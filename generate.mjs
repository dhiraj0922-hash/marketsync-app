import fs from 'fs';

const storageContent = `import { supabase } from "@/lib/supabase";

// ============================================================================
// GLOBAL MAPPER ARCHITECTURE
// All read/write bounds mathematically mapping camelCase and complex DOM arrays
// exclusively into Postgres strictly lowercase unquoted table bounds preserving
// natively. No module will write to Supabase structurally outside this firewall.
// ============================================================================


// ----------------------------------------------------------------------------
// 1. INVENTORY ITEMS 
// ----------------------------------------------------------------------------
const mapInventoryToFrontend = (db: any) => ({
     id: db.id,
     name: db.name,
     category: db.category,
     itemType: db.itemtype,
     baseUnit: db.baseunit,
     unit: db.unit,
     inStock: db.instock,
     parLevel: db.parlevel,
     cost: db.cost,
     supplierId: db.supplierid,
     priceTrend: db.pricetrend,
     priceIncrease: db.priceincrease,
     purchaseUnits: db.purchaseunits || []
});

const mapInventoryToDB = (item: any) => ({
     id: String(item.id || ''),
     name: item.name || '',
     category: item.category || '',
     itemtype: item.itemType || '',
     baseunit: item.baseUnit || '',
     unit: item.unit || '',
     instock: isNaN(parseFloat(item.inStock)) ? 0 : parseFloat(item.inStock),
     parlevel: isNaN(parseFloat(item.parLevel)) ? 0 : parseFloat(item.parLevel),
     cost: isNaN(parseFloat(item.cost)) ? 0 : parseFloat(item.cost),
     supplierid: typeof item.supplierId === 'number' ? item.supplierId : null,
     pricetrend: item.priceTrend || 'steady',
     priceincrease: Boolean(item.priceIncrease),
     purchaseunits: Array.isArray(item.purchaseUnits) ? item.purchaseUnits : []
});

export async function loadInventory() {
  const { data, error } = await supabase.from('inventory_items').select('*');
  if (error) {
    console.error("Error loading inventory:", error);
    return [];
  }
  return Array.isArray(data) ? data.map(mapInventoryToFrontend) : [];
}

export async function saveInventory(data: any[]) {
  const cleanData = data.map(mapInventoryToDB);
  const { error } = await supabase.from('inventory_items').upsert(cleanData, { onConflict: 'id' });
  if (error) {
     console.error("Error saving inventory:", error);
     return { success: false, error };
  }
  return { success: true };
}

// Finished Goods Shim
export async function loadFinishedGoods() {
  const inv = await loadInventory();
  return inv.filter((i: any) => i.itemType === "Finished Good" || i.itemType === "Preparation");
}
export async function saveFinishedGoods(fgs: any[]) {
  const inv = await loadInventory();
  fgs.forEach(fgItem => {
     const match = inv.findIndex((i: any) => i.id.toString() === fgItem.id.toString());
     if (match !== -1) inv[match] = { ...inv[match], ...fgItem };
  });
  return await saveInventory(inv);
}


// ----------------------------------------------------------------------------
// 2. SUPPLIERS 
// ----------------------------------------------------------------------------
const mapSupplierToFrontend = (db: any) => ({
    id: db.id,
    name: db.name,
    category: db.category,
    contact: db.contact,
    phone: db.phone,
    email: db.email,
    location: db.location,
    itemsCount: db.itemscount,
    minOrder: db.minorder,
    paymentTerms: db.paymentterms,
    leadTime: db.leadtime,
    orderFreq: db.orderfreq,
    onTimePct: db.ontimepct,
    priceVariance: db.pricevariance,
    status: db.status,
    rating: db.rating
});

const mapSupplierToDB = (s: any) => {
   const mapped = {
      name: s.name || '',
      category: s.category || '',
      contact: s.contact || '',
      phone: s.phone || '',
      email: s.email || '',
      location: s.location || '',
      itemscount: isNaN(parseInt(s.itemsCount)) ? 0 : parseInt(s.itemsCount),
      minorder: s.minOrder || '',
      paymentterms: s.paymentTerms || '',
      leadtime: s.leadTime || '',
      orderfreq: s.orderFreq || '',
      ontimepct: isNaN(parseFloat(s.onTimePct)) ? 100 : parseFloat(s.onTimePct),
      pricevariance: isNaN(parseFloat(s.priceVariance)) ? 0 : parseFloat(s.priceVariance),
      status: s.status || '',
      rating: s.rating || ''
   };
   if (s.id && typeof s.id === 'number') (mapped as any).id = s.id;
   return mapped;
};

export async function loadSuppliers() {
  const { data, error } = await supabase.from('suppliers').select('*');
  if (error) {
     console.error("Error loading suppliers:", error);
     return [];
  }
  return Array.isArray(data) ? data.map(mapSupplierToFrontend) : [];
}

export async function saveSuppliers(data: any[]) {
  const cleanData = data.map(mapSupplierToDB);
  const { error } = await supabase.from('suppliers').upsert(cleanData, { onConflict: 'id' });
  if (error) {
     console.error("Error saving suppliers:", error);
     return { success: false, error };
  }
  return { success: true };
}

export async function resolveSupplier(supplierName: string): Promise<number | null> {
  if (!supplierName || typeof supplierName !== 'string') return null;
  const lowercaseInput = supplierName.trim().replace(/\\s+/g, ' ').toLowerCase();
  if (!lowercaseInput) return null;

  const suppliers = await loadSuppliers();
  const match = suppliers.find((s: any) => s.name.trim().replace(/\\s+/g, ' ').toLowerCase() === lowercaseInput);
  if (match) return match.id;
  
  const newSupplier = {
      name: supplierName.trim().replace(/\\s+/g, ' '),
      category: "General",
      contact: "-", phone: "-", email: "-", location: "System Generated",
      itemsCount: 0, minOrder: "-", paymentTerms: "-", leadTime: "-", orderFreq: "-",
      onTimePct: 100, priceVariance: 0, status: "Auto-created", rating: "Review"
  };
  
  const payload = mapSupplierToDB(newSupplier);
  const { data, error } = await supabase.from('suppliers').insert(payload).select();
  if (error) {
     console.error("Resolve Supplier DB Error:", error);
     throw error;
  }
  return data?.[0]?.id;
}


// ----------------------------------------------------------------------------
// 3. RECIPES 
// ----------------------------------------------------------------------------
const mapRecipeToFrontend = (db: any) => ({
    id: db.id,
    name: db.name,
    category: db.category,
    yieldQty: db.yieldqty,
    yieldUnit: db.yieldunit,
    theoreticalCost: db.theoreticalcost,
    margin: db.margin,
    ingredients: db.ingredients || []
});

const mapRecipeToDB = (r: any) => ({
    id: String(r.id || ''),
    name: r.name || '',
    category: r.category || '',
    yieldqty: isNaN(parseFloat(r.yieldQty)) ? 0 : parseFloat(r.yieldQty),
    yieldunit: r.yieldUnit || '',
    theoreticalcost: isNaN(parseFloat(r.theoreticalCost)) ? 0 : parseFloat(r.theoreticalCost),
    margin: isNaN(parseFloat(r.margin)) ? 0 : parseFloat(r.margin),
    ingredients: Array.isArray(r.ingredients) ? r.ingredients : []
});

export async function loadRecipes() {
  const { data, error } = await supabase.from('recipes').select('*');
  if (error) return [];
  return Array.isArray(data) ? data.map(mapRecipeToFrontend) : [];
}

export async function saveRecipes(data: any[]) {
  const cleanData = data.map(mapRecipeToDB);
  const { error } = await supabase.from('recipes').upsert(cleanData, { onConflict: 'id' });
  if (error) {
     console.error("Error saving recipes:", error);
     return { success: false, error };
  }
  return { success: true };
}


// ----------------------------------------------------------------------------
// 4. ORDERS 
// ----------------------------------------------------------------------------
const mapOrderToFrontend = (db: any) => ({
     id: db.id,
     supplierId: db.supplierid,
     supplierName: db.suppliername,
     date: db.date,
     deliveryDate: db.deliverydate,
     items: db.items,
     total: db.total,
     status: db.status,
     location: db.location,
     createdBy: db.createdby,
     receivedBy: db.receivedby,
     receivedAt: db.receivedat,
     notes: db.notes,
     lineItems: db.lineitems || []
});

const mapOrderToDB = (o: any) => ({
     id: String(o.id || ''),
     supplierid: typeof o.supplierId === 'number' ? o.supplierId : null,
     suppliername: o.supplierName || '',
     date: o.date || '',
     deliverydate: o.deliveryDate || '',
     items: isNaN(parseInt(o.items)) ? 0 : parseInt(o.items),
     total: isNaN(parseFloat(o.total)) ? 0 : parseFloat(o.total),
     status: o.status || '',
     location: o.location || '',
     createdby: o.createdBy || '',
     receivedby: o.receivedBy || '',
     receivedat: o.receivedAt || '',
     notes: o.notes || '',
     lineitems: Array.isArray(o.lineItems) ? o.lineItems : []
});

export async function loadOrders() {
  const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  if (error) return [];
  return Array.isArray(data) ? data.map(mapOrderToFrontend) : [];
}

export async function saveOrders(data: any[]) {
  const cleanData = data.map(mapOrderToDB);
  const { error } = await supabase.from('orders').upsert(cleanData, { onConflict: 'id' });
  if (error) {
     console.error("Error saving orders:", error);
     return { success: false, error };
  }
  return { success: true };
}


// ----------------------------------------------------------------------------
// 5. REQUISITIONS 
// ----------------------------------------------------------------------------
const mapRequisitionToFrontend = (db: any) => ({
    id: db.id,
    location: db.location,
    requestedBy: db.requestedby,
    date: db.date,
    status: db.status,
    items: db.items,
    notes: db.notes,
    lineItems: db.lineitems || []
});

const mapRequisitionToDB = (req: any) => ({
    id: String(req.id || ''),
    location: req.location || '',
    requestedby: req.requestedBy || '',
    date: req.date || '',
    status: req.status || '',
    items: isNaN(parseInt(req.items)) ? 0 : parseInt(req.items),
    notes: req.notes || '',
    lineitems: Array.isArray(req.lineItems) ? req.lineItems : []
});

export async function loadRequisitions() {
  const { data, error } = await supabase.from('requisitions').select('*').order('created_at', { ascending: false });
  if (error) return [];
  return Array.isArray(data) ? data.map(mapRequisitionToFrontend) : [];
}

export async function saveRequisitions(data: any[]) {
  const cleanData = data.map(mapRequisitionToDB);
  const { error } = await supabase.from('requisitions').upsert(cleanData, { onConflict: 'id' });
  if (error) {
     console.error("Error saving requisitions:", error);
     return { success: false, error };
  }
  return { success: true };
}


// ----------------------------------------------------------------------------
// 6. COUNTS 
// ----------------------------------------------------------------------------
const mapCountToFrontend = (db: any) => ({
    id: db.id,
    name: db.name,
    type: db.type,
    status: db.status,
    date: db.date,
    location: db.location,
    items: db.items || [],
    totalVarianceValue: db.totalvariancevalue
});

const mapCountToDB = (c: any) => ({
    id: String(c.id || ''),
    name: c.name || '',
    type: c.type || '',
    status: c.status || '',
    date: c.date || '',
    location: c.location || '',
    items: Array.isArray(c.items) ? c.items : [],
    totalvariancevalue: isNaN(parseFloat(c.totalVarianceValue)) ? 0 : parseFloat(c.totalVarianceValue)
});

export async function loadCounts() {
  const { data, error } = await supabase.from('counts').select('*').order('created_at', { ascending: false });
  if (error) return [];
  return Array.isArray(data) ? data.map(mapCountToFrontend) : [];
}

export async function saveCounts(data: any[]) {
  const cleanData = data.map(mapCountToDB);
  const { error } = await supabase.from('counts').upsert(cleanData, { onConflict: 'id' });
  if (error) {
     console.error("Error saving counts:", error);
     return { success: false, error };
  }
  return { success: true };
}


// ----------------------------------------------------------------------------
// 7. PRODUCTION PLANS 
// ----------------------------------------------------------------------------
const mapPlanToFrontend = (db: any) => ({
    id: db.id,
    fgId: db.fgid,
    fgName: db.fgname,
    quantity: db.quantity,
    unit: db.unit,
    date: db.date,
    status: db.status,
    priority: db.priority,
    location: db.location,
    assignedTo: db.assignedto,
    notes: db.notes,
    ingredients: db.ingredients || []
});

const mapPlanToDB = (p: any) => ({
    id: String(p.id || ''),
    fgid: p.fgId || '',
    fgname: p.fgName || '',
    quantity: isNaN(parseFloat(p.quantity)) ? 0 : parseFloat(p.quantity),
    unit: p.unit || '',
    date: p.date || '',
    status: p.status || '',
    priority: p.priority || '',
    location: p.location || '',
    assignedto: p.assignedTo || '',
    notes: p.notes || '',
    ingredients: Array.isArray(p.ingredients) ? p.ingredients : []
});

export async function loadProductionPlans() {
  const { data, error } = await supabase.from('production_plans').select('*');
  if (error) return [];
  return Array.isArray(data) ? data.map(mapPlanToFrontend) : [];
}

export async function saveProductionPlans(data: any[]) {
  const cleanData = data.map(mapPlanToDB);
  const { error } = await supabase.from('production_plans').upsert(cleanData, { onConflict: 'id' });
  if (error) {
     console.error("Error saving plans:", error);
     return { success: false, error };
  }
  return { success: true };
}


// ----------------------------------------------------------------------------
// 8. PRODUCTION HISTORY 
// ----------------------------------------------------------------------------
const mapHistoryToFrontend = (db: any) => ({
    id: db.id,
    planId: db.planid,
    fgId: db.fgid,
    fgName: db.fgname,
    quantity: db.quantity,
    unit: db.unit,
    date: db.date,
    completedBy: db.completedby,
    variance: db.variance,
    notes: db.notes
});

const mapHistoryToDB = (h: any) => ({
    id: String(h.id || ''),
    planid: h.planId || '',
    fgid: h.fgId || '',
    fgname: h.fgName || '',
    quantity: isNaN(parseFloat(h.quantity)) ? 0 : parseFloat(h.quantity),
    unit: h.unit || '',
    date: h.date || '',
    completedby: h.completedBy || '',
    variance: isNaN(parseFloat(h.variance)) ? 0 : parseFloat(h.variance),
    notes: h.notes || ''
});

export async function loadProductionHistory() {
  const { data, error } = await supabase.from('production_history').select('*').order('created_at', { ascending: false });
  if (error) return [];
  return Array.isArray(data) ? data.map(mapHistoryToFrontend) : [];
}

export async function saveProductionHistory(data: any[]) {
  const cleanData = data.map(mapHistoryToDB);
  const { error } = await supabase.from('production_history').upsert(cleanData, { onConflict: 'id' });
  if (error) {
     console.error("Error saving history:", error);
     return { success: false, error };
  }
  return { success: true };
}


// ----------------------------------------------------------------------------
// 9. IMPORT BATCHES 
// ----------------------------------------------------------------------------
const mapBatchToFrontend = (db: any) => ({
   batchId: db.id,
   timestamp: parseInt(db.date) || 0,
   fileName: db.filename,
   totalRowsProcessed: db.recordsinserted,
   metrics: db.metrics || {},
   newlyCreatedIds: db.newlycreatedids || [],
   rollbackData: db.rollbackdata || {},
   failedRows: db.failedrows || [],
   summary: db.summary || {},
   status: db.status,
   uploadedBy: db.uploadedby || "System"
});

const mapBatchToDB = (batch: any) => ({
   id: String(batch.batchId || ''),
   date: String(batch.timestamp || ''),
   filename: batch.fileName || "Unknown",
   recordsinserted: isNaN(parseInt(batch.totalRowsProcessed)) ? 0 : parseInt(batch.totalRowsProcessed),
   metrics: batch.metrics || {},
   newlycreatedids: Array.isArray(batch.newlyCreatedIds) ? batch.newlyCreatedIds : [],
   rollbackdata: batch.rollbackData || {},
   failedrows: Array.isArray(batch.failedRows) ? batch.failedRows : [],
   summary: batch.summary || {},
   status: batch.status || "Active",
   uploadedby: batch.uploadedBy || "Authenticated User"
});

export async function loadImportBatches() {
  const { data, error } = await supabase.from('import_batches').select('*').order('created_at', { ascending: false });
  if (error) return [];
  return Array.isArray(data) ? data.map(mapBatchToFrontend) : [];
}

export async function saveImportBatches(data: any[]) {
  const cleanData = data.map(mapBatchToDB);
  const { error } = await supabase.from('import_batches').upsert(cleanData, { onConflict: 'id' });
  if (error) {
     console.error("Error saving import batches:", error);
     return { success: false, error };
  }
  return { success: true };
}


// ----------------------------------------------------------------------------
// 10. SYSTEM USERS 
// ----------------------------------------------------------------------------
const mapUserToFrontend = (db: any) => ({
    id: db.id,
    name: db.name,
    email: db.email,
    role: db.role,
    assignedLocations: db.assignedlocations || [],
    status: db.status,
    lastActive: db.lastactive,
    notes: db.notes
});

const mapUserToDB = (u: any) => ({
    id: String(u.id || ''),
    name: u.name || '',
    email: u.email || '',
    role: u.role || '',
    assignedlocations: Array.isArray(u.assignedLocations) ? u.assignedLocations : [],
    status: u.status || 'Active',
    lastactive: u.lastActive || '',
    notes: u.notes || ''
});

export async function loadUsers() {
  const { data, error } = await supabase.from('system_users').select('*');
  if (error) return [];
  return Array.isArray(data) ? data.map(mapUserToFrontend) : [];
}

export async function saveUsers(data: any[]) {
  const cleanData = data.map(mapUserToDB);
  const { error } = await supabase.from('system_users').upsert(cleanData, { onConflict: 'id' });
  if (error) {
     console.error("Error saving users:", error);
     return { success: false, error };
  }
  return { success: true };
}


// ----------------------------------------------------------------------------
// 11. LOCATIONS 
// ----------------------------------------------------------------------------
const mapLocationToFrontend = (db: any) => ({
    id: db.id,
    name: db.name,
    code: db.code,
    type: db.type,
    status: db.status
});

const mapLocationToDB = (l: any) => ({
    id: String(l.id || ''),
    name: l.name || '',
    code: l.code || '',
    type: l.type || '',
    status: l.status || ''
});

export async function loadLocations() {
  const { data, error } = await supabase.from('locations').select('*');
  if (error) return [];
  return Array.isArray(data) ? data.map(mapLocationToFrontend) : [];
}

export async function saveLocations(data: any[]) {
  const cleanData = data.map(mapLocationToDB);
  const { error } = await supabase.from('locations').upsert(cleanData, { onConflict: 'id' });
  if (error) {
     console.error("Error saving locations:", error);
     return { success: false, error };
  }
  return { success: true };
}


// ----------------------------------------------------------------------------
// 12. INVENTORY ACTIVITY
// ----------------------------------------------------------------------------
export async function loadInventoryActivity() {
  const { data, error } = await supabase.from('inventory_activity').select('*');
  if (error) return {};
  
  const activityMap: Record<string, any[]> = {};
  data?.forEach(row => {
     if (!activityMap[row.inventory_id]) activityMap[row.inventory_id] = [];
     activityMap[row.inventory_id].push({
        date: row.date,
        type: row.type,
        qty: parseFloat(row.qty),
        notes: row.notes
     });
  });
  return activityMap;
}

export async function saveInventoryActivity(activityMap: Record<string, any[]>) {
  const rows: any[] = [];
  Object.entries(activityMap).forEach(([inventory_id, events]) => {
     events.forEach(event => {
        rows.push({
           inventory_id: String(inventory_id),
           date: event.date || '',
           type: event.type || '',
           qty: isNaN(parseFloat(event.qty)) ? 0 : parseFloat(event.qty),
           notes: event.notes || ''
        });
     });
  });
  
  if (rows.length > 0) {
      // Completely wipe table for backwards compatibility simulation
      await supabase.from('inventory_activity').delete().neq('id', 0);
      const { error } = await supabase.from('inventory_activity').insert(rows);
      if (error) {
         console.error("Activity sync error:", error);
         return { success: false, error };
      }
  }
  return { success: true };
}


// ----------------------------------------------------------------------------
// LOCAL CATEGORIES STUB
// ----------------------------------------------------------------------------
export async function loadCategories() {
  return ["Produce", "Meat", "Pantry", "Dairy", "Beverages"];
}

export async function saveCategories(data: any[]) {
  return { success: true };
}
\`;

fs.writeFileSync('src/lib/storage.ts', storageContent);
console.log('Successfully generated strict storage mappers natively.');
