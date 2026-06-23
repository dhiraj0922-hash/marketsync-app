"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Drawer } from "@/components/ui/drawer";
import {
  PackageCheck, Search, Plus, Edit2, ToggleLeft, ToggleRight,
  TrendingUp, TrendingDown, Minus, AlertCircle, Loader2, ChevronRight, DollarSign, Factory,
  CheckCircle2, XCircle, Layers, MapPin, Trash2, PlusCircle, Tag, Upload,
  Users
} from "lucide-react";
import {
  loadSaleItems, upsertSaleItem, loadRecipes, loadLocations,
  loadFgLocationPricing, upsertFgLocationPricing, deleteFgLocationPricing,
  loadCategories, addCategory, convertYieldToBaseUnit,
  loadFinishedGoodLocationAvailability, saveFinishedGoodLocationAvailability,
  loadLatestFgCounts, loadTodayMovementMetrics,
  loadSuppliers, loadHqSetupQueue,
  type SaleItem, type FgLocationPricing, type HqSetupQueueRow
} from "@/lib/storage";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { FgImportModal } from "@/components/FgImportModal";
import { FgCostAuditPanel } from "@/components/FgCostAuditPanel";
import { HqPurchasedSetupDrawer } from "@/components/HqPurchasedSetupDrawer";


// ─── FG category presets ───────────────────────────────────────────────────────
const CATEGORY_OPTIONS = [
  // Existing
  "Sauces & Condiments",
  "Breads & Baked",
  "Proteins",
  "Salads & Bowls",
  "Soups & Stocks",
  "Desserts",
  "Beverages",
  "Sides",
  "Meal Kits",
  // New
  "Tandoor",
  "Curries",
  "Meat",
  "Masala",
  "Batter",
  "Tray",
  "Chutneys",
  "Other",
];

// ─── Source commissary options ─────────────────────────────────────────────────
const COMMISSARY_OPTIONS = [
  "Commissary HQ",
  "MOMOLOCO",
  "Veggie Paradise",
] as const;
type CommissaryOption = typeof COMMISSARY_OPTIONS[number];

// Badge colour per commissary
const COMMISSARY_COLORS: Record<string, string> = {
  "Commissary HQ":   "bg-brand-50   text-brand-700   border-brand-200",
  "MOMOLOCO":        "bg-warning-50  text-warning-700  border-warning-200",
  "Veggie Paradise": "bg-success-50  text-success-700  border-success-200",
};

// ─── Food cost % helper ────────────────────────────────────────────────────────
function foodCostPct(makingCost: number, salesPrice: number): string {
  if (!salesPrice || salesPrice <= 0) return "—";
  const pct = (makingCost / salesPrice) * 100;
  return `${pct.toFixed(1)}%`;
}

const fmt = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function FoodCostBadge({ pct }: { pct: string }) {
  if (pct === "—") return <span className="text-neutral-400 text-xs">—</span>;
  const val = parseFloat(pct);
  const cls = val > 35
    ? "bg-danger-50 text-danger-700 border-danger-200"
    : val > 28
    ? "bg-warning-50 text-warning-700 border-warning-200"
    : "bg-success-50 text-success-700 border-success-200";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${cls}`}>
      <TrendingUp className="h-3 w-3 mr-1" />{pct}
    </span>
  );
}

// ─── Stock status chip ─────────────────────────────────────────────────────────
function StockChip({ status }: { status: SaleItem["stockStatus"] }) {
  const cfg = {
    in_stock:     { label: "In Stock",     cls: "bg-success-50 text-success-700 border-success-200" },
    low_stock:    { label: "Low Stock",    cls: "bg-warning-50 text-warning-700 border-warning-200" },
    out_of_stock: { label: "Out of Stock", cls: "bg-danger-50  text-danger-700  border-danger-200"  },
  }[status] ?? { label: status, cls: "bg-neutral-50 text-neutral-600 border-neutral-200" };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

// ─── Active chip ──────────────────────────────────────────────────────────────
function ActiveChip({ active }: { active: boolean }) {
  return active
    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-brand-50 text-brand-700 border border-brand-200"><CheckCircle2 className="h-3 w-3" /> Active</span>
    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-neutral-100 text-neutral-500 border border-neutral-200"><XCircle className="h-3 w-3" /> Inactive</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// computeLiveCost — single source of truth for per-unit pricing
//
// Priority:
//   1. Linked recipe exists → convert recipe yield into item.baseUnit,
//      then divide theoreticalCost by the converted yield.
//   2. No linked recipe     → return the stored DB values as-is.
//
// Returns:
//   makingCost        – cost per baseUnit (live recomputed or DB fallback)
//   suggestedPrice    – makingCost × 1.20
//   effectivePrice    – manualPrice if set, else suggestedPrice
//   conversionWarning – non-null string when unit conversion is impossible
// ─────────────────────────────────────────────────────────────────────────────
interface LiveCost {
  makingCost:        number;
  suggestedPrice:    number;
  effectivePrice:    number;
  conversionWarning: string | null;
}

function computeLiveCost(item: SaleItem, recipes: any[]): LiveCost {
  const norm = (u: string) => (u ?? '').trim().toLowerCase();

  const fallback: LiveCost = {
    makingCost:        item.makingCost,
    suggestedPrice:    item.suggestedPrice,
    effectivePrice:    item.effectivePrice,
    conversionWarning: null,
  };

  if (!item.sourceRecipeId) return fallback;

  const recipe = recipes.find(r => String(r.id) === String(item.sourceRecipeId));
  if (!recipe) return fallback;

  const totalCost  = Number(recipe.theoreticalCost);
  const yieldQty   = Number(recipe.yieldQty);
  if (totalCost <= 0 || yieldQty <= 0) return fallback;

  // Always normalise both units to lowercase+trimmed before conversion
  const recipeUnit = norm(recipe.yieldUnit);
  const itemUnit   = norm(item.baseUnit);

  // ── DEBUG GUARD ─────────────────────────────────────────────────────────────
  // Log the exact inputs every time so unit mismatches are visible in DevTools.
  // Remove or gate behind a flag once stable.
  console.debug(
    `[computeLiveCost] item="${item.name}" (${item.id})` +
    ` | recipe="${recipe.name}" (${recipe.id})` +
    ` | yieldQty=${yieldQty} yieldUnit="${recipeUnit}"` +
    ` | item.baseUnit="${itemUnit}"` +
    ` | totalCost=$${totalCost}`
  );

  const conv = convertYieldToBaseUnit(yieldQty, recipeUnit, itemUnit);

  // ── ASSERTION: if units differ, conversion MUST have happened ───────────────
  if (conv !== null && !conv.converted && recipeUnit !== itemUnit) {
    // This should never happen — convertYieldToBaseUnit always converts when
    // fromU !== toU and both are dimensional. If it fires, something is wrong
    // in the conversion table.
    console.error(
      `[computeLiveCost] ASSERTION FAILED: units differ ("${recipeUnit}" vs "${itemUnit}")` +
      ` but conv.converted=false and conv.qty=${conv.qty}.` +
      ` Expected a real unit conversion. Check convertYieldToBaseUnit.`
    );
  }

  // ── ASSERTION: result must differ from raw yieldQty when units differ ───────
  if (conv !== null && recipeUnit !== itemUnit && conv.qty === yieldQty) {
    console.error(
      `[computeLiveCost] ASSERTION FAILED: yieldInBaseUnit === yieldQty (${yieldQty})` +
      ` but units differ ("${recipeUnit}" → "${itemUnit}"). This means no conversion occurred.` +
      ` makingCost would be wrong — returning conversionWarning instead.`
    );
    return {
      ...fallback,
      conversionWarning:
        `Internal error: unit conversion produced no change for "${recipeUnit}" → "${itemUnit}". ` +
        `Please report this bug.`,
    };
  }

  if (conv === null || conv.qty <= 0) {
    console.warn(
      `[computeLiveCost] Cannot convert "${recipeUnit}" → "${itemUnit}" for item "${item.name}".` +
      ` Incompatible unit dimensions or unknown unit.`
    );
    return {
      ...fallback,
      conversionWarning:
        `Unit mismatch: recipe yields in "${recipeUnit || '(none)'}" but this item uses "${itemUnit || '(none)'}". ` +
        `Both must be in the same measurement family (weight or volume). ` +
        `Re-open Edit and correct the recipe's yield unit or the FG's base unit.`,
    };
  }

  const makingCost     = totalCost / conv.qty;
  const suggestedPrice = makingCost * 1.20;
  const effectivePrice = item.manualPrice != null ? item.manualPrice : suggestedPrice;

  console.debug(
    `[computeLiveCost] result: yieldInBaseUnit=${conv.qty.toFixed(4)}${itemUnit}` +
    ` | converted=${conv.converted}` +
    ` | makingCost=$${makingCost.toFixed(4)}/${itemUnit}` +
    ` | suggested=$${suggestedPrice.toFixed(4)}/${itemUnit}`
  );

  return { makingCost, suggestedPrice, effectivePrice, conversionWarning: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HQ SALE ITEMS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function HQSaleItemsContent() {
  const [items, setItems]       = useState<SaleItem[]>([]);
  const [recipes, setRecipes]   = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [locations, setLocations] = useState<{ id: string; name: string; type?: string; subtype?: string; status?: string }[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch]     = useState("");
  const [filterCategory, setFilterCategory] = useState("All");
  const [filterCommissary, setFilterCommissary] = useState("All");

  // DB-driven category list (loaded from categories table)
  const [dbCategories, setDbCategories] = useState<string[]>([]);
  
  // Latest FG counts state (Last Count Date & Latest Variance)
  const [latestCounts, setLatestCounts] = useState<Record<string, { lastCountDate: string | null; latestVariance: number }>>({});
  // Today's movement metrics (Produced Today & Supplied Today)
  const [todayMetrics, setTodayMetrics] = useState<Record<string, { producedToday: number; suppliedToday: number }>>({});

  // Inline "+ Add Category" form in drawer
  const [addCatInput, setAddCatInput]   = useState("");
  const [isAddingCat, setIsAddingCat]   = useState(false);
  const [addCatError, setAddCatError]   = useState<string | null>(null);

  // Import modal state
  const [isImportOpen, setIsImportOpen] = useState(false);

  // HQ Purchased Setup drawer state
  const [isSetupDrawerOpen, setIsSetupDrawerOpen]   = useState(false);
  const [setupDrawerItem, setSetupDrawerItem]       = useState<SaleItem | null>(null);
  const [setupDrawerCatalogId, setSetupDrawerCatalogId] = useState<string | undefined>(undefined);

  // HQ Setup Queue — catalog rows pending HQ Purchased promotion
  const [setupQueue, setSetupQueue] = useState<HqSetupQueueRow[]>([]);
  const [queueExpanded, setQueueExpanded] = useState(true);

  // Drawer state
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [editing, setEditing]  = useState<SaleItem | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Location pricing state (for edit drawer)
  const [locationPricing, setLocationPricing] = useState<FgLocationPricing[]>([]);
  const [isPricingLoading, setIsPricingLoading] = useState(false);
  // Inline add-pricing form
  const [newPricingLocId, setNewPricingLocId]       = useState("");
  const [newPricingPrice, setNewPricingPrice]       = useState("");
  const [newPricingNotes, setNewPricingNotes]       = useState("");
  const [isPricingSaving, setIsPricingSaving]       = useState(false);
  const [pricingError, setPricingError]             = useState<string | null>(null);

  // Form state
  const [formName, setFormName]               = useState("");
  const [formCategory, setFormCategory]       = useState("");
  const [formCommissary, setFormCommissary]   = useState<string>("Commissary HQ");
  const [formDesc, setFormDesc]               = useState("");
  const [formUnit, setFormUnit]               = useState("ea");
  const [formParLevel, setFormParLevel]       = useState<number>(0);
  const [formManualPrice, setFormManualPrice] = useState<string>("");
  const [formRecipeId, setFormRecipeId]       = useState<string>("");
  const [formPackQty, setFormPackQty]         = useState<number>(1);
  const [formActive, setFormActive]           = useState(true);
  const [formRequisitionable, setFormRequisitionable] = useState(true);
  const [formAvailabilityOverride, setFormAvailabilityOverride] = useState<SaleItem['availabilityOverride']>(null);
  const [formAvailabilityMode, setFormAvailabilityMode] = useState<'all' | 'selected' | 'hq_only'>('all');
  const [formSelectedLocations, setFormSelectedLocations] = useState<string[]>([]);

  // ── Load data ────────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [si, rec, locs, cats, counts, metrics, supplierList] = await Promise.all([
        loadSaleItems(), loadRecipes(), loadLocations(),
        loadCategories('finished_goods'),
        loadLatestFgCounts(),
        loadTodayMovementMetrics(),
        loadSuppliers(),
      ]);
      setItems(Array.isArray(si) ? si : []);
      setRecipes(Array.isArray(rec) ? rec : []);
      setSuppliers(Array.isArray(supplierList) ? supplierList : []);
      setLocations(
        Array.isArray(locs)
          ? locs.map((l: any) => ({
              id: l.id,
              name: l.name,
              type: l.type,
              subtype: l.subtype,
              status: l.status
            }))
          : []
      );
      // DB categories — if empty (pre-migration), UI falls back to CATEGORY_OPTIONS
      setDbCategories(Array.isArray(cats) ? cats : []);
      setLatestCounts(counts || {});
      setTodayMetrics(metrics || {});
      // Load HQ Setup Queue (needs suppliers + saleItems both resolved)
      const queue = await loadHqSetupQueue(
        Array.isArray(supplierList) ? supplierList : [],
        Array.isArray(si) ? si : []
      );
      setSetupQueue(queue);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Load location pricing when opening edit drawer ───────────────────────────
  const loadPricing = useCallback(async (itemId: string) => {
    setIsPricingLoading(true);
    try {
      const rows = await loadFgLocationPricing(itemId);
      setLocationPricing(rows);
    } finally {
      setIsPricingLoading(false);
    }
  }, []);

  // ── Drawer open helpers ───────────────────────────────────────────────────────
  const openCreate = () => {
    setEditing(null);
    setFormName(""); setFormCategory(""); setFormCommissary("Commissary HQ"); setFormDesc(""); setFormUnit("ea");
    setFormParLevel(0); setFormManualPrice(""); setFormRecipeId(""); setFormPackQty(1);
    setFormActive(true); setFormRequisitionable(true); setFormAvailabilityOverride(null);
    setFormAvailabilityMode('all');
    setFormSelectedLocations([]);
    setLocationPricing([]);
    setNewPricingLocId(""); setNewPricingPrice(""); setNewPricingNotes("");
    setSaveError(null); setPricingError(null);
    setIsDrawerOpen(true);
  };

  const openEdit = async (item: SaleItem) => {
    setEditing(item);
    setFormName(item.name);
    setFormCategory(item.category ?? "");
    setFormCommissary(item.sourceCommissary ?? "Commissary HQ");
    setFormDesc(item.description ?? "");
    setFormUnit(item.baseUnit);
    setFormParLevel(item.parLevel);
    setFormManualPrice(item.manualPrice != null ? String(item.manualPrice) : "");
    setFormRecipeId(item.sourceRecipeId ?? "");
    setFormPackQty(item.packQty ?? 1);
    setFormActive(item.isActive);
    setFormRequisitionable(item.isRequisitionable);
    setFormAvailabilityOverride(item.availabilityOverride ?? null);
    setFormAvailabilityMode(item.locationAvailabilityMode ?? 'all');
    setFormSelectedLocations([]);
    setNewPricingLocId(""); setNewPricingPrice(""); setNewPricingNotes("");
    setSaveError(null); setPricingError(null);
    loadPricing(item.id);
    setIsDrawerOpen(true);

    try {
      const selected = await loadFinishedGoodLocationAvailability(item.id);
      setFormSelectedLocations(selected);
    } catch (err) {
      console.error("[openEdit] Failed to load visibility mappings:", err);
    }
  };

  // ── Add category inline ───────────────────────────────────────────────────────
  const handleAddCategory = async () => {
    const name = addCatInput.trim();
    if (!name) return;
    setIsAddingCat(true as any); // keep form open while saving
    setAddCatError(null);
    const res = await addCategory(name, 'finished_goods');
    if (!res.success) {
      setAddCatError(res.error?.message ?? 'Failed to add category.');
      setIsAddingCat(true);
      return;
    }
    // Reload categories from DB so the new one appears in the dropdown
    const fresh = await loadCategories('finished_goods');
    setDbCategories(fresh.length > 0 ? fresh : dbCategories);
    setFormCategory(name);    // auto-select the just-created category
    setAddCatInput('');
    setIsAddingCat(false);
  };

  // ── Save finished good ────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaveError(null);
    if (!formName.trim()) { setSaveError("Name is required."); return; }
    setIsSaving(true);
    try {
      const id = editing?.id ?? `SKU-${Date.now().toString(36).toUpperCase()}`;
      const linkedRecipe = recipes.find(r => r.id === formRecipeId);

      let makingCost = editing?.makingCost ?? 0;
      let sourceYieldQty = editing?.sourceRecipeYieldQty ?? 1;
      if (linkedRecipe) {
        // Convert recipe yield into the FG's base unit before dividing cost.
        // e.g. recipe yields 15 kg but FG is sold in oz → yieldInBaseUnit = 529.109 oz
        const conv = convertYieldToBaseUnit(
          linkedRecipe.yieldQty || 0,
          linkedRecipe.yieldUnit || '',
          formUnit,  // FG base unit
        );
        if (conv === null || conv.qty <= 0) {
          // Conversion impossible — do not write a bad price; keep current value
          setSaveError(
            `Cannot convert recipe yield unit "${linkedRecipe.yieldUnit}" to finished good unit "${formUnit}". ` +
            `Please make sure the recipe yield unit and the finished good base unit are in the same measurement family (e.g. both weight or both volume), ` +
            `or set them to the same unit.`
          );
          setIsSaving(false);
          return;
        }
        sourceYieldQty = conv.qty;
        makingCost = (linkedRecipe.theoreticalCost || 0) / sourceYieldQty;
      }

      const manualPrice = formManualPrice !== "" && !isNaN(parseFloat(formManualPrice))
        ? parseFloat(formManualPrice)
        : null;

      const res = await upsertSaleItem({
        id,
        name:                 formName.trim(),
        category:             formCategory.trim() || null,
        sourceCommissary:     formCommissary || "Commissary HQ",
        description:          formDesc.trim() || null,
        baseUnit:             formUnit,
        parLevel:             formParLevel,
        isActive:             formActive,
        isRequisitionable:    formRequisitionable,
        sourceRecipeId:       formRecipeId || null,
        sourceRecipeYieldQty: sourceYieldQty,
        makingCost,
        manualPrice,
        packQty:              formPackQty > 0 ? formPackQty : 1,
        locationAvailabilityMode: formAvailabilityMode,
        instock:              editing?.instock ?? 0,
        suggestedPrice:       0,
        effectivePrice:       0,
        stockStatus:          'in_stock',
        availabilityOverride: formAvailabilityOverride ?? null,
        makingCostUpdatedAt:  null,
        createdAt:            null,
        updatedAt:            null,
      });

      if (!res.success) {
        setSaveError(res.error?.message ?? "Save failed.");
        return;
      }

      // Save availability mapping table
      const availabilityRes = await saveFinishedGoodLocationAvailability(
        id,
        formAvailabilityMode,
        formSelectedLocations
      );

      if (!availabilityRes.success) {
        setSaveError(availabilityRes.error?.message ?? "Failed to save location visibility settings.");
        return;
      }

      setIsDrawerOpen(false);
      await fetchData();
    } finally {
      setIsSaving(false);
    }
  };

  // ── Save a location pricing row ───────────────────────────────────────────────
  const handleAddPricing = async () => {
    if (!editing) return;
    setPricingError(null);
    if (!newPricingLocId) { setPricingError("Select a location."); return; }
    const price = parseFloat(newPricingPrice);
    if (isNaN(price) || price < 0) { setPricingError("Enter a valid sales price."); return; }
    setIsPricingSaving(true);
    try {
      const loc = locations.find(l => l.id === newPricingLocId);
      const res = await upsertFgLocationPricing({
        saleItemId:   editing.id,
        locationId:   newPricingLocId,
        locationName: loc?.name ?? null,
        salesPrice:   price,
        notes:        newPricingNotes.trim() || null,
      });
      if (!res.success) { setPricingError(res.error?.message ?? "Save failed."); return; }
      // Optimistically update the list
      setNewPricingLocId(""); setNewPricingPrice(""); setNewPricingNotes("");
      await loadPricing(editing.id);
    } finally {
      setIsPricingSaving(false);
    }
  };

  const handleDeletePricing = async (row: FgLocationPricing) => {
    if (!editing) return;
    const res = await deleteFgLocationPricing(row.id);
    if (!res.success) { alert(res.error?.message ?? "Delete failed."); return; }
    setLocationPricing(prev => prev.filter(r => r.id !== row.id));
  };

  // ── Toggle helpers ────────────────────────────────────────────────────────────
  const toggleActive = async (item: SaleItem) => {
    await upsertSaleItem({ ...item, isActive: !item.isActive });
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, isActive: !i.isActive } : i));
  };

  const toggleRequisitionable = async (item: SaleItem) => {
    await upsertSaleItem({ ...item, isRequisitionable: !item.isRequisitionable });
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, isRequisitionable: !i.isRequisitionable } : i));
  };

  // ── Filters ───────────────────────────────────────────────────────────────────
  // allCategories = DB-managed list (sort_order respected) UNION any legacy
  // category strings already on items but not yet in the categories table.
  // This keeps the filter backward-compatible with pre-migration data.
  const activeSellableLocations = locations.filter(l => {
    const id = (l.id ?? '').toLowerCase().trim();
    if (id === 'loc-hq' || id === 'hq') return false;
    
    const name = (l.name ?? '').toLowerCase().trim();
    if (name.includes('head office') || name.includes('central kitchen') || name === 'hq') return false;

    const type = (l.type ?? '').toLowerCase().trim();
    if (type === 'warehouse' || type === 'internal' || type === 'hq') return false;

    const subtype = (l.subtype ?? '').toLowerCase().trim();
    if (subtype === 'warehouse' || subtype === 'internal' || subtype === 'hq') return false;

    if (l.status) {
      const statusStr = String(l.status).toLowerCase().trim();
      if (statusStr !== 'active') return false;
    }

    return true;
  });

  const dropdownLocations = activeSellableLocations.filter(loc => {
    if (formAvailabilityMode === 'selected') {
      return formSelectedLocations.includes(loc.id);
    }
    return true;
  });

  const legacyCats = items.map(i => i.category).filter(Boolean) as string[];
  const allCategories = Array.from(
    new Set([...(dbCategories.length > 0 ? dbCategories : CATEGORY_OPTIONS), ...legacyCats])
  );


  const filtered = items.filter(i => {
    const matchSearch = !search
      || i.name.toLowerCase().includes(search.toLowerCase())
      || i.id.toLowerCase().includes(search.toLowerCase());
    const matchCat = filterCategory === "All" || i.category === filterCategory;
    const matchCom = filterCommissary === "All" || i.sourceCommissary === filterCommissary;
    return matchSearch && matchCat && matchCom;
  });

  // ── Stats ─────────────────────────────────────────────────────────────────────
  const totalActive          = items.filter(i => i.isActive).length;
  const totalRequisitionable = items.filter(i => i.isRequisitionable).length;
  const totalValue           = items.reduce((s, i) => s + i.instock * i.effectivePrice, 0);
  const outOfStock           = items.filter(i => i.stockStatus === "out_of_stock").length;

  if (isLoading) return (
    <div className="-m-6 flex min-h-[calc(100vh-4rem)] items-center justify-center gap-2 bg-slate-50 p-16 text-slate-400">
      <Loader2 className="h-5 w-5 animate-spin" /> Loading HQ Finished Goods...
    </div>
  );

  return (
    <div className="w-full space-y-6 text-slate-900">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="rounded-3xl border border-emerald-100 bg-gradient-to-br from-white via-emerald-50/70 to-slate-50 p-5 shadow-sm sm:p-7">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="max-w-3xl">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-emerald-700">STOCK DHARMA</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-5xl">HQ Finished Goods</h2>
            <p className="mt-3 text-base text-slate-600">
              Manage the catalog franchise locations requisition from, including pack pricing, recipe costs, stock, and availability.
            </p>
          </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            id="btn-import-sale-items"
            onClick={() => setIsImportOpen(true)}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
          >
            <Upload className="h-4 w-4" /> Import CSV
          </button>
          <button
            id="btn-create-sale-item"
            onClick={openCreate}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-800"
          >
            <Plus className="h-4 w-4" /> New Finished Good
          </button>
        </div>
        </div>
      </div>

      {/* ── HQ Purchased Setup Queue ───────────────────────────────── */}
      {setupQueue.length > 0 && (
        <div className="rounded-xl border border-blue-200 bg-white overflow-hidden shadow-sm">
          {/* Header */}
          <button
            className="w-full flex items-center justify-between px-5 py-3.5 bg-blue-50 hover:bg-blue-100 transition-colors border-b border-blue-200"
            onClick={() => setQueueExpanded(e => !e)}
          >
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-blue-600 p-1.5">
                <PackageCheck className="h-4 w-4 text-white" />
              </div>
              <div className="text-left">
                <p className="text-sm font-bold text-blue-900">
                  HQ Purchased Setup Required — {setupQueue.length} catalog item{setupQueue.length !== 1 ? "s" : ""} pending
                </p>
                <p className="text-xs text-blue-600 mt-0.5">
                  These outlet catalog items are supplied by approved HQ Fulfillment Centre suppliers
                  but are still routed as Local Vendor. Use &ldquo;Set Up as HQ Purchased&rdquo; to promote each one.
                </p>
              </div>
            </div>
            <ChevronRight className={`h-4 w-4 text-blue-400 transition-transform ${queueExpanded ? "rotate-90" : ""}`} />
          </button>

          {/* Queue table */}
          {queueExpanded && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-blue-50/60 border-b border-blue-100">
                  <tr>
                    {["Catalog Item", "Catalog ID", "Supplier", "Current Route", "Suggested HQ Sale Item", "Action"].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-blue-700 uppercase tracking-wider whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-50">
                  {setupQueue.map(row => (
                    <tr key={row.catalogItemId} className="hover:bg-blue-50/40 transition-colors">
                      {/* Catalog Item */}
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-900 text-sm leading-tight">{row.catalogName}</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          ${row.catalogPrice.toFixed(2)} &middot; {row.catalogUnit}
                          {row.catalogPackQty > 1 ? ` × ${row.catalogPackQty}` : ""}
                        </p>
                      </td>

                      {/* Catalog ID */}
                      <td className="px-4 py-3">
                        <code className="text-[10px] font-mono bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                          {row.catalogItemId}
                        </code>
                      </td>

                      {/* Supplier */}
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                          <CheckCircle2 className="h-3 w-3" />
                          {row.catalogSupplier}
                        </span>
                      </td>

                      {/* Current route */}
                      <td className="px-4 py-3">
                        <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full font-medium">
                          Local Vendor
                        </span>
                      </td>

                      {/* Suggested HQ Sale Item
                            Three states:
                            1. Confident suggestion (exact name match OR only one same-supplier candidate)
                            2. Multiple ambiguous candidates — never auto-picked, admin must choose in drawer
                            3. No candidates — admin must create an HQ Sale Item first */}
                      <td className="px-4 py-3">
                        {row.suggestedHqItem ? (
                          <div>
                            <p className="text-xs font-semibold text-slate-800 leading-tight">
                              {row.suggestedHqItem.name}
                            </p>
                            <p className="text-[10px] font-mono text-slate-400 mt-0.5">
                              {row.suggestedHqItem.id}
                            </p>
                          </div>
                        ) : row.multipleHqCandidates ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                            Multiple matches — select in drawer
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400 italic">No HQ Sale Item found — create one first</span>
                        )}
                      </td>

                      {/* Action */}
                      <td className="px-4 py-3">
                        <button
                          onClick={() => {
                            setSetupDrawerItem(row.suggestedHqItem);
                            setSetupDrawerCatalogId(row.catalogItemId);
                            setIsSetupDrawerOpen(true);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-bold bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shadow-sm whitespace-nowrap"
                        >
                          <PackageCheck className="h-3.5 w-3.5" />
                          Set Up as HQ Purchased
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-5 py-2.5 border-t border-blue-100 bg-blue-50/40 text-[11px] text-blue-600">
                🔒 Setup uses an atomic database transaction. Stock, recipes, and old requisitions are not affected.
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Metrics ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Total SKUs",       value: items.length,          icon: <Layers className="h-5 w-5" />,          color: "text-slate-950" },
          { label: "Active",           value: totalActive,           icon: <CheckCircle2 className="h-5 w-5" />,    color: "text-emerald-700" },
          { label: "Requisitionable",  value: totalRequisitionable,  icon: <PackageCheck className="h-5 w-5" />,    color: "text-emerald-700" },
          { label: "Out of Stock",     value: outOfStock,            icon: <AlertCircle className="h-5 w-5" />,     color: "text-rose-700" },
        ].map((s, i) => (
          <Card key={i} className="rounded-2xl border-slate-200 bg-white shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <span className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">{s.label}</span>
                  <span className={`mt-3 block text-2xl font-semibold ${s.color}`}>{s.value}</span>
                </div>
                <span className="rounded-xl bg-emerald-50 p-2 text-emerald-700">{s.icon}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Cost Audit ──────────────────────────────────────────────────── */}
      {items.some(i => !i.makingCost || i.makingCost <= 0) && (
        <FgCostAuditPanel
          items={items}
          recipes={recipes}
          suppliers={suppliers}
          allHqItems={items}
          onCostApplied={fetchData}
          onSetupHqPurchased={(item) => {
            setSetupDrawerItem(item);
            setSetupDrawerCatalogId(undefined);  // Cost Audit path has no pre-known catalog item
            setIsSetupDrawerOpen(true);
          }}
          onCreateRecipe={(itemName: string) => {
            const url = `/recipes?prefill=${encodeURIComponent(itemName)}`;
            window.location.href = url;
          }}
        />
      )}

      {/* ── HQ Purchased Setup Drawer ─────────────────────────────────────── */}
      <HqPurchasedSetupDrawer
        isOpen={isSetupDrawerOpen}
        onClose={() => { setIsSetupDrawerOpen(false); setSetupDrawerItem(null); setSetupDrawerCatalogId(undefined); }}
        hqItem={setupDrawerItem}
        allHqItems={items}
        suppliers={suppliers}
        initialCatalogItemId={setupDrawerCatalogId}
        onSuccess={() => {
          setIsSetupDrawerOpen(false);
          setSetupDrawerItem(null);
          setSetupDrawerCatalogId(undefined);
          fetchData();
        }}
      />


      {/* ── Stock value banner ───────────────────────────────────────────── */}
      <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-700 px-5 py-4 text-white shadow-sm">
        <DollarSign className="h-5 w-5 opacity-90" />
        <div>
          <p className="text-xs font-medium opacity-75 uppercase tracking-wider">HQ Finished Goods Stock Value</p>
          <p className="text-2xl font-bold">
            ${totalValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────── */}
      <Card className="overflow-hidden rounded-2xl border-slate-200 bg-white shadow-sm">
        <CardHeader className="flex flex-col gap-4 border-b border-slate-200 bg-white px-4 py-5 xl:flex-row xl:items-center">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-slate-950">Finished Goods Catalog</h3>
            <p className="mt-1 text-sm text-slate-500">Review pack quantities, live recipe costs, location visibility, and requisition availability.</p>
          </div>
          <div className="relative w-full xl:ml-auto xl:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search finished goods…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="min-h-11 w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-4 text-sm outline-none ring-emerald-600 transition focus:ring-2"
            />
          </div>
          {/* Category filter — always visible; options come from DB (or CATEGORY_OPTIONS fallback) */}
          <select
            value={filterCategory}
            onChange={e => setFilterCategory(e.target.value)}
            className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none ring-emerald-600 transition focus:ring-2"
          >
            <option value="All">All categories</option>
            {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {/* Commissary filter */}
          <select
            value={filterCommissary}
            onChange={e => setFilterCommissary(e.target.value)}
            className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none ring-emerald-600 transition focus:ring-2"
          >
            <option value="All">All commissaries</option>
            {COMMISSARY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader className="bg-slate-50 text-xs uppercase tracking-[0.14em] text-slate-500">
              <TableRow>
                <TableHead className="py-4 px-6">Item / SKU</TableHead>
                <TableHead className="py-3">Category</TableHead>
                <TableHead className="py-3">Commissary</TableHead>
                <TableHead className="py-3">Unit</TableHead>
                <TableHead className="py-3">Making Cost</TableHead>
                <TableHead className="py-3">Unit Sale Price</TableHead>
                <TableHead className="py-3">Pack Qty</TableHead>
                <TableHead className="py-3">Effective Pack Price</TableHead>
                <TableHead className="py-3">Current On Hand</TableHead>
                <TableHead className="py-3">Produced Today</TableHead>
                <TableHead className="py-3">Supplied Today</TableHead>
                <TableHead className="py-3">Latest Variance</TableHead>
                <TableHead className="py-3">Status</TableHead>
                <TableHead className="py-3">Visibility</TableHead>
                <TableHead className="py-3 text-right px-6">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length > 0 ? filtered.map(item => {
                // DEBUG: verify sourceCommissary coming from DB — remove once confirmed correct
                console.log('[FG Row]', item.id, item.sourceCommissary);
                const linkedRecipe = recipes.find(r => r.id === item.sourceRecipeId);
                return (
                  <TableRow key={item.id} className="border-slate-100 transition-colors hover:bg-emerald-50/30">
                    <TableCell className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                          <Factory className="h-4 w-4" />
                        </span>
                        <div>
                          <p className="text-sm font-semibold text-slate-950">{item.name}</p>
                          <p className="flex items-center gap-1 text-xs text-slate-400">
                            {item.id}
                            {linkedRecipe && (
                              <><ChevronRight className="h-3 w-3" /> <span className="text-emerald-700">{linkedRecipe.name}</span></>
                            )}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-4">
                      {item.category ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-neutral-100 text-neutral-700 border border-neutral-200">
                          <Tag className="h-3 w-3" />{item.category}
                        </span>
                      ) : (
                        <span className="text-neutral-300 text-xs">—</span>
                      )}
                    </TableCell>
                    {/* Commissary badge */}
                    <TableCell className="py-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${COMMISSARY_COLORS[item.sourceCommissary] ?? "bg-neutral-50 text-neutral-600 border-neutral-200"}`}>
                        {item.sourceCommissary}
                      </span>
                    </TableCell>
                    <TableCell className="py-4 text-sm text-neutral-700">{item.baseUnit}</TableCell>
                    {/* Making Cost — always recomputed from linked recipe with unit conversion */}
                    <TableCell className="py-4 text-sm text-neutral-600">
                      {(() => {
                        const lc = computeLiveCost(item, recipes);
                        if (lc.conversionWarning) return (
                          <span className="inline-flex items-center gap-1 text-warning-700 text-xs font-medium" title={lc.conversionWarning}>
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" /> Unit mismatch
                          </span>
                        );
                        return lc.makingCost > 0
                          ? <><span className="font-semibold text-slate-900">${lc.makingCost.toFixed(4)}</span><span className="text-slate-400">/{item.baseUnit}</span></>
                          : <span className="text-neutral-300">—</span>;
                      })()}
                    </TableCell>
                    {/* Unit Sale Price — recomputed, respects manual price override */}
                    <TableCell className="py-4">
                      {(() => {
                        const lc = computeLiveCost(item, recipes);
                        if (lc.conversionWarning) return (
                          <span className="text-neutral-400 text-xs">—</span>
                        );
                        return (
                          <span className="font-bold text-emerald-700 text-sm">
                            ${lc.effectivePrice.toFixed(4)}
                            <span className="text-neutral-400 font-normal">/{item.baseUnit}</span>
                          </span>
                        );
                      })()}
                    </TableCell>
                    {/* Pack Qty */}
                    <TableCell className="py-4 text-sm text-neutral-700">
                      {item.packQty > 1 ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                          {item.packQty} {item.baseUnit}
                        </span>
                      ) : (
                        <span className="text-neutral-400 text-xs">1 (unit)</span>
                      )}
                    </TableCell>
                    {/* Effective Pack Price = effectivePrice × packQty (recomputed) */}
                    <TableCell className="py-4">
                      {(() => {
                        const packQty = item.packQty > 0 ? item.packQty : 1;
                        const lc = computeLiveCost(item, recipes);
                        if (lc.conversionWarning || packQty <= 1) {
                          return <span className="text-neutral-400 text-xs">{packQty > 1 ? '—' : 'same as unit'}</span>;
                        }
                        const packPrice = lc.effectivePrice * packQty;
                        return (
                          <span className="font-bold text-emerald-700 text-sm">
                            ${packPrice.toFixed(2)}
                            <span className="text-neutral-400 font-normal">/pack</span>
                          </span>
                        );
                      })()}
                    </TableCell>
                    {/* Current On Hand */}
                    <TableCell className="py-4">
                      <div className="flex flex-col gap-1">
                        <span className="font-semibold text-slate-900 text-sm">
                          {item.instock} {item.baseUnit}
                        </span>
                        <StockChip status={item.stockStatus} />
                      </div>
                    </TableCell>
                    {/* Produced Today */}
                    <TableCell className="py-4 text-sm text-neutral-700">
                      {(todayMetrics[item.id]?.producedToday ?? 0) > 0 ? (
                        <span className="font-medium text-slate-900">
                          {fmt(todayMetrics[item.id].producedToday)} {item.baseUnit}
                        </span>
                      ) : (
                        <span className="text-neutral-400 text-xs">—</span>
                      )}
                    </TableCell>
                    {/* Supplied Today */}
                    <TableCell className="py-4 text-sm text-neutral-700">
                      {(todayMetrics[item.id]?.suppliedToday ?? 0) > 0 ? (
                        <span className="font-medium text-slate-900">
                          {fmt(todayMetrics[item.id].suppliedToday)} {item.baseUnit}
                        </span>
                      ) : (
                        <span className="text-neutral-400 text-xs">—</span>
                      )}
                    </TableCell>
                    {/* Latest Variance */}
                    <TableCell className="py-4 text-sm">
                      {(() => {
                        const detail = latestCounts[item.id];
                        if (!detail || detail.lastCountDate === null) {
                          return <span className="text-neutral-400 text-xs">No counts</span>;
                        }
                        const v = detail.latestVariance;
                        if (v === 0) {
                          return (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-500 border border-slate-200">
                              <Minus className="h-3 w-3" /> No change
                            </span>
                          );
                        }
                        if (v > 0) {
                          return (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <TrendingUp className="h-3 w-3" /> +{fmt(v)} {item.baseUnit}
                            </span>
                          );
                        }
                        return (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200">
                            <TrendingDown className="h-3 w-3" /> {fmt(v)} {item.baseUnit}
                          </span>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="py-4">
                      <div className="flex flex-col gap-1">
                        <ActiveChip active={item.isActive} />
                        {item.isRequisitionable
                          ? <span className="text-xs text-success-600 font-medium">Requisitionable</span>
                          : <span className="text-xs text-neutral-400">Hidden from locations</span>}
                      </div>
                    </TableCell>
                    <TableCell className="py-4">
                      {(() => {
                        const mode = item.locationAvailabilityMode ?? 'all';
                        if (mode === 'all') {
                          return (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                              All Locations
                            </span>
                          );
                        } else if (mode === 'selected') {
                          return (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                              Selected Locations
                            </span>
                          );
                        } else {
                          return (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-neutral-100 text-neutral-600 border border-neutral-300">
                              HQ Only
                            </span>
                          );
                        }
                      })()}
                    </TableCell>
                    <TableCell className="py-4 px-6 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => toggleActive(item)}
                          title={item.isActive ? "Deactivate" : "Activate"}
                          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
                        >
                          {item.isActive ? <ToggleRight className="h-4 w-4 text-emerald-700" /> : <ToggleLeft className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={() => openEdit(item)}
                          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              }) : (
                <TableRow>
                  <TableCell colSpan={15} className="text-center py-12 text-neutral-400 text-sm">
                    {search || filterCategory !== "All" || filterCommissary !== "All"
                      ? "No finished goods match your filters."
                      : "No finished goods yet. Create your first one to make it available for franchise locations to requisition."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── Create / Edit Drawer ─────────────────────────────────────────────── */}
      <Drawer
        isOpen={isDrawerOpen}
        onClose={() => { setIsDrawerOpen(false); setSaveError(null); }}
        title={editing ? `Edit: ${editing.name}` : "New Finished Good"}
        description={(() => {
          if (!editing) return "Create a new HQ finished good that franchise locations can requisition.";
          const lc = computeLiveCost(editing, recipes);
          if (lc.conversionWarning) return `SKU: ${editing.id} · ⚠ Unit mismatch — re-save to fix cost`;
          return `SKU: ${editing.id} · Making cost: $${lc.makingCost.toFixed(4)}/${editing.baseUnit}`;
        })()}
        footer={
          <div className="w-full flex flex-col gap-3">
            {saveError && (
              <div className="flex items-center gap-2 bg-danger-50 border border-danger-200 rounded-lg px-3 py-2 text-sm text-danger-700">
                <AlertCircle className="h-4 w-4 shrink-0" />{saveError}
              </div>
            )}

            {/* Pricing preview */}
            {(() => {
              const linked = recipes.find(r => r.id === formRecipeId);
              const manual = formManualPrice !== "" && !isNaN(parseFloat(formManualPrice))
                ? parseFloat(formManualPrice) : null;

              let makingCost: number | null = null;
              let conversionWarning: string | null = null;

              if (linked) {
                // Convert recipe yield into FG base unit before computing cost
                const conv = convertYieldToBaseUnit(
                  linked.yieldQty || 0,
                  linked.yieldUnit || '',
                  formUnit,
                );
                if (conv === null || conv.qty <= 0) {
                  conversionWarning =
                    `Cannot convert recipe yield unit "${linked.yieldUnit}" to "${formUnit}". ` +
                    `Units must be in the same measurement family.`;
                } else {
                  makingCost = (linked.theoreticalCost || 0) / conv.qty;
                }
              } else if (editing) {
                makingCost = editing.makingCost;
              }

              if (conversionWarning) return (
                <div className="flex items-center gap-2 bg-warning-50 border border-warning-200 rounded-lg px-4 py-3 text-xs text-warning-800">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {conversionWarning}
                </div>
              );

              if (makingCost != null && (makingCost > 0 || manual != null)) {
                const suggested = (makingCost ?? 0) * 1.20;
                const effective = manual ?? suggested;
                return (
                  <div className="flex items-center justify-between bg-brand-50 border border-brand-100 rounded-lg px-4 py-3">
                    <div className="flex flex-col gap-0.5 text-xs text-brand-700">
                      <span>Making cost: <strong>${(makingCost ?? 0).toFixed(4)}/{formUnit}</strong></span>
                      <span>Suggested (×1.20): <strong>${suggested.toFixed(4)}/{formUnit}</strong></span>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-brand-600 font-medium">Effective price</p>
                      <p className="text-lg font-bold text-brand-900">${effective.toFixed(4)}</p>
                    </div>
                  </div>
                );
              }
              return null;
            })()}

            <div className="flex items-center justify-end gap-3 border-t border-neutral-200 pt-4">
              <button
                onClick={() => { setIsDrawerOpen(false); setSaveError(null); }}
                className="px-4 py-2 text-sm font-medium border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors"
              >
                Cancel
              </button>
              <button
                id="btn-save-sale-item"
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-2 px-5 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {isSaving ? "Saving…" : "Save Finished Good"}
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-5">
          {/* Name */}
          <div>
            <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">
              Name <span className="text-danger-500">*</span>
            </label>
            <input
              type="text"
              value={formName}
              onChange={e => setFormName(e.target.value)}
              placeholder="e.g. Agni Sauce 500ml"
              className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 bg-neutral-50"
            />
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">
              Category <span className="text-neutral-400 font-normal">(optional)</span>
            </label>
            {/* DB-driven select — falls back to CATEGORY_OPTIONS pre-migration */}
            <select
              value={formCategory}
              onChange={e => setFormCategory(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="">— Uncategorized —</option>
              {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>

            {/* ── Inline "+ Add Category" ──────────────────────────────────── */}
            {!isAddingCat ? (
              <button
                type="button"
                onClick={() => { setAddCatInput(""); setAddCatError(null); setIsAddingCat(true); }}
                className="mt-2 flex items-center gap-1 text-xs text-brand-600 hover:text-brand-800 font-medium transition-colors"
              >
                <PlusCircle className="h-3.5 w-3.5" /> Add new category
              </button>
            ) : (
              <div className="mt-2 flex items-start gap-2">
                <input
                  type="text"
                  placeholder="New category name…"
                  value={addCatInput}
                  onChange={e => { setAddCatInput(e.target.value); setAddCatError(null); }}
                  onKeyDown={async e => {
                    if (e.key === "Enter") { e.preventDefault(); await handleAddCategory(); }
                    if (e.key === "Escape") setIsAddingCat(false);
                  }}
                  autoFocus
                  className="flex-1 px-3 py-1.5 text-sm border border-brand-300 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <button
                  type="button"
                  disabled={!addCatInput.trim() || isAddingCat === null}
                  onClick={handleAddCategory}
                  className="px-3 py-1.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => setIsAddingCat(false)}
                  className="px-2 py-1.5 text-xs text-neutral-500 hover:text-neutral-800 transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
            {addCatError && <p className="mt-1 text-xs text-danger-600">{addCatError}</p>}
          </div>

          {/* Source Commissary */}
          <div>
            <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">
              Source Commissary
            </label>
            <select
              value={formCommissary}
              onChange={e => setFormCommissary(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              {COMMISSARY_OPTIONS.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <p className="text-xs text-neutral-400 mt-1">Determines which commissary kitchen produces and ships this finished good.</p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">
              Description
            </label>
            <textarea
              rows={2}
              value={formDesc}
              onChange={e => setFormDesc(e.target.value)}
              placeholder="Optional description shown to HQ…"
              className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 bg-neutral-50 resize-none"
            />
          </div>

          {/* Unit + Par Level + Pack Qty */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">Base Unit</label>
              <select
                value={formUnit}
                onChange={e => setFormUnit(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {["ea","kg","g","lb","oz","l","ml","fl oz","pcs","btl","box","case","pack"].map(u => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">Low Stock Threshold</label>
              <input
                type="number"
                min={0}
                value={formParLevel}
                onChange={e => setFormParLevel(Math.max(0, Number(e.target.value)))}
                className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">
                Pack Qty
                <span className="ml-1 text-neutral-400 font-normal normal-case">({formUnit}s / pack)</span>
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={formPackQty}
                onChange={e => setFormPackQty(Math.max(1, Number(e.target.value) || 1))}
                className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          </div>

          {/* Pack price preview */}
          {formPackQty > 1 && (() => {
            const linked = recipes.find(r => r.id === formRecipeId);
            const manualP = formManualPrice !== "" && !isNaN(parseFloat(formManualPrice)) ? parseFloat(formManualPrice) : null;

            let makingCost: number | null = null;
            if (linked) {
              const conv = convertYieldToBaseUnit(
                linked.yieldQty || 0,
                linked.yieldUnit || '',
                formUnit,
              );
              if (conv !== null && conv.qty > 0) {
                makingCost = (linked.theoreticalCost || 0) / conv.qty;
              }
            } else if (editing) {
              makingCost = editing.makingCost;
            }

            const unitPrice = manualP ?? (makingCost != null ? makingCost * 1.20 : null);
            if (unitPrice == null || unitPrice <= 0) return null;

            const packCostPerUnit = makingCost ?? 0;
            const packCost       = packCostPerUnit * formPackQty;
            const packPrice      = unitPrice * formPackQty;

            return (
              <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-2.5 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-blue-700">
                    Cost: <strong>${packCostPerUnit.toFixed(4)}</strong>/{formUnit} × <strong>{formPackQty}</strong> {formUnit}s
                    {" = "}<strong>${packCost.toFixed(2)}</strong> cost/pack
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-blue-700">
                    Price: <strong>${unitPrice.toFixed(4)}</strong>/{formUnit} × <strong>{formPackQty}</strong> {formUnit}s
                  </span>
                  <span className="font-bold text-blue-900 text-sm">
                    = ${packPrice.toFixed(2)} / pack
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Linked recipe */}
          <div>
            <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">
              Source Recipe <span className="text-neutral-400 font-normal">(links making cost automatically)</span>
            </label>
            <select
              value={formRecipeId}
              onChange={e => setFormRecipeId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="">— No linked recipe —</option>
              {recipes.map(r => (
                <option key={r.id} value={r.id}>
                  {r.name} (yield {r.yieldQty} {r.yieldUnit}, cost ${(r.theoreticalCost || 0).toFixed(2)})
                </option>
              ))}
            </select>
          </div>

          {/* Manual price / supplier price — label changes based on whether a recipe is linked */}
          <div>
            {formRecipeId ? (
              /* Recipe-linked item: manual_price overrides the auto-suggested price */
              <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">
                Manual Price Override
                <span className="ml-1 text-neutral-400 font-normal normal-case">
                  per {formUnit} (overrides recipe-suggested price; leave blank to use suggested)
                </span>
              </label>
            ) : (
              /* Purchased / no-recipe item: manual_price IS the supplier cost & location charge */
              <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">
                <span className="text-blue-700">HQ Purchased Item — Supplier Price</span>
                <span className="ml-1 text-neutral-400 font-normal normal-case">
                  per {formUnit} charged to locations
                </span>
              </label>
            )}
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 text-sm">$</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={formManualPrice}
                onChange={e => setFormManualPrice(e.target.value)}
                placeholder={formRecipeId ? "Auto (suggested × 1.20)" : "Enter supplier price per " + formUnit}
                className="w-full pl-7 pr-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            {!formRecipeId && formManualPrice !== "" && !isNaN(parseFloat(formManualPrice)) && (
              <p className="mt-1 text-[11px] text-blue-600">
                This is the price HQ charges locations per {formUnit}.
                {formPackQty > 1 ? ` Pack price = $${(parseFloat(formManualPrice) * formPackQty).toFixed(2)} (${formPackQty} ${formUnit}s × $${parseFloat(formManualPrice).toFixed(4)}).` : ""}
                {" "}No recipe markup is applied.
              </p>
            )}
          </div>

          {/* Toggles */}
          <div className="flex flex-col gap-3 pt-1">
            <label className="flex items-center justify-between p-3 bg-neutral-50 border border-neutral-200 rounded-lg cursor-pointer hover:bg-neutral-100 transition-colors">
              <div>
                <p className="text-sm font-medium text-neutral-800">Active</p>
                <p className="text-xs text-neutral-500">Inactive items are hidden from all views</p>
              </div>
              <div
                onClick={() => setFormActive(p => !p)}
                className={`relative w-10 h-5 rounded-full transition-colors ${formActive ? "bg-brand-500" : "bg-neutral-300"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${formActive ? "translate-x-5" : ""}`} />
              </div>
            </label>

            <label className="flex items-center justify-between p-3 bg-neutral-50 border border-neutral-200 rounded-lg cursor-pointer hover:bg-neutral-100 transition-colors">
              <div>
                <p className="text-sm font-medium text-neutral-800">Requisitionable</p>
                <p className="text-xs text-neutral-500">Appears in franchise location requisition picker</p>
              </div>
              <div
                onClick={() => setFormRequisitionable(p => !p)}
                className={`relative w-10 h-5 rounded-full transition-colors ${formRequisitionable ? "bg-success-500" : "bg-neutral-300"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${formRequisitionable ? "translate-x-5" : ""}`} />
              </div>
            </label>

            {/* Outlet Availability Override */}
            <div className="space-y-1.5 p-3 bg-violet-50 border border-violet-200 rounded-lg">
              <label className="text-xs font-semibold text-violet-800 uppercase tracking-wider flex items-center gap-1.5">
                <MapPin className="h-3 w-3" /> Outlet Availability Override
              </label>
              <select
                value={formAvailabilityOverride ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setFormAvailabilityOverride(v === "" ? null : v as SaleItem['availabilityOverride']);
                }}
                className="w-full px-3 py-2 text-sm border border-violet-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-violet-500"
              >
                <option value="">Auto-calculate (based on HQ stock)</option>
                <option value="available">🟢 Available</option>
                <option value="low_stock">🟡 Low Stock</option>
                <option value="out_of_stock">🔴 Out of Stock</option>
                <option value="not_available">⚫ Not Available</option>
              </select>
              <p className="text-[11px] text-violet-600">
                Controls the availability badge shown to outlet users. When set, overrides auto-calculated status. Outlets never see exact HQ stock quantities.
              </p>
            </div>

            {/* Location Visibility Assignment */}
            <div className="space-y-3 p-3 bg-neutral-50 border border-neutral-200 rounded-lg">
              <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-neutral-500" /> Location Visibility
              </label>
              <select
                value={formAvailabilityMode}
                onChange={(e) => {
                  const mode = e.target.value as 'all' | 'selected' | 'hq_only';
                  setFormAvailabilityMode(mode);
                }}
                className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="all">Available to all locations</option>
                <option value="selected">Available to selected locations only</option>
                <option value="hq_only">HQ only / not visible to locations</option>
              </select>

              {formAvailabilityMode === 'selected' && (
                <div className="space-y-2 pt-2 border-t border-neutral-200">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-semibold text-neutral-500">Select Locations:</span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setFormSelectedLocations(activeSellableLocations.map(l => l.id))}
                        className="text-[10px] text-brand-600 hover:underline font-semibold"
                      >
                        Select All
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormSelectedLocations([])}
                        className="text-[10px] text-neutral-500 hover:underline font-semibold"
                      >
                        Clear All
                      </button>
                    </div>
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1.5 border border-neutral-200 rounded-md p-2 bg-white">
                    {activeSellableLocations.map(loc => (
                      <label key={loc.id} className="flex items-center gap-2 text-xs text-neutral-700 cursor-pointer hover:bg-neutral-50 p-1 rounded">
                        <input
                          type="checkbox"
                          checked={formSelectedLocations.includes(loc.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setFormSelectedLocations(prev => [...prev, loc.id]);
                            } else {
                              setFormSelectedLocations(prev => prev.filter(id => id !== loc.id));
                            }
                          }}
                          className="rounded border-neutral-300 text-brand-600 focus:ring-brand-500 h-3.5 w-3.5"
                        />
                        <span>{loc.name} <span className="text-neutral-400 font-mono">({loc.id})</span></span>
                      </label>
                    ))}
                    {activeSellableLocations.length === 0 && (
                      <p className="text-xs text-neutral-400 text-center py-2">No active branch/sellable locations found.</p>
                    )}
                  </div>
                </div>
              )}
              <p className="text-[11px] text-neutral-400 font-medium">
                {formAvailabilityMode === 'all' && "This finished good is visible to all active franchise locations."}
                {formAvailabilityMode === 'selected' && "This finished good is only visible to the checked locations."}
                {formAvailabilityMode === 'hq_only' && "This finished good is hidden from all franchise locations (HQ only)."}
              </p>
            </div>
          </div>

          {/* Pricing info box for existing items — always recomputed from linked recipe */}
          {editing && (() => {
            const lc = computeLiveCost(editing, recipes);
            return (
              <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-4 space-y-2 text-sm">
                <p className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-2">Current Pricing</p>

                {lc.conversionWarning ? (
                  <div className="flex items-start gap-2 text-xs text-warning-700 bg-warning-50 border border-warning-200 rounded-lg p-2">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{lc.conversionWarning}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Making cost</span>
                      <span className="font-medium">${lc.makingCost.toFixed(4)}/{editing.baseUnit}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Suggested (×1.20)</span>
                      <span className="font-medium">${lc.suggestedPrice.toFixed(4)}/{editing.baseUnit}</span>
                    </div>
                    {editing.packQty > 1 && (
                      <div className="flex justify-between text-xs text-neutral-500">
                        <span>Pack cost ({editing.packQty} {editing.baseUnit})</span>
                        <span>${(lc.makingCost * editing.packQty).toFixed(2)}/pack</span>
                      </div>
                    )}
                    <div className="flex justify-between border-t border-neutral-200 pt-2">
                      <span className="font-semibold text-neutral-700">Effective price</span>
                      <span className="font-bold text-success-700">${lc.effectivePrice.toFixed(4)}/{editing.baseUnit}</span>
                    </div>
                    {editing.packQty > 1 && (
                      <div className="flex justify-between">
                        <span className="font-semibold text-neutral-700">Pack price ({editing.packQty} {editing.baseUnit})</span>
                        <span className="font-bold text-brand-700">${(lc.effectivePrice * editing.packQty).toFixed(2)}/pack</span>
                      </div>
                    )}
                    {editing.manualPrice != null && (
                      <p className="text-xs text-neutral-400">Manual price override active — suggested price ignored.</p>
                    )}
                  </>
                )}

                {editing.makingCostUpdatedAt && (
                  <p className="text-xs text-neutral-400">
                    Cost last synced: {new Date(editing.makingCostUpdatedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
            );
          })()}

          {/* ── Location Pricing Section ───────────────────────────────────────── */}
          {editing && (
            <div className="border-t border-neutral-200 pt-5">
              <div className="flex items-center gap-2 mb-4">
                <MapPin className="h-4 w-4 text-brand-500" />
                <h4 className="text-sm font-bold text-neutral-800 uppercase tracking-wider">Location Sales Prices</h4>
                <span className="text-xs text-neutral-400">(food cost % = making cost ÷ sales price)</span>
              </div>

              {isPricingLoading ? (
                <div className="flex items-center gap-2 text-neutral-400 text-sm py-4">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading location prices…
                </div>
              ) : (
                <>
                  {/* Existing pricing rows */}
                  {locationPricing.length > 0 ? (
                    <div className="rounded-lg border border-neutral-200 overflow-hidden mb-4">
                      <table className="w-full text-sm">
                        <thead className="bg-neutral-50 text-xs text-neutral-500 uppercase tracking-wider">
                          <tr>
                            <th className="px-3 py-2 text-left">Location</th>
                            <th className="px-3 py-2 text-right">Sales Price</th>
                            <th className="px-3 py-2 text-right">Making Cost</th>
                            <th className="px-3 py-2 text-right">Food Cost %</th>
                            <th className="px-3 py-2" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-100">
                          {locationPricing.map(row => {
                            const lc  = computeLiveCost(editing, recipes);
                            const pct = lc.conversionWarning ? '—' : foodCostPct(lc.makingCost, row.salesPrice);
                            return (
                              <tr key={row.id} className="hover:bg-neutral-50/50">
                                <td className="px-3 py-2.5 font-medium text-neutral-800">
                                  {row.locationName || row.locationId}
                                </td>
                                <td className="px-3 py-2.5 text-right font-semibold text-success-700">
                                  ${row.salesPrice.toFixed(2)}
                                </td>
                                <td className="px-3 py-2.5 text-right text-neutral-500">
                                  {lc.conversionWarning
                                    ? <span className="text-warning-600 text-xs">⚠ mismatch</span>
                                    : `$${lc.makingCost.toFixed(4)}`
                                  }
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  <FoodCostBadge pct={pct} />
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  <button
                                    onClick={() => handleDeletePricing(row)}
                                    className="p-1 rounded text-neutral-300 hover:text-danger-600 hover:bg-danger-50 transition-colors"
                                    title="Remove"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-center py-6 bg-neutral-50 border border-neutral-200 border-dashed rounded-lg mb-4">
                      <MapPin className="h-6 w-6 text-neutral-300 mx-auto mb-2" />
                      <p className="text-xs text-neutral-400">No location prices set yet.</p>
                    </div>
                  )}

                  {/* Add pricing row form */}
                  {formAvailabilityMode === 'hq_only' ? (
                    <div className="bg-neutral-50 border border-neutral-200 border-dashed rounded-lg p-4 text-center">
                      <p className="text-xs text-neutral-400">Location pricing is not applicable for HQ-only items.</p>
                    </div>
                  ) : (
                    <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3 space-y-3">
                      <p className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Add / Update Location Price</p>
                      {pricingError && (
                        <div className="flex items-center gap-2 bg-danger-50 border border-danger-200 rounded px-2 py-1 text-xs text-danger-700">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" />{pricingError}
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Location</label>
                          <select
                            value={newPricingLocId}
                            onChange={e => setNewPricingLocId(e.target.value)}
                            className="w-full mt-1 px-2 py-1.5 text-sm border border-neutral-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                          >
                            <option value="">— Select —</option>
                            {dropdownLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                          </select>
                        </div>
                      <div>
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Sales Price</label>
                        <div className="relative mt-1">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400 text-xs">$</span>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={newPricingPrice}
                            onChange={e => setNewPricingPrice(e.target.value)}
                            placeholder="0.00"
                            className="w-full pl-5 pr-2 py-1.5 text-sm border border-neutral-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                          />
                        </div>
                      </div>
                    </div>
                    {/* Live food cost preview */}
                    {newPricingPrice && !isNaN(parseFloat(newPricingPrice)) && parseFloat(newPricingPrice) > 0 && (() => {
                      const lc    = computeLiveCost(editing, recipes);
                      const price = parseFloat(newPricingPrice);
                      if (lc.conversionWarning) return (
                        <div className="flex items-center gap-2 text-xs text-warning-700 bg-warning-50 border border-warning-100 rounded px-2 py-1.5">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                          Cannot compute food cost % — unit mismatch on making cost.
                        </div>
                      );
                      return (
                        <div className="flex items-center gap-2 text-xs text-neutral-600 bg-white border border-neutral-200 rounded px-2 py-1.5">
                          <TrendingUp className="h-3.5 w-3.5 text-brand-500" />
                          Food cost at this price: <strong className="ml-1">{foodCostPct(lc.makingCost, price)}</strong>
                          <span className="text-neutral-400 ml-1">(${lc.makingCost.toFixed(4)} ÷ ${price.toFixed(2)} × 100)</span>
                        </div>
                      );
                    })()}
                    <input
                      type="text"
                      value={newPricingNotes}
                      onChange={e => setNewPricingNotes(e.target.value)}
                      placeholder="Notes (optional)"
                      className="w-full px-2 py-1.5 text-sm border border-neutral-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                    <button
                      onClick={handleAddPricing}
                      disabled={isPricingSaving}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-brand-600 text-white rounded-md hover:bg-brand-700 transition-colors disabled:opacity-50"
                    >
                      {isPricingSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlusCircle className="h-3.5 w-3.5" />}
                      {isPricingSaving ? "Saving…" : "Save Location Price"}
                    </button>
                  </div>
                )}
                </>
              )}
            </div>
          )}
        </div>
      </Drawer>

      {/* ── CSV Import Modal ────────────────────────────────────────── */}
      <FgImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        existingNames={items.map(i => i.name)}
        onSuccess={fetchData}
      />
    </div>
  );
}

export default function HQSaleItemsPage() {
  return (
    <HQOnlyGuard>
      <HQSaleItemsContent />
    </HQOnlyGuard>
  );
}
