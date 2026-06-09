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
 * Body: { email: string; password: string; profileId?: string; userId?: string }
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
  const { email, password, profileId, userId } = body as {
    email?: string;
    password?: string;
    profileId?: string;
    userId?: string;
  };

  if (!email)    return NextResponse.json({ error: "email is required" },    { status: 400 });
  if (!password) return NextResponse.json({ error: "password is required" }, { status: 400 });
  if (password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
  }

  const safeEmail = email.toLowerCase().trim();

  // 1. Look up the profile if caller supplied profileId. This gives us the
  // canonical auth user id link and lets us detect profile/auth drift.
  let profile: any = null;
  if (profileId) {
    const { data: profileRow, error: profileErr } = await adminClient
      .from("user_profiles")
      .select("id, user_id, full_name, role, location_id, is_active, phone")
      .eq("id", profileId)
      .maybeSingle();
    if (profileErr) {
      console.error("[set-password] profile lookup failed", { email: safeEmail, profileId, message: profileErr.message });
      return NextResponse.json({ error: `Profile lookup failed: ${profileErr.message}` }, { status: 500 });
    }
    profile = profileRow;
  }

  // 2. Look up auth user by user_id first, then by email. listUsers is
  // paginated, so scan all pages instead of relying on the first page.
  let authUser: any = null;
  const wantedUserId = String(userId || profile?.user_id || "").trim();
  let page = 1;
  while (!authUser) {
    const { data: pageData, error: listErr } = await adminClient.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (listErr) {
      console.error("[set-password] listUsers failed", { email: safeEmail, profileId, userId: wantedUserId, message: listErr.message });
      return NextResponse.json({ error: `Could not list users: ${listErr.message}` }, { status: 500 });
    }
    const users = pageData?.users ?? [];
    authUser = users.find((u) => String(u.id) === wantedUserId) ??
      users.find((u) => u.email?.toLowerCase().trim() === safeEmail) ??
      null;
    if (authUser || users.length < 1000) break;
    page += 1;
  }

  console.log("[set-password] lookup", {
    email: safeEmail,
    profileId: profile?.id ?? profileId ?? null,
    profileUserId: profile?.user_id ?? null,
    requestedUserId: wantedUserId || null,
    authUserId: authUser?.id ?? null,
    authUserFound: Boolean(authUser),
  });

  if (!authUser) {
    if (!profile) {
      return NextResponse.json(
        { error: `Auth account missing — recreate auth user for ${email}. No profile id was supplied for automatic reconciliation.` },
        { status: 404 }
      );
    }

    // Profile exists but Auth user is missing. Recreate auth user and relink
    // the existing profile, preserving role/location metadata.
    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email: safeEmail,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: profile.full_name,
        role: profile.role,
        phone: profile.phone ?? null,
      },
    });
    if (createErr || !created?.user) {
      console.error("[set-password] auth recreate failed", {
        email: safeEmail,
        profileId: profile.id,
        message: createErr?.message,
      });
      return NextResponse.json(
        { error: `Auth account missing — recreate auth user failed: ${createErr?.message ?? "Unknown error"}` },
        { status: 500 }
      );
    }
    authUser = created.user;
    const { error: linkErr } = await adminClient
      .from("user_profiles")
      .update({ user_id: authUser.id, updated_at: new Date().toISOString() })
      .eq("id", profile.id);
    if (linkErr) {
      console.error("[set-password] profile relink failed", {
        email: safeEmail,
        profileId: profile.id,
        authUserId: authUser.id,
        message: linkErr.message,
      });
      return NextResponse.json(
        { error: `Auth account was recreated, but profile relink failed: ${linkErr.message}` },
        { status: 500 }
      );
    }
    console.log("[set-password] auth account recreated and profile relinked", {
      email: safeEmail,
      profileId: profile.id,
      authUserId: authUser.id,
    });
  }

  // 3. Set the new password directly
  const { error: updateErr } = await adminClient.auth.admin.updateUserById(authUser.id, {
    password,
    email_confirm: true,
  });

  if (updateErr) {
    console.error("[set-password] updateUserById failed", {
      email: safeEmail,
      profileId: profile?.id ?? profileId ?? null,
      authUserId: authUser.id,
      message: updateErr.message,
    });
    return NextResponse.json({ error: updateErr.message }, { status: 400 });
  }

  console.log("[set-password] updateUserById success", {
    email: safeEmail,
    profileId: profile?.id ?? profileId ?? null,
    authUserId: authUser.id,
  });

  return NextResponse.json({ success: true, userId: authUser.id });
}
