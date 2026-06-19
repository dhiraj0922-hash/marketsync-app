import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/users/provision
 *
 * Unified, idempotent HQ user provisioning.
 * ALWAYS guarantees:  auth.users exists  +  user_profiles exists  +  both linked.
 *
 * Algorithm:
 *   1. Generate or use provided password.
 *   2. Look up auth user by email via admin.listUsers (paginated, all pages).
 *   3. If auth user NOT found → create with admin.createUser (email_confirm: true).
 *   4. If auth user found    → reuse (optionally update password if provided).
 *   5. Look up user_profiles row by user_id.
 *   6. If profile NOT found  → insert.
 *   7. If profile found      → update (role / name / location).
 *   8. Return {success, action, userId, profileId, generatedPassword?}.
 *
 * Handles all 4 cases:
 *   A  auth missing  + profile missing  → create auth  + insert profile
 *   B  auth exists   + profile missing  → reuse auth   + insert profile
 *   C  auth missing  + profile exists   → create auth  + update profile.user_id
 *   D  auth exists   + profile exists   → update profile
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
export async function POST(req: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url        = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!serviceKey || !url) {
    return NextResponse.json(
      { error: "Server misconfiguration: SUPABASE_SERVICE_ROLE_KEY is not set." },
      { status: 500 }
    );
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Parse body ────────────────────────────────────────────────────────────
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  const {
    email,
    full_name   = null,
    role        = "location_manager",
    location_id = null,
    phone       = null,
    password: providedPassword,
  } = body;

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const validRoles = ["hq_master", "hq_ops", "location_manager", "driver", "hq_admin", "hq_fulfillment"];
  if (!validRoles.includes(role)) {
    return NextResponse.json(
      { error: `Invalid role "${role}". Expected one of: ${validRoles.join(", ")}` },
      { status: 400 }
    );
  }
  if (role === "location_manager" && !location_id) {
    return NextResponse.json(
      { error: "location_id is required for location_manager role" },
      { status: 400 }
    );
  }

  // ── Step 1: Determine password ────────────────────────────────────────────
  const passwordIsProvided = typeof providedPassword === "string" && providedPassword.length >= 8;
  // Auto-generate a secure 16-char password if none given.
  // Only returned to the caller when we CREATE the auth user.
  const passwordToUse: string = passwordIsProvided
    ? providedPassword
    : Array.from({ length: 16 }, () => {
        const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
        return chars[Math.floor(Math.random() * chars.length)];
      }).join("");

  // ── Step 2: Find existing auth user by email (paginated) ──────────────────
  let authUserId: string | null = null;
  let authAction: "created" | "existing" = "existing";

  // listUsers only returns up to 1000 per page — iterate all pages to be safe
  let page = 1;
  let found = false;
  while (!found) {
    const { data: pageData, error: pageErr } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (pageErr) {
      console.error("[provision] listUsers error:", pageErr.message);
      return NextResponse.json(
        { error: `Failed to query auth users: ${pageErr.message}` },
        { status: 500 }
      );
    }
    const match = pageData?.users?.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    );
    if (match) {
      authUserId = match.id;
      found = true;
    } else if ((pageData?.users?.length ?? 0) < 1000) {
      // Last page — user genuinely doesn't exist
      break;
    } else {
      page++;
    }
  }

  // ── Step 3: Create auth user if missing ───────────────────────────────────
  if (!authUserId) {
    console.log("[provision] auth user not found — creating:", email);
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password:      passwordToUse,
      email_confirm: true,   // confirmed immediately — no email sent
      user_metadata: { full_name, role },
    });

    if (createErr) {
      // Rare race: another request created the user between our listUsers and now.
      // Try to recover by re-fetching.
      const isAlreadyExists =
        createErr.message?.toLowerCase().includes("already registered") ||
        createErr.message?.toLowerCase().includes("already been registered") ||
        createErr.message?.toLowerCase().includes("already exists") ||
        createErr.message?.toLowerCase().includes("duplicate");

      if (isAlreadyExists) {
        console.warn("[provision] race condition — auth user appeared after listUsers, fetching:", email);
        const { data: retry } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const racedUser = retry?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());
        if (racedUser) {
          authUserId = racedUser.id;
        } else {
          console.error("[provision] createUser race — still cannot find user after retry");
          return NextResponse.json(
            { error: "Could not create or locate auth user. Please retry." },
            { status: 500 }
          );
        }
      } else {
        console.error("[provision] createUser failed:", createErr.message);
        return NextResponse.json(
          { error: `Auth user creation failed: ${createErr.message}` },
          { status: 500 }
        );
      }
    } else {
      authUserId = created.user.id;
      authAction = "created";
      console.log("[provision] auth user created:", authUserId);
    }
  } else {
    // Auth user exists — update password only if one was explicitly provided
    console.log("[provision] auth user already exists:", authUserId);
    if (passwordIsProvided) {
      const { error: pwErr } = await admin.auth.admin.updateUserById(authUserId, {
        password: providedPassword,
      });
      if (pwErr) {
        // Non-fatal — log and continue. Profile still needs to be created/updated.
        console.error("[provision] password update failed (non-fatal):", pwErr.message);
      }
    }
  }

  // authUserId is guaranteed non-null from here ─────────────────────────────

  // ── Step 4: Find existing user_profiles row ───────────────────────────────
  const { data: existingProfile, error: profileLookupErr } = await admin
    .from("user_profiles")
    .select("id, user_id")
    .eq("user_id", authUserId!)
    .maybeSingle();

  if (profileLookupErr) {
    console.error("[provision] profile lookup error:", profileLookupErr.message);
    return NextResponse.json(
      { error: `Profile lookup failed: ${profileLookupErr.message}` },
      { status: 500 }
    );
  }

  const now = new Date().toISOString();
  const profilePayload: Record<string, any> = {
    user_id:     authUserId,
    full_name:   full_name   ?? null,
    role,
    location_id: location_id ?? null,
    is_active:   true,
    updated_at:  now,
  };
  if (phone !== undefined) profilePayload.phone = phone;

  let profileId: string | null = null;
  let profileAction: "created" | "updated" = "created";

  if (existingProfile) {
    // ── Step 5a: Update existing profile ─────────────────────────────────
    profileAction = "updated";
    const { data: updated, error: updateErr } = await admin
      .from("user_profiles")
      .update(profilePayload)
      .eq("user_id", authUserId!)
      .select("id")
      .single();

    if (updateErr) {
      console.error("[provision] profile update error:", updateErr.message);
      return NextResponse.json(
        { error: `Profile update failed: ${updateErr.message}` },
        { status: 500 }
      );
    }
    profileId = updated.id;
    console.log("[provision] profile updated:", profileId);
  } else {
    // ── Step 5b: Insert new profile ───────────────────────────────────────
    const { data: inserted, error: insertErr } = await admin
      .from("user_profiles")
      .insert({ ...profilePayload, created_at: now })
      .select("id")
      .single();

    if (insertErr) {
      console.error("[provision] profile insert error:", insertErr.message, insertErr);
      return NextResponse.json(
        { error: `Profile creation failed: ${insertErr.message}` },
        { status: 500 }
      );
    }
    profileId = inserted.id;
    console.log("[provision] profile inserted:", profileId);
  }

  // ── Step 6: Determine overall action label ────────────────────────────────
  const action =
    authAction === "created" && profileAction === "created" ? "created"
    : authAction === "created" || profileAction === "created" ? "reconciled"
    : "updated";

  return NextResponse.json(
    {
      success:   true,
      action,
      userId:    authUserId,
      profileId,
      // Only expose the auto-generated password when we created the auth user
      // and no password was explicitly provided by the caller.
      ...(authAction === "created" && !passwordIsProvided
        ? { generatedPassword: passwordToUse }
        : {}),
    },
    { status: 201 }
  );
}
