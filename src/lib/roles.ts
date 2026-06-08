/**
 * roles.ts — Central role/location resolution utilities.
 *
 * Single source of truth for all permission logic.
 * Import from here instead of duplicating role strings across the app.
 *
 * Role model:
 *   hq_master       → global HQ ownership access, all modules
 *   hq_ops          → operational HQ access, no owner-only financial/admin modules
 *   driver          → assigned delivery routes only
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
/** Legacy DB value; treated as hq_master for backward compatibility. */
export const ROLE_HQ_ADMIN        = "hq_admin"        as const;
/** Canonical DB value for owner/master HQ admins stored in user_profiles.role */
export const ROLE_HQ_MASTER       = "hq_master"       as const;
/** Canonical DB value for operational HQ staff stored in user_profiles.role */
export const ROLE_HQ_OPS          = "hq_ops"          as const;
/** Canonical DB value for location managers stored in user_profiles.role */
export const ROLE_LOCATION_MANAGER = "location_manager" as const;
/** Canonical DB value for delivery drivers stored in user_profiles.role */
export const ROLE_DRIVER          = "driver"          as const;
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

export type UserRole = typeof ROLE_HQ_MASTER | typeof ROLE_HQ_OPS | typeof ROLE_LOCATION_MANAGER | typeof ROLE_DRIVER | typeof ROLE_HQ_ADMIN;

export const normalizeRole = (role?: string | null): UserRole | null => {
  const r = String(role ?? "").toLowerCase().trim().replace(/\s+/g, "_");
  if (r === "hq_admin" || r === "admin") return ROLE_HQ_MASTER;
  if (r === "hq_master" || r === "master_admin" || r === "hq_master_admin") return ROLE_HQ_MASTER;
  if (r === "hq_ops" || r === "hq_operations" || r === "hq_operations_staff") return ROLE_HQ_OPS;
  if (r === "location_manager") return ROLE_LOCATION_MANAGER;
  if (r === "driver" || r === "delivery_driver") return ROLE_DRIVER;
  return null;
};

// ─── Role helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true for any user that should have global HQ access.
 * Case-insensitive + supports legacy variants ("hq_admin", "HQ Admin", "admin").
 */
export function isHqAdmin(user: { role?: string | null } | null | undefined): boolean {
  return isHqMaster(user);
}

export function isHqMaster(user: { role?: string | null } | null | undefined): boolean {
  return normalizeRole(user?.role) === ROLE_HQ_MASTER;
}

export function isHqOps(user: { role?: string | null } | null | undefined): boolean {
  return normalizeRole(user?.role) === ROLE_HQ_OPS;
}

export function isHqStaff(user: { role?: string | null } | null | undefined): boolean {
  return isHqMaster(user) || isHqOps(user);
}

export function isDriver(user: { role?: string | null } | null | undefined): boolean {
  return normalizeRole(user?.role) === ROLE_DRIVER;
}

/**
 * Returns true for location-scoped users.
 */
export function isLocationManager(user: { role?: string | null } | null | undefined): boolean {
  return normalizeRole(user?.role) === ROLE_LOCATION_MANAGER;
}

export const canViewSales = (user: { role?: string | null } | null | undefined) => isHqMaster(user) || isLocationManager(user);
export const canViewReports = (user: { role?: string | null } | null | undefined) => isHqMaster(user) || isLocationManager(user);
export const canManageUsers = (user: { role?: string | null } | null | undefined) => isHqMaster(user);
export const canManageSettings = (user: { role?: string | null } | null | undefined) => isHqMaster(user);
export const canUpdateRecipes = (user: { role?: string | null } | null | undefined) => isHqMaster(user) || isHqOps(user);
export const canReceivePurchaseOrders = (user: { role?: string | null } | null | undefined) => isHqMaster(user) || isHqOps(user) || isLocationManager(user);
export const canAssignDrivers = (user: { role?: string | null } | null | undefined) => isHqMaster(user) || isHqOps(user);
export const canViewDeliveryRuns = (user: { role?: string | null } | null | undefined) => isHqMaster(user) || isHqOps(user) || isDriver(user) || isLocationManager(user);
export const canViewAssignedDriverRuns = (user: { role?: string | null } | null | undefined) => isDriver(user);
export const canAccessInventory = (user: { role?: string | null } | null | undefined) => isHqMaster(user) || isHqOps(user) || isLocationManager(user);
export const canAccessInvoices = (user: { role?: string | null } | null | undefined) => isHqMaster(user);
export const canDeleteArchiveAdmin = (user: { role?: string | null } | null | undefined) => isHqMaster(user);
export const canViewOwnerDashboard = (user: { role?: string | null } | null | undefined) => isHqMaster(user) || isLocationManager(user);

export function getAllowedHomePath(user: { role?: string | null } | null | undefined): string {
  if (isDriver(user)) return "/deliveries";
  if (isHqOps(user)) return "/inventory";
  if (isHqMaster(user) || isLocationManager(user)) return "/";
  return "/login";
}

export function canAccessPath(user: { role?: string | null } | null | undefined, pathname: string): boolean {
  if (!user) return pathname === "/login";
  const path = pathname.split("?")[0];
  if (path === "/login") return true;
  if (isHqMaster(user)) return true;
  if (isDriver(user)) return path === "/deliveries";
  if (isHqOps(user)) {
    return [
      "/inventory",
      "/outlet-inventory",
      "/menu-costing",
      "/counts",
      "/orders",
      "/requisitions",
      "/deliveries",
      "/suppliers",
      "/fg-count",
      "/finished-goods",
      "/hq-sale-items",
      "/recipes",
      "/approvals",
      "/location-catalog",
    ].some(allowed => path === allowed || path.startsWith(`${allowed}/`));
  }
  if (isLocationManager(user)) {
    return ![
      "/approvals",
      "/location-catalog",
      "/hq-sale-items",
      "/fg-count",
      "/finished-goods",
      "/invoices",
      "/recipes",
      "/users",
      "/settings",
    ].some(blocked => path === blocked || path.startsWith(`${blocked}/`));
  }
  return false;
}

/**
 * Returns the DB location_id to use for reads/writes.
 * - HQ admins  → "LOC-HQ" (never null, even if their profile has location_id = null)
 * - Location managers → their assigned locationId (must be non-empty)
 * - Unknown role → "LOC-HQ" as safe default (read-only guard elsewhere)
 */
export function resolveLocationId(user: { role?: string | null; locationId?: string | null } | null | undefined): string {
  if (!user) return LOC_HQ;
  if (isHqStaff(user)) return LOC_HQ;
  return user.locationId?.trim() || LOC_HQ; // fall through to LOC-HQ rather than empty string
}

/**
 * Returns a human-readable label for the user's access scope.
 */
export function accessScopeLabel(user: { role?: string | null; locationId?: string | null } | null | undefined): string {
  if (!user) return "Unauthenticated";
  if (isHqMaster(user)) return "All Locations (HQ Master)";
  if (isHqOps(user)) return "HQ Operations";
  if (isDriver(user)) return "Assigned Driver Routes";
  if (user.locationId) return user.locationId;
  return "No Location Assigned";
}
