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
 *   hq_admin        — full access, location_id may be null
 *   location_manager — scoped to one location, location_id is always set
 */

import { supabase } from "@/lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole = "hq_admin" | "location_manager";

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
  // Return cached value if already resolved
  if (_profileCache !== undefined) {
    console.log('[AUTH] getCurrentUserProfile — cache hit  role=', _profileCache?.role ?? null);
    return _profileCache;
  }
  console.log('[AUTH] getCurrentUserProfile — cache miss, fetching…');

  // Get the Supabase auth session
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  console.log('[AUTH] getSession (auth.ts)', {
    userId:       user?.id    ?? null,
    email:        user?.email ?? null,
    authErrorMsg: authError?.message ?? null,
    authErrorStatus: (authError as any)?.status ?? null,
  });

  if (authError || !user) {
    console.warn('[AUTH] getCurrentUserProfile — no auth user, returning null');
    _profileCache = null;
    return null;
  }

  // Query user_profiles for this auth user
  console.log('[AUTH] profile query start (auth.ts)  uid=', user.id);
  const queryStart = Date.now();
  const { data, error } = await supabase
    .from("user_profiles")
    .select("id, user_id, full_name, role, location_id, is_active")
    .eq("user_id", user.id)
    .single();
  const elapsed = Date.now() - queryStart;

  if (error || !data) {
    console.error('[AUTH] profile query error (auth.ts)', {
      elapsed_ms:  elapsed,
      code:        error?.code,
      message:     error?.message,
      details:     (error as any)?.details   ?? null,
      hint:        (error as any)?.hint      ?? null,
      status:      (error as any)?.status    ?? null,
      interpretation:
        error?.code === 'PGRST116' ? 'NO_PROFILE_ROW'
        : (error as any)?.status === 403 ? 'RLS_DENIED'
        : 'DB_OR_NETWORK_ERROR',
    });
    console.warn('[AUTH] using cached credentials (auth.ts) — returning null, no profile');
    _profileCache = null;
    return null;
  }

  const profile: UserProfile = {
    id: data.id,
    userId: data.user_id,
    fullName: data.full_name,
    role: data.role as UserRole,
    locationId: data.location_id,
    isActive: data.is_active,
  };

  console.log('[AUTH] profile query success (auth.ts)', {
    elapsed_ms: elapsed,
    role:       profile.role,
    locationId: profile.locationId,
    isActive:   profile.isActive,
  });

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
 * Always null for hq_admin. Always set for location_manager.
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
 * Returns true if the current user has the hq_admin role.
 */
export async function isHQAdmin(): Promise<boolean> {
  return (await getCurrentRole()) === "hq_admin";
}

/**
 * Returns true if the current user has the location_manager role.
 */
export async function isLocationManager(): Promise<boolean> {
  return (await getCurrentRole()) === "location_manager";
}

/**
 * Returns true if the current user can access the given locationId.
 * - hq_admin: can access any location (returns true always)
 * - location_manager: only if their assigned location matches
 */
export async function canAccessLocation(targetLocationId: string): Promise<boolean> {
  const profile = await getCurrentUserProfile();
  if (!profile) return false;
  if (profile.role === "hq_admin") return true;
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
