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

  // 1. Load all profiles from plain user_profiles table
  const { data: profiles, error: profileErr } = await adminClient
    .from("user_profiles")
    .select("*")
    .order("created_at", { ascending: false });

  if (profileErr) {
    console.error("[GET /api/users/profile] profile fetch error:", profileErr.message);
    return NextResponse.json({ error: profileErr.message }, { status: 500 });
  }

  // 2. Load all Auth users (paginated)
  let authUsers: any[] = [];
  try {
    let page = 1;
    let done = false;
    while (!done) {
      const { data: pageData, error: pageErr } = await adminClient.auth.admin.listUsers({
        page,
        perPage: 1000,
      });
      if (pageErr) {
        console.error("[GET /api/users/profile] listUsers error:", pageErr.message);
        break; // Fallback to whatever we have
      }
      if (pageData?.users && pageData.users.length > 0) {
        authUsers = authUsers.concat(pageData.users);
        if (pageData.users.length < 1000) {
          done = true;
        } else {
          page++;
        }
      } else {
        done = true;
      }
    }
  } catch (err) {
    console.error("[GET /api/users/profile] listUsers exception:", err);
  }

  // Create lookup map
  const authMap = new Map(authUsers.map((u) => [String(u.id).toLowerCase(), u.email]));

  // 3. Merge email into each profile
  const mergedProfiles = (profiles || []).map((p) => {
    const key = String(p.user_id || '').toLowerCase();
    const email = authMap.get(key) || null;
    return {
      id:          p.id,
      user_id:     p.user_id,
      full_name:   p.full_name,
      email:       email,
      phone:       p.phone,
      role:        p.role,
      location_id: p.location_id,
      is_active:   p.is_active,
      created_at:  p.created_at,
      updated_at:  p.updated_at,
    };
  });

  return NextResponse.json({ success: true, profiles: mergedProfiles });
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
  if (role && !["hq_master", "hq_ops", "location_manager", "driver", "hq_admin", "hq_fulfillment"].includes(role)) {
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
