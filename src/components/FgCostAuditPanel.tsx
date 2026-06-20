"use client";

/**
 * FgCostAuditPanel  (v2)
 *
 * Three cost method classifications — derived purely from existing SaleItem fields
 * plus a localStorage override map so HQ can mark purchased items without a DB migration.
 *
 * ── Classification logic ─────────────────────────────────────────────────────
 *  recipe_derived    → item.sourceRecipeId is set AND a matching recipe is found
 *                      Action: derive & apply cost automatically
 *
 *  manual_purchased  → item is externally sourced (Pav Bun, frozen puffs, bread, etc.)
 *                      Detection: manualPrice is set, OR user has toggled it via the UI
 *                      Display:   neutral blue badge — not a failure state
 *
 *  manual_no_recipe  → no recipe linked, not marked as purchased
 *                      These are HQ-produced items (sauces, gravies, batters)
 *                      that SHOULD have a recipe but do not yet.
 *                      Display:   amber warning badge + "Create Recipe" action
 *
 * ── Safety constraints (unchanged from v1) ───────────────────────────────────
 *  - NEVER overwrites making_cost when it is already > 0
 *  - NEVER writes a cost derived from theoreticalCost ≤ 0 or yieldQty ≤ 0
 *  - NEVER writes a cost when unit conversion is impossible
 *  - Skips inactive items from the UI
 *  - Uses existing updateSaleItemCost() — no new DB logic
 */

import { useState, useCallback, useEffect } from "react";
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
  ShoppingBag,
  BookOpen,
  Filter,
} from "lucide-react";
import { updateSaleItemCost, convertYieldToBaseUnit, type SaleItem } from "@/lib/storage";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CostMethod =
  | "recipe_derived"    // has sourceRecipeId + matching recipe found
  | "manual_purchased"  // externally sourced — no recipe needed
  | "manual_no_recipe"; // HQ-produced but recipe is missing → warning

export type AuditSource =
  | "recipe:id"         // linked via source_recipe_id
  | "recipe:name-match" // guessed by name when id is null
  | "none";             // no recipe

export interface AuditRow {
  item:        SaleItem;
  costMethod:  CostMethod;
  derivedCost: number | null;
  source:      AuditSource;
  recipeId:    string | null;
  recipeName:  string | null;
  applied:     boolean;
  applying:    boolean;
  error:       string | null;
}

export type AuditFilter = "all" | "recipe_derived" | "manual_purchased" | "manual_no_recipe";

const STORAGE_KEY = "fg_cost_method_overrides_v1";

// ─── Persistence helpers ──────────────────────────────────────────────────────

function loadOverrides(): Record<string, CostMethod> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveOverrides(overrides: Record<string, CostMethod>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {}
}

// ─── Format helper ────────────────────────────────────────────────────────────

const $fmt = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;

// ─── Build audit rows ─────────────────────────────────────────────────────────

export function buildAuditRows(
  items: SaleItem[],
  recipes: any[],
  overrides: Record<string, CostMethod>
): AuditRow[] {
  // Only show items with missing / zero making_cost
  const missing = items.filter(i => i.isActive && (!i.makingCost || i.makingCost <= 0));

  return missing.map(item => {
    // ── 1. Recipe lookup ──────────────────────────────────────────────────
    let recipe: any = null;
    let source: AuditSource = "none";

    if (item.sourceRecipeId) {
      recipe = recipes.find(r => String(r.id) === String(item.sourceRecipeId));
      if (recipe) source = "recipe:id";
    }
    if (!recipe) {
      const normName = item.name.trim().toLowerCase();
      recipe = recipes.find(r => r.name?.trim().toLowerCase() === normName);
      if (recipe) source = "recipe:name-match";
    }

    // ── 2. Derive cost ────────────────────────────────────────────────────
    let derivedCost: number | null = null;
    if (recipe && Number(recipe.theoreticalCost) > 0 && Number(recipe.yieldQty) > 0) {
      const conv = convertYieldToBaseUnit(
        Number(recipe.yieldQty),
        recipe.yieldUnit || "",
        item.baseUnit || "ea"
      );
      if (conv !== null && conv.qty > 0) {
        derivedCost = Number(recipe.theoreticalCost) / conv.qty;
      }
    }

    // ── 3. Classify cost method ───────────────────────────────────────────
    // Priority: localStorage override > auto-detection
    let costMethod: CostMethod;
    if (overrides[item.id]) {
      costMethod = overrides[item.id];
    } else if (source !== "none") {
      // Has a recipe → recipe_derived (even if cost can't be computed due to unit mismatch)
      costMethod = "recipe_derived";
    } else if (item.manualPrice != null && item.manualPrice > 0) {
      // Has explicit manual price set → treat as purchased item
      costMethod = "manual_purchased";
    } else {
      // No recipe, no manual price → missing recipe warning
      costMethod = "manual_no_recipe";
    }

    return {
      item,
      costMethod,
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

// ─── Badge configs ────────────────────────────────────────────────────────────

function costMethodBadge(method: CostMethod): {
  label: string;
  classes: string;
  icon: React.ReactNode;
  tip: string;
} {
  switch (method) {
    case "recipe_derived":
      return {
        label:   "Recipe Derived",
        classes: "text-green-700 bg-green-50 border-green-200",
        icon:    <BookOpen className="h-2.5 w-2.5 shrink-0" />,
        tip:     "Cost is derived from the linked recipe's theoretical cost ÷ yield.",
      };
    case "manual_purchased":
      return {
        label:   "Purchased Item — Manual Cost",
        classes: "text-blue-700 bg-blue-50 border-blue-200",
        icon:    <ShoppingBag className="h-2.5 w-2.5 shrink-0" />,
        tip:     "This item is purchased externally. Set the manual cost in the Edit drawer. No recipe is required.",
      };
    case "manual_no_recipe":
      return {
        label:   "Recipe Missing",
        classes: "text-amber-700 bg-amber-50 border-amber-200",
        icon:    <AlertTriangle className="h-2.5 w-2.5 shrink-0" />,
        tip:     "This item appears to be HQ-produced but has no linked recipe. Create a recipe and link it, or mark this as a purchased item.",
      };
  }
}

// ─── Filter tab config ────────────────────────────────────────────────────────

const FILTER_TABS: { key: AuditFilter; label: string }[] = [
  { key: "all",              label: "All" },
  { key: "recipe_derived",   label: "Recipe Derived" },
  { key: "manual_purchased", label: "Purchased / Manual Cost" },
  { key: "manual_no_recipe", label: "Missing Recipe" },
];

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  items:         SaleItem[];
  recipes:       any[];
  onCostApplied: () => void;
  onCreateRecipe?: (itemName: string) => void; // optional: navigate to recipe creation
}

export function FgCostAuditPanel({ items, recipes, onCostApplied, onCreateRecipe }: Props) {
  const [overrides, setOverrides]   = useState<Record<string, CostMethod>>({});
  const [rows, setRows]             = useState<AuditRow[]>([]);
  const [expanded, setExpanded]     = useState(true);
  const [applying, setApplying]     = useState(false);
  const [activeFilter, setFilter]   = useState<AuditFilter>("all");

  // Load persisted overrides on mount
  useEffect(() => {
    const saved = loadOverrides();
    setOverrides(saved);
  }, []);

  // Rebuild rows when data or overrides change
  useEffect(() => {
    setRows(buildAuditRows(items, recipes, overrides));
  }, [items, recipes, overrides]);

  const rebuild = useCallback(() => {
    setRows(buildAuditRows(items, recipes, overrides));
  }, [items, recipes, overrides]);

  // ── Method override toggle ──────────────────────────────────────────────────
  const setMethod = (itemId: string, method: CostMethod) => {
    setOverrides(prev => {
      const next = { ...prev, [itemId]: method };
      saveOverrides(next);
      return next;
    });
  };

  if (rows.length === 0) return null;

  // ── Counts ──────────────────────────────────────────────────────────────────
  const derivable    = rows.filter(r => r.costMethod === "recipe_derived" && r.derivedCost !== null && !r.applied);
  const purchased    = rows.filter(r => r.costMethod === "manual_purchased");
  const noRecipe     = rows.filter(r => r.costMethod === "manual_no_recipe");

  // ── Apply single ──────────────────────────────────────────────────────────
  const applyOne = async (row: AuditRow) => {
    if (!row.derivedCost || row.derivedCost <= 0) return;
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
    for (const row of derivable) await applyOne(row);
    setApplying(false);
  };

  // ── Filter rows ──────────────────────────────────────────────────────────
  const visibleRows = activeFilter === "all"
    ? rows
    : rows.filter(r => r.costMethod === activeFilter);

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm">
      {/* ── Banner header ──────────────────────────────────────────────── */}
      <button
        className="w-full flex items-center justify-between px-5 py-3.5 bg-slate-50 hover:bg-slate-100 transition-colors border-b border-slate-200"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
          <div className="text-left">
            <p className="text-sm font-bold text-slate-900">
              Cost Audit — {rows.length} item{rows.length !== 1 ? "s" : ""} with missing <code className="font-mono text-xs bg-slate-200 px-1 rounded">making_cost</code>
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              <span className="text-green-700 font-medium">{derivable.length} recipe-derivable</span>
              {" · "}
              <span className="text-blue-700 font-medium">{purchased.length} purchased/manual</span>
              {" · "}
              <span className="text-amber-700 font-medium">{noRecipe.length} missing recipe</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {derivable.length > 0 && expanded && (
            <button
              onClick={e => { e.stopPropagation(); applyAll(); }}
              disabled={applying}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors shadow-sm"
            >
              {applying
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Applying all…</>
                : <><Wand2 className="h-3.5 w-3.5" /> Apply all ({derivable.length})</>}
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); rebuild(); }}
            className="p-1 rounded text-slate-400 hover:text-slate-700 transition-colors"
            title="Rebuild audit"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {expanded
            ? <ChevronDown className="h-4 w-4 text-slate-400" />
            : <ChevronRight className="h-4 w-4 text-slate-400" />}
        </div>
      </button>

      {expanded && (
        <>
          {/* ── Filter tabs ──────────────────────────────────────────────── */}
          <div className="flex items-center gap-1 px-5 py-2.5 border-b border-slate-100 bg-slate-50/50">
            <Filter className="h-3.5 w-3.5 text-slate-400 mr-1 shrink-0" />
            {FILTER_TABS.map(tab => {
              const count =
                tab.key === "all"              ? rows.length :
                tab.key === "recipe_derived"   ? rows.filter(r => r.costMethod === "recipe_derived").length :
                tab.key === "manual_purchased" ? purchased.length :
                noRecipe.length;
              const isActive = activeFilter === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setFilter(tab.key)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors whitespace-nowrap ${
                    isActive
                      ? "bg-slate-800 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {tab.label} ({count})
                </button>
              );
            })}
          </div>

          {/* ── Table ──────────────────────────────────────────────────── */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  {["Item", "Category", "Cost Method", "Derivable Cost / Manual Cost", "Source / Supplier", "Action"].map(h => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-xs text-slate-400">
                      No items match this filter.
                    </td>
                  </tr>
                )}
                {visibleRows.map(row => {
                  const badge = costMethodBadge(row.costMethod);
                  const isPurchased = row.costMethod === "manual_purchased";
                  const isNoRecipe  = row.costMethod === "manual_no_recipe";

                  return (
                    <tr
                      key={row.item.id}
                      className={`transition-colors ${
                        row.applied    ? "bg-green-50/60" :
                        isPurchased    ? "bg-blue-50/20 hover:bg-blue-50/40" :
                        isNoRecipe     ? "hover:bg-amber-50/40" :
                        "hover:bg-slate-50"
                      }`}
                    >
                      {/* Item */}
                      <td className="px-4 py-2.5">
                        <p className="font-semibold text-slate-900 text-sm leading-tight">{row.item.name}</p>
                        <p className="text-[10px] text-slate-400 font-mono mt-0.5">{row.item.id}</p>
                      </td>

                      {/* Category */}
                      <td className="px-4 py-2.5 text-xs text-slate-500">
                        {row.item.category ?? "—"}
                      </td>

                      {/* Cost Method badge + toggle */}
                      <td className="px-4 py-2.5">
                        <div className="flex flex-col gap-1.5">
                          <span
                            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${badge.classes}`}
                            title={badge.tip}
                          >
                            {badge.icon}
                            {badge.label}
                          </span>
                          {/* Toggle: allow marking as purchased or reverting */}
                          {!row.applied && (
                            <div className="flex gap-1 flex-wrap">
                              {row.costMethod !== "manual_purchased" && (
                                <button
                                  onClick={() => setMethod(row.item.id, "manual_purchased")}
                                  className="text-[10px] text-blue-600 underline underline-offset-2 hover:text-blue-800 whitespace-nowrap"
                                >
                                  Mark as Purchased
                                </button>
                              )}
                              {row.costMethod === "manual_purchased" && overrides[row.item.id] && (
                                <button
                                  onClick={() => {
                                    setOverrides(prev => {
                                      const next = { ...prev };
                                      delete next[row.item.id];
                                      saveOverrides(next);
                                      return next;
                                    });
                                  }}
                                  className="text-[10px] text-slate-500 underline underline-offset-2 hover:text-slate-700 whitespace-nowrap"
                                >
                                  Revert
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Derivable Cost / Manual Cost column */}
                      <td className="px-4 py-2.5 tabular-nums">
                        {row.applied ? (
                          <span className="text-green-700 font-semibold text-xs">
                            ✓ {$fmt(row.derivedCost!)} applied
                          </span>
                        ) : isPurchased ? (
                          // Purchased item — show manual price if set, else prompt
                          row.item.manualPrice != null && row.item.manualPrice > 0 ? (
                            <span className="text-blue-700 font-semibold text-xs">
                              {$fmt(row.item.manualPrice)}
                              <span className="text-slate-400 font-normal ml-1">/ {row.item.baseUnit} (manual)</span>
                            </span>
                          ) : (
                            <span className="text-slate-400 text-xs italic">Set cost in Edit drawer</span>
                          )
                        ) : row.derivedCost !== null ? (
                          <span className="font-mono font-semibold text-slate-900">
                            {$fmt(row.derivedCost)}
                            <span className="text-slate-400 font-normal text-[10px] ml-1">/ {row.item.baseUnit}</span>
                          </span>
                        ) : row.source !== "none" ? (
                          // Has recipe but unit conversion failed
                          <span className="text-amber-600 text-xs font-medium flex items-center gap-1">
                            <XCircle className="h-3 w-3" /> Cannot derive — unit mismatch
                          </span>
                        ) : (
                          <span className="text-slate-400 text-xs italic">—</span>
                        )}
                      </td>

                      {/* Source / Supplier */}
                      <td className="px-4 py-2.5">
                        {row.recipeName ? (
                          <span className="text-xs text-slate-700 font-medium">{row.recipeName}</span>
                        ) : isPurchased ? (
                          <span className="text-xs text-blue-600 font-medium">
                            {row.item.sourceCommissary ?? "External supplier"}
                          </span>
                        ) : (
                          <span className="text-slate-300 text-xs">—</span>
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
                        ) : isPurchased ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-blue-700 font-medium">
                            <ShoppingBag className="h-3 w-3" /> Edit cost in drawer
                          </span>
                        ) : isNoRecipe ? (
                          <div className="flex flex-col gap-1">
                            <span className="text-[11px] text-amber-700 font-semibold">Recipe Missing</span>
                            {onCreateRecipe && (
                              <button
                                onClick={() => onCreateRecipe(row.item.name)}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold bg-amber-50 border border-amber-300 text-amber-800 rounded-lg hover:bg-amber-100 transition-colors"
                              >
                                <BookOpen className="h-3 w-3" /> Create Recipe
                              </button>
                            )}
                          </div>
                        ) : row.derivedCost !== null ? (
                          <button
                            onClick={() => applyOne(row)}
                            disabled={row.applying}
                            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-white border border-emerald-300 text-emerald-800 rounded-lg hover:bg-emerald-50 disabled:opacity-50 transition-colors"
                          >
                            {row.applying
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <Wand2 className="h-3 w-3" />}
                            Apply
                          </button>
                        ) : (
                          <span className="text-[11px] text-slate-400 italic">Fix unit mismatch</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Footer note ────────────────────────────────────────────── */}
          <div className="px-5 py-3 border-t border-slate-100 flex items-start gap-2 text-xs text-slate-500 bg-slate-50/60">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-400" />
            <span>
              <strong className="text-slate-700">Only items with missing making_cost are shown.</strong>{" "}
              Items with an existing making_cost&nbsp;&gt;&nbsp;0 are never modified.
              Use <em>Mark as Purchased</em> on items sourced externally (e.g. Pav Bun, bread, cookies, frozen puffs) to suppress the warning.
              This classification is saved locally and does not change any database values.
              HQ-produced items without a recipe (e.g. sauces, batters, gravies) should have a recipe created and linked.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
