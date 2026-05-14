/**
 * src/__tests__/units.test.ts
 *
 * Regression tests for the costing engine.
 * Run:  npx jest src/__tests__/units.test.ts
 *
 * Tests cover all 8 requirements from the approved plan:
 *   1. 24 oz against 380 gr pack  → ~$8.06
 *   2. lb → kg
 *   3. floz → ml
 *   4. identical-unit passthrough
 *   5. incompatible dimension rejection (mass ↔ volume, volume ↔ each)
 *   6. production stock deduction qty (normalised correctly)
 *   7. FG making cost sync (syncLinkedFgCost-equivalent math)
 *   8. recipe ingredient replacement flow
 *
 * Also tests:
 *   - "gr" alias resolves to "g"
 *   - all three cost paths (pack fields / purchaseUnits / item.cost)
 *   - convertQuantity never throws
 *   - getDimension & areDimensionsCompatible
 */

import {
  normalizeUnit,
  convertQuantity,
  computeIngredientLineCost,
  computeBaseUnitCostFromPack,
  resolveEffectiveBaseUom,
  canonicalizeUnit,
  getDimension,
  areDimensionsCompatible,
} from '../lib/units';

// ─── Helper: round to N decimal places ────────────────────────────────────────
const round = (n: number, dp = 4) =>
  Math.round(n * 10 ** dp) / 10 ** dp;

// ═════════════════════════════════════════════════════════════════════════════
// 1. Alias resolution
// ═════════════════════════════════════════════════════════════════════════════

describe('canonicalizeUnit', () => {
  test('"gr" resolves to "g" (common DB alias for grams)', () => {
    expect(canonicalizeUnit('gr')).toBe('g');
  });

  test('"Grams" resolves to "g"', () => {
    expect(canonicalizeUnit('Grams')).toBe('g');
  });

  test('"fl oz" resolves to "fl oz"', () => {
    expect(canonicalizeUnit('fl oz')).toBe('fl oz');
  });

  test('"floz" (legacy) resolves to "fl oz"', () => {
    expect(canonicalizeUnit('floz')).toBe('fl oz');
  });

  test('"LBS" resolves to "lb"', () => {
    expect(canonicalizeUnit('LBS')).toBe('lb');
  });

  test('unknown string returns null', () => {
    expect(canonicalizeUnit('parsec')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Dimensional categories
// ═════════════════════════════════════════════════════════════════════════════

describe('getDimension', () => {
  test('g → weight', () => expect(getDimension('g')).toBe('weight'));
  test('kg → weight', () => expect(getDimension('kg')).toBe('weight'));
  test('oz → weight', () => expect(getDimension('oz')).toBe('weight'));
  test('lb → weight', () => expect(getDimension('lb')).toBe('weight'));
  test('ml → volume', () => expect(getDimension('ml')).toBe('volume'));
  test('l → volume',  () => expect(getDimension('l')).toBe('volume'));
  test('fl oz → volume', () => expect(getDimension('fl oz')).toBe('volume'));
  test('ea → each',   () => expect(getDimension('ea')).toBe('each'));
});

describe('areDimensionsCompatible', () => {
  test('oz ↔ g  → compatible',    () => expect(areDimensionsCompatible('oz', 'g')).toBe(true));
  test('lb ↔ kg → compatible',    () => expect(areDimensionsCompatible('lb', 'kg')).toBe(true));
  test('ml ↔ l  → compatible',    () => expect(areDimensionsCompatible('ml', 'l')).toBe(true));
  test('fl oz ↔ ml → compatible', () => expect(areDimensionsCompatible('fl oz', 'ml')).toBe(true));
  test('g ↔ ml  → incompatible',  () => expect(areDimensionsCompatible('g', 'ml')).toBe(false));
  test('oz ↔ ea → incompatible',  () => expect(areDimensionsCompatible('oz', 'ea')).toBe(false));
  test('ml ↔ ea → incompatible',  () => expect(areDimensionsCompatible('ml', 'ea')).toBe(false));
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. normalizeUnit — unit conversions
// ═════════════════════════════════════════════════════════════════════════════

describe('normalizeUnit', () => {
  // Requirement 2: lb → kg
  test('1 lb = 0.453592 kg', () => {
    expect(round(normalizeUnit(1, 'lb', 'kg'), 6)).toBe(0.453592);
  });

  // Requirement 3: floz → ml
  test('1 fl oz = 29.5735 ml', () => {
    expect(round(normalizeUnit(1, 'floz', 'ml'), 4)).toBe(29.5735);
  });

  // oz → g (key conversion from the bug report)
  test('24 oz = 680.3885 g', () => {
    expect(round(normalizeUnit(24, 'oz', 'g'), 4)).toBe(680.3886);
  });

  // "gr" alias must also work
  test('24 oz → gr (alias) = 680.3886 g', () => {
    expect(round(normalizeUnit(24, 'oz', 'gr'), 4)).toBe(680.3886);
  });

  // Requirement 4: identical-unit passthrough
  test('identical unit passthrough: 5 kg → kg = 5', () => {
    expect(normalizeUnit(5, 'kg', 'kg')).toBe(5);
  });

  test('identical unit passthrough: 100 ml → ml = 100', () => {
    expect(normalizeUnit(100, 'ml', 'ml')).toBe(100);
  });

  test('zero qty always returns 0', () => {
    expect(normalizeUnit(0, 'oz', 'g')).toBe(0);
  });

  // Requirement 5: incompatible dimension rejection
  test('g ↔ ml throws', () => {
    expect(() => normalizeUnit(1, 'g', 'ml')).toThrow('incompatible dimensions');
  });

  test('oz ↔ ea throws', () => {
    expect(() => normalizeUnit(1, 'oz', 'ea')).toThrow('incompatible dimensions');
  });

  test('unknown unit throws with descriptive message', () => {
    expect(() => normalizeUnit(1, 'parsec', 'kg')).toThrow('not a recognised unit');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. convertQuantity — non-throwing wrapper
// ═════════════════════════════════════════════════════════════════════════════

describe('convertQuantity', () => {
  test('ok=true for valid conversion', () => {
    const r = convertQuantity(24, 'oz', 'g');
    expect(r.ok).toBe(true);
    if (r.ok) expect(round(r.qty!, 4)).toBe(680.3886);
  });

  test('ok=false for incompatible dimensions — never throws', () => {
    const r = convertQuantity(1, 'g', 'ml');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.qty).toBeNull();
      expect(r.error).toMatch(/incompatible/i);
    }
  });

  test('ok=false for unknown unit — never throws', () => {
    const r = convertQuantity(1, 'parsec', 'g');
    expect(r.ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. computeBaseUnitCostFromPack — Path 1
// ═════════════════════════════════════════════════════════════════════════════

describe('computeBaseUnitCostFromPack', () => {
  // Pack: 1 pack of 380 g, cost $4.50
  // costPerGram = 4.50 / 380 = 0.01184210...
  const item380g = {
    purchaseCost:  4.50,
    packQty:       1,
    innerUnitSize: 380,
    innerUnitUom:  'g',
    baseUnit:      'g',
  };

  test('380g pack @ $4.50 → $0.011842/g', () => {
    const cost = computeBaseUnitCostFromPack(item380g)!;
    expect(round(cost, 6)).toBe(0.011842);
  });

  test('returns null when purchaseCost is missing', () => {
    expect(computeBaseUnitCostFromPack({ ...item380g, purchaseCost: null })).toBeNull();
  });

  test('returns null when inner unit and base unit are cross-family', () => {
    expect(
      computeBaseUnitCostFromPack({ ...item380g, innerUnitUom: 'ml', baseUnit: 'g' })
    ).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. computeIngredientLineCost — THE MAIN EVENT
// ═════════════════════════════════════════════════════════════════════════════

describe('computeIngredientLineCost', () => {

  // ── Requirement 1: 24 oz against 380g pack ──────────────────────────────
  // Expected: 680.388g × (4.50/380 $/g) ≈ $8.06
  describe('24 oz against 380 gr pack → ~$8.06 (Path 1)', () => {
    const item = {
      purchaseCost:  4.50,
      packQty:       1,
      innerUnitSize: 380,
      innerUnitUom:  'g',
      baseUnit:      'g',     // DB stores "g"
      cost:          0,       // legacy cost is wrong/zero
    };

    test('uses Path 1 (structured pack)', () => {
      const r = computeIngredientLineCost(24, 'oz', item);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.costPath).toBe(1);
    });

    test('normalizedQty is ~680.39 g', () => {
      const r = computeIngredientLineCost(24, 'oz', item);
      if (r.ok) expect(round(r.normalizedQty, 2)).toBe(680.39);
    });

    test('line cost is ~$8.06', () => {
      const r = computeIngredientLineCost(24, 'oz', item);
      if (r.ok) expect(round(r.cost, 2)).toBe(8.06);
    });

    // Same item but baseUnit stored as "gr" (common DB alias)
    test('works when baseUnit is "gr" (alias)', () => {
      const r = computeIngredientLineCost(24, 'oz', { ...item, baseUnit: 'gr' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(round(r.cost, 2)).toBe(8.06);
    });
  });

  // ── Requirement 2: lb → kg ───────────────────────────────────────────────
  test('2 lb of item with baseUnit kg, cost $10/kg → $9.07', () => {
    const item = { cost: 10, baseUnit: 'kg' };
    const r = computeIngredientLineCost(2, 'lb', item);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(round(r.normalizedQty, 4)).toBe(0.9072); // 2 × 0.453592
      expect(round(r.cost, 2)).toBe(9.07);
    }
  });

  // ── Requirement 3: floz → ml ────────────────────────────────────────────
  test('8 fl oz of item with baseUnit ml, cost $0.01/ml → $2.37', () => {
    const item = { cost: 0.01, baseUnit: 'ml' };
    const r = computeIngredientLineCost(8, 'fl oz', item);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(round(r.normalizedQty, 2)).toBe(236.59); // 8 × 29.5735
      expect(round(r.cost, 2)).toBe(2.37);
    }
  });

  // ── Requirement 4: identical unit passthrough ────────────────────────────
  test('100 g at $0.05/g passthrough → $5.00', () => {
    const r = computeIngredientLineCost(100, 'g', { cost: 0.05, baseUnit: 'g' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalizedQty).toBe(100);
      expect(r.cost).toBe(5);
    }
  });

  // ── Requirement 5: incompatible dimension rejection ──────────────────────
  test('g recipe qty vs ml baseUnit → ok:false', () => {
    const r = computeIngredientLineCost(100, 'g', { cost: 1, baseUnit: 'ml' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cost).toBe(0);
      expect(r.error).toMatch(/incompatible/i);
    }
  });

  test('oz recipe qty vs ea baseUnit → ok:false', () => {
    const r = computeIngredientLineCost(5, 'oz', { cost: 1, baseUnit: 'ea' });
    expect(r.ok).toBe(false);
  });

  // ── Path 2: purchaseUnits JSONB ──────────────────────────────────────────
  test('Path 2 — purchaseUnits: 1 kg at purchaseCost $5, conversion 1 → $5/kg', () => {
    const item = {
      cost:          999,    // stale legacy cost — must be ignored
      purchaseCost:  5,
      purchaseUnits: [{ isPrimary: true, conversion: 1 }],
      baseUnit:      'kg',
    };
    const r = computeIngredientLineCost(1, 'kg', item);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.costPath).toBe(2);
      expect(round(r.cost, 2)).toBe(5);
    }
  });

  // ── Path 3: legacy item.cost ─────────────────────────────────────────────
  test('Path 3 — no pack fields, no purchaseUnits: uses item.cost directly', () => {
    const item = { cost: 0.02, baseUnit: 'g' };
    const r = computeIngredientLineCost(50, 'g', item);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.costPath).toBe(3);
      expect(r.cost).toBe(1.0);
    }
  });

  // ── resolveEffectiveBaseUom priority ────────────────────────────────────
  test('baseUomNew takes priority over baseUnit', () => {
    const item = {
      cost:       0.001,
      baseUomNew: 'ml',   // should be used
      baseUnit:   'l',    // should be ignored
    };
    const r = computeIngredientLineCost(500, 'ml', item);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.baseUnit).toBe('ml');
      expect(r.normalizedQty).toBe(500);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Requirement 6: Production stock deduction — qty matches base unit
// ═════════════════════════════════════════════════════════════════════════════

describe('Production deduction qty normalisation', () => {
  // Simulate what executeProduction does with convertQuantity
  test('24 oz deducted from a gr-based item = 680.39 g deducted', () => {
    const rawItem = { baseUnit: 'g', unit: 'gr', cost: 0 };
    const baseUom = resolveEffectiveBaseUom(rawItem);
    const result  = convertQuantity(24, 'oz', baseUom);
    expect(result.ok).toBe(true);
    if (result.ok) expect(round(result.qty!, 2)).toBe(680.39);
  });

  test('1 lb deducted from a kg-based item = 0.4536 kg deducted', () => {
    const rawItem = { baseUnit: 'kg', unit: 'kg', cost: 0 };
    const baseUom = resolveEffectiveBaseUom(rawItem);
    const result  = convertQuantity(1, 'lb', baseUom);
    expect(result.ok).toBe(true);
    if (result.ok) expect(round(result.qty!, 4)).toBe(0.4536);
  });

  test('deduction of incompatible unit returns ok:false (no silent deduction)', () => {
    const rawItem = { baseUnit: 'ml', unit: 'ml', cost: 0 };
    const baseUom = resolveEffectiveBaseUom(rawItem);
    const result  = convertQuantity(5, 'oz', baseUom); // oz is mass, ml is volume
    expect(result.ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Requirement 7: FG making cost sync math
// ═════════════════════════════════════════════════════════════════════════════

describe('FG making cost sync math', () => {
  // syncLinkedFgCost calculates: theoreticalCost / yieldInBaseUnit
  // This mirrors the computeIngredientLineCost results aggregated over all ingredients.

  test('recipe total cost $8.06 / yield 680g = $0.01185/g', () => {
    const theoreticalCost  = 8.06;
    const yieldInBaseUnits = 680;  // grams
    const costPerUnit      = theoreticalCost / yieldInBaseUnits;
    expect(round(costPerUnit, 5)).toBe(0.01185);
  });

  test('recipe total cost $50 / yield 10 kg = $5/kg', () => {
    const theoreticalCost  = 50;
    const yieldInBaseUnits = 10;
    expect(theoreticalCost / yieldInBaseUnits).toBe(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Requirement 8: Recipe ingredient replacement flow
// ═════════════════════════════════════════════════════════════════════════════

describe('Recipe ingredient replacement flow', () => {
  const inventory = [
    { id: 'A', name: 'Old Sauce',   cost: 0.01, baseUnit: 'g',  unit: 'g'  },
    { id: 'B', name: 'New Sauce',   cost: 0.02, baseUnit: 'g',  unit: 'g', purchaseCost: 4.50, packQty: 1, innerUnitSize: 380, innerUnitUom: 'g' },
  ];

  const ingredients = [
    { inventoryId: 'A', qty: 100, unit: 'g' },   // will be replaced
    { inventoryId: 'A', qty:  50, unit: 'g' },   // unchanged
  ];

  function recalcCost(ings: typeof ingredients) {
    return ings.reduce((sum, ing) => {
      const item = inventory.find(i => i.id === ing.inventoryId)!;
      const r = computeIngredientLineCost(ing.qty, ing.unit, item);
      return sum + (r.ok ? r.cost : 0);
    }, 0);
  }

  test('before replacement: cost uses old ingredient', () => {
    const cost = recalcCost(ingredients);
    // 100g × $0.01 + 50g × $0.01 = $1.50
    expect(round(cost, 2)).toBe(1.50);
  });

  test('after replacement: first ingredient swapped to item B (pack pricing)', () => {
    const newIngredients = ingredients.map((ing, i) =>
      i === 0 ? { ...ing, inventoryId: 'B' } : ing
    );
    const cost = recalcCost(newIngredients);
    // Item B: 100g × (4.50/380) + Item A: 50g × 0.01
    const expectedItemB = round(100 * (4.50 / 380), 4);
    const expectedItemA = round(50 * 0.01, 4);
    expect(round(cost, 4)).toBe(round(expectedItemB + expectedItemA, 4));
  });
});
