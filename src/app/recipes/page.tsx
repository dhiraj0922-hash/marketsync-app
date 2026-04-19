"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { loadRecipes, saveRecipes, loadInventory, saveInventory, upsertRecipe, updateInventoryItemCost, loadSuppliers, deleteRecipe } from "@/lib/storage";

import { normalizeUnit, canonicalizeUnit, resolveEffectiveBaseUom, computeBaseUnitCostFromPack, auditItemUnitAmbiguity } from "@/lib/units";

import { Plus, Search, SplitSquareVertical, Calculator, Trash2, Sparkles } from "lucide-react";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { AIRecipeImport } from "@/components/AIRecipeImport";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin, resolveLocationId } from "@/lib/roles";

// ─── Utility: race a promise against a cancellable deadline ───────────────────
//
// withAbortableTimeout: passes an AbortSignal to the factory so the underlying
// fetch is actually cancelled (not just orphaned) when the timer fires.
// This prevents zombie Supabase requests from sitting on the connection pool
// and causing subsequent saves to queue behind a dead request.
//
// withTimeout: legacy shim for non-fetch promises that don't take a signal.
//
// Root cause of the 12 s timeout: Supabase free-tier PostgREST cold-starts
// (after ~5 min inactivity) legitimately take 10–20 s. The previous 12 s
// deadline was firing during valid, slow-but-correct cold-start responses.
// Payload optimization (sanitizeIngredientForDB) reduces actual latency;
// timeout raised to 30 s as the safety net.
function withAbortableTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
  timeoutMsg: string | (() => string)
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      // Evaluate lazy message factory at the moment the deadline fires
      // so any elapsed-time calculation in the message is accurate.
      reject(new Error(typeof timeoutMsg === 'function' ? timeoutMsg() : timeoutMsg));
    }, ms);
  });
  return Promise.race([factory(controller.signal), deadline])
    .finally(() => clearTimeout(timer));
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMsg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMsg)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export default function Recipes() {
  return (
    <HQOnlyGuard>
      <RecipesPageContent />
    </HQOnlyGuard>
  );
}

function RecipesPageContent() {
  const { user } = useAuth();
  const [recipes, setRecipes] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState("");

  // Builder State
  const [isBuilderOpen, setIsBuilderOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<any>(null);

  // AI Import State
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [recipeName, setRecipeName] = useState("");
  const [recipeCategory, setRecipeCategory] = useState("Mains");
  const [yieldQty, setYieldQty] = useState<number>(1);
  const [yieldUnit, setYieldUnit] = useState("kg");
  const [targetMargin, setTargetMargin] = useState<number>(80);
  const [outputItemId, setOutputItemId] = useState<string>("");
  
  const [ingredients, setIngredients] = useState<any[]>([]);
  const [selectedInvId, setSelectedInvId] = useState<string>("");

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);

  // Ingredient combobox state
  const [ingSearch, setIngSearch]         = useState("");
  const [ingPanelOpen, setIngPanelOpen]   = useState(false);
  const [suppliersData, setSuppliersData] = useState<any[]>([]);
  // Ref to the search input so we can measure its viewport position for the fixed dropdown
  const ingInputRef = useRef<HTMLInputElement>(null);
  // Anchor rect: top/left/width captured at open time, used for fixed positioning
  const [ingAnchor, setIngAnchor] = useState<{ top: number; left: number; width: number } | null>(null);

  // Close the panel when the drawer body scrolls (prevents dropdown drifting)
  useEffect(() => {
    if (!ingPanelOpen) return;
    const scrollEl = ingInputRef.current?.closest('[class*="overflow-y-auto"]') as HTMLElement | null;
    if (!scrollEl) return;
    const close = () => setIngPanelOpen(false);
    scrollEl.addEventListener("scroll", close, { passive: true });
    return () => scrollEl.removeEventListener("scroll", close);
  }, [ingPanelOpen]);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null); // recipe pending deletion
  const [isDeleting, setIsDeleting]     = useState(false);

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const locationId: string = resolveLocationId(user);
        const hqAdmin = isHqAdmin(user);

        // KEY FIX: HQ admins must NOT pass locationId to loadInventory.
        // Passing locationId='LOC-HQ' adds a DB-side WHERE location_id='LOC-HQ'
        // which drops any row with a null or different location_id BEFORE
        // PostgREST applies the range() limit — so those rows never arrive.
        // Location managers still get their location scoped at the DB level.
        const [loadedRec, loadedInv, loadedSups] = await Promise.all([
          loadRecipes(),
          hqAdmin
            ? loadInventory()           // HQ: fetch all rows, no WHERE location_id filter
            : loadInventory(locationId), // location manager: DB-scoped to their location
          loadSuppliers(),
        ]);

        // CLOVE diagnostic: verify rows arrived from DB
        const cloveRows = loadedInv.filter((i: any) => i.name?.toLowerCase().includes('clove'));
        console.log(
          `[RecipeDiag] loadInventory fetched ${loadedInv.length} rows | clove rows: ${cloveRows.length}` +
          ` | isHqAdmin=${hqAdmin} | locationId arg used=${hqAdmin ? 'none' : locationId}`,
          cloveRows.map((i: any) => ({ name: i.name, locationId: i.locationId, itemType: i.itemType }))
        );

        setRecipes(loadedRec);
        setInventory(loadedInv);
        setSuppliersData(Array.isArray(loadedSups) ? loadedSups : []);
      } catch(e) {
        console.error(e);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  // Re-fetch if user resolves after mount (auth timing)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.locationId, user?.role]);

  if (isLoading) return <div className="animate-pulse flex p-12 justify-center text-neutral-400">Loading Recipes...</div>;

  // ── Delete handler ────────────────────────────────────────────────────────
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const result = await deleteRecipe(deleteTarget.id);
      if (!result.success) {
        const msg = result.error?.message ?? result.error?.detail ?? "Unknown error from database.";
        alert(`Failed to delete "${deleteTarget.name}": ${msg}`);
        return;
      }
      // Optimistic removal — no page reload needed
      setRecipes(prev => prev.filter(r => r.id !== deleteTarget.id));
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
    }
  };

  const openBuilder = (recipe: any = null) => {
    if (recipe) {
      setEditingRecipe(recipe);
      setRecipeName(recipe.name);
      setRecipeCategory(recipe.category || "Mains");
      setYieldQty(recipe.yieldQty || 1);
      setYieldUnit(recipe.yieldUnit || "kg");
      setTargetMargin(recipe.margin || 80);
      setOutputItemId(recipe.outputItemId || "");
      setIngredients(recipe.ingredients ? [...recipe.ingredients] : []);
    } else {
      setEditingRecipe(null);
      setRecipeName("");
      setRecipeCategory("Mains");
      setYieldQty(1);
      setYieldUnit("kg");
      setTargetMargin(80);
      setOutputItemId("");
      setIngredients([]);
    }
    setSelectedInvId("");
    setIsBuilderOpen(true);
  };

  /**
   * Called when user confirms an AI import.
   * Pre-populates the recipe builder with the extracted header and ingredients.
   * The user still goes through the full builder UI before final save.
   */
  const handleAIImportConfirm = (
    header: { name: string; category: string; yieldQty: number; yieldUnit: string; notes: string },
    importedIngredients: any[]   // renamed param to avoid shadowing the state variable
  ) => {
    // 1. Write all recipe-builder form state first — while the import drawer is still open.
    //    This guarantees every setter is batched in the same React render that has the
    //    correct imported values, so the builder never sees a stale empty ingredients array.
    setEditingRecipe(null);
    setRecipeName(header.name);
    setRecipeCategory(header.category || "Mains");
    setYieldQty(header.yieldQty || 1);
    setYieldUnit(header.yieldUnit || "portions");
    setTargetMargin(80);          // default margin — user sets in builder
    setOutputItemId("");
    setIngredients(importedIngredients);   // AI-matched ingredients pre-loaded
    setSelectedInvId("");

    // 2. Close the import drawer and open the recipe builder in the next animation
    //    frame. By this point, React has committed all the state above. The builder
    //    Drawer will mount with the full importedIngredients array already in place.
    requestAnimationFrame(() => {
      setIsImportOpen(false);
      setIsBuilderOpen(true);
    });
  };

  const addIngredient = () => {
    if (!selectedInvId) return;

    // selectedInvId comes from the dropdown which uses item.id.toString() as value.
    // ALWAYS match by row PK (id) here — the row renderer also looks up by i.id.
    const invItem = inventory.find(i => i.id.toString() === selectedInvId);
    if (!invItem) return;

    // For duplicate-prevention we compare by shared itemId so two location rows
    // for the same product don't both get added.
    const sharedId = invItem.itemId || invItem.id;
    if (ingredients.some(ing => {
      const stored = ing.inventoryId || ing.fgId || "";
      return stored.toString() === invItem.id.toString() ||
             stored.toString() === sharedId.toString();
    })) {
      alert("Ingredient is already in the recipe.");
      return;
    }

    // Canonicalize the native unit so it always matches a <select> option.
    // DB values like "LIT", "lit", "LITRE", "FL OZ", "pcs" are non-canonical
    // and don't match any <option value=...> in the unit dropdown. When there
    // is no match the browser silently resets to the first option ("g") —
    // this was why Agni Sauce (LIT) always landed on grams.
    const rawUnit = invItem.baseUnit || invItem.unit || "ea";
    const nativeUnit = canonicalizeUnit(rawUnit) ?? rawUnit;

    const newIng = {
      type: 'inventory',
      // Store the row PK so the ingredient row renderer can find the item with
      // a direct i.id lookup. calculateCost uses dual-path (itemId + id) so it
      // works with either value.
      inventoryId: invItem.id.toString(),
      name: invItem.name,
      qty: 1,
      unit: nativeUnit,   // canonical unit — always matches a dropdown option
    };

    setIngredients([...ingredients, newIng]);
    setSelectedInvId("");
  };

  const updateIngredient = (index: number, field: string, value: any) => {
    const updated = [...ingredients];
    updated[index][field] = value;
    setIngredients(updated);
  };

  const removeIngredient = (index: number) => {
    const updated = [...ingredients];
    updated.splice(index, 1);
    setIngredients(updated);
  };

  const calculateCost = () => {
    let total = 0;
    let errors = 0;

    ingredients.forEach(ing => {
      try {
        const targetId = ing.inventoryId || ing.fgId;
        if (targetId) {
          // Dual-path lookup: row PK first, then shared itemId (same as row renderer)
          const invItem = inventory.find(i =>
            i.id.toString() === targetId.toString() ||
            (i.itemId && i.itemId.toString() === targetId.toString())
          );
          if (invItem) {
             // Phase 1: use resolveEffectiveBaseUom so base_uom takes priority over baseUnit when set
             const baseTargetUnit = resolveEffectiveBaseUom(invItem);
             const normQty = normalizeUnit(ing.qty, ing.unit, baseTargetUnit);

             // ── Effective base cost — three-path priority chain ────────────────────
             // Path 1 (NEW): structured pack fields all populated
             //   → computeBaseUnitCostFromPack (read-time only, no write-back)
             // Path 2 (EXISTING): purchaseUnits JSONB
             //   → effectiveBaseCost = purchaseCost / primary.conversion
             // Path 3 (LEGACY): item.cost is already the base-unit cost
             let effectiveBaseCost = invItem.cost;                                        // Path 3 default
             const structuredCost = computeBaseUnitCostFromPack(invItem);
             if (structuredCost !== null) {
               effectiveBaseCost = structuredCost;                                         // Path 1
             } else if (invItem.purchaseUnits && invItem.purchaseUnits.length > 0) {
               const primary = invItem.purchaseUnits.find((u: any) => u.isPrimary) || invItem.purchaseUnits[0];
               const purchCost = (invItem.purchaseCost !== undefined && invItem.purchaseCost !== null)
                 ? invItem.purchaseCost
                 : invItem.cost * primary.conversion;                                     // reconstruct for legacy rows
               effectiveBaseCost = purchCost / primary.conversion;                        // Path 2
             }
             total += (normQty * effectiveBaseCost);
           }
        }
      } catch (e) {
        errors++;
      }
    });

    return { total, errors };
  };

  const saveRecipeData = async () => {
    // ── Guard: prevent double submission ─────────────────────────────────────
    if (isSaving) return;

    // ── Validation — inline errors, no alert() ──────────────────────────────
    setBuilderError(null);

    if (!recipeName.trim()) {
      setBuilderError("Recipe name is required.");
      return;
    }
    if (ingredients.length === 0) {
      setBuilderError("Recipes require at least one ingredient mapped from active inventory.");
      return;
    }

    const costData = calculateCost();
    if (costData.errors > 0) {
      setBuilderError("Cannot save recipe — some ingredients have incompatible unit mappings. Hover the \"Unit Error\" badge to see the reason.");
      return;
    }

    setIsSaving(true);
    const t0 = Date.now();
    console.debug("[saveRecipe] START", { recipeName, ingredients: ingredients.length });

    try {
      const cost = costData.total;
      const marginDec = targetMargin / 100;
      const price = (marginDec >= 1) ? 0 : cost / (1 - marginDec);

      const recipeData = {
        // Keep existing id on edit; generate a stable new one on create.
        // Math.random() is fine here — human-readable prefix only, not a DB PK UUID.
        id: editingRecipe ? editingRecipe.id : `REC-${Date.now().toString(36).toUpperCase()}`,
        name: recipeName,
        category: recipeCategory,
        yieldQty,
        yieldUnit,
        theoreticalCost: cost,
        margin: targetMargin,
        price,
        outputItemId,
        ingredients,
      };

      // ── Step 1: upsert the single recipe row ────────────────────────────────
      // Uses withAbortableTimeout so the underlying fetch() is actually cancelled
      // (not just orphaned) when the 30 s deadline fires.
      //
      // KEY FIX: upsertRecipe now uses raw fetch() and accepts the AbortSignal.
      // Previously: supabase.from().upsert() ignores signals → zombie TCP request
      //   blocked the NEXT save attempt, causing cascading timeouts.
      // Now: abort() tears down the HTTP connection immediately.
      console.debug("[saveRecipe] step 1: upsertRecipe", recipeData.id,
        "| ingredients:", ingredients.length);
      const SAVE_TIMEOUT_MS = Math.max(30_000, 20_000); // 30 s, floor of 20 s
      const res = await withAbortableTimeout(
        (signal) => upsertRecipe(recipeData, signal),
        SAVE_TIMEOUT_MS,
        () =>
          `Recipe save timed out after ${Math.round((Date.now() - t0) / 1000)}s. ` +
          `Supabase may be cold-starting — please retry in a few seconds.`
      );
      console.debug(`[saveRecipe] step 1 done (total so far: ${Date.now() - t0}ms)`, res);

      if (!res.success) {
        const dbMsg = res.error?.message ?? res.error?.hint ?? JSON.stringify(res.error) ?? "Unknown DB error";
        setBuilderError(`Database error on step 1 (recipe upsert): ${dbMsg}`);
        return;
      }

      // ── Update local state immediately after DB confirms ─────────────────────
      setRecipes(prev => {
        if (editingRecipe) {
          return prev.map(r => r.id === editingRecipe.id ? recipeData : r);
        }
        return [recipeData, ...prev];
      });

      // ── Step 2 (non-blocking): patch output inventory item cost ──────────────
      // This runs AFTER the drawer closes — recipe is already saved above.
      // Awaiting this was adding sequential latency to every save unnecessarily.
      // Any failure is logged to console; user sees the recipe was saved correctly.
      if (outputItemId) {
        const invItem = inventory.find(i =>
          (i.itemId && i.itemId.toString() === outputItemId.toString()) ||
          i.id.toString() === outputItemId.toString()
        );
        if (invItem) {
          const newCost = cost / yieldQty;
          // Optimistically patch local state immediately
          setInventory(prev =>
            prev.map(i => i.id === invItem.id ? { ...i, cost: newCost } : i)
          );
          // Fire DB patch in background — don't await, don't block close
          withTimeout(
            updateInventoryItemCost(invItem.id, newCost),
            15_000,
            "Inventory cost patch timed out"
          ).then(invRes => {
            if (!invRes.success) {
              console.warn("[saveRecipe] inventory cost patch failed:", invRes.error);
            } else {
              console.debug(`[saveRecipe] step 2 (bg) done in ${Date.now() - t0}ms`);
            }
          }).catch(err => {
            console.warn("[saveRecipe] inventory cost patch error:", err?.message);
          });
        }
      }

      console.debug(`[saveRecipe] COMPLETE in ${Date.now() - t0}ms (drawer closing)`);
      setIsBuilderOpen(false);
      setBuilderError(null);
    } catch (err: any) {
      console.error("[saveRecipe] CAUGHT ERROR", err);
      setBuilderError(err?.message ?? "An unexpected error occurred. Please try again.");
    } finally {
      console.debug(`[saveRecipe] finally: resetting isSaving (${Date.now() - t0}ms total)`);
      setIsSaving(false);
    }
  };

  const filteredRecipes = recipes.filter(r => r.name.toLowerCase().includes(searchQuery.toLowerCase()));
  const currentCalc = calculateCost();
  const currentPrice = (targetMargin / 100 >= 1) ? 0 : currentCalc.total / (1 - (targetMargin / 100));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight">Recipes & Costing</h2>
            <Badge variant="warning" className="text-[10px] px-1.5 py-0">HQ Only</Badge>
          </div>
          <p className="text-neutral-500">Construct BOM outputs mathematically linking units natively to raw inventory tracking.</p>
        </div>
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <button
            onClick={() => setIsImportOpen(true)}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 shadow-sm w-full sm:w-auto"
          >
            <Sparkles className="h-4 w-4" />
            Import from Image
          </button>
          <button
            onClick={() => openBuilder()}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm w-full sm:w-auto"
          >
            <Plus className="h-4 w-4" />
            Create Recipe Wrapper
          </button>
        </div>
      </div>

      <Card className="shadow-sm border-neutral-200">
        <CardHeader className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:items-center justify-between pb-4 border-b border-neutral-100">
          <div className="relative w-full sm:w-96">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-neutral-400" />
            </div>
            <input 
              type="text" 
              placeholder="Search recipes..." 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 w-full bg-neutral-50 hover:bg-white transition-colors"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/50">
              <TableRow>
                <TableHead className="pl-6">Recipe Sequence</TableHead>
                <TableHead>Yield Rules</TableHead>
                <TableHead>Raw Items Mapped</TableHead>
                <TableHead className="text-right">Theoretical Output Cost</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRecipes.map((recipe) => (
                <TableRow key={recipe.id} className="hover:bg-neutral-50/50 group">
                  <TableCell className="pl-6 py-4">
                    <p className="font-semibold text-brand-900">{recipe.name}</p>
                    <p className="text-xs text-neutral-500 mt-0.5">{recipe.category} • {recipe.id}</p>
                  </TableCell>
                  <TableCell className="py-4">
                    <Badge variant="neutral" className="bg-white border-neutral-200 text-neutral-700">
                      Output: {recipe.yieldQty} {recipe.yieldUnit}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-4 text-sm text-neutral-600">
                    <span className="font-semibold text-neutral-900">{recipe.ingredients ? recipe.ingredients.length : 0}</span> linked nodes
                  </TableCell>
                  <TableCell className="py-4 text-right">
                    <p className="font-bold text-neutral-900">${(recipe.theoreticalCost || 0).toFixed(2)}</p>
                    {(recipe.yieldQty > 0) && (
                      <p className="text-xs text-brand-600 font-semibold mt-0.5">
                        ${((recipe.theoreticalCost || 0) / recipe.yieldQty).toFixed(2)}&nbsp;/&nbsp;{recipe.yieldUnit || "unit"}
                      </p>
                    )}
                    <p className="text-[10px] uppercase text-neutral-400 font-semibold tracking-wider mt-1">{recipe.margin}% target margin</p>
                  </TableCell>
                  <TableCell className="pr-6 py-4 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        onClick={() => openBuilder(recipe)}
                        className="px-3 py-1.5 bg-white border border-neutral-200 text-neutral-700 rounded-md text-xs font-semibold hover:bg-neutral-50 transition-colors shadow-sm inline-flex items-center gap-1.5"
                      >
                        <SplitSquareVertical className="h-3.5 w-3.5" /> Open Matrix
                      </button>
                      <button
                        onClick={() => setDeleteTarget(recipe)}
                        className="px-3 py-1.5 bg-white border border-danger-200 text-danger-600 rounded-md text-xs font-semibold hover:bg-danger-50 transition-colors shadow-sm inline-flex items-center gap-1.5"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── Delete confirmation modal ───────────────────────────────────── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => !isDeleting && setDeleteTarget(null)}
          />
          {/* Dialog */}
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4">
            {/* Icon + title */}
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-full bg-danger-50 flex items-center justify-center shrink-0">
                <Trash2 className="h-5 w-5 text-danger-500" />
              </div>
              <div>
                <h2 className="text-base font-bold text-neutral-900">Delete Recipe</h2>
                <p className="text-sm text-neutral-500 mt-0.5">
                  <span className="font-semibold text-neutral-800">{deleteTarget.name}</span>
                </p>
              </div>
            </div>

            {/* Warning body */}
            <div className="bg-danger-50 border border-danger-100 rounded-lg p-3 text-sm text-danger-700 leading-relaxed">
              Are you sure you want to delete this recipe? <strong>This cannot be undone.</strong>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-1">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={isDeleting}
                className="px-4 py-2 text-sm font-semibold bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
                className="px-4 py-2 text-sm font-semibold bg-danger-600 text-white rounded-lg hover:bg-danger-700 transition-colors disabled:opacity-50 inline-flex items-center gap-2"
              >
                {isDeleting ? (
                  <><div className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Deleting…</>
                ) : (
                  <><Trash2 className="h-3.5 w-3.5" /> Yes, Delete Recipe</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <Drawer
        isOpen={isBuilderOpen}
        onClose={() => setIsBuilderOpen(false)}
        title={editingRecipe ? "Edit Recipe Map" : "Compile Recipe Map"}
        description="Bind abstract ingredients firmly exclusively to existing HQ raw tier items."
        footer={
          <div className="w-full flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
               <span className="text-[10px] uppercase tracking-wider text-neutral-500 font-bold">Calculation Output</span>
               {builderError ? (
                 <span className="text-sm font-bold text-danger-600">{builderError}</span>
               ) : currentCalc.errors > 0 ? (
                 <span className="text-sm font-bold text-danger-600">Unresolvable Unit Constraints</span>
               ) : (
                 <span className="text-sm font-bold text-brand-700">${currentCalc.total.toFixed(2)} Target Cost</span>
               )}
            </div>
            <div className="flex gap-2">
              <button
                className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors shadow-sm disabled:opacity-50"
                onClick={() => { setIsBuilderOpen(false); setBuilderError(null); }}
                disabled={isSaving}
              >
                Discard
              </button>
              <button
                className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                onClick={saveRecipeData}
                disabled={isSaving}
              >
                {isSaving && <span className="h-3.5 w-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                {isSaving ? "Saving…" : "Compile Sequence"}
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          <div className="bg-white p-4 rounded-xl border border-neutral-200 shadow-sm space-y-4">
            <div>
              <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5 block">Recipe Identity</label>
              <input 
                type="text" 
                value={recipeName}
                onChange={e => setRecipeName(e.target.value)}
                className="w-full p-2 border border-neutral-300 rounded font-medium focus:ring-1 focus:ring-brand-500 focus:outline-none"
                placeholder="e.g. Garlic Emulsion Base"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5 block">Category</label>
                <select 
                  value={recipeCategory}
                  onChange={e => setRecipeCategory(e.target.value)}
                  className="w-full p-2 border border-neutral-300 rounded text-sm focus:ring-1 focus:ring-brand-500 focus:outline-none bg-white"
                >
                  <option>Mains</option>
                  <option>Prep</option>
                  <option>Sauces</option>
                  <option>Starters</option>
                  <option>Desserts</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5 block">Target Margin (%)</label>
                <input 
                  type="number" 
                  value={targetMargin}
                  onChange={e => setTargetMargin(Number(e.target.value))}
                  className="w-full p-2 border border-neutral-300 rounded text-sm focus:ring-1 focus:ring-brand-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="flex gap-4">
             <div className="flex-1 bg-white p-4 rounded-xl border border-neutral-200 shadow-sm">
                <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5 block flex items-center justify-between">
                  Expected Physical Yield
                  <Calculator className="h-3.5 w-3.5 text-neutral-400" />
                </label>
                <div className="flex gap-2">
                  <input 
                    type="number" 
                    value={yieldQty}
                    onChange={e => setYieldQty(Number(e.target.value))}
                    className="w-full p-2 border border-neutral-300 rounded text-sm focus:ring-1 focus:ring-brand-500 focus:outline-none"
                    placeholder="Qty"
                  />
                  <input 
                    type="text" 
                    value={yieldUnit}
                    onChange={e => setYieldUnit(e.target.value)}
                    className="w-24 p-2 border border-neutral-300 rounded text-sm focus:ring-1 focus:ring-brand-500 focus:outline-none"
                    placeholder="kg/L"
                  />
                </div>
                
                <div className="pt-4 mt-4 border-t border-neutral-100">
                   <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5 block">Linked Physical Output Item (Optional)</label>
                   <select
                     value={outputItemId}
                     onChange={e => setOutputItemId(e.target.value)}
                     className="w-full p-2 border border-neutral-300 rounded text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                   >
                     <option value="">No Link (Abstract Recipe)</option>
                     <optgroup label="Physical Preparations / FGs">
                       {inventory.filter((i: any) => i.itemType === 'Preparation' || i.itemType === 'Finished Good').map((item: any) => (
                         <option key={item.id} value={item.id.toString()}>
                           {item.name} ({item.unit})
                         </option>
                       ))}
                     </optgroup>
                   </select>
                   <p className="text-[10px] text-neutral-400 mt-1">If linked, generating production blocks updates this item's native stock quantity.</p>
                </div>
             </div>
             
             <div className="w-48 bg-neutral-800 text-white p-4 rounded-xl shadow-inner flex flex-col justify-center">
                <p className="text-[10px] uppercase font-bold text-neutral-400 tracking-wider">Suggested Menu Price</p>
                <p className="text-2xl font-bold mt-1">${currentPrice.toFixed(2)}</p>
             </div>
          </div>

          <div>
             <div className="flex items-center justify-between mb-3">
               <h3 className="font-bold text-neutral-900 border-b-2 border-brand-500 pb-1 w-fit">Raw Hardware Requirements</h3>
             </div>
             
             <div className="space-y-3">
               {ingredients.map((ing, idx) => {
                  let lineCost = 0;
                  let hasError = false;
                  let costErrorMsg = "";

                  const targetId = ing.inventoryId || ing.fgId;

                  // ── Item lookup — match on row id first, itemId only as fallback ──────────
                  // IMPORTANT: always prefer the unique row id over the shared item_id.
                  // Two items with the same name share item_id (cross-location link) — if we
                  // match on itemId first, the second cauliflower would resolve to the first's
                  // row and show wrong cost / units. Row id is always unique.
                  const invItem = inventory.find(i =>
                    (targetId != null) && (
                      i.id.toString() === targetId.toString() ||
                      (i.itemId && i.itemId.toString() === targetId.toString())
                    )
                  );

                  if (invItem) {
                     try {
                        // Phase 1: use resolveEffectiveBaseUom so base_uom takes priority over baseUnit when set
                        const baseTargetUnit = resolveEffectiveBaseUom(invItem);
                        const normQty = normalizeUnit(ing.qty, ing.unit, baseTargetUnit);

                        // ── Effective base cost — three-path priority chain ──────
                        // Path 1 (NEW): structured pack fields fully populated
                        // Path 2 (EXISTING): purchaseUnits JSONB
                        // Path 3 (LEGACY): item.cost is already base-unit cost
                        let effectiveBaseCost = invItem.cost;                              // Path 3 default
                        const structuredCost = computeBaseUnitCostFromPack(invItem);
                        if (structuredCost !== null) {
                           effectiveBaseCost = structuredCost;                             // Path 1
                        } else if (invItem.purchaseUnits && invItem.purchaseUnits.length > 0) {
                            const primary = invItem.purchaseUnits.find((u: any) => u.isPrimary) || invItem.purchaseUnits[0];
                            const purchCost = (invItem.purchaseCost !== undefined && invItem.purchaseCost !== null)
                              ? invItem.purchaseCost
                              : invItem.cost * primary.conversion;                         // reconstruct if missing
                            effectiveBaseCost = purchCost / primary.conversion;            // Path 2
                        }
                        lineCost = normQty * effectiveBaseCost;

                        // Soft-warning audit (Phase 1) — never blocks saving
                        const unitWarnings = auditItemUnitAmbiguity(invItem, ing.unit);
                        if (unitWarnings.length > 0 && !hasError) {
                          // Surface first warning so ⚠ badge appears without overriding a real error
                          costErrorMsg = unitWarnings[0];
                        }
                     } catch (e: any) {
                        hasError = true;
                        costErrorMsg = e?.message ?? "Unit conversion error";
                     }
                  }

                  const mappedName = invItem ? invItem.name : "Unknown Item";
                  // Phase 1: use resolveEffectiveBaseUom so the "Native Constraint" badge
                  // shows base_uom when set, falling back to baseUnit → unit.
                  const mappedUnit = invItem ? resolveEffectiveBaseUom(invItem) : 'N/A';

                  // Extract visual type indicator if properly tagged in the native inventory ledger
                  const isPrepNode = invItem && (invItem.itemType === 'Preparation' || invItem.itemType === 'Finished Good');

                  return (
                    <div key={idx} className={`p-3 rounded-lg border flex items-center gap-4 shadow-sm bg-white ${hasError ? 'border-danger-300' : 'border-neutral-200'}`}>
                      <div className="w-1/3">
                        <div className="flex items-center gap-2 mb-0.5">
                           <p className="text-sm font-bold text-neutral-900 truncate">{mappedName}</p>
                           {isPrepNode ? (
                              <Badge variant="warning" className="text-[9px] px-1.5 py-0 border-none bg-orange-100 text-orange-700">PREP</Badge>
                           ) : (
                              <Badge variant="neutral" className="text-[9px] px-1.5 py-0 border-none bg-neutral-100 text-neutral-600">INV</Badge>
                           )}
                        </div>
                        <p className="text-[10px] text-neutral-400 uppercase tracking-wider font-semibold mt-0.5">
                          Native Constraint: <span className="text-brand-600">{mappedUnit}</span>
                        </p>
                      </div>
                      
                      <div className="flex-1 grid grid-cols-2 gap-2">
                        <input 
                          type="number"
                          value={ing.qty}
                          onChange={e => updateIngredient(idx, 'qty', Number(e.target.value))}
                          className="w-full p-1.5 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                        {(() => {
                           const allowedUoms: string[] = Array.isArray(invItem?.allowedRecipeUoms)
                             ? invItem.allowedRecipeUoms.filter(Boolean)
                             : [];
                           const isUomMismatch = allowedUoms.length > 0 && !allowedUoms.includes(ing.unit);
                           const uomLabel: Record<string, string> = {
                             g: "Grams (g)", kg: "Kilograms (kg)", mg: "Milligrams (mg)",
                             oz: "Ounces (oz)", lb: "Pounds (lb)",
                             ml: "Milliliters (ml)", l: "Liters (l)",
                             tsp: "Teaspoon (tsp)", tbsp: "Tablespoon (tbsp)",
                             cup: "Cup", "fl oz": "Fl. Oz.",
                             ea: "Each (ea)", each: "Each (each)", pcs: "Pieces (pcs)", piece: "Piece",
                             pack: "Pack", box: "Box", bag: "Bag", can: "Can / Tin",
                             bottle: "Bottle", bunch: "Bunch", clove: "Clove",
                             sprig: "Sprig", slice: "Slice", knob: "Knob",
                           };
                           return (
                             <select
                               value={ing.unit}
                               onChange={e => updateIngredient(idx, 'unit', e.target.value)}
                               className={`w-full p-1.5 border rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white transition-colors ${
                                 isUomMismatch
                                   ? "border-warning-400 ring-1 ring-warning-300 bg-warning-50"
                                   : "border-neutral-200"
                               }`}
                               title={isUomMismatch
                                 ? `\u26a0 "${ing.unit}" is outside recommended units: ${allowedUoms.join(", ")}`
                                 : undefined}
                             >
                               {allowedUoms.length > 0 && (
                                 <optgroup label={`\u2605 Recommended for this item`}>
                                   {allowedUoms.map(u => (
                                     <option key={u} value={u}>{uomLabel[u] ?? u}</option>
                                   ))}
                                 </optgroup>
                               )}
                               <optgroup label={allowedUoms.length > 0 ? "All Units \u2014 Weight" : "Weight"}>
                                 <option value="g">Grams (g)</option>
                                 <option value="kg">Kilograms (kg)</option>
                                 <option value="mg">Milligrams (mg)</option>
                                 <option value="oz">Ounces (oz)</option>
                                 <option value="lb">Pounds (lb)</option>
                               </optgroup>
                               <optgroup label={allowedUoms.length > 0 ? "All Units \u2014 Volume" : "Volume"}>
                                 <option value="ml">Milliliters (ml)</option>
                                 <option value="l">Liters (l)</option>
                                 <option value="tsp">Teaspoon (tsp)</option>
                                 <option value="tbsp">Tablespoon (tbsp)</option>
                                 <option value="cup">Cup</option>
                                 <option value="fl oz">Fl. Oz.</option>
                               </optgroup>
                               <optgroup label="Count / Each">
                                 <option value="ea">Each (ea)</option>
                                 <option value="each">Each (each)</option>
                                 <option value="pcs">Pieces (pcs)</option>
                                 <option value="piece">Piece</option>
                               </optgroup>
                               <optgroup label="Packaging">
                                 <option value="pack">Pack</option>
                                 <option value="box">Box</option>
                                 <option value="bag">Bag</option>
                                 <option value="can">Can / Tin</option>
                                 <option value="bottle">Bottle</option>
                                 <option value="bunch">Bunch</option>
                                 <option value="clove">Clove</option>
                                 <option value="sprig">Sprig</option>
                                 <option value="slice">Slice</option>
                                 <option value="knob">Knob</option>
                               </optgroup>
                             </select>
                           );
                        })()}
                      </div>
                      
                      <div className="w-20 text-right shrink-0">
                         {hasError ? (
                           <Badge
                             variant="danger"
                             className="text-[10px] px-1.5 py-0 border-none cursor-help"
                             title={costErrorMsg}
                           >
                             Unit Error
                           </Badge>
                         ) : (
                           <span className="text-sm font-semibold text-neutral-600">${lineCost.toFixed(2)}</span>
                         )}
                      </div>

                      <button 
                        onClick={() => removeIngredient(idx)}
                        className="text-neutral-400 hover:text-danger-600 p-1.5 rounded hover:bg-danger-50 transition-colors"
                      >
                         <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  );
               })}

               {/* ── Ingredient search combobox ── */}
               {(() => {
                  const supMap: Record<number, string> = {};
                  suppliersData.forEach((s: any) => { supMap[s.id] = s.name; });
                  const q = ingSearch.toLowerCase().trim();
                  const filtered = q
                    ? inventory.filter((i: any) =>
                        i.name?.toLowerCase().includes(q) ||
                        i.category?.toLowerCase().includes(q) ||
                        (i.supplierId && supMap[i.supplierId]?.toLowerCase().includes(q))
                      )
                    : inventory;

                  // CLOVE search diagnostic
                  if (q.includes('clo') || q.includes('clove')) {
                    const cloveInInv = inventory.filter((i: any) => i.name?.toLowerCase().includes('clove'));
                    const cloveInFiltered = filtered.filter((i: any) => i.name?.toLowerCase().includes('clove'));
                    console.log(
                      `[RecipeSearchDiag] query="${q}" | inventory.length=${inventory.length}` +
                      ` | clove in inventory=${cloveInInv.length} | clove in filtered=${cloveInFiltered.length}`,
                      cloveInInv.map((i: any) => ({ name: i.name, id: i.id, locationId: i.locationId }))
                    );
                  }

                  const selectedItem = inventory.find((i: any) => i.id.toString() === selectedInvId);

                  // Open panel: capture anchor rect so the fixed dropdown aligns to the input
                  const openPanel = () => {
                    if (ingInputRef.current) {
                      const r = ingInputRef.current.getBoundingClientRect();
                      setIngAnchor({ top: r.bottom + 4, left: r.left, width: r.width });
                    }
                    setIngPanelOpen(true);
                  };

                  return (
                    <div className="relative mt-1">
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-400 pointer-events-none" />
                          <input
                            ref={ingInputRef}
                            type="text"
                            value={ingSearch}
                            onChange={e => {
                              setIngSearch(e.target.value);
                              setSelectedInvId("");
                              openPanel();
                            }}
                            onFocus={openPanel}
                            onKeyDown={e => {
                              if (e.key === "Enter" && selectedInvId) { addIngredient(); setIngSearch(""); setIngPanelOpen(false); }
                              if (e.key === "Escape") setIngPanelOpen(false);
                            }}
                            placeholder="Search by name, category, or supplier…"
                            className="w-full pl-8 pr-3 py-2 border border-neutral-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-400"
                          />
                        </div>
                        <button
                          onClick={() => { addIngredient(); setIngSearch(""); setIngPanelOpen(false); }}
                          disabled={!selectedInvId}
                          className="px-4 py-2 bg-neutral-900 text-white text-sm font-semibold rounded-lg hover:bg-black transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                        >
                          {selectedItem ? `+ ${selectedItem.name}` : "Append"}
                        </button>
                      </div>

                      {/* Fixed-position dropdown — escapes overflow-y-auto clipping */}
                      {ingPanelOpen && ingAnchor && (
                        <>
                          {/* Invisible backdrop: closes panel on outside click */}
                          <div
                            className="fixed inset-0"
                            style={{ zIndex: 9998 }}
                            onClick={() => setIngPanelOpen(false)}
                          />
                          <div
                            className="bg-white border border-neutral-200 rounded-xl shadow-2xl overflow-y-auto"
                            style={{
                              position: "fixed",
                              top:      ingAnchor.top,
                              left:     ingAnchor.left,
                              width:    ingAnchor.width,
                              maxHeight: "260px",
                              zIndex:   9999,
                            }}
                          >
                            {filtered.length === 0 ? (
                              <div className="px-4 py-6 text-center text-sm text-neutral-400">No items match your search.</div>
                            ) : (
                              <div className="divide-y divide-neutral-100">
                                {filtered.map((item: any) => {
                                  const shortId      = String(item.id).slice(-6);
                                  const supplierName = item.supplierId ? (supMap[item.supplierId] ?? null) : null;
                                  const isPrepNode   = item.itemType === "Preparation" || item.itemType === "Finished Good";
                                  const isSelected   = item.id.toString() === selectedInvId;
                                  return (
                                    <button
                                      key={item.id}
                                      type="button"
                                      onClick={() => { setSelectedInvId(item.id.toString()); setIngSearch(item.name); setIngPanelOpen(false); }}
                                      className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 transition-colors ${isSelected ? "bg-brand-50 border-l-2 border-brand-500" : "hover:bg-neutral-50"}`}
                                    >
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                          <span className="text-sm font-semibold text-neutral-900">{item.name}</span>
                                          {isPrepNode && (
                                            <span className="text-[9px] font-bold px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded uppercase shrink-0">
                                              {item.itemType === "Finished Good" ? "FG" : "PREP"}
                                            </span>
                                          )}
                                          <span className="text-[10px] font-mono text-neutral-300 shrink-0">#{shortId}</span>
                                        </div>
                                        {supplierName && <p className="text-[11px] text-neutral-400 mt-0.5 truncate">{supplierName}</p>}
                                      </div>
                                      <div className="text-right shrink-0 space-y-0.5">
                                        {item.category && (
                                          <span className="block text-[10px] font-semibold px-1.5 py-0.5 bg-neutral-100 text-neutral-500 rounded uppercase">{item.category}</span>
                                        )}
                                        <span className="block text-xs text-neutral-600 font-medium">
                                          {item.unit}&nbsp;·&nbsp;${(item.cost || 0).toFixed(2)}/{item.unit}
                                        </span>
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
               })()}
             </div>
          </div>
        </div>
      </Drawer>

      {/* ── AI Recipe Import Drawer ──────────────────────────────── */}
      <AIRecipeImport
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        inventory={inventory}
        onConfirm={handleAIImportConfirm}
      />
    </div>
  );
}
