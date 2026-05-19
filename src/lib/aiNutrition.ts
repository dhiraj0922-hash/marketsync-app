export const NUTRITION_DISCLAIMER =
  "Estimated nutrition only. Verify before using on packaging.";

export interface NutritionMacroSet {
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fibre_g: number;
  sodium_mg: number;
}

export type NutritionConfidence = "high" | "medium" | "low";

export interface NutritionEstimateAiResponse {
  total: NutritionMacroSet;
  per_yield_unit: NutritionMacroSet;
  confidence: NutritionConfidence;
  assumptions: string[];
  warnings: string[];
}

export interface NutritionEstimate extends NutritionEstimateAiResponse {
  source: "ai" | "manual";
  ai_model?: string;
  estimated_at: string;
  approved_by?: string;
  approved_at?: string;
  yield_qty: number;
  yield_unit: string;
  disclaimer: string;
}

export interface NutritionEstimateRecipeInput {
  name: string;
  yieldQty: number;
  yieldUnit: string;
  ingredients: Array<{
    name: string;
    qty: number;
    unit: string;
  }>;
}

const MACRO_KEYS: Array<keyof NutritionMacroSet> = [
  "calories",
  "protein_g",
  "fat_g",
  "carbs_g",
  "fibre_g",
  "sodium_mg",
];

function cleanNumber(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 10) / 10;
}

export function normalizeMacroSet(raw: Partial<NutritionMacroSet> | null | undefined): NutritionMacroSet {
  return MACRO_KEYS.reduce((acc, key) => {
    acc[key] = cleanNumber(raw?.[key]);
    return acc;
  }, {} as NutritionMacroSet);
}

export function derivePerYieldUnit(total: NutritionMacroSet, yieldQty: number): NutritionMacroSet {
  const divisor = Number(yieldQty) > 0 ? Number(yieldQty) : 1;
  return MACRO_KEYS.reduce((acc, key) => {
    acc[key] = cleanNumber(total[key] / divisor);
    return acc;
  }, {} as NutritionMacroSet);
}

export function deriveTotalFromPerYieldUnit(perYieldUnit: NutritionMacroSet, yieldQty: number): NutritionMacroSet {
  const multiplier = Number(yieldQty) > 0 ? Number(yieldQty) : 1;
  return MACRO_KEYS.reduce((acc, key) => {
    acc[key] = cleanNumber(perYieldUnit[key] * multiplier);
    return acc;
  }, {} as NutritionMacroSet);
}

export function buildNutritionPrompt(recipe: NutritionEstimateRecipeInput): string {
  const ingredientLines = recipe.ingredients
    .map((ing) => `- ${ing.qty} ${ing.unit} ${ing.name}`.trim())
    .join("\n");

  return `
You are a professional nutritionist AI. Estimate the total nutrition for this recipe.

Recipe: ${recipe.name || "Untitled recipe"}
Yield: ${recipe.yieldQty} ${recipe.yieldUnit}

Ingredients:
${ingredientLines}

Return ONLY valid JSON with this exact structure:
{
  "total": { "calories": 0, "protein_g": 0, "fat_g": 0, "carbs_g": 0, "fibre_g": 0, "sodium_mg": 0 },
  "per_yield_unit": { "calories": 0, "protein_g": 0, "fat_g": 0, "carbs_g": 0, "fibre_g": 0, "sodium_mg": 0 },
  "confidence": "high|medium|low",
  "assumptions": ["string", ...],
  "warnings": ["string", ...]
}

Rules:
- Use standard nutritional reference values (USDA-style).
- per_yield_unit = total / yieldQty.
- confidence "high" = all ingredients have well-known nutrition; "medium" = some assumptions; "low" = unusual ingredients or ambiguous quantities.
- List every significant assumption or unit approximation in "assumptions".
- List any ingredient you could not reliably estimate in "warnings".
- Return ONLY the JSON object, no other text.
`.trim();
}

export function normalizeAiNutritionResponse(
  raw: Partial<NutritionEstimateAiResponse>,
  yieldQty: number
): NutritionEstimateAiResponse {
  const total = normalizeMacroSet(raw.total);
  const perYieldUnit = raw.per_yield_unit
    ? normalizeMacroSet(raw.per_yield_unit)
    : derivePerYieldUnit(total, yieldQty);
  const confidence = raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low"
    ? raw.confidence
    : "medium";

  return {
    total,
    per_yield_unit: perYieldUnit,
    confidence,
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.map(String).filter(Boolean) : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String).filter(Boolean) : [],
  };
}

export function attachNutritionMetadata(
  aiResponse: NutritionEstimateAiResponse,
  recipe: Pick<NutritionEstimateRecipeInput, "yieldQty" | "yieldUnit">,
  model = "gpt-4o"
): NutritionEstimate {
  return {
    source: "ai",
    ai_model: model,
    estimated_at: new Date().toISOString(),
    total: aiResponse.total,
    per_yield_unit: aiResponse.per_yield_unit,
    yield_qty: Number(recipe.yieldQty) || 1,
    yield_unit: recipe.yieldUnit || "unit",
    confidence: aiResponse.confidence,
    assumptions: aiResponse.assumptions,
    warnings: aiResponse.warnings,
    disclaimer: NUTRITION_DISCLAIMER,
  };
}

export function mockNutritionEstimate(recipe: NutritionEstimateRecipeInput): NutritionEstimateAiResponse {
  const ingredientFactor = Math.max(recipe.ingredients.length, 1);
  const qtyFactor = recipe.ingredients.reduce((sum, ing) => sum + (Number(ing.qty) || 0), 0) || ingredientFactor;
  const total = normalizeMacroSet({
    calories: 185 * ingredientFactor + 42 * qtyFactor,
    protein_g: 7.5 * ingredientFactor + 1.4 * qtyFactor,
    fat_g: 6.2 * ingredientFactor + 0.9 * qtyFactor,
    carbs_g: 22 * ingredientFactor + 3.1 * qtyFactor,
    fibre_g: 2.1 * ingredientFactor,
    sodium_mg: 180 * ingredientFactor + 35 * qtyFactor,
  });

  return {
    total,
    per_yield_unit: derivePerYieldUnit(total, recipe.yieldQty),
    confidence: "medium",
    assumptions: [
      "Mock estimate generated because OPENAI_API_KEY is not configured.",
      "Standard raw ingredient nutrition values were assumed.",
    ],
    warnings: [
      "Development mock values are realistic placeholders and must not be used for packaging.",
    ],
  };
}
