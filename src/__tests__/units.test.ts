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

  test('Onion: 150 lb against 50 lb case at $39 → $117', () => {
    const item = {
      name: 'PEELED ONION',
      purchaseCost: 39,
      purchaseUom: 'Case',
      packQty: 1,
      innerUnitSize: 50,
      innerUnitUom: 'lb',
      baseUnit: 'lb',
      cost: 0,
    };
    const r = computeIngredientLineCost(150, 'lb', item);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Path 1 (structured pack) cost — label is measurement_unit_conversion
      expect(r.costAudit.costPathLabel).toBe('measurement_unit_conversion');
      expect(round(r.costPerBaseUnit, 2)).toBe(0.78);
      expect(round(r.cost, 2)).toBe(117);
    }
  });

  test('Oil: 4 L costs as litres, while 4 Case uses purchase pack conversion', () => {
    const item = {
      name: 'OIL VEGETABLE CAPRI',
      purchaseCost: 43.49,
      purchaseUom: 'Case',
      packQty: 1,
      innerUnitSize: 16,
      innerUnitUom: 'l',
      baseUnit: 'l',
      cost: 0,
    };
    const litres = computeIngredientLineCost(4, 'l', item);
    expect(litres.ok).toBe(true);
    if (litres.ok) {
      // Path 1 (structured pack) cost — label is measurement_unit_conversion
      expect(litres.costAudit.costPathLabel).toBe('measurement_unit_conversion');
      expect(round(litres.costPerBaseUnit, 6)).toBe(2.718125);
      expect(round(litres.cost, 2)).toBe(10.87);
    }

    const cases = computeIngredientLineCost(4, 'Case', item);
    expect(cases.ok).toBe(true);
    if (cases.ok) {
      expect(cases.costAudit.costPathLabel).toBe('purchase_unit_conversion');
      expect(cases.normalizedQty).toBe(64);
      expect(round(cases.cost, 2)).toBe(173.96);
    }
  });

  test('Biryani masala: 100 g normalizes to 0.1 kg with stable cost', () => {
    const item = {
      name: 'BIRYANI MASALA HYD',
      purchaseCost: 20,
      purchaseUom: 'Bag',
      packQty: 1,
      innerUnitSize: 1,
      innerUnitUom: 'kg',
      baseUnit: 'kg',
      cost: 0,
    };
    const recipe = computeIngredientLineCost(100, 'g', item);
    const production = computeIngredientLineCost(100, 'g', item);
    expect(recipe.ok).toBe(true);
    expect(production.ok).toBe(true);
    if (recipe.ok && production.ok) {
      expect(recipe.normalizedQty).toBe(0.1);
      expect(recipe.cost).toBe(production.cost);
      expect(round(recipe.cost, 2)).toBe(2);
    }
  });

  test('Garlic: lb recipe quantity uses cost/lb; Case uses pack conversion', () => {
    const item = {
      name: 'GARLIC',
      purchaseCost: 36,
      purchaseUom: 'Case',
      packQty: 1,
      innerUnitSize: 18,
      innerUnitUom: 'lb',
      baseUnit: 'lb',
      cost: 0,
    };
    const pounds = computeIngredientLineCost(1.5, 'lb', item);
    const oneCase = computeIngredientLineCost(1, 'Case', item);
    expect(pounds.ok).toBe(true);
    expect(oneCase.ok).toBe(true);
    if (pounds.ok && oneCase.ok) {
      expect(round(pounds.cost, 2)).toBe(3);
      expect(oneCase.normalizedQty).toBe(18);
      expect(round(oneCase.cost, 2)).toBe(36);
    }
  });

  // ── MAIDA: the reported production costing bug ───────────────────────────
  // When purchaseCost is null but purchaseUnits exists, Path 2 MUST NOT
  // reconstruct purchaseCost as item.cost × conversion. That gives:
  //   0.9725 × 20 = 19.45 "pack cost" → 19.45/20 = 0.9725/kg → wrong $19.45
  // The fix: fall honestly to Path 3 instead of a false reconstruction.
  test('MAIDA: purchaseCost=null with purchaseUnits must fall to Path 3, NOT reconstruct', () => {
    const item = {
      name: 'MAIDA 20KG/BAG',
      cost: 0.9725,             // stale per-kg legacy cost — must NOT be multiplied back up
      purchaseCost: null,       // not yet saved to DB
      purchaseUnits: [{ isPrimary: true, conversion: 20, name: 'Case' }],
      baseUnit: 'kg',
    };
    const r = computeIngredientLineCost(20, 'kg', item);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Must use Path 3 (honest stale cost), not a fake Path 2
      expect(r.costPath).toBe(3);
      // When unit matches base and Path 3 is used, label is 'direct_base_unit'
      // (which is correct and distinct from a false Path 2 reconstruction)
      expect(['fallback_cost', 'direct_base_unit']).toContain(r.costPathLabel);
      // Cost per base unit must be the honest stale cost, not item.cost * conversion
      expect(round(r.costPerBaseUnit, 4)).toBe(0.9725);
      // CRITICAL: must NOT be the wrong reconstructed cost (item.cost × 20 / 20 = 0.9725
      // is the same value, but lineCost for 20 kg must be 19.45, not 36.99 or anything else)
      expect(round(r.cost, 4)).toBe(round(20 * 0.9725, 4));
      // inventoryPriceLabel should show per-base-unit form (no purchase unit label)
      if (r.costAudit) {
        expect(r.costAudit.inventoryPriceLabel).toMatch(/\$.*\/ kg/);
      }
    }
  });


  test('MAIDA: with purchaseCost=$36.99 saved, Path 2 gives correct $1.8495/kg → $36.99 for 20 kg', () => {
    const item = {
      name: 'MAIDA 20KG/BAG',
      cost: 0.9725,             // stale — must be ignored when purchaseCost is present
      purchaseCost: 36.99,      // correct case price
      purchaseUom: 'Case',
      purchaseUnits: [{ isPrimary: true, conversion: 20, name: 'Case' }],
      baseUnit: 'kg',
    };
    const r = computeIngredientLineCost(20, 'kg', item);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.costPath).toBe(2);
      expect(r.costPathLabel).toBe('purchase_unit_conversion');
      expect(round(r.costPerBaseUnit, 4)).toBe(1.8495);
      expect(round(r.cost, 2)).toBe(36.99);
      if (r.costAudit) {
        expect(r.costAudit.inventoryPriceLabel).toBe('$36.99 / Case');
        expect(r.costAudit.baseQtyPerPurchUnit).toBe(20);
      }
    }
  });

  test('MAIDA: inventoryPriceLabel for Path 3 (no purchaseCost) shows per-base-unit format', () => {
    const item = {
      name: 'MAIDA PLAIN FLOUR',
      cost: 1.85,
      purchaseCost: null,
      baseUnit: 'kg',
    };
    const r = computeIngredientLineCost(5, 'kg', item);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.costPath).toBe(3);
      expect(r.costAudit.inventoryPriceLabel).toBe('$1.8500 / kg');
    }
  });
}); // end describe('computeIngredientLineCost')


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

// ═════════════════════════════════════════════════════════════════════════════
// 10. Requirement: Menu Costing / Flexible Recipe Conversions & Count Units
// ═════════════════════════════════════════════════════════════════════════════

describe('Menu Costing & Flexible Recipe Costing count units & weight/volume warning', () => {
  test('pc recipe unit with case base unit converts using packQty', () => {
    const invItem = {
      name: 'Paper Cups',
      cost: 150.00,
      baseUnit: 'case',
      unit: 'case',
      purchaseCost: 150.00,
      packQty: 150,
      innerUnitSize: 1,
      innerUnitUom: 'ea',
    };

    // Recipe uses 1 pc. Case contains 150 pc. Cost should be $1.00.
    const result = computeIngredientLineCost(1, 'pc', invItem);
    expect(result.ok).toBe(true);
    expect(result.cost).toBe(1.00);
    expect(result.normalizedQty).toBe(1 / 150);
  });

  test('case recipe unit with ea base unit converts using packQty', () => {
    const invItem = {
      name: 'Benne Dosa Box',
      cost: 1.00,
      baseUnit: 'ea',
      unit: 'ea',
      purchaseCost: 150.00,
      packQty: 150,
      innerUnitSize: 1,
      innerUnitUom: 'ea',
    };

    // Recipe uses 1 case. Case contains 150 pc. Cost should be $150.00.
    const result = computeIngredientLineCost(1, 'case', invItem);
    expect(result.ok).toBe(true);
    expect(result.cost).toBe(150.00);
    expect(result.normalizedQty).toBe(150);
  });

  test('structured pack costing works when base unit is ea', () => {
    const invItem = {
      name: 'Burger Bun',
      purchaseCost: 12.00,
      packQty: 24,
      innerUnitSize: 1,
      innerUnitUom: 'ea',
      baseUnit: 'ea',
      unit: 'ea',
    };

    // Cost per bun = $12.00 / 24 = $0.50
    const result = computeIngredientLineCost(2, 'ea', invItem);
    expect(result.ok).toBe(true);
    expect(result.cost).toBe(1.00);
  });

  test('weight-to-volume conversion throws custom setup warning', () => {
    const invItem = {
      name: 'Oil',
      cost: 10.00,
      baseUnit: 'L',
      unit: 'L',
    };

    const result = computeIngredientLineCost(100, 'g', invItem);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Cannot convert weight to volume for this item without density/yield setup');
    }
  });
});
