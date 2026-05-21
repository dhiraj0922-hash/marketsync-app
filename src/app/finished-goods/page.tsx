"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import {
  Factory,
  Search,
  PackagePlus,
  AlertTriangle,
  CheckCircle2,
  PackageCheck,
  RefreshCw,
  Upload,
  ChefHat,
  Layers,
  ShoppingBag,
  Repeat2,
  X,
  History,
  ChevronDown,
  ChevronRight,
  Calendar,
  DollarSign,
  Package,
} from "lucide-react";
import {
  loadRecipes,
  loadInventory,
  saveInventory,
  loadRequisitions,
  saveRequisitions,
  loadProductionHistory,
  saveProductionHistory,
  logMovement,
  loadSaleItems,
  updateSaleItemStock,
  deductInventoryItemStock,
  loadProductionMovements,
  upsertRecipe,
  syncLinkedFgCost,
  updateInventoryLinkedRecipe,
  type ProductionMovementRow,
} from "@/lib/storage";
import {
  computeIngredientLineCost,
  convertQuantity,
  resolveEffectiveBaseUom,
} from "@/lib/units";
import { FgImportModal } from "@/components/FgImportModal";
import { findInventoryItem, warnInventoryIdentity, auditInventoryIdentity } from "@/lib/utils";

// ─── Classification helpers ───────────────────────────────────────────────────
//
// "Final" item:  is an output of a recipe AND is NOT used as an ingredient in
//               any other recipe.  (i.e. it is a leaf — nothing downstream
//               consumes it as a raw input)
//
// "Prep" item:  either:
//               a) itemType === "Preparation" (explicitly marked)
//               b) appears as an ingredient in at least one recipe
//               c) is NOT the output of any recipe
//               (Prep items are intermediate components / bases)
//
// Why this rule is safe:
//   • No DB changes — uses only in-memory recipes.ingredients[] and
//     recipes.outputItemId which are already loaded.
//   • Backward-compatible — existing production execution is untouched.
//   • Conservative: anything ambiguous lands in "Final" (visible by default).

type ItemClass = "final" | "prep";

function classifyItems(
  finishedGoods: any[],
  recipes: any[]
): Map<string, ItemClass> {
  // Build set: IDs that appear as ingredient.inventoryId in any recipe
  const ingredientIds = new Set<string>();
  recipes.forEach((r) => {
    (r.ingredients ?? []).forEach((ing: any) => {
      if (ing.inventoryId != null) ingredientIds.add(String(ing.inventoryId));
    });
  });

  // Build set: IDs that are the output of a recipe
  const outputIds = new Set<string>();
  recipes.forEach((r) => {
    if (r.outputItemId != null) outputIds.add(String(r.outputItemId));
  });

  const map = new Map<string, ItemClass>();
  finishedGoods.forEach((fg) => {
    const id = String(fg.id);
    const isIngredient = ingredientIds.has(id);
    const isOutput = outputIds.has(id);
    const isPreparation = fg.itemType === "Preparation";

    if (isPreparation || isIngredient) {
      // Definitively prep: explicitly typed OR consumed by another recipe
      map.set(id, "prep");
    } else if (isOutput && !isIngredient) {
      // Recipe output never consumed downstream → final
      map.set(id, "final");
    } else {
      // No recipe link at all: treat as final (conservative default — don't hide)
      map.set(id, "final");
    }
  });
  return map;
}

// ─── Filter options ───────────────────────────────────────────────────────────
type FilterMode = "all" | "final" | "prep";

const FILTER_TABS: { key: FilterMode; label: string }[] = [
  { key: "all",   label: "All" },
  { key: "final", label: "Final Items" },
  { key: "prep",  label: "Prep / Base" },
];

const stockIqDarkShellCss = `
  body .flex.bg-neutral-50.text-neutral-900.min-h-screen {
    background: #070707 !important;
    color: #e4e4e7 !important;
  }
  body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] {
    background: #111111 !important;
    border-color: #262626 !important;
  }
  body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] a,
  body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] button {
    color: #a1a1aa !important;
  }
  body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] a[class*="bg-brand-50"],
  body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] a:hover {
    background: #2563eb !important;
    color: #ffffff !important;
  }
  body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] svg {
    color: currentColor !important;
  }
  body header[class*="bg-white"][class*="border-b"] {
    background: #111111 !important;
    border-color: #262626 !important;
    box-shadow: none !important;
  }
  body header[class*="bg-white"] h1,
  body header[class*="bg-white"] button,
  body header[class*="bg-white"] span {
    color: #e4e4e7 !important;
  }
  body header[class*="bg-white"] input,
  body header[class*="bg-white"] [role="button"] {
    background: #171717 !important;
    border-color: #262626 !important;
    color: #e4e4e7 !important;
  }
`;

// ─── Badges ──────────────────────────────────────────────────────────────────
function ClassBadge({ cls }: { cls: ItemClass }) {
  return cls === "final" ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/20 bg-blue-500/15 px-2 py-0.5 text-[10px] font-bold text-blue-300">
      <Layers className="h-2.5 w-2.5" /> Final
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">
      <ChefHat className="h-2.5 w-2.5" /> Prep
    </span>
  );
}

function RecipeBadge({
  linked,
  recipeId,
  recipeName,
  onNavigate,
}: {
  linked: boolean;
  recipeId?: string | null;
  recipeName?: string | null;
  onNavigate?: () => void;
}) {
  const label = recipeName ? recipeName : "Linked recipe";
  if (linked && onNavigate) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onNavigate(); }}
        className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 cursor-pointer hover:bg-green-100 hover:border-green-400 focus:outline-none focus:ring-1 focus:ring-green-400 transition-colors"
        title="Open linked recipe"
      >
        <CheckCircle2 className="h-2.5 w-2.5" /> {label}
      </button>
    );
  }
  return linked ? (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">
      <CheckCircle2 className="h-2.5 w-2.5" /> {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
      <AlertTriangle className="h-2.5 w-2.5" /> No recipe
    </span>
  );
}


export default function FinishedGoods() {
  const router = useRouter();
  const [recipes, setRecipes]               = useState<any[]>([]);
  const [inventoryData, setInventoryData]   = useState<any[]>([]);
  const [saleItems, setSaleItems]           = useState<any[]>([]); // hq_sale_items
  const [requisitions, setRequisitions]     = useState<any[]>([]);
  const [productionHistory, setProductionHistory] = useState<any[]>([]);

  const [searchQuery, setSearchQuery]   = useState("");
  const [filterMode, setFilterMode]     = useState<FilterMode>("final");

  // ── Page-level view: item list vs history ────────────────────────────────
  type PageView = "items" | "history";
  const [pageView, setPageView] = useState<PageView>("items");

  // ── Production history (movements) ───────────────────────────────────────
  const [productionMovements, setProductionMovements] = useState<ProductionMovementRow[]>([]);
  const [historyLoading, setHistoryLoading]           = useState(false);
  const [historyDateFrom, setHistoryDateFrom]         = useState("");
  const [historyDateTo, setHistoryDateTo]             = useState("");
  const [historySearch, setHistorySearch]             = useState("");
  const [expandedEvents, setExpandedEvents]           = useState<Set<string>>(new Set());

  const [selectedFG, setSelectedFG]             = useState<any>(null);
  const [produceBatches, setProduceBatches]     = useState<number>(1);
  const [isAutoFulfillMode, setIsAutoFulfillMode] = useState<boolean>(false);
  const [isImportOpen, setIsImportOpen]         = useState(false);
  const [isLoading, setIsLoading]               = useState(true);

  // ── Ingredient substitution (session-only, never persisted) ──────────────
  // Key = ingredient index in recipe.ingredients[]
  // Value = the inventory item chosen as substitute for this production run
  const [substitutes, setSubstitutes] = useState<Map<number, any>>(new Map());
  // Which ingredient's substitute picker is open
  const [substituteModal, setSubstituteModal] = useState<{ ingIdx: number; query: string } | null>(null);

  // ── "Update recipe" permanent-substitute confirmation dialog ─────────────
  type RecipeUpdateTarget = {
    ingIdx:        number;   // index in recipe.ingredients[]
    substituteItem: any;    // the new inventory item
    recipe:         any;    // the recipe object to patch
  };
  const [recipeUpdateConfirm, setRecipeUpdateConfirm] = useState<RecipeUpdateTarget | null>(null);
  const [recipeUpdateSaving,  setRecipeUpdateSaving]  = useState(false);
  const [recipeUpdateError,   setRecipeUpdateError]   = useState<string | null>(null);

  // ── Prep recipe linking state ─────────────────────────────────────────────
  // linkingRecipeFor: the inventory item id whose recipe picker is open (null = closed)
  const [linkingRecipeFor,  setLinkingRecipeFor]  = useState<string | null>(null);
  const [recipeSearchQuery, setRecipeSearchQuery] = useState("");
  const [savingLinkFor,     setSavingLinkFor]     = useState<string | null>(null);

  // ── Handler: permanently swap one ingredient in a recipe ─────────────────
  async function handleUpdateRecipeIngredient() {
    if (!recipeUpdateConfirm) return;
    const { ingIdx, substituteItem, recipe } = recipeUpdateConfirm;
    setRecipeUpdateSaving(true);
    setRecipeUpdateError(null);
    try {
      // Deep-clone the ingredient list and swap the target ingredient
      const newIngredients = (recipe.ingredients ?? []).map((ing: any, i: number) => {
        if (i !== ingIdx) return ing;
        return {
          ...ing,
          inventoryId: substituteItem.id,
          name:        substituteItem.name,
          // Preserve quantity and unit — only the item reference changes
        };
      });

      // Recalculate theoretical cost using the canonical costing engine
      let theoreticalCost = 0;
      for (const ing of newIngredients) {
        const invItem = findInventoryItem(inventoryData, ing.inventoryId?.toString());
        if (!invItem) continue;
        const result = computeIngredientLineCost(
          Number(ing.qty ?? ing.quantity ?? 0),
          ing.unit ?? '',
          invItem,
        );
        if (result.ok) theoreticalCost += result.cost;
      }

      const updatedRecipe = { ...recipe, ingredients: newIngredients, theoreticalCost };

      const { success, error } = await upsertRecipe(updatedRecipe);
      if (!success) throw new Error(error?.message ?? "Recipe save failed");

      // Sync linked FG making_cost exactly as the Recipes page does on save
      await syncLinkedFgCost({
        id:              updatedRecipe.id,
        theoreticalCost: updatedRecipe.theoreticalCost,
        yieldQty:        updatedRecipe.yieldQty ?? 1,
        yieldUnit:       updatedRecipe.yieldUnit ?? 'ea',
      });

      // Update local recipes state so the modal reflects the change immediately
      setRecipes(prev =>
        prev.map(r => r.id === updatedRecipe.id ? updatedRecipe : r)
      );

      // Remove the session substitute since the recipe now uses the new item
      setSubstitutes(prev => {
        const m = new Map(prev);
        m.delete(ingIdx);
        return m;
      });

      setRecipeUpdateConfirm(null);
    } catch (err: any) {
      setRecipeUpdateError(err?.message ?? "An error occurred");
    } finally {
      setRecipeUpdateSaving(false);
    }
  }

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const [rec, inv, si, req, hist] = await Promise.all([
          loadRecipes(),
          loadInventory(),
          loadSaleItems(),          // hq_sale_items — the bridge
          loadRequisitions(),
          loadProductionHistory(),
        ]);
        setRecipes(Array.isArray(rec) ? rec : []);
        const invArray = Array.isArray(inv) ? inv : [];
        setInventoryData(invArray);
        // Dev-mode identity audit — no-op in production
        auditInventoryIdentity(invArray);
        invArray.forEach((item: any) => warnInventoryIdentity(item));
        setSaleItems(Array.isArray(si) ? si : []);
        setRequisitions(Array.isArray(req) ? req : []);
        setProductionHistory(Array.isArray(hist) ? hist : []);
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, []);

  // ── Lazy-load production movements when history tab is active ────────────
  useEffect(() => {
    if (pageView !== "history") return;
    let cancelled = false;
    async function loadHistory() {
      setHistoryLoading(true);
      try {
        const rows = await loadProductionMovements({
          dateFrom: historyDateFrom || undefined,
          dateTo:   historyDateTo   || undefined,
        });
        if (!cancelled) setProductionMovements(rows);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    }
    loadHistory();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageView, historyDateFrom, historyDateTo]);

  if (isLoading) {
    return (
      <div className="p-12 flex justify-center text-neutral-400 animate-pulse">
        Loading Production...
      </div>
    );
  }

  // ── inventory_items FG/Prep base ─────────────────────────────────────────
  const invFinishedGoods = inventoryData.filter(
    (i) => i.itemType === "Finished Good" || i.itemType === "Preparation"
  );

  // ── Build set of IDs already covered by inventory_items ─────────────────
  // Used for deduplication: if hq_sale_items.id already exists in
  // inventory_items, we do NOT add a second virtual item.
  const invFgIds = new Set(invFinishedGoods.map((i: any) => String(i.id)));

  // ── Adapt hq_sale_items → virtual production items ───────────────────────
  // _source flag routes stock writes to the correct table in executeProduction.
  // These items are never written into inventory_items.
  const saleItemVirtuals = saleItems
    .filter((si: any) => !invFgIds.has(String(si.id))) // deduplicate by ID
    .map((si: any) => {
      // Required debug log per request
      console.log("FG:", si.name, "source_recipe_id:", si.sourceRecipeId);
      return {
        id:             si.id,
        name:           si.name,
        inStock:        si.instock ?? si.inStock ?? 0,
        unit:           si.baseUnit ?? "ea",
        category:       si.category ?? "",
        itemType:       "Finished Good",
        cost:           si.makingCost ?? 0,
        locationId:     "LOC-HQ",
        _source:        "hq_sale_items" as const,   // routing flag
        sourceRecipeId: si.sourceRecipeId ?? null,  // hq_sale_items.source_recipe_id
      };
    });

  // ── Merged display list ──────────────────────────────────────────────────
  // inventory_items items first (existing behaviour), then hq_sale_items adapters.
  const finishedGoods = [...invFinishedGoods, ...saleItemVirtuals];

  // ── Classify each item ───────────────────────────────────────────────────
  // hq_sale_items adapters are always classified "final" (they are sellable output).
  const classMap = classifyItems(finishedGoods, recipes);
  // Guarantee every hq_sale_items virtual is "final" regardless of recipe graph
  saleItemVirtuals.forEach((v) => classMap.set(String(v.id), "final"));

  // ── Backorder / popularity maps ──────────────────────────────────────────
  const reqBackorders   = new Map<string, number>();
  const requestedCounts = new Map<string, number>();

  requisitions.forEach((req) => {
    req.lineItems.forEach((li: any) => {
      requestedCounts.set(li.id, (requestedCounts.get(li.id) || 0) + li.requestedQty);
      if (
        req.status === "Partial" ||
        req.status === "Approved" ||
        req.status === "Backordered"
      ) {
        const remaining = li.requestedQty - (li.fulfilledQty || 0);
        if (remaining > 0) {
          reqBackorders.set(li.id, (reqBackorders.get(li.id) || 0) + remaining);
        }
      }
    });
  });

  // ── Stats ────────────────────────────────────────────────────────────────
  let maxBackorderId = "N/A";
  let maxBackCount   = 0;
  reqBackorders.forEach((val, id) => {
    if (val > maxBackCount) { maxBackCount = val; maxBackorderId = id; }
  });
  const topBackorderName =
    finishedGoods.find((fg) => fg.id === maxBackorderId)?.name || "None";

  const totalSKUs       = finishedGoods.length;
  const finalCount      = [...classMap.values()].filter((v) => v === "final").length;
  const prepCount       = [...classMap.values()].filter((v) => v === "prep").length;
  const hqLinkedCount   = saleItemVirtuals.length;
  const totalBackorders = Array.from(reqBackorders.values()).reduce(
    (a: number, b: number) => a + b, 0
  );

  const producedToday = productionHistory.filter((ph) => {
    const today = new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return ph.date === today;
  }).length;

  // ── Filtering pipeline ───────────────────────────────────────────────────
  const filteredFGs = finishedGoods.filter((fg) => {
    const cls = classMap.get(String(fg.id)) ?? "final";
    if (filterMode === "final" && cls !== "final") return false;
    if (filterMode === "prep"  && cls !== "prep")  return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!fg.name?.toLowerCase().includes(q) && !fg.id?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // ── Recipe lookup ─────────────────────────────────────────────────────────
  // Lookup priority:
  //   1. sourceRecipeId  — hq_sale_items.source_recipe_id (UUID FK → recipes.id)
  //   2. outputItemId matches fg.id (inventory row PK)
  //   3. outputItemId matches fg.itemId (shared identity column)
  //   4. outputItemType=prep + outputItemId matches fg.id or fg.itemId (explicit prep link)
  //   5. Name-match — hq_sale_items only
  //   6. Name-match — prep inventory items (outputItemType=prep)
  const findRecipeForFg = (fg: any) => {
    const fgIdStr     = String(fg.id     ?? '');
    const fgItemIdStr = String(fg.itemId ?? '');

    // Diagnostic log — fires once per item render; check browser console
    console.log(
      `[findRecipeForFg] checking "${fg.name}" | fg.id="${fgIdStr}" | fg.itemId="${fgItemIdStr}" | fg.itemType="${fg.itemType}" | fg._source="${fg._source ?? 'inventory_items'}"`
    );

    // Log all recipes' output links so mismatch is immediately visible
    if (process.env.NODE_ENV !== 'production') {
      recipes.forEach(r => {
        if (r.outputItemId) {
          console.log(
            `  recipe "${r.name}" outputItemId="${r.outputItemId}" outputItemType="${r.outputItemType}"`
          );
        }
      });
    }

    // 1. source_recipe_id — the canonical link stored on hq_sale_items
    if (fg.sourceRecipeId) {
      const bySourceId = recipes.find(
        (r) => r.id?.toString() === fg.sourceRecipeId.toString()
      );
      if (bySourceId) {
        console.log(`  [findRecipeForFg] MATCH via sourceRecipeId → "${bySourceId.name}"`);
        return bySourceId;
      }
      console.warn(
        `[findRecipeForFg] source_recipe_id=${fg.sourceRecipeId} not found in loaded recipes for "${fg.name}"`
      );
    }

    // 2 & 3. outputItemId matches fg.id OR fg.itemId — FG path (non-prep first)
    const byOutputId = recipes.find((r) => {
      if (!r.outputItemId || r.outputItemType === 'prep') return false;
      const oid = String(r.outputItemId);
      return oid === fgIdStr || (fgItemIdStr && oid === fgItemIdStr);
    });
    if (byOutputId) {
      console.log(`  [findRecipeForFg] MATCH via outputItemId (FG) id/itemId → "${byOutputId.name}"`);
      return byOutputId;
    }

    // 4. Prep item match — recipe.outputItemType === 'prep', matches fg.id OR fg.itemId
    const byPrepOutputId = recipes.find((r) => {
      if (!r.outputItemId || r.outputItemType !== 'prep') return false;
      const oid = String(r.outputItemId);
      return oid === fgIdStr || (fgItemIdStr && oid === fgItemIdStr);
    });
    if (byPrepOutputId) {
      console.log(`  [findRecipeForFg] MATCH via outputItemId (Prep) id/itemId → "${byPrepOutputId.name}"`);
      return byPrepOutputId;
    }

    // 5. Name-match fallback — hq_sale_items only, exact match
    if (fg._source === "hq_sale_items") {
      const norm = fg.name.trim().toLowerCase();
      const byName = recipes.find((r) => r.name?.trim().toLowerCase() === norm) ?? null;
      if (byName) console.log(`  [findRecipeForFg] MATCH via name (hq_sale_items) → "${byName.name}"`);
      else console.log(`  [findRecipeForFg] NO MATCH for "${fg.name}" (hq_sale_items)`);
      return byName;
    }

    // 6. Name-match fallback — prep inventory items
    if (fg.itemType === "Preparation") {
      const norm = fg.name.trim().toLowerCase();
      const byName = recipes.find(
        (r) => r.outputItemType === 'prep' && r.name?.trim().toLowerCase() === norm
      );
      if (byName) {
        console.log(`  [findRecipeForFg] MATCH via name (Prep) → "${byName.name}"`);
        return byName;
      }
    }

    console.log(`  [findRecipeForFg] NO MATCH for "${fg.name}" (all paths exhausted)`);
    return null;
  };


  // ── getLinkedRecipe: authoritative recipe lookup for prep inventory items ──
  // For prep items: use fg.linkedRecipeId directly (explicit HQ mapping).
  // For FG/hq_sale_items: fall through to findRecipeForFg() which handles
  //   sourceRecipeId / outputItemId / name-match paths.
  const getRecipeForItem = (fg: any) => {
    if (fg.itemType === "Preparation" && fg.linkedRecipeId) {
      return recipes.find((r) => r.id?.toString() === fg.linkedRecipeId.toString()) ?? null;
    }
    // Non-prep items — FG workflow unchanged
    return findRecipeForFg(fg);
  };

  // ── Substitute helper ─────────────────────────────────────────────────────
  // Returns the effective raw item for a given ingredient — substitute if set,
  // otherwise the original inventory lookup.  Keyed by ingredient array index.
  const getEffectiveRawItem = (ing: any, ingIdx: number, invList = inventoryData): any | null => {
    if (substitutes.has(ingIdx)) return substitutes.get(ingIdx);
    return invList.find(
      (i: any) =>
        i.id.toString() === ing.inventoryId.toString() ||
        i.itemId === ing.inventoryId
    ) ?? null;
  };

  // ── Production constraints ───────────────────────────────────────────────
  // Unchanged from original — no production logic modified.
  const getProductionConstraints = (fg: any, batches: number) => {
    const recipe = getRecipeForItem(fg);
    if (!recipe || !recipe.ingredients)
      return { valid: true, shortages: [], maxBatches: -1, yield: 0, ingredientsCheck: [] };

    let valid = true;
    const shortages: any[] = [];
    let maxBatches = Infinity;

    const ingredientsCheck = recipe.ingredients.map((ing: any, ingIdx: number) => {
      const rawItem = getEffectiveRawItem(ing, ingIdx);
      const inStock = rawItem ? rawItem.inStock : 0;
      const isSubstituted = substitutes.has(ingIdx);

      // Labour items (LABOUR*/LABOR* by name) are available on demand.
      // Their instock is always 0 and should never block production or
      // reduce maxBatches — they still appear in the check table for visibility.
      const itemNameUpper = (rawItem?.name ?? ing.name ?? '').toUpperCase();
      const isLabour = itemNameUpper.includes('LABOUR') || itemNameUpper.includes('LABOR');

      let requiredTotal    = 0;
      let short            = false;
      let possibleCount    = 0;
      let conversionError  = '';
      let itemCost         = 0;   // cost per base unit

      if (rawItem) {
        // ── Route through the canonical costing engine ────────────────────────
        // This is the ONLY place production constraints compute cost/qty.
        // computeIngredientLineCost handles: unit canonicalization,
        // qty conversion into item base unit, three-path cost chain.
        const lineResult = computeIngredientLineCost(
          ing.qty,
          ing.unit,
          rawItem,
        );

        if (lineResult.ok) {
          // normalizedQty is in the item's base unit — use for stock comparison
          const normalizedQtyPerBatch = lineResult.normalizedQty;
          requiredTotal = normalizedQtyPerBatch * batches;
          itemCost      = lineResult.costPerBaseUnit;

          if (!isLabour) {
            short = requiredTotal > inStock;
            if (short) valid = false;
            possibleCount = normalizedQtyPerBatch > 0
              ? Math.floor(inStock / normalizedQtyPerBatch)
              : 0;
            if (possibleCount < maxBatches) maxBatches = possibleCount;
          }
        } else {
          // Dimension incompatible — only block production for non-labour
          conversionError = lineResult.error;
          if (!isLabour) {
            valid = false;
            maxBatches = 0;
          }
        }
      } else {
        // rawItem not found — can still show the row for visibility
        conversionError = `Inventory item not found`;
        if (!isLabour) { valid = false; maxBatches = 0; }
      }

      if (short || conversionError) {
        shortages.push({
          name: ing.name || (rawItem ? rawItem.name : 'Unknown'),
          required: requiredTotal,
          available: inStock,
          unit: rawItem ? resolveEffectiveBaseUom(rawItem) : ing.unit,
          error: conversionError,
        });
      }

      return {
        name:          ing.name || (rawItem ? rawItem.name : 'Unknown'),
        effectiveName: rawItem?.name ?? ing.name ?? 'Unknown',
        originalName:  ing.name || 'Unknown',
        isSubstituted,
        requiredTotal,
        inStock,
        unit: rawItem ? resolveEffectiveBaseUom(rawItem) : ing.unit,
        isShort: short || !!conversionError,
        error: conversionError,
        ingIdx,
        isLabour,
        itemCost,  // cost per base unit (not raw item.cost)
      };
    });

    return {
      valid,
      shortages,
      maxBatches: maxBatches === Infinity ? 0 : maxBatches,
      yield: recipe.yieldQty * batches,
      unit: recipe.yieldUnit,
      ingredientsCheck,
    };
  };

  const activeConstraints = selectedFG
    ? getProductionConstraints(selectedFG, produceBatches)
    : null;

  // (findRecipeForFg and executeProduction are defined below)
  // Branched on fg._source for stock write:
  //   'hq_sale_items' → updateSaleItemStock() (writes hq_sale_items.instock)
  //   undefined/other → saveInventory()       (writes inventory_items, unchanged)
  const executeProduction = async (
    fg: any,
    targetBatches: number,
    autoFulfill: boolean
  ) => {
    const rule   = getProductionConstraints(fg, targetBatches);
    const recipe = getRecipeForItem(fg);
    if (!recipe || !rule) return;

    const isHqItem = fg._source === "hq_sale_items";

    // ── 1. Build deduction plan ──────────────────────────────────────────────
    //
    // KEY FIX: Previously the isHqItem branch mutated a local _inv copy then
    // discarded it because saveInventory() was inside the !isHqItem else block.
    // Ingredient deductions NEVER reached the DB for hq_sale_items items.
    //
    // Fix: build a deductionPlan[] of (rowId, rawItem, normalizedQty) tuples
    // up-front, then call deductInventoryItemStock() for EVERY ingredient on
    // BOTH paths (step 5a). This is an atomic targeted UPDATE per row.
    //
    const _inv = [...inventoryData]; // still needed for auto-fulfill stock math

    type DeductionPlan = {
      rowId:          string;
      rawItem:        any;
      normalizedQty:  number;
      isLabourItem:   boolean;  // labour items skip stock deduction but still log movement
      substituteNote: string;   // "" when no substitute; "substitute for X" when swapped
    };
    const deductionPlan: DeductionPlan[] = [];

    for (const [ingIdx, ing] of recipe.ingredients.entries()) {
      const rawItem = getEffectiveRawItem(ing, ingIdx, _inv);

      if (!rawItem) {
        console.warn(
          `[executeProduction] ingredient "${ing.name}" (inventoryId=${ing.inventoryId})${
            substitutes.has(ingIdx) ? " [substitute]" : ""
          } not found in loaded inventory — skipping`
        );
        continue;
      }

      // Detect labour items by name — they have instock=0 intentionally and
      // must NOT reduce physical stock, but MUST still enter deductionPlan so
      // logMovement('production_consumption') fires for them.
      const _itemNameUpper = (rawItem.name ?? ing.name ?? "").toUpperCase();
      const isLabourItem = _itemNameUpper.includes("LABOUR") || _itemNameUpper.includes("LABOR");

      // ── Canonical qty normalisation via the costing engine ──────────────
      // MUST normalise into the item's base unit — not rawItem.unit (display)
      // — to ensure stock deduction matches the correct quantity dimension.
      const baseUomForDeduction = resolveEffectiveBaseUom(rawItem);
      const deductConv = convertQuantity(ing.qty, ing.unit, baseUomForDeduction);
      let normalizedQty = 0;
      if (deductConv.ok) {
        normalizedQty = (deductConv.qty ?? 0) * targetBatches;
      } else {
        console.error(
          `[executeProduction] unit convert failed for "${ing.name}": ${deductConv.error}. Using raw qty.`
        );
        normalizedQty = ing.qty * targetBatches;
      }
      if (normalizedQty <= 0) continue;

      // Always push into deductionPlan (including labour) so movement log fires.
      // isLabourItem is carried in the plan entry so step 5a can skip the
      // physical DB deduction for labour without skipping the movement log.
      const isSubstituteUsed = substitutes.has(ingIdx);
      deductionPlan.push({
        rowId: String(rawItem.id),
        rawItem,
        normalizedQty,
        isLabourItem,
        // Carry substitute label into movement log notes
        substituteNote: isSubstituteUsed
          ? `[substitute for "${ing.name}"]`
          : "",
      });

      // Mirror in _inv for auto-fulfill FG stock math — skip for labour
      // (instock is intentionally 0; mirroring a deduction is a no-op).
      if (!isLabourItem) {
        const idx = _inv.findIndex((i: any) => i.id.toString() === rawItem.id.toString());
        if (idx !== -1) {
          _inv[idx].inStock = Math.max(0, _inv[idx].inStock - normalizedQty);
        }
      }
    }

    // ── 2. FG yield amount ───────────────────────────────────────────────────
    const yieldAmount = recipe.yieldQty * targetBatches;

    // inventory_items path: apply FG output increment in _inv for saveInventory()
    const fgIndex = _inv.findIndex(
      (f: any) => f.id.toString() === fg.id.toString()
    );
    if (!isHqItem && fgIndex !== -1) {
      _inv[fgIndex].inStock += yieldAmount;
      _inv[fgIndex].lastProduced = new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }

    // ── 3. Production history log ────────────────────────────────────────────
    const newLog = {
      id:      `PRD-${1000 + productionHistory.length}`,
      fgId:    fg.id,
      fgName:  fg.name,
      date:    new Date().toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      batches: targetBatches,
      yield:   yieldAmount,
      status:  "Completed",
    };

    const _hist = [newLog, ...productionHistory];
    const histRes = await saveProductionHistory(_hist);
    if (!histRes?.success) {
      alert(`Database Error (Save Production log): ${histRes?.error?.message}`);
      return;
    }
    setProductionHistory(_hist);

    let alertMsg = `Successfully produced ${targetBatches} batches of ${fg.name} yielding ${yieldAmount} ${recipe.yieldUnit}!`;

    // ── 4. Auto-fulfill (inventory_items FG path only) ───────────────────────
    if (autoFulfill && !isHqItem && fgIndex !== -1) {
      const _reqs = [...requisitions];
      let fulfilledTotal = 0;

      _reqs.forEach((r, rIdx) => {
        if (
          r.status === "Approved" ||
          r.status === "Partial" ||
          r.status === "Backordered"
        ) {
          let allLineItemsDone = true;

          const updatedLines = r.lineItems.map((li: any) => {
            if (li.id.toString() === fg.id.toString()) {
              const remainingGap = li.requestedQty - (li.fulfilledQty || 0);
              if (remainingGap > 0) {
                const hqStock = _inv[fgIndex].inStock;
                if (hqStock >= remainingGap) {
                  _inv[fgIndex].inStock -= remainingGap;
                  fulfilledTotal += remainingGap;
                  return { ...li, fulfilledQty: li.requestedQty };
                } else if (hqStock > 0) {
                  _inv[fgIndex].inStock = 0;
                  fulfilledTotal += hqStock;
                  allLineItemsDone = false;
                  return { ...li, fulfilledQty: (li.fulfilledQty || 0) + hqStock };
                }
              }
            }
            if ((li.requestedQty - (li.fulfilledQty || 0)) > 0) allLineItemsDone = false;
            return li;
          });

          _reqs[rIdx].lineItems = updatedLines;
          _reqs[rIdx].status = allLineItemsDone ? "Fulfilled" : "Partial";
        }
      });

      const reqRes = await saveRequisitions(_reqs);
      if (!reqRes?.success) {
        alert(`Database Error (Save Requisitions): ${reqRes?.error?.message}`);
        return;
      }
      setRequisitions(_reqs);
      alertMsg += ` Auto-fulfilled ${fulfilledTotal} ${recipe.yieldUnit} to open Requisitions.`;
    }

    // ── 5a. Deduct ingredients from inventory_items (BOTH paths) ────────────
    //
    // Each call is an atomic read-modify-write UPDATE on inventory_items.
    // Labour items (isLabourItem=true) are skipped here — their instock is
    // intentionally 0 and must not be touched. They still appear in
    // deductionPlan so that logMovement fires for them in step 6.
    //
    const failedDeductions: string[] = [];
    for (const plan of deductionPlan) {
      if (plan.isLabourItem) {
        console.log(
          `[Production] labour item "${plan.rawItem.name}" — skipping stock deduction, movement will still be logged`
        );
        continue;
      }
      console.log(
        `[Production] deducting: ${plan.rawItem.name} (id=${plan.rowId}) × ${plan.normalizedQty} ${plan.rawItem.unit}`
      );
      const deductRes = await deductInventoryItemStock(plan.rowId, plan.normalizedQty);
      if (!deductRes.success) {
        failedDeductions.push(plan.rawItem.name);
        console.error(`[Production] deduction failed for ${plan.rawItem.name}:`, deductRes.error);
      } else {
        // Mirror confirmed new stock into local state (no full reload needed)
        setInventoryData((prev: any[]) =>
          prev.map((item: any) =>
            item.id.toString() === plan.rowId
              ? { ...item, inStock: deductRes.newStock ?? item.inStock }
              : item
          )
        );
      }
    }

    if (failedDeductions.length > 0) {
      alert(
        `Warning: Could not deduct stock for: ${failedDeductions.join(", ")}.\n` +
        `Production log was saved. Please manually adjust inventory.`
      );
    }

    // ── 5b. FG stock increment ───────────────────────────────────────────────
    if (isHqItem) {
      // hq_sale_items: increment instock via dedicated fn
      const stockRes = await updateSaleItemStock(fg.id, yieldAmount);
      if (!stockRes?.success) {
        alert(`Database Error (Update HQ Sale Item stock): ${stockRes?.error?.message}`);
        return;
      }
      setSaleItems((prev: any[]) =>
        prev.map((si: any) =>
          si.id === fg.id
            ? { ...si, instock: (si.instock ?? si.inStock ?? 0) + yieldAmount }
            : si
        )
      );
    } else {
      // inventory_items: saveInventory() writes FG output increment + auto-fulfill changes
      const invRes = await saveInventory(_inv);
      if (!invRes?.success) {
        alert(`Database Error (Save Inventory): ${invRes?.error?.message}`);
        return;
      }
      setInventoryData(_inv);
    }

    // ── 6. Movement logging (fire-and-forget) ────────────────────────────────
    (async () => {
      // One production_consumption row per ingredient
      for (const plan of deductionPlan) {
        await logMovement({
          locationId:    plan.rawItem.locationId ?? "LOC-HQ",
          itemId:        String(plan.rawItem?.itemId || plan.rowId),
          movementType:  "production_consumption",
          quantity:      plan.normalizedQty,
          unitCost:      plan.rawItem.cost ?? null,
          referenceType: "production",
          referenceId:   newLog.id,
          notes: `Production: ${targetBatches}× ${fg.name} — consumed ${plan.normalizedQty} ${plan.rawItem.unit} of ${plan.rawItem.name}${
            (plan as any).substituteNote ? " " + (plan as any).substituteNote : ""
          }`,
        });
      }

      // production_in for the output item (works for both prep and FG; item_id is TEXT)
      const isPrepOutput = recipe.outputItemType === 'prep' || fg.itemType === 'Preparation';
      await logMovement({
        locationId:    fg.locationId ?? "LOC-HQ",
        itemId:        String(fg.id),
        movementType:  "production_in",
        quantity:      yieldAmount,
        unitCost:      fg.cost ?? null,
        referenceType: "production",
        referenceId:   newLog.id,
        notes: `Production output: ${targetBatches} batches of ${fg.name}${isPrepOutput ? " [prep_item]" : isHqItem ? " [hq_sale_items]" : ""}`,

      });
    })();

    setSelectedFG(null);
    setProduceBatches(1);
    setIsAutoFulfillMode(false);
    setSubstitutes(new Map());   // clear substitutes for next production run
    setSubstituteModal(null);
    alert(alertMsg);
  };

  const openAutoFulfillModule = (e: any, fg: any) => {
    e.stopPropagation();
    const demand = reqBackorders.get(fg.id) || 0;
    const recipe = getRecipeForItem(fg);

    if (demand <= 0 || !recipe) {
      alert("No open backorders found for this item, or Recipe is missing.");
      return;
    }

    const theoreticalBatchesRequired = Math.ceil(demand / recipe.yieldQty);
    setSelectedFG(fg);
    setProduceBatches(theoreticalBatchesRequired);
    setIsAutoFulfillMode(true);
  };

  // ── handleLinkRecipe: assign or clear a recipe for a prep inventory item ──
  const handleLinkRecipe = async (prepItemId: string, recipeId: string | null) => {
    setSavingLinkFor(prepItemId);
    const res = await updateInventoryLinkedRecipe(prepItemId, recipeId);
    setSavingLinkFor(null);
    if (!res.success) {
      alert(`Failed to save recipe link: ${res.error?.message ?? 'Unknown error'}\n\nMake sure migration_linked_recipe.sql has been run in Supabase.`);
      return;
    }
    // Mirror into local inventoryData immediately — no full reload needed
    setInventoryData((prev: any[]) =>
      prev.map((item: any) =>
        item.id.toString() === prepItemId.toString()
          ? { ...item, linkedRecipeId: recipeId }
          : item
      )
    );
    setLinkingRecipeFor(null);
    setRecipeSearchQuery("");
  };

  // ─── JSX ───────────────────────────────────────────────────────────────────
  return (
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-[#070707] p-6 text-zinc-100">
      <style>{stockIqDarkShellCss}</style>
      <div className="mx-auto max-w-[1408px] space-y-5">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-500">Production</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Production</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Central kitchen batch execution and auto-fulfillment.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Page-level view tabs */}
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#151515] p-1 shadow-inner shadow-black/30">
            <button
              onClick={() => setPageView("items")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                pageView === "items"
                  ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              <Package className="h-3.5 w-3.5" /> Production Items
            </button>
            <button
              onClick={() => setPageView("history")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                pageView === "history"
                  ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20"
                  : "text-zinc-400 hover:text-white"
              }`}
            >
              <History className="h-3.5 w-3.5" /> Production History
            </button>
          </div>
          <button
            onClick={() => setIsImportOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#151515] px-4 py-2 text-sm font-semibold text-zinc-300 shadow-sm transition-colors hover:bg-[#1f1f1f]"
          >
            <Upload className="h-4 w-4" /> Import CSV
          </button>
        </div>
      </div>

      {pageView === "items" && (<>

      {/* ── Metrics ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Total SKUs",             value: totalSKUs.toString(),       icon: <Package className="h-5 w-5" />, tone: "blue" },
          { label: "Final Items",            value: finalCount.toString(),      icon: <Layers className="h-5 w-5" />, tone: "emerald" },
          { label: "HQ Catalog Items",       value: hqLinkedCount.toString(),   icon: <ShoppingBag className="h-5 w-5" />, tone: "violet" },
          { label: "Total Backorder Volume", value: totalBackorders.toString(), icon: <AlertTriangle className="h-5 w-5" />, tone: "red" },
        ].map((stat, i) => (
          <Card key={i} className="rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
            <CardContent className="flex items-start justify-between p-4">
              <div>
                <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{stat.label}</span>
                <span className="mt-3 block truncate text-2xl font-semibold tracking-tight text-white">{stat.value}</span>
              </div>
              <div className={`rounded-lg p-2 ${
                stat.tone === "emerald" ? "bg-emerald-500/15 text-emerald-300" :
                stat.tone === "violet" ? "bg-violet-500/15 text-violet-300" :
                stat.tone === "red" ? "bg-red-500/15 text-red-300" :
                "bg-blue-500/15 text-blue-300"
              }`}>
                {stat.icon}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Table card ───────────────────────────────────────────────────── */}
      <Card className="overflow-hidden rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.32)]">
        <CardHeader className="flex flex-col items-start gap-3 border-b border-white/10 bg-[#111111] px-4 py-4 sm:flex-row sm:items-center">

          {/* Search */}
          <div className="relative w-full sm:w-80">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-zinc-500" />
            </div>
            <input
              type="text"
              placeholder="Search by name or ID…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-[#171717] py-2 pl-9 pr-4 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Filter tabs */}
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#171717] p-1">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setFilterMode(tab.key)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  filterMode === tab.key
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                {tab.label}
                {tab.key !== "all" && (
                  <span className="ml-1.5 text-[10px] font-bold opacity-60">
                    {tab.key === "final" ? finalCount : prepCount}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Result count */}
          <span className="ml-auto hidden text-xs text-zinc-500 sm:block">
            {filteredFGs.length} item{filteredFGs.length !== 1 ? "s" : ""}
          </span>
        </CardHeader>

        <CardContent className="p-0">
          <Table>
            <TableHeader className="border-b border-white/10 bg-[#161616] text-xs uppercase tracking-[0.16em] text-zinc-500">
              <TableRow>
                <TableHead className="px-6 py-3">Item / SKU</TableHead>
                <TableHead className="py-3">Type</TableHead>
                <TableHead className="py-3">Recipe</TableHead>
                <TableHead className="py-3">Current Stock</TableHead>
                <TableHead className="py-3">Available</TableHead>
                <TableHead className="py-3">Backorders</TableHead>
                <TableHead className="px-6 py-3 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredFGs.length > 0 ? (
                filteredFGs.map((fg) => {
                  const cls        = classMap.get(String(fg.id)) ?? "final";
                  const recipe     = getRecipeForItem(fg);
                  const hasRecipe  = !!recipe;
                  const isHqSource = fg._source === "hq_sale_items";
                  const backorders = reqBackorders.get(fg.id) || 0;
                  const available  = Math.max(0, fg.inStock - backorders);

                  return (
                    <TableRow
                      key={fg.id}
                      className="cursor-pointer border-b border-white/5 bg-[#111111] transition-colors hover:bg-[#171717]"
                      onClick={() => {
                        // Close recipe picker if user clicks a different row
                        if (linkingRecipeFor && linkingRecipeFor !== fg.id.toString()) {
                          setLinkingRecipeFor(null);
                          setRecipeSearchQuery("");
                        }
                      }}
                    >
                      {/* Item name + ID */}
                      <TableCell className="px-6 py-3">
                        <div className="flex items-center gap-2">
                          <Factory className="h-4 w-4 shrink-0 text-zinc-600" />
                          <div>
                            <div className="flex items-center gap-1.5">
                              <p className="font-semibold leading-tight text-zinc-100">
                                {fg.name}
                              </p>
                              {isHqSource && (
                                <span className="inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border border-violet-500/20 bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold text-violet-300">
                                  <ShoppingBag className="h-2 w-2" /> HQ Catalog
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
                              {fg.id}
                            </p>
                          </div>
                        </div>
                      </TableCell>

                      {/* Classification badge */}
                      <TableCell className="py-3">
                        <ClassBadge cls={cls} />
                      </TableCell>

                      {/* Recipe / Linked Recipe column */}
                      <TableCell className="py-3" style={{minWidth: 200}}>
                        {fg.itemType === "Preparation" ? (
                          // ── Prep items: explicit HQ-controlled linking ────
                          <div className="flex flex-col gap-1">
                            {/* Current linked recipe badge */}
                            {hasRecipe ? (
                              <span className="inline-flex w-fit items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                                <CheckCircle2 className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate max-w-[120px]">{recipe!.name}</span>
                              </span>
                            ) : (
                              <span className="inline-flex w-fit items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                                <AlertTriangle className="h-2.5 w-2.5 shrink-0" /> No Recipe Linked
                              </span>
                            )}

                            {/* Link Recipe picker */}
                            {linkingRecipeFor === fg.id.toString() ? (
                              <div className="relative mt-1" onClick={e => e.stopPropagation()}>
                                <input
                                  autoFocus
                                  type="text"
                                  placeholder="Search recipe…"
                                  value={recipeSearchQuery}
                                  onChange={e => setRecipeSearchQuery(e.target.value)}
                                  className="w-full rounded border border-blue-500/30 bg-[#171717] px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                                <div className="absolute left-0 top-full z-50 mt-0.5 max-h-48 w-full overflow-y-auto rounded-md border border-white/10 bg-[#151515] shadow-2xl shadow-black/50">
                                  {fg.linkedRecipeId && (
                                    <button
                                      className="w-full border-b border-white/10 px-2 py-1.5 text-left text-xs font-semibold text-red-300 hover:bg-red-500/10"
                                      onClick={() => handleLinkRecipe(fg.id.toString(), null)}
                                    >✕ Remove Link</button>
                                  )}
                                  {recipes
                                    .filter(r => !recipeSearchQuery || r.name?.toLowerCase().includes(recipeSearchQuery.toLowerCase()))
                                    .slice(0, 30)
                                    .map(r => (
                                      <button
                                        key={r.id}
                                        className={`w-full px-2 py-1.5 text-left text-xs transition-colors hover:bg-blue-500/10 ${fg.linkedRecipeId === r.id ? 'bg-blue-500/15 font-semibold text-blue-200' : 'text-zinc-300'}`}
                                        onClick={() => handleLinkRecipe(fg.id.toString(), r.id)}
                                      >
                                        {r.name}
                                        <span className="ml-1 text-zinc-600">({r.yieldQty} {r.yieldUnit})</span>
                                      </button>
                                    ))
                                  }
                                  {recipes.filter(r => !recipeSearchQuery || r.name?.toLowerCase().includes(recipeSearchQuery.toLowerCase())).length === 0 && (
                                    <p className="px-2 py-2 text-xs italic text-zinc-500">No recipes match</p>
                                  )}
                                </div>
                                <button
                                  className="mt-1 text-[10px] text-zinc-500 hover:text-zinc-300"
                                  onClick={e => { e.stopPropagation(); setLinkingRecipeFor(null); setRecipeSearchQuery(""); }}
                                >Cancel</button>
                              </div>
                            ) : (
                              <button
                                disabled={savingLinkFor === fg.id.toString()}
                                onClick={e => { e.stopPropagation(); setLinkingRecipeFor(fg.id.toString()); setRecipeSearchQuery(""); }}
                                className="mt-0.5 w-fit rounded border border-blue-500/20 px-2 py-0.5 text-[10px] font-semibold text-blue-300 hover:bg-blue-500/10 disabled:opacity-50"
                              >
                                {savingLinkFor === fg.id.toString() ? "Saving…" : hasRecipe ? "Change" : "Link Recipe"}
                              </button>
                            )}
                          </div>
                        ) : (
                          // ── FG items: existing RecipeBadge display ────────
                          <div className="flex flex-col gap-0.5">
                            <RecipeBadge
                              linked={hasRecipe}
                              recipeId={recipe?.id ?? null}
                              recipeName={recipe?.name ?? null}
                              onNavigate={
                                hasRecipe && recipe?.id
                                  ? () => router.push(`/recipes?recipeId=${encodeURIComponent(recipe!.id)}`)
                                  : undefined
                              }
                            />
                            {hasRecipe && (
                              <span className="max-w-[140px] truncate text-[10px] text-zinc-500">
                                {recipe!.yieldQty} {recipe!.yieldUnit} · {recipe!.ingredients?.length ?? 0} ing.
                              </span>
                            )}
                          </div>
                        )}
                      </TableCell>

                      {/* Stock */}
                      <TableCell className="py-3">
                        <span className="font-medium tabular-nums text-zinc-100">
                          {fg.inStock} {fg.unit}
                        </span>
                      </TableCell>

                      {/* Available */}
                      <TableCell className="py-3">
                        <span
                          className={`font-bold tabular-nums ${
                            available === 0 ? "text-zinc-600" : "text-emerald-300"
                          }`}
                        >
                          {available} {fg.unit}
                        </span>
                      </TableCell>

                      {/* Backorders */}
                      <TableCell className="py-3">
                        {backorders > 0 ? (
                          <Badge
                            variant="danger"
                            className="bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-300"
                          >
                            {backorders} {fg.unit} backordered
                          </Badge>
                        ) : (
                          <span className="text-sm text-zinc-700">—</span>
                        )}
                      </TableCell>

                      {/* Actions */}
                      <TableCell className="px-6 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {backorders > 0 && (
                            <button
                              onClick={(e) => openAutoFulfillModule(e, fg)}
                              className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-300 shadow-sm transition-colors hover:bg-amber-500/25"
                            >
                              <RefreshCw className="h-3.5 w-3.5" /> Auto-Fulfill
                            </button>
                          )}
                          {(() => {
                            // Prep items require explicit linked recipe before producing
                            const isPrepItem = fg.itemType === "Preparation";
                            const canProduce = !isPrepItem || !!fg.linkedRecipeId;
                            return (
                              <button
                                disabled={!canProduce}
                                title={!canProduce ? "Link a recipe first using the 'Link Recipe' button" : undefined}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setProduceBatches(1);
                                  setSelectedFG(fg);
                                  setIsAutoFulfillMode(false);
                                }}
                                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                                  canProduce
                                    ? "cursor-pointer bg-blue-600 text-white hover:bg-blue-500"
                                    : "cursor-not-allowed bg-[#202020] text-zinc-600"
                                }`}
                              >
                                <PackagePlus className="h-3.5 w-3.5" /> Produce
                              </button>
                            );
                          })()}
                        </div>
                      </TableCell>

                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center text-sm text-zinc-500">
                    {searchQuery
                      ? `No items match "${searchQuery}" in ${filterMode === "all" ? "all items" : filterMode === "final" ? "Final Items" : "Prep / Base"}.`
                      : "No items in this category."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── Production Drawer ─────────────────────────────────────────────── */}
      <Drawer
        isOpen={!!selectedFG}
        onClose={() => {
          setSelectedFG(null);
          setProduceBatches(1);
          setIsAutoFulfillMode(false);
          setSubstitutes(new Map());
          setSubstituteModal(null);
        }}
        title={(() => {
          const recipe = selectedFG ? getRecipeForItem(selectedFG) : null;
          const isPrepOutput = recipe?.outputItemType === 'prep' || selectedFG?.itemType === 'Preparation';
          const typeLabel = isPrepOutput ? '🍳 Prep Production' : '🏷️ Production Run';
          if (isAutoFulfillMode) return `Auto-Fulfill Backorder: ${selectedFG?.name}`;
          return `${typeLabel}: ${selectedFG?.name}`;
        })()}
        description={(() => {
          const recipe = selectedFG ? getRecipeForItem(selectedFG) : null;
          const isPrepOutput = recipe?.outputItemType === 'prep' || selectedFG?.itemType === 'Preparation';
          if (isAutoFulfillMode) return 'Algorithmically mapping raw constraints to clear location backorders natively.';
          if (isPrepOutput) return 'Deducts raw ingredients and labour · Adds prep stock · Flows into downstream recipes.';
          return 'Calculate required raw ingredients directly mapping to theoretical recipe rules.';
        })()}
        footer={
          <div className="w-full flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-neutral-500">
                Projected Yield:{" "}
                <span className="text-brand-600 font-bold">
                  {activeConstraints?.yield} {activeConstraints?.unit}
                </span>
              </span>
              {/* Extra stats: ingredient count, labour, last produced */}
              {selectedFG && (() => {
                const r = getRecipeForItem(selectedFG);
                if (!r) return null;
                const labourIngs = (r.ingredients ?? []).filter((ing: any) =>
                  (ing.name || '').toUpperCase().includes('LABOUR') || (ing.name || '').toUpperCase().includes('LABOR')
                );
                return (
                  <span className="text-[10px] text-neutral-400 mt-0.5">
                    {(r.ingredients ?? []).length} ingredients
                    {labourIngs.length > 0 && ` · ${labourIngs.length} labour`}
                    {selectedFG.lastProduced && ` · Last: ${selectedFG.lastProduced}`}
                  </span>
                );
              })()}
              {isAutoFulfillMode && (
                <span className="text-xs font-medium text-red-500 mt-1">
                  Open Backorders: {reqBackorders.get(selectedFG?.id) || 0}{" "}
                  {activeConstraints?.unit}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors shadow-sm"
                onClick={() => {
                  setSelectedFG(null);
                  setProduceBatches(1);
                  setIsAutoFulfillMode(false);
                }}
              >
                Cancel
              </button>
              {!activeConstraints || activeConstraints.valid ? (
                <button
                  className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors shadow-sm flex items-center gap-2 disabled:opacity-50 ${
                    isAutoFulfillMode
                      ? "bg-amber-600 hover:bg-amber-700"
                      : "bg-brand-600 hover:bg-brand-700"
                  }`}
                  onClick={() =>
                    executeProduction(selectedFG, produceBatches, isAutoFulfillMode)
                  }
                  disabled={!activeConstraints}
                >
                  {isAutoFulfillMode ? (
                    <RefreshCw className="h-4 w-4" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  {isAutoFulfillMode ? "Fulfill Mapped Backorders" : "Finalize Production"}
                </button>
              ) : (
                <button
                  className="px-4 py-2 text-sm font-medium bg-neutral-800 text-white rounded-lg hover:bg-neutral-900 transition-colors shadow-sm flex items-center gap-2 disabled:opacity-50"
                  onClick={() =>
                    executeProduction(
                      selectedFG,
                      activeConstraints.maxBatches,
                      isAutoFulfillMode
                    )
                  }
                  disabled={activeConstraints.maxBatches <= 0}
                >
                  <PackageCheck className="h-4 w-4" /> Produce Max ({activeConstraints.maxBatches})
                </button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          {/* Constrained auto-fulfill warning */}
          <div className="flex flex-col sm:flex-row sm:items-start gap-4">
            {isAutoFulfillMode &&
              activeConstraints &&
              !activeConstraints.valid &&
              activeConstraints.maxBatches > 0 && (
                <div className="w-full flex items-start gap-3 bg-brand-50 text-brand-800 p-4 rounded-lg border border-brand-200">
                  <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-brand-600" />
                  <div className="flex flex-col gap-1">
                    <p className="font-semibold text-sm">Optimal Supply Constrained</p>
                    <p className="text-xs text-brand-700 max-w-lg leading-relaxed">
                      Your physical raw inventory restricts you from completing this
                      entire backorder sequence. You require{" "}
                      <span className="font-bold underline">{produceBatches} batches</span>{" "}
                      to satisfy demand, but are restricted to a maximum threshold of{" "}
                      <span className="font-bold underline">
                        {activeConstraints.maxBatches} batches
                      </span>
                      . Execute the <b>Produce Max</b> constraint to partially fulfill stores.
                    </p>
                  </div>
                </div>
              )}
          </div>

          {/* Batch selector */}
          <div className="flex items-center gap-4 bg-neutral-50 border border-neutral-200 rounded-lg p-4">
            <div className="flex-1">
              <h4 className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-2">
                Production Threshold Batches
              </h4>
              <div className="flex items-center gap-2">
                <button
                  className="w-8 h-8 rounded bg-white border border-neutral-300 text-neutral-600 font-bold hover:bg-neutral-100 transition-colors focus:outline-none"
                  onClick={() => setProduceBatches(Math.max(1, produceBatches - 1))}
                >
                  -
                </button>
                <span className="text-xl font-bold w-12 text-center text-neutral-900">
                  {produceBatches}
                </span>
                <button
                  className="w-8 h-8 rounded bg-white border border-neutral-300 text-neutral-600 font-bold hover:bg-neutral-100 transition-colors focus:outline-none"
                  onClick={() => setProduceBatches(produceBatches + 1)}
                >
                  +
                </button>
              </div>
            </div>

            {activeConstraints && !activeConstraints.valid && (
              <div className="flex items-start gap-2 bg-red-50 text-red-800 p-3 rounded-lg border border-red-100 text-sm font-medium w-[240px]">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p>Insufficient Raw Yields</p>
                  <p className="text-xs opacity-90 mt-0.5 font-normal">
                    Physical stock limits block this configuration entirely.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* No-recipe warning */}
          {selectedFG && !getRecipeForItem(selectedFG) && (
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-900">No linked recipe</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  This item has no recipe attached. Link a recipe in the Recipes page
                  to enable ingredient tracking and constraint checking.
                </p>
              </div>
            </div>
          )}

          {/* Ingredients table */}
          <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden">
            {(!activeConstraints || (activeConstraints.ingredientsCheck?.length ?? 0) === 0) && getRecipeForItem(selectedFG!) && (
              <div className="px-4 py-6 text-center text-sm text-neutral-400 italic">
                Recipe found but has no ingredients. Add ingredients in the Recipes page.
              </div>
            )}
            <Table>
              <TableHeader className="bg-neutral-50/50 text-[11px] uppercase text-neutral-500 tracking-wider">
                <TableRow>
                  <TableHead>Raw Ingredient</TableHead>
                  <TableHead>Required</TableHead>
                  <TableHead>HQ Stock</TableHead>
                  <TableHead className="text-right">Status / Switch</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(activeConstraints?.ingredientsCheck ?? []).map((ing: any, idx: number) => {
                  const recipe = selectedFG ? getRecipeForItem(selectedFG) : null;
                  const ingIdx = ing.ingIdx ?? idx;
                  const originalIngName = recipe?.ingredients?.[ingIdx]?.name ?? ing.originalName ?? ing.name ?? 'Unknown';
                  const isModalOpen = substituteModal?.ingIdx === ingIdx;

                  // ── Labour row: special rendering ──────────────────────────
                  if (ing.isLabour) {
                    const labourCost = ing.requiredTotal * ing.itemCost;
                    return (
                      <TableRow key={`ing-${idx}`} className="bg-amber-50/30 hover:bg-amber-50/50">
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-100 text-amber-700 shrink-0">
                              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                              </svg>
                            </span>
                            <div>
                              <div className="font-medium text-sm text-neutral-900">{ing.effectiveName ?? ing.name}</div>
                              <div className="text-[10px] text-amber-700 font-medium mt-0.5">Labour / Non-stock cost</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span className="text-sm font-bold text-neutral-800 tabular-nums">
                              {ing.requiredTotal} hr{ing.requiredTotal !== 1 ? "s" : ""}
                            </span>
                            <span className="text-[10px] text-neutral-500">
                              Rate: ${(ing.itemCost ?? 0).toFixed(2)}/hr
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {/* Labour items intentionally show no stock */}
                          <span className="text-xs text-neutral-400 italic">Non-stock</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-col items-end gap-1">
                            <Badge
                              variant="success"
                              className="text-xs px-2 py-0.5 border-none bg-amber-100 text-amber-800"
                            >
                              Labour Cost
                            </Badge>
                            <span className="text-xs font-bold text-amber-700 tabular-nums">
                              ${labourCost.toFixed(2)}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  }

                  // ── Standard ingredient row ────────────────────────────────

                  // Candidate substitutes: all raw-type inventory items
                  const candidatesAll = inventoryData.filter((i: any) =>
                    i.itemType !== "Finished Good" && i.itemType !== "Preparation"
                  );
                  // Prioritise: same unit AND same category as original ingredient's item
                  const effectiveOriginal = findInventoryItem(
                    inventoryData,
                    recipe?.ingredients?.[ingIdx]?.inventoryId?.toString()
                  );
                  const sameGroup = candidatesAll.filter((i: any) =>
                    i.id.toString() !== effectiveOriginal?.id?.toString() &&
                    (i.unit === effectiveOriginal?.unit || i.category === effectiveOriginal?.category)
                  );
                  const rest = candidatesAll.filter((i: any) =>
                    !sameGroup.some((s: any) => s.id === i.id) &&
                    i.id.toString() !== effectiveOriginal?.id?.toString()
                  );
                  const candidates = [...sameGroup, ...rest];
                  const q = (substituteModal?.query ?? "").toLowerCase();
                  const filtered = q
                    ? candidates.filter((i: any) => i.name.toLowerCase().includes(q))
                    : candidates;

                  return (
                    <TableRow
                      key={`ing-${idx}`}
                      className={`hover:bg-neutral-50/50 ${ing.isShort ? "bg-red-50/30" : ""}`}
                    >
                      <TableCell>
                        <div className="font-medium text-sm text-neutral-900">
                          {ing.effectiveName ?? ing.name}
                        </div>
                        {ing.isSubstituted && (
                          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                            <Repeat2 className="h-3 w-3 text-violet-500 shrink-0" />
                            <span className="text-[10px] text-violet-600 font-medium">
                              Using substitute instead of &ldquo;{originalIngName}&rdquo;
                            </span>
                            {/* Restore original */}
                            <button
                              onClick={() => {
                                const m = new Map(substitutes);
                                m.delete(ingIdx);
                                setSubstitutes(m);
                              }}
                              className="ml-1 text-[10px] text-neutral-400 hover:text-red-500 transition-colors"
                              title="Restore original ingredient"
                            >
                              <X className="h-3 w-3" />
                            </button>
                            {/* Permanent recipe update */}
                            {recipe && (
                              <button
                                onClick={() => {
                                  const sub = substitutes.get(ingIdx);
                                  if (sub) {
                                    setRecipeUpdateError(null);
                                    setRecipeUpdateConfirm({
                                      ingIdx:        ingIdx,
                                      substituteItem: sub,
                                      recipe,
                                    });
                                  }
                                }}
                                className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded hover:bg-emerald-100 transition-colors"
                                title="Permanently replace this ingredient in the recipe"
                              >
                                <CheckCircle2 className="h-2.5 w-2.5" /> Update recipe
                              </button>
                            )}
                          </div>
                        )}
                        {/* ── Substitute picker modal ──────────────────── */}
                        {isModalOpen && (
                          <div className="absolute z-50 mt-1 w-72 bg-white border border-neutral-200 rounded-lg shadow-xl p-3 flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-neutral-700">Pick substitute</span>
                              <button
                                onClick={() => setSubstituteModal(null)}
                                className="text-neutral-400 hover:text-neutral-700"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <input
                              autoFocus
                              type="text"
                              placeholder="Search inventory…"
                              value={substituteModal?.query ?? ""}
                              onChange={(e) =>
                                setSubstituteModal((prev) =>
                                  prev ? { ...prev, query: e.target.value } : prev
                                )
                              }
                              className="px-2 py-1.5 text-xs border border-neutral-200 rounded-md w-full focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                            <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5">
                              {filtered.length === 0 && (
                                <span className="text-xs text-neutral-400 text-center py-3">No items found</span>
                              )}
                              {sameGroup.length > 0 && !q && (
                                <div className="text-[10px] text-neutral-400 font-semibold uppercase tracking-wider px-1 py-0.5 mt-1">
                                  Same unit / category
                                </div>
                              )}
                              {filtered.map((item: any) => (
                                <button
                                  key={item.id}
                                  onClick={() => {
                                    const m = new Map(substitutes);
                                    m.set(ingIdx, item);
                                    setSubstitutes(m);
                                    setSubstituteModal(null);
                                  }}
                                  className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-brand-50 text-left transition-colors"
                                >
                                  <span className="text-xs font-medium text-neutral-800 truncate">{item.name}</span>
                                  <span className={`text-[10px] ml-2 shrink-0 ${
                                    item.inStock <= 0 ? "text-red-500" : "text-green-600"
                                  }`}>
                                    {item.inStock} {item.unit}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-sm font-bold text-neutral-800 tabular-nums">
                          {ing.requiredTotal} {ing.unit}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`text-sm font-semibold tabular-nums ${
                            ing.isShort ? "text-red-600" : "text-neutral-600"
                          }`}
                        >
                          {ing.inStock} {ing.unit}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {ing.error ? (
                            <Badge
                              variant="danger"
                              className="text-xs px-2 py-0.5 border-none bg-red-100 text-red-800"
                              title={ing.error}
                            >
                              Unit Conflict
                            </Badge>
                          ) : ing.isShort ? (
                            <Badge
                              variant="danger"
                              className="text-xs px-2 py-0.5 border-none"
                            >
                              Shortage (-{(ing.requiredTotal - ing.inStock).toFixed(2)})
                            </Badge>
                          ) : (
                            <Badge
                              variant="success"
                              className="text-xs px-2 py-0.5 border-none bg-green-100 text-green-800"
                            >
                              Available
                            </Badge>
                          )}
                          {/* Switch button */}
                          <button
                            onClick={() =>
                              setSubstituteModal(
                                isModalOpen ? null : { ingIdx: ingIdx, query: "" }
                              )
                            }
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold transition-colors border ${
                              ing.isSubstituted
                                ? "bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100"
                                : "bg-neutral-50 border-neutral-200 text-neutral-500 hover:bg-neutral-100"
                            }`}
                            title={ing.isSubstituted ? "Change substitute" : "Switch ingredient"}
                          >
                            <Repeat2 className="h-3 w-3" />
                            {ing.isSubstituted ? "Change" : "Switch"}
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {(!activeConstraints ||
                  activeConstraints.ingredientsCheck.length === 0) && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="text-center py-6 text-neutral-400 text-sm"
                    >
                      No recipe linked — no ingredient constraints to display.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* ── Production Cost Summary ───────────────────────────────────── */}
          {activeConstraints && activeConstraints.ingredientsCheck.length > 0 && (() => {
            const ingredientCost = activeConstraints.ingredientsCheck
              .filter((r: any) => !r.isLabour)
              .reduce((sum: number, r: any) => sum + r.requiredTotal * r.itemCost, 0);

            const labourCost = activeConstraints.ingredientsCheck
              .filter((r: any) => r.isLabour)
              .reduce((sum: number, r: any) => sum + r.requiredTotal * r.itemCost, 0);

            const totalCost = ingredientCost + labourCost;
            const projectedYield = activeConstraints.yield ?? 0;
            const costPerUnit = projectedYield > 0 ? totalCost / projectedYield : 0;

            return (
              <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-4">
                <h4 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">Production Cost Summary</h4>
                <div className="grid grid-cols-2 gap-x-8 gap-y-2">
                  <div className="flex items-center justify-between col-span-2 sm:col-span-1">
                    <span className="text-xs text-neutral-500">Ingredient Cost</span>
                    <span className="text-xs font-semibold text-neutral-800 tabular-nums">${ingredientCost.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center justify-between col-span-2 sm:col-span-1">
                    <span className="text-xs text-amber-700 font-medium">Labour Cost</span>
                    <span className="text-xs font-semibold text-amber-700 tabular-nums">${labourCost.toFixed(2)}</span>
                  </div>
                  <div className="col-span-2 border-t border-neutral-200 pt-2 mt-1 flex items-center justify-between">
                    <span className="text-sm font-semibold text-neutral-900">Total Production Cost</span>
                    <span className="text-sm font-bold text-brand-700 tabular-nums">${totalCost.toFixed(2)}</span>
                  </div>
                  <div className="col-span-2 flex items-center justify-between">
                    <span className="text-xs text-neutral-500">
                      Cost per {activeConstraints.unit ?? "unit"}
                    </span>
                    <span className="text-xs font-semibold text-neutral-700 tabular-nums">
                      ${costPerUnit.toFixed(4)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* ── Permanent recipe-update confirmation dialog ──────────────── */}
        {recipeUpdateConfirm && (() => {
          const { ingIdx, substituteItem, recipe: targetRecipe } = recipeUpdateConfirm;
          const oldIng = targetRecipe.ingredients?.[ingIdx];
          const oldName = oldIng?.name ?? "original ingredient";
          return (
            <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm">
              <div className="bg-white rounded-xl shadow-2xl border border-neutral-200 w-full max-w-md mx-4 p-6 flex flex-col gap-4">
                {/* Header */}
                <div className="flex items-start gap-3">
                  <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-amber-100 text-amber-700 shrink-0">
                    <AlertTriangle className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="font-bold text-neutral-900 text-base">Permanently update recipe?</h3>
                    <p className="text-sm text-neutral-500 mt-0.5">This action cannot be undone from this page.</p>
                  </div>
                </div>

                {/* Details */}
                <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3 text-xs space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-neutral-500 w-16 shrink-0">Recipe</span>
                    <span className="font-semibold text-neutral-800 truncate">{targetRecipe.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-neutral-500 w-16 shrink-0">Replace</span>
                    <span className="font-semibold text-red-700 line-through truncate">{oldName}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-neutral-500 w-16 shrink-0">With</span>
                    <span className="font-semibold text-emerald-700 truncate">{substituteItem.name}</span>
                  </div>
                  <p className="text-neutral-400 pt-1 border-t border-neutral-200">
                    Quantity and unit will be preserved. Recipe cost and linked finished-good making cost will be recalculated.
                  </p>
                </div>

                {/* Error */}
                {recipeUpdateError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                    {recipeUpdateError}
                  </p>
                )}

                {/* Actions */}
                <div className="flex items-center justify-end gap-3 pt-1">
                  <button
                    onClick={() => { setRecipeUpdateConfirm(null); setRecipeUpdateError(null); }}
                    disabled={recipeUpdateSaving}
                    className="px-4 py-2 text-sm font-semibold text-neutral-600 bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleUpdateRecipeIngredient}
                    disabled={recipeUpdateSaving}
                    className="px-4 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-60 inline-flex items-center gap-2"
                  >
                    {recipeUpdateSaving && (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    )}
                    {recipeUpdateSaving ? "Updating…" : "Confirm update"}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </Drawer>

      {/* ── CSV Import Modal ──────────────────────────────────────────────── */}
      <FgImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        existingNames={finishedGoods.map((fg: any) => fg.name)}
        onSuccess={() => window.location.reload()}
      />
      </>)}  {/* end pageView === "items" */}

      {/* ══════════════════════════════════════════════════════════════════════
          PRODUCTION HISTORY VIEW
      ══════════════════════════════════════════════════════════════════════ */}
      {pageView === "history" && (() => {
        // ── Labour detection ─────────────────────────────────────────────
        const isLabour = (notes: string | null) => {
          const u = (notes ?? "").toUpperCase();
          return u.includes("LABOUR") || u.includes("LABOR");
        };

        // ── Group movements by reference_id ──────────────────────────────
        type HistoryEvent = {
          refId:          string;
          fgName:         string;
          producedAt:     string;   // ISO timestamp of production_in row
          yieldQty:       number;
          yieldUnit:      string;
          batches:        string;
          notes:          string | null;
          ingredientCost: number;
          labourCost:     number;
          totalCost:      number;
          lines:          ProductionMovementRow[];
        };

        const eventMap = new Map<string, HistoryEvent>();
        for (const row of productionMovements) {
          const refId = row.reference_id ?? "unknown";
          if (!eventMap.has(refId)) {
            eventMap.set(refId, {
              refId,
              fgName:         "—",
              producedAt:     row.created_at,
              yieldQty:       0,
              yieldUnit:      "",
              batches:        "",
              notes:          row.notes,
              ingredientCost: 0,
              labourCost:     0,
              totalCost:      0,
              lines:          [],
            });
          }
          const ev = eventMap.get(refId)!;
          ev.lines.push(row);

          if (row.movement_type === "production_in") {
            ev.fgName     = (row.notes ?? "").replace(/^Production output:.*? batches of /, "").split("[")[0].trim() || ev.fgName;
            ev.yieldQty   = row.quantity;
            ev.producedAt = row.created_at;
            // extract batch count from notes like "2 batches of …"
            const bm = (row.notes ?? "").match(/^Production output:\s*(\d+)\s*batch/i);
            if (bm) ev.batches = `${bm[1]} batch${Number(bm[1]) !== 1 ? "es" : ""}`;
          }

          if (row.movement_type === "production_consumption") {
            const cost = row.total_cost ?? 0;
            if (isLabour(row.notes)) {
              ev.labourCost += cost;
            } else {
              ev.ingredientCost += cost;
            }
            ev.totalCost += cost;
          }
        }

        // Sorted newest first
        const events = Array.from(eventMap.values()).sort(
          (a, b) => new Date(b.producedAt).getTime() - new Date(a.producedAt).getTime()
        );

        // Search filter
        const q = historySearch.toLowerCase();
        const filteredEvents = q
          ? events.filter(e =>
              e.fgName.toLowerCase().includes(q) ||
              e.refId.toLowerCase().includes(q)
            )
          : events;

        // Summary totals
        const totalEvents       = filteredEvents.length;
        const totalIngredient   = filteredEvents.reduce((s, e) => s + e.ingredientCost, 0);
        const totalLabour       = filteredEvents.reduce((s, e) => s + e.labourCost,     0);
        const totalProduction   = filteredEvents.reduce((s, e) => s + e.totalCost,      0);

        const fmtDate = (iso: string) => {
          try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
          catch { return iso; }
        };

        return (
          <div className="space-y-5">

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: "Production Events", value: totalEvents.toString(),           icon: <Package className="h-4 w-4"/>,    color: "text-neutral-900" },
                { label: "Ingredient Cost",   value: `$${totalIngredient.toFixed(2)}`, icon: <DollarSign className="h-4 w-4"/>, color: "text-neutral-700" },
                { label: "Labour Cost",       value: `$${totalLabour.toFixed(2)}`,     icon: <Calendar className="h-4 w-4"/>,   color: "text-amber-700"   },
                { label: "Total Cost",        value: `$${totalProduction.toFixed(2)}`, icon: <DollarSign className="h-4 w-4"/>, color: "text-brand-700"   },
              ].map((s, i) => (
                <Card key={i} className="shadow-sm border-neutral-200">
                  <CardContent className="p-4 flex flex-col gap-1">
                    <div className="flex items-center gap-1.5 text-neutral-400">{s.icon}<span className="text-xs font-medium text-neutral-500">{s.label}</span></div>
                    <span className={`text-xl font-bold tabular-nums ${s.color}`}>{s.value}</span>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Filters */}
            <Card className="shadow-sm border-neutral-200">
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                  {/* Search */}
                  <div className="relative flex-1 min-w-0">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Search className="h-4 w-4 text-neutral-400" />
                    </div>
                    <input
                      type="text"
                      placeholder="Search by product name or reference ID…"
                      value={historySearch}
                      onChange={e => setHistorySearch(e.target.value)}
                      className="pl-9 pr-4 py-1.5 border border-neutral-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 w-full bg-neutral-50 hover:bg-white transition-colors"
                    />
                  </div>
                  {/* Date range */}
                  <div className="flex items-center gap-2 shrink-0">
                    <Calendar className="h-4 w-4 text-neutral-400 shrink-0" />
                    <input
                      type="date"
                      value={historyDateFrom}
                      onChange={e => setHistoryDateFrom(e.target.value)}
                      className="border border-neutral-200 rounded-md text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-neutral-50"
                      title="From date"
                    />
                    <span className="text-neutral-400 text-xs">–</span>
                    <input
                      type="date"
                      value={historyDateTo}
                      onChange={e => setHistoryDateTo(e.target.value)}
                      className="border border-neutral-200 rounded-md text-xs px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-neutral-50"
                      title="To date"
                    />
                    {(historyDateFrom || historyDateTo) && (
                      <button
                        onClick={() => { setHistoryDateFrom(""); setHistoryDateTo(""); }}
                        className="text-neutral-400 hover:text-red-500 transition-colors"
                        title="Clear dates"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {/* Refresh */}
                  <button
                    onClick={() => {
                      // Toggle pageView off/on to force re-fetch
                      setProductionMovements([]);
                      setPageView("items");
                      setTimeout(() => setPageView("history"), 0);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-white border border-neutral-200 text-neutral-600 rounded-md hover:bg-neutral-50 transition-colors shadow-sm shrink-0"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Refresh
                  </button>
                </div>
              </CardContent>
            </Card>

            {/* Events list */}
            {historyLoading ? (
              <div className="flex justify-center py-16 text-neutral-400 animate-pulse text-sm">
                Loading production history…
              </div>
            ) : filteredEvents.length === 0 ? (
              <Card className="shadow-sm border-neutral-200">
                <CardContent className="py-16 text-center text-neutral-400 text-sm">
                  {productionMovements.length === 0
                    ? "No production movements found. Execute a production run to see history here."
                    : `No events match "${historySearch}".`}
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {filteredEvents.map(ev => {
                  const isOpen = expandedEvents.has(ev.refId);
                  const costPerUnit = ev.yieldQty > 0 ? ev.totalCost / ev.yieldQty : 0;
                  const consLines   = ev.lines.filter(l => l.movement_type === "production_consumption");
                  const outLine     = ev.lines.find(l  => l.movement_type === "production_in");

                  // Try to extract unit from notes "yielding X kg" or "production_in" row notes
                  const unitMatch = (outLine?.notes ?? "").match(/yielding\s+[\d.]+\s+(\w+)/i);
                  const yieldUnit = ev.yieldUnit || unitMatch?.[1] || "";

                  return (
                    <Card key={ev.refId} className="shadow-sm border-neutral-200 overflow-hidden">
                      {/* Event header — always visible */}
                      <button
                        type="button"
                        onClick={() => setExpandedEvents(prev => {
                          const next = new Set(prev);
                          isOpen ? next.delete(ev.refId) : next.add(ev.refId);
                          return next;
                        })}
                        className="w-full text-left"
                      >
                        <CardContent className="p-4">
                          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                            {/* Expand chevron */}
                            <span className="text-neutral-400 shrink-0">
                              {isOpen ? <ChevronDown className="h-4 w-4"/> : <ChevronRight className="h-4 w-4"/>}
                            </span>

                            {/* FG name + ref */}
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-neutral-900 truncate">{ev.fgName}</p>
                              <p className="text-[10px] text-neutral-400 font-mono">{ev.refId}</p>
                            </div>

                            {/* Date */}
                            <div className="text-xs text-neutral-500 shrink-0 sm:text-right">
                              <p className="font-medium">{fmtDate(ev.producedAt)}</p>
                              {ev.batches && <p className="text-neutral-400">{ev.batches}</p>}
                            </div>

                            {/* Yield */}
                            <div className="text-right shrink-0">
                              <p className="text-sm font-bold text-neutral-900 tabular-nums">
                                {ev.yieldQty} {yieldUnit}
                              </p>
                              <p className="text-[10px] text-neutral-400">produced</p>
                            </div>

                            {/* Cost pills */}
                            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                              {ev.ingredientCost > 0 && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-700 border border-neutral-200">
                                  Ing ${ev.ingredientCost.toFixed(2)}
                                </span>
                              )}
                              {ev.labourCost > 0 && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                                  Labour ${ev.labourCost.toFixed(2)}
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 border border-brand-200">
                                Total ${ev.totalCost.toFixed(2)}
                              </span>
                              {costPerUnit > 0 && (
                                <span className="text-[10px] text-neutral-400 tabular-nums">
                                  ${costPerUnit.toFixed(3)}/{yieldUnit || "unit"}
                                </span>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </button>

                      {/* Expanded breakdown */}
                      {isOpen && (
                        <div className="border-t border-neutral-100 bg-neutral-50/50 px-4 pb-4 pt-3">
                          <p className="text-[10px] uppercase font-semibold text-neutral-400 tracking-wider mb-2">
                            Ingredient &amp; Labour Breakdown
                          </p>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-neutral-400 border-b border-neutral-200">
                                  <th className="text-left font-semibold pb-1.5 pr-3">Item</th>
                                  <th className="text-right font-semibold pb-1.5 px-3">Qty</th>
                                  <th className="text-right font-semibold pb-1.5 px-3">Unit Cost</th>
                                  <th className="text-right font-semibold pb-1.5 pl-3">Total Cost</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-neutral-100">
                                {consLines.map(line => {
                                  const itemLabel = (line.notes ?? "")
                                    .replace(/^Production:.*?— consumed [\d.]+ \w+ of /, "")
                                    .replace(/\s*\[.*$/, "")
                                    .trim() || line.item_id || "—";
                                  const lab = isLabour(line.notes);
                                  return (
                                    <tr key={line.id} className={lab ? "bg-amber-50/40" : ""}>
                                      <td className="py-1.5 pr-3 font-medium text-neutral-800">
                                        {itemLabel}
                                        {lab && (
                                          <span className="ml-1.5 text-[9px] font-bold uppercase text-amber-600 bg-amber-100 px-1 py-0.5 rounded">Labour</span>
                                        )}
                                      </td>
                                      <td className="py-1.5 px-3 text-right tabular-nums text-neutral-600">
                                        {line.quantity}
                                      </td>
                                      <td className="py-1.5 px-3 text-right tabular-nums text-neutral-600">
                                        {line.unit_cost != null ? `$${line.unit_cost.toFixed(4)}` : "—"}
                                      </td>
                                      <td className="py-1.5 pl-3 text-right tabular-nums font-semibold text-neutral-800">
                                        {line.total_cost != null ? `$${line.total_cost.toFixed(2)}` : "—"}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                              {ev.totalCost > 0 && (
                                <tfoot>
                                  <tr className="border-t-2 border-neutral-200">
                                    <td colSpan={3} className="pt-2 text-right font-semibold text-neutral-700 pr-3">Total Production Cost</td>
                                    <td className="pt-2 pl-3 text-right font-bold text-brand-700 tabular-nums">${ev.totalCost.toFixed(2)}</td>
                                  </tr>
                                  {costPerUnit > 0 && (
                                    <tr>
                                      <td colSpan={3} className="pt-0.5 text-right text-neutral-400 pr-3">Cost per {yieldUnit || "unit"}</td>
                                      <td className="pt-0.5 pl-3 text-right text-neutral-500 tabular-nums">${costPerUnit.toFixed(4)}</td>
                                    </tr>
                                  )}
                                </tfoot>
                              )}
                            </table>
                          </div>
                          {outLine?.notes && (
                            <p className="mt-2 text-[10px] text-neutral-400 italic truncate">{outLine.notes}</p>
                          )}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
      </div>
    </div>
  );
}
