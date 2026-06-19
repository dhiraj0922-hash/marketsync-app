/**
 * src/lib/auth.ts
 *
 * Phase 1: Auth Identity & Role Service
 * ─────────────────────────────────────
 * Central source of truth for the current logged-in user's identity.
 * Every page and server helper should use these functions — never read
 * auth.users or user_profiles directly in component code.
 *
 * Phase 1 roles:
 *   hq_master       — full access, location_id may be null
 *   hq_ops          — operational HQ access
 *   driver          — assigned delivery route access
 *   location_manager — scoped to one location, location_id is always set
 */

import { supabase } from "@/lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole = "hq_master" | "hq_ops" | "location_manager" | "driver" | "hq_admin" | "hq_fulfillment";

export interface UserProfile {
  /** user_profiles.id — UUID row identifier */
  id: string;
  /** auth.users.id — the Supabase auth identity */
  userId: string;
  fullName: string | null;
  role: UserRole;
  /**
   * The assigned location id (TEXT, matches locations.id).
   * Always set for location_manager. May be null for hq_admin.
   */
  locationId: string | null;
  isActive: boolean;
}

// ─── Internal cache ───────────────────────────────────────────────────────────
// Simple in-memory cache for the duration of the browser session.
// Cleared on sign-out via clearProfileCache().

let _profileCache: UserProfile | null | undefined = undefined;

export function clearProfileCache(): void {
  _profileCache = undefined;
}


// ─── Core: fetch current user profile ─────────────────────────────────────────

/**
 * Returns the full UserProfile for the currently logged-in user.
 * Returns null if the user is not authenticated, or has no user_profiles row.
 * Results are cached in memory for the browser session.
 */
export async function getCurrentUserProfile(): Promise<UserProfile | null> {
  if (_profileCache !== undefined) return _profileCache;

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    _profileCache = null;
    return null;
  }

  const { data, error } = await supabase
    .from("user_profiles")
    .select("id, user_id, full_name, role, location_id, is_active")
    .eq("user_id", user.id)
    .single();

  if (error || !data) {
    if (error) {
      console.error("[auth] user_profiles query failed", {
        code:    error.code,
        message: error.message,
        status:  (error as any).status ?? null,
      });
    }
    _profileCache = null;
    return null;
  }

  const profile: UserProfile = {
    id:         data.id,
    userId:     data.user_id,
    fullName:   data.full_name,
    role:       data.role as UserRole,
    locationId: data.location_id,
    isActive:   data.is_active,
  };

  _profileCache = profile;
  return profile;
}


// ─── Convenience helpers ───────────────────────────────────────────────────────

/**
 * Returns the current user's role, or null if not authenticated / no profile.
 */
export async function getCurrentRole(): Promise<UserRole | null> {
  const profile = await getCurrentUserProfile();
  return profile?.role ?? null;
}

/**
 * Returns the current user's assigned location_id, or null.
 * Usually null for HQ/driver roles. Always set for location_manager.
 */
export async function getCurrentLocationId(): Promise<string | null> {
  const profile = await getCurrentUserProfile();
  return profile?.locationId ?? null;
}

/**
 * Returns the Supabase auth.users uuid of the current user.
 * Returns null if not authenticated.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/**
 * Returns true if the current user has the HQ master/admin role.
 */
export async function isHQAdmin(): Promise<boolean> {
  const role = await getCurrentRole();
  return role === "hq_master" || role === "hq_admin";
}

/**
 * Returns true if the current user has the location_manager role.
 */
export async function isLocationManager(): Promise<boolean> {
  return (await getCurrentRole()) === "location_manager";
}

/**
 * Returns true if the current user can access the given locationId.
 * - hq_master / legacy hq_admin / hq_ops: can access any location (returns true always)
 * - location_manager: only if their assigned location matches
 */
export async function canAccessLocation(targetLocationId: string): Promise<boolean> {
  const profile = await getCurrentUserProfile();
  if (!profile) return false;
  if (profile.role === "hq_master" || profile.role === "hq_admin" || profile.role === "hq_ops" || profile.role === "hq_fulfillment") return true;
  return profile.locationId === targetLocationId;
}


// ─── Auth event listener ──────────────────────────────────────────────────────
// Clears the profile cache whenever the auth state changes
// (sign in, sign out, token refresh). Safe to call once at app root.

export function initAuthListener(): void {
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" || event === "SIGNED_IN" || event === "USER_UPDATED") {
      clearProfileCache();
    }
  });
}
