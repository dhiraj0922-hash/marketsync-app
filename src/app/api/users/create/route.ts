import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/users/create
 *
 * HQ fallback: creates a Supabase auth user directly (no email sent) using
 * auth.admin.createUser. The account is immediately active — the user logs in
 * with the temporary password HQ provides. They should change it on first login.
 *
 * Use this when invite emails are rate-limited or email delivery is unavailable.
 *
 * Body: { email, password, full_name, role, location_id, phone? }
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
export async function POST(req: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!serviceKey || !url) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured. Add it to .env.local." },
      { status: 500 }
    );
  }

  const adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const body = await req.json();
  const { email, password, full_name, role, location_id, phone } = body;

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!email || !password || !role) {
    return NextResponse.json(
      { error: "email, password, and role are required" },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Temporary password must be at least 8 characters." },
      { status: 400 }
    );
  }
  if (!["hq_master", "hq_ops", "location_manager", "driver", "hq_admin"].includes(role)) {
    return NextResponse.json({ error: `Invalid role: ${role}` }, { status: 400 });
  }
  if (role === "location_manager" && !location_id) {
    return NextResponse.json(
      { error: "location_id is required for location_manager role" },
      { status: 400 }
    );
  }

  // ── Step 1: Create auth user directly (no email sent) ──────────────────────
  const { data: createData, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,           // mark email as confirmed immediately
    user_metadata: { full_name, role, phone: phone ?? null },
  });

  let authUserId: string | null = createData?.user?.id ?? null;

  if (createError) {
    // User might already exist — look them up
    const alreadyExists =
      createError.message?.toLowerCase().includes("already registered") ||
      createError.message?.toLowerCase().includes("already been registered") ||
      createError.message?.toLowerCase().includes("already exists");

    if (!alreadyExists) {
      return NextResponse.json({ error: createError.message }, { status: 400 });
    }

    // Resolve existing user id
    const { data: listData } = await adminClient.auth.admin.listUsers();
    const existing = listData?.users?.find((u) => u.email === email);
    authUserId = existing?.id ?? null;
  }

  if (!authUserId) {
    return NextResponse.json(
      { error: "Could not create or resolve auth user." },
      { status: 500 }
    );
  }

  // ── Step 2: Upsert user_profiles ───────────────────────────────────────────
  const profilePayload: Record<string, any> = {
    user_id:     authUserId,
    full_name:   full_name ?? null,
    role,
    location_id: location_id ?? null,
    is_active:   true,
    updated_at:  new Date().toISOString(),
  };
  if (phone) profilePayload.phone = phone;

  const { data: profileData, error: profileError } = await adminClient
    .from("user_profiles")
    .upsert(profilePayload, { onConflict: "user_id" })
    .select()
    .single();

  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, profile: profileData }, { status: 201 });
}
