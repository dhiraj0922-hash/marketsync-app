/**
 * src/lib/units.ts
 *
 * Canonical unit system for recipe costing and AI import.
 *
 * Structure:
 *  1. UNIT_CANON  — maps every raw string variant → canonical code
 *  2. UNIT_FAMILIES — conversion factors for each canonical code
 *  3. canonicalizeUnit(raw) — resolve a raw string to a canonical code (or null)
 *  4. normalizeUnit(qty, from, to) — convert qty between any two units in the
 *     same family. Both from/to are resolved through UNIT_CANON first, so raw
 *     DB strings like "fl oz", "litre", "lbs", "fluid ounce" all work.
 *
 * Root cause this fixes:
 *   normalizeUnit received raw strings from the DB (invItem.baseUnit / invItem.unit)
 *   which it could not look up because its internal table only contained canonical
 *   codes. "fl oz" stored in the DB → not in table → Unit conversion error → Math Error.
 *   Now both inputs are canonicalized before lookup, so every recognised spelling works.
 */

// ─── 1. Canonical alias table ─────────────────────────────────────────────────
//
// Maps every raw / alternate / misspelled unit string → canonical code.
// Key rule: keys are always lowercase & trimmed (normalizeUnit handles that).
// Add new aliases here — normalizeUnit and canonicalizeUnit pick them up automatically.

export const UNIT_CANON: Record<string, string> = {
  // ── Weight ────────────────────────────────────────────────────────────────
  g: "g", gm: "g", gms: "g", gram: "g", grams: "g",
  kg: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  mg: "mg", milligram: "mg", milligrams: "mg",
  oz: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",

  // ── Volume (metric / SI) ─────────────────────────────────────────────────
  ml: "ml", millilitre: "ml", milliliter: "ml", millilitres: "ml", milliliters: "ml",
  cl: "cl", centilitre: "cl", centiliter: "cl", centilitres: "cl", centiliters: "cl",
  dl: "dl", decilitre: "dl", deciliter: "dl", decilitres: "dl", deciliters: "dl",
  l: "l", litre: "l", liter: "l", litres: "l", liters: "l", lt: "l",

  // ── Volume (imperial / culinary) ─────────────────────────────────────────
  // "fl oz" is the canonical code for fluid ounces (not "floz") because
  // the user's requirement spells it "fl oz" and it reads more naturally.
  // All aliases — including the legacy "floz" code — resolve to "fl oz".
  "fl oz": "fl oz",
  floz: "fl oz",          // legacy canonical used in previous code → mapped here
  "fl-oz": "fl oz",
  "fl. oz.": "fl oz",
  "fl.oz.": "fl oz",
  "fluid oz": "fl oz",
  "fluid ounce": "fl oz",
  "fluid ounces": "fl oz",
  "fl. oz": "fl oz",

  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp", "tea spoon": "tsp",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", tbs: "tbsp", "table spoon": "tbsp",
  cup: "cup", cups: "cup",

  // ── Count / Each — all map to "ea" ───────────────────────────────────────
  ea: "ea", each: "ea",
  pcs: "ea", pc: "ea", piece: "ea", pieces: "ea",
  unit: "ea", units: "ea",
  no: "ea", nos: "ea", number: "ea",
  count: "ea", cnt: "ea",
  "1": "ea",

  // ── Pack / Portion ────────────────────────────────────────────────────────
  pack: "pack", packet: "pack", pkt: "pack", packs: "pack",
  bunch: "bunch", bunches: "bunch",
  can: "can", cans: "can", tin: "can", tins: "can",
  bottle: "bottle", bottles: "bottle",
  bag: "bag", bags: "bag",
  box: "box", boxes: "box",
  case: "case", cases: "case",
  clove: "clove", cloves: "clove",
  sprig: "sprig", sprigs: "sprig",
  slice: "slice", slices: "slice",
  strip: "strip", strips: "strip",
  sheet: "sheet", sheets: "sheet",
  knob: "knob",
};

// ─── 2. Conversion factors ────────────────────────────────────────────────────
//
// Maps canonical code → { family, factor }.
// factor is the multiplier to convert 1 unit into the family's base:
//   mass base = kg, volume base = l, count base = ea (all factor 1).

const UNIT_FAMILIES: Record<string, { family: string; factor: number }> = {
  // Weight — base unit: kg
  g:   { family: "mass",   factor: 0.001 },
  kg:  { family: "mass",   factor: 1 },
  mg:  { family: "mass",   factor: 0.000001 },
  oz:  { family: "mass",   factor: 0.0283495 },   // 1 oz = 28.3495 g
  lb:  { family: "mass",   factor: 0.453592 },    // 1 lb = 453.592 g

  // Volume — base unit: l
  ml:     { family: "volume", factor: 0.001 },
  cl:     { family: "volume", factor: 0.01 },
  dl:     { family: "volume", factor: 0.1 },
  l:      { family: "volume", factor: 1 },
  "fl oz":{ family: "volume", factor: 0.0295735 }, // 1 fl oz = 29.5735 ml
  tsp:    { family: "volume", factor: 0.00492892 }, // 1 tsp = 4.92892 ml
  tbsp:   { family: "volume", factor: 0.0147868 },  // 1 tbsp = 14.7868 ml
  cup:    { family: "volume", factor: 0.236588 },   // 1 cup = 236.588 ml

  // Count — base unit: ea (all factor 1, 1:1 within family)
  ea:     { family: "count", factor: 1 },
  pack:   { family: "count", factor: 1 },
  box:    { family: "count", factor: 1 },
  case:   { family: "count", factor: 1 },
  can:    { family: "count", factor: 1 },
  bottle: { family: "count", factor: 1 },
  bag:    { family: "count", factor: 1 },
  bunch:  { family: "count", factor: 1 },
  clove:  { family: "count", factor: 1 },
  sprig:  { family: "count", factor: 1 },
  slice:  { family: "count", factor: 1 },
  strip:  { family: "count", factor: 1 },
  sheet:  { family: "count", factor: 1 },
  knob:   { family: "count", factor: 1 },
};

// ─── 3. canonicalizeUnit ──────────────────────────────────────────────────────

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
 */
export function canonicalizeUnit(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;

  const clean = raw.trim().toLowerCase().replace(/[,;]+$/, "");
  if (!clean) return null;

  // Direct match
  if (UNIT_CANON[clean]) return UNIT_CANON[clean];

  // Multi-word lookup with normalised internal spaces (e.g. "fl  oz" → "fl oz")
  const spaceColl = clean.replace(/\s+/g, " ");
  if (UNIT_CANON[spaceColl]) return UNIT_CANON[spaceColl];

  // Plural stripping: "grams" → "gram" → "g"
  if (clean.endsWith("s") && UNIT_CANON[clean.slice(0, -1)]) {
    return UNIT_CANON[clean.slice(0, -1)];
  }

  return null;
}

// ─── 4. normalizeUnit ─────────────────────────────────────────────────────────

/**
 * Convert `qty` from one unit to another within the same measurement family.
 *
 * Both `fromUnitBase` and `toUnitBase` are resolved through the canonical alias
 * table before conversion, so raw DB strings (e.g. "fl oz", "litre", "lbs") and
 * canonical codes (e.g. "l", "kg", "ea") both work at every call site without
 * any changes to callers.
 *
 * Supported conversions (cross-family within same dimension auto-convert):
 *   Mass:   g ↔ kg ↔ lb ↔ oz  (and mg)
 *   Volume: ml ↔ l ↔ fl oz ↔ tsp ↔ tbsp ↔ cup  (and cl, dl)
 *   Count:  ea ↔ pcs ↔ pack ↔ box ↔ case ↔ can ↔ bottle …
 *
 * Cross-family (mass ↔ volume, ea ↔ kg, etc.) throws with a descriptive message.
 * Unknown unit strings throw with the unrecognised raw value in the message.
 *
 * @param qty      Quantity in the source unit
 * @param fromUnitBase  Source unit (raw or canonical)
 * @param toUnitBase    Target unit (raw or canonical)
 * @returns Converted quantity, rounded to 6 decimal places
 */
export function normalizeUnit(qty: number, fromUnitBase: string, toUnitBase: string): number {
  if (qty === 0) return 0;

  // Canonicalize both inputs through the alias table
  const fromCanon = canonicalizeUnit(fromUnitBase) ?? fromUnitBase.trim().toLowerCase();
  const toCanon   = canonicalizeUnit(toUnitBase)   ?? toUnitBase.trim().toLowerCase();

  // Identical canonical units — no conversion needed (handles ea↔ea, kg↔kg, etc.)
  if (fromCanon === toCanon) return qty;

  const fromDef = UNIT_FAMILIES[fromCanon];
  const toDef   = UNIT_FAMILIES[toCanon];

  if (!fromDef || !toDef || fromDef.family !== toDef.family) {
    const hint =
      !fromDef
        ? `"${fromUnitBase}" is not a recognised unit`
        : !toDef
        ? `"${toUnitBase}" is not a recognised unit`
        : `"${fromUnitBase}" (${fromDef.family}) cannot convert to "${toUnitBase}" (${toDef.family}) — they are in different measurement families`;
    throw new Error(`Unit conversion error: ${hint}`);
  }

  // Convert: qty → family base → target unit
  const baseQty   = qty * fromDef.factor;
  const targetQty = baseQty / toDef.factor;

  // Round to 6 decimal places
  return Math.round(targetQty * 1_000_000) / 1_000_000;
}
