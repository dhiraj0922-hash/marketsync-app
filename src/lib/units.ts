/**
 * src/lib/units.ts  — SINGLE SOURCE OF TRUTH for all unit/costing logic
 *
 * Architecture
 * ─────────────
 * This file is the ONE place in the entire app that may perform:
 *   • unit canonicalization
 *   • quantity conversion between measurement families
 *   • dimensional compatibility checks
 *   • ingredient line-cost computation (the THREE-PATH cost chain)
 *
 * No page, component, or library may inline:
 *   • rawItem.cost × qty
 *   • packCost ÷ packQty
 *   • ad-hoc normalizeUnit calls for costing
 *
 * All costing MUST route through computeIngredientLineCost().
 * All quantity normalisation MUST route through convertQuantity().
 *
 * ─── Exports ──────────────────────────────────────────────────────────────────
 *   UNIT_CANON              alias → canonical code map
 *   UNIT_FAMILIES           canonical code → { family, factor } for normalizeUnit
 *   DIMENSION               'weight' | 'volume' | 'each'  (new categorical type)
 *   getDimension()          canonical code → DIMENSION (or null)
 *   areDimensionsCompatible() check before conversion attempt
 *   canonicalizeUnit()      raw string → canonical code (or null)
 *   normalizeUnit()         qty conversion (throws on cross-family / unknown)
 *   convertQuantity()       safe wrapper around normalizeUnit — returns { qty, error }
 *   resolveEffectiveBaseUom() pick the correct costing base unit for an item
 *   computeBaseUnitCostFromPack()  pack-field cost decomposition (Path 1)
 *   CostAuditRecord                10-field breakdown from every successful cost result
 *   computeIngredientLineCost()    THE SINGLE COSTING ENTRYPOINT — all sites use this
 *   calculateIngredientLineCost()  named wrapper: { item, recipeQty, recipeUnit }
 *   auditItemUnitAmbiguity()       soft-warning audit for inventory items
 */

// ─── 1. Canonical alias table ─────────────────────────────────────────────────
//
// Maps every raw / alternate / misspelled unit string → canonical code.
// Key rule: keys are always lowercase & trimmed.
// Add new aliases here — all downstream functions pick them up automatically.

export const UNIT_CANON: Record<string, string> = {
  // ── Weight ────────────────────────────────────────────────────────────────
  g:   'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g',
  // 'gr' is a common data-entry alias for grams (not the troy grain).
  // We deliberately map it to 'g' so legacy DB rows using "gr" convert correctly.
  gr:  'g', grs: 'g',
  kg:  'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  mg:  'mg', milligram: 'mg', milligrams: 'mg',
  oz:  'oz', ounce: 'oz', ounces: 'oz',
  lb:  'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',

  // ── Volume (metric / SI) ─────────────────────────────────────────────────
  ml: 'ml', millilitre: 'ml', milliliter: 'ml', millilitres: 'ml', milliliters: 'ml',
  cl: 'cl', centilitre: 'cl', centiliter: 'cl', centilitres: 'cl', centiliters: 'cl',
  dl: 'dl', decilitre: 'dl', deciliter: 'dl', decilitres: 'dl', deciliters: 'dl',
  l:  'l',  litre: 'l', liter: 'l', litres: 'l', liters: 'l', lt: 'l',

  // ── Volume (imperial / culinary) ─────────────────────────────────────────
  'fl oz':    'fl oz',
  floz:       'fl oz',   // legacy canonical used in old code
  'fl-oz':    'fl oz',
  'fl. oz.':  'fl oz',
  'fl.oz.':   'fl oz',
  'fluid oz': 'fl oz',
  'fluid ounce':  'fl oz',
  'fluid ounces': 'fl oz',
  'fl. oz':   'fl oz',

  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp', 'tea spoon': 'tsp',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp', 'table spoon': 'tbsp',
  cup: 'cup', cups: 'cup',

  // ── Count / Each ─────────────────────────────────────────────────────────
  ea: 'ea', each: 'ea',
  pcs: 'ea', pc: 'ea', piece: 'ea', pieces: 'ea',
  unit: 'ea', units: 'ea',
  no: 'ea', nos: 'ea', number: 'ea',
  count: 'ea', cnt: 'ea',
  '1': 'ea',

  // ── Pack / Portion ────────────────────────────────────────────────────────
  pack: 'pack', packet: 'pack', pkt: 'pack', packs: 'pack',
  bunch: 'bunch', bunches: 'bunch',
  can: 'can', cans: 'can', tin: 'can', tins: 'can',
  bottle: 'bottle', bottles: 'bottle',
  bag: 'bag', bags: 'bag',
  box: 'box', boxes: 'box',
  case: 'case', cases: 'case',
  clove: 'clove', cloves: 'clove',
  sprig: 'sprig', sprigs: 'sprig',
  slice: 'slice', slices: 'slice',
  strip: 'strip', strips: 'strip',
  sheet: 'sheet', sheets: 'sheet',
  knob: 'knob',
};

// ─── 2. Conversion factors ────────────────────────────────────────────────────
//
// Maps canonical code → { family, factor }.
// factor = multiplier to convert 1 unit into the family's SI base:
//   mass base   = kg   (factor = qty_in_kg per 1 unit)
//   volume base = l    (factor = qty_in_litres per 1 unit)
//   count base  = ea   (all factor 1)

const UNIT_FAMILIES: Record<string, { family: string; factor: number }> = {
  // Weight — base: kg
  g:   { family: 'mass', factor: 0.001 },
  kg:  { family: 'mass', factor: 1 },
  mg:  { family: 'mass', factor: 0.000001 },
  oz:  { family: 'mass', factor: 0.028349523125 },   // exact per NIST
  lb:  { family: 'mass', factor: 0.45359237 },       // exact per NIST

  // Volume — base: l
  ml:     { family: 'volume', factor: 0.001 },
  cl:     { family: 'volume', factor: 0.01 },
  dl:     { family: 'volume', factor: 0.1 },
  l:      { family: 'volume', factor: 1 },
  'fl oz':{ family: 'volume', factor: 0.0295735296 }, // 1 US fl oz = 29.5735296 ml
  tsp:    { family: 'volume', factor: 0.00492892159 }, // 1 US tsp = 4.92892159 ml
  tbsp:   { family: 'volume', factor: 0.0147867648 },  // 1 US tbsp = 14.7867648 ml
  cup:    { family: 'volume', factor: 0.236588236 },   // 1 US cup = 236.588236 ml

  // Count — base: ea (all 1:1)
  ea:     { family: 'count', factor: 1 },
  pack:   { family: 'count', factor: 1 },
  box:    { family: 'count', factor: 1 },
  case:   { family: 'count', factor: 1 },
  can:    { family: 'count', factor: 1 },
  bottle: { family: 'count', factor: 1 },
  bag:    { family: 'count', factor: 1 },
  bunch:  { family: 'count', factor: 1 },
  clove:  { family: 'count', factor: 1 },
  sprig:  { family: 'count', factor: 1 },
  slice:  { family: 'count', factor: 1 },
  strip:  { family: 'count', factor: 1 },
  sheet:  { family: 'count', factor: 1 },
  knob:   { family: 'count', factor: 1 },
};

// ─── 3. Dimensional categories ────────────────────────────────────────────────
//
// High-level dimension used for compatibility checks.
// 'weight' and 'volume' are inter-convertible within themselves.
// 'each' cannot convert to weight or volume.

export type Dimension = 'weight' | 'volume' | 'each';

const FAMILY_TO_DIMENSION: Record<string, Dimension> = {
  mass:   'weight',
  volume: 'volume',
  count:  'each',
};

/**
 * Return the Dimension for a canonical unit code, or null if unrecognised.
 */
export function getDimension(canonicalCode: string): Dimension | null {
  const def = UNIT_FAMILIES[canonicalCode];
  if (!def) return null;
  return FAMILY_TO_DIMENSION[def.family] ?? null;
}

/**
 * Check whether two canonical unit codes can be converted to each other.
 * Returns true for same-family pairs (oz ↔ g, ml ↔ l) and same-unit pairs.
 * Returns false for cross-family (g ↔ ml, oz ↔ ea).
 */
export function areDimensionsCompatible(fromCanon: string, toCanon: string): boolean {
  if (fromCanon === toCanon) return true;
  const fromDef = UNIT_FAMILIES[fromCanon];
  const toDef   = UNIT_FAMILIES[toCanon];
  if (!fromDef || !toDef) return false;
  return fromDef.family === toDef.family;
}

// ─── 4. canonicalizeUnit ──────────────────────────────────────────────────────

/**
 * Resolve a raw unit string to its canonical code.
 *
 * Returns null if the string is unrecognised.
 * Handles: lowercase, trim, trailing punctuation stripping, plural-s stripping.
 *
 * Examples:
 *   "Fluid Ounces" → "fl oz"
 *   "litres"       → "l"
 *   "LBS"          → "lb"
 *   "fl. oz."      → "fl oz"
 *   "grams"        → "g"
 *   "gr"           → "g"      ← common data-entry alias for grams
 */
export function canonicalizeUnit(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;

  const clean = raw.trim().toLowerCase().replace(/[,;]+$/, '');
  if (!clean) return null;

  // Direct match
  if (UNIT_CANON[clean]) return UNIT_CANON[clean];

  // Multi-word lookup with normalised internal spaces (e.g. "fl  oz" → "fl oz")
  const spaceColl = clean.replace(/\s+/g, ' ');
  if (UNIT_CANON[spaceColl]) return UNIT_CANON[spaceColl];

  // Plural stripping: "grams" → "gram" → "g"
  if (clean.endsWith('s') && UNIT_CANON[clean.slice(0, -1)]) {
    return UNIT_CANON[clean.slice(0, -1)];
  }

  return null;
}

// ─── 5. normalizeUnit ─────────────────────────────────────────────────────────

/**
 * Convert `qty` from one unit to another within the same measurement family.
 *
 * Both inputs are resolved through UNIT_CANON before conversion, so raw DB
 * strings ("fl oz", "litre", "lbs", "gr") all work without caller changes.
 *
 * Throws — with a descriptive message — for:
 *   • unrecognised unit strings
 *   • cross-family pairs (mass ↔ volume, volume ↔ each, etc.)
 *
 * IMPORTANT: prefer convertQuantity() at call-sites that want a { qty, error }
 * result instead of a thrown exception.
 */
export function normalizeUnit(qty: number, fromUnitRaw: string, toUnitRaw: string): number {
  if (qty === 0) return 0;

  const fromCanon = canonicalizeUnit(fromUnitRaw) ?? fromUnitRaw.trim().toLowerCase();
  const toCanon   = canonicalizeUnit(toUnitRaw)   ?? toUnitRaw.trim().toLowerCase();

  if (fromCanon === toCanon) return qty;

  const fromDef = UNIT_FAMILIES[fromCanon];
  const toDef   = UNIT_FAMILIES[toCanon];

  if (!fromDef || !toDef || fromDef.family !== toDef.family) {
    const hint =
      !fromDef
        ? `"${fromUnitRaw}" is not a recognised unit`
        : !toDef
        ? `"${toUnitRaw}" is not a recognised unit`
        : `"${fromUnitRaw}" (${FAMILY_TO_DIMENSION[fromDef.family] ?? fromDef.family}) ` +
          `cannot convert to "${toUnitRaw}" (${FAMILY_TO_DIMENSION[toDef.family] ?? toDef.family}) — ` +
          `incompatible dimensions`;
    throw new Error(`Unit conversion error: ${hint}`);
  }

  // Convert: qty → family SI base → target unit
  const baseQty   = qty * fromDef.factor;
  const targetQty = baseQty / toDef.factor;
  return Math.round(targetQty * 1_000_000) / 1_000_000;
}

// ─── 6. convertQuantity — safe non-throwing wrapper ──────────────────────────

export type ConvertQuantityResult =
  | { ok: true;  qty: number; fromCanon: string; toCanon: string }
  | { ok: false; qty: null;   error: string; fromCanon: string | null; toCanon: string | null };

/**
 * Safe wrapper around normalizeUnit that never throws.
 *
 * Use this instead of normalizeUnit() everywhere you need a { ok, qty, error }
 * result rather than a try/catch. All production/requisition deduction logic
 * MUST use this so conversion errors are surfaced clearly instead of silently
 * using raw quantities.
 */
export function convertQuantity(
  qty: number,
  fromUnitRaw: string,
  toUnitRaw:   string,
): ConvertQuantityResult {
  const fromCanon = canonicalizeUnit(fromUnitRaw) ?? null;
  const toCanon   = canonicalizeUnit(toUnitRaw)   ?? null;

  try {
    const converted = normalizeUnit(qty, fromUnitRaw, toUnitRaw);
    return {
      ok:        true,
      qty:       converted,
      fromCanon: fromCanon ?? fromUnitRaw.trim().toLowerCase(),
      toCanon:   toCanon   ?? toUnitRaw.trim().toLowerCase(),
    };
  } catch (err: any) {
    return {
      ok:        false,
      qty:       null,
      error:     err?.message ?? 'Unit conversion error',
      fromCanon,
      toCanon,
    };
  }
}

// ─── 7. resolveEffectiveBaseUom ───────────────────────────────────────────────

/**
 * Resolve the effective canonical costing unit for an inventory item.
 *
 * Priority:
 *   1. base_uom (new, explicit)        → item.baseUomNew
 *   2. baseunit (legacy DB column)     → item.baseUnit
 *   3. unit (display unit, last resort)→ item.unit
 *   4. 'ea' (hard fallback, never empty)
 *
 * Used by computeIngredientLineCost so both the constraint checker and the
 * recipe builder use the identical target unit.
 */
export function resolveEffectiveBaseUom(item: {
  baseUomNew?: string | null;
  baseUnit?:   string | null;
  unit?:       string | null;
}): string {
  return (
    item.baseUomNew?.trim() ||
    item.baseUnit?.trim()   ||
    item.unit?.trim()       ||
    'ea'
  );
}

// ─── 8. computeBaseUnitCostFromPack — Path 1 cost ────────────────────────────

/**
 * Compute cost per base unit from the structured pack fields (read-time only).
 *
 * Formula:
 *   totalBaseUnits = normalizeUnit(packQty × innerUnitSize, innerUnitUom → baseUom)
 *   costPerBaseUnit = purchaseCost / totalBaseUnits
 *
 * Returns null if any required field is missing/zero or units are incompatible.
 * Caller (computeIngredientLineCost) falls back to Path 2 → Path 3 on null.
 * Per architecture decision: this result is NEVER written back to item.cost.
 */
export function computeBaseUnitCostFromPack(item: {
  purchaseCost?:  number | null;
  packQty?:       number | null;
  innerUnitSize?: number | null;
  innerUnitUom?:  string | null;
  baseUomNew?:    string | null;
  baseUnit?:      string | null;
  unit?:          string | null;
}): number | null {
  const { purchaseCost, packQty, innerUnitSize, innerUnitUom } = item;

  if (
    purchaseCost  == null || purchaseCost  <= 0 ||
    packQty       == null || packQty       <= 0 ||
    innerUnitSize == null || innerUnitSize <= 0 ||
    !innerUnitUom?.trim()
  ) return null;

  const baseUom = resolveEffectiveBaseUom(item);
  if (!baseUom || baseUom === 'ea') return null;

  try {
    const totalInnerQty  = packQty * innerUnitSize;
    const totalBaseUnits = normalizeUnit(totalInnerQty, innerUnitUom, baseUom);
    if (totalBaseUnits <= 0) return null;
    return purchaseCost / totalBaseUnits;
  } catch {
    return null;
  }
}

// ─── 9. computeIngredientLineCost — THE SINGLE COSTING ENTRYPOINT ────────────

/**
 * Compute the cost for one recipe ingredient line.
 *
 * This is the ONLY function in the entire application that may perform
 * ingredient cost math. All pages/components MUST call this.
 *
 * Algorithm
 * ─────────
 * 1. Resolve item's canonical base unit: resolveEffectiveBaseUom(invItem)
 * 2. Convert recipe qty into that base unit: normalizeUnit(recipeQty, recipeUnit, baseUnit)
 * 3. Resolve cost per base unit — three-path priority chain:
 *      Path 1 (BEST): structured pack fields (computeBaseUnitCostFromPack)
 *      Path 2: purchaseUnits JSONB → purchaseCost ÷ primary.conversion
 *      Path 3 (LEGACY): item.cost is already the per-base-unit cost
 * 4. line cost = normalizedQty × effectiveBaseCost
 *
 * Correct example:
 *   Pack 380 gr, cost $4.50, recipe uses 24 oz
 *   → baseUnit = 'g'
 *   → normalizedQty = normalizeUnit(24, 'oz', 'g') = 680.388 g
 *   → effectiveBaseCost = 4.50 / 380 = 0.011842 $/g   (via Path 1 or purchaseUnits)
 *   → lineCost = 680.388 × 0.011842 = $8.06 ✓
 *
 * @param recipeQty   Quantity specified in the recipe
 * @param recipeUnit  Unit specified in the recipe (raw string, any recognised alias)
 * @param invItem     The inventory item (front-end camelCase shape from storage.ts)
 *
 * @returns
 *   ok: true   → { cost, normalizedQty, baseUnit, costPerBaseUnit, costAudit }
 *   ok: false  → { error, normalizedQty (null), baseUnit }
 */

/** Full breakdown carried in every successful costing result. Rendered in audit panels. */
export type CostAuditRecord = {
  itemName:            string;
  measurementFamily:   string;   // '' when not set on the item
  purchaseUnit:        string;   // purchaseUom / purchase unit label, '' if not set
  purchaseCost:        number;   // raw purchaseCost field on the item
  baseQtyPerPurchUnit: number | null;  // computed from pack fields (Path 1) or purchaseUnits
  costPerBaseUnit:     number;   // effectiveBaseCost ($/<baseUnit>)
  recipeQty:           number;
  recipeUnit:          string;
  normalizedRecipeQty: number;   // recipeQty converted to baseUnit
  calculatedCost:      number;   // final line cost
  costPath:            1 | 2 | 3;
  costPathLabel:
    | 'direct_base_unit'
    | 'measurement_unit_conversion'
    | 'purchase_unit_conversion'
    | 'labour_cost'
    | 'prep_cost'
    | 'fallback_cost';
  baseUnit:            string;
};

export type IngredientLineCostResult =
  | {
      ok:             true;
      cost:           number;   // total line cost ($)
      normalizedQty:  number;   // qty in item's base unit
      baseUnit:       string;   // effective base unit used
      costPerBaseUnit:number;   // cost per base unit ($)
      costPath:       1 | 2 | 3; // which path resolved the cost
      costPathLabel:   CostAuditRecord['costPathLabel'];
      costAudit:      CostAuditRecord;
    }
  | {
      ok:             false;
      cost:           0;
      normalizedQty:  null;
      baseUnit:       string;
      costPerBaseUnit:0;
      error:          string;
    };

const normalizeCostUnitLabel = (unit: string | null | undefined) =>
  String(unit ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const getPurchaseUnitCandidates = (invItem: {
  purchaseUom?: string | null;
  purchaseUnits?: Array<{ name?: string | null; label?: string | null; unit?: string | null; isPrimary?: boolean; conversion: number }> | null;
}) => {
  const candidates: Array<{ label: string; conversion: number | null }> = [];
  if (invItem.purchaseUom?.trim()) candidates.push({ label: invItem.purchaseUom, conversion: null });
  for (const unit of invItem.purchaseUnits ?? []) {
    const label = unit.name ?? unit.label ?? unit.unit ?? '';
    if (label?.trim()) candidates.push({ label, conversion: Number(unit.conversion ?? 0) || null });
  }
  return candidates;
};

const findExactPurchaseUnitMatch = (
  recipeUnit: string,
  invItem: {
    purchaseUom?: string | null;
    purchaseUnits?: Array<{ name?: string | null; label?: string | null; unit?: string | null; isPrimary?: boolean; conversion: number }> | null;
  },
) => {
  const recipeLabel = normalizeCostUnitLabel(recipeUnit);
  if (!recipeLabel) return null;
  return getPurchaseUnitCandidates(invItem).find(candidate =>
    normalizeCostUnitLabel(candidate.label) === recipeLabel
  ) ?? null;
};

const resolveBaseQtyPerPurchaseUnit = (
  invItem: Parameters<typeof computeBaseUnitCostFromPack>[0] & {
    purchaseUnits?: Array<{ name?: string | null; label?: string | null; unit?: string | null; isPrimary?: boolean; conversion: number }> | null;
  },
  baseUnit: string,
): number | null => {
  if (
    invItem.packQty       != null && invItem.packQty       > 0 &&
    invItem.innerUnitSize != null && invItem.innerUnitSize > 0 &&
    invItem.innerUnitUom?.trim()
  ) {
    try {
      const totalInnerQty = invItem.packQty * invItem.innerUnitSize;
      const converted = normalizeUnit(totalInnerQty, invItem.innerUnitUom, baseUnit);
      if (converted > 0) return converted;
    } catch { /* fallback below */ }
  }

  const primary = invItem.purchaseUnits?.find((u) => u.isPrimary) ?? invItem.purchaseUnits?.[0];
  const conversion = Number(primary?.conversion ?? 0);
  return conversion > 0 ? conversion : null;
};

export function computeIngredientLineCost(
  recipeQty:  number,
  recipeUnit: string,
  invItem: {
    name?:              string | null;
    measurementFamily?: string | null;   // NEW: locked family from inventory engine
    cost?:              number | null;
    purchaseCost?:      number | null;
    purchaseUnits?:     Array<{ name?: string | null; label?: string | null; unit?: string | null; isPrimary?: boolean; conversion: number }> | null;
    packQty?:           number | null;
    innerUnitSize?:     number | null;
    innerUnitUom?:      string | null;
    baseUomNew?:        string | null;
    baseUnit?:          string | null;
    unit?:              string | null;
    // Structured pack fields (new model — map to Path 1 via computeBaseUnitCostFromPack)
    purchaseUom?:       string | null;
  },
): IngredientLineCostResult {
  const baseUnit = resolveEffectiveBaseUom(invItem);

  // ── Step 1: Cost per base unit — shared chain ─────────────────────────────
  let effectiveBaseCost: number;
  let costPath: 1 | 2 | 3;
  let costPathLabel: CostAuditRecord['costPathLabel'];
  let baseQtyPerPurchUnit: number | null = null;

  // Path 1: structured pack fields (purchaseCost, packQty, innerUnitSize, innerUnitUom)
  const structuredCost = computeBaseUnitCostFromPack(invItem);
  if (structuredCost !== null) {
    effectiveBaseCost = structuredCost;
    costPath          = 1;
    costPathLabel     = 'measurement_unit_conversion';
    baseQtyPerPurchUnit = resolveBaseQtyPerPurchaseUnit(invItem, baseUnit);
  } else if (invItem.purchaseUnits && invItem.purchaseUnits.length > 0) {
    // Path 2: legacy purchaseUnits JSONB
    const primary = invItem.purchaseUnits.find((u) => u.isPrimary) ?? invItem.purchaseUnits[0];
    const purchCost =
      invItem.purchaseCost !== undefined && invItem.purchaseCost !== null
        ? Number(invItem.purchaseCost)
        : Number(invItem.cost ?? 0) * primary.conversion; // reconstruct if purchaseCost missing
    effectiveBaseCost   = purchCost / primary.conversion;
    costPath            = 2;
    costPathLabel       = 'purchase_unit_conversion';
    baseQtyPerPurchUnit = primary.conversion;
  } else {
    // Path 3: item.cost is already the per-base-unit cost (legacy)
    effectiveBaseCost   = Number(invItem.cost ?? 0);
    costPath            = 3;
    costPathLabel       = 'fallback_cost';
    baseQtyPerPurchUnit = null;
  }

  // ── Step 2: Quantity conversion priority ─────────────────────────────────
  // Measurement units win when compatible. Purchase-pack conversion is used
  // only when the recipe unit exactly matches a purchase unit label.
  let normalizedQty: number | null = null;
  const convResult = convertQuantity(recipeQty, recipeUnit, baseUnit);
  const conversionError = convResult.ok ? '' : convResult.error;
  if (convResult.ok) {
    normalizedQty = convResult.qty!;
    costPathLabel = normalizeCostUnitLabel(recipeUnit) === normalizeCostUnitLabel(baseUnit)
      ? 'direct_base_unit'
      : costPathLabel === 'fallback_cost'
        ? 'measurement_unit_conversion'
        : costPathLabel;
  } else {
    const purchaseMatch = findExactPurchaseUnitMatch(recipeUnit, invItem);
    const packConversion = baseQtyPerPurchUnit ?? purchaseMatch?.conversion ?? null;
    if (purchaseMatch && packConversion && packConversion > 0) {
      normalizedQty = recipeQty * packConversion;
      costPathLabel = 'purchase_unit_conversion';
    }
  }

  if (normalizedQty == null) {
    return {
      ok:             false,
      cost:           0,
      normalizedQty:  null,
      baseUnit,
      costPerBaseUnit:0,
      error:          conversionError || `Unit conversion error: "${recipeUnit}" cannot convert to "${baseUnit}"`,
    };
  }

  const cost = normalizedQty * effectiveBaseCost;
  const roundedCost = Math.round(cost * 1_000_000) / 1_000_000;

  const costAudit: CostAuditRecord = {
    itemName:            invItem.name?.trim()         ?? 'Unknown',
    measurementFamily:   invItem.measurementFamily?.trim() ?? '',
    purchaseUnit:        invItem.purchaseUom?.trim()  ?? '',
    purchaseCost:        Number(invItem.purchaseCost  ?? invItem.cost ?? 0),
    baseQtyPerPurchUnit,
    costPerBaseUnit:     effectiveBaseCost,
    recipeQty,
    recipeUnit,
    normalizedRecipeQty: normalizedQty,
    calculatedCost:      roundedCost,
    costPath,
    costPathLabel,
    baseUnit,
  };

  if (process.env.NODE_ENV === 'development') {
    const invalid = [
      ['lineCost', roundedCost],
      ['normalizedQty', normalizedQty],
      ['costPerBaseUnit', effectiveBaseCost],
    ].find(([, value]) => Number.isNaN(value));
    if (invalid) {
      console.warn('[CostAudit] Invalid ingredient cost output', {
        field: invalid[0],
        item: invItem.name,
        recipeQty,
        recipeUnit,
        baseUnit,
        costAudit,
      });
    }
    const recipeCanon = canonicalizeUnit(recipeUnit);
    const baseCanon = canonicalizeUnit(baseUnit);
    if (
      costPathLabel === 'purchase_unit_conversion' &&
      recipeCanon &&
      baseCanon &&
      areDimensionsCompatible(recipeCanon, baseCanon)
    ) {
      console.warn('[CostAudit] Purchase conversion used for measurement unit', {
        item: invItem.name,
        recipeQty,
        recipeUnit,
        baseUnit,
        costAudit,
      });
    }
  }

  return {
    ok:             true,
    cost:           roundedCost,
    normalizedQty,
    baseUnit,
    costPerBaseUnit:effectiveBaseCost,
    costPath,
    costPathLabel,
    costAudit,
  };
}

// ─── 9b. calculateIngredientLineCost — named wrapper (user-facing API) ────────

/**
 * Named wrapper around computeIngredientLineCost that accepts the
 * user-facing parameter shape: { item, recipeQty, recipeUnit }.
 *
 * This is the canonical export referenced by recipe and production pages.
 * Both modules MUST call this (or computeIngredientLineCost directly)
 * and MUST NOT perform any inline cost arithmetic.
 *
 * @example
 *   const result = calculateIngredientLineCost({ item: invItem, recipeQty: 100, recipeUnit: 'g' });
 *   if (result.ok) console.log(result.costAudit);
 */
export function calculateIngredientLineCost({
  item,
  recipeQty,
  recipeUnit,
}: {
  item:       Parameters<typeof computeIngredientLineCost>[2];
  recipeQty:  number;
  recipeUnit: string;
}): IngredientLineCostResult {
  return computeIngredientLineCost(recipeQty, recipeUnit, item);
}

export function calculateIngredientCost({
  item,
  quantity,
  unit,
  context = 'recipe',
}: {
  item: Parameters<typeof computeIngredientLineCost>[2];
  quantity: number;
  unit: string;
  context?: 'recipe' | 'production' | string;
}): IngredientLineCostResult extends infer R
  ? R extends { ok: true }
    ? R & {
        lineCost: number;
        normalizedUnit: string;
        audit: CostAuditRecord & { context: string; enteredQty: number; enteredUnit: string };
      }
    : IngredientLineCostResult
  : never {
  const result = computeIngredientLineCost(quantity, unit, item);
  if (!result.ok) return result as any;
  return {
    ...result,
    lineCost: result.cost,
    normalizedUnit: result.baseUnit,
    audit: {
      ...result.costAudit,
      context,
      enteredQty: quantity,
      enteredUnit: unit,
    },
  } as any;
}

// ─── 10. auditItemUnitAmbiguity — soft-warning audit ─────────────────────────

/**
 * Return soft-warning strings for an inventory item whose unit fields are
 * ambiguous or inconsistent. Shown as ⚠ badges in the recipe builder.
 * These never block saving — they are informational only.
 */
export function auditItemUnitAmbiguity(
  item: {
    name?:              string | null;
    measurementFamily?: string | null;
    baseUomNew?:        string | null;
    baseUnit?:          string | null;
    unit?:              string | null;
    innerUnitUom?:      string | null;
    allowedRecipeUoms?: string[] | null;
  },
  usedUnit?: string | null,
): string[] {
  const warnings: string[] = [];
  const effectiveBase = resolveEffectiveBaseUom(item);
  const label = item.name || 'This item';

  // 1. No meaningful base unit
  if (!effectiveBase || effectiveBase === 'ea') {
    warnings.push(
      `"${label}" has no specific base unit — pack-level cost computation is disabled. Costing uses item.cost directly.`,
    );
  }

  // 2. base_uom conflicts with existing baseunit (informational)
  const legacyBase = item.baseUnit?.trim();
  const newBase    = item.baseUomNew?.trim();
  if (newBase && legacyBase && newBase !== legacyBase) {
    try {
      normalizeUnit(1, newBase, legacyBase);
    } catch {
      warnings.push(
        `"${label}" base_uom="${newBase}" and baseunit="${legacyBase}" are in different measurement families. base_uom takes priority for costing.`,
      );
    }
  }

  // 3. inner_unit_uom cannot convert to effectiveBase
  const innerUom = item.innerUnitUom?.trim();
  if (innerUom && effectiveBase && effectiveBase !== 'ea') {
    try {
      normalizeUnit(1, innerUom, effectiveBase);
    } catch {
      warnings.push(
        `"${label}" inner_unit_uom="${innerUom}" cannot convert to costing unit "${effectiveBase}" — they are different measurement families. Pack cost computation falls back to legacy.`,
      );
    }
  }

  // 4. Soft warning: recipe ingredient unit not in allowed_recipe_uoms
  if (
    usedUnit &&
    Array.isArray(item.allowedRecipeUoms) &&
    item.allowedRecipeUoms.length > 0
  ) {
    const usedCanon     = canonicalizeUnit(usedUnit) ?? usedUnit.trim().toLowerCase();
    const isWhitelisted = item.allowedRecipeUoms.some(
      (u) => (canonicalizeUnit(u) ?? u.trim().toLowerCase()) === usedCanon,
    );
    if (!isWhitelisted) {
      warnings.push(
        `"${label}" does not list "${usedUnit}" as an allowed recipe unit. Costing may be inaccurate — allowed: ${item.allowedRecipeUoms.join(', ')}.`,
      );
    }
  }

  return warnings;
}
