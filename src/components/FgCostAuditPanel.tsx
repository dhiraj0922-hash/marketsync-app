"use client";

/**
 * FgCostAuditPanel
 *
 * Surfaces hq_sale_items with missing / zero making_cost and, where possible,
 * safely derives the correct value from the linked recipe's theoreticalCost.
 *
 * Derivation rule (identical to what the recipe builder already uses):
 *   making_cost = recipe.theoreticalCost / recipe.yieldQty   (per base unit)
 *
 * Source attribution displayed for every row:
 *   "recipe:<id>"           — recipe found via hq_sale_items.source_recipe_id
 *   "recipe:name-match"     — recipe found by matching recipe.name → item.name
 *   "none"                  — no recipe found; item flagged, no cost written
 *
 * Safety constraints:
 *   - NEVER overwrites making_cost when it is already > 0
 *   - NEVER writes a cost derived from theoreticalCost ≤ 0  or yieldQty ≤ 0
 *   - Skips inactive items from the UI (they still appear as count in header)
 *   - Uses existing updateSaleItemCost() — no new DB logic
 *   - Entirely additive — does not touch any other column
 */

import { useState, useCallback } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Wand2,
  Loader2,
  ChevronDown,
  ChevronRight,
  Info,
  RefreshCw,
} from "lucide-react";
import { updateSaleItemCost, type SaleItem } from "@/lib/storage";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditSource =
  | "recipe:id"         // linked via source_recipe_id
  | "recipe:name-match" // guessed by name when id is null
  | "none";             // no recipe — cannot derive

export interface AuditRow {
  item:        SaleItem;
  derivedCost: number | null; // null = cannot derive
  source:      AuditSource;
  recipeId:    string | null;
  recipeName:  string | null;
  applied:     boolean;
  applying:    boolean;
  error:       string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const $fmt = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;

function sourceLabel(s: AuditSource): { text: string; color: string; tip: string } {
  switch (s) {
    case "recipe:id":
      return {
        text:  "Linked recipe",
        color: "text-green-700 bg-green-50 border-green-200",
        tip:   "Cost derived from recipes.theoreticalCost ÷ recipes.yieldqty via hq_sale_items.source_recipe_id",
      };
    case "recipe:name-match":
      return {
        text:  "Name-matched recipe",
        color: "text-amber-700 bg-amber-50 border-amber-200",
        tip:   "source_recipe_id is null — recipe found by matching recipe.name to item.name (case-insensitive). Link via Edit drawer for a permanent association.",
      };
    case "none":
      return {
        text:  "No recipe — manual entry required",
        color: "text-red-700 bg-red-50 border-red-200",
        tip:   "No recipe is linked or name-matched. Set making_cost manually in the Edit drawer, or create and link a recipe.",
      };
  }
}

// ─── Build audit rows ─────────────────────────────────────────────────────────

export function buildAuditRows(items: SaleItem[], recipes: any[]): AuditRow[] {
  // Items missing cost (making_cost null or ≤ 0)
  const missing = items.filter(i => !i.makingCost || i.makingCost <= 0);

  return missing.map(item => {
    // 1. Try exact source_recipe_id link
    let recipe: any = null;
    let source: AuditSource = "none";

    if (item.sourceRecipeId) {
      recipe = recipes.find(r => String(r.id) === String(item.sourceRecipeId));
      if (recipe) source = "recipe:id";
    }

    // 2. Fall back to name match (case-insensitive, trim)
    if (!recipe) {
      const normName = item.name.trim().toLowerCase();
      recipe = recipes.find(r => r.name?.trim().toLowerCase() === normName);
      if (recipe) source = "recipe:name-match";
    }

    // 3. Derive cost only if recipe has valid numbers
    let derivedCost: number | null = null;
    if (
      recipe &&
      Number(recipe.theoreticalCost) > 0 &&
      Number(recipe.yieldQty) > 0
    ) {
      derivedCost = Number(recipe.theoreticalCost) / Number(recipe.yieldQty);
    }

    return {
      item,
      derivedCost,
      source,
      recipeId:   recipe ? String(recipe.id) : null,
      recipeName: recipe ? recipe.name : null,
      applied:    false,
      applying:   false,
      error:      null,
    };
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  items:   SaleItem[];
  recipes: any[];
  onCostApplied: () => void; // callback to reload page data after write
}

export function FgCostAuditPanel({ items, recipes, onCostApplied }: Props) {
  const [rows, setRows] = useState<AuditRow[]>(() => buildAuditRows(items, recipes));
  const [expanded, setExpanded] = useState(true);
  const [applying, setApplying] = useState(false);

  // Rebuild when parent reloads items/recipes
  const rebuild = useCallback(() => {
    setRows(buildAuditRows(items, recipes));
  }, [items, recipes]);

  if (rows.length === 0) return null; // nothing to show

  const derivable    = rows.filter(r => r.derivedCost !== null && !r.applied);
  const noRecipe     = rows.filter(r => r.source === "none");
  const alreadyDone  = rows.filter(r => r.applied);

  // ── Apply single ────────────────────────────────────────────────────────
  const applyOne = async (row: AuditRow) => {
    if (!row.derivedCost || row.derivedCost <= 0) return;
    // Guard: never overwrite existing positive cost
    if (row.item.makingCost > 0) return;

    setRows(prev => prev.map(r =>
      r.item.id === row.item.id ? { ...r, applying: true, error: null } : r
    ));

    const res = await updateSaleItemCost(
      row.item.id,
      row.derivedCost,
      row.item.sourceRecipeYieldQty || 1,
    );

    setRows(prev => prev.map(r =>
      r.item.id === row.item.id
        ? { ...r, applying: false, applied: res.success, error: res.success ? null : (res.error?.message ?? "Write failed") }
        : r
    ));

    if (res.success) onCostApplied();
  };

  // ── Apply all derivable ──────────────────────────────────────────────────
  const applyAll = async () => {
    setApplying(true);
    for (const row of derivable) {
      await applyOne(row);
    }
    setApplying(false);
  };

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 overflow-hidden shadow-sm">
      {/* ── Banner header ─────────────────────────────────────────────── */}
      <button
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-amber-100/60 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
          <div className="text-left">
            <p className="text-sm font-bold text-amber-900">
              Cost Audit — {rows.length} item{rows.length !== 1 ? "s" : ""} with missing <code className="font-mono text-xs">making_cost</code>
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              {derivable.length} derivable from recipe · {noRecipe.length} require manual entry
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {derivable.length > 0 && expanded && (
            <button
              onClick={e => { e.stopPropagation(); applyAll(); }}
              disabled={applying}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors shadow-sm"
            >
              {applying
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying all…</>
                : <><Wand2 className="h-3.5 w-3.5" /> Apply all ({derivable.length})</>}
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); rebuild(); }}
            className="p-1 rounded text-amber-500 hover:text-amber-700"
            title="Rebuild audit"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {expanded
            ? <ChevronDown className="h-4 w-4 text-amber-500" />
            : <ChevronRight className="h-4 w-4 text-amber-500" />}
        </div>
      </button>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-amber-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-amber-100/60 border-b border-amber-200">
              <tr>
                {["Item", "Category", "Derivable Cost", "Source", "Recipe", "Action"].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-amber-800 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-amber-100">
              {rows.map(row => {
                const sl = sourceLabel(row.source);
                return (
                  <tr
                    key={row.item.id}
                    className={`transition-colors ${row.applied ? "bg-green-50/60" : "hover:bg-amber-50"}`}
                  >
                    {/* Item */}
                    <td className="px-4 py-2.5">
                      <p className="font-semibold text-neutral-900 text-sm leading-tight">{row.item.name}</p>
                      <p className="text-[10px] text-neutral-400 font-mono mt-0.5">{row.item.id}</p>
                    </td>

                    {/* Category */}
                    <td className="px-4 py-2.5 text-xs text-neutral-500">
                      {row.item.category ?? "—"}
                    </td>

                    {/* Derivable cost */}
                    <td className="px-4 py-2.5 tabular-nums">
                      {row.applied ? (
                        <span className="text-green-700 font-semibold text-xs">
                          ✓ {$fmt(row.derivedCost!)} applied
                        </span>
                      ) : row.derivedCost !== null ? (
                        <span className="font-mono font-semibold text-neutral-900">
                          {$fmt(row.derivedCost)}
                          <span className="text-neutral-400 font-normal text-[10px] ml-1">/ {row.item.baseUnit}</span>
                        </span>
                      ) : (
                        <span className="text-red-500 text-xs font-medium flex items-center gap-1">
                          <XCircle className="h-3 w-3" /> Cannot derive
                        </span>
                      )}
                    </td>

                    {/* Source badge */}
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${sl.color}`}
                        title={sl.tip}
                      >
                        <Info className="h-2.5 w-2.5 shrink-0" />
                        {sl.text}
                      </span>
                    </td>

                    {/* Recipe name */}
                    <td className="px-4 py-2.5">
                      {row.recipeName ? (
                        <span className="text-xs text-neutral-700 font-medium">{row.recipeName}</span>
                      ) : (
                        <span className="text-neutral-300 text-xs">—</span>
                      )}
                    </td>

                    {/* Action */}
                    <td className="px-4 py-2.5">
                      {row.applied ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-700">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Applied
                        </span>
                      ) : row.error ? (
                        <span className="text-[11px] text-red-600 font-medium" title={row.error}>
                          ✗ {row.error}
                        </span>
                      ) : row.derivedCost !== null ? (
                        <button
                          onClick={() => applyOne(row)}
                          disabled={row.applying}
                          className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-white border border-amber-300 text-amber-800 rounded-lg hover:bg-amber-100 disabled:opacity-50 transition-colors"
                        >
                          {row.applying
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Wand2 className="h-3 w-3" />}
                          Apply
                        </button>
                      ) : (
                        <span className="text-[11px] text-neutral-400 italic">Edit manually</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Footer note */}
          <div className="px-5 py-3 border-t border-amber-100 flex items-start gap-2 text-xs text-amber-700 bg-amber-50/40">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              <strong>Only missing costs are shown here.</strong>{" "}
              Items with an existing making_cost &gt; 0 are never modified.
              Formula used: <code className="font-mono bg-amber-100 px-1 rounded">recipe.theoreticalCost ÷ recipe.yieldQty</code>.
              Items with no recipe must be costed manually via the Edit drawer.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
