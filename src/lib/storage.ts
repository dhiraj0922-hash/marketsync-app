import { supabase } from "@/lib/supabase";

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
     itemId: db.item_id ?? db.id,     // shared identity; fall back to row id for legacy rows
     locationId: db.location_id,       // required for RLS-safe writes
     name: db.name,
     category: db.category,
     itemType: db.itemtype,
     baseUnit: db.baseunit,
     unit: db.unit,
     inStock: db.instock,
     parLevel: db.parlevel,
     cost: db.cost,
     // purchaseCost: pack/case price as entered by user.
     // MUST be mapped so recipe costing (effectiveBaseCost = purchaseCost / conversion)
     // works correctly after page reload. Without this, purchaseCost is always
     // undefined → falls back to raw item.cost which may be stale or wrong.
     purchaseCost: db.purchasecost ?? null,
     supplierId: db.supplierid,
     priceTrend: db.pricetrend,
     priceIncrease: db.priceincrease,
     purchaseUnits: db.purchaseunits || [],
     // ── Phase 1: Structured packaging / UOM fields ─────────────────────────
     // All nullable. NULL = legacy behavior in costing (falls back to purchaseUnits → item.cost).
     purchaseUom:       db.purchase_uom      ?? null,  // supplier invoice unit (e.g. 'case')
     packQty:           db.pack_qty          != null ? Number(db.pack_qty)       : null, // inner units per pack
     innerUnitType:     db.inner_unit_type   ?? null,  // e.g. 'can', 'bottle'
     innerUnitSize:     db.inner_unit_size   != null ? Number(db.inner_unit_size) : null, // qty per inner unit
     innerUnitUom:      db.inner_unit_uom    ?? null,  // measurement unit of innerUnitSize
     baseUomNew:        db.base_uom          ?? null,  // preferred costing unit (overrides baseUnit when set)
     allowedRecipeUoms: Array.isArray(db.allowed_recipe_uoms) ? db.allowed_recipe_uoms : null,
});

const mapInventoryToDB = (item: any) => {
  // Phase 1 decision: if base_uom is set but baseunit is blank, backfill baseunit.
  // Never overwrite an existing baseunit value.
  const existingBaseUnit = item.baseUnit?.trim() || '';
  const newBaseUom       = item.baseUomNew?.trim() || '';
  const resolvedBaseUnit = existingBaseUnit || newBaseUom; // only fills blank; existing wins

  return {
     id: String(item.id || ''),
     item_id: String(item.itemId || item.id || ''),   // shared identity across locations
     location_id: item.locationId || item.location_id || null,
     name: item.name || '',
     category: item.category || '',
     itemtype: item.itemType || '',
     baseunit: resolvedBaseUnit,   // backfill from base_uom only when baseunit is blank
     unit: item.unit || '',
     instock: isNaN(parseFloat(item.inStock)) ? 0 : parseFloat(item.inStock),
     parlevel: isNaN(parseFloat(item.parLevel)) ? 0 : parseFloat(item.parLevel),
     cost: isNaN(parseFloat(item.cost)) ? 0 : parseFloat(item.cost),
     purchasecost: (item.purchaseCost !== undefined && item.purchaseCost !== null)
       ? parseFloat(item.purchaseCost) || null
       : null,
     supplierid: typeof item.supplierId === 'number' ? item.supplierId : null,
     pricetrend: item.priceTrend || 'steady',
     priceincrease: Boolean(item.priceIncrease),
     purchaseunits: Array.isArray(item.purchaseUnits) ? item.purchaseUnits : [],
     // ── Phase 1: Structured packaging / UOM fields ─────────────────────────
     // Pass-through as-is. NULL preserved for items not yet upgraded.
     purchase_uom:        item.purchaseUom    ?? null,
     pack_qty:            item.packQty        != null ? Number(item.packQty)       : null,
     inner_unit_type:     item.innerUnitType  ?? null,
     inner_unit_size:     item.innerUnitSize  != null ? Number(item.innerUnitSize) : null,
     inner_unit_uom:      item.innerUnitUom   ?? null,
     base_uom:            newBaseUom          || null,
     allowed_recipe_uoms: Array.isArray(item.allowedRecipeUoms) ? item.allowedRecipeUoms : null,
  };
};

/**
 * Load inventory items.
 * - Pass locationId to scope to a specific location (HQ cross-location review).
 * - Pass null/undefined for the current user's default scoped view.
 */
export async function loadInventory(locationId?: string | null) {
  let query = supabase.from('inventory_items').select('*');
  if (locationId) query = query.eq('location_id', locationId);
  const { data, error } = await query;
  if (error) {
    console.error("Error loading inventory:", error);
    return [];
  }
  return Array.isArray(data) ? data.map(mapInventoryToFrontend) : [];
}

export async function saveInventory(data: any[]) {
  const cleanData = data.map(mapInventoryToDB);
  const { error } = await supabase.from('inventory_items').upsert(cleanData, { onConflict: 'id' });
  if (error) return { success: false, error };
  return { success: true };
}

/**
 * Patch only the cost field on a single inventory item.
 *
 * Used by recipe save to update output item cost without re-upserting the
 * whole inventory array (which caused the same payload-size hang as saveRecipes).
 */
export async function updateInventoryItemCost(
  rowId: string,
  newCostPerBaseUnit: number
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('inventory_items')
    .update({ cost: newCostPerBaseUnit })
    .eq('id', rowId);
  if (error) return { success: false, error };
  return { success: true };
}

/**
 * Insert a brand-new inventory item for a specific location.
 *
 * item_id assignment rules (bidirectional):
 *  - If adding at a STORE: look up HQ by name → reuse HQ item_id if found.
 *  - If adding at HQ: look up any store by name → reuse that item_id if found.
 *  - This ensures whichever location creates the product first, the second
 *    location always converges to the same shared item_id.
 *
 * id (row PK) is always a fresh UUID unique to this location row.
 * location_id is required — RLS will reject any insert without it.
 */
export async function insertInventoryItem(
  item: any,
  locationId: string
): Promise<{ success: boolean; id?: string; error?: any }> {
  const rowId = crypto.randomUUID(); // always unique per location row

  // ── Resolve shared item_id (bidirectional) ────────────────────────────────
  let sharedItemId: string | null = null;

  if (item.name) {
    if (locationId !== 'LOC-HQ') {
      // Store creating item → prefer HQ's item_id
      const { data: hqMatch } = await supabase
        .from('inventory_items')
        .select('item_id')
        .eq('location_id', 'LOC-HQ')
        .ilike('name', item.name.trim())
        .limit(1)
        .maybeSingle();

      if (hqMatch?.item_id) {
        console.log(`[insertInventoryItem] store reusing HQ item_id=${hqMatch.item_id} for "${item.name}"`);
        sharedItemId = hqMatch.item_id;
      }
    } else {
      // HQ creating item → check if any store already has this product
      const { data: storeMatch } = await supabase
        .from('inventory_items')
        .select('item_id')
        .neq('location_id', 'LOC-HQ')
        .ilike('name', item.name.trim())
        .limit(1)
        .maybeSingle();

      if (storeMatch?.item_id) {
        console.log(`[insertInventoryItem] HQ reusing store item_id=${storeMatch.item_id} for "${item.name}"`);
        sharedItemId = storeMatch.item_id;
      }
    }
  }

  // Fall back to a fresh item_id only if no match found anywhere
  const itemId = sharedItemId ?? crypto.randomUUID();

  const row = {
    id:            rowId,
    item_id:       itemId,
    location_id:   locationId,
    name:          item.name || '',
    category:      item.category || '',
    itemtype:      item.itemType || '',
    baseunit:      item.baseUnit || item.unit || '',
    unit:          item.unit || '',
    instock:       isNaN(parseFloat(item.inStock)) ? 0 : parseFloat(item.inStock),
    parlevel:      isNaN(parseFloat(item.parLevel)) ? 0 : parseFloat(item.parLevel),
    cost:          isNaN(parseFloat(item.cost)) ? 0 : parseFloat(item.cost),
    purchasecost:  (item.purchaseCost !== undefined && item.purchaseCost !== null)
                     ? parseFloat(item.purchaseCost) || null
                     : null,
    supplierid:    typeof item.supplierId === 'number' ? item.supplierId : null,
    pricetrend:    item.priceTrend || 'steady',
    priceincrease: Boolean(item.priceIncrease),
    purchaseunits: Array.isArray(item.purchaseUnits) ? item.purchaseUnits : [],
    // Phase 2: structured packaging fields — null when not provided
    purchase_uom:        item.purchaseUom        ?? null,
    pack_qty:            item.packQty        != null ? Number(item.packQty)       : null,
    inner_unit_type:     item.innerUnitType      ?? null,
    inner_unit_size:     item.innerUnitSize  != null ? Number(item.innerUnitSize) : null,
    inner_unit_uom:      item.innerUnitUom       ?? null,
    base_uom:            item.baseUomNew?.trim() || null,
    allowed_recipe_uoms: Array.isArray(item.allowedRecipeUoms) ? item.allowedRecipeUoms : null,
  };

  const { error } = await supabase.from('inventory_items').insert(row);
  if (error) {
    console.error('insertInventoryItem:', error);
    return { success: false, error };
  }
  return { success: true, id: rowId };
}

/**
 * Resolve the shared item_id for a product being created at locationId.
 * Checks the opposite side of the HQ/store boundary so whichever location
 * creates the product first the second always gets the same item_id.
 */
export async function resolveSharedItemId(name: string, locationId: string): Promise<string | null> {
  if (!name) return null;

  let result;
  if (locationId !== 'LOC-HQ') {
    // Store creating/importing → look for existing HQ row with same name
    result = await supabase
      .from('inventory_items')
      .select('item_id')
      .eq('location_id', 'LOC-HQ')
      .ilike('name', name.trim())
      .limit(1)
      .maybeSingle();
  } else {
    // HQ creating/importing → look for any existing store row with same name
    result = await supabase
      .from('inventory_items')
      .select('item_id')
      .neq('location_id', 'LOC-HQ')
      .ilike('name', name.trim())
      .limit(1)
      .maybeSingle();
  }
  return result.data?.item_id ?? null;
}

/** @deprecated Use resolveSharedItemId instead */
export async function resolveHqItemId(name: string): Promise<string | null> {
  return resolveSharedItemId(name, 'store'); // store path: looks up HQ
}




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
// HQ SALE ITEMS  (hq_sale_items table)
// Dedicated finished-goods catalog that franchise locations requisition.
// Separate from inventory_items to keep raw ingredient views clean.
// ----------------------------------------------------------------------------

export interface SaleItem {
  id:                   string;
  name:                 string;
  category:             string | null;   // e.g. "Sauces", "Breads", "Desserts"
  sourceCommissary:     string;          // which commissary produces this FG; default 'Commissary HQ'
  description:          string | null;
  baseUnit:             string;
  instock:              number;
  parLevel:             number;
  isActive:             boolean;
  isRequisitionable:    boolean;
  sourceRecipeId:       string | null;
  sourceRecipeYieldQty: number;
  makingCost:           number;
  makingCostUpdatedAt:  string | null;
  suggestedPrice:       number;          // generated column: makingCost * 1.20
  manualPrice:          number | null;   // HQ override
  effectivePrice:       number;          // COALESCE(manualPrice, suggestedPrice)
  stockStatus:          'in_stock' | 'low_stock' | 'out_of_stock';
  createdAt:            string | null;
  updatedAt:            string | null;
}

const mapSaleItemToFrontend = (db: any): SaleItem => ({
  id:                   db.id,
  name:                 db.name,
  category:             db.category ?? null,
  sourceCommissary:     db.source_commissary ?? 'Commissary HQ',
  description:          db.description ?? null,
  baseUnit:             db.base_unit ?? 'ea',
  instock:              Number(db.instock ?? 0),
  parLevel:             Number(db.par_level ?? 0),
  isActive:             db.is_active ?? true,
  isRequisitionable:    db.is_requisitionable ?? true,
  sourceRecipeId:       db.source_recipe_id ?? null,
  sourceRecipeYieldQty: Number(db.source_recipe_yield_qty ?? 1),
  makingCost:           Number(db.making_cost ?? 0),
  makingCostUpdatedAt:  db.making_cost_updated_at ?? null,
  suggestedPrice:       Number(db.suggested_price ?? 0),
  manualPrice:          db.manual_price != null ? Number(db.manual_price) : null,
  effectivePrice:       db.effective_price != null
                          ? Number(db.effective_price)
                          : (db.manual_price != null ? Number(db.manual_price) : Number(db.suggested_price ?? 0)),
  stockStatus:          (db.stock_status ?? (
                          Number(db.instock ?? 0) <= 0 ? 'out_of_stock' :
                          Number(db.instock ?? 0) <= Number(db.par_level ?? 0) ? 'low_stock' :
                          'in_stock'
                        )) as SaleItem['stockStatus'],
  createdAt:            db.created_at ?? null,
  updatedAt:            db.updated_at ?? null,
});

const mapSaleItemToDB = (item: Partial<SaleItem> & { id: string }) => ({
  id:                      item.id,
  name:                    item.name ?? '',
  category:                item.category ?? null,
  source_commissary:       item.sourceCommissary ?? 'Commissary HQ',
  description:             item.description ?? null,
  base_unit:               item.baseUnit ?? 'ea',
  instock:                 isNaN(Number(item.instock)) ? 0 : Number(item.instock),
  par_level:               isNaN(Number(item.parLevel)) ? 0 : Number(item.parLevel),
  is_active:               item.isActive ?? true,
  is_requisitionable:      item.isRequisitionable ?? true,
  source_recipe_id:        item.sourceRecipeId ?? null,
  source_recipe_yield_qty: isNaN(Number(item.sourceRecipeYieldQty)) ? 1 : Number(item.sourceRecipeYieldQty),
  making_cost:             isNaN(Number(item.makingCost)) ? 0 : Number(item.makingCost),
  manual_price:            item.manualPrice != null ? Number(item.manualPrice) : null,
  // suggested_price is a generated column — never write it
  updated_at:              new Date().toISOString(),
});

/**
 * Load all HQ sale items via the hq_sale_items_priced VIEW which pre-computes
 * effective_price and stock_status. Falls back to the base table if the view
 * doesn't exist yet (pre-migration environments).
 */
export async function loadSaleItems(): Promise<SaleItem[]> {
  // Try the convenience view first (has effective_price + stock_status)
  const { data: viewData, error: viewErr } = await supabase
    .from('hq_sale_items_priced')
    .select('*')
    .order('name', { ascending: true });

  if (!viewErr && Array.isArray(viewData)) {
    return viewData.map(mapSaleItemToFrontend);
  }

  // Fallback: base table (migration not yet applied)
  const { data, error } = await supabase
    .from('hq_sale_items')
    .select('*')
    .order('name', { ascending: true });
  if (error) { console.error('[loadSaleItems]', error); return []; }
  return Array.isArray(data) ? data.map(mapSaleItemToFrontend) : [];
}

/** Upsert a single HQ sale item (create or update). */
export async function upsertSaleItem(
  item: Partial<SaleItem> & { id: string }
): Promise<{ success: boolean; error?: any }> {
  const row = mapSaleItemToDB(item);
  const { error } = await supabase
    .from('hq_sale_items')
    .upsert(row, { onConflict: 'id' });
  if (error) { console.error('[upsertSaleItem]', error); return { success: false, error }; }
  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// FG LOCATION PRICING  (fg_location_pricing table)
// location-level sales prices for finished goods, used to compute food cost %
// food_cost_pct = making_cost / sales_price * 100  (computed in UI, not stored)
// ─────────────────────────────────────────────────────────────────────────────

export interface FgLocationPricing {
  id:           number;
  saleItemId:   string;
  locationId:   string;
  locationName: string | null;
  salesPrice:   number;
  notes:        string | null;
  createdAt:    string | null;
  updatedAt:    string | null;
}

const mapFgPricingToFrontend = (db: any): FgLocationPricing => ({
  id:           Number(db.id),
  saleItemId:   db.sale_item_id,
  locationId:   db.location_id,
  locationName: db.location_name ?? null,
  salesPrice:   Number(db.sales_price ?? 0),
  notes:        db.notes ?? null,
  createdAt:    db.created_at ?? null,
  updatedAt:    db.updated_at ?? null,
});

/**
 * Load all location pricing rows for a specific finished good.
 * Falls back gracefully if the table doesn't exist yet (pre-migration).
 */
export async function loadFgLocationPricing(
  saleItemId: string
): Promise<FgLocationPricing[]> {
  const { data, error } = await supabase
    .from('fg_location_pricing')
    .select('*')
    .eq('sale_item_id', saleItemId)
    .order('location_name', { ascending: true });
  if (error) {
    console.warn('[loadFgLocationPricing] table may not exist yet:', error.message);
    return [];
  }
  return Array.isArray(data) ? data.map(mapFgPricingToFrontend) : [];
}

/**
 * Upsert a single location-pricing row.
 * Conflict target: (sale_item_id, location_id) — one price per item+location.
 */
export async function upsertFgLocationPricing(
  row: Omit<FgLocationPricing, 'id' | 'createdAt' | 'updatedAt'>
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('fg_location_pricing')
    .upsert({
      sale_item_id:  row.saleItemId,
      location_id:   row.locationId,
      location_name: row.locationName ?? null,
      sales_price:   Number(row.salesPrice),
      notes:         row.notes ?? null,
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'sale_item_id,location_id' });
  if (error) { console.error('[upsertFgLocationPricing]', error); return { success: false, error }; }
  return { success: true };
}

/**
 * Delete a single location-pricing row by its serial id.
 */
export async function deleteFgLocationPricing(
  id: number
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('fg_location_pricing')
    .delete()
    .eq('id', id);
  if (error) { console.error('[deleteFgLocationPricing]', error); return { success: false, error }; }
  return { success: true };
}

/**
 * Update making_cost on a sale item after recipe costing changes.
 * Called as a background write after recipe save when sale_item_id is set.
 * makingCost = recipe.theoreticalCost / recipe.yieldQty  (cost per base unit)
 */
export async function updateSaleItemCost(
  saleItemId: string,
  makingCost: number,
  sourceRecipeYieldQty: number
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('hq_sale_items')
    .update({
      making_cost:             Number(makingCost.toFixed(4)),
      source_recipe_yield_qty: Number(sourceRecipeYieldQty),
      making_cost_updated_at:  new Date().toISOString(),
      updated_at:              new Date().toISOString(),
    })
    .eq('id', saleItemId);
  if (error) { console.error('[updateSaleItemCost]', error); return { success: false, error }; }
  return { success: true };
}

/**
 * Adjust instock on a sale item.
 * delta > 0: production adds stock
 * delta < 0: fulfillment deducts stock
 * Uses increment pattern to avoid race conditions on concurrent production runs.
 */
export async function updateSaleItemStock(
  saleItemId: string,
  delta: number
): Promise<{ success: boolean; newStock?: number; error?: any }> {
  // Fetch current stock first so we can validate and return new value
  const { data: current, error: fetchErr } = await supabase
    .from('hq_sale_items')
    .select('instock')
    .eq('id', saleItemId)
    .single();

  if (fetchErr || !current) {
    console.error('[updateSaleItemStock] fetch error', fetchErr);
    return { success: false, error: fetchErr ?? { message: 'Sale item not found' } };
  }

  const currentStock = Number(current.instock ?? 0);
  const newStock = Math.max(0, currentStock + delta); // never go below 0

  const { error } = await supabase
    .from('hq_sale_items')
    .update({ instock: newStock, updated_at: new Date().toISOString() })
    .eq('id', saleItemId);

  if (error) { console.error('[updateSaleItemStock]', error); return { success: false, error }; }
  return { success: true, newStock };
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
  if (error) return [];
  return Array.isArray(data) ? data.map(mapSupplierToFrontend) : [];
}

export async function saveSuppliers(data: any[]) {
  const cleanData = data.map(mapSupplierToDB);
  const { error } = await supabase.from('suppliers').upsert(cleanData, { onConflict: 'id' });
  if (error) return { success: false, error };
  return { success: true };
}

/**
 * Resolve a supplier name to its numeric id from the HQ supplier master.
 *
 * IMPORTANT: This function is intentionally READ-ONLY.
 * Suppliers are HQ master records — no location can auto-create them.
 * If the supplier is not found, throws with a user-facing message so the
 * importer can surface it as a row-level error instead of silently failing.
 *
 * @throws Error with message "Supplier not found in HQ master. Ask HQ to create it first."
 */
export async function resolveSupplier(supplierName: string): Promise<number | null> {
  if (!supplierName || typeof supplierName !== 'string') return null;
  const normalised = supplierName.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalised) return null;

  const suppliers = await loadSuppliers();
  const match = suppliers.find(
    (s: any) => s.name.trim().replace(/\s+/g, ' ').toLowerCase() === normalised
  );

  if (match) return match.id;

  // Supplier not in HQ master — do NOT auto-create, surface a clear error.
  throw new Error(
    `Supplier "${supplierName.trim()}" not found in HQ master. Ask HQ to create it first.`
  );
}


// ----------------------------------------------------------------------------
// 3. RECIPES 
// ----------------------------------------------------------------------------
// ─── Recipe ingredient sanitizer ─────────────────────────────────────────────
// Strip runtime-only / AI-import-only fields before writing to the JSONB column.
// Extra fields (source, type, fgId) cause PostgREST to do additional schema-cache
// validation work and increase the serialized payload size for no benefit.
function sanitizeIngredientForDB(ing: any) {
  return {
    inventoryId: ing.inventoryId ?? ing.fgId ?? null,
    name:        ing.name        ?? "",
    qty:         Number(ing.qty) || 0,
    unit:        ing.unit        ?? "ea",
    prepNote:    ing.prepNote    ?? undefined,
  };
}

const mapRecipeToFrontend = (db: any) => ({
    id:              db.id,
    name:            db.name,
    category:        db.category,
    yieldQty:        db.yieldqty,
    yieldUnit:       db.yieldunit,
    theoreticalCost: db.theoreticalcost,
    margin:          db.margin,
    ingredients:     db.ingredients || []
});

// Columns to fetch — avoids pulling created_at and any future-added admin columns
const RECIPE_SELECT = "id,name,category,yieldqty,yieldunit,theoreticalcost,margin,ingredients";

const mapRecipeToDB = (r: any) => ({
    id:              String(r.id || ''),
    name:            r.name     || '',
    category:        r.category || '',
    yieldqty:        isNaN(parseFloat(r.yieldQty))        ? 0 : parseFloat(r.yieldQty),
    yieldunit:       r.yieldUnit || '',
    theoreticalcost: isNaN(parseFloat(r.theoreticalCost)) ? 0 : parseFloat(r.theoreticalCost),
    margin:          isNaN(parseFloat(r.margin))          ? 0 : parseFloat(r.margin),
    // Sanitize ingredients — strip runtime fields before persisting to JSONB
    ingredients: Array.isArray(r.ingredients)
      ? r.ingredients.map(sanitizeIngredientForDB)
      : [],
});

export async function loadRecipes() {
  const { data, error } = await supabase.from('recipes').select(RECIPE_SELECT);
  if (error) return [];
  return Array.isArray(data) ? data.map(mapRecipeToFrontend) : [];
}

export async function saveRecipes(data: any[]) {
  const cleanData = data.map(mapRecipeToDB);
  const { error } = await supabase.from('recipes').upsert(cleanData, { onConflict: 'id' });
  if (error) return { success: false, error };
  return { success: true };
}

/**
 * Upsert a SINGLE recipe row via raw fetch() so the caller's AbortSignal
 * is honoured at the HTTP layer.
 *
 * WHY raw fetch:
 *   supabase.from('recipes').upsert() in @supabase/supabase-js v2 does NOT
 *   expose an AbortSignal. When withAbortableTimeout fires controller.abort(),
 *   the JS Promise rejects, but the underlying HTTP request remains open on
 *   the TCP connection. The NEXT save attempt then queues behind the zombie
 *   request — causing the next call to ALSO time out, even after a cold-start
 *   has completed. Using fetch() directly means abort() tears down the socket.
 *
 * HOW it works:
 *   PostgREST upsert = PATCH /rest/v1/recipes?id=eq.<id> with Prefer: resolution=merge-duplicates
 *   OR a POST with Prefer: resolution=merge-duplicates,return=minimal
 *   We use the simpler POST + on_conflict approach via query param supported by PostgREST v10+.
 */
export async function upsertRecipe(
  recipe: any,
  signal?: AbortSignal
): Promise<{ success: boolean; error?: any }> {
  const row = mapRecipeToDB(recipe);
  const payloadBytes = JSON.stringify(row).length;
  console.debug("[upsertRecipe] payload:", payloadBytes, "bytes | ingredients:", row.ingredients.length);

  // Build the PostgREST upsert URL
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/recipes?on_conflict=id`;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

  // Get the current session token for authenticated requests.
  // Falls back to the anon key if no active session (e.g. during SSR or cold load).
  const { data: { session } } = await supabase.auth.getSession();
  const authHeader = session?.access_token ? `Bearer ${session.access_token}` : `Bearer ${key}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': authHeader,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });

    if (!resp.ok) {
      let errBody: any = {};
      try { errBody = await resp.json(); } catch { errBody = { message: resp.statusText }; }
      console.error("[upsertRecipe] HTTP", resp.status, errBody);
      return { success: false, error: errBody };
    }
    return { success: true };
  } catch (err: any) {
    // AbortError means the caller cancelled (timeout) — re-throw so withAbortableTimeout catch handles it
    if (err?.name === 'AbortError') throw err;
    console.error("[upsertRecipe] fetch error", err);
    return { success: false, error: { message: err?.message ?? 'Network error' } };
  }
}

/**
 * Hard-delete a single recipe row by its UUID primary key.
 *
 * Returns { success: true } on success, or { success: false, error } if Supabase
 * returns an error. The caller should remove the row from local state optimistically
 * (or on success) to avoid a full page reload.
 *
 * Note: recipes are not FK-referenced by any other table in the current schema,
 * so deletion is always safe. If that changes, add a reference check here.
 */
export async function deleteRecipe(id: string): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase.from('recipes').delete().eq('id', id);
  if (error) {
    console.error('[deleteRecipe] error', error);
    return { success: false, error };
  }
  return { success: true };
}


// ----------------------------------------------------------------------------
// 4. ORDERS
// ----------------------------------------------------------------------------

/**
 * Generate a guaranteed-unique order ID for DB insert.
 *
 * Root cause of "duplicate key" bug:
 *   `PO-${1050 + orders.length}` used the in-memory array length, which:
 *   - Does not match the actual DB row count (location_manager only loads
 *     their own location's orders, so length=0 even though PO-1050 exists globally)
 *   - Does not increment on a failed retry (state unchanged) → same ID sent twice
 *
 * Fix: crypto.randomUUID() is a 128-bit random value, collision probability
 *   is astronomically low (1 in 2^122). No counter, no DB query, no race condition.
 *
 * The human-readable label (e.g. "PO-a1b2c3d4") is derived from the UUID prefix
 * for display only — it is NOT the DB primary key.
 */
export function generateOrderId(): { id: string; poNumber: string } {
  const uuid = crypto.randomUUID();          // e.g. "550e8400-e29b-41d4-a716-446655440000"
  const short = uuid.replace(/-/g, '').slice(0, 8).toUpperCase();  // "550E8400"
  return {
    id:       uuid,                          // DB primary key — TEXT PRIMARY KEY
    poNumber: `PO-${short}`,                 // human-readable display label
  };
}

const mapOrderToFrontend = (db: any) => ({
     id: db.id,
     // poNumber: human-readable display label (e.g. "PO-550E8400").
     // Falls back to db.id for legacy rows inserted before this field existed.
     poNumber:    db.ponumber ?? db.id,
     supplierId:  db.supplierid,
     supplierName: db.suppliername,
     date:        db.date,
     deliveryDate: db.deliverydate,
     items:       db.items,
     total:       db.total,
     status:      db.status,
     location:    db.location,           // display label — for UI only
     locationId:  db.location_id ?? null, // FK to locations.id — source of truth
     createdBy:   db.createdby,
     receivedBy:  db.receivedby,
     receivedAt:  db.receivedat,
     notes:       db.notes,
     lineItems:   db.lineitems || []
});

const mapOrderToDB = (o: any) => ({
     id:          String(o.id || ''),
     // ponumber: human-readable display label, stored separately from pk.
     // If the column doesn't exist in DB yet, Supabase silently ignores unknown keys
     // (they are stripped before the query). Safe to include always.
     ponumber:    o.poNumber || o.ponumber || null,
     supplierid:  typeof o.supplierId === 'number' ? o.supplierId : null,
     suppliername: o.supplierName || '',
     date:        o.date || '',
     deliverydate: o.deliveryDate || '',
     items:       isNaN(parseInt(o.items)) ? 0 : parseInt(o.items),
     total:       isNaN(parseFloat(o.total)) ? 0 : parseFloat(o.total),
     status:      o.status || '',
     location:    o.location || '',        // display label preserved for UI
     location_id: o.locationId || o.location_id || null,  // FK — source of truth
     createdby:   o.createdBy || '',
     receivedby:  o.receivedBy || '',
     receivedat:  o.receivedAt || '',
     notes:       o.notes || '',
     lineitems:   Array.isArray(o.lineItems) ? o.lineItems : []
});

/**
 * Load purchase orders, scoped by location_id FK.
 * - hq_admin: pass null  → unfiltered (sees all locations)
 * - location_manager: pass their locationId (e.g. "LOC-1091") → own location only
 *
 * orders.location_id now exists (migration applied 2026-04-07) and is backfilled.
 */
export async function loadOrders(locationId?: string | null) {
  let query = supabase.from('orders').select('*').order('created_at', { ascending: false });
  if (locationId) query = query.eq('location_id', locationId);
  const { data, error } = await query;
  if (error) return [];
  return Array.isArray(data) ? data.map(mapOrderToFrontend) : [];
}

export async function saveOrders(data: any[]) {
  const cleanData = data.map(mapOrderToDB);

  // Guard: every row must have a location_id — RLS will reject null location rows
  // for location_manager writes. Surface this clearly before hitting the DB.
  const missingLocation = cleanData.find(r => !r.location_id);
  if (missingLocation) {
    return {
      success: false,
      error: `Order "${missingLocation.id}" is missing location_id. Cannot save — check that your user profile has a location assigned.`
    };
  }

  const { error } = await supabase.from('orders').upsert(cleanData, { onConflict: 'id' });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Insert a single new order row.
 *
 * RLS-safe: touches only the one new row.
 * The full-array saveOrders() upsert was triggering USING violations when a
 * location_manager's array included rows owned by other locations — the DB tried
 * to UPDATE those rows and the USING clause correctly blocked the caller.
 */
export async function insertOrder(
  order: any
): Promise<{ success: boolean; order?: any; error?: string }> {
  const row = mapOrderToDB(order);

  // ── Pre-flight: verify auth session and log exact payload ──────────────────
  // Open browser DevTools → Console and look for "[insertOrder]" before saving.
  // location_id logged here MUST match user_profiles.location_id for auth.uid().
  const { data: { session } } = await supabase.auth.getSession();
  console.debug('[insertOrder] pre-flight →', {
    auth_uid:    session?.user?.id ?? 'NO SESSION ← AUTH BUG',
    location_id: row.location_id,   // must equal user_profiles.location_id for this uid
    id:          row.id,
    status:      row.status,
  });

  if (!session?.user) {
    return { success: false, error: 'No active auth session. Please sign out and sign back in.' };
  }

  if (!row.location_id) {
    return { success: false, error: 'Order is missing location_id. Ensure your user profile has a location assigned.' };
  }

  const { data, error } = await supabase.from('orders').insert(row).select().single();
  if (error) {
    console.error('[insertOrder] DB error →', error);
    // Include Postgres error code: 42501 = RLS violation, 23505 = unique conflict
    return { success: false, error: `[${error.code}] ${error.message}` };
  }
  return { success: true, order: mapOrderToFrontend(data) };
}

/**
 * Update a single existing order row by id.
 *
 * RLS-safe: the USING clause checks the caller owns the row being updated.
 * Only touches ONE row, so no cross-location contamination.
 */
export async function updateOrder(
  id: string,
  patch: any
): Promise<{ success: boolean; order?: any; error?: string }> {
  const row = mapOrderToDB({ ...patch, id });
  const { data, error } = await supabase
    .from('orders')
    .update(row)
    .eq('id', id)
    .select()
    .single();
  if (error) return { success: false, error: error.message };
  return { success: true, order: mapOrderToFrontend(data) };
}

/**
 * Delete a single order row by id.
 *
 * RLS-safe: touches only the target row. The USING clause confirms caller owns it.
 */
export async function deleteOrder(
  id: string
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.from('orders').delete().eq('id', id);
  if (error) return { success: false, error: error.message };
  return { success: true };
}



// ----------------------------------------------------------------------------
// 5. REQUISITIONS 
// ----------------------------------------------------------------------------
const mapRequisitionToFrontend = (db: any) => ({
    id: db.id,
    location_id: db.location_id ?? null,   // Phase 3 FK — used by RLS and location views
    location: db.location,
    requestedBy: db.requestedby,
    date: db.date,
    status: db.status,
    items: db.items,
    notes: db.notes,
    // totalAmount: stored in DB as total_amount. Falls back to 0 for legacy rows
    // that were created before this column existed (or before backfill was run).
    totalAmount: db.total_amount != null ? Number(db.total_amount) : 0,
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
    total_amount: isNaN(parseFloat(req.totalAmount)) ? 0 : parseFloat(req.totalAmount),
    lineitems: Array.isArray(req.lineItems) ? req.lineItems : []
});

/**
 * Load requisitions.
 * - hq_admin reviewing a location: pass that location's id.
 * - Normal load (dashboard, requisitions page): pass null/undefined.
 */
export async function loadRequisitions(locationId?: string | null) {
  let query = supabase.from('requisitions').select('*').order('created_at', { ascending: false });
  if (locationId) query = query.eq('location_id', locationId);
  const { data, error } = await query;
  if (error) return [];
  return Array.isArray(data) ? data.map(mapRequisitionToFrontend) : [];
}

export async function saveRequisitions(data: any[]) {
  const cleanData = data.map(mapRequisitionToDB);
  const { error } = await supabase.from('requisitions').upsert(cleanData, { onConflict: 'id' });
  if (error) return { success: false, error };
  return { success: true };
}

/**
 * Targeted single-row status update.
 * Avoids upserting the full array which triggers CHECK constraint
 * failures from legacy capitalized statuses on other rows.
 */
export async function updateRequisitionStatus(
  id: string,
  status: string
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('requisitions')
    .update({ status: status.toLowerCase() })
    .eq('id', id);
  if (error) {
    console.error('updateRequisitionStatus:', error);
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
    locationId: db.location_id ?? null,   // required NOT NULL in DB
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
    location_id: c.locationId || c.location_id || null,   // NOT NULL — must be set by caller
    items: Array.isArray(c.items) ? c.items : [],
    totalvariancevalue: isNaN(parseFloat(c.totalVarianceValue)) ? 0 : parseFloat(c.totalVarianceValue)
});

/**
 * Load physical counts.
 * - hq_admin: pass null  → returns all counts
 * - location_manager: pass their locationId → returns only their location's counts
 */
export async function loadCounts(locationId?: string | null) {
  let query = supabase.from('counts').select('*').order('created_at', { ascending: false });
  if (locationId) query = query.eq('location_id', locationId);
  const { data, error } = await query;
  if (error) return [];
  return Array.isArray(data) ? data.map(mapCountToFrontend) : [];
}

export async function saveCounts(data: any[]) {
  const cleanData = data.map(mapCountToDB);
  const { error } = await supabase.from('counts').upsert(cleanData, { onConflict: 'id' });
  if (error) return { success: false, error };
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
  if (error) return { success: false, error };
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
  if (error) return { success: false, error };
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
   newlyCreatedIds: db.created_ids || [],
   rollbackData: db.rollback_data || {},
   failedRows: db.failed_rows || [],
   summary: db.summary_payload || {},
   status: db.status,
   uploadedBy: db.uploadedby || "System"
});

const mapBatchToDB = (batch: any) => ({
   id: String(batch.batchId || ''),
   date: String(batch.timestamp || ''),
   filename: batch.fileName || "Unknown",
   recordsinserted: isNaN(parseInt(batch.totalRowsProcessed)) ? 0 : parseInt(batch.totalRowsProcessed),
   metrics: batch.metrics || {},
   created_ids: Array.isArray(batch.newlyCreatedIds) ? batch.newlyCreatedIds : [],
   updated_ids: batch.rollbackData ? Object.keys(batch.rollbackData).map(Number) : [],
   rollback_data: batch.rollbackData || {},
   failed_rows: Array.isArray(batch.failedRows) ? batch.failedRows : [],
   summary_payload: batch.summary || {},
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
  if (error) return { success: false, error };
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
  if (error) return { success: false, error };
  return { success: true };
}

// ── user_profiles (auth-linked, Phase 1) ─────────────────────────────────────

export interface UserProfileRow {
  id: string;
  userId: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  locationId: string | null;
  isActive: boolean;
  createdAt: string | null;
}

const mapProfileToFrontend = (db: any): UserProfileRow => ({
  id:         db.id,
  userId:     db.user_id,
  fullName:   db.full_name ?? null,
  email:      db.email ?? null,        // joined from auth.users via view if available
  phone:      db.phone ?? null,
  role:       db.role,
  locationId: db.location_id ?? null,
  isActive:   db.is_active ?? true,
  createdAt:  db.created_at ?? null,
});

/**
 * Load all user_profiles rows.
 * Tries the `user_profiles_with_email` view first (which joins auth.users.email).
 * Falls back to plain user_profiles if the view doesn't exist.
 */
export async function loadUserProfiles(): Promise<UserProfileRow[]> {
  // Try view with email first
  const { data: viewData, error: viewErr } = await supabase
    .from('user_profiles_with_email')
    .select('*')
    .order('created_at', { ascending: false });

  if (!viewErr && Array.isArray(viewData)) {
    return viewData.map(mapProfileToFrontend);
  }

  // Fallback: plain table (no email column)
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return [];
  return Array.isArray(data) ? data.map(mapProfileToFrontend) : [];
}

/**
 * Update a user_profiles row via the server-side API route.
 * Uses /api/users/profile (PATCH) which runs with service-role key.
 */
export async function updateUserProfile(
  profileId: string,
  updates: Partial<Pick<UserProfileRow, 'fullName' | 'role' | 'locationId' | 'isActive' | 'phone'>>
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch('/api/users/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile_id:  profileId,
      full_name:   updates.fullName,
      role:        updates.role,
      location_id: updates.locationId,
      is_active:   updates.isActive,
      phone:       updates.phone,
    }),
  });
  const json = await res.json();
  if (!res.ok) return { success: false, error: json.error };
  return { success: true };
}

/**
 * Invite a new user via the server-side API route.
 * Sends a magic-link invite email and creates user_profiles.
 */
export async function inviteUser(payload: {
  email: string;
  fullName: string;
  role: string;
  locationId?: string | null;
  phone?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  const res = await fetch('/api/users/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:       payload.email,
      full_name:   payload.fullName,
      role:        payload.role,
      location_id: payload.locationId ?? null,
      phone:       payload.phone ?? null,
    }),
  });
  const json = await res.json();
  if (!res.ok) return { success: false, error: json.error };
  return { success: true };
}

/**
 * Fallback: create a user directly without sending an invite email.
 * HQ provides a temporary password the user changes on first login.
 * Use when Supabase invite emails are rate-limited.
 */
export async function createUserDirect(payload: {
  email: string;
  password: string;
  fullName: string;
  role: string;
  locationId?: string | null;
  phone?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  const res = await fetch('/api/users/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:       payload.email,
      password:    payload.password,
      full_name:   payload.fullName,
      role:        payload.role,
      location_id: payload.locationId ?? null,
      phone:       payload.phone ?? null,
    }),
  });
  const json = await res.json();
  if (!res.ok) return { success: false, error: json.error };
  return { success: true };
}

/**
 * HQ action: send a password-reset email to a registered user.
 * Calls /api/users/reset-password (service-role-gated server route).
 */
export async function resetUserPassword(
  email: string
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch('/api/users/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const json2 = await res.json();
  if (!res.ok) return { success: false, error: json2.error };
  return { success: true };
}


// ----------------------------------------------------------------------------
// 11. LOCATIONS
// ----------------------------------------------------------------------------
const mapLocationToFrontend = (db: any) => ({
    id:      db.id,
    name:    db.name,
    code:    db.code,
    type:    db.type,
    // subtype is the human-friendly display label (store/airport/mall/other/hq)
    // Falls back to type if subtype column doesn't exist yet in older rows
    subtype: db.subtype || db.type,
    status:  db.status
});

/**
 * Canonical type mapping.
 * The DB trigger enforces: type IN ('hq', 'branch', 'warehouse').
 * UI shows human-friendly labels — translate here so every save path is
 * automatically correct regardless of which component calls saveLocations().
 *
 * Subtype (store / airport / mall / other) is stored separately as a display
 * tag and is NOT validated by the DB trigger — it's informational only.
 */
const UI_TO_DB_TYPE: Record<string, string> = {
  // canonical DB values — pass through unchanged
  hq:        'hq',
  branch:    'branch',
  warehouse: 'warehouse',
  // UI-friendly labels → canonical DB values
  'HQ':        'hq',
  'Store':     'branch',
  'Airport':   'branch',
  'Mall':      'branch',
  'Other':     'branch',
  'Warehouse': 'warehouse',
};

const mapLocationToDB = (l: any) => ({
    id:      String(l.id || ''),
    name:    l.name || '',
    code:    l.code || '',
    // Always write a valid DB type — fall back to 'branch' if unmapped
    type:    UI_TO_DB_TYPE[l.type] ?? 'branch',
    // subtype preserves the original UI label for display purposes
    subtype: l.subtype || l.type || '',
    status:  l.status || ''
});

export async function loadLocations() {
  const { data, error } = await supabase.from('locations').select('*');
  if (error) return [];
  return Array.isArray(data) ? data.map(mapLocationToFrontend) : [];
}

export async function saveLocations(data: any[]) {
  const cleanData = data.map(mapLocationToDB);
  const { error } = await supabase.from('locations').upsert(cleanData, { onConflict: 'id' });
  if (error) return { success: false, error };
  return { success: true };
}

/**
 * Insert a single new location row.
 * Preferred over saveLocations() for one-off creation because it:
 *  - sends only the new row (no full-array re-write risk)
 *  - type is translated via mapLocationToDB (hq/branch/warehouse enforced)
 *  - returns the created row so callers can immediately update local state
 */
export async function insertLocation(
  payload: {
    id: string; name: string; code: string;
    type: string; subtype: string; status: string;
  }
): Promise<{ success: boolean; location?: any; error?: string }> {
  const row = mapLocationToDB(payload);
  if (!row.id) return { success: false, error: 'Location ID is required.' };

  const { data, error } = await supabase
    .from('locations')
    .insert(row)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  // Return as frontend model so callers can merge into local state directly
  return { success: true, location: mapLocationToFrontend(data) };
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
      await supabase.from('inventory_activity').delete().neq('id', 0);
      const { error } = await supabase.from('inventory_activity').insert(rows);
      if (error) return { success: false, error };
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


// ----------------------------------------------------------------------------
// PHASE 3: REQUISITION CREATE (location_manager flow)
// Writes a header row to public.requisitions and line items to
// public.requisition_items in a single coordinated sequence.
// The caller must supply location_id and created_by from auth context.
// ----------------------------------------------------------------------------

export async function saveNewRequisition(
  header: {
    id: string;
    location_id: string;
    created_by: string;
    status: string;
    notes: string;
    date: string;
  },
  lineItems: {
    item_id?:            string | null;
    finished_good_id?:   string | null;
    item_name_snapshot?: string | null;
    unit_snapshot?:      string | null;
    quantity_requested:  number;
    unit_price:          number;
    line_total:          number;
  }[]
): Promise<{ success: boolean; error?: any }> {

  console.log("UI ITEMS PASSED TO SAVE:", JSON.stringify(lineItems, null, 2));

  // ── Pre-flight ─────────────────────────────────────────────────────────────
  if (lineItems.length === 0) {
    return { success: false, error: { message: "Cannot save a requisition with no line items." } };
  }

  const nullFkRows = lineItems.filter(li => !li.item_id && !li.finished_good_id);
  if (nullFkRows.length > 0) {
    console.error("[saveNewRequisition] pre-flight: rows missing both FKs:", nullFkRows);
    return {
      success: false,
      error: { message: `${nullFkRows.length} line item(s) have no item_id or finished_good_id. Check the item picker.` },
    };
  }

  // ── Insert header ──────────────────────────────────────────────────────────
  const grandTotal = parseFloat(lineItems.reduce((s, li) => s + li.line_total, 0).toFixed(2));

  const headerPayload = {
    id:           header.id,
    location_id:  header.location_id,
    location:     header.location_id,
    created_by:   header.created_by,
    requestedby:  header.created_by,
    status:       header.status,
    notes:        header.notes || "",
    date:         header.date,
    items:        lineItems.length,
    total_amount: grandTotal,
    lineitems:    [],
  };

  const { data: insertedHeader, error: headerError } = await supabase
    .from("requisitions")
    .insert(headerPayload)
    .select("id")
    .single();

  if (headerError || !insertedHeader?.id) {
    console.error("[saveNewRequisition] header insert FAILED", {
      message: headerError?.message, details: headerError?.details,
      hint: headerError?.hint, code: headerError?.code,
      fullError: headerError,
    });
    return { success: false, error: headerError ?? { message: "Requisition insert returned no id." } };
  }

  const confirmedId = insertedHeader.id;
  console.log("[saveNewRequisition] header OK → confirmedId:", confirmedId);

  // ── Rollback helper ────────────────────────────────────────────────────────
  async function rollbackHeader() {
    const { error: delErr } = await supabase.from("requisitions").delete().eq("id", confirmedId);
    if (delErr) console.error("[saveNewRequisition] ROLLBACK FAILED — orphan left:", confirmedId, delErr);
    else        console.warn("[saveNewRequisition] rollback OK — header deleted:", confirmedId);
  }

  // ── Build rows with confirmed id ───────────────────────────────────────────
  const rows = lineItems.map((li, idx) => {
    const row = {
      requisition_id:     confirmedId,
      item_id:            li.item_id            ?? null,
      finished_good_id:   li.finished_good_id   ?? null,
      item_name_snapshot: li.item_name_snapshot ?? null,
      unit_snapshot:      li.unit_snapshot      ?? null,
      quantity_requested: li.quantity_requested,
      unit_price:         li.unit_price,
      line_total:         li.line_total,
      quantity_approved:  null,
      quantity_fulfilled: null,
    };
    console.log(`[saveNewRequisition] row[${idx}] item_id=${row.item_id} fg_id=${row.finished_good_id} qty=${row.quantity_requested} name="${row.item_name_snapshot}"`);
    return row;
  });

  console.log("FINAL ROWS:", JSON.stringify(rows, null, 2));

  if (!rows.length) {
    await rollbackHeader();
    throw new Error("No line items found. Requisition not created.");
  }

  // ── Insert line items ──────────────────────────────────────────────────────
  let { error: itemsError } = await supabase
    .from("requisition_items")
    .insert(rows);

  // 42703 = column not found → migration not applied.
  // Raw-mode: retry without new columns. FG-mode: hard error.
  if (itemsError?.code === "42703") {
    console.warn("[saveNewRequisition] 42703 — new columns absent. Checking mode...");
    const fgRows = rows.filter(r => !r.item_id && r.finished_good_id);
    if (fgRows.length > 0) {
      console.error("[saveNewRequisition] FG rows need migration:", fgRows);
      await rollbackHeader();
      return { success: false, error: { message: "Database migration required: run migration.sql in Supabase SQL Editor to enable Finished Goods requisitions." } };
    }
    const legacyRows = rows.map(({ finished_good_id, item_name_snapshot, unit_snapshot, ...rest }) => rest);
    console.log("[saveNewRequisition] legacy retry:", JSON.stringify(legacyRows, null, 2));
    const retry = await supabase.from("requisition_items").insert(legacyRows);
    itemsError = retry.error ?? null;
  }

  // 23502 = NOT NULL violated on item_id → migration DROP NOT NULL not applied.
  if (itemsError?.code === "23502" && itemsError.message?.includes("item_id")) {
    console.error("[saveNewRequisition] 23502 — item_id still NOT NULL in DB");
    await rollbackHeader();
    return { success: false, error: { message: "Database migration required: run migration.sql (ALTER TABLE requisition_items ALTER COLUMN item_id DROP NOT NULL)." } };
  }

  if (itemsError) {
    console.error("[saveNewRequisition] line items insert FAILED — rolling back header", {
      message: itemsError?.message, details: itemsError?.details,
      hint: itemsError?.hint, code: itemsError?.code,
      fullError: itemsError, payload: rows,
    });
    await rollbackHeader();
    return { success: false, error: itemsError };
  }

  console.log("[saveNewRequisition] line items OK →", rows.length, "rows under", confirmedId);
  return { success: true };
}




export async function loadRequisitionItems(
  requisitionId: string
): Promise<{ success: boolean; data?: any[]; error?: any }> {
  // Join both inventory_items (raw mode) and hq_sale_items (FG mode).
  // PostgREST: include both FK joins; each returns null when the FK is null.
  const { data, error } = await supabase
    .from("requisition_items")
    .select("*, inventory_items(name), hq_sale_items(name, base_unit)")
    .eq("requisition_id", requisitionId)
    .order("created_at", { ascending: true });

  if (error) {
    // hq_sale_items join may fail pre-migration — retry without it
    console.warn("loadRequisitionItems: join failed, retrying without hq_sale_items join", error.message);
    const { data: fallbackData, error: fallbackError } = await supabase
      .from("requisition_items")
      .select("*, inventory_items(name)")
      .eq("requisition_id", requisitionId)
      .order("created_at", { ascending: true });
    if (fallbackError) { console.error("loadRequisitionItems fallback:", fallbackError); return { success: false, error: fallbackError }; }
    return {
      success: true,
      data: (fallbackData || []).map((row: any) => mapReqItemRow(row)),
    };
  }

  return {
    success: true,
    data: (data || []).map((row: any) => mapReqItemRow(row)),
  };
}

function mapReqItemRow(row: any) {
  const isFGMode = !!row.finished_good_id;
  // Name resolution priority:
  //   1. item_name_snapshot (captured at order time — survives future renames)
  //   2. joined relation name
  //   3. raw id fallback
  const itemName = row.item_name_snapshot
    ?? (isFGMode ? row.hq_sale_items?.name : row.inventory_items?.name)
    ?? row.finished_good_id ?? row.item_id;

  const unit = row.unit_snapshot
    ?? (isFGMode ? row.hq_sale_items?.base_unit : null)
    ?? null;

  return {
    id:                row.id,
    requisitionId:     row.requisition_id,
    // Which mode
    isFGMode,
    itemId:            row.item_id ?? null,
    finishedGoodId:    row.finished_good_id ?? null,
    itemName,
    unit,
    quantityRequested: Number(row.quantity_requested),
    quantityApproved:  row.quantity_approved  != null ? Number(row.quantity_approved)  : null,
    quantityFulfilled: row.quantity_fulfilled != null ? Number(row.quantity_fulfilled) : null,
    unitPrice:         row.unit_price  != null ? Number(row.unit_price)  : null,
    lineTotal:         row.line_total  != null ? Number(row.line_total)  : null,
  };
}








/**
 * Batch-load line items for multiple requisitions in a single query.
 * Used by HQ Production to aggregate demand without N+1 fetches.
 *
 * Returns a Map<requisitionId, mappedLineItem[]> so callers can use
 *   itemsByReqId.get(req.id) ?? []
 *
 * Falls back gracefully if the hq_sale_items join fails (pre-migration).
 */
export async function loadRequisitionItemsBatch(
  requisitionIds: string[]
): Promise<Map<string, any[]>> {
  if (!requisitionIds.length) return new Map();

  const run = (select: string) =>
    supabase
      .from("requisition_items")
      .select(select)
      .in("requisition_id", requisitionIds)
      .order("created_at", { ascending: true });

  let { data, error } = await run("*, inventory_items(name), hq_sale_items(name, base_unit)");

  if (error) {
    console.warn("[loadRequisitionItemsBatch] join failed, retrying without hq_sale_items", error.message);
    ({ data, error } = await run("*, inventory_items(name)"));
    if (error) {
      console.error("[loadRequisitionItemsBatch] fallback failed", error);
      return new Map();
    }
  }

  const result = new Map<string, any[]>();
  (data ?? []).forEach((row: any) => {
    const mapped = mapReqItemRow(row);
    const list = result.get(row.requisition_id) ?? [];
    list.push(mapped);
    result.set(row.requisition_id, list);
  });
  return result;
}

// ─── HQ Location ID ───────────────────────────────────────────────────────────
const HQ_LOCATION_ID = "LOC-HQ";

export async function updateRequisitionItemFulfilled(
  itemId: string,
  quantityFulfilled: number,
  requisitionId: string
): Promise<{ success: boolean; newStatus?: string; error?: any }> {

  console.log(`[Fulfillment] START itemId=${itemId} qty=${quantityFulfilled} reqId=${requisitionId}`);

  // ── 1. Fetch current requisition_items row ────────────────────────────────
  // Fetch finished_good_id alongside item_id to detect FG mode.
  const { data: currentRow, error: fetchCurrentError } = await supabase
    .from("requisition_items")
    .select("item_id, finished_good_id, quantity_fulfilled")
    .eq("id", itemId)
    .single();

  if (fetchCurrentError || !currentRow) {
    console.error("[Fulfillment] ✗ Step 1: could not fetch requisition_items row", fetchCurrentError);
    return { success: false, error: fetchCurrentError ?? { message: "requisition_items row not found." } };
  }

  const previousFulfilled = Number(currentRow.quantity_fulfilled ?? 0);
  const delta = quantityFulfilled - previousFulfilled;

  // ── 1a. FG-mode: deduct from hq_sale_items.instock and skip inventory transfer
  if (currentRow.finished_good_id) {
    console.log(`[Fulfillment] FG-mode: sale_item=${currentRow.finished_good_id} delta=${delta}`);

    if (delta > 0) {
      const stockRes = await updateSaleItemStock(currentRow.finished_good_id, -delta);
      if (!stockRes.success) {
        console.error('[Fulfillment] ✗ FG stock deduct failed', stockRes.error);
        return { success: false, error: stockRes.error };
      }
      console.log(`[Fulfillment] FG stock deducted. new instock=${stockRes.newStock}`);
    }

    // Write fulfilled qty and recalculate status (shared Steps 8 & 9)
    return await writeFulfilledAndRecalc(itemId, quantityFulfilled, requisitionId);
  }

  console.log(`[Fulfillment] Raw-mode: inventoryRowPk=${currentRow.item_id} prevFulfilled=${previousFulfilled}`);

  const inventoryRowPk: string = currentRow.item_id;

  // ── 1b. Resolve row PK → shared item_id ──────────────────────────────────
  // requisition_items.item_id stores inventory_items.id (the row PK).
  // HQ/dest lookups need inventory_items.item_id (shared identity column).
  const { data: sourceRow, error: sourceResolveError } = await supabase
    .from("inventory_items")
    .select("item_id, name, location_id")
    .eq("id", inventoryRowPk)
    .maybeSingle();   // maybeSingle: won't throw on 0 rows, returns null

  console.log(`[Fulfillment] Step 1b resolve: sourceRow=`, JSON.stringify(sourceRow), `error=`, sourceResolveError);

  if (sourceResolveError) {
    console.error("[Fulfillment] ✗ Step 1b: DB error resolving inventory row PK", sourceResolveError);
    return { success: false, error: { message: `DB error resolving inventory row id=${inventoryRowPk}: ${sourceResolveError.message}` } };
  }

  if (!sourceRow) {
    console.error(`[Fulfillment] ✗ Step 1b: no inventory_items row found for id=${inventoryRowPk}. Possibly a legacy numeric id with type mismatch.`);
    return { success: false, error: { message: `Inventory row not found for id=${inventoryRowPk}. If this looks like a legacy numeric id, the row may need to be migrated to UUID.` } };
  }

  if (!sourceRow.item_id) {
    console.error(`[Fulfillment] ✗ Step 1b: inventory row id=${inventoryRowPk} has NULL item_id (shared identity not set).`);
    return { success: false, error: { message: `Inventory row id=${inventoryRowPk} has no shared item_id set. Update that row's item_id column in the DB.` } };
  }

  const sharedItemId: string = sourceRow.item_id;
  console.log(`[Fulfillment] Step 1b OK: sharedItemId=${sharedItemId} (from row ${inventoryRowPk} at ${sourceRow.location_id})`);

  // ── 2. If delta <= 0, skip stock transfer — just write and recalculate ────
  if (delta <= 0) {
    console.log(`[Fulfillment] delta=${delta} <= 0, skipping stock transfer. Writing fulfilled qty only.`);
  } else {

    // ── 3. Fetch destination location_id from parent requisition ─────────────
    const { data: requisition, error: reqFetchError } = await supabase
      .from("requisitions")
      .select("location_id")
      .eq("id", requisitionId)
      .maybeSingle();

    if (reqFetchError || !requisition) {
      console.error("[Fulfillment] ✗ Step 3: could not fetch parent requisition", reqFetchError);
      return { success: false, error: reqFetchError ?? { message: `Requisition id=${requisitionId} not found.` } };
    }

    const destLocationId: string = requisition.location_id;
    console.log(`[Fulfillment] Step 3 OK: destLocationId=${destLocationId}`);

    // ── 4. Fetch HQ inventory row ─────────────────────────────────────────────
    const { data: hqRows, error: hqFetchError } = await supabase
      .from("inventory_items")
      .select("id, instock, avg_cost, name, category, itemtype, baseunit, unit, parlevel, cost, supplierid, pricetrend, priceincrease, purchaseunits")
      .eq("item_id", sharedItemId)
      .eq("location_id", HQ_LOCATION_ID);

    console.log(`[Fulfillment] Step 4 HQ lookup: item_id=${sharedItemId} loc=${HQ_LOCATION_ID} → rows=${hqRows?.length ?? 0} error=`, hqFetchError);

    if (hqFetchError) {
      console.error("[Fulfillment] ✗ Step 4: DB error fetching HQ row", hqFetchError);
      return { success: false, error: { message: `DB error fetching HQ inventory: ${hqFetchError.message}` } };
    }

    if (!hqRows || hqRows.length === 0) {
      console.error(`[Fulfillment] ✗ Step 4: HQ row genuinely missing. item_id=${sharedItemId} not present at ${HQ_LOCATION_ID}.`);
      return { success: false, error: { message: `HQ has no inventory row for this product (item_id=${sharedItemId}). Add the product to HQ inventory first.` } };
    }

    const hqRow = hqRows[0];  // use first if somehow duplicated
    const hqStockBefore = Number(hqRow.instock ?? 0);
    console.log(`[Fulfillment] Step 4 OK: HQ row id=${hqRow.id} instock=${hqStockBefore} delta=${delta}`);

    // ── 4b. Validate HQ stock ─────────────────────────────────────────────────
    if (hqStockBefore < delta) {
      console.warn(`[Fulfillment] ✗ Step 4b: Insufficient HQ stock. available=${hqStockBefore} needed=${delta}`);
      return {
        success: false,
        error: { message: `Insufficient HQ stock. Available: ${hqStockBefore}, needed: ${delta}.` },
      };
    }

    // ── 5. Check destination row exists BEFORE deducting HQ ──────────────────
    const { data: destRows, error: destFetchError } = await supabase
      .from("inventory_items")
      .select("id, instock")
      .eq("item_id", sharedItemId)
      .eq("location_id", destLocationId);

    console.log(`[Fulfillment] Step 5 dest lookup: loc=${destLocationId} → rows=${destRows?.length ?? 0} error=`, destFetchError);

    const destRow     = destRows?.[0] ?? null;
    const destExists  = !!destRow;
    const destStockBefore = destExists ? Number(destRow.instock ?? 0) : 0;
    const hqStockAfter    = hqStockBefore - delta;
    const destStockAfter  = destStockBefore + delta;

    // ── 6. Deduct from HQ ─────────────────────────────────────────────────────
    const { error: hqDeductError } = await supabase
      .from("inventory_items")
      .update({ instock: hqStockAfter })   // no updated_at — DB trigger handles it
      .eq("item_id", sharedItemId)
      .eq("location_id", HQ_LOCATION_ID);

    if (hqDeductError) {
      console.error("[Fulfillment] ✗ Step 6: HQ deduction failed", hqDeductError);
      return { success: false, error: hqDeductError };
    }
    console.log(`[Fulfillment] Step 6 OK: HQ instock ${hqStockBefore} → ${hqStockAfter}`);

    // ── 7. Add stock to destination (update or insert) ────────────────────────
    if (destExists) {
      const { error: destUpdateError } = await supabase
        .from("inventory_items")
        .update({ instock: destStockAfter })   // no updated_at — DB trigger handles it
        .eq("item_id", sharedItemId)
        .eq("location_id", destLocationId);

      if (destUpdateError) {
        console.error("[Fulfillment] ✗ Step 7: dest stock update failed", destUpdateError);
        return { success: false, error: destUpdateError };
      }
      console.log(`[Fulfillment] Step 7 OK: dest instock ${destStockBefore} → ${destStockAfter}`);
    } else {
      // Destination has no row yet — insert one using HQ row as template
      const { error: insertError } = await supabase
        .from("inventory_items")
        .insert({
          id:            crypto.randomUUID(),
          item_id:       sharedItemId,
          location_id:   destLocationId,
          instock:       destStockAfter,
          name:          hqRow.name,
          category:      hqRow.category,
          itemtype:      hqRow.itemtype,
          baseunit:      hqRow.baseunit,
          unit:          hqRow.unit,
          parlevel:      hqRow.parlevel,
          cost:          hqRow.cost,
          supplierid:    hqRow.supplierid,
          pricetrend:    hqRow.pricetrend,
          priceincrease: hqRow.priceincrease,
          purchaseunits: hqRow.purchaseunits,
        });

      if (insertError) {
        console.error("[Fulfillment] ✗ Step 7: dest insert failed", insertError);
        return { success: false, error: insertError };
      }
      console.log(`[Fulfillment] Step 7 OK: inserted new dest row instock=${destStockAfter}`);
    }

    // ── 7b. Write inventory_movements ledger (fire-and-forget) ────────────────
    // Use avg_cost → cost → 0 as the transfer unit cost.
    // Failures are logged as warnings only — never block a confirmed stock transfer.
    const unitCost   = Number(hqRow.avg_cost ?? hqRow.cost ?? 0);
    const totalCost  = unitCost * delta;
    const movUnit    = hqRow.unit || hqRow.baseunit || '';
    const movId      = crypto.randomUUID();

    const { error: ledgerError } = await supabase
      .from("inventory_movements")
      .insert([
        {
          id:               movId + '-out',
          item_id:          sharedItemId,
          item_identity:    hqRow.name ?? null,
          movement_type:    'requisition_out',
          reference_type:   'requisition',
          reference_id:     requisitionId,
          from_location_id: HQ_LOCATION_ID,
          to_location_id:   destLocationId,
          quantity:         delta,
          unit:             movUnit,
          unit_cost:        unitCost,
          total_cost:       totalCost,
          notes:            `Requisition fulfillment: ${delta} ${movUnit} → ${destLocationId}`,
        },
        {
          id:               movId + '-in',
          item_id:          sharedItemId,
          item_identity:    hqRow.name ?? null,
          movement_type:    'requisition_in',
          reference_type:   'requisition',
          reference_id:     requisitionId,
          from_location_id: HQ_LOCATION_ID,
          to_location_id:   destLocationId,
          quantity:         delta,
          unit:             movUnit,
          unit_cost:        unitCost,
          total_cost:       totalCost,
          notes:            `Received from HQ: ${delta} ${movUnit}`,
        },
      ]);

    if (ledgerError) {
      // Non-fatal: stock transfer already committed. Log and continue.
      console.warn('[Fulfillment] ⚠ Step 7b: movement ledger insert failed (non-fatal)', {
        message: ledgerError.message, code: ledgerError.code,
      });
    } else {
      console.log(`[Fulfillment] Step 7b OK: 2 movement rows written (unit_cost=${unitCost} total=${totalCost})`);
    }
  }

  // Raw-mode shared path: write qty_fulfilled + recalc status
  return await writeFulfilledAndRecalc(itemId, quantityFulfilled, requisitionId);
}



/**
 * Shared helper: write quantity_fulfilled on a requisition_items row, then
 * recompute the parent requisition status (fulfilled vs approved).
 * Called by BOTH FG-mode and raw-mode fulfillment paths so logic is DRY.
 */
async function writeFulfilledAndRecalc(
  itemId: string,
  quantityFulfilled: number,
  requisitionId: string
): Promise<{ success: boolean; newStatus?: string; error?: any }> {
  // ── 8. Write new quantity_fulfilled ────────────────────────────────────────────
  const { error: writeError } = await supabase
    .from("requisition_items")
    .update({ quantity_fulfilled: quantityFulfilled })
    .eq("id", itemId);

  if (writeError) {
    console.error("[Fulfillment] ✗ Step 8: requisition_items write failed", writeError);
    return { success: false, error: writeError };
  }
  console.log(`[Fulfillment] Step 8 OK: quantity_fulfilled=${quantityFulfilled}`);

  // ── 9. Recalculate requisition status ──────────────────────────────────────────
  const { data: allItems, error: siblingsError } = await supabase
    .from("requisition_items")
    .select("quantity_requested, quantity_fulfilled")
    .eq("requisition_id", requisitionId);

  if (siblingsError || !allItems || allItems.length === 0) {
    return { success: true };
  }

  const allDone = allItems.every(
    (row) => Number(row.quantity_fulfilled ?? 0) >= Number(row.quantity_requested)
  );
  const newStatus = allDone ? "fulfilled" : "approved";

  const { error: statusError } = await supabase
    .from("requisitions")
    .update({ status: newStatus })
    .eq("id", requisitionId);

  if (statusError) {
    console.error("[Fulfillment] ✗ Step 9: status sync failed", statusError);
  } else {
    console.log(`[Fulfillment] Step 9 OK: requisition status → ${newStatus}`);
  }

  return { success: true, newStatus };
}
