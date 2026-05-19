/**
 * POST /api/ai-nutrition/estimate
 *
 * AI Recipe Nutrition Estimation API Route.
 * This route is called only from the explicit recipe-builder button handler.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  attachNutritionMetadata,
  buildNutritionPrompt,
  mockNutritionEstimate,
  normalizeAiNutritionResponse,
  type NutritionEstimateAiResponse,
  type NutritionEstimateRecipeInput,
} from "@/lib/aiNutrition";

const MODEL = "gpt-4o";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

type RawIngredientInput = {
  name?: unknown;
  qty?: unknown;
  unit?: unknown;
};

type RawRecipeInput = {
  name?: unknown;
  yieldQty?: unknown;
  yieldUnit?: unknown;
  ingredients?: unknown;
};

type OpenAiChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

function cleanRecipe(raw: RawRecipeInput | null | undefined): NutritionEstimateRecipeInput {
  const rawIngredients = Array.isArray(raw?.ingredients)
    ? raw.ingredients as RawIngredientInput[]
    : [];

  return {
    name: String(raw?.name ?? "").trim(),
    yieldQty: Number(raw?.yieldQty) > 0 ? Number(raw?.yieldQty) : 1,
    yieldUnit: String(raw?.yieldUnit ?? "unit").trim() || "unit",
    ingredients: rawIngredients
      .map((ing) => ({
        name: String(ing?.name ?? "").trim(),
        qty: Number(ing?.qty) || 0,
        unit: String(ing?.unit ?? "").trim() || "ea",
      }))
      .filter((ing) => ing.name),
  };
}

export async function POST(req: NextRequest) {
  let requestId = "";
  let logReady = false;

  try {
    const body = await req.json() as { requestId?: unknown; userId?: unknown; recipe?: RawRecipeInput };
    requestId = String(body?.requestId || `AIN-${Date.now()}`);
    const userId = String(body?.userId || "") || null;
    const recipe = cleanRecipe(body?.recipe);

    if (!recipe.name) {
      return NextResponse.json({ success: false, error: "Recipe name is required." }, { status: 400 });
    }
    if (recipe.ingredients.length === 0) {
      return NextResponse.json({ success: false, error: "At least one ingredient is required." }, { status: 400 });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    let aiResult: Partial<NutritionEstimateAiResponse>;
    let rawAiResponse: unknown = null;

    try {
      const { error } = await supabaseAdmin.from("ai_nutrition_logs").upsert({
        id: requestId,
        requested_by: userId,
        recipe_name: recipe.name,
        request_payload: { recipe },
        status: "pending",
      }, { onConflict: "id" });
      logReady = !error;
    } catch {
      logReady = false;
    }

    if (!openaiKey) {
      console.warn("[AI Nutrition] OPENAI_API_KEY not set — running in mock mode.");
      aiResult = mockNutritionEstimate(recipe);
      rawAiResponse = { mock: true, message: "Set OPENAI_API_KEY in .env.local to enable real nutrition estimation." };
    } else {
      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1600,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: buildNutritionPrompt(recipe),
            },
          ],
        }),
      });

      if (!openaiRes.ok) {
        const errBody = await openaiRes.text();
        console.error("[AI Nutrition] OpenAI API error:", errBody);
        return NextResponse.json(
          { success: false, error: `AI service error (${openaiRes.status}). Please try again.` },
          { status: 502 }
        );
      }

      const openAiBody = await openaiRes.json() as OpenAiChatResponse;
      rawAiResponse = openAiBody;
      const content = openAiBody?.choices?.[0]?.message?.content;

      if (!content) {
        return NextResponse.json(
          { success: false, error: "AI returned an empty response. Please retry." },
          { status: 422 }
        );
      }

      try {
        aiResult = JSON.parse(content) as Partial<NutritionEstimateAiResponse>;
      } catch (parseErr) {
        console.error("[AI Nutrition] JSON parse failed:", content, parseErr);
        return NextResponse.json(
          { success: false, error: "AI returned malformed nutrition data. Please retry." },
          { status: 422 }
        );
      }
    }

    const normalized = normalizeAiNutritionResponse(aiResult, recipe.yieldQty);
    const estimate = attachNutritionMetadata(normalized, recipe, MODEL);

    if (logReady) {
      try {
        await supabaseAdmin.from("ai_nutrition_logs").update({
          status: "complete",
          raw_ai_response: rawAiResponse,
          parsed_result: estimate,
          updated_at: new Date().toISOString(),
        }).eq("id", requestId);
      } catch { /* best effort only */ }
    }

    return NextResponse.json({ success: true, data: estimate, requestId });
  } catch (err: unknown) {
    console.error("[AI Nutrition] Unexpected error:", err);
    if (requestId && logReady) {
      try {
        await supabaseAdmin.from("ai_nutrition_logs").update({
          status: "failed",
          error_message: err instanceof Error ? err.message : "Unknown server error",
          updated_at: new Date().toISOString(),
        }).eq("id", requestId);
      } catch { /* best effort only */ }
    }
    return NextResponse.json(
      { success: false, error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    );
  }
}
