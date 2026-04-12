/**
 * POST /api/ai-import/extract
 *
 * AI Recipe Image Extraction API Route
 * ─────────────────────────────────────────────────────────────────────────────
 * Receives a multipart/form-data request with:
 *   - image: File (JPEG/PNG/WebP/HEIC, max 4MB)
 *   - requestId: string (client-generated, used as ai_import_logs.id)
 *
 * Returns:
 *   { success: true, data: AiExtractionResult }
 *   or
 *   { success: false, error: string }
 *
 * AI Backend:
 *   Uses OpenAI GPT-4o Vision API (gpt-4o is strongly preferred over gpt-4-vision-preview
 *   for structured JSON output quality).
 *
 *   If OPENAI_API_KEY is not set in environment, runs in MOCK MODE:
 *   returns realistic fake extraction data so the full UI review flow
 *   can be tested without an API key.
 *
 * Audit:
 *   Every extraction attempt is logged to ai_import_logs in Supabase
 *   with the raw AI response, status, and caller user id.
 *   This uses the service role key (server-side only) to bypass RLS for logging.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { AiExtractionResult } from "@/lib/aiRecipeImport";

// ── Supabase admin client (server-side only — never expose service key to browser) ──
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Max image size: 4MB ──────────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// ── Structured extraction prompt ────────────────────────────────────────────
const EXTRACTION_PROMPT = `
You are a restaurant inventory and recipe data extraction system.

Analyze this recipe image and extract all ingredient information.

Return ONLY a valid JSON object with this exact structure — no markdown, no explanation, no extra text:

{
  "recipe_name": "string or empty string",
  "recipe_type": "recipe or sub-recipe or empty string",
  "servings_or_yield": "string or empty string (e.g. '10 portions', '4 servings', '1 kg')",
  "notes": "string or empty string",
  "items": [
    {
      "line_number": 1,
      "ingredient_raw": "ingredient name only, no quantity or unit",
      "qty_raw": "raw quantity string as it appears (e.g. '1/2', '250', '1 1/2')",
      "qty_numeric": 0.5,
      "unit_raw": "unit as it appears (e.g. 'kg', 'grams', 'pcs', 'tbsp')",
      "prep_note_raw": "preparation instruction if present (e.g. 'sliced', 'chopped', 'minced') — empty string if none",
      "confidence_score": 0.95
    }
  ]
}

Rules:
- Parse fractions correctly: 1/2 = 0.5, 1 1/2 = 1.5, ¼ = 0.25, ¾ = 0.75
- ingredient_raw should be the ingredient name ONLY — not quantity, not unit, not prep note
- If quantity is missing, set qty_raw = "" and qty_numeric = null
- If unit is missing (e.g. "2 eggs"), set unit_raw = "pcs"
- confidence_score: 1.0 = clearly legible, 0.5 = partially readable, 0.2 = guessed
- Extract ALL ingredients visible in the image
- Return only the JSON object — no other text
`.trim();

// ── Mock extraction (used when OPENAI_API_KEY not set) ──────────────────────
function mockExtraction(): AiExtractionResult {
  return {
    recipe_name: "Butter Chicken Gravy (Mock)",
    recipe_type: "recipe",
    servings_or_yield: "10 portions",
    notes: "This is mock extracted data — add OPENAI_API_KEY to .env.local for real AI extraction.",
    items: [
      { line_number: 1, ingredient_raw: "Tomato Puree",   qty_raw: "1",   qty_numeric: 1,    unit_raw: "kg",   prep_note_raw: "",        confidence_score: 0.97 },
      { line_number: 2, ingredient_raw: "Heavy Cream",    qty_raw: "250", qty_numeric: 250,  unit_raw: "ml",   prep_note_raw: "",        confidence_score: 0.95 },
      { line_number: 3, ingredient_raw: "Butter",         qty_raw: "100", qty_numeric: 100,  unit_raw: "g",    prep_note_raw: "",        confidence_score: 0.98 },
      { line_number: 4, ingredient_raw: "Kasuri Methi",   qty_raw: "20",  qty_numeric: 20,   unit_raw: "grams",prep_note_raw: "",        confidence_score: 0.90 },
      { line_number: 5, ingredient_raw: "Salt",           qty_raw: "15",  qty_numeric: 15,   unit_raw: "g",    prep_note_raw: "to taste",confidence_score: 0.88 },
      { line_number: 6, ingredient_raw: "Onion",          qty_raw: "2",   qty_numeric: 2,    unit_raw: "pcs",  prep_note_raw: "sliced",  confidence_score: 0.96 },
      { line_number: 7, ingredient_raw: "Oil",            qty_raw: "3",   qty_numeric: 3,    unit_raw: "tbsp", prep_note_raw: "",        confidence_score: 0.94 },
      { line_number: 8, ingredient_raw: "Green Chilli",   qty_raw: "4",   qty_numeric: 4,    unit_raw: "pcs",  prep_note_raw: "chopped", confidence_score: 0.93 },
      { line_number: 9, ingredient_raw: "Coriander",      qty_raw: "1",   qty_numeric: 1,    unit_raw: "handful", prep_note_raw: "",     confidence_score: 0.75 },
    ],
  };
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let requestId = "";
  let imageDataUrl = "";

  try {
    // ── Parse multipart form ─────────────────────────────────────────────
    const form = await req.formData();
    const imageFile = form.get("image") as File | null;
    requestId = (form.get("requestId") as string) || `AIR-${Date.now()}`;
    const userId = (form.get("userId") as string) || null;

    if (!imageFile) {
      return NextResponse.json({ success: false, error: "No image file provided." }, { status: 400 });
    }

    // ── Size guard ───────────────────────────────────────────────────────
    if (imageFile.size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { success: false, error: `Image too large (${(imageFile.size / 1024 / 1024).toFixed(1)}MB). Maximum is 4MB.` },
        { status: 413 }
      );
    }

    // ── Convert to base64 ─────────────────────────────────────────────────
    const arrayBuffer = await imageFile.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = imageFile.type || "image/jpeg";
    imageDataUrl = `data:${mimeType};base64,${base64}`;

    // ── Log initial attempt ───────────────────────────────────────────────
    await supabaseAdmin.from("ai_import_logs").upsert({
      id: requestId,
      uploaded_by: userId,
      image_data_url: imageDataUrl,
      status: "pending",
      raw_ai_response: null,
      parsed_result: null,
    }, { onConflict: "id" });

    // ── Check for OpenAI API key ──────────────────────────────────────────
    const openaiKey = process.env.OPENAI_API_KEY;
    let extractionResult: AiExtractionResult;
    let rawAiResponse: any = null;

    if (!openaiKey) {
      // ── MOCK MODE ──────────────────────────────────────────────────────
      console.warn("[AI Import] OPENAI_API_KEY not set — running in mock mode.");
      extractionResult = mockExtraction();
      rawAiResponse = { mock: true, message: "Set OPENAI_API_KEY in .env.local to enable real AI extraction." };
    } else {
      // ── REAL OPENAI CALL ───────────────────────────────────────────────
      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 2048,
          temperature: 0,               // deterministic JSON output
          response_format: { type: "json_object" },  // enforces JSON response
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: EXTRACTION_PROMPT },
                {
                  type: "image_url",
                  image_url: {
                    url: imageDataUrl,
                    detail: "high",    // high resolution mode for recipe text
                  },
                },
              ],
            },
          ],
        }),
      });

      if (!openaiRes.ok) {
        const errBody = await openaiRes.text();
        console.error("[AI Import] OpenAI API error:", errBody);

        // Log failure
        await supabaseAdmin.from("ai_import_logs").update({
          status: "failed",
          raw_ai_response: { error: errBody, httpStatus: openaiRes.status },
        }).eq("id", requestId);

        return NextResponse.json(
          { success: false, error: `AI service error (${openaiRes.status}). Please try again.` },
          { status: 502 }
        );
      }

      rawAiResponse = await openaiRes.json();
      const content = rawAiResponse?.choices?.[0]?.message?.content;

      if (!content) {
        await supabaseAdmin.from("ai_import_logs").update({
          status: "failed",
          raw_ai_response: rawAiResponse,
        }).eq("id", requestId);

        return NextResponse.json(
          { success: false, error: "AI returned an empty response. The image may be unreadable." },
          { status: 422 }
        );
      }

      // ── Parse JSON from AI response ─────────────────────────────────────
      try {
        extractionResult = JSON.parse(content) as AiExtractionResult;
      } catch (parseErr) {
        console.error("[AI Import] JSON parse failed:", content);

        await supabaseAdmin.from("ai_import_logs").update({
          status: "failed",
          raw_ai_response: rawAiResponse,
          validation_warnings: [{ error: "AI returned invalid JSON", raw: content }],
        }).eq("id", requestId);

        return NextResponse.json(
          { success: false, error: "AI returned malformed data. Please retry or enter ingredients manually." },
          { status: 422 }
        );
      }
    }

    // ── Validate minimum structure ────────────────────────────────────────
    if (!extractionResult.items || !Array.isArray(extractionResult.items)) {
      extractionResult.items = [];
    }
    if (extractionResult.items.length === 0) {
      await supabaseAdmin.from("ai_import_logs").update({
        status: "failed",
        raw_ai_response: rawAiResponse,
        parsed_result: extractionResult as any,
        validation_warnings: [{ warning: "No ingredients detected in image" }],
      }).eq("id", requestId);

      return NextResponse.json(
        { success: false, error: "No ingredients could be detected in this image. Try a clearer photo." },
        { status: 422 }
      );
    }

    // ── Ensure line_number is sequential ─────────────────────────────────
    extractionResult.items = extractionResult.items.map((item, idx) => ({
      ...item,
      line_number: item.line_number ?? idx + 1,
      qty_numeric: item.qty_numeric != null ? Number(item.qty_numeric) : null,
      confidence_score: item.confidence_score ?? 0.8,
      ingredient_raw: (item.ingredient_raw ?? "").trim(),
      unit_raw: (item.unit_raw ?? "").trim(),
      qty_raw: (item.qty_raw ?? "").trim(),
      prep_note_raw: (item.prep_note_raw ?? "").trim(),
    }));

    // ── Update log with success ────────────────────────────────────────────
    await supabaseAdmin.from("ai_import_logs").update({
      status: "complete",
      raw_ai_response: rawAiResponse as any,
      parsed_result: extractionResult as any,
    }).eq("id", requestId);

    return NextResponse.json({ success: true, data: extractionResult, requestId });

  } catch (err: any) {
    console.error("[AI Import] Unexpected error:", err);

    // Best-effort log failure — wrapped in its own try/catch so it never throws
    if (requestId) {
      try {
        await supabaseAdmin.from("ai_import_logs").update({
          status: "failed",
          validation_warnings: [{ error: err?.message ?? "Unknown server error" }],
        }).eq("id", requestId);
      } catch { /* ignore — best effort only */ }
    }

    return NextResponse.json(
      { success: false, error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    );
  }
}
