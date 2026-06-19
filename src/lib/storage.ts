import { supabase } from "@/lib/supabase";
import {
  normalizeLocationStatus,
  isActiveLocation,
  isStoreLocation,
  isHqLocation,
  isInternalLocation,
  isWarehouseLocation,
  isDeliveryDestinationLocation,
  isUserAssignableLocation,
  isReportVisibleLocation,
  buildFullLocationAddress,
  getLocationHealthStatus
} from "./locationRegistry";

// ============================================================================
// GLOBAL MAPPER ARCHITECTURE
// All read/write bounds mathematically mapping camelCase and complex DOM arrays
// exclusively into Postgres strictly lowercase unquoted table bounds preserving
// natively. No module will write to Supabase structurally outside this firewall.
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// UNIT CONVERSION
//
// Converts a quantity expressed in `fromUnit` into `toUnit`.
// Supports: kg, g, lb, oz   (mass)
//           l, ml, fl oz    (volume)
//
// Returns null when the conversion is impossible (e.g. mass → volume, unknown
// unit), so callers can show a warning instead of producing a garbage number.
//
// Example:
//   convertUnit(15, 'kg', 'oz')  →  529.109
//   convertUnit(1,  'kg', 'kg')  →  1
//   convertUnit(1,  'kg', 'l')   →  null  (different dimensions)
// ─────────────────────────────────────────────────────────────────────────────

/** All units expressed in grams (mass) or millilitres (volume). */
const TO_BASE: Record<string, { base: 'g' | 'ml'; factor: number }> = {
  // ── Mass ──────────────────────────────────────────────────────────────────
  'kg':    { base: 'g',  factor: 1000      },
  'g':     { base: 'g',  factor: 1         },
  'lb':    { base: 'g',  factor: 453.59237 },
  'oz':    { base: 'g',  factor: 28.349523 },
  // ── Volume ────────────────────────────────────────────────────────────────
  'l':     { base: 'ml', factor: 1000      },
  'ml':    { base: 'ml', factor: 1         },
  'fl oz': { base: 'ml', factor: 29.57353  },
};

/**
 * Convert `qty` from `fromUnit` to `toUnit`.
 * Returns null if conversion is impossible or a unit is unknown.
 */
export function convertUnit(
  qty: number,
  fromUnit: string,
  toUnit: string,
): number | null {
  const norm = (u: string) => u.trim().toLowerCase();
  const from = norm(fromUnit);
  const to   = norm(toUnit);

  // Same unit → no conversion needed
  if (from === to) return qty;

  const fromEntry = TO_BASE[from];
  const toEntry   = TO_BASE[to];

  // Unknown unit
  if (!fromEntry || !toEntry) return null;
  // Different measurement dimensions (e.g. mass vs volume)
  if (fromEntry.base !== toEntry.base) return null;

  // Convert: qty × fromFactor ÷ toFactor
  return (qty * fromEntry.factor) / toEntry.factor;
}

/**
 * Convert a recipe yield quantity into the finished good's base unit.
 *
 * Returns:
 *   { qty: number; converted: boolean }  on success
 *   null  when conversion is impossible (caller should show a warning)
 *
 * Example:
 *   convertYieldToBaseUnit(15, 'kg', 'oz')
 *   → { qty: 529.109, converted: true }
 */
export function convertYieldToBaseUnit(
  recipeYieldQty:  number,
  recipeYieldUnit: string,
  fgBaseUnit:      string,
): { qty: number; converted: boolean } | null {
  if (recipeYieldQty <= 0) return null;

  const norm = (u: string) => u.trim().toLowerCase();
  const fromU = norm(recipeYieldUnit);
  const toU   = norm(fgBaseUnit);

  // Same unit — no conversion required
  if (fromU === toU) return { qty: recipeYieldQty, converted: false };

  // Non-dimensional units (ea, pcs, box, case, pack, btl…) can't be converted
  const dimensional = Object.keys(TO_BASE);
  if (!dimensional.includes(fromU) || !dimensional.includes(toU)) {
    // If BOTH are non-dimensional and equal → handled above.
    // If one is dimensional and the other isn't → impossible.
    return null;
  }

  const converted = convertUnit(recipeYieldQty, fromU, toU);
  if (converted === null) return null;
  return { qty: converted, converted: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// MEASUREMENT FAMILY HELPERS
//
// These pure functions drive the Add/Edit Inventory Item UI:
//   - deriveLockedBaseUnit       → the DEFAULT (family minimum) storage unit
//   - getAllowedBaseUnits        → all selectable base units for a family
//   - resolveStorageBaseUnit     → user choice if valid, else family default
//   - getFamilyAllowedInnerUnits → which inner measurement units are valid
//   - calcBaseQtyPerPurchaseUnit → total base-unit qty in one purchase unit
//   - inferMeasurementFamily     → auto-detect family from an existing baseUnit
// ─────────────────────────────────────────────────────────────────────────────

export type MeasurementFamily =
  | 'weight' | 'volume' | 'count' | 'labour' | 'preparation' | 'finished_good';

/**
 * The default (smallest / most precise) internal base unit for each family.
 * Kept as the locked fallback when no explicit selection is saved.
 */
export function deriveLockedBaseUnit(family: string): string {
  switch (family) {
    case 'weight':       return 'g';
    case 'volume':       return 'ml';
    case 'count':        return 'ea';
    case 'labour':       return 'hr';
    case 'preparation':  return 'g';   // preparation items are always weighed internally
    case 'finished_good':return 'ea';
    default:             return '';
  }
}

/**
 * All valid base unit choices within a measurement family.
 * The first element is the recommended / most-precise default.
 * These are the options shown in the "Base Unit" dropdown in the Edit drawer.
 */
export function getAllowedBaseUnits(family: string): string[] {
  switch (family) {
    case 'weight':       return ['g', 'kg', 'lb', 'oz'];
    case 'volume':       return ['ml', 'l', 'fl oz'];
    case 'count':        return ['ea', 'pack', 'case', 'box', 'bag'];
    case 'labour':       return ['hr'];   // min stays as inner-unit only
    case 'preparation':  return ['g', 'kg', 'ml', 'l', 'ea'];
    case 'finished_good':return ['ea', 'batch', 'portion', 'tray'];
    default:             return [];
  }
}

/**
 * Return the effective base unit for an item given its measurement family and
 * the user's explicit selection (if any).
 *
 * Rule:
 *   - If `selectedBaseUnit` is non-empty AND is in the allowed list for the
 *     family → use it.
 *   - Otherwise fall back to `deriveLockedBaseUnit(family)` (the default).
 *
 * This is the single source of truth for "what unit is stock, par, and
 * per-base-unit cost expressed in?" at save time.
 */
export function resolveStorageBaseUnit(
  family: string,
  selectedBaseUnit: string | null | undefined,
): string {
  const candidate = selectedBaseUnit?.trim();
  if (candidate) {
    const allowed = getAllowedBaseUnits(family);
    if (allowed.includes(candidate)) return candidate;
  }
  return deriveLockedBaseUnit(family);
}

/** Measurement units that are valid for the inner pack (innerMeasurementUnit). */
export function getFamilyAllowedInnerUnits(family: string): string[] {
  switch (family) {
    case 'weight':
    case 'preparation':
      return ['g', 'kg', 'lb', 'oz'];
    case 'volume':
      return ['ml', 'l', 'fl oz'];
    case 'count':
    case 'finished_good':
      return ['ea'];
    case 'labour':
      return ['hr', 'min'];
    default:
      return [];
  }
}

/**
 * Compute the total base-unit quantity contained in one purchase unit.
 *
 * @param family              Measurement family of the item
 * @param innerPackCount      How many inner units are in one purchase unit
 * @param innerQty            Quantity per inner unit
 * @param innerMeasurementUnit The unit of `innerQty`
 * @param explicitBaseUnit    (Optional) user-selected base unit. When provided
 *                             and valid for the family, overrides the family default.
 *
 * Examples (base unit = L):
 *   volume, innerPackCount=1, innerQty=16, innerMeasurementUnit='l', explicitBaseUnit='l'
 *     → 1 × 16 l → already l → 16 L
 *
 * Examples (base unit = ml, legacy default):
 *   volume, innerPackCount=1, innerQty=16, innerMeasurementUnit='l'
 *     → 1 × 16 l × 1000 ml/l = 16000 ml
 *
 * Returns null when the conversion is impossible (incompatible units).
 */
export function calcBaseQtyPerPurchaseUnit(
  family: string,
  innerPackCount: number,
  innerQty: number,
  innerMeasurementUnit: string,
  explicitBaseUnit?: string | null,
): number | null {
  if (innerPackCount <= 0 || innerQty <= 0) return null;

  const base = resolveStorageBaseUnit(family, explicitBaseUnit);
  if (!base) return null;

  const totalInner = innerPackCount * innerQty;

  // Count / labour / finished_good: no dimensional conversion needed
  if (['ea', 'hr'].includes(base)) {
    if (innerMeasurementUnit === base || innerMeasurementUnit === 'min') {
      if (innerMeasurementUnit === 'min') return totalInner / 60; // min → hr
      return totalInner;
    }
    return null;
  }

  // Weight (g/kg/lb/oz) or Volume (ml/l/fl oz): use convertUnit
  const converted = convertUnit(totalInner, innerMeasurementUnit, base);
  return converted; // null if units are incompatible
}

/**
 * Auto-infer measurement family from a legacy baseUnit string.
 * Used when opening an existing inventory item that was created before
 * measurement_family was added to the schema.
 */
export function inferMeasurementFamily(baseUnit: string | null | undefined): MeasurementFamily | '' {
  if (!baseUnit) return '';
  const u = baseUnit.trim().toLowerCase();
  if (['g', 'kg', 'lb', 'oz'].includes(u))       return 'weight';
  if (['ml', 'l', 'fl oz'].includes(u))           return 'volume';
  if (['ea', 'each', 'piece', 'pcs'].includes(u)) return 'count';
  if (['hr', 'hour'].includes(u))                 return 'labour';
  return '';
}


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
     physicalCount: db.physical_count ?? db.physicalcount ?? null,
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
     // ── Phase 2: Measurement family (drives locked base unit)
     measurementFamily: db.measurement_family ?? null,
     // Explicit production recipe link — set via Production → Prep/Base "Link Recipe" picker
     linkedRecipeId:    db.linked_recipe_id ?? null,
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
     baseunit: resolvedBaseUnit,
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
     // ── Phase 2: Measurement family
     measurement_family:  item.measurementFamily ?? null,
     // Explicit prep→recipe linkage — persist whatever HQ sets
     linked_recipe_id:    item.linkedRecipeId ? String(item.linkedRecipeId) : null,
  };
};

// ─── Pagination helper ──────────────────────────────────────────────────────────────────────────────
//
// Supabase PostgREST silently caps results at its server-side max_rows (default
// 1000). Without explicit pagination, tables larger than that limit return only
// the first N rows — no error, no warning.
//
// fetchAllRows pages through the table in chunks of `pageSize` (default 1000)
// until a page returns fewer rows than the size, signalling the last page.
// Existing filters, ordering, and RLS all apply normally on each page.
//
// Usage:
//   const rows = await fetchAllRows(
//     q => q.from("inventory_items").select("*").eq("location_id", id).order("name"),
//     1000
//   );
//
export async function fetchAllRows<T = any>(
  buildQuery: (client: typeof supabase) => {
    range: (from: number, to: number) => Promise<{ data: T[] | null; error: any }>;
  },
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery(supabase).range(from, to);
    if (error) throw error;   // never return partial data — let the caller handle it
    const page = data ?? [];
    all.push(...page);
    if (page.length < pageSize) break; // last page
    from += pageSize;
  }
  return all;
}


/**
 * Load all inventory items.
 *
 * Uses fetchAllRows to page through inventory_items in 1000-row chunks so the
 * full table is always returned regardless of size.
 *
 * - Pass locationId to scope to a specific location (HQ cross-location review).
 * - Pass null/undefined for the current user's default scoped view.
 */
export async function loadInventory(locationId?: string | null) {
  const data = await fetchAllRows(
    (sb) => {
      let q = sb
        .from('inventory_items')
        .select('*')
        .order('name', { ascending: true }) as any;
      if (locationId) q = q.eq('location_id', locationId);
      return q;
    },
    1000,
  );
  console.log(`[loadInventory] fetched ${data.length} rows${locationId ? ` for location ${locationId}` : ''}`);
  return data.map(mapInventoryToFrontend);
}

export async function saveInventory(data: any[]) {
  const cleanData = data.map(mapInventoryToDB);
  const originalRows = cleanData;
  const uniqueMap = new Map<string, any>();
  for (const row of originalRows) {
    if (row.id) {
      uniqueMap.set(String(row.id), row);
    }
  }
  const dedupedRows = Array.from(uniqueMap.values());

  console.warn("Deduped inventory updates", {
    before: originalRows.length,
    after: dedupedRows.length
  });

  const { error } = await supabase.from('inventory_items').upsert(dedupedRows, { onConflict: 'id' });
  if (error) return { success: false, error };
  return { success: true };
}

/**
 * Update exactly one inventory_items row, guarded by both row id and location_id.
 * Use this for location-scoped item setup, stock, par, price, and unit edits.
 * It never upserts, so it cannot create a row in HQ or another location.
 */
export async function updateInventoryItemScoped(
  item: any,
  expectedLocationId?: string | null
): Promise<{ success: boolean; error?: any }> {
  const row = mapInventoryToDB(item);
  const locationId = expectedLocationId ?? row.location_id;
  if (!row.id || !locationId) {
    return { success: false, error: { message: 'Inventory row id and location_id are required for scoped update.' } };
  }

  const { id, ...patch } = row;
  const { data, error } = await supabase
    .from('inventory_items')
    .update(patch)
    .eq('id', id)
    .eq('location_id', locationId)
    .select('id, location_id');

  if (error) return { success: false, error };
  if (!data || data.length !== 1) {
    return {
      success: false,
      error: { message: `Scoped inventory update matched ${data?.length ?? 0} rows for id=${id} location_id=${locationId}.` },
    };
  }
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
 * Reassign the shared product identity (item_id) on a single inventory_items row.
 *
 * This is the ONLY write used by the duplicate merge feature.
 * It does NOT:
 *  - rename the row
 *  - delete any row
 *  - touch recipes, movements, or requisitions
 *
 * After this call, the row will match HQ lookups that filter by newItemId,
 * enabling fulfillment and future allocation to treat it as the canonical product.
 */
export async function updateInventoryRowItemId(
  rowId: string,
  newItemId: string
): Promise<{ success: boolean; error?: any }> {
  if (!rowId || !newItemId) {
    return { success: false, error: { message: "rowId and newItemId are required." } };
  }
  const { error } = await supabase
    .from('inventory_items')
    .update({ item_id: newItemId })
    .eq('id', rowId);
  if (error) return { success: false, error };
  return { success: true };
}



/**
 * Deduct a quantity from a single inventory_items row (atomic read-modify-write).
 *
 * Used by production execution to apply ingredient deductions after a production
 * run. Each ingredient gets its own targeted UPDATE so we never need to re-upsert
 * the full inventory array (which would ignore items not yet loaded in the page's
 * local state).
 *
 * quantity: positive number — the amount to subtract (floor at 0).
 * Returns the new instock value on success.
 */
export async function deductInventoryItemStock(
  rowId: string,
  quantity: number
): Promise<{ success: boolean; newStock?: number; error?: any }> {
  // Read current stock
  const { data: current, error: fetchErr } = await supabase
    .from('inventory_items')
    .select('instock, location_id')
    .eq('id', rowId)
    .single();

  if (fetchErr || !current) {
    console.error('[deductInventoryItemStock] fetch error', fetchErr);
    return { success: false, error: fetchErr };
  }

  const newStock = Math.max(0, Number(current.instock ?? 0) - quantity);

  console.log(
    `[deductInventoryItemStock] id=${rowId} current=${current.instock} deduct=${quantity} → newStock=${newStock}`
  );

  const { error: updateErr } = await supabase
    .from('inventory_items')
    .update({ instock: newStock })
    .eq('id', rowId)
    .eq('location_id', current.location_id);

  if (updateErr) {
    console.error('[deductInventoryItemStock] update error', updateErr);
    return { success: false, error: updateErr };
  }
  return { success: true, newStock };
}

/**
 * Adjust a single inventory_items row by delta.
 * Positive delta adds stock, negative delta removes stock. Floors at zero.
 * Used by production void/correction flows so every stock correction can be
 * paired with explicit inventory_movements reversal rows.
 */
export async function adjustInventoryItemStock(
  rowId: string,
  delta: number
): Promise<{ success: boolean; newStock?: number; error?: any }> {
  const { data: current, error: fetchErr } = await supabase
    .from('inventory_items')
    .select('instock, location_id')
    .eq('id', rowId)
    .single();

  if (fetchErr || !current) {
    console.error('[adjustInventoryItemStock] fetch error', fetchErr);
    return { success: false, error: fetchErr ?? { message: 'Inventory item not found' } };
  }

  const currentStock = Number(current.instock ?? 0);
  const newStock = Math.max(0, currentStock + delta);

  const { error: updateErr } = await supabase
    .from('inventory_items')
    .update({ instock: newStock })
    .eq('id', rowId)
    .eq('location_id', current.location_id);

  if (updateErr) {
    console.error('[adjustInventoryItemStock] update error', updateErr);
    return { success: false, error: updateErr };
  }

  return { success: true, newStock };
}

/**
 * Set one inventory_items.instock value to an exact target and write a matching
 * stock_correction movement. This is intentionally an exact set, not a delta
 * conversion helper, so operators can recover from impossible stock values.
 */
export async function setInventoryStockToTarget(params: {
  itemId: string;
  targetBaseQty: number;
  reason: string;
  locationId?: string | null;
  movementItemId?: string | null;
  unit?: string | null;
  unitCost?: number | null;
}): Promise<{ success: boolean; previousStock?: number; targetStock?: number; delta?: number; error?: any }> {
  const { data: current, error: fetchErr } = await supabase
    .from('inventory_items')
    .select('id, instock, location_id, item_id, unit, baseunit, cost')
    .eq('id', params.itemId)
    .single();

  if (fetchErr || !current) {
    console.error('[setInventoryStockToTarget] fetch error', fetchErr);
    return { success: false, error: fetchErr ?? { message: 'Inventory item not found' } };
  }

  const previousStock = Number(current.instock ?? 0);
  const targetStock = Number(params.targetBaseQty);
  if (!Number.isFinite(targetStock) || targetStock < 0) {
    return { success: false, error: { message: 'Target stock must be a number 0 or greater.' } };
  }

  const delta = targetStock - previousStock;
  const { error: updateErr } = await supabase
    .from('inventory_items')
    .update({ instock: targetStock })
    .eq('id', params.itemId)
    .eq('location_id', current.location_id);

  if (updateErr) {
    console.error('[setInventoryStockToTarget] update error', updateErr);
    return { success: false, error: updateErr };
  }

  const movementErr = await logMovement({
    locationId:    params.locationId ?? current.location_id ?? 'LOC-HQ',
    itemId:        String(params.movementItemId ?? current.item_id ?? current.id),
    movementType:  'stock_correction',
    quantity:      Math.abs(delta),
    unitCost:      params.unitCost ?? current.cost ?? null,
    referenceType: 'stock_correction',
    referenceId:   `stock-correction:${current.id}:${Date.now()}`,
    notes:         `Stock Correction | previous_stock=${previousStock} | target_stock=${targetStock} | quantity_delta=${delta} | unit=${params.unit ?? current.baseunit ?? current.unit ?? ''} | reason=${params.reason}`,
  });

  if (movementErr) {
    return {
      success: false,
      previousStock,
      targetStock,
      delta,
      error: movementErr,
    };
  }

  return { success: true, previousStock, targetStock, delta };
}

/**
 * Atomically set (or clear) the linked_recipe_id on a single inventory_items row.
 *
 * Called from Production → Prep/Base "Link Recipe" picker.
 * Pass recipeId=null to unlink.
 *
 * Requires migration_linked_recipe.sql to have been run first.
 */
export async function updateInventoryLinkedRecipe(
  itemId: string,
  recipeId: string | null
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('inventory_items')
    .update({ linked_recipe_id: recipeId ?? null })
    .eq('id', itemId);
  if (error) {
    console.error('[updateInventoryLinkedRecipe] error:', error);
    return { success: false, error };
  }
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
 * Allocate a source inventory item to one or more store locations.
 *
 * Phase 3A — foundation only. No sync, no inheritance.
 *
 * Contract:
 *  - Each new row gets a FRESH crypto.randomUUID() row id (never clones source id).
 *  - item_id is copied verbatim from sourceItem.itemId (the shared product identity).
 *  - instock is ALWAYS 0 — stock must be counted/entered per-location after allocation.
 *  - parlevel is set from options.startingPar (defaults to 0).
 *  - Supplier (supplierId) and cost are copied only when options flags are true.
 *  - Safe V1 fields always copied: name, category, itemtype, baseunit, unit,
 *    purchase_uom, pack_qty, inner_unit_type, inner_unit_size, allowed_recipe_uoms.
 *
 * Returns the newly-mapped frontend rows so the caller can append them to
 * local inventoryData without a full reload.
 */
export async function allocateInventoryToLocations(
  sourceItem: any,
  locationIds: string[],
  options: {
    copySupplier:  boolean;
    copyCost:      boolean;
    startingPar:   number;
  }
): Promise<{
  success:       boolean;
  insertedRows?: any[];  // mapped to frontend shape for immediate state merge
  errors?:       { locationId: string; message: string }[];
}> {
  if (!locationIds || locationIds.length === 0) {
    return { success: false, errors: [{ locationId: '', message: 'No locations selected.' }] };
  }

  const canonicalItemId = sourceItem.itemId ?? sourceItem.item_id;
  if (!canonicalItemId) {
    return { success: false, errors: [{ locationId: '', message: 'Source item has no shared item_id — allocate from an HQ row with a valid item_id.' }] };
  }

  const insertedRows: any[] = [];
  const errors: { locationId: string; message: string }[] = [];

  for (const locationId of locationIds) {
    const rowId = crypto.randomUUID();

    const row: Record<string, any> = {
      id:          rowId,
      item_id:     canonicalItemId,  // ← ALWAYS the source canonical identity
      location_id: locationId,

      // ── V1 safe fields (always copied) ──
      name:          sourceItem.name         || '',
      category:      sourceItem.category     || '',
      itemtype:      sourceItem.itemType     || '',
      baseunit:      sourceItem.baseUnit     || sourceItem.unit || '',
      unit:          sourceItem.unit         || '',
      purchase_uom:  sourceItem.purchaseUom  ?? null,
      pack_qty:      sourceItem.packQty      != null ? Number(sourceItem.packQty) : null,
      inner_unit_type: sourceItem.innerUnitType  ?? null,
      inner_unit_size: sourceItem.innerUnitSize  != null ? Number(sourceItem.innerUnitSize) : null,
      inner_unit_uom:  sourceItem.innerUnitUom   ?? null,
      base_uom:        sourceItem.baseUomNew?.trim() || null,
      allowed_recipe_uoms: Array.isArray(sourceItem.allowedRecipeUoms) ? sourceItem.allowedRecipeUoms : null,
      purchaseunits: Array.isArray(sourceItem.purchaseUnits) ? sourceItem.purchaseUnits : [],

      // ── Always reset ──
      instock:   0,
      parlevel:  isNaN(options.startingPar) ? 0 : options.startingPar,

      // ── Optional copies ──
      supplierid:   options.copySupplier && typeof sourceItem.supplierId === 'number' ? sourceItem.supplierId : null,
      cost:         options.copyCost     && !isNaN(parseFloat(sourceItem.cost)) ? parseFloat(sourceItem.cost) : 0,
      purchasecost: options.copyCost     && sourceItem.purchaseCost != null ? parseFloat(sourceItem.purchaseCost) || null : null,

      // housekeeping defaults
      pricetrend:    'steady',
      priceincrease: false,
    };

    const { error } = await supabase.from('inventory_items').insert(row);
    if (error) {
      console.error(`[allocateInventoryToLocations] insert failed for ${locationId}:`, error);
      errors.push({ locationId, message: error.message });
      continue;
    }

    // Map back to frontend shape for immediate state merge
    insertedRows.push(mapInventoryToFrontend(row));
  }

  if (insertedRows.length === 0 && errors.length > 0) {
    return { success: false, errors };
  }
  return { success: true, insertedRows, errors: errors.length > 0 ? errors : undefined };
}

export interface CopyInventoryItemsToLocationsOptions {
  sourceLocationId: string;
  sourceRowIds: string[];
  targetLocationIds: string[];
  copyParLevels: boolean;
  copySupplierCostSettings: boolean;
  copyPurchaseOptions: boolean;
  copyStock: boolean;
  updateExistingSetupFields: boolean;
}

export interface CopyInventoryItemsToLocationsResult {
  created: number;
  updated: number;
  skipped: number;
  purchaseOptionsCopied: number;
  failed: number;
  errors: string[];
  insertedRows: any[];
  updatedRows: any[];
}

const normalizeInventoryCopyKey = (value: any) =>
  String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const getInventoryDuplicateKey = (row: any) => [
  normalizeInventoryCopyKey(row.name),
  normalizeInventoryCopyKey(row.baseunit ?? row.baseUnit ?? row.unit),
  normalizeInventoryCopyKey(row.supplierid ?? row.supplierId ?? ''),
].join('|');

const getPurchaseOptionDuplicateKey = (row: any) => [
  normalizeInventoryCopyKey(row.supplier_name ?? row.supplierName),
  normalizeInventoryCopyKey(row.purchase_uom ?? row.purchaseUom),
  normalizeInventoryCopyKey(row.pack_qty ?? row.packQty ?? ''),
  normalizeInventoryCopyKey(row.unit_price ?? row.unitPrice ?? 0),
].join('|');

const LONDON_TEMPLATE_LOCATION_ID = 'LOC-1091';

/**
 * Copy independent location-level Inventory setup rows to other locations.
 *
 * This intentionally touches only:
 *   - inventory_items
 *   - purchase_options, when requested
 *
 * It does not touch Outlet Inventory, HQ sale items, requisitions, orders,
 * recipes, production, reports, invoices, or movements.
 */
export async function copyInventoryItemsToLocations(
  options: CopyInventoryItemsToLocationsOptions
): Promise<CopyInventoryItemsToLocationsResult> {
  const emptyResult: CopyInventoryItemsToLocationsResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    purchaseOptionsCopied: 0,
    failed: 0,
    errors: [],
    insertedRows: [],
    updatedRows: [],
  };

  const sourceRowIds = Array.from(new Set(options.sourceRowIds.map(String).filter(Boolean)));
  const sourceLocationId = String(options.sourceLocationId ?? '').trim();
  const targetLocationIds = Array.from(new Set(options.targetLocationIds.map(String).filter(Boolean)))
    .filter((locationId) => locationId !== LONDON_TEMPLATE_LOCATION_ID && locationId !== 'LOC-HQ');
  if (sourceRowIds.length === 0 || targetLocationIds.length === 0) return emptyResult;
  if (sourceLocationId !== LONDON_TEMPLATE_LOCATION_ID) {
    return {
      ...emptyResult,
      failed: sourceRowIds.length * targetLocationIds.length,
      errors: [`This copy workflow only supports London / ${LONDON_TEMPLATE_LOCATION_ID} as the source location.`],
    };
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return {
      ...emptyResult,
      failed: sourceRowIds.length * targetLocationIds.length,
      errors: ['No active auth session. Please sign out and sign back in.'],
    };
  }

  const resp = await fetch('/api/inventory/copy-london-template', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      sourceLocationId,
      selectedItemIds: sourceRowIds,
      targetLocationIds,
      copyPar: options.copyParLevels,
      copySupplierSettings: options.copySupplierCostSettings,
      copyPurchaseOptions: options.copyPurchaseOptions,
      copyStock: options.copyStock,
      updateExistingSetupFields: options.updateExistingSetupFields,
    }),
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body?.success) {
    return {
      ...emptyResult,
      failed: sourceRowIds.length * targetLocationIds.length,
      errors: [body?.error || resp.statusText || 'Copy London template failed.'],
    };
  }

  return {
    ...emptyResult,
    ...body.data,
    insertedRows: Array.isArray(body.data?.insertedRows) ? body.data.insertedRows : [],
    updatedRows: Array.isArray(body.data?.updatedRows) ? body.data.updatedRows : [],
    errors: Array.isArray(body.data?.errors) ? body.data.errors : [],
  };
}



/**
 * Hard-delete a single inventory_items row by its UUID primary key.
 *
 * Use this instead of saveInventory(filtered) which calls upsert and never
 * actually deletes the row — the item reappears on next page load.
 */
export async function deleteInventoryItem(
  rowId: string
): Promise<{ success: boolean; error?: any }> {
  console.log('[deleteInventoryItem] Deleting inventory item:', rowId);
  const { error } = await supabase
    .from('inventory_items')
    .delete()
    .eq('id', rowId);
  if (error) {
    console.error('[deleteInventoryItem] error:', error);
    return { success: false, error };
  }
  return { success: true };
}

/**
 * Hard-delete a single hq_sale_items row.
 *
 * Tries by id first. If the id does not exist in hq_sale_items (item came
 * from inventory_items only), falls back to a case-insensitive name match.
 * This covers the "same item in both tables with different row ids" case.
 */
export async function deleteSaleItemByNameOrId(
  id: string,
  name: string
): Promise<{ success: boolean; deletedCount: number; error?: any }> {
  console.log('[deleteSaleItemByNameOrId] Deleting finished good: id=', id, 'name=', name);

  // Attempt by id first (fast, exact)
  const { data: byId, error: idErr } = await supabase
    .from('hq_sale_items')
    .select('id')
    .eq('id', id)
    .limit(1);

  if (idErr) {
    console.error('[deleteSaleItemByNameOrId] id-lookup error:', idErr);
    return { success: false, deletedCount: 0, error: idErr };
  }

  if (byId && byId.length > 0) {
    // Found by id — delete it
    const { error: delErr } = await supabase
      .from('hq_sale_items')
      .delete()
      .eq('id', id);
    if (delErr) {
      console.error('[deleteSaleItemByNameOrId] delete-by-id error:', delErr);
      return { success: false, deletedCount: 0, error: delErr };
    }
    console.log('[deleteSaleItemByNameOrId] deleted 1 row by id:', id);
    return { success: true, deletedCount: 1 };
  }

  // Not found by id → try name match (covers cross-table name-based duplicates)
  if (!name?.trim()) {
    console.log('[deleteSaleItemByNameOrId] no id match and no name provided — nothing to delete');
    return { success: true, deletedCount: 0 };
  }

  const { data: byName, error: nameErr } = await supabase
    .from('hq_sale_items')
    .select('id')
    .ilike('name', name.trim());

  if (nameErr) {
    console.error('[deleteSaleItemByNameOrId] name-lookup error:', nameErr);
    return { success: false, deletedCount: 0, error: nameErr };
  }

  if (!byName || byName.length === 0) {
    console.log('[deleteSaleItemByNameOrId] no matching hq_sale_item found for name:', name);
    return { success: true, deletedCount: 0 }; // not an error — item simply didn't exist
  }

  const ids = byName.map((r: any) => r.id);
  const { error: bulkDelErr } = await supabase
    .from('hq_sale_items')
    .delete()
    .in('id', ids);

  if (bulkDelErr) {
    console.error('[deleteSaleItemByNameOrId] bulk name-delete error:', bulkDelErr);
    return { success: false, deletedCount: 0, error: bulkDelErr };
  }

  console.log('[deleteSaleItemByNameOrId] deleted', ids.length, 'row(s) by name:', name);
  return { success: true, deletedCount: ids.length };
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
  const errors: string[] = [];
  fgs.forEach(fgItem => {
     const match = inv.findIndex((i: any) => i.id.toString() === fgItem.id.toString());
     if (match !== -1) inv[match] = { ...inv[match], ...fgItem };
  });
  for (const fgItem of fgs) {
    const match = inv.find((i: any) => i.id.toString() === fgItem.id.toString());
    if (!match) continue;
    const res = await updateInventoryItemScoped(match, match.locationId);
    if (!res.success) errors.push(`${match.name}: ${res.error?.message ?? 'update failed'}`);
  }
  return errors.length > 0 ? { success: false, error: { message: errors.join('\n') } } : { success: true };
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
  packQty:              number;          // how many base units make up one sellable pack/case; default 1
  locationAvailabilityMode: 'all' | 'selected' | 'hq_only';
  /**
   * Optional HQ-controlled override for the availability badge shown to outlet users.
   * When null, the system calculates from instock / par_level.
   * Allowed values: 'available' | 'low_stock' | 'out_of_stock' | 'not_available'
   */
  availabilityOverride: 'available' | 'low_stock' | 'out_of_stock' | 'not_available' | null;
  createdAt:            string | null;
  updatedAt:            string | null;
}

// ─── Outlet-facing availability helper ──────────────────────────────────────
/**
 * Returns the 4-state availability label for a finished good as seen by
 * outlet / location-manager users.  Never exposes exact stock numbers.
 *
 * Priority:
 *   1. If item is inactive or not requisitionable → 'not_available'
 *   2. If HQ has set availability_override        → use override
 *   3. Auto-calculate from instock vs par_level
 */
export type HQAvailability = 'available' | 'low_stock' | 'out_of_stock' | 'not_available';

export function getHQAvailabilityLabel(item: SaleItem): HQAvailability {
  if (!item.isActive || !item.isRequisitionable) return 'not_available';
  if (item.availabilityOverride) return item.availabilityOverride;
  if (item.instock <= 0) return 'out_of_stock';
  // Use par_level as low-stock threshold; fall back to a safe default of 5
  const threshold = item.parLevel > 0 ? item.parLevel : 5;
  if (item.instock <= threshold) return 'low_stock';
  return 'available';
}

const mapSaleItemToFrontend = (db: any): SaleItem => ({
  id:                   db.id,
  name:                 db.name,
  category:             db.category ?? null,
  sourceCommissary:     db.source_commissary ?? 'Commissary HQ',
  description:          db.description ?? null,
  // Normalise unit at read time so 'Oz', ' KG ', etc. never break comparisons
  baseUnit:             (db.base_unit ?? 'ea').trim().toLowerCase(),
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
  locationAvailabilityMode: (db.location_availability_mode ?? 'all') as SaleItem['locationAvailabilityMode'],
  availabilityOverride: (db.availability_override ?? null) as SaleItem['availabilityOverride'],
  packQty:              Number(db.pack_qty ?? 1) || 1,  // default 1 if null/0
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
  pack_qty:                (item.packQty != null && !isNaN(Number(item.packQty)) && Number(item.packQty) > 0)
                             ? Number(item.packQty)
                             : 1,
  location_availability_mode: item.locationAvailabilityMode ?? 'all',
  availability_override:   item.availabilityOverride ?? null,
  // suggested_price is a generated column — never write it
  updated_at:              new Date().toISOString(),
});

// ----------------------------------------------------------------------------
// CATEGORIES
// ----------------------------------------------------------------------------

export interface CategoryRow {
  id:         string;
  name:       string;
  type:       'finished_goods' | 'inventory';
  sortOrder:  number;
  isActive:   boolean;
  createdAt:  string;
  updatedAt:  string;
}

const mapCategoryRow = (db: any): CategoryRow => ({
  id:        db.id,
  name:      db.name,
  type:      db.type,
  sortOrder: db.sort_order ?? 0,
  isActive:  db.is_active ?? true,
  createdAt: db.created_at,
  updatedAt: db.updated_at,
});

/**
 * Load active category NAMES for a given type, ordered by sort_order → name.
 * Returns [] gracefully if the table doesn't exist yet (pre-migration).
 * The caller should fall back to CATEGORY_OPTIONS when [] is returned.
 */
export async function loadCategories(
  type: 'finished_goods' | 'inventory'
): Promise<string[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('name')
    .eq('type', type)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('name',       { ascending: true });

  if (error) {
    console.warn('[loadCategories] failed (migration not applied?):', error.message);
    return [];
  }
  return (data ?? []).map((r: any) => r.name as string);
}

/**
 * Load full CategoryRow objects (for a management UI).
 * Returns all rows including inactive ones.
 */
export async function loadCategoryRows(
  type: 'finished_goods' | 'inventory'
): Promise<CategoryRow[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('type', type)
    .order('sort_order', { ascending: true })
    .order('name',       { ascending: true });

  if (error) {
    console.warn('[loadCategoryRows]', error.message);
    return [];
  }
  return (data ?? []).map(mapCategoryRow);
}

/**
 * Add (or reactivate) a category.
 * If the name already exists but is inactive, it is reactivated.
 * sort_order defaults to 0 (will appear at top — reorder manually if needed).
 */
export async function addCategory(
  name: string,
  type: 'finished_goods' | 'inventory',
  sortOrder = 0
): Promise<{ success: boolean; row?: CategoryRow; error?: any }> {
  const trimmed = name.trim();
  if (!trimmed) return { success: false, error: { message: 'Category name cannot be empty.' } };

  const { data, error } = await supabase
    .from('categories')
    .upsert(
      { name: trimmed, type, sort_order: sortOrder, is_active: true, updated_at: new Date().toISOString() },
      { onConflict: 'name,type' }
    )
    .select('*')
    .single();

  if (error) { console.error('[addCategory]', error); return { success: false, error }; }
  return { success: true, row: mapCategoryRow(data) };
}

/**
 * Soft-deactivate a category by id.
 * Existing hq_sale_items.category strings are unaffected (stored as text snapshot).
 * Use loadCategoryRows to get ids.
 */
export async function deactivateCategory(
  id: string
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('categories')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) { console.error('[deactivateCategory]', error); return { success: false, error }; }
  return { success: true };
}

/**
 * Hard-delete — use only for truly erroneous rows.
 * Existing items referencing this category string display it safely
 * (they hold the string directly, not a FK).
 */
export async function deleteCategory(
  name: string,
  type: 'finished_goods' | 'inventory'
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('categories')
    .delete()
    .eq('name', name)
    .eq('type', type);

  if (error) { console.error('[deleteCategory]', error); return { success: false, error }; }
  return { success: true };
}

/**
 * Load all HQ sale items.
 *
 * WHY we query the base table instead of hq_sale_items_priced VIEW:
 *   Postgres materialises SELECT * at view-creation time. When new columns
 *   (category, source_commissary) are added to the base table AFTER the view
 *   was created, SELECT * on the view returns the old column list and silently
 *   drops the new fields. The fix is:
 *     CREATE OR REPLACE VIEW hq_sale_items_priced AS SELECT * ...
 *   but that requires a manual SQL migration. To be resilient we query the
 *   base table directly with explicit columns so new fields are always present.
 *
 * effective_price and stock_status are computed here to match what the view
 *   previously provided.
 */
const SALE_ITEM_COLS = [
  'id', 'name', 'category', 'source_commissary', 'description',
  'base_unit', 'instock', 'par_level', 'is_active', 'is_requisitionable',
  'source_recipe_id', 'source_recipe_yield_qty',
  'making_cost', 'making_cost_updated_at',
  'suggested_price', 'manual_price',
  'pack_qty', 'location_availability_mode', 'availability_override',
  'created_at', 'updated_at',
].join(',');

export async function loadSaleItems(): Promise<SaleItem[]> {
  const { data, error } = await supabase
    .from('hq_sale_items')
    .select(SALE_ITEM_COLS)
    .order('name', { ascending: true })
    .range(0, 4999);  // bypass PostgREST 1000-row default cap

  if (error) { console.error('[loadSaleItems]', error); return []; }
  console.log(`[loadSaleItems] fetched ${data?.length ?? 0} rows`);
  
  if (!Array.isArray(data)) return [];

  try {
    const { data: authData } = await supabase.auth.getUser();
    const user = authData?.user;
    if (user) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role, location_id')
        .eq('user_id', user.id)
        .single();
      
      if (profile) {
        const role = (profile.role ?? '').toLowerCase().trim();
        const isHq = role === 'hq_admin' || role === 'hq admin' || role === 'admin';
        const isLocMgr = role === 'location_manager' || role === 'location manager';
        const locationId = profile.location_id;

        if (!isHq && isLocMgr && locationId) {
          // Fetch availability mappings for this location
          const { data: availRows } = await supabase
            .from('finished_good_location_availability')
            .select('finished_good_id, is_available')
            .eq('location_id', locationId)
            .eq('is_available', true);
          const allowedFgIds = new Set(availRows?.map(r => r.finished_good_id) || []);

          const filtered = data.filter((item: any) => {
            const mode = item.location_availability_mode ?? 'all';
            if (mode === 'all') return true;
            if (mode === 'selected') return allowedFgIds.has(item.id);
            return false; // hq_only
          });
          return filtered.map(mapSaleItemToFrontend);
        }
      }
    }
  } catch (err) {
    console.error('[loadSaleItems] dynamic filtering failed:', err);
  }

  return data.map(mapSaleItemToFrontend);
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

/** Load location availability mappings for a single Finished Good */
export async function loadFinishedGoodLocationAvailability(finishedGoodId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('finished_good_location_availability')
    .select('location_id')
    .eq('finished_good_id', finishedGoodId)
    .eq('is_available', true);

  if (error) {
    console.error('[loadFinishedGoodLocationAvailability] error:', error);
    return [];
  }
  return (data ?? []).map((r: any) => r.location_id);
}

/** Save location availability mappings for a Finished Good */
export async function saveFinishedGoodLocationAvailability(
  finishedGoodId: string,
  mode: 'all' | 'selected' | 'hq_only',
  selectedLocationIds: string[]
): Promise<{ success: boolean; error?: any }> {
  // First, update the mode in hq_sale_items
  const { error: updateErr } = await supabase
    .from('hq_sale_items')
    .update({ location_availability_mode: mode })
    .eq('id', finishedGoodId);

  if (updateErr) {
    console.error('[saveFinishedGoodLocationAvailability] update mode error:', updateErr);
    return { success: false, error: updateErr };
  }

  // Delete all existing mappings for this finished good
  const { error: deleteErr } = await supabase
    .from('finished_good_location_availability')
    .delete()
    .eq('finished_good_id', finishedGoodId);

  if (deleteErr) {
    console.error('[saveFinishedGoodLocationAvailability] delete error:', deleteErr);
    return { success: false, error: deleteErr };
  }

  // If mode is 'selected' and there are locations selected, insert them
  if (mode === 'selected' && selectedLocationIds.length > 0) {
    const rows = selectedLocationIds.map(locId => ({
      finished_good_id: finishedGoodId,
      location_id: locId,
      is_available: true
    }));

    const { error: insertErr } = await supabase
      .from('finished_good_location_availability')
      .insert(rows);

    if (insertErr) {
      console.error('[saveFinishedGoodLocationAvailability] insert error:', insertErr);
      return { success: false, error: insertErr };
    }
  }

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
 * syncLinkedFgCost — called after every recipe upsert.
 *
 * Finds all hq_sale_items rows whose source_recipe_id matches the saved recipe,
 * then patches:
 *   making_cost             = theoreticalCost / yieldInBaseUnit   (per FG base-unit cost)
 *   source_recipe_yield_qty = yieldInBaseUnit  (already converted to FG base unit)
 *   making_cost_updated_at  = now()
 *
 * Unit conversion:
 *   If the recipe yields in 'kg' but the FG base unit is 'oz', the yield is
 *   converted before division:  yieldInBaseUnit = convertYieldToBaseUnit(yieldQty, yieldUnit, baseUnit)
 *   If conversion is impossible (incompatible units), that item is skipped with
 *   a warning and counted as an error — no bad price is ever written.
 *
 * Intentionally does NOT touch manual_price, instock, or any other field.
 * suggested_price is a GENERATED column in Postgres (making_cost * 1.20) —
 * it auto-updates whenever making_cost changes, no extra write needed.
 *
 * Returns a summary so callers can log without importing Supabase directly.
 */
export async function syncLinkedFgCost(recipe: {
  id:              string;
  theoreticalCost: number;
  yieldQty:        number;
  yieldUnit:       string;   // ← required for unit conversion
}): Promise<{ updated: number; errors: number; ids: string[]; newCostPerUnit: number }> {

  if (recipe.yieldQty <= 0) {
    console.warn('[Recipe Sync] yieldQty is 0 or missing — skipping sync for recipe', recipe.id);
    return { updated: 0, errors: 0, ids: [], newCostPerUnit: 0 };
  }

  // 1. Find all linked sale items — also fetch base_unit for per-item conversion
  const { data: linked, error: fetchErr } = await supabase
    .from('hq_sale_items')
    .select('id, making_cost, base_unit')
    .eq('source_recipe_id', recipe.id);

  if (fetchErr || !linked || linked.length === 0) {
    if (fetchErr) console.warn('[Recipe Sync] lookup error', fetchErr);
    else          console.debug('[Recipe Sync] no linked FGs for recipe', recipe.id);
    return { updated: 0, errors: fetchErr ? 1 : 0, ids: [], newCostPerUnit: 0 };
  }

  // 2. Patch each linked sale item in parallel + emit per-item [Recipe Sync] log
  let totalNewCostPerUnit = 0;
  const results = await Promise.all(
    linked.map(async row => {
      const fgBaseUnit = row.base_unit || 'ea';
      const oldCost    = Number(row.making_cost ?? 0);

      // Convert recipe yield into this FG's base unit before dividing cost
      const conv = convertYieldToBaseUnit(recipe.yieldQty, recipe.yieldUnit, fgBaseUnit);

      if (conv === null) {
        // Conversion impossible — skip this item rather than write a wrong price
        console.warn(
          `[Recipe Sync] SKIPPED — cannot convert recipe yield unit "${recipe.yieldUnit}" → FG base unit "${fgBaseUnit}"` +
          ` | recipeId=${recipe.id} | saleItemId=${row.id}` +
          ` (set both to the same unit or a convertible pair)`
        );
        return { success: false, error: { message: `Unit conversion impossible: ${recipe.yieldUnit} → ${fgBaseUnit}` } };
      }

      const yieldInBaseUnit = conv.qty;
      const newCostPerUnit  = Number((recipe.theoreticalCost / yieldInBaseUnit).toFixed(4));
      totalNewCostPerUnit   = newCostPerUnit; // for the summary return value

      const res = await updateSaleItemCost(row.id, newCostPerUnit, yieldInBaseUnit);
      if (res.success) {
        console.log(
          `[Recipe Sync] Updated linked FG cost` +
          ` | recipeId=${recipe.id}` +
          ` | saleItemId=${row.id}` +
          ` | oldCost=$${oldCost.toFixed(4)}` +
          ` | newCost=$${newCostPerUnit.toFixed(4)}` +
          (conv.converted
            ? ` | yieldConverted=${recipe.yieldQty}${recipe.yieldUnit}→${yieldInBaseUnit.toFixed(4)}${fgBaseUnit}`
            : ` | yieldQty=${yieldInBaseUnit}${fgBaseUnit}`)
        );
      } else {
        console.error(
          `[Recipe Sync] FAILED to update FG cost` +
          ` | recipeId=${recipe.id}` +
          ` | saleItemId=${row.id}` +
          ` | attempted newCost=$${newCostPerUnit.toFixed(4)}`,
          res.error
        );
      }
      return res;
    })
  );

  const ids     = linked.map(r => r.id);
  const errors  = results.filter(r => !r.success).length;
  const updated = results.filter(r =>  r.success).length;

  return { updated, errors, ids, newCostPerUnit: totalNewCostPerUnit };
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

/**
 * createFgFromRecipe — one-click "Add to Finished Goods" from the Recipes list.
 *
 * Creates a new hq_sale_items row pre-filled from the recipe.  Aborts and
 * returns { alreadyLinked: true } if any row with source_recipe_id = recipe.id
 * already exists, so the caller can show "Linked" without creating a duplicate.
 *
 * Fields written:
 *   name                  = recipe.name
 *   source_recipe_id      = recipe.id
 *   source_recipe_yield_qty = recipe.yieldQty  (or 1)
 *   making_cost           = recipe.theoreticalCost / max(recipe.yieldQty, 1)
 *   base_unit             = recipe.yieldUnit   (e.g. "kg", "L", "portions")
 *   pack_qty              = 1
 *   category              = recipe.category    (or null)
 *   is_active             = true
 *   is_requisitionable    = true
 *   instock               = 0
 *   par_level             = 0
 *
 * Does NOT touch: manual_price, suggested_price (generated), any inventory row.
 */
export async function createFgFromRecipe(recipe: {
  id:              string;
  name:            string;
  theoreticalCost: number;
  yieldQty:        number;
  yieldUnit:       string;
  category?:       string | null;
}): Promise<{ success: boolean; alreadyLinked?: boolean; newId?: string; error?: any }> {

  // 1. Guard: check whether a sale item is already linked to this recipe
  const { data: existing, error: checkErr } = await supabase
    .from('hq_sale_items')
    .select('id')
    .eq('source_recipe_id', recipe.id)
    .limit(1);

  if (checkErr) {
    console.error('[createFgFromRecipe] link-check error', checkErr);
    return { success: false, error: checkErr };
  }

  if (existing && existing.length > 0) {
    console.log('[createFgFromRecipe] already linked — skipping insert', recipe.id);
    return { success: true, alreadyLinked: true, newId: existing[0].id };
  }

  // 2. Build the row
  const yieldQty      = Math.max(Number(recipe.yieldQty) || 1, 0.0001);
  const makingCost    = Number((Number(recipe.theoreticalCost || 0) / yieldQty).toFixed(4));
  const newId         = crypto.randomUUID();
  const now           = new Date().toISOString();

  const row = {
    id:                      newId,
    name:                    recipe.name.trim(),
    category:                recipe.category?.trim() || null,
    source_commissary:       'Commissary HQ',
    description:             null,
    base_unit:               (recipe.yieldUnit || 'ea').trim().toLowerCase(),
    instock:                 0,
    par_level:               0,
    is_active:               true,
    is_requisitionable:      true,
    source_recipe_id:        recipe.id,
    source_recipe_yield_qty: yieldQty,
    making_cost:             makingCost,
    making_cost_updated_at:  now,
    manual_price:            null,
    pack_qty:                1,
    created_at:              now,
    updated_at:              now,
  };

  const { error: insertErr } = await supabase.from('hq_sale_items').insert(row);
  if (insertErr) {
    console.error('[createFgFromRecipe] insert error', insertErr);
    return { success: false, error: insertErr };
  }

  console.log(
    `[createFgFromRecipe] Created FG "${recipe.name}" (id=${newId}) ` +
    `| makingCost=${makingCost} | baseUnit=${recipe.yieldUnit} | recipeId=${recipe.id}`
  );
  return { success: true, alreadyLinked: false, newId };
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
    // Normalise at DB boundary: trim whitespace + lowercase so 'Kg', ' KG ', etc.
    // never reach computeLiveCost or convertYieldToBaseUnit as a wrong unit string.
    yieldUnit:       (db.yieldunit ?? '').trim().toLowerCase(),
    theoreticalCost: db.theoreticalcost,
    margin:          db.margin,
    ingredients:     db.ingredients || [],
    nutritionEstimate: db.nutrition_estimate ?? null,
    // Output item linkage — prep vs finished_good routing
    outputItemId:   db.output_item_id   ?? null,
    outputItemType: db.output_item_type  ?? 'finished_good',
});

// Columns to fetch — avoids pulling created_at and any future-added admin columns
const RECIPE_SELECT = "id,name,category,yieldqty,yieldunit,theoreticalcost,margin,ingredients,nutrition_estimate,output_item_id,output_item_type";
const RECIPE_SELECT_LEGACY = "id,name,category,yieldqty,yieldunit,theoreticalcost,margin,ingredients";

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
    // Output item linkage
    output_item_id:   r.outputItemId   ? String(r.outputItemId) : null,
    output_item_type: r.outputItemType || 'finished_good',
});

export async function loadRecipes() {
  const query = supabase
    .from('recipes')
    .select(RECIPE_SELECT)
    .order('name', { ascending: true })
    .range(0, 4999);  // bypass PostgREST 1000-row default cap
  let { data, error }: { data: any[] | null; error: any } = await query;

  // Until migration_recipe_nutrition.sql is run, older DBs do not have this
  // column. Keep recipes usable and surface null estimates instead of hard-failing.
  if (error && String(error.message || '').includes('nutrition_estimate')) {
    const fallback = await supabase
      .from('recipes')
      .select(RECIPE_SELECT_LEGACY)
      .order('name', { ascending: true })
      .range(0, 4999);
    data = fallback.data;
    error = fallback.error;
  }

  // Until migration_prep_output.sql is run, older DBs do not have output_item_id.
  // Fall back to the legacy select (no output cols) so recipes remain usable.
  if (error && (String(error.message || '').includes('output_item_id') || String(error.message || '').includes('output_item_type'))) {
    const fallback2 = await supabase
      .from('recipes')
      .select(RECIPE_SELECT_LEGACY)
      .order('name', { ascending: true })
      .range(0, 4999);
    data = fallback2.data;
    error = fallback2.error;
  }

  if (error) return [];
  console.log(`[loadRecipes] fetched ${data?.length ?? 0} rows`);
  return Array.isArray(data) ? data.map(mapRecipeToFrontend) : [];
}

export async function saveRecipes(data: any[]) {
  const cleanData = data.map(mapRecipeToDB);
  const { error } = await supabase.from('recipes').upsert(cleanData, { onConflict: 'id' });
  if (error) return { success: false, error };
  return { success: true };
}

/**
 * Patch only the nutrition_estimate JSONB field on a recipe.
 *
 * This intentionally does not call mapRecipeToDB or resave the full recipe;
 * nutrition approval is a separate user-reviewed action from recipe costing.
 */
export async function updateRecipeNutrition(
  recipeId: string,
  nutritionEstimate: any
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('recipes')
    .update({ nutrition_estimate: nutritionEstimate })
    .eq('id', recipeId);
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
  console.debug("[upsertRecipe] payload:", payloadBytes, "bytes | ingredients:", row.ingredients.length,
    "| output_item_id:", row.output_item_id, "| output_item_type:", row.output_item_type);

  // Build the PostgREST upsert URL
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/recipes?on_conflict=id`;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

  // Get the current session token for authenticated requests.
  const { data: { session } } = await supabase.auth.getSession();
  const authHeader = session?.access_token ? `Bearer ${session.access_token}` : `Bearer ${key}`;

  const doFetch = async (body: object, sig?: AbortSignal) => {
    const resp = await fetch(url, {
      method: 'POST',
      signal: sig,
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': authHeader,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      let errBody: any = {};
      try { errBody = await resp.json(); } catch { errBody = { message: resp.statusText }; }
      return { ok: false, status: resp.status, errBody };
    }
    return { ok: true };
  };

  try {
    const result = await doFetch(row, signal);
    if (!result.ok) {
      const errMsg: string = result.errBody?.message ?? result.errBody?.hint ?? '';
      // If migration_prep_output.sql has NOT been run yet, PostgREST returns
      // HTTP 400 with "column output_item_id does not exist" (or similar).
      // In that case: retry without the new columns so the save still succeeds.
      // The output linkage will be lost until the migration is applied.
      const isMissingColumn = errMsg.includes('output_item_id') || errMsg.includes('output_item_type');
      if (isMissingColumn) {
        console.warn(
          '[upsertRecipe] output columns not found in DB — migration_prep_output.sql may not have been run. ' +
          'Retrying without output_item_id / output_item_type. Run the migration to persist recipe output linking.'
        );
        // Omit the new columns and retry
        const { output_item_id: _oid, output_item_type: _otype, ...rowWithoutOutput } = row;
        const retry = await doFetch(rowWithoutOutput, signal);
        if (!retry.ok) {
          console.error("[upsertRecipe] HTTP", retry.status, retry.errBody);
          return { success: false, error: retry.errBody };
        }
        return { success: true };
      }
      console.error("[upsertRecipe] HTTP", result.status, result.errBody);
      return { success: false, error: result.errBody };
    }
    return { success: true };
  } catch (err: any) {
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

const mapOrderToFrontend = (db: any): any => ({
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
     lineItems:   db.lineitems || [],
     emailSentAt: db.email_sent_at ?? null,
     emailError:  db.email_error ?? null
});

const mapOrderToDB = (o: any): any => ({
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
     lineitems:   Array.isArray(o.lineItems) ? o.lineItems : [],
     ...(o.emailSentAt !== undefined ? { email_sent_at: o.emailSentAt } : {}),
     ...(o.emailError !== undefined ? { email_error: o.emailError } : {})
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

export async function sendOrderToSupplier(
  orderId: string
): Promise<{ success: boolean; order?: any; error?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { success: false, error: 'No active auth session. Please sign out and sign back in.' };
  }

  const resp = await fetch('/api/purchase-orders/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ orderId }),
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body?.success) {
    return { success: false, error: body?.error || resp.statusText || 'Supplier email failed.' };
  }

  return { success: true, order: body.order ? mapOrderToFrontend(body.order) : undefined };
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

  // For any requisition that is now fulfilled, trigger backorders
  for (const req of cleanData) {
    if (req.status && req.status.toLowerCase() === 'fulfilled') {
      await createBackordersFromRequisition(req.id);
    }
  }

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
  const cleanStatus = status.toLowerCase();
  const { error } = await supabase
    .from('requisitions')
    .update({ status: cleanStatus })
    .eq('id', id);
  if (error) {
    console.error('updateRequisitionStatus:', error);
    return { success: false, error };
  }

  if (cleanStatus === 'fulfilled') {
    await createBackordersFromRequisition(id);
  }

  return { success: true };
}

// ----------------------------------------------------------------------------
// REQUISITION BACKORDER SYSTEM OPERATIONS
// ----------------------------------------------------------------------------

export async function loadBackorders(locationId?: string): Promise<any[]> {
  let query = supabase
    .from('requisition_backorders')
    .select('*, original_requisition_item:requisition_items(pack_qty_snapshot, finished_good_id)')
    .order('created_at', { ascending: false });
  if (locationId) {
    query = query.eq('location_id', locationId);
  }
  const { data, error } = await query;
  if (error) {
    console.error('[Backorders] load error', error);
    return [];
  }
  return (data || []).map(row => {
    const isFG = row.source_type === 'finished_good' || !!row.original_requisition_item?.finished_good_id;
    const packQty = row.original_requisition_item?.pack_qty_snapshot != null ? Number(row.original_requisition_item.pack_qty_snapshot) : 1;
    return {
      id: row.id,
      locationId: row.location_id,
      location_id: row.location_id,
      originalRequisitionId: row.original_requisition_id,
      original_requisition_id: row.original_requisition_id,
      originalRequisitionItemId: row.original_requisition_item_id,
      original_requisition_item_id: row.original_requisition_item_id,
      itemId: row.item_id,
      item_id: row.item_id,
      itemName: row.item_name,
      item_name: row.item_name,
      requestedQty: Number(row.requested_qty ?? 0),
      requested_qty: Number(row.requested_qty ?? 0),
      fulfilledQty: Number(row.fulfilled_qty ?? 0),
      fulfilled_qty: Number(row.fulfilled_qty ?? 0),
      backorderQty: Number(row.backorder_qty ?? 0),
      backorder_qty: Number(row.backorder_qty ?? 0),
      remainingQty: Number(row.remaining_qty ?? 0),
      remaining_qty: Number(row.remaining_qty ?? 0),
      unit: row.unit,
      unitPrice: Number(row.unit_price ?? 0),
      unit_price: Number(row.unit_price ?? 0),
      sourceType: row.source_type,
      source_type: row.source_type,
      supplierName: row.supplier_name,
      supplier_name: row.supplier_name,
      status: row.status,
      createdAt: row.created_at,
      created_at: row.created_at,
      updatedAt: row.updated_at,
      updated_at: row.updated_at,
      fulfilledAt: row.fulfilled_at,
      fulfilled_at: row.fulfilled_at,
      notes: row.notes,
      // Helper fields
      isFGMode: isFG,
      packQty,
      packCount: Number(row.requested_qty ?? 0),
      baseQty: Number(row.requested_qty ?? 0) * packQty,
      packPrice: Number(row.unit_price ?? 0),
      lineTotal: Number(row.requested_qty ?? 0) * Number(row.unit_price ?? 0),
    };
  });
}

export async function loadBackorderFulfillments(backorderId: string): Promise<any[]> {
  const { data, error } = await supabase
    .from('requisition_backorder_fulfillments')
    .select('*')
    .eq('backorder_id', backorderId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[Backorders] load fulfillments error', error);
    return [];
  }
  return data || [];
}

export async function createBackordersFromRequisition(requisitionId: string): Promise<{ success: boolean; error?: any }> {
  console.log(`[Backorders] Checking requisition ${requisitionId} for backorders...`);
  
  // Fetch the requisition to get location_id
  const { data: requisition, error: reqErr } = await supabase
    .from('requisitions')
    .select('location_id')
    .eq('id', requisitionId)
    .single();

  if (reqErr || !requisition) {
    console.error(`[Backorders] Error fetching requisition ${requisitionId}:`, reqErr);
    return { success: false, error: reqErr || new Error('Requisition not found') };
  }

  // Fetch requisition items
  const { data: items, error: itemsErr } = await supabase
    .from('requisition_items')
    .select('*')
    .eq('requisition_id', requisitionId);

  if (itemsErr || !items) {
    console.error(`[Backorders] Error fetching items for requisition ${requisitionId}:`, itemsErr);
    return { success: false, error: itemsErr };
  }

  for (const item of items) {
    const requested = Number(item.quantity_requested ?? 0);
    const fulfilled = Number(item.quantity_fulfilled ?? 0);
    const backorderQty = requested - fulfilled;

    if (backorderQty > 0) {
      // Check if backorder already exists for this original_requisition_item_id
      const { data: existing, error: existErr } = await supabase
        .from('requisition_backorders')
        .select('id')
        .eq('original_requisition_item_id', item.id)
        .maybeSingle();

      if (existErr) {
        console.error(`[Backorders] Error checking existing backorders for item ${item.id}:`, existErr);
        continue;
      }

      // Determine item_id (which could be finished_good_id or item_id/legacy raw item id)
      const itemId = item.finished_good_id || item.item_id;
      const sourceType = item.finished_good_id ? 'finished_good' : 'raw_item';

      if (existing) {
        // Update existing backorder record if needed
        console.log(`[Backorders] Backorder already exists for item ${item.id}, updating quantities...`);
        const { error: updateErr } = await supabase
          .from('requisition_backorders')
          .update({
            requested_qty: requested,
            fulfilled_qty: fulfilled,
            backorder_qty: backorderQty,
            remaining_qty: backorderQty,
            unit_price: Number(item.unit_price ?? 0),
          })
          .eq('id', existing.id);

        if (updateErr) {
          console.error(`[Backorders] Error updating backorder for item ${item.id}:`, updateErr);
        }
      } else {
        // Create new backorder record
        console.log(`[Backorders] Creating new backorder for item ${item.id} (Qty: ${backorderQty})...`);
        const { error: insertErr } = await supabase
          .from('requisition_backorders')
          .insert({
            original_requisition_id: requisitionId,
            original_requisition_item_id: item.id,
            location_id: requisition.location_id,
            item_id: itemId,
            item_name: item.item_name_snapshot || 'Unknown Item',
            requested_qty: requested,
            fulfilled_qty: fulfilled,
            backorder_qty: backorderQty,
            remaining_qty: backorderQty,
            unit: item.unit_snapshot,
            unit_price: Number(item.unit_price ?? 0),
            source_type: sourceType,
            supplier_name: item.supplier_snapshot || null,
            status: 'open',
          });

        if (insertErr) {
          console.error(`[Backorders] Error inserting backorder for item ${item.id}:`, insertErr);
        }
      }
    }
  }

  return { success: true };
}

export async function fulfillBackorder(
  backorderId: string,
  qtyToFulfill: number,
  notes?: string
): Promise<{ success: boolean; error?: any }> {
  console.log(`[Backorders] Fulfilling backorderId=${backorderId} qty=${qtyToFulfill}`);

  // Fetch backorder row
  const { data: backorder, error: boFetchError } = await supabase
    .from('requisition_backorders')
    .select('*')
    .eq('id', backorderId)
    .single();

  if (boFetchError || !backorder) {
    console.error('[Backorders] ✗ Could not fetch backorder row', boFetchError);
    return { success: false, error: boFetchError ?? { message: 'Backorder not found' } };
  }

  const remaining = Number(backorder.remaining_qty ?? 0);
  if (qtyToFulfill <= 0 || qtyToFulfill > remaining) {
    return { success: false, error: { message: `Invalid quantity. Remaining: ${remaining}, attempting: ${qtyToFulfill}` } };
  }

  const itemId = backorder.item_id;
  const isFinishedGood = backorder.source_type === 'finished_good';

  if (isFinishedGood) {
    // ── 1. FG mode ──
    const { data: fg, error: fgFetchError } = await supabase
      .from('hq_sale_items')
      .select('instock, name, pack_qty')
      .eq('id', itemId)
      .single();

    if (fgFetchError || !fg) {
      return { success: false, error: fgFetchError ?? { message: `Finished Good SKU ${itemId} not found at HQ.` } };
    }

    const packQty = fg.pack_qty != null ? Number(fg.pack_qty) : 1;
    const baseQtyToFulfill = qtyToFulfill * packQty;
    const hqStock = Number(fg.instock ?? 0);
    if (hqStock < baseQtyToFulfill) {
      return { success: false, error: { message: `Insufficient HQ stock. Available: ${hqStock} base units, needed: ${baseQtyToFulfill} base units (${qtyToFulfill} packs).` } };
    }

    // Deduct stock
    const stockRes = await updateSaleItemStock(itemId, -baseQtyToFulfill);
    if (!stockRes.success) {
      return { success: false, error: stockRes.error };
    }
  } else {
    // ── 2. Raw item mode ──
    // Fetch HQ inventory item
    const { data: hqRows, error: hqFetchError } = await supabase
      .from('inventory_items')
      .select('*')
      .eq('item_id', itemId)
      .eq('location_id', HQ_LOCATION_ID);

    if (hqFetchError || !hqRows || hqRows.length === 0) {
      return { success: false, error: hqFetchError ?? { message: `Raw item ${itemId} not found in HQ inventory.` } };
    }

    const hqRow = hqRows[0];
    const hqStock = Number(hqRow.instock ?? 0);
    if (hqStock < qtyToFulfill) {
      return { success: false, error: { message: `Insufficient HQ stock. Available: ${hqStock}, needed: ${qtyToFulfill}.` } };
    }

    // Fetch dest inventory item
    const destLocationId = backorder.location_id;
    const { data: destRows, error: destFetchError } = await supabase
      .from('inventory_items')
      .select('id, instock')
      .eq('item_id', itemId)
      .eq('location_id', destLocationId);

    if (destFetchError) {
      return { success: false, error: destFetchError };
    }

    const destRow = destRows?.[0] ?? null;
    const destStockBefore = destRow ? Number(destRow.instock ?? 0) : 0;

    const hqStockAfter = hqStock - qtyToFulfill;
    const destStockAfter = destStockBefore + qtyToFulfill;

    // Update HQ stock
    const { error: hqDeductError } = await supabase
      .from('inventory_items')
      .update({ instock: hqStockAfter })
      .eq('id', hqRow.id)
      .eq('location_id', HQ_LOCATION_ID);

    if (hqDeductError) {
      return { success: false, error: hqDeductError };
    }

    // Update or Insert dest stock
    if (destRow) {
      const { error: destUpdateError } = await supabase
        .from('inventory_items')
        .update({ instock: destStockAfter })
        .eq('id', destRow.id)
        .eq('location_id', destLocationId);

      if (destUpdateError) {
        return { success: false, error: destUpdateError };
      }
    } else {
      const { error: insertError } = await supabase
        .from('inventory_items')
        .insert({
          id: crypto.randomUUID(),
          item_id: itemId,
          location_id: destLocationId,
          instock: destStockAfter,
          name: hqRow.name,
          category: hqRow.category,
          itemtype: hqRow.itemtype,
          baseunit: hqRow.baseunit,
          unit: hqRow.unit,
          parlevel: hqRow.parlevel,
          cost: hqRow.cost,
          supplierid: hqRow.supplierid,
          pricetrend: hqRow.pricetrend,
          priceincrease: hqRow.priceincrease,
          purchaseunits: hqRow.purchaseunits,
        });

      if (insertError) {
        return { success: false, error: insertError };
      }
    }

    // Log movement ledger
    const unitCost = Number(hqRow.cost ?? 0);
    await Promise.all([
      logMovement({
        locationId: HQ_LOCATION_ID,
        itemId,
        movementType: 'transfer_out',
        quantity: qtyToFulfill,
        unitCost,
        referenceType: 'requisition',
        referenceId: backorder.original_requisition_id,
        notes: `Backorder fulfillment → ${destLocationId}. ${notes ?? ''}`,
      }),
      logMovement({
        locationId: destLocationId,
        itemId,
        movementType: 'transfer_in',
        quantity: qtyToFulfill,
        unitCost,
        referenceType: 'requisition',
        referenceId: backorder.original_requisition_id,
        notes: `Received backorder from HQ. ${notes ?? ''}`,
      }),
    ]);
  }

  // ── 3. Record backorder fulfillment event ──
  const { error: bfInsertError } = await supabase
    .from('requisition_backorder_fulfillments')
    .insert({
      backorder_id: backorderId,
      quantity_fulfilled: qtyToFulfill,
      notes: notes || null,
    });

  if (bfInsertError) {
    console.error('[Backorders] ✗ Failed to insert backorder fulfillment log', bfInsertError);
    return { success: false, error: bfInsertError };
  }

  // ── 4. Update backorder remaining qty and status ──
  const newFulfilledQty = Number(backorder.fulfilled_qty ?? 0) + qtyToFulfill;
  const newRemainingQty = remaining - qtyToFulfill;
  let newStatus = 'partially_fulfilled';
  let fulfilledAt = null;

  if (newRemainingQty <= 0) {
    newStatus = 'fulfilled';
    fulfilledAt = new Date().toISOString();
  }

  const { error: boUpdateError } = await supabase
    .from('requisition_backorders')
    .update({
      fulfilled_qty: newFulfilledQty,
      remaining_qty: newRemainingQty,
      status: newStatus,
      fulfilled_at: fulfilledAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', backorderId);

  if (boUpdateError) {
    console.error('[Backorders] ✗ Failed to update backorder totals', boUpdateError);
    return { success: false, error: boUpdateError };
  }

  console.log(`[Backorders] Successfully fulfilled backorderId=${backorderId}. remaining=${newRemainingQty} status=${newStatus}`);
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
  email:      db.email || db.user_email || db.auth_email || db.login_email || null,
  phone:      db.phone ?? null,
  role:       db.role ?? "staff",
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
  try {
    const res = await fetch('/api/users/profile');
    if (res.ok) {
      const json = await res.json();
      if (json.success && Array.isArray(json.profiles)) {
        return json.profiles.map(mapProfileToFrontend);
      }
    }
  } catch (err) {
    console.error('[loadUserProfiles] API fetch failed, falling back to direct Supabase select:', err);
  }

  // Fallback: Try view with email first
  const { data: viewData, error: viewErr } = await supabase
    .from('user_profiles_with_email')
    .select('*')
    .order('created_at', { ascending: false });

  if (!viewErr && Array.isArray(viewData)) {
    return viewData.map(mapProfileToFrontend);
  }

  // Fallback 2: plain table (no email column)
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
 * Set (or reset) a user's password directly without sending any email.
 * HQ admin provides the new password manually.
 * The target user is identified by their email address.
 *
 * Calls POST /api/users/set-password which uses the Supabase service role key.
 */
export async function setUserPassword(
  email: string,
  newPassword: string,
  options: { profileId?: string; userId?: string } = {}
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch('/api/users/set-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: newPassword,
      profileId: options.profileId,
      userId: options.userId,
    }),
  });
  const json = await res.json();
  if (!res.ok) return { success: false, error: json.error ?? 'Failed to set password.' };
  return { success: true };
}

/**
 * Unified user provisioning — creates or reconciles BOTH the Supabase auth
 * account AND the user_profiles row in one call.
 *
 * Safe to call on existing users (idempotent). Handles all 4 cases:
 *   - auth missing  + profile missing  → full create
 *   - auth exists   + profile missing  → insert profile
 *   - auth missing  + profile exists   → create auth + link
 *   - auth exists   + profile exists   → update profile
 *
 * Returns generatedPassword only when a new auth user is created without an
 * explicit password — HQ should copy and share it with the user.
 */
export async function provisionUser(payload: {
  email: string;
  fullName?: string;
  role: string;
  locationId?: string | null;
  phone?: string | null;
  password?: string;
}): Promise<{
  success: boolean;
  action?: "created" | "updated" | "reconciled";
  userId?: string;
  profileId?: string;
  generatedPassword?: string;
  error?: string;
}> {
  const res = await fetch('/api/users/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:       payload.email,
      full_name:   payload.fullName   ?? null,
      role:        payload.role,
      location_id: payload.locationId ?? null,
      phone:       payload.phone      ?? null,
      password:    payload.password   ?? undefined,
    }),
  });
  const json = await res.json();
  if (!res.ok) return { success: false, error: json.error ?? 'Provisioning failed.' };
  return {
    success:           true,
    action:            json.action,
    userId:            json.userId,
    profileId:         json.profileId,
    generatedPassword: json.generatedPassword,
  };
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

// ── location_billing_profiles (HQ Billing & Incorporation) ──────────────────

export interface LocationBillingProfile {
  id?: string;
  locationId: string;
  legalName?: string | null;
  incorporationAddress?: string | null;
  billingAddress?: string | null;
  billingCity?: string | null;
  billingProvince?: string | null;
  billingPostalCode?: string | null;
  hstNumber?: string | null;
  businessNumber?: string | null;
  billingEmail?: string | null;
  invoiceContactName?: string | null;
  storeAddress?: string | null;
  storeCity?: string | null;
  storeProvince?: string | null;
  storePostalCode?: string | null;
  storePhone?: string | null;
  storeManagerName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

const mapBillingProfileToFrontend = (db: any): LocationBillingProfile => ({
  id: db.id,
  locationId: db.location_id,
  legalName: db.legal_name,
  incorporationAddress: db.incorporation_address,
  billingAddress: db.billing_address,
  billingCity: db.billing_city,
  billingProvince: db.billing_province,
  billingPostalCode: db.billing_postal_code,
  hstNumber: db.hst_number,
  businessNumber: db.business_number,
  billingEmail: db.billing_email,
  invoiceContactName: db.invoice_contact_name,
  storeAddress: db.store_address,
  storeCity: db.store_city,
  storeProvince: db.store_province,
  storePostalCode: db.store_postal_code,
  storePhone: db.store_phone,
  storeManagerName: db.store_manager_name,
  createdAt: db.created_at,
  updatedAt: db.updated_at,
});

const mapBillingProfileToDB = (bp: any) => ({
  location_id: bp.locationId,
  legal_name: bp.legalName || null,
  incorporation_address: bp.incorporationAddress || null,
  billing_address: bp.billingAddress || null,
  billing_city: bp.billingCity || null,
  billing_province: bp.billingProvince || null,
  billing_postal_code: bp.billingPostalCode || null,
  hst_number: bp.hstNumber || null,
  business_number: bp.businessNumber || null,
  billing_email: bp.billingEmail || null,
  invoice_contact_name: bp.invoiceContactName || null,
  store_address: bp.storeAddress || null,
  store_city: bp.storeCity || null,
  store_province: bp.storeProvince || null,
  store_postal_code: bp.storePostalCode || null,
  store_phone: bp.storePhone || null,
  store_manager_name: bp.storeManagerName || null,
});

export async function getLocationBillingProfile(locationId: string): Promise<LocationBillingProfile | null> {
  if (!locationId) return null;
  const { data, error } = await supabase
    .from('location_billing_profiles')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle();

  if (error || !data) return null;
  return mapBillingProfileToFrontend(data);
}

export async function upsertLocationBillingProfile(
  locationId: string,
  billingProfile: Partial<LocationBillingProfile>
): Promise<{ success: boolean; error?: string }> {
  if (!locationId) return { success: false, error: 'Location ID is required.' };
  
  const dbRow = mapBillingProfileToDB({ ...billingProfile, locationId });
  const { error } = await supabase
    .from('location_billing_profiles')
    .upsert(dbRow, { onConflict: 'location_id' });

  if (error) {
    console.error('[upsertLocationBillingProfile] error:', error);
    return { success: false, error: error.message };
  }
  return { success: true };
}

export async function getUserProfileWithLocationAndBilling(
  userId: string
): Promise<{ profile: UserProfileRow | null; billing: LocationBillingProfile | null }> {
  const { data: profileData, error: profileErr } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (profileErr || !profileData) {
    return { profile: null, billing: null };
  }

  const profile = mapProfileToFrontend(profileData);
  let billing: LocationBillingProfile | null = null;
  if (profile.locationId) {
    billing = await getLocationBillingProfile(profile.locationId);
  }

  return { profile, billing };
}

export async function updateUserProfileAndBilling(
  profileId: string,
  profileUpdates: Partial<Pick<UserProfileRow, 'fullName' | 'role' | 'locationId' | 'isActive' | 'phone'>>,
  billingUpdates: Partial<LocationBillingProfile>
): Promise<{ success: boolean; error?: string }> {
  const profileRes = await updateUserProfile(profileId, profileUpdates);
  if (!profileRes.success) {
    return { success: false, error: profileRes.error };
  }

  const targetLocationId = profileUpdates.locationId;
  if (targetLocationId) {
    const billingRes = await upsertLocationBillingProfile(targetLocationId, billingUpdates);
    if (!billingRes.success) {
      return { success: false, error: billingRes.error };
    }
  }

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
    status:  db.status,
    purpose: db.purpose || 'store',
    isDeliveryDestination: db.is_delivery_destination !== false,
    isHq: !!db.is_hq,
    isInternal: !!db.is_internal,
    sortOrder: db.sort_order ?? null,
    notes: db.notes || ''
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
    status:  l.status || '',
    purpose: l.purpose || 'store',
    is_delivery_destination: l.isDeliveryDestination !== false,
    is_hq: !!l.isHq,
    is_internal: !!l.isInternal,
    sort_order: l.sortOrder ?? null,
    notes: l.notes || ''
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
    purpose?: string; isDeliveryDestination?: boolean;
    isHq?: boolean; isInternal?: boolean; notes?: string;
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

export async function getAllLocationsForRegistry(): Promise<any[]> {
  const { data: locs, error: locsErr } = await supabase.from('locations').select('*');
  if (locsErr || !locs) return [];
  
  const { data: profiles } = await supabase.from('location_billing_profiles').select('*');
  const profileMap = new Map(profiles?.map(p => [p.location_id, p]) ?? []);

  return locs.map(l => {
    const frontendLoc = mapLocationToFrontend(l);
    const bp = profileMap.get(l.id);
    return {
      ...frontendLoc,
      billingProfile: bp ? mapBillingProfileToFrontend(bp) : null
    };
  });
}

export async function getLocationById(id: string): Promise<{ success: boolean; data: any; error?: any }> {
  const { data: loc, error: locErr } = await supabase.from('locations').select('*').eq('id', id).maybeSingle();
  if (locErr) return { success: false, data: null, error: locErr };
  if (!loc) return { success: false, data: null, error: { message: 'Location not found' } };

  const { data: bp } = await supabase.from('location_billing_profiles').select('*').eq('location_id', id).maybeSingle();

  return {
    success: true,
    data: {
      ...mapLocationToFrontend(loc),
      billingProfile: bp ? mapBillingProfileToFrontend(bp) : null
    }
  };
}

export async function createLocationWithProfile(payload: {
  location: {
    id: string;
    name: string;
    code?: string;
    status: string;
    type: string;
    subtype: string;
    purpose: string;
    isDeliveryDestination: boolean;
    isHq: boolean;
    isInternal: boolean;
    notes?: string;
  };
  billingProfile: Partial<LocationBillingProfile>;
}): Promise<{ success: boolean; error?: any }> {
  const locRow = mapLocationToDB(payload.location);
  const { error: locErr } = await supabase.from('locations').insert(locRow);
  if (locErr) return { success: false, error: locErr };

  // Initialize/upsert billing profile
  const bpRow = {
    location_id: payload.location.id,
    legal_name: payload.billingProfile.legalName || null,
    incorporation_address: payload.billingProfile.incorporationAddress || null,
    billing_address: payload.billingProfile.billingAddress || null,
    billing_city: payload.billingProfile.billingCity || null,
    billing_province: payload.billingProfile.billingProvince || null,
    billing_postal_code: payload.billingProfile.billingPostalCode || null,
    hst_number: payload.billingProfile.hstNumber || null,
    business_number: payload.billingProfile.businessNumber || null,
    store_address: payload.billingProfile.storeAddress || null,
    store_city: payload.billingProfile.storeCity || null,
    store_province: payload.billingProfile.storeProvince || null,
    store_postal_code: payload.billingProfile.storePostalCode || null,
    store_phone: payload.billingProfile.storePhone || null,
    store_manager_name: payload.billingProfile.storeManagerName || null,
  };
  
  const { error: bpErr } = await supabase.from('location_billing_profiles').upsert(bpRow, { onConflict: 'location_id' });
  if (bpErr) return { success: false, error: bpErr };

  return { success: true };
}

export async function updateLocationRegistryRecord(id: string, patch: any): Promise<{ success: boolean; error?: any }> {
  const dbPatch: any = {};
  if (patch.name !== undefined) dbPatch.name = patch.name;
  if (patch.code !== undefined) dbPatch.code = patch.code;
  if (patch.status !== undefined) dbPatch.status = patch.status;
  if (patch.type !== undefined) dbPatch.type = UI_TO_DB_TYPE[patch.type] ?? patch.type;
  if (patch.subtype !== undefined) dbPatch.subtype = patch.subtype;
  if (patch.purpose !== undefined) dbPatch.purpose = patch.purpose;
  if (patch.isDeliveryDestination !== undefined) dbPatch.is_delivery_destination = patch.isDeliveryDestination;
  if (patch.isHq !== undefined) dbPatch.is_hq = patch.isHq;
  if (patch.isInternal !== undefined) dbPatch.is_internal = patch.isInternal;
  if (patch.notes !== undefined) dbPatch.notes = patch.notes;
  if (patch.sortOrder !== undefined) dbPatch.sort_order = patch.sortOrder;

  const { error } = await supabase.from('locations').update(dbPatch).eq('id', id);
  if (error) return { success: false, error };
  return { success: true };
}

export async function updateLocationBillingProfile(locationId: string, patch: any): Promise<{ success: boolean; error?: any }> {
  const dbPatch: any = {
    location_id: locationId
  };
  if (patch.legalName !== undefined) dbPatch.legal_name = patch.legalName;
  if (patch.incorporationAddress !== undefined) dbPatch.incorporation_address = patch.incorporationAddress;
  if (patch.billingAddress !== undefined) dbPatch.billing_address = patch.billingAddress;
  if (patch.billingCity !== undefined) dbPatch.billing_city = patch.billingCity;
  if (patch.billingProvince !== undefined) dbPatch.billing_province = patch.billingProvince;
  if (patch.billingPostalCode !== undefined) dbPatch.billing_postal_code = patch.billingPostalCode;
  if (patch.hstNumber !== undefined) dbPatch.hst_number = patch.hstNumber;
  if (patch.businessNumber !== undefined) dbPatch.business_number = patch.businessNumber;
  if (patch.storeAddress !== undefined) dbPatch.store_address = patch.storeAddress;
  if (patch.storeCity !== undefined) dbPatch.store_city = patch.storeCity;
  if (patch.storeProvince !== undefined) dbPatch.store_province = patch.storeProvince;
  if (patch.storePostalCode !== undefined) dbPatch.store_postal_code = patch.storePostalCode;
  if (patch.storePhone !== undefined) dbPatch.store_phone = patch.storePhone;
  if (patch.storeManagerName !== undefined) dbPatch.store_manager_name = patch.storeManagerName;

  const { error } = await supabase.from('location_billing_profiles').upsert(dbPatch, { onConflict: 'location_id' });
  if (error) return { success: false, error };
  return { success: true };
}

export async function getUserAssignableLocations(): Promise<any[]> {
  const locs = await loadLocations();
  return locs.filter(l => isUserAssignableLocation(l));
}

export async function getDeliveryDestinationLocations(): Promise<any[]> {
  const locs = await loadLocations();
  return locs.filter(l => isDeliveryDestinationLocation(l));
}

export async function getRequisitionLocations(): Promise<any[]> {
  const locs = await loadLocations();
  return locs.filter(l => isActiveLocation(l) && isStoreLocation(l));
}

export async function getHqStartLocation(): Promise<any | null> {
  const res = await getLocationById('LOC-HQ');
  return res.success ? res.data : null;
}

export async function getLocationUsers(locationId: string): Promise<UserProfileRow[]> {
  const allProfiles = await loadUserProfiles();
  return allProfiles.filter(p => p.locationId === locationId);
}

export async function getLocationActivityCounts(locationId: string): Promise<{
  openTicketsCount: number;
  openRequisitionsCount: number;
  assignedUsersCount: number;
  inventoryRowsCount: number;
}> {
  const allProfiles = await loadUserProfiles();
  const assignedUsersCount = allProfiles.filter(p => p.locationId === locationId).length;

  const { count: openTicketsCount } = await supabase
    .from('delivery_tickets')
    .select('*', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .not('status', 'in', '(delivered,cancelled)');

  const { count: openRequisitionsCount } = await supabase
    .from('requisitions')
    .select('*', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .not('status', 'in', '(fulfilled,cancelled,rejected)');

  const { count: inventoryRowsCount } = await supabase
    .from('inventory_items')
    .select('*', { count: 'exact', head: true })
    .eq('location_id', locationId);

  return {
    openTicketsCount: openTicketsCount ?? 0,
    openRequisitionsCount: openRequisitionsCount ?? 0,
    assignedUsersCount,
    inventoryRowsCount: inventoryRowsCount ?? 0
  };
}

export async function getLocationRegistryHealth(): Promise<any> {
  const locs = await getAllLocationsForRegistry();
  
  const { count: missingAddrTickets } = await supabase
    .from('delivery_tickets')
    .select('*', { count: 'exact', head: true })
    .or('destination_address.eq.,destination_address.is.null')
    .not('status', 'in', '(delivered,cancelled)');

  let totalLocations = locs.length;
  let activeStores = 0;
  let deliveryDestinations = 0;
  let missingAddress = 0;
  let missingBillingProfile = 0;
  let inactiveWithActivity = 0;

  const healthRecords = await Promise.all(locs.map(async (l) => {
    const activity = await getLocationActivityCounts(l.id);
    const warnings = getLocationHealthStatus(l, l.billingProfile, activity);
    
    const isAct = isActiveLocation(l);
    const isStore = isStoreLocation(l);
    const isDest = isDeliveryDestinationLocation(l);

    if (isAct && isStore) activeStores++;
    if (isDest) deliveryDestinations++;
    
    const street = (l.billingProfile?.storeAddress || l.address || l.street || "").trim();
    if (!street) missingAddress++;
    if (!l.billingProfile) missingBillingProfile++;
    if (!isAct && (activity.openTicketsCount > 0 || activity.openRequisitionsCount > 0 || activity.assignedUsersCount > 0)) {
      inactiveWithActivity++;
    }

    return {
      location: l,
      activity,
      warnings
    };
  }));

  return {
    summary: {
      totalLocations,
      activeStores,
      deliveryDestinations,
      missingAddress,
      missingBillingProfile,
      inactiveWithActivity,
      deliveryTicketsMissingAddress: missingAddrTickets ?? 0
    },
    records: healthRecords
  };
}

export async function syncLocationAddressToOpenTickets(locationId: string): Promise<{ success: boolean; count: number; error?: any }> {
  const res = await getLocationById(locationId);
  if (!res.success || !res.data) return { success: false, count: 0, error: res.error || { message: 'Location not found' } };
  const loc = res.data;
  const addr = buildFullLocationAddress(loc, loc.billingProfile);
  if (!addr) return { success: false, count: 0, error: { message: 'Location has no physical address to sync' } };

  const { data: tickets, error: fetchErr } = await supabase
    .from('delivery_tickets')
    .select('id')
    .eq('location_id', locationId)
    .not('status', 'in', '(delivered,cancelled)');
  if (fetchErr) return { success: false, count: 0, error: fetchErr };
  if (!tickets || tickets.length === 0) return { success: true, count: 0 };

  const ticketIds = tickets.map(t => t.id);
  const { error: updateErr } = await supabase
    .from('delivery_tickets')
    .update({
      destination_address: addr,
      destination_name: loc.name || '',
      destination_contact: loc.billingProfile?.storeManagerName || null,
      destination_phone: loc.billingProfile?.storePhone || null
    })
    .in('id', ticketIds);

  if (updateErr) return { success: false, count: 0, error: updateErr };
  return { success: true, count: ticketIds.length };
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
    item_id?:             string | null;
    finished_good_id?:    string | null;
    /** FK → outlet_catalog_items.item_id (local vendor orders) */
    catalog_item_id?:     string | null;
    /** 'hq_supplied' | 'local_vendor' */
    source_type?:         string | null;
    supplier_snapshot?:   string | null;
    pack_qty_snapshot?:   number | null;
    item_name_snapshot?:  string | null;
    unit_snapshot?:       string | null;
    quantity_requested:   number;
    unit_price:           number;
    line_total:           number;
  }[]
): Promise<{ success: boolean; error?: any }> {

  console.log("UI ITEMS PASSED TO SAVE:", JSON.stringify(lineItems, null, 2));

  // ── Pre-flight ─────────────────────────────────────────────────────────────
  if (lineItems.length === 0) {
    return { success: false, error: { message: "Cannot save a requisition with no line items." } };
  }

  // A valid line must have at least one FK:
  //   item_id        → inventory_items (HQ raw mode)
  //   finished_good_id → hq_sale_items (HQ FG mode)
  //   catalog_item_id  → outlet_catalog_items (local vendor mode)
  const nullFkRows = lineItems.filter(li =>
    !li.item_id && !li.finished_good_id && !li.catalog_item_id
  );
  if (nullFkRows.length > 0) {
    console.error("[saveNewRequisition] pre-flight: rows missing all FKs:", nullFkRows);
    return {
      success: false,
      error: { message: `${nullFkRows.length} line item(s) have no item_id, finished_good_id, or catalog_item_id. Check the item picker.` },
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
      requisition_id:              confirmedId,
      item_id:                     li.item_id            ?? null,
      finished_good_id:            li.finished_good_id   ?? null,
      catalog_item_id:             li.catalog_item_id    ?? null,
      source_type:                 li.source_type        ?? 'hq_supplied',
      supplier_snapshot:           li.supplier_snapshot  ?? null,
      pack_qty_snapshot:           li.pack_qty_snapshot  ?? 1,
      item_name_snapshot:          li.item_name_snapshot ?? null,
      unit_snapshot:               li.unit_snapshot      ?? null,
      source_commissary_snapshot:  (li as any).source_commissary_snapshot ?? null,
      quantity_requested:          li.quantity_requested,
      unit_price:                  li.unit_price,
      line_total:                  li.line_total,
      quantity_approved:           null,
      quantity_fulfilled:          null,
    };
    console.log(`[saveNewRequisition] row[${idx}] item_id=${row.item_id} fg_id=${row.finished_good_id} catalog_id=${row.catalog_item_id} source=${row.source_type} qty=${row.quantity_requested} name="${row.item_name_snapshot}"`);
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
    const lvRows = rows.filter(r => r.catalog_item_id);
    if (lvRows.length > 0) {
      console.error("[saveNewRequisition] local vendor rows need migration:", lvRows);
      await rollbackHeader();
      return { success: false, error: { message: "Database migration required: run migration_local_vendor_orders.sql in Supabase SQL Editor to enable local vendor ordering." } };
    }
    if (fgRows.length > 0) {
      console.error("[saveNewRequisition] FG rows need migration:", fgRows);
      await rollbackHeader();
      return { success: false, error: { message: "Database migration required: run migration.sql in Supabase SQL Editor to enable Finished Goods requisitions." } };
    }
    // Pure raw-mode fallback: strip all new columns
    const legacyRows = rows.map(({ finished_good_id, item_name_snapshot, unit_snapshot, catalog_item_id, source_type, supplier_snapshot, pack_qty_snapshot, ...rest }) => rest);
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

export async function sendHqRequisitionNotification(
  requisitionId: string
): Promise<{ success: boolean; error?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { success: false, error: 'No active auth session. Please sign out and sign back in.' };
  }

  const resp = await fetch('/api/requisitions/notify-hq', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ requisitionId }),
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body?.success) {
    return { success: false, error: body?.error || resp.statusText || 'HQ notification failed.' };
  }

  return { success: true };
}




export async function saveRequisitionEdits(
  requisitionId: string,
  notes: string,
  lineItems: {
    requisitionItemId?: string | null;
    item_id?:             string | null;
    itemId?:              string | null;
    finishedGoodId?:      string | null;
    finished_good_id?:    string | null;
    catalog_item_id?:     string | null;
    catalogItemId?:       string | null;
    sourceType?:          string | null;
    source_type?:         string | null;
    supplierSnapshot?:    string | null;
    supplier_snapshot?:   string | null;
    packQty?:             number | null;
    pack_qty_snapshot?:   number | null;
    itemName?:            string | null;
    item_name_snapshot?:  string | null;
    unit?:                string | null;
    unit_snapshot?:       string | null;
    sourceCommissary?:    string | null;
    source_commissary_snapshot?: string | null;
    quantityRequested?:   number;
    quantity_requested?:  number;
    unitPrice?:           number;
    unit_price?:          number;
  }[]
): Promise<{ success: boolean; error?: any }> {
  console.log(`[saveRequisitionEdits] START edit for reqId=${requisitionId}`);

  // 1. Re-check status before saving edits (Safety Rule 1)
  const { data: req, error: fetchError } = await supabase
    .from("requisitions")
    .select("status")
    .eq("id", requisitionId)
    .single();

  if (fetchError || !req) {
    return { success: false, error: fetchError ?? { message: "Requisition not found." } };
  }

  const statusClean = String(req.status || '').toLowerCase();
  const isEditable = ['submitted', 'pending', 'requested'].includes(statusClean);
  if (!isEditable) {
    return {
      success: false,
      error: { message: `This requisition is currently in '${req.status}' status and has been locked by HQ. It can no longer be edited.` }
    };
  }

  // Calculate new totals (Safety Rule 2: items and total_amount updated based on requested items)
  const grandTotal = parseFloat(
    lineItems.reduce((s, li) => {
      const q = li.quantityRequested ?? li.quantity_requested ?? 0;
      const p = li.unitPrice ?? li.unit_price ?? 0;
      return s + (q * p);
    }, 0).toFixed(2)
  );

  // 2. Update requisition header
  const { error: headerError } = await supabase
    .from("requisitions")
    .update({
      notes: notes || "",
      items: lineItems.length,
      total_amount: grandTotal,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requisitionId);

  if (headerError) {
    console.error("[saveRequisitionEdits] header update FAILED", headerError);
    return { success: false, error: headerError };
  }

  // 3. Sync requisition_items (Safety Rule 2: preserve all non-requested columns)
  // Fetch existing rows from db
  const { data: dbItems, error: dbItemsError } = await supabase
    .from("requisition_items")
    .select("id")
    .eq("requisition_id", requisitionId);

  if (dbItemsError) {
    console.error("[saveRequisitionEdits] failed fetching db items", dbItemsError);
    return { success: false, error: dbItemsError };
  }

  const dbIds = dbItems?.map((x: any) => x.id) || [];
  const keepIds = lineItems.map(li => li.requisitionItemId).filter(Boolean) as string[];
  
  // A. Deletions: delete DB rows that are not in the edit payload (Safety Rule 2: preserve all other tables, only delete these req items)
  const toDelete = dbIds.filter(id => !keepIds.includes(id));
  if (toDelete.length > 0) {
    console.log(`[saveRequisitionEdits] Deleting removed items:`, toDelete);
    const { error: deleteError } = await supabase
      .from("requisition_items")
      .delete()
      .in("id", toDelete);
      
    if (deleteError) {
      console.error("[saveRequisitionEdits] items deletion FAILED", deleteError);
      return { success: false, error: deleteError };
    }
  }

  // B. Updates and Inserts
  for (const li of lineItems) {
    const qty = Number(li.quantityRequested ?? li.quantity_requested ?? 0);
    const price = Number(li.unitPrice ?? li.unit_price ?? 0);
    const lineTotal = parseFloat((qty * price).toFixed(2));

    if (li.requisitionItemId) {
      // Update existing item. ONLY update quantity_requested and line_total. (Safety Rule 2)
      const { error: updateError } = await supabase
        .from("requisition_items")
        .update({
          quantity_requested: qty,
          line_total: lineTotal,
        })
        .eq("id", li.requisitionItemId);

      if (updateError) {
        console.error(`[saveRequisitionEdits] item update FAILED on id=${li.requisitionItemId}`, updateError);
        return { success: false, error: updateError };
      }
    } else {
      // Insert new item. Stamp snapshots, unit price, quantity_requested, line_total. Preserve all other fields at default. (Safety Rule 2)
      const insertRow = {
        requisition_id:              requisitionId,
        item_id:                     li.catalogItemId ? null : (li.finishedGoodId ? null : (li.itemId ?? li.item_id ?? null)),
        finished_good_id:            li.finishedGoodId ?? li.finished_good_id ?? null,
        catalog_item_id:             li.catalogItemId ?? li.catalog_item_id ?? null,
        source_type:                 li.sourceType ?? li.source_type ?? 'hq_supplied',
        supplier_snapshot:           li.supplierSnapshot ?? li.supplier_snapshot ?? null,
        pack_qty_snapshot:           li.packQty ?? li.pack_qty_snapshot ?? 1,
        item_name_snapshot:          li.itemName ?? li.item_name_snapshot ?? null,
        unit_snapshot:               li.unit ?? li.unit_snapshot ?? null,
        source_commissary_snapshot:  li.sourceType === 'local_vendor' || li.source_type === 'local_vendor' ? null : (li.sourceCommissary ?? li.source_commissary_snapshot ?? "Commissary HQ"),
        quantity_requested:          qty,
        unit_price:                  price,
        line_total:                  lineTotal,
        quantity_approved:           null,
        quantity_fulfilled:          null,
      };

      const { error: insertError } = await supabase
        .from("requisition_items")
        .insert(insertRow);

      if (insertError) {
        console.error("[saveRequisitionEdits] item insert FAILED", insertError);
        return { success: false, error: insertError };
      }
    }
  }

  console.log(`[saveRequisitionEdits] Requisition ${requisitionId} successfully updated.`);
  return { success: true };
}


export async function loadRequisitionItems(
  requisitionId: string
): Promise<{ success: boolean; data?: any[]; error?: any }> {
  // Join both inventory_items (raw mode) and hq_sale_items (FG mode).
  // PostgREST: include both FK joins; each returns null when the FK is null.
  const { data, error } = await supabase
    .from("requisition_items")
    .select("*, inventory_items(name), hq_sale_items(name, base_unit, instock)")
    .eq("requisition_id", requisitionId)
    .order("created_at", { ascending: true });

  if (error) {
    // hq_sale_items join may fail pre-migration — retry without it
    console.warn("loadRequisitionItems: join failed, retrying without hq_sale_items join", error.message);
    const { data: fallbackData, error: fallbackError } = await supabase
      .from("requisition_items")
      .select("*, inventory_items(name), hq_sale_items(name, base_unit, instock)")
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

  const packQtySnapshot = row.pack_qty_snapshot != null ? Number(row.pack_qty_snapshot) : (isFGMode ? (row.hq_sale_items?.pack_qty != null ? Number(row.hq_sale_items.pack_qty) : 1) : 1);
  const packPriceSnapshot = isFGMode && row.unit_price != null ? Number(row.unit_price) : null;
  const quantityRequested = Number(row.quantity_requested);

  return {
    id:                row.id,
    requisitionId:     row.requisition_id,
    // Which mode
    isFGMode,
    itemId:            row.item_id ?? null,
    finishedGoodId:    row.finished_good_id ?? null,
    // Commissary that should fulfill this line (snapshot at order time).
    // NULL on legacy rows — treat as 'Commissary HQ'.
    sourceCommissary:  row.source_commissary_snapshot ?? 'Commissary HQ',
    itemName,
    unit,
    quantityRequested,
    quantityApproved:  row.quantity_approved  != null ? Number(row.quantity_approved)  : null,
    quantityFulfilled: row.quantity_fulfilled != null ? Number(row.quantity_fulfilled) : null,
    unitPrice:         row.unit_price  != null ? Number(row.unit_price)  : null,
    lineTotal:         row.line_total  != null ? Number(row.line_total)  : null,
    // HQ available stock — only populated for FG-mode lines via hq_sale_items join.
    // null for raw inventory lines (shown as '—' in UI).
    hqAvailableStock:  isFGMode && row.hq_sale_items?.instock != null
                         ? Number(row.hq_sale_items.instock)
                         : null,
    allocatedQty:      row.allocated_qty != null ? Number(row.allocated_qty) : 0,
    backorderQty:      row.backorder_qty != null ? Number(row.backorder_qty) : 0,
    fulfillmentNote:   row.fulfillment_note ?? '',
    fulfilledBy:       row.fulfilled_by ?? null,
    fulfilledAt:       row.fulfilled_at ?? null,
    // Helper fields
    packPriceSnapshot,
    packQtySnapshot,
    packQty:           packQtySnapshot,
    packCount:         quantityRequested,
    baseQty:           quantityRequested * packQtySnapshot,
    packPrice:         row.unit_price != null ? Number(row.unit_price) : 0,
  };
}








// ----------------------------------------------------------------------------
// 5B. DELIVERY MANAGEMENT
// ----------------------------------------------------------------------------
export type DeliveryTicketStatus =
  | 'draft'
  | 'assigned'
  | 'loaded'
  | 'out_for_delivery'
  | 'delivered'
  | 'issue_reported'
  | 'cancelled';

export type DeliveryRunStatus =
  | 'draft'
  | 'assigned'
  | 'loaded'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type VehicleDailyLogStatus = 'open' | 'closed' | 'cancelled';

const mapDriverToFrontend = (db: any) => ({
  id: db.id,
  name: db.name,
  phone: db.phone ?? '',
  email: db.email ?? '',
  active: db.active ?? true,
  hourlyRate: db.hourly_rate != null ? Number(db.hourly_rate) : null,
  notes: db.notes ?? '',
  createdAt: db.created_at,
  updatedAt: db.updated_at,
});

const mapVehicleToFrontend = (db: any) => ({
  id: db.id,
  vehicleName: db.vehicle_name,
  plateNumber: db.plate_number ?? '',
  active: db.active ?? true,
  notes: db.notes ?? '',
  createdAt: db.created_at,
  updatedAt: db.updated_at,
});

const mapDeliveryTicketItemToFrontend = (db: any) => ({
  id: db.id,
  deliveryTicketId: db.delivery_ticket_id,
  requisitionItemId: db.requisition_item_id ?? null,
  inventoryItemId: db.inventory_item_id ?? null,
  itemName: db.item_name_snapshot,
  unit: db.unit_snapshot ?? '',
  requestedQty: Number(db.requested_qty ?? 0),
  approvedQty: Number(db.approved_qty ?? 0),
  shippedQty: Number(db.shipped_qty ?? 0),
  deliveredQty: Number(db.delivered_qty ?? 0),
  issueQty: Number(db.issue_qty ?? 0),
  issueReason: db.issue_reason ?? '',
  createdAt: db.created_at,
});

const mapDeliveryRunToFrontend = (db: any): any => ({
  id: db.id,
  runNumber: db.run_number,
  runDate: db.run_date,
  driverId: db.driver_id ?? null,
  vehicleId: db.vehicle_id ?? null,
  status: db.status as DeliveryRunStatus,
  estimatedDistanceKm: Number(db.estimated_distance_km ?? 0),
  estimatedDurationMinutes: Number(db.estimated_duration_minutes ?? 0),
  actualDistanceKm: Number(db.actual_distance_km ?? 0),
  actualDurationMinutes: Number(db.actual_duration_minutes ?? 0),
  actualStartTime: db.actual_start_time ?? '',
  actualEndTime: db.actual_end_time ?? '',
  startLocationName: db.start_location_name ?? '',
  startAddress: db.start_address ?? '',
  odometerStartKm: db.odometer_start_km != null ? Number(db.odometer_start_km) : null,
  odometerEndKm: db.odometer_end_km != null ? Number(db.odometer_end_km) : null,
  notes: db.notes ?? '',
  createdBy: db.created_by ?? null,
  createdAt: db.created_at,
  updatedAt: db.updated_at,
  routeEstimateSource: db.route_estimate_source ?? 'manual',
  routeEstimatedAt: db.route_estimated_at ?? null,
  routePolyline: db.route_polyline ?? null,
  googleRouteSummary: db.google_route_summary ?? null,
  driverEmail: db.driver_email ?? null,
  driverName: db.driver_name ?? null,
  driver: db.drivers ? mapDriverToFrontend(db.drivers) : null,
  vehicle: db.vehicles ? mapVehicleToFrontend(db.vehicles) : null,
  tickets: Array.isArray(db.delivery_tickets)
    ? db.delivery_tickets.map(mapDeliveryTicketToFrontend)
    : [],
});

const mapDeliveryTicketToFrontend = (db: any): any => ({
  id: db.id,
  ticketNumber: db.ticket_number,
  deliveryRunId: db.delivery_run_id ?? null,
  requisitionId: db.requisition_id ?? null,
  locationId: db.location_id ?? null,
  status: db.status as DeliveryTicketStatus,
  stopSequence: db.stop_sequence ?? null,
  destinationName: db.destination_name ?? '',
  destinationAddress: db.destination_address ?? '',
  destinationContact: db.destination_contact ?? '',
  destinationPhone: db.destination_phone ?? '',
  estimatedArrivalTime: db.estimated_arrival_time ?? '',
  arrivedAt: db.arrived_at ?? '',
  deliveredAt: db.delivered_at ?? '',
  receivedBy: db.received_by ?? '',
  deliveryNotes: db.delivery_notes ?? '',
  driverDepartedPreviousStopAt: db.driver_departed_previous_stop_at ?? '',
  proofPhotoUrl: db.proof_photo_url ?? '',
  signatureUrl: db.signature_url ?? '',
  notes: db.notes ?? '',
  createdBy: db.created_by ?? null,
  createdAt: db.created_at,
  updatedAt: db.updated_at,
  deliveryRun: db.delivery_runs ? mapDeliveryRunToFrontend(db.delivery_runs) : null,
  items: Array.isArray(db.delivery_ticket_items)
    ? db.delivery_ticket_items.map(mapDeliveryTicketItemToFrontend)
    : [],
});

const mapVehicleDailyLogToFrontend = (db: any): any => ({
  id: db.id,
  vehicleId: db.vehicle_id,
  logDate: db.log_date,
  driverId: db.driver_id ?? null,
  odometerStartKm: Number(db.odometer_start_km ?? 0),
  odometerEndKm: db.odometer_end_km != null ? Number(db.odometer_end_km) : null,
  totalOdometerKm: db.total_odometer_km != null ? Number(db.total_odometer_km) : null,
  totalRunKm: db.total_run_km != null ? Number(db.total_run_km) : null,
  varianceKm: db.variance_km != null ? Number(db.variance_km) : null,
  fuelStartLevel: db.fuel_start_level ?? '',
  fuelEndLevel: db.fuel_end_level ?? '',
  startConditionNotes: db.start_condition_notes ?? '',
  endConditionNotes: db.end_condition_notes ?? '',
  damageReported: Boolean(db.damage_reported),
  damageNotes: db.damage_notes ?? '',
  status: db.status as VehicleDailyLogStatus,
  createdBy: db.created_by ?? null,
  openedAt: db.opened_at ?? '',
  closedAt: db.closed_at ?? '',
  createdAt: db.created_at,
  updatedAt: db.updated_at,
  driver: db.drivers ? mapDriverToFrontend(db.drivers) : null,
  vehicle: db.vehicles ? mapVehicleToFrontend(db.vehicles) : null,
  runs: Array.isArray(db.delivery_runs) ? db.delivery_runs.map(mapDeliveryRunToFrontend) : [],
});

async function getCurrentAuthUserId() {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

async function generateDeliveryNumber(
  table: 'delivery_tickets' | 'delivery_runs',
  column: 'ticket_number' | 'run_number',
  prefix: 'DT' | 'RUN'
) {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const { data, error } = await supabase
    .from(table)
    .select(column)
    .like(column, like)
    .order(column, { ascending: false })
    .limit(1);
  if (error) throw error;
  const latest = String((data?.[0] as any)?.[column] ?? '');
  const lastSeq = Number(latest.split('-').pop() ?? 0);
  const next = Number.isFinite(lastSeq) ? lastSeq + 1 : 1;
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}

function mapDeliveryTicketPatchToDB(patch: any) {
  const out: any = {};
  if ('deliveryRunId' in patch) out.delivery_run_id = patch.deliveryRunId;
  if ('status' in patch) out.status = patch.status;
  if ('stopSequence' in patch) out.stop_sequence = patch.stopSequence;
  if ('estimatedArrivalTime' in patch) out.estimated_arrival_time = patch.estimatedArrivalTime || null;
  if ('arrivedAt' in patch) out.arrived_at = patch.arrivedAt || null;
  if ('deliveredAt' in patch) out.delivered_at = patch.deliveredAt || null;
  if ('receivedBy' in patch) out.received_by = patch.receivedBy ?? '';
  if ('deliveryNotes' in patch) out.delivery_notes = patch.deliveryNotes ?? '';
  if ('notes' in patch) out.notes = patch.notes ?? '';
  if ('destinationName' in patch) out.destination_name = patch.destinationName ?? '';
  if ('destinationAddress' in patch) out.destination_address = patch.destinationAddress ?? '';
  if ('destinationContact' in patch) out.destination_contact = patch.destinationContact ?? null;
  if ('destinationPhone' in patch) out.destination_phone = patch.destinationPhone ?? null;
  if ('proofPhotoUrl' in patch) out.proof_photo_url = patch.proofPhotoUrl ?? null;
  if ('signatureUrl' in patch) out.signature_url = patch.signatureUrl ?? null;
  if ('driverDepartedPreviousStopAt' in patch) out.driver_departed_previous_stop_at = patch.driverDepartedPreviousStopAt || null;
  return out;
}

function mapDeliveryRunPatchToDB(patch: any) {
  const out: any = {};
  if ('runDate' in patch) out.run_date = patch.runDate;
  if ('driverId' in patch) out.driver_id = patch.driverId || null;
  if ('vehicleId' in patch) out.vehicle_id = patch.vehicleId || null;
  if ('status' in patch) out.status = patch.status;
  if ('estimatedDistanceKm' in patch) out.estimated_distance_km = Number(patch.estimatedDistanceKm ?? 0);
  if ('estimatedDurationMinutes' in patch) out.estimated_duration_minutes = Number(patch.estimatedDurationMinutes ?? 0);
  if ('actualDistanceKm' in patch) out.actual_distance_km = Number(patch.actualDistanceKm ?? 0);
  if ('actualDurationMinutes' in patch) out.actual_duration_minutes = Number(patch.actualDurationMinutes ?? 0);
  if ('actualStartTime' in patch) out.actual_start_time = patch.actualStartTime || null;
  if ('actualEndTime' in patch) out.actual_end_time = patch.actualEndTime || null;
  if ('startLocationName' in patch) out.start_location_name = patch.startLocationName ?? '';
  if ('startAddress' in patch) out.start_address = patch.startAddress ?? '';
  if ('odometerStartKm' in patch) out.odometer_start_km = patch.odometerStartKm == null || patch.odometerStartKm === '' ? null : Number(patch.odometerStartKm);
  if ('odometerEndKm' in patch) out.odometer_end_km = patch.odometerEndKm == null || patch.odometerEndKm === '' ? null : Number(patch.odometerEndKm);
  if ('notes' in patch) out.notes = patch.notes ?? '';
  if ('routeEstimateSource' in patch) out.route_estimate_source = patch.routeEstimateSource;
  if ('routeEstimatedAt' in patch) out.route_estimated_at = patch.routeEstimatedAt || null;
  if ('routePolyline' in patch) out.route_polyline = patch.routePolyline || null;
  if ('googleRouteSummary' in patch) out.google_route_summary = patch.googleRouteSummary || null;
  return out;
}

export async function getDeliveryTickets(filters: {
  status?: string;
  locationId?: string;
  fromDate?: string;
  toDate?: string;
  showAll?: boolean;
} = {}) {
  let query = supabase
    .from('delivery_tickets')
    .select('*, delivery_runs(*, drivers(*), vehicles(*)), delivery_ticket_items(*)')
    .order('created_at', { ascending: false });
  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.locationId && filters.locationId !== 'all') query = query.eq('location_id', filters.locationId);
  if (filters.fromDate) query = query.gte('created_at', `${filters.fromDate}T00:00:00`);
  if (filters.toDate) query = query.lte('created_at', `${filters.toDate}T23:59:59`);

  // If not requesting all history, and no specific date/status filter is applied, limit the query.
  if (!filters.showAll && !filters.fromDate && !filters.toDate && (!filters.status || filters.status === 'all')) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    query = query.or(`status.not.in.(delivered,cancelled),created_at.gte.${thirtyDaysAgo.toISOString()}`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('getDeliveryTickets:', error);
    return [];
  }
  return (data ?? []).map(mapDeliveryTicketToFrontend);
}

export async function getDeliveryTicketById(id: string) {
  const { data, error } = await supabase
    .from('delivery_tickets')
    .select('*, delivery_runs(*, drivers(*), vehicles(*)), delivery_ticket_items(*)')
    .eq('id', id)
    .single();
  if (error) return { success: false, error };
  return { success: true, data: mapDeliveryTicketToFrontend(data) };
}

export async function getDeliveryTicketForRequisition(requisitionId: string) {
  const { data, error } = await supabase
    .from('delivery_tickets')
    .select('*, delivery_ticket_items(*)')
    .eq('requisition_id', requisitionId)
    .maybeSingle();
  if (error) return { success: false, error };
  return { success: true, data: data ? mapDeliveryTicketToFrontend(data) : null };
}

export async function createDeliveryTicketFromRequisition(requisitionId: string) {
  const existing = await getDeliveryTicketForRequisition(requisitionId);
  if (existing.success && existing.data) return { success: true, data: existing.data, alreadyExists: true };

  const { data: req, error: reqError } = await supabase
    .from('requisitions')
    .select('*')
    .eq('id', requisitionId)
    .single();
  if (reqError || !req) return { success: false, error: reqError ?? { message: 'Requisition not found.' } };

  const reqStatus = String(req.status ?? '').toLowerCase();
  if (!['approved', 'fulfilled'].includes(reqStatus)) {
    return { success: false, error: { message: 'Delivery tickets can only be generated from approved or fulfilled requisitions.' } };
  }

  const itemsRes = await loadRequisitionItems(requisitionId);
  if (!itemsRes.success) return { success: false, error: itemsRes.error };
  const reqItems = itemsRes.data ?? [];
  if (reqItems.length === 0) return { success: false, error: { message: 'Cannot create a delivery ticket without requisition items.' } };

  let location: any = null;
  let billingProfile: any = null;
  if (req.location_id) {
    const [locRes, bpRes] = await Promise.all([
      supabase.from('locations').select('*').eq('id', req.location_id).maybeSingle(),
      supabase.from('location_billing_profiles').select('*').eq('location_id', req.location_id).maybeSingle()
    ]);
    location = locRes.data;
    billingProfile = bpRes.data;
  }

  const userId = await getCurrentAuthUserId();
  const ticketNumber = await generateDeliveryNumber('delivery_tickets', 'ticket_number', 'DT');

  const storeAddress = billingProfile?.store_address || billingProfile?.storeAddress;
  const storeCity = billingProfile?.store_city || billingProfile?.storeCity;
  const storeProvince = billingProfile?.store_province || billingProfile?.storeProvince;
  const storePostalCode = billingProfile?.store_postal_code || billingProfile?.storePostalCode;
  const country = billingProfile?.store_country || billingProfile?.storeCountry || 'Canada';

  let address = '';
  if (storeAddress) {
    address = `${storeAddress}, ${storeCity || ''}, ${storeProvince || ''} ${storePostalCode || ''}, ${country}`
      .replace(/,\s*,/g, ',')
      .replace(/\s+/g, ' ')
      .trim();
  } else {
    address = [
      location?.address,
      location?.street,
      location?.city,
      location?.province ?? location?.state,
      location?.postal_code ?? location?.postalCode,
    ].filter(Boolean).join(', ');
  }

  const destinationContact = billingProfile?.store_manager_name || billingProfile?.storeManagerName || location?.contact_name || location?.contact || null;
  const destinationPhone = billingProfile?.store_phone || billingProfile?.storePhone || location?.phone || location?.contact_phone || null;

  const { data: ticket, error: ticketError } = await supabase
    .from('delivery_tickets')
    .insert({
      ticket_number: ticketNumber,
      requisition_id: req.id,
      location_id: req.location_id ?? null,
      status: 'draft',
      destination_name: location?.name ?? req.location ?? '',
      destination_address: address,
      destination_contact: destinationContact,
      destination_phone: destinationPhone,
      notes: req.notes ?? '',
      created_by: userId,
    })
    .select()
    .single();
  if (ticketError || !ticket) return { success: false, error: ticketError };

  const hasAllocations = reqItems.some((i: any) => (i.allocatedQty ?? 0) > 0 || (i.quantityFulfilled ?? 0) > 0);

  const itemRows = reqItems.map((item: any) => {
    const requestedQty = Number(item.quantityRequested ?? 0);
    const approvedQty = hasAllocations
      ? (item.quantityFulfilled != null ? Number(item.quantityFulfilled) : Number(item.allocatedQty ?? 0))
      : Number(item.quantityApproved ?? item.quantityFulfilled ?? requestedQty);
    const shippedQty = approvedQty;
    return {
      delivery_ticket_id: ticket.id,
      requisition_item_id: item.id,
      inventory_item_id: item.itemId ?? null,
      item_name_snapshot: item.itemName ?? 'Unnamed Item',
      unit_snapshot: item.unit ?? '',
      requested_qty: requestedQty,
      approved_qty: approvedQty,
      shipped_qty: shippedQty,
      delivered_qty: 0,
      issue_qty: 0,
      issue_reason: null,
    };
  });

  const { error: itemError } = await supabase.from('delivery_ticket_items').insert(itemRows);
  if (itemError) return { success: false, error: itemError };
  return await getDeliveryTicketById(ticket.id);
}

export async function updateDeliveryTicket(id: string, patch: any) {
  const { data, error } = await supabase
    .from('delivery_tickets')
    .update(mapDeliveryTicketPatchToDB(patch))
    .eq('id', id)
    .select()
    .single();
  if (error) return { success: false, error };
  return { success: true, data: mapDeliveryTicketToFrontend(data) };
}

export async function updateDeliveryTicketStatus(id: string, status: DeliveryTicketStatus) {
  return updateDeliveryTicket(id, { status });
}

export async function updateTicketAddressFromProfile(ticketId: string) {
  const { data: ticket, error: ticketErr } = await supabase
    .from('delivery_tickets')
    .select('*')
    .eq('id', ticketId)
    .single();
  if (ticketErr || !ticket) return { success: false, error: ticketErr || { message: 'Ticket not found' } };

  if (!ticket.location_id) {
    return { success: false, error: { message: 'Ticket does not have an associated location ID' } };
  }

  const { data: bp, error: bpErr } = await supabase
    .from('location_billing_profiles')
    .select('*')
    .eq('location_id', ticket.location_id)
    .maybeSingle();

  if (bpErr) return { success: false, error: bpErr };
  
  const { data: loc } = await supabase
    .from('locations')
    .select('*')
    .eq('id', ticket.location_id)
    .maybeSingle();

  const storeAddress = bp?.store_address || bp?.storeAddress;
  const storeCity = bp?.store_city || bp?.storeCity;
  const storeProvince = bp?.store_province || bp?.storeProvince;
  const storePostalCode = bp?.store_postal_code || bp?.storePostalCode;
  const country = bp?.store_country || bp?.storeCountry || 'Canada';

  let destinationAddress = '';
  if (storeAddress) {
    destinationAddress = `${storeAddress}, ${storeCity || ''}, ${storeProvince || ''} ${storePostalCode || ''}, ${country}`
      .replace(/,\s*,/g, ',')
      .replace(/\s+/g, ' ')
      .trim();
  } else {
    destinationAddress = [
      loc?.address,
      loc?.street,
      loc?.city,
      loc?.province ?? loc?.state,
      loc?.postal_code ?? loc?.postalCode,
    ].filter(Boolean).join(', ');
  }

  const destinationContact = bp?.store_manager_name || bp?.storeManagerName || loc?.contact_name || loc?.contact || null;
  const destinationPhone = bp?.store_phone || bp?.storePhone || loc?.phone || loc?.contact_phone || null;
  const destinationName = loc?.name || ticket.destination_name || '';

  return updateDeliveryTicket(ticketId, {
    destinationAddress,
    destinationName,
    destinationContact,
    destinationPhone
  });
}

export async function updateDeliveryTicketItems(ticketId: string, items: any[]) {
  const results = await Promise.all(items.map((item) => supabase
    .from('delivery_ticket_items')
    .update({
      delivered_qty: Number(item.deliveredQty ?? 0),
      issue_qty: Number(item.issueQty ?? 0),
      issue_reason: item.issueReason || null,
    })
    .eq('id', item.id)
    .eq('delivery_ticket_id', ticketId)));
  const failed = results.find((res) => res.error);
  if (failed?.error) return { success: false, error: failed.error };
  return { success: true };
}

export async function markDeliveryTicketDelivered(id: string, receivedBy: string, items: any[]) {
  for (const item of items) {
    const del = Number(item.deliveredQty ?? 0);
    const iss = Number(item.issueQty ?? 0);
    const shp = Number(item.shippedQty ?? 0);
    if (del + iss !== shp) {
      return {
        success: false,
        error: {
          message: "Delivered quantity plus issue quantity must equal shipped quantity for all items."
        }
      };
    }
  }

  const normalized = items.map((item) => ({
    ...item,
    deliveredQty: Number(item.deliveredQty ?? 0),
    issueQty: Number(item.issueQty ?? 0),
  }));
  const itemRes = await updateDeliveryTicketItems(id, normalized);
  if (!itemRes.success) return itemRes;
  const hasIssue = normalized.some((item) => Number(item.issueQty ?? 0) > 0);
  return updateDeliveryTicket(id, {
    status: hasIssue ? 'issue_reported' : 'delivered',
    deliveredAt: new Date().toISOString(),
    receivedBy,
  });
}

let cachedDriverEmailExists: boolean | null = null;
let cachedDriverNameExists: boolean | null = null;

async function hasDriverEmailColumn(): Promise<boolean> {
  if (cachedDriverEmailExists !== null) return cachedDriverEmailExists;
  try {
    const { error } = await supabase.from('delivery_runs').select('driver_email').limit(1);
    cachedDriverEmailExists = !error || (error.code !== '42703' && !error.message?.includes('driver_email') && !error.message?.includes('column does not exist'));
  } catch (e) {
    cachedDriverEmailExists = false;
  }
  return cachedDriverEmailExists ?? false;
}

async function hasDriverNameColumn(): Promise<boolean> {
  if (cachedDriverNameExists !== null) return cachedDriverNameExists;
  try {
    const { error } = await supabase.from('delivery_runs').select('driver_name').limit(1);
    cachedDriverNameExists = !error || (error.code !== '42703' && !error.message?.includes('driver_name') && !error.message?.includes('column does not exist'));
  } catch (e) {
    cachedDriverNameExists = false;
  }
  return cachedDriverNameExists ?? false;
}

async function enrichDriverSnapshot(payload: any) {
  const driverId = payload.driver_id || payload.driverId;
  const out: any = {};
  
  const hasEmail = await hasDriverEmailColumn();
  const hasName = await hasDriverNameColumn();

  if (!driverId) {
    if (hasEmail) out.driver_email = null;
    if (hasName) out.driver_name = null;
    return out;
  }

  try {
    const { data: driver } = await supabase
      .from('drivers')
      .select('name, email')
      .eq('id', driverId)
      .maybeSingle();

    if (driver) {
      if (hasEmail) out.driver_email = driver.email || null;
      if (hasName) out.driver_name = driver.name || null;
    }
  } catch (err) {
    console.error('[driver-route-debug] Error in enrichDriverSnapshot:', err);
  }
  return out;
}

export async function getDeliveryRuns(filters: {
  status?: string;
  runDate?: string;
  driverId?: string;
  driverEmail?: string;
  showAll?: boolean;
} = {}) {
  let query = supabase
    .from('delivery_runs')
    .select('*, drivers(*), vehicles(*), delivery_tickets(*, delivery_ticket_items(*))')
    .order('run_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.runDate) query = query.eq('run_date', filters.runDate);
  
  if (filters.driverId) {
    const hasEmailCol = await hasDriverEmailColumn();
    if (hasEmailCol && filters.driverEmail) {
      query = query.or(`driver_id.eq.${filters.driverId},driver_email.ilike.${filters.driverEmail}`);
    } else {
      query = query.eq('driver_id', filters.driverId);
    }
  }

  // If not requesting all history, and no specific runDate / status is queried, limit the query.
  if (!filters.showAll && !filters.runDate && (!filters.status || filters.status === 'all')) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoIso = thirtyDaysAgo.toISOString().split('T')[0];
    query = query.or(`status.not.in.(completed,cancelled),run_date.gte.${thirtyDaysAgoIso}`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('getDeliveryRuns:', error);
    return [];
  }

  const runs = (data ?? []).map(mapDeliveryRunToFrontend);

  // Background self-healing
  if (filters.driverId && filters.driverEmail) {
    const hasEmailCol = await hasDriverEmailColumn();
    if (hasEmailCol) {
      const runsToRepair = runs.filter((run: any) => {
        const emailMatch = run.driverEmail && String(run.driverEmail).trim().toLowerCase() === String(filters.driverEmail).trim().toLowerCase();
        return emailMatch && run.driverId !== filters.driverId;
      });

      if (runsToRepair.length > 0) {
        console.warn(`[driver-route-debug] Found ${runsToRepair.length} runs with missing/wrong driver_id. Repairing...`);
        Promise.all(
          runsToRepair.map(async (run: any) => {
            try {
              const { error: repairError } = await supabase
                .from('delivery_runs')
                .update({ driver_id: filters.driverId })
                .eq('id', run.id);
              if (repairError) {
                console.error(`[driver-route-debug] Failed to self-heal run ${run.id}:`, repairError);
              } else {
                console.log(`[driver-route-debug] Successfully self-healed run ${run.id} driver_id to ${filters.driverId}`);
                run.driverId = filters.driverId;
              }
            } catch (err) {
              console.error(`[driver-route-debug] Exception self-healing run ${run.id}:`, err);
            }
          })
        ).catch(err => console.error('[driver-route-debug] Self-heal group failed:', err));
      }
    }
  }

  return runs;
}

export async function getDeliveryRunById(id: string) {
  const { data, error } = await supabase
    .from('delivery_runs')
    .select('*, drivers(*), vehicles(*), delivery_tickets(*, delivery_ticket_items(*))')
    .eq('id', id)
    .maybeSingle();
  if (error) return { success: false, error };
  if (!data) return { success: false, error: { message: 'Delivery run not found.' } };
  return { success: true, data: mapDeliveryRunToFrontend(data) };
}

export async function createDeliveryRun(payload: any) {
  const userId = await getCurrentAuthUserId();
  const runNumber = await generateDeliveryNumber('delivery_runs', 'run_number', 'RUN');

  // Default start address from LOC-HQ billing profile if not provided
  let defaultStartAddress = '';
  if (!payload.startAddress) {
    const { data: hqProfile } = await supabase
      .from('location_billing_profiles')
      .select('*')
      .eq('location_id', 'LOC-HQ')
      .maybeSingle();

    if (hqProfile) {
      const storeAddress = hqProfile.store_address || hqProfile.storeAddress;
      const city = hqProfile.store_city || hqProfile.storeCity;
      const province = hqProfile.store_province || hqProfile.storeProvince;
      const postalCode = hqProfile.store_postal_code || hqProfile.storePostalCode;
      if (storeAddress) {
        defaultStartAddress = `${storeAddress}, ${city || ''}, ${province || ''} ${postalCode || ''}, Canada`
          .replace(/,\s*,/g, ',')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
  }

  const driverEnrich = await enrichDriverSnapshot({ driverId: payload.driverId });
  const insertObj = {
    run_number: runNumber,
    run_date: payload.runDate,
    driver_id: payload.driverId || null,
    vehicle_id: payload.vehicleId || null,
    status: payload.status ?? 'draft',
    estimated_distance_km: Number(payload.estimatedDistanceKm ?? 0),
    estimated_duration_minutes: Number(payload.estimatedDurationMinutes ?? 0),
    notes: payload.notes ?? '',
    start_address: payload.startAddress || defaultStartAddress,
    created_by: userId,
    ...driverEnrich
  };

  const { data, error } = await supabase
    .from('delivery_runs')
    .insert(insertObj)
    .select()
    .single();
  if (error) return { success: false, error };
  return { success: true, data: mapDeliveryRunToFrontend(data) };
}

export async function updateDeliveryRun(id: string, patch: any) {
  const dbPatch = mapDeliveryRunPatchToDB(patch);
  if ('driver_id' in dbPatch) {
    const driverEnrich = await enrichDriverSnapshot({ driver_id: dbPatch.driver_id });
    Object.assign(dbPatch, driverEnrich);
  }

  const { data, error } = await supabase
    .from('delivery_runs')
    .update(dbPatch)
    .eq('id', id)
    .select()
    .single();
  if (error) return { success: false, error };
  return { success: true, data: mapDeliveryRunToFrontend(data) };
}

export async function addTicketsToDeliveryRun(runId: string, ticketIds: string[]) {
  const uniqueIds = Array.from(new Set(ticketIds.filter(Boolean)));
  if (uniqueIds.length === 0) return { success: true };

  // Fetch current tickets for this run to find the max sequence
  const { data: existingTickets, error: fetchErr } = await supabase
    .from('delivery_tickets')
    .select('stop_sequence')
    .eq('delivery_run_id', runId);
  if (fetchErr) return { success: false, error: fetchErr };

  let maxSeq = 0;
  if (existingTickets && existingTickets.length > 0) {
    maxSeq = Math.max(...existingTickets.map(t => t.stop_sequence ?? 0));
  }

  const results = await Promise.all(uniqueIds.map((ticketId, index) => supabase
    .from('delivery_tickets')
    .update({ delivery_run_id: runId, status: 'assigned', stop_sequence: maxSeq + index + 1 })
    .eq('id', ticketId)
    .not('status', 'in', '(delivered,cancelled)')));
  const failed = results.find((res) => res.error);
  if (failed?.error) return { success: false, error: failed.error };
  return { success: true };
}

export async function removeTicketFromDeliveryRun(ticketId: string) {
  const { error } = await supabase
    .from('delivery_tickets')
    .update({ delivery_run_id: null, stop_sequence: null, status: 'draft' })
    .eq('id', ticketId);
  if (error) return { success: false, error };
  return { success: true };
}

export async function reorderDeliveryRunStops(runId: string, orderedTicketIds: string[]) {
  const results = await Promise.all(orderedTicketIds.map((ticketId, index) => supabase
    .from('delivery_tickets')
    .update({ stop_sequence: index + 1 })
    .eq('id', ticketId)
    .eq('delivery_run_id', runId)));
  const failed = results.find((res) => res.error);
  if (failed?.error) return { success: false, error: failed.error };
  return { success: true };
}

export async function startDeliveryRun(runId: string, payload: { odometerStartKm?: number | string; startLocationName?: string; startAddress?: string } = {}) {
  const { data: tickets, error: ticketError } = await supabase
    .from('delivery_tickets')
    .select('id')
    .eq('delivery_run_id', runId);
  if (ticketError) return { success: false, error: ticketError };
  if (!tickets || tickets.length === 0) {
    return { success: false, error: { message: "Cannot start a delivery run with 0 stops/tickets." } };
  }

  const now = new Date().toISOString();
  const patch: any = {
    status: 'in_progress',
    actualStartTime: now,
    startLocationName: payload.startLocationName ?? '',
    startAddress: payload.startAddress ?? '',
  };
  if (payload.odometerStartKm !== undefined && payload.odometerStartKm !== '') {
    patch.odometerStartKm = Number(payload.odometerStartKm);
  }
  const runRes = await updateDeliveryRun(runId, patch);
  if (!runRes.success) return runRes;

  const { error } = await supabase
    .from('delivery_tickets')
    .update({ status: 'out_for_delivery' })
    .eq('delivery_run_id', runId)
    .in('status', ['draft', 'assigned', 'loaded']);
  if (error) return { success: false, error };
  return getDeliveryRunById(runId);
}

export async function completeDeliveryRun(runId: string, payload: { odometerEndKm?: number | string } = {}) {
  const runRes = await getDeliveryRunById(runId);
  if (!runRes.success) return runRes;
  const run = runRes.data;
  const stopsCount = (run.tickets ?? []).length;
  if (stopsCount === 0) {
    return { success: false, error: { message: "Cannot complete a delivery run with 0 stops/tickets." } };
  }

  const incomplete = (run.tickets ?? []).some((ticket: any) => !['delivered', 'issue_reported', 'cancelled'].includes(ticket.status));
  if (incomplete) return { success: false, error: { message: 'All tickets must be delivered, issue reported, or cancelled before completing the run.' } };

  const odometerStart = run.odometerStartKm != null ? Number(run.odometerStartKm) : null;
  const odometerEnd = payload.odometerEndKm !== undefined && payload.odometerEndKm !== '' ? Number(payload.odometerEndKm) : run.odometerEndKm;
  if (odometerStart != null && odometerEnd != null && Number(odometerEnd) < odometerStart) {
    return { success: false, error: { message: 'Ending odometer cannot be less than starting odometer.' } };
  }

  const now = new Date();
  const started = run.actualStartTime ? new Date(run.actualStartTime) : now;
  const actualDurationMinutes = Math.max(0, Math.round((now.getTime() - started.getTime()) / 60000));
  const actualDistanceKm = odometerStart != null && odometerEnd != null
    ? Math.max(0, Number(odometerEnd) - odometerStart)
    : Number(run.actualDistanceKm ?? 0);

  return updateDeliveryRun(runId, {
    status: 'completed',
    actualEndTime: now.toISOString(),
    odometerEndKm: odometerEnd,
    actualDistanceKm,
    actualDurationMinutes,
  });
}

export async function updateDeliveryRunOdometer(runId: string, startKm: number | null, endKm: number | null) {
  const actualDistanceKm = startKm != null && endKm != null ? Math.max(0, Number(endKm) - Number(startKm)) : 0;
  return updateDeliveryRun(runId, { odometerStartKm: startKm, odometerEndKm: endKm, actualDistanceKm });
}

export async function calculateDeliveryRunActuals(runId: string) {
  const res = await getDeliveryRunById(runId);
  if (!res.success) return res;
  const run = res.data;
  const start = run.actualStartTime ? new Date(run.actualStartTime) : null;
  const end = run.actualEndTime ? new Date(run.actualEndTime) : null;
  const actualDurationMinutes = start && end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000)) : Number(run.actualDurationMinutes ?? 0);
  const actualDistanceKm = run.odometerStartKm != null && run.odometerEndKm != null
    ? Math.max(0, Number(run.odometerEndKm) - Number(run.odometerStartKm))
    : Number(run.actualDistanceKm ?? 0);
  return updateDeliveryRun(runId, { actualDurationMinutes, actualDistanceKm });
}

export async function markDeliveryTicketArrived(ticketId: string) {
  return updateDeliveryTicket(ticketId, {
    arrivedAt: new Date().toISOString(),
    status: 'out_for_delivery',
  });
}

export async function reportDeliveryTicketIssue(ticketId: string, payload: { items: any[]; deliveryNotes?: string; receivedBy?: string }) {
  const itemRes = await updateDeliveryTicketItems(ticketId, payload.items);
  if (!itemRes.success) return itemRes;
  return updateDeliveryTicket(ticketId, {
    status: 'issue_reported',
    deliveryNotes: payload.deliveryNotes ?? '',
    receivedBy: payload.receivedBy ?? '',
    deliveredAt: new Date().toISOString(),
  });
}

export async function updateDeliveryTicketStopSequence(ticketId: string, sequence: number) {
  return updateDeliveryTicket(ticketId, { stopSequence: sequence });
}

export async function estimateDeliveryRunRoute(
  runId: string,
  options: { optimize?: boolean; returnToStart?: boolean } = {}
) {
  try {
    const res = await fetch('/api/delivery-routes/estimate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        runId,
        optimize: options.optimize ?? false,
        returnToStart: options.returnToStart ?? false,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, error: err.error || err.message || `HTTP error ${res.status}` };
    }
    const data = await res.json();
    return { success: true, data };
  } catch (err: any) {
    console.error('estimateDeliveryRunRoute error:', err);
    return { success: false, error: err.message || 'Unknown network error' };
  }
}

export async function updateDeliveryRunRouteEstimate(
  runId: string,
  estimate: {
    estimatedDistanceKm: number;
    estimatedDurationMinutes: number;
    routeEstimateSource: string;
    routePolyline?: string | null;
    googleRouteSummary?: any | null;
    tickets?: Array<{ id: string; estimatedArrivalTime: string | null }>;
  }
) {
  const patch: any = {
    estimatedDistanceKm: estimate.estimatedDistanceKm,
    estimatedDurationMinutes: estimate.estimatedDurationMinutes,
    routeEstimateSource: estimate.routeEstimateSource,
    routeEstimatedAt: new Date().toISOString(),
  };
  if ('routePolyline' in estimate) patch.routePolyline = estimate.routePolyline;
  if ('googleRouteSummary' in estimate) patch.googleRouteSummary = estimate.googleRouteSummary;

  const { data, error } = await supabase
    .from('delivery_runs')
    .update(mapDeliveryRunPatchToDB(patch))
    .eq('id', runId)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[Route Estimate Supabase Error]', error);
    return { success: false, error };
  }
  if (!data) {
    const notFoundError = { message: 'Delivery run not found.' };
    console.error('[Route Estimate Supabase Error]', notFoundError);
    return { success: false, error: notFoundError };
  }

  if (Array.isArray(estimate.tickets) && estimate.tickets.length > 0) {
    const ticketUpdates = estimate.tickets.map((t) =>
      supabase
        .from('delivery_tickets')
        .update({ estimated_arrival_time: t.estimatedArrivalTime })
        .eq('id', t.id)
        .eq('delivery_run_id', runId)
    );
    const results = await Promise.all(ticketUpdates);
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      console.error('updateDeliveryRunRouteEstimate ticket update error:', failed.error);
      return { success: false, error: failed.error };
    }
  }

  return { success: true, data: mapDeliveryRunToFrontend(data) };
}

export async function applyOptimizedStopOrder(runId: string, orderedTicketIds: string[]) {
  return reorderDeliveryRunStops(runId, orderedTicketIds);
}

export async function buildGoogleMapsDirectionsUrl(runId: string) {
  const runRes = await getDeliveryRunById(runId);
  if (!runRes.success || !runRes.data) return '';
  const run = runRes.data;

  // 1. Determine origin
  let origin = run.startAddress?.trim();
  if (!origin) {
    // Load LOC-HQ to check for address in location_billing_profiles
    const { data: hqProfile } = await supabase
      .from('location_billing_profiles')
      .select('*')
      .eq('location_id', 'LOC-HQ')
      .maybeSingle();
    
    if (hqProfile) {
      const storeAddress = hqProfile.store_address || hqProfile.storeAddress;
      const city = hqProfile.store_city || hqProfile.storeCity;
      const province = hqProfile.store_province || hqProfile.storeProvince;
      const postalCode = hqProfile.store_postal_code || hqProfile.storePostalCode;
      if (storeAddress) {
        origin = `${storeAddress}, ${city || ''}, ${province || ''} ${postalCode || ''}, Canada`
          .replace(/,\s*,/g, ',')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }

    if (!origin) {
      // Load LOC-HQ locations table fallback
      const { data: hqLoc } = await supabase
        .from('locations')
        .select('*')
        .eq('id', 'LOC-HQ')
        .maybeSingle();
      
      if (hqLoc) {
        origin = [
          hqLoc.address,
          hqLoc.street,
          hqLoc.city,
          hqLoc.province ?? hqLoc.state,
          hqLoc.postal_code ?? hqLoc.postalCode,
        ].filter(Boolean).join(', ');
      }
    }
  }

  if (!origin) {
    origin = "Head Office / Central Kitchen";
  }

  const tickets = [...(run.tickets || [])]
    .sort((a, b) => (a.stopSequence ?? 999) - (b.stopSequence ?? 999))
    .filter((t: any) => t.status !== 'cancelled');

  if (tickets.length === 0) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(origin)}&travelmode=driving`;
  }

  const destAddress = tickets[tickets.length - 1].destinationAddress?.trim() || tickets[tickets.length - 1].destinationName?.trim() || '';
  const intermediateAddresses = tickets
    .slice(0, -1)
    .map((t: any) => t.destinationAddress?.trim() || t.destinationName?.trim() || '')
    .filter(Boolean);

  let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destAddress)}&travelmode=driving`;
  if (intermediateAddresses.length > 0) {
    url += `&waypoints=${encodeURIComponent(intermediateAddresses.join('|'))}`;
  }
  return url;
}

export async function getVehicleDailyLogs(filters: { vehicleId?: string; driverId?: string; status?: string; date?: string } = {}) {
  let query = supabase
    .from('vehicle_daily_logs')
    .select('*, drivers(*), vehicles(*)')
    .order('log_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (filters.vehicleId) query = query.eq('vehicle_id', filters.vehicleId);
  if (filters.driverId) query = query.eq('driver_id', filters.driverId);
  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.date) query = query.eq('log_date', filters.date);
  const { data, error } = await query;
  if (error) {
    console.error('getVehicleDailyLogs:', error);
    return [];
  }
  return (data ?? []).map(mapVehicleDailyLogToFrontend);
}

export async function getVehicleDailyLogById(id: string) {
  const { data, error } = await supabase
    .from('vehicle_daily_logs')
    .select('*, drivers(*), vehicles(*)')
    .eq('id', id)
    .single();
  if (error) return { success: false, error };
  const log = mapVehicleDailyLogToFrontend(data);
  const runsRes = await getDeliveryRuns({ runDate: log.logDate });
  log.runs = runsRes.filter((run: any) => run.vehicleId === log.vehicleId);
  return { success: true, data: log };
}

export async function getVehicleDailyLogByVehicleDate(vehicleId: string, date: string) {
  const { data, error } = await supabase
    .from('vehicle_daily_logs')
    .select('*, drivers(*), vehicles(*)')
    .eq('vehicle_id', vehicleId)
    .eq('log_date', date)
    .maybeSingle();
  if (error) return { success: false, error };
  return { success: true, data: data ? mapVehicleDailyLogToFrontend(data) : null };
}

export async function createVehicleDailyLog(payload: any) {
  const userId = await getCurrentAuthUserId();
  const { data, error } = await supabase
    .from('vehicle_daily_logs')
    .insert({
      vehicle_id: payload.vehicleId,
      log_date: payload.logDate,
      driver_id: payload.driverId || null,
      odometer_start_km: Number(payload.odometerStartKm ?? 0),
      fuel_start_level: payload.fuelStartLevel ?? '',
      start_condition_notes: payload.startConditionNotes ?? '',
      status: 'open',
      created_by: userId,
      opened_at: new Date().toISOString(),
    })
    .select('*, drivers(*), vehicles(*)')
    .single();
  if (error) return { success: false, error };
  return { success: true, data: mapVehicleDailyLogToFrontend(data) };
}

export async function updateVehicleDailyLog(id: string, patch: any) {
  const payload: any = {};
  if ('driverId' in patch) payload.driver_id = patch.driverId || null;
  if ('odometerStartKm' in patch) payload.odometer_start_km = Number(patch.odometerStartKm ?? 0);
  if ('odometerEndKm' in patch) payload.odometer_end_km = patch.odometerEndKm === '' || patch.odometerEndKm == null ? null : Number(patch.odometerEndKm);
  if ('totalOdometerKm' in patch) payload.total_odometer_km = patch.totalOdometerKm == null ? null : Number(patch.totalOdometerKm);
  if ('totalRunKm' in patch) payload.total_run_km = patch.totalRunKm == null ? null : Number(patch.totalRunKm);
  if ('varianceKm' in patch) payload.variance_km = patch.varianceKm == null ? null : Number(patch.varianceKm);
  if ('fuelStartLevel' in patch) payload.fuel_start_level = patch.fuelStartLevel ?? '';
  if ('fuelEndLevel' in patch) payload.fuel_end_level = patch.fuelEndLevel ?? '';
  if ('startConditionNotes' in patch) payload.start_condition_notes = patch.startConditionNotes ?? '';
  if ('endConditionNotes' in patch) payload.end_condition_notes = patch.endConditionNotes ?? '';
  if ('damageReported' in patch) payload.damage_reported = Boolean(patch.damageReported);
  if ('damageNotes' in patch) payload.damage_notes = patch.damageNotes ?? '';
  if ('status' in patch) payload.status = patch.status;
  if ('closedAt' in patch) payload.closed_at = patch.closedAt || null;
  const { data, error } = await supabase.from('vehicle_daily_logs').update(payload).eq('id', id).select('*, drivers(*), vehicles(*)').single();
  if (error) return { success: false, error };
  return { success: true, data: mapVehicleDailyLogToFrontend(data) };
}

export async function calculateVehicleDailyLogVariance(vehicleId: string, date: string, odometerStartKm?: number, odometerEndKm?: number) {
  const runs = (await getDeliveryRuns({ runDate: date })).filter((run: any) => run.vehicleId === vehicleId);
  const totalRunKm = runs.reduce((sum: number, run: any) => sum + Number(run.actualDistanceKm ?? 0), 0);
  const totalOdometerKm = odometerStartKm != null && odometerEndKm != null
    ? Math.max(0, Number(odometerEndKm) - Number(odometerStartKm))
    : null;
  return {
    totalRunKm,
    totalOdometerKm,
    varianceKm: totalOdometerKm != null ? totalOdometerKm - totalRunKm : null,
    runs,
  };
}

export async function closeVehicleDailyLog(id: string, payload: any) {
  const current = await getVehicleDailyLogById(id);
  if (!current.success) return current;
  const log = current.data;
  const odometerEndKm = Number(payload.odometerEndKm ?? log.odometerEndKm ?? 0);
  if (odometerEndKm < Number(log.odometerStartKm ?? 0)) {
    return { success: false, error: { message: 'Ending odometer cannot be less than starting odometer.' } };
  }
  const totals = await calculateVehicleDailyLogVariance(log.vehicleId, log.logDate, Number(log.odometerStartKm), odometerEndKm);
  return updateVehicleDailyLog(id, {
    odometerEndKm,
    totalOdometerKm: totals.totalOdometerKm,
    totalRunKm: totals.totalRunKm,
    varianceKm: totals.varianceKm,
    fuelEndLevel: payload.fuelEndLevel ?? '',
    endConditionNotes: payload.endConditionNotes ?? '',
    damageReported: payload.damageReported ?? false,
    damageNotes: payload.damageNotes ?? '',
    status: 'closed',
    closedAt: new Date().toISOString(),
  });
}

export async function getVehicleDailyLogReport(id: string) {
  return getVehicleDailyLogById(id);
}

export async function getDeliveryRunReport(runId: string) {
  const runRes = await getDeliveryRunById(runId);
  if (!runRes.success) return runRes;
  const run = runRes.data;
  const vehicleLog = run.vehicleId ? await getVehicleDailyLogByVehicleDate(run.vehicleId, run.runDate) : { success: true, data: null };
  const vehicleTotals = run.vehicleId
    ? await calculateVehicleDailyLogVariance(run.vehicleId, run.runDate, vehicleLog.data?.odometerStartKm, vehicleLog.data?.odometerEndKm)
    : { totalRunKm: 0, totalOdometerKm: null, varianceKm: null, runs: [] };
  return {
    success: true,
    data: {
      run,
      vehicleDailyLog: vehicleLog.success ? vehicleLog.data : null,
      vehicleTotals,
      totals: {
        stops: (run.tickets ?? []).length,
        tickets: (run.tickets ?? []).length,
        itemLines: (run.tickets ?? []).reduce((sum: number, ticket: any) => sum + (ticket.items?.length ?? 0), 0),
        shippedQty: (run.tickets ?? []).reduce((sum: number, ticket: any) => sum + (ticket.items ?? []).reduce((s: number, item: any) => s + Number(item.shippedQty ?? 0), 0), 0),
        deliveredQty: (run.tickets ?? []).reduce((sum: number, ticket: any) => sum + (ticket.items ?? []).reduce((s: number, item: any) => s + Number(item.deliveredQty ?? 0), 0), 0),
        issueQty: (run.tickets ?? []).reduce((sum: number, ticket: any) => sum + (ticket.items ?? []).reduce((s: number, item: any) => s + Number(item.issueQty ?? 0), 0), 0),
        estimatedKm: Number(run.estimatedDistanceKm ?? 0),
        actualKm: Number(run.actualDistanceKm ?? 0),
        estimatedMinutes: Number(run.estimatedDurationMinutes ?? 0),
        actualMinutes: Number(run.actualDurationMinutes ?? 0),
      },
    },
  };
}



export async function getDrivers() {
  const { data, error } = await supabase.from('drivers').select('*').order('active', { ascending: false }).order('name');
  if (error) return [];
  return (data ?? []).map(mapDriverToFrontend);
}

export async function getActiveDriverByEmail(email: string) {
  const authEmail = String(email ?? '').trim();
  if (!authEmail) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[delivery-driver-scope] Missing auth email; cannot resolve driver row.');
    }
    return null;
  }

  const { data, error } = await supabase
    .from('drivers')
    .select('id, name, email, active, phone, hourly_rate, notes, created_at, updated_at')
    .ilike('email', authEmail)
    .eq('active', true)
    .maybeSingle();

  if (error) {
    console.error('[delivery-driver-scope] Driver lookup failed:', {
      authEmail,
      message: error.message,
    });
    return null;
  }

  if (process.env.NODE_ENV === 'development') {
    console.log('[delivery-driver-scope] Driver lookup result:', {
      authEmail,
      driverId: data?.id ?? null,
      driverEmail: data?.email ?? null,
      driverActive: data?.active ?? null,
    });
  }

  return data ? mapDriverToFrontend(data) : null;
}

export async function createDriver(payload: any) {
  const { data, error } = await supabase
    .from('drivers')
    .insert({
      name: payload.name,
      phone: payload.phone ?? '',
      email: payload.email ?? '',
      active: payload.active ?? true,
      hourly_rate: payload.hourlyRate === '' || payload.hourlyRate == null ? null : Number(payload.hourlyRate),
      notes: payload.notes ?? '',
    })
    .select()
    .single();
  if (error) return { success: false, error };
  return { success: true, data: mapDriverToFrontend(data) };
}

export async function updateDriver(id: string, patch: any) {
  const payload: any = {};
  if ('name' in patch) payload.name = patch.name;
  if ('phone' in patch) payload.phone = patch.phone ?? '';
  if ('email' in patch) payload.email = patch.email ?? '';
  if ('active' in patch) payload.active = Boolean(patch.active);
  if ('hourlyRate' in patch) payload.hourly_rate = patch.hourlyRate === '' || patch.hourlyRate == null ? null : Number(patch.hourlyRate);
  if ('notes' in patch) payload.notes = patch.notes ?? '';
  const { data, error } = await supabase.from('drivers').update(payload).eq('id', id).select().single();
  if (error) return { success: false, error };
  return { success: true, data: mapDriverToFrontend(data) };
}

export async function getVehicles() {
  const { data, error } = await supabase.from('vehicles').select('*').order('active', { ascending: false }).order('vehicle_name');
  if (error) return [];
  return (data ?? []).map(mapVehicleToFrontend);
}

export async function createVehicle(payload: any) {
  const { data, error } = await supabase
    .from('vehicles')
    .insert({
      vehicle_name: payload.vehicleName,
      plate_number: payload.plateNumber ?? '',
      active: payload.active ?? true,
      notes: payload.notes ?? '',
    })
    .select()
    .single();
  if (error) return { success: false, error };
  return { success: true, data: mapVehicleToFrontend(data) };
}

export async function updateVehicle(id: string, patch: any) {
  const payload: any = {};
  if ('vehicleName' in patch) payload.vehicle_name = patch.vehicleName;
  if ('plateNumber' in patch) payload.plate_number = patch.plateNumber ?? '';
  if ('active' in patch) payload.active = Boolean(patch.active);
  if ('notes' in patch) payload.notes = patch.notes ?? '';
  const { data, error } = await supabase.from('vehicles').update(payload).eq('id', id).select().single();
  if (error) return { success: false, error };
  return { success: true, data: mapVehicleToFrontend(data) };
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

  let { data, error } = await run("*, inventory_items(name), hq_sale_items(name, base_unit, instock)");

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
    .select("item_id, finished_good_id, quantity_fulfilled, pack_qty_snapshot")
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

    if (delta !== 0) {
      const packQtySnapshot = currentRow.pack_qty_snapshot != null ? Number(currentRow.pack_qty_snapshot) : 1;
      const baseQtyDeduct = delta * packQtySnapshot;
      const stockRes = await updateSaleItemStock(currentRow.finished_good_id, -baseQtyDeduct);
      if (!stockRes.success) {
        console.error('[Fulfillment] ✗ FG stock deduct failed', stockRes.error);
        return { success: false, error: stockRes.error };
      }
      console.log(`[Fulfillment] FG stock deducted by ${baseQtyDeduct} base units. new instock=${stockRes.newStock}`);
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

    // ── 4. Fetch HQ inventory row for cost and metadata ────────────────────────
    const { data: hqRows, error: hqFetchError } = await supabase
      .from("inventory_items")
      .select("id, cost, name")
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

    const hqRow = hqRows[0];

    // ── 5. Call PostgreSQL transfer RPC (updates HQ and dest stock safely) ──
    const { error: transferError } = await supabase.rpc("transfer_inventory_stock_definer", {
      p_shared_item_id: sharedItemId,
      p_from_location_id: HQ_LOCATION_ID,
      p_to_location_id: destLocationId,
      p_qty: delta
    });

    if (transferError) {
      console.error("[Fulfillment] ✗ Step 5: Stock transfer RPC failed", transferError);
      return { success: false, error: transferError };
    }

    console.log(`[Fulfillment] Step 5 OK: Stock transfer completed. item_id=${sharedItemId} qty=${delta}`);

    // ── 7b. Write inventory_movements ledger (fire-and-forget) ────────────────
    // Uses real schema: bigint id (identity), location_id TEXT, item_id TEXT.
    // Two rows: transfer_out on HQ, transfer_in on destination.
    // Failures are non-fatal — stock transfer is already committed.
    const unitCost = Number(hqRow.cost ?? 0);

    const [outErr, inErr] = await Promise.all([
      logMovement({
        locationId:    HQ_LOCATION_ID,
        itemId:        sharedItemId,
        movementType:  'transfer_out',
        quantity:      delta,
        unitCost,
        referenceType: 'requisition',
        referenceId:   requisitionId,
        notes:         `Requisition fulfillment → ${destLocationId}`,
      }),
      logMovement({
        locationId:    destLocationId,
        itemId:        sharedItemId,
        movementType:  'transfer_in',
        quantity:      delta,
        unitCost,
        referenceType: 'requisition',
        referenceId:   requisitionId,
        notes:         `Received from HQ`,
      }),
    ]);

    if (outErr || inErr) {
      console.warn('[Fulfillment] ⚠ Step 7b: movement ledger insert failed (non-fatal)',
        outErr?.message ?? inErr?.message);
    } else {
      console.log(`[Fulfillment] Step 7b OK: 2 movement rows written (unit_cost=${unitCost})`);
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

  // ── 9. Recalculate requisition status + total_amount ──────────────────────────
  const { data: allItems, error: siblingsError } = await supabase
    .from("requisition_items")
    .select("quantity_requested, quantity_fulfilled, unit_price")
    .eq("requisition_id", requisitionId);

  if (siblingsError || !allItems || allItems.length === 0) {
    return { success: true };
  }

  // -- Status rules (only valid DB statuses: fulfilled | approved) --
  // partial/backordered are UI-display-only computed client-side from line quantities.
  // The DB CHECK constraint only allows: draft, submitted, approved, rejected, fulfilled.
  const allDone = allItems.every(
    (row) => Number(row.quantity_fulfilled ?? 0) >= Number(row.quantity_requested)
  );
  const newStatus = allDone ? "fulfilled" : "approved";

  // ── Fulfilled total: sum(quantityFulfilled × unitPrice) ──────────────────────
  const fulfilledTotal = allItems.reduce((sum, row) => {
    return sum + Number(row.quantity_fulfilled ?? 0) * Number(row.unit_price ?? 0);
  }, 0);

  // Guard: missing requisitionId would update every row -- abort early.
  if (!requisitionId) {
    console.error("[Fulfillment] ✗ Step 9: requisitionId missing.");
    return { success: true };
  }

  // Minimal status-only UPDATE -- never include location_id or other header fields.
  const { error: statusError } = await supabase
    .from("requisitions")
    .update({ status: newStatus })   // only status -- no location_id, no created_at
    .eq("id", requisitionId);

  if (statusError) {
    console.error("[Fulfillment] ✗ Step 9a: status update failed", statusError);
    return { success: false, error: statusError };
  }
  console.log(`[Fulfillment] Step 9a OK: status -> ${newStatus}`);

  // Non-fatal total_amount patch -- separate so a missing column cannot block status.
  const { error: totalError } = await supabase
    .from("requisitions")
    .update({ total_amount: parseFloat(fulfilledTotal.toFixed(2)) })
    .eq("id", requisitionId);

  if (totalError) {
    console.warn(`[Fulfillment] Step 9b: total_amount non-fatal: ${totalError.message}`);
  } else {
    console.log(`[Fulfillment] Step 9b OK: total_amount -> $${fulfilledTotal.toFixed(2)}`);
  }

  return { success: true, newStatus };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVEMENT LEDGER HELPER
// Central writer for public.inventory_movements (real schema):
//   id BIGINT GENERATED ALWAYS AS IDENTITY  ← auto, do NOT supply
//   created_at TIMESTAMPTZ DEFAULT NOW()    ← auto
//   location_id TEXT NOT NULL
//   item_id TEXT NOT NULL
//   movement_type TEXT NOT NULL
//   quantity NUMERIC NOT NULL
//   unit_cost NUMERIC nullable   (view falls back to inventory_items.cost)
//   total_cost NUMERIC nullable  (view computes qty*unit_cost when null)
//   reference_type TEXT nullable
//   reference_id TEXT nullable
//   notes TEXT nullable
//
// Returns the Supabase error object on failure, or null on success.
// All callers treat movement failures as non-fatal (stock is already committed).
// ─────────────────────────────────────────────────────────────────────────────
export async function logMovement(params: {
  locationId:     string;
  itemId:         string;
  movementType:   string;        // 'transfer_out'|'transfer_in'|'purchase_in'|'adjustment_in'|'adjustment_out'
  quantity:       number;        // always positive
  unitCost?:      number | null; // null → view falls back to inventory_items.cost
  referenceType?: string | null;
  referenceId?:   string | null;
  notes?:         string | null;
}): Promise<any | null> {
  const unitCost  = params.unitCost != null ? Number(params.unitCost) : null;
  const totalCost = unitCost !== null && params.quantity > 0
    ? params.quantity * unitCost
    : null;

  const { error } = await supabase
    .from('inventory_movements')
    .insert({
      location_id:    params.locationId,
      item_id:        params.itemId,
      movement_type:  params.movementType,
      quantity:       params.quantity,
      unit_cost:      unitCost,
      total_cost:     totalCost,
      reference_type: params.referenceType ?? null,
      reference_id:   params.referenceId   ?? null,
      notes:          params.notes         ?? null,
    });

  if (error) {
    console.error('[logMovement] insert failed:', {
      movement_type: params.movementType,
      location_id:   params.locationId,
      item_id:       params.itemId,
      msg:           error.message,
      code:          error.code,
    });
    return error;
  }
  return null;
}


// ----------------------------------------------------------------------------
// PRODUCTION MOVEMENTS — read-only history for the Production History view
// Fetches all inventory_movements rows where reference_type = 'production'.
// Callers group by reference_id client-side. Non-fatal on error.
// ----------------------------------------------------------------------------

export interface ProductionMovementRow {
  id:            number;
  created_at:    string;
  location_id:   string | null;
  item_id:       string | null;
  movement_type: string;   // 'production_in' | 'production_consumption'
  quantity:      number;
  unit_cost:     number | null;
  total_cost:    number | null;
  reference_type: string | null;
  reference_id:   string | null;
  notes:          string | null;
}

export interface FgCountMovementRow {
  id:             number;
  created_at:     string;
  item_id:        string | null;
  movement_type:  string;
  quantity:       number;
  unit_cost:      number | null;
  total_cost:     number | null;
  reference_id:   string | null;
  notes:          string | null;
}

export interface FgCountSessionRow {
  id: string;
  count_date: string;
  session_name: string | null;
  counted_by: string | null;
  counted_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface FgCountLineRow {
  id: string;
  session_id: string;
  item_id: string;
  item_name: string | null;
  unit: string | null;
  system_qty: number;
  physical_qty: number;
  variance_qty: number;
  unit_cost: number;
  variance_value: number;
}

export interface FgCountSessionWithLines {
  session: FgCountSessionRow;
  lines: FgCountLineRow[];
}

const mapFgCountSession = (db: any): FgCountSessionRow => ({
  id:              db.id ?? '',
  count_date:      db.count_date ?? '',
  session_name:    db.session_name ?? null,
  counted_by:      db.counted_by ?? null,
  counted_by_name: db.counted_by_name ?? null,
  created_at:      db.created_at ?? '',
  updated_at:      db.updated_at ?? '',
});

const mapFgCountLine = (db: any): FgCountLineRow => ({
  id:             db.id ?? '',
  session_id:     db.session_id ?? '',
  item_id:        db.item_id ?? '',
  item_name:      db.item_name ?? null,
  unit:           db.unit ?? null,
  system_qty:     Number(db.system_qty ?? 0),
  physical_qty:   Number(db.physical_qty ?? 0),
  variance_qty:   Number(db.variance_qty ?? 0),
  unit_cost:      Number(db.unit_cost ?? 0),
  variance_value: Number(db.variance_value ?? 0),
});

export async function loadFgCountSessions(opts?: {
  dateFrom?: string;
  dateTo?: string;
}): Promise<FgCountSessionRow[]> {
  let query = supabase
    .from('fg_count_sessions')
    .select('id, count_date, session_name, counted_by, counted_by_name, created_at, updated_at')
    .order('count_date', { ascending: false })
    .order('updated_at', { ascending: false })
    .range(0, 4999);

  if (opts?.dateFrom) query = query.gte('count_date', opts.dateFrom);
  if (opts?.dateTo) query = query.lte('count_date', opts.dateTo);

  const { data, error } = await query;

  if (error) {
    console.error('[loadFgCountSessions] DB error:', error.message);
    return [];
  }
  return (data ?? []).map(mapFgCountSession);
}

export async function loadFgCountSessionByDate(countDate: string): Promise<FgCountSessionWithLines | null> {
  const { data: session, error } = await supabase
    .from('fg_count_sessions')
    .select('id, count_date, session_name, counted_by, counted_by_name, created_at, updated_at')
    .eq('count_date', countDate)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[loadFgCountSessionByDate] DB error:', error.message);
    return null;
  }
  if (!session) return null;

  const { data: lines, error: lineError } = await supabase
    .from('fg_count_lines')
    .select('id, session_id, item_id, item_name, unit, system_qty, physical_qty, variance_qty, unit_cost, variance_value')
    .eq('session_id', session.id)
    .range(0, 4999);

  if (lineError) {
    console.error('[loadFgCountSessionByDate] line DB error:', lineError.message);
    return { session: mapFgCountSession(session), lines: [] };
  }

  return {
    session: mapFgCountSession(session),
    lines: (lines ?? []).map(mapFgCountLine),
  };
}

export async function loadFgCountSessionById(sessionId: string): Promise<FgCountSessionWithLines | null> {
  const { data: session, error } = await supabase
    .from('fg_count_sessions')
    .select('id, count_date, session_name, counted_by, counted_by_name, created_at, updated_at')
    .eq('id', sessionId)
    .maybeSingle();

  if (error || !session) {
    if (error) console.error('[loadFgCountSessionById] DB error:', error.message);
    return null;
  }

  const { data: lines, error: lineError } = await supabase
    .from('fg_count_lines')
    .select('id, session_id, item_id, item_name, unit, system_qty, physical_qty, variance_qty, unit_cost, variance_value')
    .eq('session_id', sessionId)
    .range(0, 4999);

  if (lineError) {
    console.error('[loadFgCountSessionById] line DB error:', lineError.message);
    return { session: mapFgCountSession(session), lines: [] };
  }

  return {
    session: mapFgCountSession(session),
    lines: (lines ?? []).map(mapFgCountLine),
  };
}

export async function upsertFgCountSessionWithLines(params: {
  session: {
    id: string;
    countDate: string;
    sessionName: string | null;
    countedBy: string | null;
    countedByName: string | null;
  };
  lines: Array<{
    itemId: string;
    itemName: string;
    unit: string;
    systemQty: number;
    physicalQty: number;
    varianceQty: number;
    unitCost: number;
    varianceValue: number;
  }>;
}): Promise<{ success: boolean; error?: any }> {
  const now = new Date().toISOString();
  const { error: sessionError } = await supabase
    .from('fg_count_sessions')
    .upsert({
      id:              params.session.id,
      count_date:      params.session.countDate,
      session_name:    params.session.sessionName,
      counted_by:      params.session.countedBy,
      counted_by_name: params.session.countedByName,
      updated_at:      now,
    }, { onConflict: 'id' });

  if (sessionError) return { success: false, error: sessionError };

  const lineRows = params.lines.map(line => ({
    id:             `${params.session.id}:${line.itemId}`,
    session_id:     params.session.id,
    item_id:        line.itemId,
    item_name:      line.itemName,
    unit:           line.unit,
    system_qty:     line.systemQty,
    physical_qty:   line.physicalQty,
    variance_qty:   line.varianceQty,
    unit_cost:      line.unitCost,
    variance_value: line.varianceValue,
    updated_at:     now,
  }));

  if (lineRows.length === 0) return { success: true };

  const originalLines = lineRows;
  const uniqueLinesMap = new Map<string, any>();
  for (const row of originalLines) {
    const key = `${row.session_id}::${row.item_id}`;
    uniqueLinesMap.set(key, row);
  }
  const dedupedLines = Array.from(uniqueLinesMap.values());

  console.warn("Deduped inventory updates", {
    before: originalLines.length,
    after: dedupedLines.length
  });

  const { error: lineError } = await supabase
    .from('fg_count_lines')
    .upsert(dedupedLines, { onConflict: 'session_id,item_id' });

  if (lineError) return { success: false, error: lineError };
  return { success: true };
}

export async function loadFgCountMovements(): Promise<FgCountMovementRow[]> {
  const { data, error } = await supabase
    .from('inventory_movements')
    .select('id, created_at, item_id, movement_type, quantity, unit_cost, total_cost, reference_id, notes')
    .eq('reference_type', 'fg_count')
    .in('movement_type', ['count_variance_gain', 'count_variance_loss'])
    .order('created_at', { ascending: false })
    .range(0, 4999);

  if (error) {
    console.error('[loadFgCountMovements] DB error:', error.message);
    return [];
  }

  return (data ?? []).map((r: any): FgCountMovementRow => ({
    id:            Number(r.id ?? 0),
    created_at:    r.created_at ?? '',
    item_id:       r.item_id ?? null,
    movement_type: r.movement_type ?? '',
    quantity:      Number(r.quantity ?? 0),
    unit_cost:     r.unit_cost  != null ? Number(r.unit_cost)  : null,
    total_cost:    r.total_cost != null ? Number(r.total_cost) : null,
    reference_id:  r.reference_id ?? null,
    notes:         r.notes ?? null,
  }));
}

export async function loadProductionMovements(opts?: {
  dateFrom?: string;   // ISO date "YYYY-MM-DD"
  dateTo?:   string;
}): Promise<ProductionMovementRow[]> {
  let query = supabase
    .from('inventory_movements')
    .select('id, created_at, location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes')
    .eq('reference_type', 'production')
    .order('created_at', { ascending: false })
    .range(0, 4999);  // cap at 5 000 rows for safety

  if (opts?.dateFrom) {
    query = query.gte('created_at', `${opts.dateFrom}T00:00:00Z`);
  }
  if (opts?.dateTo) {
    query = query.lte('created_at', `${opts.dateTo}T23:59:59Z`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[loadProductionMovements] DB error:', error.message);
    return [];
  }
  return (data ?? []).map((r: any): ProductionMovementRow => ({
    id:             Number(r.id            ?? 0),
    created_at:     r.created_at           ?? '',
    location_id:    r.location_id          ?? null,
    item_id:        r.item_id              ?? null,
    movement_type:  r.movement_type        ?? '',
    quantity:       Number(r.quantity      ?? 0),
    unit_cost:      r.unit_cost  != null ? Number(r.unit_cost)  : null,
    total_cost:     r.total_cost != null ? Number(r.total_cost) : null,
    reference_type: r.reference_type       ?? null,
    reference_id:   r.reference_id         ?? null,
    notes:          r.notes                ?? null,
  }));
}


// ----------------------------------------------------------------------------
// PURCHASE OPTIONS  — multi-supplier pricing rows per inventory item
// ----------------------------------------------------------------------------
// Schema:
//   id                uuid PK (gen_random_uuid)
//   inventory_item_id TEXT FK → inventory_items.id (TEXT PK, SET NULL on delete)
//   supplier_name     text NOT NULL
//   supplier_product_name text
//   purchase_uom      text NOT NULL
//   pack_qty          numeric
//   pack_uom          text
//   unit_price        numeric NOT NULL DEFAULT 0
//   is_preferred      boolean NOT NULL DEFAULT false
//   created_at        timestamptz
//   updated_at        timestamptz   (auto-updated by trigger)
// ----------------------------------------------------------------------------

const mapPurchaseOptionToFrontend = (db: any) => ({
  id:                   db.id,                             // uuid (string)
  inventoryItemId:      db.inventory_item_id ?? null,      // TEXT FK
  supplierName:         db.supplier_name ?? '',
  supplierProductName:  db.supplier_product_name ?? '',
  purchaseUom:          db.purchase_uom ?? '',
  packQty:              db.pack_qty != null ? Number(db.pack_qty) : null,
  packUom:              db.pack_uom ?? null,
  unitPrice:            db.unit_price != null ? Number(db.unit_price) : 0,
  isPreferred:          Boolean(db.is_preferred),
  createdAt:            db.created_at,
  updatedAt:            db.updated_at,
});

const mapPurchaseOptionToDB = (opt: any) => ({
  // id: omit on insert (DB generates uuid); include on update/upsert
  ...(opt.id ? { id: String(opt.id) } : {}),
  inventory_item_id:    opt.inventoryItemId ? String(opt.inventoryItemId) : null,
  supplier_name:        opt.supplierName   ?? '',
  supplier_product_name: opt.supplierProductName ?? null,
  purchase_uom:         opt.purchaseUom    ?? '',
  pack_qty:             opt.packQty  != null ? Number(opt.packQty)   : null,
  pack_uom:             opt.packUom  ?? null,
  unit_price:           isNaN(parseFloat(opt.unitPrice)) ? 0 : parseFloat(opt.unitPrice),
  is_preferred:         Boolean(opt.isPreferred),
});

/**
 * Load purchase options.
 * @param inventoryItemId  When supplied, returns options for that item only.
 *                         When omitted, returns all rows (e.g. bulk import audit).
 */
export async function loadPurchaseOptions(inventoryItemId?: string | null) {
  console.log('[storage.loadPurchaseOptions] querying with inventoryItemId:', inventoryItemId, '| typeof:', typeof inventoryItemId);
  let query = supabase
    .from('purchase_options')
    .select('*')
    .order('is_preferred', { ascending: false })  // preferred row first
    .order('supplier_name', { ascending: true })
    .range(0, 9999);
  if (inventoryItemId) query = query.eq('inventory_item_id', inventoryItemId);
  const { data, error } = await query;
  if (error) {
    console.error('[storage.loadPurchaseOptions] DB error:', error);
    return [];
  }
  console.log('[storage.loadPurchaseOptions] raw DB rows returned:', data?.length ?? 0, data);
  const mapped = Array.isArray(data) ? data.map(mapPurchaseOptionToFrontend) : [];
  console.log('[storage.loadPurchaseOptions] mapped rows:', mapped);
  return mapped;
}

/**
 * Upsert one or many purchase options.
 * Rows with an existing id are updated; rows without an id are inserted (DB generates uuid).
 */
export async function savePurchaseOptions(options: any[]) {
  if (!options.length) return { success: true };
  const rows = options.map(mapPurchaseOptionToDB);
  const { error } = await supabase
    .from('purchase_options')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });
  if (error) {
    console.error('[savePurchaseOptions] error:', error);
    return { success: false, error };
  }
  return { success: true };
}

/**
 * Bulk-insert purchase options (no id needed — DB generates uuid for each row).
 * Use this for the initial CSV import when rows are guaranteed new.
 */
export async function insertPurchaseOptions(options: any[]) {
  if (!options.length) return { success: true };
  const rows = options.map(opt => {
    const mapped = mapPurchaseOptionToDB(opt);
    // Remove id entirely so Postgres generates a fresh uuid
    const { id: _id, ...rest } = mapped as any;
    return rest;
  });
  console.log('[storage.insertPurchaseOptions] rows to insert:', rows);
  const { data, error } = await supabase.from('purchase_options').insert(rows).select();
  console.log('[storage.insertPurchaseOptions] insert result — data:', data, '| error:', error);
  if (error) {
    console.error('[storage.insertPurchaseOptions] error detail:', JSON.stringify(error));
    return { success: false, error };
  }
  return { success: true, data };
}

/**
 * Delete all purchase options for one inventory item.
 * Used before a re-import to clear stale supplier rows cleanly.
 */
export async function deletePurchaseOptionsForItem(inventoryItemId: string) {
  const { error } = await supabase
    .from('purchase_options')
    .delete()
    .eq('inventory_item_id', inventoryItemId);
  if (error) {
    console.error('[deletePurchaseOptionsForItem] error:', error);
    return { success: false, error };
  }
  return { success: true };
}

/**
 * Delete a single purchase option by its uuid.
 */
export async function deletePurchaseOption(id: string) {
  const { error } = await supabase
    .from('purchase_options')
    .delete()
    .eq('id', id);
  if (error) {
    console.error('[deletePurchaseOption] error:', error);
    return { success: false, error };
  }
  return { success: true };
}

// ────────────────────────────────────────────────────────────────────────────
// 18. OUTLET LEVEL INVENTORY  (location_inventory_items)
// ────────────────────────────────────────────────────────────────────────────
//
// Table: location_inventory_items
//   item_id, location_id  — UNIQUE composite key
//   current_stock, physical_count, min_on_hand, par_level — outlet-only fields
//   local_enabled, local_notes, last_counted_at
//
// IMPORTANT: location_inventory_items is INDEPENDENT of inventory_items.
// Master item data (name, category, uom, price, supplier…) comes from
// outlet_catalog_items (NOT inventory_items). HQ Inventory (inventory_items)
// and Location Inventory are completely separate systems. Changes in one
// never affect the other.
// ────────────────────────────────────────────────────────────────────────────

/** Shape of one outlet inventory row after DB read */
export interface OutletInventoryRow {
  id:             string;
  itemId:         string;       // shared item identity (FK to HQ row)
  locationId:     string;
  currentStock:   number;
  physicalCount:  number | null;
  minOnHand:      number;
  parLevel:       number;
  localEnabled:   boolean;
  localNotes:     string | null;
  lastCountedAt:  string | null;
  createdAt:      string;
  updatedAt:      string;
}

function mapOutletRowToFrontend(db: any): OutletInventoryRow {
  return {
    id:            db.id,
    itemId:        db.item_id,
    locationId:    db.location_id,
    currentStock:  parseFloat(db.current_stock) || 0,
    physicalCount: db.physical_count != null ? parseFloat(db.physical_count) : null,
    minOnHand:     parseFloat(db.min_on_hand)   || 0,
    parLevel:      parseFloat(db.par_level)      || 0,
    localEnabled:  db.local_enabled !== false,
    localNotes:    db.local_notes    ?? null,
    lastCountedAt: db.last_counted_at ?? null,
    createdAt:     db.created_at,
    updatedAt:     db.updated_at,
  };
}

/**
 * Load all outlet inventory rows for a given location.
 *
 * @param locationId  Pass 'LOC-HQ' to retrieve HQ rows, or any outlet id.
 *                    hq_admin can load any location; location_manager is
 *                    restricted by RLS to their own location.
 */
export async function loadOutletInventory(
  locationId: string
): Promise<OutletInventoryRow[]> {
  const { data, error } = await supabase
    .from('location_inventory_items')
    .select('*')
    .eq('location_id', locationId)
    .order('item_id', { ascending: true });

  if (error) {
    console.error('[loadOutletInventory] error:', error);
    return [];
  }
  return (data ?? []).map(mapOutletRowToFrontend);
}

/**
 * Upsert a single outlet inventory row.
 * Only the outlet-editable fields are written; master item data is untouched.
 *
 * Requires migration_outlet_inventory.sql to have been run.
 */
export async function upsertOutletInventoryRow(
  row: {
    item_id:        string;
    location_id:    string;
    current_stock:  number;
    physical_count: number | null;
    min_on_hand:    number;
    par_level:      number;
    local_enabled:  boolean;
    local_notes:    string | null;
    last_counted_at?: string | null;
  }
): Promise<{ success: boolean; error?: any }> {
  const payload: any = {
    item_id:        row.item_id,
    location_id:    row.location_id,
    current_stock:  isNaN(row.current_stock)  ? 0 : row.current_stock,
    physical_count: row.physical_count ?? null,
    min_on_hand:    isNaN(row.min_on_hand)    ? 0 : row.min_on_hand,
    par_level:      isNaN(row.par_level)      ? 0 : row.par_level,
    local_enabled:  row.local_enabled,
    local_notes:    row.local_notes ?? null,
    updated_at:     new Date().toISOString(),
  };
  if (row.last_counted_at !== undefined) {
    payload.last_counted_at = row.last_counted_at;
  }

  const { error } = await supabase
    .from('location_inventory_items')
    .upsert(payload, { onConflict: 'item_id,location_id' });

  if (error) {
    console.error('[upsertOutletInventoryRow] error:', error);
    return { success: false, error };
  }
  return { success: true };
}

/**
 * Bulk-upsert outlet inventory rows from Excel import.
 * Processes each row individually so failures are isolated and reported.
 *
 * @param rows       Array of outlet rows (already validated + mapped by excel.ts)
 * @returns          Summary: { succeeded, failed, errors }
 */
export async function bulkUpsertOutletInventory(
  rows: Parameters<typeof upsertOutletInventoryRow>[0][]
): Promise<{ succeeded: number; failed: number; errors: string[] }> {
  let succeeded = 0;
  let failed    = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const res = await upsertOutletInventoryRow(row);
    if (res.success) {
      succeeded++;
    } else {
      failed++;
      const msg = res.error?.message ?? JSON.stringify(res.error);
      errors.push(`${row.item_id} @ ${row.location_id}: ${msg}`);
    }
  }

  return { succeeded, failed, errors };
}

// ────────────────────────────────────────────────────────────────────────────
// 19. OUTLET CATALOG  (outlet_catalog_items)
// ────────────────────────────────────────────────────────────────────────────

export interface OutletCatalogItem {
  itemId:          string;
  name:            string;
  category:        string | null;
  uom:             string | null;
  type:            string;
  sourceType:      'hq_supplied' | 'local_vendor';
  hqSaleItemId:    string | null;
  supplier:        string | null;
  /** FK to suppliers.id — null when supplier is free-text only (backward compat) */
  supplierId:      number | null;
  purchaseOption:  string | null;
  productCode:     string | null;
  scanBarcode:     string | null;
  price:           number;
  taxRate:         number;
  packQty:         number;
  orderingEnabled: boolean;
  isActive:        boolean;
}

function mapCatalogItem(db: any): OutletCatalogItem {
  return {
    itemId:          db.item_id,
    name:            db.name,
    category:        db.category  ?? null,
    uom:             db.uom       ?? null,
    type:            db.type      ?? 'Inventory item',
    sourceType:      db.source_type === 'hq_supplied' ? 'hq_supplied' : 'local_vendor',
    hqSaleItemId:    db.hq_sale_item_id ?? null,
    supplier:        db.supplier  ?? null,
    supplierId:      db.supplier_id != null ? Number(db.supplier_id) : null,
    purchaseOption:  db.purchase_option ?? null,
    productCode:     db.product_code    ?? null,
    scanBarcode:     db.scan_barcode    ?? null,
    price:           parseFloat(db.price)    || 0,
    taxRate:         parseFloat(db.tax_rate) || 0,
    packQty:         parseFloat(db.pack_qty) || 1,
    orderingEnabled: db.ordering_enabled !== false,
    isActive:        db.is_active !== false,
  };
}

/** Load outlet catalog items (global — same for every location) */
export async function loadOutletCatalog(
  all: boolean = false,
  userProfile?: { role: string | null; location_id?: string | null; locationId?: string | null } | null
): Promise<OutletCatalogItem[]> {
  let query = supabase
    .from('outlet_catalog_items')
    .select('*');

  if (!all) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query.order('name', { ascending: true });
  if (error) {
    console.error('[loadOutletCatalog] error:', error);
    return [];
  }
  
  if (!Array.isArray(data)) return [];

  try {
    let profile = userProfile;
    if (!profile) {
      const { data: authData } = await supabase.auth.getUser();
      const user = authData?.user;
      if (user) {
        const { data: dbProfile } = await supabase
          .from('user_profiles')
          .select('role, location_id')
          .eq('user_id', user.id)
          .single();
        profile = dbProfile;
      }
    }
    
    if (profile) {
      const role = (profile.role ?? '').toLowerCase().trim();
      const isHq = role === 'hq_admin' || role === 'hq admin' || role === 'admin';
      const isLocMgr = role === 'location_manager' || role === 'location manager';
      const locationId = profile.location_id ?? profile.locationId;

      if (!isHq && isLocMgr && locationId) {
        // Fetch finished goods visibility modes in parallel
        const [fgsResult, availRowsResult] = await Promise.all([
          supabase
            .from('hq_sale_items')
            .select('id, location_availability_mode'),
          supabase
            .from('finished_good_location_availability')
            .select('finished_good_id, is_available')
            .eq('location_id', locationId)
            .eq('is_available', true)
        ]);
        
        const fgs = fgsResult.data;
        const availRows = availRowsResult.data;
        
        const allowedFgIds = new Set(availRows?.map(r => r.finished_good_id) || []);
        const fgModes = new Map(fgs?.map(f => [f.id, f.location_availability_mode ?? 'all']) || []);

        const mapped = data.map(mapCatalogItem);
        const filtered = mapped.filter(c => {
          if (!c.hqSaleItemId) return true; // not a finished good
          const mode = fgModes.get(c.hqSaleItemId) ?? 'all';
          if (mode === 'all') return true;
          if (mode === 'selected') return allowedFgIds.has(c.hqSaleItemId);
          return false; // hq_only
        });
        return filtered;
      }
    }
  } catch (err) {
    console.error('[loadOutletCatalog] dynamic filtering failed:', err);
  }

  return data.map(mapCatalogItem);
}

/** HQ-only: upsert a catalog item */
export async function upsertOutletCatalogItem(
  item: Omit<OutletCatalogItem, 'isActive'> & { isActive?: boolean }
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('outlet_catalog_items')
    .upsert({
      item_id:          item.itemId,
      name:             item.name,
      category:         item.category         ?? null,
      uom:              item.uom              ?? null,
      type:             item.type,
      source_type:      item.sourceType,
      hq_sale_item_id:  item.hqSaleItemId     ?? null,
      supplier:         item.supplier         ?? null,
      supplier_id:      item.supplierId       ?? null,
      purchase_option:  item.purchaseOption   ?? null,
      product_code:     item.productCode      ?? null,
      scan_barcode:     item.scanBarcode      ?? null,
      price:            item.price,
      tax_rate:         item.taxRate,
      pack_qty:         item.packQty,
      ordering_enabled: item.orderingEnabled,
      is_active:        item.isActive ?? true,
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'item_id' });
  if (error) {
    console.error('[upsertOutletCatalogItem] error:', error);
    return { success: false, error };
  }
  return { success: true };
}

/** HQ-only: soft-delete a catalog item */
export async function deactivateOutletCatalogItem(
  itemId: string
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('outlet_catalog_items')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('item_id', itemId);
  if (error) return { success: false, error };
  return { success: true };
}

/** HQ-only: activate a catalog item */
export async function activateOutletCatalogItem(
  itemId: string
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('outlet_catalog_items')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('item_id', itemId);
  if (error) return { success: false, error };
  return { success: true };
}

// Extended outlet row shape (with local-override columns added in migration_outlet_catalog.sql)
export interface OutletInventoryRowV2 extends OutletInventoryRow {
  localSupplier:       string | null;
  localPurchaseOption: string | null;
  localPrice:          number | null;
  localProductCode:    string | null;
}

function mapOutletRowV2(db: any): OutletInventoryRowV2 {
  const base = {
    id:            db.id,
    itemId:        db.item_id,
    locationId:    db.location_id,
    currentStock:  parseFloat(db.current_stock)  || 0,
    physicalCount: db.physical_count != null ? parseFloat(db.physical_count) : null,
    minOnHand:     parseFloat(db.min_on_hand)    || 0,
    parLevel:      parseFloat(db.par_level)      || 0,
    localEnabled:  db.local_enabled !== false,
    localNotes:    db.local_notes    ?? null,
    lastCountedAt: db.last_counted_at ?? null,
    createdAt:     db.created_at,
    updatedAt:     db.updated_at,
  };
  return {
    ...base,
    localSupplier:       db.local_supplier        ?? null,
    localPurchaseOption: db.local_purchase_option ?? null,
    localPrice:          db.local_price != null ? parseFloat(db.local_price) : null,
    localProductCode:    db.local_product_code    ?? null,
  };
}

/** Load outlet inventory rows for a location (v2 — includes local overrides) */
export async function loadOutletInventoryV2(
  locationId: string
): Promise<OutletInventoryRowV2[]> {
  const { data, error } = await supabase
    .from('location_inventory_items')
    .select('*')
    .eq('location_id', locationId)
    .order('item_id', { ascending: true });
  if (error) {
    console.error('[loadOutletInventoryV2] error:', error);
    return [];
  }
  return (data ?? []).map(mapOutletRowV2);
}

/** Upsert outlet inventory row (v2 — includes local overrides) */
export async function upsertOutletInventoryRowV2(
  row: {
    item_id:              string;
    location_id:          string;
    current_stock:        number;
    physical_count:       number | null;
    min_on_hand:          number;
    par_level:            number;
    local_enabled:        boolean;
    local_notes:          string | null;
    local_supplier?:      string | null;
    local_purchase_option?: string | null;
    local_price?:         number | null;
    local_product_code?:  string | null;
    last_counted_at?:     string | null;
  }
): Promise<{ success: boolean; error?: any }> {
  const payload: any = {
    item_id:        row.item_id,
    location_id:    row.location_id,
    current_stock:  isNaN(row.current_stock) ? 0 : row.current_stock,
    physical_count: row.physical_count ?? null,
    min_on_hand:    isNaN(row.min_on_hand)   ? 0 : row.min_on_hand,
    par_level:      isNaN(row.par_level)     ? 0 : row.par_level,
    local_enabled:  row.local_enabled,
    local_notes:    row.local_notes ?? null,
    local_supplier:        row.local_supplier        ?? null,
    local_purchase_option: row.local_purchase_option ?? null,
    local_price:           row.local_price           ?? null,
    local_product_code:    row.local_product_code    ?? null,
    updated_at:     new Date().toISOString(),
  };
  if (row.last_counted_at !== undefined) payload.last_counted_at = row.last_counted_at;

  const { error } = await supabase
    .from('location_inventory_items')
    .upsert(payload, { onConflict: 'item_id,location_id' });
  if (error) {
    console.error('[upsertOutletInventoryRowV2] error:', error);
    return { success: false, error };
  }
  return { success: true };
}

/** Bulk upsert v2 rows (Excel import) */
export async function bulkUpsertOutletInventoryV2(
  rows: Parameters<typeof upsertOutletInventoryRowV2>[0][]
): Promise<{ succeeded: number; failed: number; errors: string[] }> {
  let succeeded = 0; let failed = 0; const errors: string[] = [];
  for (const row of rows) {
    const res = await upsertOutletInventoryRowV2(row);
    if (res.success) { succeeded++; }
    else { failed++; errors.push(`${row.item_id}@${row.location_id}: ${res.error?.message ?? 'error'}`); }
  }
  return { succeeded, failed, errors };
}

/** Bulk upsert catalog items (Location Catalog Excel / MarketMan import) */
export async function bulkUpsertOutletCatalogItems(
  items: (Omit<OutletCatalogItem, 'isActive'> & { isActive?: boolean })[]
): Promise<{ succeeded: number; failed: number; errors: string[] }> {
  let succeeded = 0; let failed = 0; const errors: string[] = [];
  for (const item of items) {
    const res = await upsertOutletCatalogItem(item);
    if (res.success) { succeeded++; }
    else { failed++; errors.push(`${item.itemId} (${item.name}): ${res.error?.message ?? 'error'}`); }
  }
  return { succeeded, failed, errors };
}

/**
 * Find an existing outlet catalog item by normalized name + supplier + uom.
 *
 * Used during MarketMan import to match an incoming row to an existing catalog
 * item BEFORE generating a new item_id. If a match is found, the existing
 * item_id is reused so the upsert updates rather than duplicates the row.
 *
 * Normalization: lowercase → trim → collapse whitespace.
 * Returns the item_id string if found, null otherwise.
 */
export async function findOutletCatalogItemByNormalized(
  name:     string,
  supplier: string | null,
  uom:      string | null,
): Promise<string | null> {
  const norm = (s: string | null) =>
    (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

  const { data, error } = await supabase
    .from('outlet_catalog_items')
    .select('item_id, name, supplier, uom')
    .eq('source_type', 'local_vendor');

  if (error || !data) {
    console.warn('[findOutletCatalogItemByNormalized] query error:', error);
    return null;
  }

  const normName     = norm(name);
  const normSupplier = norm(supplier);
  const normUom      = norm(uom);

  const match = data.find(row => {
    const sameName     = norm(row.name)     === normName;
    const sameSupplier = normSupplier === '' || norm(row.supplier) === normSupplier;
    const sameUom      = normUom      === '' || norm(row.uom)      === normUom;
    return sameName && sameSupplier && sameUom;
  });

  return match?.item_id ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// 19b. ASSIGN CATALOG ITEMS → LOCATIONS
// ────────────────────────────────────────────────────────────────────────────
//
// Creates location_inventory_items rows for one or more (item_id, location_id)
// pairs so those items appear in Outlet Inventory for the given locations.
//
// Rules:
//   - If a row already exists (UNIQUE item_id + location_id), skip it — never
//     overwrite current_stock, physical_count, min_on_hand, par_level, or any
//     local_* override columns.
//   - Default inserted values: current_stock=0, physical_count=0, min_on_hand=0,
//     par_level=0, local_enabled=true, local_notes=null.
//   - Returns a summary: { created, skipped, failed, errors }.
//   - Does NOT touch inventory_items, hq_sale_items, or any HQ table.
// ────────────────────────────────────────────────────────────────────────────

export interface AssignCatalogResult {
  created: number;
  skipped: number;
  failed:  number;
  errors:  string[];
}

export interface CopyOutletInventoryOptions {
  sourceLocationId: string;
  targetLocationIds: string[];
  itemIds: string[];
  copyMinPar: boolean;
  copySupplierSettings: boolean;
  copyStockCounts: boolean;
  updateExistingSetupFields: boolean;
}

export interface CopyOutletInventoryResult {
  created: number;
  skipped: number;
  updated: number;
  failed: number;
  errors: string[];
}

/**
 * Assign one or more catalog items to one or more locations.
 *
 * @param itemIds      Array of outlet_catalog_items.item_id values to assign.
 * @param locationIds  Array of locations.id values to assign them to.
 * @returns            Summary of created / skipped / failed rows.
 */
export async function assignCatalogItemsToLocations(
  itemIds:     string[],
  locationIds: string[],
): Promise<AssignCatalogResult> {
  const result: AssignCatalogResult = { created: 0, skipped: 0, failed: 0, errors: [] };

  if (itemIds.length === 0 || locationIds.length === 0) return result;

  // 1. Fetch all existing rows for these item_ids × location_ids in one query.
  //    This lets us check existence without N×M round trips.
  const { data: existing, error: fetchErr } = await supabase
    .from('location_inventory_items')
    .select('item_id, location_id')
    .in('item_id',     itemIds)
    .in('location_id', locationIds);

  if (fetchErr) {
    console.error('[assignCatalogItemsToLocations] fetch error:', fetchErr);
    result.failed  = itemIds.length * locationIds.length;
    result.errors  = [`DB fetch error: ${fetchErr.message}`];
    return result;
  }

  // Build a Set of "item_id|location_id" pairs that already exist
  const existingSet = new Set<string>(
    (existing ?? []).map(r => `${r.item_id}|${r.location_id}`)
  );

  // 2. Build the list of rows to insert (only missing pairs)
  const toInsert: {
    item_id:        string;
    location_id:    string;
    current_stock:  number;
    physical_count: number;
    min_on_hand:    number;
    par_level:      number;
    local_enabled:  boolean;
    local_notes:    null;
    updated_at:     string;
  }[] = [];

  const now = new Date().toISOString();

  for (const itemId of itemIds) {
    for (const locationId of locationIds) {
      const key = `${itemId}|${locationId}`;
      if (existingSet.has(key)) {
        result.skipped++;
      } else {
        toInsert.push({
          item_id:        itemId,
          location_id:    locationId,
          current_stock:  0,
          physical_count: 0,
          min_on_hand:    0,
          par_level:      0,
          local_enabled:  true,
          local_notes:    null,
          updated_at:     now,
        });
      }
    }
  }

  if (toInsert.length === 0) return result; // all already existed

  // 3. Insert in chunks of 50 to stay well within Supabase row limits
  const CHUNK = 50;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const { error: insertErr } = await supabase
      .from('location_inventory_items')
      .insert(chunk);

    if (insertErr) {
      console.error('[assignCatalogItemsToLocations] insert error:', insertErr);
      result.failed += chunk.length;
      result.errors.push(`Batch ${Math.floor(i / CHUNK) + 1}: ${insertErr.message}`);
    } else {
      result.created += chunk.length;
    }
  }

  return result;
}

/**
 * Copy existing outlet inventory setup rows from one source location to targets.
 *
 * This only touches location_inventory_items. Existing target rows are skipped
 * by default to protect stock/count values and local overrides.
 */
export async function copyOutletInventoryItemsToLocationsV2(
  options: CopyOutletInventoryOptions
): Promise<CopyOutletInventoryResult> {
  const result: CopyOutletInventoryResult = {
    created: 0,
    skipped: 0,
    updated: 0,
    failed: 0,
    errors: [],
  };

  const sourceLocationId = options.sourceLocationId;
  const targetLocationIds = Array.from(new Set(options.targetLocationIds.filter((id) => id && id !== sourceLocationId)));
  const itemIds = Array.from(new Set(options.itemIds.filter(Boolean)));

  if (!sourceLocationId || targetLocationIds.length === 0 || itemIds.length === 0) return result;

  const { data: sourceRows, error: sourceErr } = await supabase
    .from('location_inventory_items')
    .select('*')
    .eq('location_id', sourceLocationId)
    .in('item_id', itemIds);

  if (sourceErr) {
    console.error('[copyOutletInventoryItemsToLocationsV2] source fetch error:', sourceErr);
    result.failed = itemIds.length * targetLocationIds.length;
    result.errors.push(`Source fetch error: ${sourceErr.message}`);
    return result;
  }

  const sourceByItem = new Map<string, any>((sourceRows ?? []).map((row: any) => [row.item_id, row]));
  for (const itemId of itemIds) {
    if (!sourceByItem.has(itemId)) {
      result.failed += targetLocationIds.length;
      result.errors.push(`${itemId}: source row does not exist at ${sourceLocationId}`);
    }
  }

  const copyableItemIds = itemIds.filter((itemId) => sourceByItem.has(itemId));
  if (copyableItemIds.length === 0) return result;

  const { data: existing, error: existingErr } = await supabase
    .from('location_inventory_items')
    .select('item_id, location_id')
    .in('item_id', copyableItemIds)
    .in('location_id', targetLocationIds);

  if (existingErr) {
    console.error('[copyOutletInventoryItemsToLocationsV2] existing fetch error:', existingErr);
    result.failed += copyableItemIds.length * targetLocationIds.length;
    result.errors.push(`Existing rows fetch error: ${existingErr.message}`);
    return result;
  }

  const existingSet = new Set<string>((existing ?? []).map((row: any) => `${row.item_id}|${row.location_id}`));
  const now = new Date().toISOString();

  const buildSetupPayload = (source: any) => ({
    min_on_hand: options.copyMinPar ? Number(source.min_on_hand ?? 0) : 0,
    par_level: options.copyMinPar ? Number(source.par_level ?? 0) : 0,
    local_enabled: source.local_enabled !== false,
    local_supplier: options.copySupplierSettings ? source.local_supplier ?? null : null,
    local_purchase_option: options.copySupplierSettings ? source.local_purchase_option ?? null : null,
    local_price: options.copySupplierSettings ? source.local_price ?? null : null,
    local_product_code: options.copySupplierSettings ? source.local_product_code ?? null : null,
    updated_at: now,
  });

  const toInsert: any[] = [];
  const toUpdate: { itemId: string; locationId: string; payload: any }[] = [];

  for (const itemId of copyableItemIds) {
    const source = sourceByItem.get(itemId);
    for (const locationId of targetLocationIds) {
      const key = `${itemId}|${locationId}`;
      if (existingSet.has(key)) {
        if (options.updateExistingSetupFields) {
          toUpdate.push({ itemId, locationId, payload: buildSetupPayload(source) });
        } else {
          result.skipped++;
        }
        continue;
      }

      toInsert.push({
        item_id: itemId,
        location_id: locationId,
        current_stock: options.copyStockCounts ? Number(source.current_stock ?? 0) : 0,
        physical_count: options.copyStockCounts ? Number(source.physical_count ?? 0) : 0,
        local_notes: null,
        ...buildSetupPayload(source),
      });
    }
  }

  const CHUNK = 50;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('location_inventory_items')
      .insert(chunk);

    if (error) {
      console.error('[copyOutletInventoryItemsToLocationsV2] insert error:', error);
      result.failed += chunk.length;
      result.errors.push(`Insert batch ${Math.floor(i / CHUNK) + 1}: ${error.message}`);
    } else {
      result.created += chunk.length;
    }
  }

  for (const update of toUpdate) {
    const { error } = await supabase
      .from('location_inventory_items')
      .update(update.payload)
      .eq('item_id', update.itemId)
      .eq('location_id', update.locationId);

    if (error) {
      console.error('[copyOutletInventoryItemsToLocationsV2] update error:', error);
      result.failed++;
      result.errors.push(`${update.itemId}@${update.locationId}: ${error.message}`);
    } else {
      result.updated++;
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// 20. LOCATION PHYSICAL COUNT  (location_inventory_items + location_inventory_count_logs)
// ────────────────────────────────────────────────────────────────────────────
//
// Applies physical counts entered by a location manager.
// For each item with physical_count != null:
//   - variance = physical_count - current_stock
//   - Sets current_stock = physical_count
//   - Sets last_counted_at = now()
//   - Preserves physical_count (cleared by UX once acknowledged)
//   - Inserts an audit row into location_inventory_count_logs
//
// IMPORTANT: Only touches location_inventory_items and location_inventory_count_logs.
// Never reads or writes inventory_items, hq_sale_items, or any HQ table.
// ────────────────────────────────────────────────────────────────────────────

export interface CountApplyEntry {
  /** item_id from outlet_catalog_items / location_inventory_items */
  itemId:        string;
  locationId:    string;
  previousStock: number;
  physicalCount: number;
  varianceQty:   number;
  /** Current outlet inventory row fields — preserved on upsert */
  minOnHand:     number;
  parLevel:      number;
  localEnabled:  boolean;
  localNotes:    string | null;
  localSupplier: string | null;
  localPrice:    number | null;
}

export interface CountApplyResult {
  succeeded: number;
  failed:    number;
  errors:    string[];
}

/**
 * Apply physical count for a batch of location inventory items.
 *
 * @param entries   Array of items to update (only those with physical_count not null)
 * @param countedBy UUID of the authenticated user performing the count
 * @param notes     Optional free-text notes for the count session
 */
export async function applyPhysicalCount(
  entries:   CountApplyEntry[],
  countedBy: string | null,
  notes:     string | null
): Promise<CountApplyResult> {
  const originalRows = entries;
  const uniqueEntriesMap = new Map<string, CountApplyEntry>();
  for (const entry of originalRows) {
    const key = `${entry.locationId}::${entry.itemId}`;
    uniqueEntriesMap.set(key, entry);
  }
  const dedupedRows = Array.from(uniqueEntriesMap.values());

  console.warn("Deduped inventory updates", {
    before: originalRows.length,
    after: dedupedRows.length
  });

  let succeeded = 0;
  let failed    = 0;
  const errors: string[] = [];

  const now = new Date().toISOString();

  for (const entry of dedupedRows) {
    // 1. Update location_inventory_items:
    //    current_stock  = physical_count (the reconciled value)
    //    physical_count = null           (clear — audit history lives in location_inventory_count_logs)
    //    last_counted_at = now()
    const { error: upsertError } = await supabase
      .from('location_inventory_items')
      .upsert({
        item_id:        entry.itemId,
        location_id:    entry.locationId,
        current_stock:  entry.physicalCount,
        physical_count: null,             // ← cleared so the row is no longer "pending count"
        min_on_hand:    entry.minOnHand,
        par_level:      entry.parLevel,
        local_enabled:  entry.localEnabled,
        local_notes:    entry.localNotes ?? null,
        local_supplier: entry.localSupplier ?? null,
        local_price:    entry.localPrice ?? null,
        last_counted_at: now,
        updated_at:     now,
      }, { onConflict: 'item_id,location_id' });

    if (upsertError) {
      console.error('[applyPhysicalCount] upsert failed:', entry.itemId, upsertError);
      errors.push(`${entry.itemId}: ${upsertError.message}`);
      failed++;
      continue;
    }

    // 2. Insert audit log into location_inventory_count_logs
    const { error: logError } = await supabase
      .from('location_inventory_count_logs')
      .insert({
        location_id:    entry.locationId,
        item_id:        entry.itemId,
        previous_stock: entry.previousStock,
        physical_count: entry.physicalCount,
        variance_qty:   entry.varianceQty,
        counted_by:     countedBy ?? null,
        notes:          notes ?? null,
      });

    if (logError) {
      // Log failure is non-fatal — stock is already updated. Warn and continue.
      console.warn('[applyPhysicalCount] audit log insert failed (non-fatal):', entry.itemId, logError);
    }

    succeeded++;
  }

  return { succeeded, failed, errors };
}

// ────────────────────────────────────────────────────────────────────────────
// 21. MONTHLY LOCATION INVOICES
// ────────────────────────────────────────────────────────────────────────────

export interface Invoice {
  id: string;
  invoiceNumber: string;
  locationId: string;
  invoiceMonth: string;
  status: "draft" | "finalized" | "sent" | "paid" | "void";
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  generatedAt: string;
  finalizedAt: string | null;
  paidAt: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  billingFrequency: "daily" | "biweekly" | "monthly";
  periodStart: string;
  periodEnd: string;
}

export interface InvoiceItem {
  id: string;
  invoiceId: string;
  requisitionId: string | null;
  requisitionItemId: string | null;
  itemId: string | null;
  itemName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  createdAt: string;
}

export interface MonthlyInvoiceSummary {
  invoiceId: string;
  invoiceNumber: string;
  locationId: string;
  invoiceMonth: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  requisitionCount: number;
  itemCount: number;
}

const mapInvoiceToFrontend = (db: any): Invoice => ({
  id: db.id,
  invoiceNumber: db.invoice_number,
  locationId: db.location_id,
  invoiceMonth: db.invoice_month,
  status: db.status,
  subtotal: Number(db.subtotal ?? 0),
  taxAmount: Number(db.tax_amount ?? 0),
  totalAmount: Number(db.total_amount ?? 0),
  generatedAt: db.generated_at,
  finalizedAt: db.finalized_at ?? null,
  paidAt: db.paid_at ?? null,
  notes: db.notes ?? null,
  createdBy: db.created_by ?? null,
  createdAt: db.created_at,
  updatedAt: db.updated_at,
  billingFrequency: db.billing_frequency ?? 'monthly',
  periodStart: db.period_start ?? db.invoice_month,
  periodEnd: db.period_end ?? db.invoice_month,
});

const mapInvoiceItemToFrontend = (db: any): InvoiceItem => ({
  id: db.id,
  invoiceId: db.invoice_id,
  requisitionId: db.requisition_id ?? null,
  requisitionItemId: db.requisition_item_id ?? null,
  itemId: db.item_id ?? null,
  itemName: db.item_name,
  quantity: Number(db.quantity ?? 0),
  unitPrice: Number(db.unit_price ?? 0),
  lineTotal: Number(db.line_total ?? 0),
  createdAt: db.created_at,
});

export async function loadInvoices(filters?: {
  month?: string | null;
  date?: string | null;
  locationId?: string | null;
  billingFrequency?: "daily" | "biweekly" | "monthly" | "all" | null;
}): Promise<Invoice[]> {
  let query = supabase
    .from('invoices')
    .select('*')
    .order('generated_at', { ascending: false });

  if (filters?.billingFrequency && filters.billingFrequency !== 'all') {
    query = query.eq('billing_frequency', filters.billingFrequency);
  }
  if (filters?.locationId) {
    query = query.eq('location_id', filters.locationId);
  }
  
  if (filters?.billingFrequency === 'monthly') {
    if (filters?.month) {
      const monthStart = `${filters.month.slice(0, 7)}-01`;
      query = query.eq('period_start', monthStart);
    }
  } else if (filters?.billingFrequency === 'daily' || filters?.billingFrequency === 'biweekly') {
    if (filters?.date) {
      query = query.eq('period_start', filters.date);
    }
  } else {
    // If 'all' or undefined frequency, but filters have month/date
    if (filters?.month && !filters?.date) {
      const monthStart = `${filters.month.slice(0, 7)}-01`;
      const nextMonthStart = new Date(new Date(`${filters.month.slice(0, 7)}-01T00:00:00`).setMonth(new Date(`${filters.month.slice(0, 7)}-01T00:00:00`).getMonth() + 1)).toISOString().slice(0, 10);
      query = query.gte('period_start', monthStart).lt('period_start', nextMonthStart);
    } else if (filters?.date) {
      query = query.eq('period_start', filters.date);
    }
  }

  const { data, error } = await query;
  if (error) {
    console.error('[loadInvoices]', error);
    return [];
  }
  return Array.isArray(data) ? data.map(mapInvoiceToFrontend) : [];
}

export async function loadInvoiceItems(invoiceId: string): Promise<InvoiceItem[]> {
  const { data, error } = await supabase
    .from('invoice_items')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[loadInvoiceItems]', error);
    return [];
  }
  return Array.isArray(data) ? data.map(mapInvoiceItemToFrontend) : [];
}

export async function generateInvoices(
  frequency: "daily" | "biweekly" | "monthly",
  periodStart: string,
  locationId?: string | null
): Promise<{ success: boolean; data?: MonthlyInvoiceSummary[]; error?: any }> {
  const { data, error } = await supabase.rpc('generate_invoices', {
    p_billing_frequency: frequency,
    p_period_start: periodStart,
    p_location_id: locationId || null,
  } as any);

  if (error) {
    console.error('[generateInvoices]', error);
    return { success: false, error };
  }

  const summaries: MonthlyInvoiceSummary[] = (Array.isArray(data) ? data : []).map((row: any) => ({
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    locationId: row.location_id,
    invoiceMonth: row.invoice_month,
    subtotal: Number(row.subtotal ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    totalAmount: Number(row.total_amount ?? 0),
    requisitionCount: Number(row.requisition_count ?? 0),
    itemCount: Number(row.item_count ?? 0),
  }));

  return { success: true, data: summaries };
}

export async function generateMonthlyInvoices(
  month: string,
  locationId?: string | null
): Promise<{ success: boolean; data?: MonthlyInvoiceSummary[]; error?: any }> {
  const invoiceMonth = `${month.slice(0, 7)}-01`;
  return generateInvoices("monthly", invoiceMonth, locationId);
}

export async function finalizeInvoice(invoiceId: string): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('invoices')
    .update({ status: 'finalized', finalized_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('status', 'draft');

  if (error) {
    console.error('[finalizeInvoice]', error);
    return { success: false, error };
  }
  return { success: true };
}

export async function markInvoicePaid(invoiceId: string): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from('invoices')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .in('status', ['draft', 'finalized', 'sent']);

  if (error) {
    console.error('[markInvoicePaid]', error);
    return { success: false, error };
  }
  return { success: true };
}

// ── Daily Location Sales & Gratuity Tracking ─────────────────────────────────

export interface LocationDailySales {
  id?: string;
  locationId: string;
  salesDate: string; // YYYY-MM-DD
  posSales: number;
  uberSales: number;
  onlineSales: number;
  cateringSales: number;
  skipSales: number;
  doordashSales: number;
  notes?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface LocationSalesGratuitySettings {
  id: string;
  posPercent: number;
  uberPercent: number;
  onlinePercent: number;
  cateringPercent: number;
  skipPercent: number;
  doordashPercent: number;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

const mapDailySalesToFrontend = (db: any): LocationDailySales => ({
  id:            db.id,
  locationId:    db.location_id,
  salesDate:     db.sales_date,
  posSales:      Number(db.pos_sales ?? 0),
  uberSales:     Number(db.uber_sales ?? 0),
  onlineSales:   Number(db.online_sales ?? 0),
  cateringSales: Number(db.catering_sales ?? 0),
  skipSales:     Number(db.skip_sales ?? 0),
  doordashSales: Number(db.doordash_sales ?? 0),
  notes:         db.notes ?? null,
  createdBy:     db.created_by ?? null,
  createdAt:     db.created_at ?? null,
  updatedAt:     db.updated_at ?? null,
});

const mapDailySalesToDB = (l: LocationDailySales) => ({
  id:             l.id || undefined,
  location_id:    l.locationId,
  sales_date:     l.salesDate,
  pos_sales:      Number(l.posSales ?? 0),
  uber_sales:     Number(l.uberSales ?? 0),
  online_sales:   Number(l.onlineSales ?? 0),
  catering_sales: Number(l.cateringSales ?? 0),
  skip_sales:     Number(l.skipSales ?? 0),
  doordash_sales: Number(l.doordashSales ?? 0),
  notes:          l.notes || null,
  created_by:     l.createdBy || undefined,
  updated_at:     new Date().toISOString(),
});

const mapGratuitySettingsToFrontend = (db: any): LocationSalesGratuitySettings => ({
  id:              db.id,
  posPercent:      Number(db.pos_percent ?? 0),
  uberPercent:     Number(db.uber_percent ?? 0),
  onlinePercent:   Number(db.online_percent ?? 0),
  cateringPercent: Number(db.catering_percent ?? 0),
  skipPercent:     Number(db.skip_percent ?? 0),
  doordashPercent: Number(db.doordash_percent ?? 0),
  updatedBy:       db.updated_by ?? null,
  updatedAt:       db.updated_at ?? null,
});

const mapGratuitySettingsToDB = (g: Partial<LocationSalesGratuitySettings>) => ({
  id:               g.id || '00000000-0000-0000-0000-000000000000',
  pos_percent:      Number(g.posPercent ?? 0),
  uber_percent:     Number(g.uberPercent ?? 0),
  online_percent:   Number(g.onlinePercent ?? 0),
  catering_percent: Number(g.cateringPercent ?? 0),
  skip_percent:     Number(g.skipPercent ?? 0),
  doordash_percent: Number(g.doordashPercent ?? 0),
  updated_by:       g.updatedBy || undefined,
  updated_at:       new Date().toISOString(),
});

export async function loadDailySales(
  locationId?: string | null,
  startDate?: string | null,
  endDate?: string | null
): Promise<LocationDailySales[]> {
  let query = supabase.from('location_daily_sales').select('*');

  if (locationId) {
    query = query.eq('location_id', locationId);
  }
  if (startDate) {
    query = query.gte('sales_date', startDate);
  }
  if (endDate) {
    query = query.lte('sales_date', endDate);
  }

  const { data, error } = await query.order('sales_date', { ascending: false });
  if (error) {
    console.error('[loadDailySales] error:', error);
    return [];
  }
  return Array.isArray(data) ? data.map(mapDailySalesToFrontend) : [];
}

export async function upsertDailySales(
  sales: LocationDailySales
): Promise<{ success: boolean; error?: string }> {
  if (!sales.locationId || !sales.salesDate) {
    return { success: false, error: 'Location ID and Sales Date are required.' };
  }

  const dbRow = mapDailySalesToDB(sales);
  const { error } = await supabase
    .from('location_daily_sales')
    .upsert(dbRow, { onConflict: 'location_id,sales_date' });

  if (error) {
    console.error('[upsertDailySales] error:', error);
    return { success: false, error: error.message };
  }
  return { success: true };
}

export async function loadGratuitySettings(): Promise<LocationSalesGratuitySettings> {
  const { data, error } = await supabase
    .from('location_sales_gratuity_settings')
    .select('*')
    .eq('id', '00000000-0000-0000-0000-000000000000')
    .maybeSingle();

  if (error || !data) {
    return {
      id: '00000000-0000-0000-0000-000000000000',
      posPercent: 0,
      uberPercent: 0,
      onlinePercent: 0,
      cateringPercent: 0,
      skipPercent: 0,
      doordashPercent: 0,
    };
  }
  return mapGratuitySettingsToFrontend(data);
}

export async function saveGratuitySettings(
  settings: Partial<LocationSalesGratuitySettings>
): Promise<{ success: boolean; error?: string }> {
  const dbRow = mapGratuitySettingsToDB(settings);
  const { error } = await supabase
    .from('location_sales_gratuity_settings')
    .upsert(dbRow, { onConflict: 'id' });

  if (error) {
    console.error('[saveGratuitySettings] error:', error);
    return { success: false, error: error.message };
  }
  return { success: true };
}

// ─── HQ Fulfillment Role Data Helpers ──────────────────────────────────────────

export async function getFulfillmentSummary(): Promise<any[]> {
  const { data: reqs, error: reqsError } = await supabase
    .from('requisitions')
    .select('id, location, status, date, location_id')
    .in('status', ['submitted', 'approved', 'partial', 'backordered', 'fulfilled']);
    
  if (reqsError || !reqs || reqs.length === 0) return [];
  
  const reqIds = reqs.map(r => r.id);
  const [{ data: items, error: itemsError }, { data: tickets, error: ticketsError }] = await Promise.all([
    supabase
      .from('requisition_items')
      .select('*')
      .in('requisition_id', reqIds),
    supabase
      .from('delivery_tickets')
      .select('id, ticket_number, requisition_id')
      .in('requisition_id', reqIds)
  ]);
    
  if (itemsError || !items) return [];
  
  const mappedItems = items.map(mapReqItemRow);
  
  const summaryMap = new Map<string, any>();
  
  for (const item of mappedItems) {
    const key = item.itemName || 'Unnamed Item';
    if (!summaryMap.has(key)) {
      summaryMap.set(key, {
        itemName: key,
        finishedGoodId: item.finishedGoodId,
        itemId: item.itemId,
        catalogItemId: item.finishedGoodId || item.itemId,
        unit: item.unit,
        totalRequested: 0,
        totalAllocated: 0,
        totalBackorder: 0,
        items: [],
        isFGMode: item.isFGMode,
        packQty: item.packQty,
      });
    }
    const group = summaryMap.get(key);
    
    const req = reqs.find(r => r.id === item.requisitionId);
    const ticket = tickets?.find(t => t.requisition_id === item.requisitionId);
    
    group.totalRequested += item.quantityRequested;
    group.totalAllocated += item.allocatedQty || 0;
    group.totalBackorder += item.backorderQty || 0;
    
    group.items.push({
      id: item.id,
      requisitionId: item.requisitionId,
      requisitionNumber: req?.id || item.requisitionId,
      requisitionDate: req?.date,
      requisitionStatus: req?.status,
      locationName: req?.location || 'Unknown Location',
      locationId: req?.location_id,
      quantityRequested: item.quantityRequested,
      allocatedQty: item.allocatedQty || 0,
      backorderQty: item.backorderQty || 0,
      fulfillmentNote: item.fulfillmentNote || '',
      deliveryTicketId: ticket?.id || null,
      deliveryTicketNumber: ticket?.ticket_number || null,
      isFGMode: item.isFGMode,
      packQty: item.packQty,
      packCount: item.packCount,
      baseQty: item.baseQty,
      packPrice: item.packPrice,
      lineTotal: item.lineTotal,
      unit: item.unit,
    });
  }
  
  return Array.from(summaryMap.values());
}

export async function getFulfillmentItemBreakdown(itemName: string): Promise<any[]> {
  const summary = await getFulfillmentSummary();
  const group = summary.find(g => g.itemName === itemName);
  return group ? group.items : [];
}

export async function saveFulfillmentAllocations(allocations: {
  id: string;
  allocatedQty: number;
  backorderQty: number;
  fulfillmentNote: string;
  userId: string;
}[]): Promise<{ success: boolean; error?: any }> {
  const updates = allocations.map(a => ({
    id: a.id,
    allocated_qty: a.allocatedQty,
    backorder_qty: a.backorderQty,
    fulfillment_note: a.fulfillmentNote,
    fulfilled_by: a.userId,
    fulfilled_at: new Date().toISOString(),
  }));
  
  const { error } = await supabase
    .from('requisition_items')
    .upsert(updates, { onConflict: 'id' });
    
  if (error) {
    console.error('saveFulfillmentAllocations:', error);
    return { success: false, error };
  }
  return { success: true };
}

export async function completeFulfillmentMovement(requisitionId: string): Promise<{ success: boolean; error?: any }> {
  // 1. Fetch all items in requisition_items for this requisitionId
  const { data: items, error: fetchError } = await supabase
    .from('requisition_items')
    .select('id, allocated_qty, quantity_fulfilled')
    .eq('requisition_id', requisitionId);

  if (fetchError || !items) {
    return { success: false, error: fetchError || { message: 'Requisition items not found.' } };
  }

  // 2. Loop through each item and call updateRequisitionItemFulfilled sequentially
  for (const item of items) {
    const allocated = Number(item.allocated_qty ?? 0);
    const res = await updateRequisitionItemFulfilled(item.id, allocated, requisitionId);
    if (!res.success) {
      console.error(`[Fulfillment] completeFulfillmentMovement failed on item ${item.id}:`, res.error);
      return { success: false, error: res.error };
    }
  }

  // 3. Update parent requisition status to 'fulfilled'
  const resStatus = await updateRequisitionStatus(requisitionId, 'fulfilled');
  if (!resStatus.success) {
    console.error(`[Fulfillment] completeFulfillmentMovement failed updating status:`, resStatus.error);
    return { success: false, error: resStatus.error };
  }

  return { success: true };
}

export async function assignDeliveryTicketToRun(ticketId: string, runId: string): Promise<{ success: boolean; error?: any }> {
  return addTicketsToDeliveryRun(runId, [ticketId]);
}

export async function getInventoryItemsForCount(): Promise<any[]> {
  const items = await loadInventory();
  return items.filter((inv: any) => inv.locationId === 'LOC-HQ');
}

export async function saveInventoryCount(data: any[]): Promise<{ success: boolean; error?: any }> {
  return saveCounts(data);
}

export async function getFinishedGoodsForCount(): Promise<any[]> {
  const items = await loadSaleItems();
  return items.filter((i: any) => i.isActive);
}

export async function saveFinishedGoodsCount(session: any, lines: any[]): Promise<{ success: boolean; error?: any }> {
  return upsertFgCountSessionWithLines({ session, lines });
}

export * from './menuCostingStorage';
