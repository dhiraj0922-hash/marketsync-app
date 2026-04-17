import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/users/set-password
 *
 * HQ action: directly sets a new password for an existing user.
 * No email is sent. The HQ admin provides the password manually.
 *
 * Uses auth.admin.updateUserById which requires the Supabase service role key.
 * We look up the auth user by email first, then update by their UUID.
 *
 * Body: { email: string; password: string }
 *
 * Password rules (Supabase default): minimum 6 characters.
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

  const adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const body = await req.json().catch(() => ({}));
  const { email, password } = body as { email?: string; password?: string };

  if (!email)    return NextResponse.json({ error: "email is required" },    { status: 400 });
  if (!password) return NextResponse.json({ error: "password is required" }, { status: 400 });
  if (password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
  }

  // 1. Look up auth user by email
  const { data: listData, error: listErr } = await adminClient.auth.admin.listUsers();
  if (listErr) {
    return NextResponse.json({ error: `Could not list users: ${listErr.message}` }, { status: 500 });
  }

  const authUser = listData?.users?.find(
    (u) => u.email?.toLowerCase() === email.toLowerCase()
  );

  if (!authUser) {
    return NextResponse.json(
      { error: `No Supabase auth account found for email: ${email}. The user must be created first.` },
      { status: 404 }
    );
  }

  // 2. Set the new password directly
  const { error: updateErr } = await adminClient.auth.admin.updateUserById(authUser.id, {
    password,
  });

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 400 });
  }

  return NextResponse.json({ success: true, userId: authUser.id });
}
