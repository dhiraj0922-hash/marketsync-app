/**
 * src/lib/inventoryIdentity.ts
 *
 * Inventory Alias Foundation — Phase 2, Part 5
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure client-safe utility. No Supabase calls. No side-effects at import time.
 *
 * Current scope:
 *  1. normalizeInventoryName() — canonical name form used in duplicate detection
 *
 * TODO (future alias table support):
 *  - Add loadInventoryAliases()  → reads from a future `inventory_aliases` table
 *  - Add resolveCanonicalName()  → alias → canonical lookup with DB fallback
 *  - Add saveInventoryAlias()    → persist a manual alias mapping
 *  - Integrate alias resolution into resolveSharedItemId() in storage.ts
 *
 * Design contract:
 *  - normalizeInventoryName() is ONLY used in client-side duplicate grouping.
 *  - It is intentionally lossy (strips plurality, punctuation) — never use it
 *    as a DB key or for row identity. Use item_id for that.
 */

// ─── Basic singularization map ────────────────────────────────────────────────
//
// Common food/ingredient plurals that appear in restaurant inventory.
// Extend this list as new false-duplicate patterns are found in practice.
// Each entry: NORMALIZED_PLURAL → NORMALIZED_SINGULAR
//
const SINGULAR_MAP: Record<string, string> = {
  // Vegetables
  tomatoes:   "tomato",
  tomatos:    "tomato",
  tamatoes:   "tomato",
  tamatos:    "tomato",
  peppers:    "pepper",
  onions:     "onion",
  potatoes:   "potato",
  potatos:    "potato",
  carrots:    "carrot",
  mushrooms:  "mushroom",
  zucchinis:  "zucchini",
  zucchinis_: "zucchini",
  eggplants:  "eggplant",
  avocados:   "avocado",
  avocadoes:  "avocado",
  cucumbers:  "cucumber",
  lemons:     "lemon",
  limes:      "lime",
  oranges:    "orange",
  apples:     "apple",
  bananas:    "banana",
  mangoes:    "mango",
  mangos:     "mango",
  berries:    "berry",
  jalapenos:  "jalapeno",

  // Proteins
  chickens:   "chicken",
  shrimps:    "shrimp",
  prawns:     "prawn",
  eggs:       "egg",
  sausages:   "sausage",
  fillets:    "fillet",

  // Pantry
  cloves:     "clove",
  herbs:      "herb",
  spices:     "spice",
  oils:       "oil",
  sauces:     "sauce",
  pastas:     "pasta",
  beans:      "bean",
  lentils:    "lentil",
  nuts:       "nut",
  seeds:      "seed",
  flours:     "flour",

  // Generic English plural rules (es / ies endings — applied as fallback)
  // These are approximate and kept conservative to avoid false collapses.
  // e.g. "leaves" → "leaf", "loaves" → "loaf"
  leaves:     "leaf",
  loaves:     "loaf",
};

// ─── normalizeInventoryName ────────────────────────────────────────────────────

/**
 * Produce a canonical comparison form of an inventory item name.
 *
 * Steps (in order):
 *  1. Lowercase + trim
 *  2. Collapse multiple spaces → single space
 *  3. Strip leading/trailing punctuation (commas, periods, quotes)
 *  4. Remove packaging qualifiers: "1 kg", "500g", "10 l", etc.
 *     (keeps the semantic product name only)
 *  5. Singularize common food plurals via SINGULAR_MAP
 *
 * This function is INTENTIONALLY LOSSY — it is only used for grouping
 * candidate duplicates, not for DB identity. Two names that normalize to the
 * same string are *candidate* duplicates, not definitive matches.
 *
 * @param name  Raw inventory item name from the DB or UI input
 * @returns     Canonical lowercase-singular form, or "" for blank input
 */
export function normalizeInventoryName(name: string | null | undefined): string {
  if (!name) return "";

  let s = name
    .toLowerCase()
    .trim()
    // Collapse internal whitespace
    .replace(/\s+/g, " ")
    // Strip leading/trailing punctuation
    .replace(/^[.,;'"()\-]+|[.,;'"()\-]+$/g, "")
    // Remove packaging-size qualifiers like "1 kg", "500g", "10l", "5lb", "1.5 kg"
    // Pattern: optional space + number(s) + optional space + unit abbreviation
    .replace(/\s*\d+(\.\d+)?\s*(kg|g|mg|lb|lbs|oz|l|ml|cl|dl|ea|pc|pcs|units?|pack|bag|case|box|can|bottle|litre|liter|liters|litres)\b/gi, "")
    .trim();

  // Singularize using the lookup map
  const singular = SINGULAR_MAP[s];
  if (singular) s = singular;

  return s;
}
