import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/users/invite
 * Lightweight health-check: returns { ready: true } when the service role key
 * is configured, { ready: false } otherwise. No sensitive data is returned.
 */
export async function GET() {
  const ready = !!(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);
  return NextResponse.json({ ready });
}

/**
 * POST /api/users/invite
 *
 * Creates a Supabase auth user via invite (magic link sent to email)
 * then upserts a user_profiles row with role and location_id.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env.local.
 * Must NEVER be called from client-side code directly — always via fetch().
 *
 * Body: { email, full_name, role, location_id, phone? }
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

  // Admin client — service role bypasses RLS
  const adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const body = await req.json();
  const { email, full_name, role, location_id, phone } = body;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!email || !role) {
    return NextResponse.json({ error: "email and role are required" }, { status: 400 });
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

  // ── Step 1: Invite the auth user ──────────────────────────────────────────
  const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
    email,
    { data: { full_name, role, phone: phone ?? null } }
  );

  if (inviteError) {
    // If user already exists in auth, we can still sync their profile below.
    // Supabase returns "User already registered" for duplicate emails.
    const alreadyExists = inviteError.message?.toLowerCase().includes("already registered")
      || inviteError.message?.toLowerCase().includes("already been registered");

    if (!alreadyExists) {
      return NextResponse.json({ error: inviteError.message }, { status: 400 });
    }
  }

  // ── Step 2: Resolve auth user id  ─────────────────────────────────────────
  let authUserId: string | null = inviteData?.user?.id ?? null;

  if (!authUserId) {
    // Try to look up the existing user by email
    const { data: listData } = await adminClient.auth.admin.listUsers();
    const existing = listData?.users?.find((u) => u.email === email);
    authUserId = existing?.id ?? null;
  }

  if (!authUserId) {
    return NextResponse.json(
      { error: "Could not resolve auth user id. Invite may have failed." },
      { status: 500 }
    );
  }

  // ── Step 3: Upsert user_profiles ──────────────────────────────────────────
  const profilePayload: Record<string, any> = {
    user_id:     authUserId,
    full_name:   full_name ?? null,
    role:        role,
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
