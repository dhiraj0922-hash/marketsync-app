/**
 * roles.ts — Central role/location resolution utilities.
 *
 * Single source of truth for all permission logic.
 * Import from here instead of duplicating role strings across the app.
 *
 * Role model:
 *   hq_admin        → global HQ access, all locations, all modules
 *   location_manager → restricted to their assigned location_id
 *   null / unknown  → unauthenticated or profile fetch failed (treated as no-access)
 *
 * Location model:
 *   HQ admin:           locationId = null OR "LOC-HQ"  → always resolves to "LOC-HQ"
 *   Location manager:   locationId = the assigned location id (e.g. "LOC-001")
 *
 * HQ admins do NOT require a location row — null is acceptable.
 */

// ─── Role constants ────────────────────────────────────────────────────────────
/** Canonical DB value for HQ admins stored in user_profiles.role */
export const ROLE_HQ_ADMIN        = "hq_admin"        as const;
/** Canonical DB value for location managers stored in user_profiles.role */
export const ROLE_LOCATION_MANAGER = "location_manager" as const;
/** Virtual location id used for all HQ-level inventory rows */
export const LOC_HQ               = "LOC-HQ"          as const;

// ─── Type helpers ──────────────────────────────────────────────────────────────
export type AppUser = {
  id:          string;
  email:       string;
  name:        string;
  role:        string | null;
  locationId:  string | null;
  isActive?:   boolean;
  /** Set to true when profile was loaded from DB successfully */
  profileLoaded?: boolean;
  /** Set to true when profile fetch timed out / failed — role may be stale */
  profileError?:  boolean;
};

// ─── Role helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true for any user that should have global HQ access.
 * Case-insensitive + supports legacy variants ("hq_admin", "HQ Admin", "admin").
 */
export function isHqAdmin(user: { role?: string | null } | null | undefined): boolean {
  if (!user?.role) return false;
  const r = user.role.toLowerCase().trim();
  return r === "hq_admin" || r === "hq admin" || r === "admin";
}

/**
 * Returns true for location-scoped users.
 */
export function isLocationManager(user: { role?: string | null } | null | undefined): boolean {
  if (!user?.role) return false;
  const r = user.role.toLowerCase().trim();
  return r === "location_manager" || r === "location manager";
}

/**
 * Returns the DB location_id to use for reads/writes.
 * - HQ admins  → "LOC-HQ" (never null, even if their profile has location_id = null)
 * - Location managers → their assigned locationId (must be non-empty)
 * - Unknown role → "LOC-HQ" as safe default (read-only guard elsewhere)
 */
export function resolveLocationId(user: { role?: string | null; locationId?: string | null } | null | undefined): string {
  if (!user) return LOC_HQ;
  if (isHqAdmin(user)) return LOC_HQ;
  return user.locationId?.trim() || LOC_HQ; // fall through to LOC-HQ rather than empty string
}

/**
 * Returns a human-readable label for the user's access scope.
 */
export function accessScopeLabel(user: { role?: string | null; locationId?: string | null } | null | undefined): string {
  if (!user) return "Unauthenticated";
  if (isHqAdmin(user)) return "All Locations (HQ)";
  if (user.locationId) return user.locationId;
  return "No Location Assigned";
}
