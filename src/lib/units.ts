export function normalizeUnit(qty: number, fromUnitBase: string, toUnitBase: string): number {
  if (qty === 0) return 0;
  
  const fromUnit = fromUnitBase.trim().toLowerCase();
  const toUnit = toUnitBase.trim().toLowerCase();

  // If units are identical, no conversion needed
  if (fromUnit === toUnit) {
    return qty;
  }

  // Define conversion factors to a base unit
  const conversions: Record<string, { base: string, factor: number }> = {
    // Mass
    'g': { base: 'mass', factor: 0.001 },
    'kg': { base: 'mass', factor: 1 },
    'oz': { base: 'mass', factor: 0.0283495 },
    'lb': { base: 'mass', factor: 0.453592 },
    
    // Volume
    'ml': { base: 'volume', factor: 0.001 },
    'litre': { base: 'volume', factor: 1 },
    'l': { base: 'volume', factor: 1 },
    
    // Direct / Count
    'piece': { base: 'count', factor: 1 },
    'each': { base: 'count', factor: 1 },
    'box': { base: 'count', factor: 1 },
    'case': { base: 'count', factor: 1 },
  };

  const fromDef = conversions[fromUnit];
  const toDef = conversions[toUnit];

  // If we can't find definitions, or if they belong to different base categories (mass vs volume)
  if (!fromDef || !toDef || fromDef.base !== toDef.base) {
    throw new Error(`Incompatible units: Cannot convert ${fromUnitBase} to ${toUnitBase}`);
  }

  // Convert to base standard, then divide by target factor
  // Math: 500g -> 500 * (0.001) = 0.5 kg base. 0.5 kg base / (1 for kg) = 0.5 kg
  const baseQty = qty * fromDef.factor;
  const targetQty = baseQty / toDef.factor;
  
  // Return fixed to 4 decimals to avoid weird floating point issues
  return Number(Math.round(parseFloat(targetQty + 'e' + 4)) + 'e-' + 4);
}
