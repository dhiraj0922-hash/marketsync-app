import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/users/provision
 *
 * Unified, idempotent HQ user provisioning.
 * Creates or reconciles BOTH the Supabase auth account AND the user_profiles
 * row in a single call. Handles all four states safely:
 *
 *   Case A — auth missing,    profile missing  → create auth + insert profile
 *   Case B — auth exists,     profile missing  → reuse auth  + insert profile
 *   Case C — auth missing,    profile exists   → create auth + update profile.user_id
 *   Case D — auth exists,     profile exists   → update profile (role/name/location)
 *                                                + optionally update password
 *
 * Body (all except email are optional):
 *   {
 *     email:       string   (required)
 *     full_name?:  string
 *     role?:       "hq_admin" | "location_manager" | "staff"  (default: "location_manager")
 *     location_id?: string | null
 *     phone?:      string | null
 *     password?:   string   (min 8 chars; if omitted a random one is generated — user must reset)
 *   }
 *
 * Response:
 *   201 { success: true, userId, profileId, action: "created"|"updated"|"reconciled" }
 *   4xx/5xx { error: string }
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
export async function POST(req: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url        = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!serviceKey || !url) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Parse + validate body ─────────────────────────────────────────────────
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  const {
    email,
    full_name  = null,
    role       = "location_manager",
    location_id = null,
    phone      = null,
    password: rawPassword,
  } = body;

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  const validRoles = ["hq_admin", "location_manager", "staff"];
  if (!validRoles.includes(role)) {
    return NextResponse.json({ error: `Invalid role "${role}". Must be one of: ${validRoles.join(", ")}` }, { status: 400 });
  }
  if (role === "location_manager" && !location_id) {
    return NextResponse.json({ error: "location_id is required for location_manager" }, { status: 400 });
  }

  // Use provided password or generate a secure random one
  const password = rawPassword && rawPassword.length >= 8
    ? rawPassword
    : Array.from({ length: 16 }, () =>
        "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%"[
          Math.floor(Math.random() * 62)
        ]
      ).join("");

  // ── Step 1: Resolve / create the auth user ────────────────────────────────
  let authUserId: string | null = null;
  let authAction: "created" | "existing" = "existing";

  // List all users and find by email (case-insensitive)
  const { data: listData, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    return NextResponse.json({ error: `Failed to list auth users: ${listErr.message}` }, { status: 500 });
  }
  const existingAuthUser = listData?.users?.find(
    (u) => u.email?.toLowerCase() === email.toLowerCase()
  );

  if (existingAuthUser) {
    // Auth user already exists — reuse their ID
    authUserId = existingAuthUser.id;

    // If a password was explicitly provided, update it
    if (rawPassword && rawPassword.length >= 8) {
      const { error: pwErr } = await admin.auth.admin.updateUserById(authUserId, { password: rawPassword });
      if (pwErr) {
        return NextResponse.json({ error: `Failed to update password: ${pwErr.message}` }, { status: 500 });
      }
    }
  } else {
    // Create a brand new auth user
    const { data: createData, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,   // mark confirmed immediately — no email sent
      user_metadata: { full_name, role },
    });

    if (createErr) {
      return NextResponse.json({ error: `Failed to create auth user: ${createErr.message}` }, { status: 500 });
    }
    authUserId = createData.user.id;
    authAction = "created";
  }

  // ── Step 2: Resolve / upsert the user_profiles row ───────────────────────
  const profilePayload: Record<string, any> = {
    user_id:     authUserId,
    full_name:   full_name   ?? null,
    role,
    location_id: location_id ?? null,
    is_active:   true,
    updated_at:  new Date().toISOString(),
  };
  if (phone !== undefined) profilePayload.phone = phone;

  // Check whether a profile row already exists for this user_id
  const { data: existingProfile } = await admin
    .from("user_profiles")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  let profileId: string | null = null;
  let profileAction: "created" | "updated" = "created";

  if (existingProfile) {
    // Update existing profile
    profileAction = "updated";
    const { data: updated, error: updateErr } = await admin
      .from("user_profiles")
      .update(profilePayload)
      .eq("user_id", authUserId)
      .select("id")
      .single();

    if (updateErr) {
      return NextResponse.json({ error: `Profile update failed: ${updateErr.message}` }, { status: 500 });
    }
    profileId = updated.id;
  } else {
    // Insert new profile row
    const { data: inserted, error: insertErr } = await admin
      .from("user_profiles")
      .insert(profilePayload)
      .select("id")
      .single();

    if (insertErr) {
      return NextResponse.json({ error: `Profile insert failed: ${insertErr.message}` }, { status: 500 });
    }
    profileId = inserted.id;
  }

  // ── Determine overall action for audit log ─────────────────────────────────
  const action =
    authAction === "created" && profileAction === "created" ? "created"
    : authAction === "created" || profileAction === "created" ? "reconciled"
    : "updated";

  return NextResponse.json(
    {
      success:   true,
      userId:    authUserId,
      profileId,
      action,
      // Return the generated password only when we created the auth user
      // so HQ can share it — omit otherwise (updating existing auth users).
      ...(authAction === "created" ? { generatedPassword: rawPassword ? undefined : password } : {}),
    },
    { status: 201 }
  );
}
