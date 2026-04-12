import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/users/reset-password
 *
 * HQ action: sends a password-reset email to the user's registered address.
 * Uses auth.admin.generateLink({ type: 'recovery' }) which works regardless
 * of Supabase email rate limits (it generates the link server-side and sends
 * it via the configured SMTP).
 *
 * Body: { email: string }
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
export async function POST(req: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url        = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!serviceKey || !url) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 500 }
    );
  }

  const adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { email } = await req.json();
  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  // generateLink sends the recovery email via Supabase SMTP and returns the
  // link (we don't expose the raw link to the client for security).
  const { error } = await adminClient.auth.admin.generateLink({
    type:       "recovery",
    email,
    options: {
      // Redirect to login page after password is reset
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? url}/login`,
    },
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
