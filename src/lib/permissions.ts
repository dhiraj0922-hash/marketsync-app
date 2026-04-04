export type Action = "read" | "create" | "edit" | "approve" | "execute" | "admin";
export type AppModule = "Dashboard" | "Inventory" | "Counts" | "Orders" | "Requisitions" | "FinishedGoods" | "Suppliers" | "Recipes" | "Reports" | "Users" | "Approvals";

export const PERMISSIONS_MATRIX: Record<string, Record<AppModule, Action[]>> = {
  "HQ Admin": {
    "Dashboard": ["read", "create", "edit", "approve", "execute", "admin"],
    "Inventory": ["read", "create", "edit", "approve", "execute", "admin"],
    "Counts": ["read", "create", "edit", "approve", "execute", "admin"],
    "Orders": ["read", "create", "edit", "approve", "execute", "admin"],
    "Requisitions": ["read", "create", "edit", "approve", "execute", "admin"],
    "FinishedGoods": ["read", "create", "edit", "approve", "execute", "admin"],
    "Suppliers": ["read", "create", "edit", "approve", "execute", "admin"],
    "Recipes": ["read", "create", "edit", "approve", "execute", "admin"],
    "Reports": ["read", "create", "edit", "approve", "execute", "admin"],
    "Users": ["read", "create", "edit", "approve", "execute", "admin"],
    "Approvals": ["read", "create", "edit", "approve", "execute", "admin"],
  },
  "HQ Manager": {
    "Dashboard": ["read", "create", "edit", "approve", "execute"],
    "Inventory": ["read", "create", "edit", "approve", "execute"],
    "Counts": ["read", "create", "edit", "approve", "execute"],
    "Orders": ["read", "create", "edit", "approve", "execute"],
    "Requisitions": ["read", "create", "edit", "approve", "execute"],
    "FinishedGoods": ["read", "create", "edit", "approve", "execute"],
    "Suppliers": ["read", "create", "edit", "approve", "execute"],
    "Recipes": ["read", "create", "edit", "approve", "execute"],
    "Reports": ["read", "create", "edit", "approve", "execute"],
    "Users": ["read"], // Read-only for HQ Manager visually
    "Approvals": ["read", "approve", "edit", "execute"],
  },
  "Location Manager": {
    // Scoped strictly via location logic internally, but Action rights enable operations.
    "Dashboard": ["read"],
    "Inventory": ["read"],
    "Counts": ["read", "create", "edit"],
    "Orders": ["read"], 
    "Requisitions": ["read", "create"], 
    "FinishedGoods": ["read"],
    "Suppliers": ["read"], 
    "Recipes": ["read"],
    "Reports": ["read"],
    "Users": ["read"],
    "Approvals": ["read"] 
  },
  "Kitchen Staff": {
    "Dashboard": ["read"],
    "Inventory": ["read"], 
    "Counts": ["read", "create", "edit"],
    "Orders": [],
    "Requisitions": ["read", "create"],
    "FinishedGoods": ["read", "execute"], // Important: Action "execute" isolates running workflows perfectly away from "edit" stock values manually
    "Suppliers": [],
    "Recipes": ["read"],
    "Reports": [],
    "Users": [],
    "Approvals": []
  },
  "Finance / Purchasing": {
    "Dashboard": ["read"],
    "Inventory": ["read"],
    "Counts": ["read"],
    "Orders": ["read", "create", "edit", "approve"],
    "Requisitions": ["read"],
    "FinishedGoods": ["read"],
    "Suppliers": ["read", "create", "edit"],
    "Recipes": [],
    "Reports": ["read", "create"],
    "Users": ["read"],
    "Approvals": ["read", "approve", "edit"]
  }
};

export function hasPermission(role: string, targetModule: AppModule, action: Action): boolean {
  if (role === 'HQ Admin') return true; // Supreme rule
  const roleAcls = PERMISSIONS_MATRIX[role];
  if (!roleAcls) return false;

  const moduleAcls = roleAcls[targetModule];
  if (!moduleAcls) return false;

  return moduleAcls.includes(action);
}

// Scoped Location Evaluation Rules
export function canAccessLocation(userAssignedLocations: string[], targetLocation: string): boolean {
  if (userAssignedLocations.includes("All")) return true;
  return userAssignedLocations.includes(targetLocation);
}
