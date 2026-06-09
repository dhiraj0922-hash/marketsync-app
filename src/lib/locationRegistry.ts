import { type LocationBillingProfile } from "@/lib/storage";

/**
 * Normalize location status to lowercase. Default to 'active' if empty/null.
 */
export function normalizeLocationStatus(status: string | null | undefined): string {
  const s = String(status ?? "").trim().toLowerCase();
  return s === "" ? "active" : s;
}

/**
 * Check if the location is active.
 */
export function isActiveLocation(location: any): boolean {
  if (!location) return false;
  return normalizeLocationStatus(location.status) === "active";
}

/**
 * Check if the location is HQ.
 */
export function isHqLocation(location: any): boolean {
  if (!location) return false;
  return !!location.isHq || !!location.is_hq || location.id === "LOC-HQ" || location.type === "hq";
}

/**
 * Check if the location is internal.
 */
export function isInternalLocation(location: any): boolean {
  if (!location) return false;
  return !!location.isInternal || !!location.is_internal || location.id === "LOC-HQ";
}

/**
 * Check if the location is a warehouse.
 */
export function isWarehouseLocation(location: any): boolean {
  if (!location) return false;
  return location.type === "warehouse" || location.purpose === "warehouse";
}

/**
 * Check if the location is a store/outlet.
 */
export function isStoreLocation(location: any): boolean {
  if (!location) return false;
  if (isHqLocation(location) || isInternalLocation(location) || isWarehouseLocation(location)) {
    return false;
  }
  return location.purpose === "store" || location.type === "branch" || location.subtype === "Store";
}

/**
 * Check if the location is a valid delivery destination.
 * Valid delivery destinations must be active, not HQ, not internal, not warehouse, and explicitly marked as delivery destinations.
 */
export function isDeliveryDestinationLocation(location: any): boolean {
  if (!location) return false;
  const isDestFlag = location.isDeliveryDestination !== false && location.is_delivery_destination !== false;
  return (
    isActiveLocation(location) &&
    isDestFlag &&
    !isHqLocation(location) &&
    !isInternalLocation(location) &&
    !isWarehouseLocation(location)
  );
}

/**
 * Check if a location can have users assigned to it.
 * Active store/outlet locations or HQ.
 */
export function isUserAssignableLocation(location: any): boolean {
  if (!location) return false;
  return isActiveLocation(location) && (isStoreLocation(location) || isHqLocation(location));
}

/**
 * Role-aware check for whether a location's reports should be visible.
 */
export function isReportVisibleLocation(
  location: any,
  role: string | null | undefined,
  userLocationId: string | null | undefined
): boolean {
  if (!location) return false;
  const normRole = String(role ?? "").toLowerCase().trim();
  const isHq = normRole === "hq_admin" || normRole === "hq_master" || normRole === "hq_ops" || normRole === "admin" || normRole === "master_admin";
  if (isHq) {
    return isActiveLocation(location);
  }
  // Location manager scoped to their own
  return String(location.id) === String(userLocationId);
}

/**
 * Build the full address for a location.
 * Priorities:
 * 1. Physical store address fields in the billing profile
 * 2. Fall back to location table address fields if profile is missing
 */
export function buildFullLocationAddress(location: any, billingProfile: LocationBillingProfile | null | undefined): string {
  const street = (billingProfile?.storeAddress || location?.storeAddress || location?.address || location?.street || "").trim();
  const city = (billingProfile?.storeCity || location?.storeCity || location?.city || "").trim();
  const province = (billingProfile?.storeProvince || location?.storeProvince || location?.province || location?.state || "").trim();
  const postalCode = (billingProfile?.storePostalCode || location?.storePostalCode || location?.postal_code || location?.postalCode || "").trim();
  const country = (billingProfile?.storeAddress ? (billingProfile?.billingAddress ? "Canada" : "Canada") : "Canada"); // Default to Canada

  if (!street) {
    return "";
  }

  return `${street}, ${city}, ${province} ${postalCode}, Canada`
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Health check validation logic for locations.
 */
export function getLocationHealthStatus(
  location: any,
  billingProfile: LocationBillingProfile | null | undefined,
  activity?: { openTicketsCount?: number; assignedUsersCount?: number; openRequisitionsCount?: number }
): string[] {
  const warnings: string[] = [];
  if (!location) return ["Invalid location data"];

  const isActive = isActiveLocation(location);
  const isHq = isHqLocation(location);
  const isDest = location.isDeliveryDestination !== false && location.is_delivery_destination !== false;

  const street = (billingProfile?.storeAddress || location?.storeAddress || location?.address || location?.street || "").trim();
  const city = (billingProfile?.storeCity || location?.storeCity || location?.city || "").trim();
  const province = (billingProfile?.storeProvince || location?.storeProvince || location?.province || location?.state || "").trim();
  const postalCode = (billingProfile?.storePostalCode || location?.storePostalCode || location?.postal_code || location?.postalCode || "").trim();

  // 1. Missing physical address
  if (!street) {
    warnings.push("Missing physical address");
  }

  // 2. Missing city/province/postal code
  if (street && (!city || !province || !postalCode)) {
    warnings.push("Missing city, province, or postal code");
  }

  // 3. Missing billing profile
  if (!billingProfile) {
    warnings.push("Missing billing profile");
  }

  // 4. Status casing inconsistent
  if (location.status && location.status !== "active" && location.status !== "inactive") {
    warnings.push(`Status casing inconsistent ('${location.status}')`);
  }

  // 5. Active store not marked as delivery destination
  if (isActive && isStoreLocation(location) && !isDest) {
    warnings.push("Active store not marked as delivery destination");
  }

  // 6. Delivery destination but no address
  if (isDest && !street) {
    warnings.push("Delivery destination but missing physical address");
  }

  // 7. Location has users but inactive
  if (!isActive && (activity?.assignedUsersCount ?? 0) > 0) {
    warnings.push("Location is inactive but has assigned users");
  }

  // 8. Location has open requisitions or tickets but inactive
  if (!isActive && ((activity?.openRequisitionsCount ?? 0) > 0 || (activity?.openTicketsCount ?? 0) > 0)) {
    warnings.push("Location is inactive but has open activity");
  }

  // 9. Delivery tickets missing address
  if (street === "" && (activity?.openTicketsCount ?? 0) > 0) {
    warnings.push("Location has open tickets but missing address");
  }

  // 10. HQ missing start address
  if (isHq && !street) {
    warnings.push("HQ location missing start address profile");
  }

  return warnings;
}
