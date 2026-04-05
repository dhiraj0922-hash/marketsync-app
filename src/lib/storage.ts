export const STORAGE_KEYS = {
  ORDERS: "restaurant_orders",
  INVENTORY: "restaurant_inventory",
  COUNTS: "restaurant_counts",
  INVENTORY_ACTIVITY: "restaurant_inventory_activity",
  CATEGORIES: "restaurant_categories",
  IMPORT_BATCHES: "restaurant_import_batches",
  SUPPLIERS: "restaurant_suppliers",
  REQUISITIONS: "restaurant_requisitions",
  RECIPES: "restaurant_recipes",
  PRODUCTION_HISTORY: "restaurant_production_history",
  PRODUCTION_PLANS: "restaurant_production_plans",
  USERS: "restaurant_users",
  LOCATIONS: "restaurant_locations"
};

const getRelativeDate = (daysAgo: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const defaultOrders: any[] = [];

// Recipes Logic Persistence Map
export const defaultRecipes = [
  { 
    id: "REC-01", name: "Butter Chicken Base", category: "Mains", yieldQty: 10, yieldUnit: "kg", theoreticalCost: 85.50, margin: 70,
    ingredients: [
      { inventoryId: 102, name: "Chicken Breast", qty: 4, unit: "kg" },
      { inventoryId: 101, name: "Tomatoes (Roma)", qty: 2, unit: "kg" },
      { inventoryId: 106, name: "Onions (Yellow)", qty: 1.5, unit: "kg" }
    ]
  },
  { 
    id: "REC-02", name: "Chole", category: "Mains", yieldQty: 15, yieldUnit: "kg", theoreticalCost: 45.20, margin: 80,
    ingredients: [
      { inventoryId: 101, name: "Tomatoes (Roma)", qty: 3, unit: "kg" },
      { inventoryId: 106, name: "Onions (Yellow)", qty: 2, unit: "kg" }
    ]
  },
  { 
    id: "REC-03", name: "Pizza Dough Batch", category: "Prep", yieldQty: 20, yieldUnit: "kg", theoreticalCost: 15.00, margin: 90,
    ingredients: [
      { inventoryId: 103, name: "Olive Oil", qty: 0.5, unit: "Litre" }
    ]
  },
  { 
    id: "REC-04", name: "Garlic Sauce", category: "Sauces", yieldQty: 5, yieldUnit: "Litre", theoreticalCost: 12.30, margin: 85,
    ingredients: [
      { inventoryId: 103, name: "Olive Oil", qty: 2, unit: "Litre" }
    ]
  }
];

export function loadRecipes() {
  if (typeof window === "undefined") return defaultRecipes;
  const stored = localStorage.getItem(STORAGE_KEYS.RECIPES);
  if (stored) {
    try { return JSON.parse(stored); } catch(e) { return defaultRecipes; }
  }
  return defaultRecipes;
}

export function saveRecipes(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.RECIPES, JSON.stringify(data));
}

// DEPRECATED COMPATIBILITY SHIM: Finished Goods Standalone
export function loadFinishedGoods() {
  const inv = loadInventory();
  return inv.filter((i: any) => i.itemType === "Finished Good" || i.itemType === "Preparation");
}

export function saveFinishedGoods(fgs: any[]) {
  const inv = loadInventory();
  fgs.forEach(fgItem => {
     const match = inv.findIndex((i: any) => i.id.toString() === fgItem.id.toString());
     if (match !== -1) {
        inv[match] = { ...inv[match], ...fgItem };
     }
  });
  saveInventory(inv);
}

// Requisitions Data (FGs only)
export const defaultRequisitions: any[] = [];

export function loadRequisitions() {
  if (typeof window === "undefined") return defaultRequisitions;
  const stored = localStorage.getItem(STORAGE_KEYS.REQUISITIONS);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch(e) {
      return defaultRequisitions;
    }
  }
  return defaultRequisitions;
}

export function saveRequisitions(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.REQUISITIONS, JSON.stringify(data));
}

// Unified Inventory Data mapped for both Inventory and Orders usage
export const defaultInventory = [
  { 
    id: 101, name: "Tomatoes (Roma)", category: "Produce", itemType: "Raw", baseUnit: "kg", unit: "kg", 
    inStock: 0, parLevel: 15, cost: 2.20, supplierId: 2, priceTrend: "steady", priceIncrease: false,
    purchaseUnits: [{ name: "Case", conversion: 10, isPrimary: true }, { name: "Bag", conversion: 2, isPrimary: false }]
  },
  { 
    id: 102, name: "Chicken Breast", category: "Meat", itemType: "Raw", baseUnit: "kg", unit: "kg", 
    inStock: 0, parLevel: 45, cost: 5.50, supplierId: 1, priceTrend: "up", priceIncrease: true,
    purchaseUnits: [{ name: "Box", conversion: 15, isPrimary: true }]
  },
  { 
    id: 103, name: "Olive Oil", category: "Pantry", itemType: "Raw", baseUnit: "Litre", unit: "Litre", 
    inStock: 0, parLevel: 10, cost: 18.00, supplierId: 4, priceTrend: "steady", priceIncrease: false,
    purchaseUnits: [{ name: "Jug", conversion: 4, isPrimary: true }]
  },
  { 
    id: 104, name: "Salmon Fillet", category: "Produce", itemType: "Raw", baseUnit: "kg", unit: "kg", 
    inStock: 0, parLevel: 10, cost: 15.00, supplierId: 3, priceTrend: "down", priceIncrease: false,
    purchaseUnits: [{ name: "Case", conversion: 20, isPrimary: true }]
  },
  { 
    id: 105, name: "Lettuce (Romaine)", category: "Produce", itemType: "Raw", baseUnit: "piece", unit: "box", 
    inStock: 0, parLevel: 30, cost: 24.50, supplierId: 2, priceTrend: "up", priceIncrease: true,
    purchaseUnits: [{ name: "Box", conversion: 12, isPrimary: true }, { name: "Single", conversion: 1, isPrimary: false }]
  },
  { 
    id: 106, name: "Onions (Yellow)", category: "Produce", itemType: "Raw", baseUnit: "kg", unit: "kg", 
    inStock: 0, parLevel: 20, cost: 1.10, supplierId: 2, priceTrend: "steady", priceIncrease: false,
    purchaseUnits: [{ name: "Sack", conversion: 25, isPrimary: true }]
  },
  { 
    id: 107, name: "Ground Beef 80/20", category: "Meat", itemType: "Raw", baseUnit: "lb", unit: "lb", 
    inStock: 0, parLevel: 40, cost: 3.20, supplierId: 1, priceTrend: "steady", priceIncrease: false,
    purchaseUnits: [{ name: "Chub", conversion: 10, isPrimary: true }]
  },
  {
    id: "FG-101", name: "Butter Chicken Base", category: "Kitchen Prep", itemType: "Preparation", baseUnit: "kg", unit: "kg",
    inStock: 0, parLevel: 50, cost: 8.55, supplierId: null, priceTrend: "steady", priceIncrease: false,
    purchaseUnits: [{ name: "kg", conversion: 1, isPrimary: true }]
  },
  {
    id: "FG-102", name: "Chole", category: "Kitchen Prep", itemType: "Preparation", baseUnit: "kg", unit: "kg",
    inStock: 0, parLevel: 30, cost: 3.01, supplierId: null, priceTrend: "steady", priceIncrease: false,
    purchaseUnits: [{ name: "kg", conversion: 1, isPrimary: true }]
  },
  {
    id: "FG-103", name: "Pizza Dough Batch", category: "Kitchen Prep", itemType: "Preparation", baseUnit: "kg", unit: "kg",
    inStock: 0, parLevel: 20, cost: 0.75, supplierId: null, priceTrend: "steady", priceIncrease: false,
    purchaseUnits: [{ name: "kg", conversion: 1, isPrimary: true }]
  },
  {
    id: "FG-104", name: "Garlic Sauce", category: "Kitchen Prep", itemType: "Preparation", baseUnit: "Litre", unit: "Litre",
    inStock: 0, parLevel: 5, cost: 2.46, supplierId: null, priceTrend: "steady", priceIncrease: false,
    purchaseUnits: [{ name: "Litre", conversion: 1, isPrimary: true }]
  }
];

export function loadInventory() {
  if (typeof window === "undefined") return defaultInventory;
  const stored = localStorage.getItem(STORAGE_KEYS.INVENTORY);
  if (stored) {
    try {
      let data = JSON.parse(stored);
      let migrated = false;
      data = data.map((item: any) => {
         if (item.supplier && typeof item.supplier === "string") {
            migrated = true;
            item.supplierId = resolveSupplier(item.supplier);
            delete item.supplier;
         }
         if (!item.purchaseUnits || !item.baseUnit) {
            migrated = true;
            item.baseUnit = item.baseUnit || item.unit || "N/A";
            item.unit = item.baseUnit || item.unit || "N/A";
            item.purchaseUnits = item.purchaseUnits || [{
               name: item.unit || "Unit",
               conversion: 1,
               isPrimary: true
            }];
         }
         
         if (!item.itemType) {
            migrated = true;
            item.itemType = "Raw"; // Safely default legacy unmapped schema to raw ingredients
         }
         return item;
      });
      if (migrated) saveInventory(data);
      return data;
    } catch (e) {
      return defaultInventory;
    }
  }
  return defaultInventory;
}

export function saveInventory(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.INVENTORY, JSON.stringify(data));
}

// HQ Production Engine Logging
export const defaultProductionHistory: any[] = [];

export function loadProductionHistory() {
  if (typeof window === "undefined") return defaultProductionHistory;
  const stored = localStorage.getItem(STORAGE_KEYS.PRODUCTION_HISTORY);
  if (stored) {
    try { return JSON.parse(stored); } catch(e) { return defaultProductionHistory; }
  }
  return defaultProductionHistory;
}

export function saveProductionHistory(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.PRODUCTION_HISTORY, JSON.stringify(data));
}

// Production Plans (Automation Engine)
export const defaultProductionPlans: any[] = [];

export function loadProductionPlans() {
  if (typeof window === "undefined") return defaultProductionPlans;
  const stored = localStorage.getItem(STORAGE_KEYS.PRODUCTION_PLANS);
  if (stored) {
    try { return JSON.parse(stored); } catch(e) { return defaultProductionPlans; }
  }
  return defaultProductionPlans;
}

export function saveProductionPlans(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.PRODUCTION_PLANS, JSON.stringify(data));
}

// Activity History Tracking
export const defaultActivity = {}; // e.g. { "101": [{date: "Apr 2, 2026", type: "Spoilage", qty: -2, notes: "Dropped"}] }

export function loadInventoryActivity() {
  if (typeof window === "undefined") return defaultActivity;
  const stored = localStorage.getItem(STORAGE_KEYS.INVENTORY_ACTIVITY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch(e) {
      return defaultActivity;
    }
  }
  return defaultActivity;
}

export function saveInventoryActivity(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.INVENTORY_ACTIVITY, JSON.stringify(data));
}

// Category Persistence Mapping
export const defaultCategories = ["Produce", "Meat", "Pantry", "Dairy", "Beverages"];

export function loadCategories() {
  if (typeof window === "undefined") return defaultCategories;
  const stored = localStorage.getItem(STORAGE_KEYS.CATEGORIES);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch(e) {
      return defaultCategories;
    }
  }
  return defaultCategories;
}

export function saveCategories(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(data));
}

// Suppliers Persistence Mapping
export const defaultSuppliers = [
  { 
    id: 1, 
    name: "Valley Meat Co.", 
    category: "Meat & Poultry", 
    contact: "Mike Reynolds", 
    phone: "(555) 987-6543", 
    email: "sales@valleymeat.com", 
    location: "National",
    itemsCount: 45, 
    minOrder: "$500",
    paymentTerms: "Net 30",
    leadTime: "2 Days",
    orderFreq: "Weekly",
    onTimePct: 98.5,
    priceVariance: 1.2,
    status: "Active",
    rating: "Top Tier"
  },
  { 
    id: 2, 
    name: "Fresh Farms Produce", 
    category: "Produce", 
    contact: "Sarah Jenkins", 
    phone: "(555) 123-4567", 
    email: "orders@freshfarms.com", 
    location: "Local (Downtown)",
    itemsCount: 120, 
    minOrder: "$150",
    paymentTerms: "Net 15",
    leadTime: "Next Day",
    orderFreq: "Daily",
    onTimePct: 92.0,
    priceVariance: -0.5,
    status: "Active",
    rating: "Standard"
  },
  { 
    id: 3, 
    name: "Ocean Catch Seafood", 
    category: "Seafood", 
    contact: "David Watts", 
    phone: "(555) 456-7890", 
    email: "orders@oceancatch.com", 
    location: "Regional",
    itemsCount: 18, 
    minOrder: "$800",
    paymentTerms: "Due on Receipt",
    leadTime: "3 Days",
    orderFreq: "Bi-Weekly",
    onTimePct: 85.5,
    priceVariance: 12.4,
    status: "Review",
    rating: "At Risk"
  },
  { 
    id: 4, 
    name: "National Distributing", 
    category: "Beverage", 
    contact: "Lisa Romero", 
    phone: "(555) 222-3333", 
    email: "support@nationaldist.com", 
    location: "National",
    itemsCount: 85, 
    minOrder: "$1,000",
    paymentTerms: "Net 60",
    leadTime: "5 Days",
    orderFreq: "Monthly",
    onTimePct: 99.9,
    priceVariance: 0.1,
    status: "Active",
    rating: "Top Tier"
  },
];

export function loadSuppliers() {
  if (typeof window === "undefined") return defaultSuppliers;
  const stored = localStorage.getItem(STORAGE_KEYS.SUPPLIERS);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch(e) {
      return defaultSuppliers;
    }
  }
  return defaultSuppliers;
}

export function saveSuppliers(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.SUPPLIERS, JSON.stringify(data));
}

export function resolveSupplier(supplierName: string): number | null {
  if (!supplierName || typeof supplierName !== 'string') return null;
  
  const normalizedInput = supplierName.trim().replace(/\s+/g, ' ');
  const lowercaseInput = normalizedInput.toLowerCase();
  
  if (!lowercaseInput) return null;

  const suppliers = loadSuppliers();
  
  const match = suppliers.find((s: any) => s.name.trim().replace(/\s+/g, ' ').toLowerCase() === lowercaseInput);
  
  if (match) {
    return match.id;
  }
  
  const newSupplier = {
      id: Math.floor(Math.random() * 900000) + 100000,
      name: normalizedInput,
      category: "General",
      contact: "-",
      phone: "-",
      email: "-",
      location: "System Generated",
      itemsCount: 0,
      minOrder: "-",
      paymentTerms: "-",
      leadTime: "-",
      orderFreq: "-",
      onTimePct: 100,
      priceVariance: 0,
      status: "Auto-created",
      rating: "Review"
  };
  
  const updated = [newSupplier, ...suppliers];
  saveSuppliers(updated);
  return newSupplier.id;
}

// BATCH TRACKING LAYER
export const defaultBatches: any[] = [];

export function loadImportBatches() {
  if (typeof window === "undefined") return defaultBatches;
  const stored = localStorage.getItem(STORAGE_KEYS.IMPORT_BATCHES);
  if (stored) {
    try { return JSON.parse(stored); } catch(e) { return defaultBatches; }
  }
  return defaultBatches;
}

export function saveImportBatches(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.IMPORT_BATCHES, JSON.stringify(data));
}

export function loadOrders() {
  if (typeof window === "undefined") return defaultOrders;
  const stored = localStorage.getItem(STORAGE_KEYS.ORDERS);
  if (stored) {
    try {
      let data = JSON.parse(stored);
      let migrated = false;
      data = data.map((item: any) => {
         if (item.supplier && typeof item.supplier === "string") {
            migrated = true;
            item.supplierId = resolveSupplier(item.supplier);
            delete item.supplier;
         }
         return item;
      });
      if (migrated) saveOrders(data);
      return data;
    } catch(e) {
      return defaultOrders;
    }
  }
  return defaultOrders;
}

export function saveOrders(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(data));
}

// Counts Data Logic

export const defaultCounts: any[] = [];

export function loadCounts() {
  if (typeof window === "undefined") return defaultCounts;
  const stored = localStorage.getItem(STORAGE_KEYS.COUNTS);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch(e) {
      return defaultCounts;
    }
  }
  return defaultCounts;
}

export function saveCounts(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.COUNTS, JSON.stringify(data));
}

// User ACL Management
export const defaultUsers = [
  { id: "USR-001", name: "Admin User", email: "admin@hq.com", role: "HQ Admin", assignedLocations: ["All"], status: "Active", lastActive: "Today", notes: "System Owner" },
  { id: "USR-002", name: "Sarah Jenkins", email: "sarah@downtown.com", role: "Location Manager", assignedLocations: ["Downtown"], status: "Active", lastActive: "Today", notes: "Downtown core" },
  { id: "USR-003", name: "Mike T.", email: "mike@downtown.com", role: "Kitchen Staff", assignedLocations: ["Downtown", "HQ"], status: "Active", lastActive: "Yesterday", notes: "" },
  { id: "USR-004", name: "David Watts", email: "david@uptown.com", role: "Location Manager", assignedLocations: ["Uptown"], status: "Active", lastActive: "2 days ago", notes: "" },
  { id: "USR-005", name: "Finance Dept", email: "purchasing@hq.com", role: "Finance / Purchasing", assignedLocations: ["HQ"], status: "Active", lastActive: "1 min ago", notes: "Reports & Ordering" },
];

export function loadUsers() {
  if (typeof window === "undefined") return defaultUsers;
  const stored = localStorage.getItem(STORAGE_KEYS.USERS);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch(e) {
      return defaultUsers;
    }
  }
  return defaultUsers;
}

export function saveUsers(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(data));
}

// Physical Region Architecture
export const defaultLocations = [
  { id: "LOC-100", name: "HQ", code: "HQ1", type: "HQ", status: "Active", createdAt: new Date().toISOString() },
  { id: "LOC-101", name: "Downtown", code: "DT1", type: "Store", status: "Active", createdAt: new Date().toISOString() },
  { id: "LOC-102", name: "Uptown", code: "UT1", type: "Store", status: "Active", createdAt: new Date().toISOString() },
  { id: "LOC-103", name: "Airport", code: "AP1", type: "Airport", status: "Active", createdAt: new Date().toISOString() },
  { id: "LOC-104", name: "Westside", code: "WS1", type: "Store", status: "Active", createdAt: new Date().toISOString() },
];

export function loadLocations() {
  if (typeof window === "undefined") return defaultLocations;
  const stored = localStorage.getItem(STORAGE_KEYS.LOCATIONS);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch(e) {
      return defaultLocations;
    }
  }
  return defaultLocations;
}

export function saveLocations(data: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.LOCATIONS, JSON.stringify(data));
}
