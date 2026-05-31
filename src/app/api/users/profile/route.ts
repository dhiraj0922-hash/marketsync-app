import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * PATCH /api/users/profile
 *
 * Updates a user_profiles row (role, location_id, full_name, is_active, phone).
 * Does NOT touch auth.users. Safe to call with service role key.
 *
 * Body: { profile_id, full_name?, role?, location_id?, is_active?, phone? }
 */
export async function GET(req: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!serviceKey || !url) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 500 }
    );
  }

  const adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Try the view first
  const { data, error } = await adminClient
    .from("user_profiles_with_email")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[GET /api/users/profile] view query failed, trying plain table:", error.message);
    const { data: fallbackData, error: fallbackError } = await adminClient
      .from("user_profiles")
      .select("*")
      .order("created_at", { ascending: false });

    if (fallbackError) {
      return NextResponse.json({ error: fallbackError.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, profiles: fallbackData });
  }

  return NextResponse.json({ success: true, profiles: data });
}

export async function PATCH(req: NextRequest) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!serviceKey || !url) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 500 }
    );
  }

  const adminClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const body = await req.json();
  const { profile_id, full_name, role, location_id, is_active, phone } = body;

  if (!profile_id) {
    return NextResponse.json({ error: "profile_id is required" }, { status: 400 });
  }
  if (role && !["hq_admin", "location_manager", "staff"].includes(role)) {
    return NextResponse.json({ error: `Invalid role: ${role}` }, { status: 400 });
  }

  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (full_name   !== undefined) updates.full_name   = full_name;
  if (role        !== undefined) updates.role        = role;
  if (location_id !== undefined) updates.location_id = location_id;
  if (is_active   !== undefined) updates.is_active   = is_active;
  if (phone       !== undefined) updates.phone       = phone;

  const { data, error } = await adminClient
    .from("user_profiles")
    .update(updates)
    .eq("id", profile_id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, profile: data });
}
