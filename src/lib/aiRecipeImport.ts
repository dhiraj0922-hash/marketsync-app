/**
 * src/lib/aiRecipeImport.ts
 *
 * AI Recipe Import — Service Layer
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure TypeScript / client-safe module.
 * No Supabase calls — can run in browser or server context.
 *
 * Responsibilities:
 *  1. Parse fractions from raw text ("1/2", "1 1/2", "¼")
 *  2. Normalize raw unit strings to canonical codes ("grams" → "g", "kilo" → "kg")
 *  3. Flag ambiguous/unmappable units ("handful", "pinch", "bowl")
 *  4. Fuzzy-match ingredient raw text against inventory items
 *  5. Build ReviewRow[] from the AI extraction JSON
 *  6. Compute line-level confidence scores and status flags
 */

import { UNIT_CANON, canonicalizeUnit } from "./units";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Raw item as returned from the AI extraction API */
export interface AiExtractedItem {
  line_number: number;
  ingredient_raw: string;
  qty_raw: string;
  qty_numeric: number | null;
  unit_raw: string;
  prep_note_raw: string;
  confidence_score: number;
}

/** Full AI extraction result */
export interface AiExtractionResult {
  recipe_name: string;
  recipe_type: string;
  servings_or_yield: string;
  notes: string;
  items: AiExtractedItem[];
}

/** Row status after normalization + matching */
export type RowStatus =
  | "matched"           // inventory item found, unit canonical, qty parseable
  | "low_confidence"    // match found but confidence < threshold
  | "needs_ingredient"  // no inventory match
  | "needs_unit"        // unit unknown or ambiguous
  | "missing_qty"       // quantity could not be parsed
  | "warning";          // multiple issues

/** A single review row shown in the review table */
export interface ReviewRow {
  lineNumber: number;
  ingredientRaw: string;
  qtyRaw: string;
  qtyNumeric: number | null;
  unitRaw: string;
  prepNote: string;
  aiConfidence: number;

  // Normalized / matched
  canonicalUnit: string | null;    // canonical unit code (g, kg, ml, etc.) or null
  unitAmbiguous: boolean;          // if unit is flagged as ambiguous (handful, etc.)
  unitWarning: string | null;      // human-readable warning for unit

  matchedInventoryId: string | null;  // inventory item id if matched
  matchedInventoryName: string | null;
  matchScore: number;              // 0–1
  suggestions: { id: string; name: string; score: number }[]; // top-3 alternatives

  status: RowStatus;
  warnings: string[];              // human-readable warning strings

  // User-overrideable (starts as matched defaults, user can change in UI)
  resolvedInventoryId: string | null;
  resolvedUnit: string | null;
  resolvedQty: number | null;
  resolvedPrepNote: string;

  // Track if user has manually reviewed this row
  userResolved: boolean;
}

// ─── Unit alias dictionary ──────────────────────────────────────────────────
//
// Single source of truth: UNIT_CANON is imported from units.ts.
// Both the AI import pipeline and recipe costing (normalizeUnit) share the same
// table — add aliases in units.ts and they automatically work in both systems.
//
// The local alias below keeps backward-compat for any internal code that
// referenced UNIT_ALIASES by name.
const UNIT_ALIASES = UNIT_CANON;

/**
 * Units that cannot be confidently normalized.
 * These are flagged for user review rather than silently mapped.
 */
const AMBIGUOUS_UNITS = new Set([
  "handful", "handfuls",
  "pinch", "pinches",
  "dash", "dashes",
  "splash",
  "bowl", "bowls",
  "tray", "trays",
  "plate", "plates",
  "scoop", "scoops",
  "dollop", "dollops",
  "portion", "portions",
  "serving", "servings",
  "to taste", "tt",
  "as needed", "q.s.", "qs",
  "some",
]);

// ─── Fraction parser ────────────────────────────────────────────────────────

/**
 * Parse a raw quantity string into a numeric value.
 *
 * Handles:
 *  - Integers: "2" → 2
 *  - Simple fractions: "1/2" → 0.5, "3/4" → 0.75
 *  - Mixed fractions: "1 1/2" → 1.5, "2 3/4" → 2.75
 *  - Unicode fractions: "½" → 0.5, "¼" → 0.25, "¾" → 0.75, "⅓" → 0.333
 *  - Decimal strings: "0.5" → 0.5
 *  - Approximate: "~2" → 2
 *  Returns null if cannot parse.
 */
export function parseFraction(raw: string): number | null {
  if (!raw || typeof raw !== "string") return null;

  // Strip non-numeric noise (tildes, "approx", "about")
  let s = raw.trim().toLowerCase()
    .replace(/approx\.?|about|~|±/g, "")
    .trim();

  if (!s) return null;

  // Unicode fraction map
  const unicodeFractions: Record<string, number> = {
    "½": 0.5, "⅓": 1/3, "⅔": 2/3,
    "¼": 0.25, "¾": 0.75,
    "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
    "⅙": 1/6, "⅚": 5/6,
    "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
  };

  // Replace unicode fractions first (may appear in mixed e.g. "1½")
  for (const [uf, val] of Object.entries(unicodeFractions)) {
    s = s.replace(uf, ` ${val}`);
  }
  s = s.trim();

  // Mixed fraction: "1 1/2" or "1 0.5"
  const mixedMatch = s.match(/^(\d+)\s+([\d.]+(?:\/[\d.]+)?)$/);
  if (mixedMatch) {
    const whole = parseFloat(mixedMatch[1]);
    const frac = parseFraction(mixedMatch[2]);
    if (frac !== null) return whole + frac;
  }

  // Simple fraction: "1/2"
  const fracMatch = s.match(/^(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)$/);
  if (fracMatch) {
    const num = parseFloat(fracMatch[1]);
    const den = parseFloat(fracMatch[2]);
    if (den === 0) return null;
    return num / den;
  }

  // Plain number
  const num = parseFloat(s);
  return isNaN(num) ? null : num;
}

// ─── Unit normalization ─────────────────────────────────────────────────────

export interface UnitNormResult {
  canonical: string | null;  // canonical unit code or null if unknown
  ambiguous: boolean;         // true if unit is in ambiguous set
  warning: string | null;     // human-readable warning
}

/**
 * Normalize a raw unit string to a canonical code.
 *
 * Delegates to canonicalizeUnit() from units.ts so the AI import pipeline
 * and the recipe costing engine share one alias table.
 *
 * Steps:
 * 1. Lowercase, trim, strip trailing punctuation, normalise internal whitespace
 * 2. Check AMBIGUOUS_UNITS set → flag and return null canonical
 * 3. Delegate to canonicalizeUnit() (handles hyphen variants, plural stripping, etc.)
 * 4. Unknown → return null canonical with warning
 */
export function normalizeExtractedUnit(raw: string): UnitNormResult {
  if (!raw || typeof raw !== "string") {
    return { canonical: null, ambiguous: false, warning: "Missing unit" };
  }

  // Normalise: lowercase, trim, collapse whitespace, strip trailing punctuation
  const clean = raw.trim().toLowerCase()
    .replace(/\s+/g, " ")       // multiple spaces → single space
    .replace(/[.,;]+$/, "");    // strip trailing . , ;

  if (!clean) {
    return { canonical: null, ambiguous: false, warning: "Missing unit" };
  }

  // Check ambiguous set first ("handful", "pinch", etc.)
  if (AMBIGUOUS_UNITS.has(clean)) {
    return {
      canonical: null,
      ambiguous: true,
      warning: `Ambiguous unit "${raw}" — cannot be automatically converted. Please select a unit manually.`,
    };
  }

  // Delegate to the shared canonical resolver from units.ts
  const canonical = canonicalizeUnit(clean);
  if (canonical) {
    return { canonical, ambiguous: false, warning: null };
  }

  // Unknown unit
  return {
    canonical: null,
    ambiguous: false,
    warning: `Unrecognized unit "${raw}" — please select a unit manually.`,
  };
}

// ─── Ingredient matching ────────────────────────────────────────────────────

/**
 * Levenshtein distance between two strings.
 * Used for fuzzy ingredient matching.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Similarity score between 0 and 1.
 * 1 = identical, 0 = completely different.
 */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Normalize a string for comparison:
 * lowercase, trim, collapse spaces, strip common prep words.
 */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    // Strip common prep descriptors that appear after the ingredient name
    .replace(/\b(sliced|chopped|diced|minced|crushed|grated|peeled|fresh|dry|dried|ground|whole|raw|cooked|roasted|frozen)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface IngredientMatchResult {
  item: any | null;        // matched inventory item
  score: number;           // 0–1 confidence
  suggestions: { id: string; name: string; score: number }[];  // top-3 alternatives
}

/**
 * Match a raw ingredient string against the inventory item list.
 *
 * Strategy (in priority order):
 *  1. Exact match (normalized)
 *  2. Contains match (ingredient name contained in inventory name or vice versa)
 *  3. Fuzzy similarity match (Levenshtein)
 *
 * Returns top match + up to 3 suggestions.
 * Items with score < MIN_CONFIDENCE are not auto-matched
 * (user must manually select from suggestions).
 */
const MIN_CONFIDENCE = 0.55;

export function matchIngredient(
  rawIngredient: string,
  inventory: any[]
): IngredientMatchResult {
  if (!rawIngredient || inventory.length === 0) {
    return { item: null, score: 0, suggestions: [] };
  }

  const query = normalizeForMatch(rawIngredient);

  // Score each inventory item
  const scored = inventory
    .filter((i) => i && i.name)
    .map((item) => {
      const itemNorm = normalizeForMatch(item.name);

      // Exact match → perfect score
      if (itemNorm === query) return { item, score: 1.0 };

      // Contained match boost
      let score = similarity(query, itemNorm);
      if (itemNorm.includes(query) || query.includes(itemNorm)) {
        // Boost containment matches
        score = Math.max(score, 0.75);
      }

      // Token set match: if all words of query appear in item name
      const queryTokens = query.split(" ").filter(Boolean);
      const itemTokens = itemNorm.split(" ").filter(Boolean);
      const allTokensPresent = queryTokens.every((t) => itemTokens.some((it) => it.includes(t) || t.includes(it)));
      if (allTokensPresent && queryTokens.length >= 2) {
        score = Math.max(score, 0.82);
      }

      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];

  // Build suggestions (top 3, excluding the auto-matched item)
  const suggestions = scored.slice(0, 4).map((s) => ({
    id: String(s.item.id),
    name: s.item.name,
    score: s.score,
  }));

  if (!top || top.score < MIN_CONFIDENCE) {
    return { item: null, score: top?.score ?? 0, suggestions };
  }

  return { item: top.item, score: top.score, suggestions: suggestions.slice(1) };
}

// ─── Review row builder ─────────────────────────────────────────────────────

/**
 * Build ReviewRow[] from the AI extraction result + inventory list.
 *
 * For each extracted item:
 *  - Parse quantity (handles fractions, unicode fractions)
 *  - Normalize unit
 *  - Match ingredient against inventory
 *  - Compute status + warnings
 *  - Set resolved* fields to the best defaults (user can override in UI)
 */
export function buildReviewRows(
  extraction: AiExtractionResult,
  inventory: any[]
): ReviewRow[] {
  return extraction.items.map((item): ReviewRow => {
    const warnings: string[] = [];

    // ── Quantity ───────────────────────────────────────────────────────────
    // Use AI-parsed numeric if present, otherwise try to parse from raw string
    let qtyNumeric = item.qty_numeric;
    if (qtyNumeric === null || isNaN(qtyNumeric as number)) {
      qtyNumeric = parseFraction(item.qty_raw);
    }
    if (qtyNumeric === null) {
      warnings.push("Could not parse quantity — please enter manually.");
    }

    // ── Unit ───────────────────────────────────────────────────────────────
    const unitNorm = normalizeExtractedUnit(item.unit_raw);
    if (unitNorm.warning) warnings.push(unitNorm.warning);

    // ── Ingredient matching ────────────────────────────────────────────────
    const match = matchIngredient(item.ingredient_raw, inventory);
    if (!match.item) {
      warnings.push(`Ingredient "${item.ingredient_raw}" not found in inventory — please select manually.`);
    } else if (match.score < 0.75) {
      warnings.push(`Low-confidence match for "${item.ingredient_raw}" (${Math.round(match.score * 100)}% confidence) — please verify.`);
    }

    // ── Status computation ─────────────────────────────────────────────────
    let status: RowStatus;
    if (qtyNumeric === null) {
      status = "missing_qty";
    } else if (!match.item && !unitNorm.canonical && !unitNorm.ambiguous) {
      status = "warning";
    } else if (!match.item) {
      status = "needs_ingredient";
    } else if (!unitNorm.canonical) {
      status = "needs_unit";
    } else if (match.score < 0.75) {
      status = "low_confidence";
    } else {
      status = "matched";
    }

    // ── resolvedUnit: smart unit selection ───────────────────────────────────────────
    //
    // Root cause of cross-family Math Error (e.g. AI reads "2 kg" for an item
    // stored as "ea"): the AI-extracted canonical is used as resolvedUnit even
    // when the inventory item belongs to a different measurement family.
    //
    // Fix: canonicalize the inventory item's native unit FIRST (so raw DB
    // values like "fl oz", "litre", "lbs", "fluid ounce" are resolved to their
    // canonical code), then compare families using the same sets as normalizeUnit.
    // If there is a family mismatch and the item is count-based, override
    // resolvedUnit to the item's canonical native unit.

    const rawInvUnit = match.item
      ? ((match.item.baseUnit || match.item.unit) ?? "").trim()
      : null;
    // Canonicalize using the shared resolver from units.ts
    const canonInvUnit = rawInvUnit ? canonicalizeUnit(rawInvUnit) : null;

    // Family sets mirror UNIT_FAMILIES in units.ts (kept local to avoid import churn)
    const MASS_SET   = new Set(["g","kg","mg","oz","lb"]);
    const VOLUME_SET = new Set(["ml","cl","dl","l","fl oz","tsp","tbsp","cup"]);
    const COUNT_SET  = new Set(["ea","pack","box","case","can","bottle","bag","bunch","clove","sprig","slice","strip","sheet","knob"]);

    const getFamily = (canon: string | null | undefined): string | null => {
      if (!canon) return null;
      if (MASS_SET.has(canon))   return "mass";
      if (VOLUME_SET.has(canon)) return "volume";
      if (COUNT_SET.has(canon))  return "count";
      return null;
    };

    const extractedFamily = getFamily(unitNorm.canonical);
    const inventoryFamily = getFamily(canonInvUnit);

    let resolvedUnit: string | null;

    // Case A: inventory item is count-based, AI extracted weight/volume → override
    if (match.item && inventoryFamily === "count" && (extractedFamily === "mass" || extractedFamily === "volume")) {
      resolvedUnit = canonInvUnit ?? rawInvUnit;
      warnings.push(
        `Unit switched from "${item.unit_raw}" to "${resolvedUnit}" — ` +
        `this item is sold by count, not by weight/volume. ` +
        `Update if you have a specific pack conversion.`
      );
    // Case B: no canonical unit extracted, but inventory item has a known canonical → use it
    } else if (match.item && !unitNorm.canonical && canonInvUnit) {
      resolvedUnit = canonInvUnit;
    // Default: use AI canonical (already a proper canonical code); raw string only as last resort
    } else {
      resolvedUnit = unitNorm.canonical ?? (item.unit_raw || null);
    }

    return {
      lineNumber: item.line_number,
      ingredientRaw: item.ingredient_raw,
      qtyRaw: item.qty_raw,
      qtyNumeric,
      unitRaw: item.unit_raw,
      prepNote: item.prep_note_raw || "",
      aiConfidence: item.confidence_score ?? 0,

      canonicalUnit: unitNorm.canonical,
      unitAmbiguous: unitNorm.ambiguous,
      unitWarning: unitNorm.warning,

      matchedInventoryId: match.item ? String(match.item.id) : null,
      matchedInventoryName: match.item?.name ?? null,
      matchScore: match.score,
      suggestions: match.suggestions,

      status,
      warnings,

      // Resolved = defaults that user can override
      resolvedInventoryId: match.item ? String(match.item.id) : null,
      resolvedUnit,
      resolvedQty: qtyNumeric,
      resolvedPrepNote: item.prep_note_raw || "",
      userResolved: false,
    };
  });
}

// ─── Ingredient shape converter ─────────────────────────────────────────────

/**
 * Convert confirmed ReviewRows to the recipe ingredient format
 * used by the existing recipe builder (openBuilder / saveRecipeData).
 *
 * Only includes rows that have a resolved inventory item.
 * Rows without inventory match are skipped (user should have resolved them
 * in the review table before confirming, or chose to exclude them).
 */
export function reviewRowsToIngredients(
  rows: ReviewRow[],
  inventory: any[]
): any[] {
  return rows
    .filter((r) => r.resolvedInventoryId != null)
    .map((r) => {
      const invItem = inventory.find(
        (i) => String(i.id) === String(r.resolvedInventoryId)
      );
      return {
        type: "inventory",
        inventoryId: String(r.resolvedInventoryId),
        name: invItem?.name ?? r.ingredientRaw,
        qty: r.resolvedQty ?? 1,
        unit: r.resolvedUnit ?? invItem?.baseUnit ?? invItem?.unit ?? "ea",
        prepNote: r.resolvedPrepNote || undefined,
        source: "ai_import",   // audit field — JSONB passthrough in existing schema
      };
    });
}

// ─── Summary stats ──────────────────────────────────────────────────────────

export interface ImportSummary {
  total: number;
  matched: number;
  needsReview: number;
  unknownIngredients: number;
  unknownUnits: number;
}

export function computeImportSummary(rows: ReviewRow[]): ImportSummary {
  return {
    total: rows.length,
    matched: rows.filter((r) => r.status === "matched").length,
    needsReview: rows.filter((r) => r.status !== "matched").length,
    unknownIngredients: rows.filter((r) => r.status === "needs_ingredient" || r.resolvedInventoryId === null).length,
    unknownUnits: rows.filter((r) => r.status === "needs_unit" || r.unitAmbiguous).length,
  };
}
