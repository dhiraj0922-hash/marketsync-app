"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Drawer } from "@/components/ui/drawer";
import {
  PackageCheck, Search, Plus, Edit2, ToggleLeft, ToggleRight,
  TrendingUp, AlertCircle, Loader2, ChevronRight, DollarSign, Factory,
  CheckCircle2, XCircle, Layers, MapPin, Trash2, PlusCircle, Tag, Upload
} from "lucide-react";
import {
  loadSaleItems, upsertSaleItem, loadRecipes, loadLocations,
  loadFgLocationPricing, upsertFgLocationPricing, deleteFgLocationPricing,
  loadCategories, addCategory,
  type SaleItem, type FgLocationPricing
} from "@/lib/storage";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { FgImportModal } from "@/components/FgImportModal";
import { FgCostAuditPanel } from "@/components/FgCostAuditPanel";


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

// ═══════════════════════════════════════════════════════════════════════════════
// HQ SALE ITEMS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function HQSaleItemsContent() {
  const [items, setItems]       = useState<SaleItem[]>([]);
  const [recipes, setRecipes]   = useState<any[]>([]);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch]     = useState("");
  const [filterCategory, setFilterCategory] = useState("All");
  const [filterCommissary, setFilterCommissary] = useState("All");

  // DB-driven category list (loaded from categories table)
  const [dbCategories, setDbCategories] = useState<string[]>([]);
  // Inline "+ Add Category" form in drawer
  const [addCatInput, setAddCatInput]   = useState("");
  const [isAddingCat, setIsAddingCat]   = useState(false);
  const [addCatError, setAddCatError]   = useState<string | null>(null);

  // Import modal state
  const [isImportOpen, setIsImportOpen] = useState(false);

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
  const [formActive, setFormActive]           = useState(true);
  const [formRequisitionable, setFormRequisitionable] = useState(true);

  // ── Load data ────────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [si, rec, locs, cats] = await Promise.all([
        loadSaleItems(), loadRecipes(), loadLocations(),
        loadCategories('finished_goods'),
      ]);
      setItems(Array.isArray(si) ? si : []);
      setRecipes(Array.isArray(rec) ? rec : []);
      setLocations(
        Array.isArray(locs)
          ? locs.filter((l: any) => !l.status || l.status === "active").map((l: any) => ({ id: l.id, name: l.name }))
          : []
      );
      // DB categories — if empty (pre-migration), UI falls back to CATEGORY_OPTIONS
      setDbCategories(Array.isArray(cats) ? cats : []);
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
    setFormParLevel(0); setFormManualPrice(""); setFormRecipeId("");
    setFormActive(true); setFormRequisitionable(true);
    setLocationPricing([]);
    setNewPricingLocId(""); setNewPricingPrice(""); setNewPricingNotes("");
    setSaveError(null); setPricingError(null);
    setIsDrawerOpen(true);
  };

  const openEdit = (item: SaleItem) => {
    setEditing(item);
    setFormName(item.name);
    setFormCategory(item.category ?? "");
    setFormCommissary(item.sourceCommissary ?? "Commissary HQ");
    setFormDesc(item.description ?? "");
    setFormUnit(item.baseUnit);
    setFormParLevel(item.parLevel);
    setFormManualPrice(item.manualPrice != null ? String(item.manualPrice) : "");
    setFormRecipeId(item.sourceRecipeId ?? "");
    setFormActive(item.isActive);
    setFormRequisitionable(item.isRequisitionable);
    setNewPricingLocId(""); setNewPricingPrice(""); setNewPricingNotes("");
    setSaveError(null); setPricingError(null);
    loadPricing(item.id);
    setIsDrawerOpen(true);
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
        sourceYieldQty = linkedRecipe.yieldQty || 1;
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
        instock:              editing?.instock ?? 0,
        suggestedPrice:       0,
        effectivePrice:       0,
        stockStatus:          'in_stock',
        makingCostUpdatedAt:  null,
        createdAt:            null,
        updatedAt:            null,
      });

      if (!res.success) {
        setSaveError(res.error?.message ?? "Save failed.");
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
    <div className="flex items-center justify-center p-16 text-neutral-400 gap-2">
      <Loader2 className="h-5 w-5 animate-spin" /> Loading HQ Finished Goods...
    </div>
  );

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">HQ Finished Goods</h2>
          <p className="text-neutral-500 text-sm mt-0.5">
            Manage the catalog that franchise locations requisition from.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            id="btn-import-sale-items"
            onClick={() => setIsImportOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 shadow-sm transition-colors"
          >
            <Upload className="h-4 w-4" /> Import CSV
          </button>
          <button
            id="btn-create-sale-item"
            onClick={openCreate}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm transition-colors"
          >
            <Plus className="h-4 w-4" /> New Finished Good
          </button>
        </div>
      </div>

      {/* ── Metrics ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total SKUs",       value: items.length,          icon: <Layers className="h-4 w-4" />,          color: "text-neutral-800" },
          { label: "Active",           value: totalActive,           icon: <CheckCircle2 className="h-4 w-4" />,    color: "text-brand-600" },
          { label: "Requisitionable",  value: totalRequisitionable,  icon: <PackageCheck className="h-4 w-4" />,    color: "text-success-600" },
          { label: "Out of Stock",     value: outOfStock,            icon: <AlertCircle className="h-4 w-4" />,     color: "text-danger-600" },
        ].map((s, i) => (
          <Card key={i} className="shadow-sm border-neutral-200">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-neutral-500 font-medium">{s.label}</span>
                <span className={s.color}>{s.icon}</span>
              </div>
              <span className={`text-2xl font-bold ${s.color}`}>{s.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Cost Audit ──────────────────────────────────────────────────── */}
      {items.some(i => !i.makingCost || i.makingCost <= 0) && (
        <FgCostAuditPanel
          items={items}
          recipes={recipes}
          onCostApplied={fetchData}
        />
      )}

      {/* ── Stock value banner ───────────────────────────────────────────── */}
      <div className="flex items-center gap-3 bg-gradient-to-r from-brand-600 to-brand-800 text-white rounded-xl px-5 py-4 shadow-sm">
        <DollarSign className="h-5 w-5 opacity-80" />
        <div>
          <p className="text-xs font-medium opacity-75 uppercase tracking-wider">HQ Finished Goods Stock Value</p>
          <p className="text-2xl font-bold">
            ${totalValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────── */}
      <Card className="shadow-sm border-neutral-200 overflow-hidden">
        <CardHeader className="flex flex-col sm:flex-row gap-3 items-start sm:items-center pb-4 border-b border-neutral-100 bg-white pt-4 px-4">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search finished goods…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-4 py-1.5 border border-neutral-200 rounded-md text-sm w-full bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          {/* Category filter — always visible; options come from DB (or CATEGORY_OPTIONS fallback) */}
          <select
            value={filterCategory}
            onChange={e => setFilterCategory(e.target.value)}
            className="px-3 py-1.5 text-sm border border-neutral-200 rounded-md bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="All">All categories</option>
            {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {/* Commissary filter */}
          <select
            value={filterCommissary}
            onChange={e => setFilterCommissary(e.target.value)}
            className="px-3 py-1.5 text-sm border border-neutral-200 rounded-md bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="All">All commissaries</option>
            {COMMISSARY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider">
              <TableRow>
                <TableHead className="py-3 px-6">Item / SKU</TableHead>
                <TableHead className="py-3">Category</TableHead>
                <TableHead className="py-3">Commissary</TableHead>
                <TableHead className="py-3">Unit</TableHead>
                <TableHead className="py-3">Making Cost</TableHead>
                <TableHead className="py-3">Effective Price</TableHead>
                <TableHead className="py-3">Stock</TableHead>
                <TableHead className="py-3">Status</TableHead>
                <TableHead className="py-3 text-right px-6">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length > 0 ? filtered.map(item => {
                // DEBUG: verify sourceCommissary coming from DB — remove once confirmed correct
                console.log('[FG Row]', item.id, item.sourceCommissary);
                const linkedRecipe = recipes.find(r => r.id === item.sourceRecipeId);
                return (
                  <TableRow key={item.id} className="hover:bg-neutral-50/50 transition-colors">
                    <TableCell className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Factory className="h-4 w-4 text-neutral-300 shrink-0" />
                        <div>
                          <p className="font-semibold text-neutral-900 text-sm">{item.name}</p>
                          <p className="text-xs text-neutral-400 flex items-center gap-1">
                            {item.id}
                            {linkedRecipe && (
                              <><ChevronRight className="h-3 w-3" /> <span className="text-brand-500">{linkedRecipe.name}</span></>
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
                    <TableCell className="py-4 text-sm text-neutral-600">
                      {item.makingCost > 0
                        ? <><span className="font-medium text-neutral-800">${item.makingCost.toFixed(2)}</span><span className="text-neutral-400">/{item.baseUnit}</span></>
                        : <span className="text-neutral-300">—</span>}
                    </TableCell>
                    <TableCell className="py-4">
                      <span className="font-bold text-success-700 text-sm">
                        ${item.effectivePrice.toFixed(2)}
                        <span className="text-neutral-400 font-normal">/{item.baseUnit}</span>
                      </span>
                    </TableCell>
                    <TableCell className="py-4">
                      <div className="flex flex-col gap-1">
                        <StockChip status={item.stockStatus} />
                        <span className="text-xs text-neutral-500">{item.instock} {item.baseUnit}</span>
                      </div>
                    </TableCell>
                    <TableCell className="py-4">
                      <div className="flex flex-col gap-1">
                        <ActiveChip active={item.isActive} />
                        {item.isRequisitionable
                          ? <span className="text-xs text-success-600 font-medium">Requisitionable</span>
                          : <span className="text-xs text-neutral-400">Hidden from locations</span>}
                      </div>
                    </TableCell>
                    <TableCell className="py-4 px-6 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => toggleActive(item)}
                          title={item.isActive ? "Deactivate" : "Activate"}
                          className="p-1.5 rounded-md text-neutral-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                        >
                          {item.isActive ? <ToggleRight className="h-4 w-4 text-brand-500" /> : <ToggleLeft className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={() => openEdit(item)}
                          className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              }) : (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-neutral-400 text-sm">
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
        description={editing
          ? `SKU: ${editing.id} · Making cost: $${editing.makingCost.toFixed(2)}/${editing.baseUnit}`
          : "Create a new HQ finished good that franchise locations can requisition."
        }
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
              const yieldQty = linked?.yieldQty || 1;
              const makingCost = linked ? (linked.theoreticalCost || 0) / yieldQty : (editing?.makingCost ?? 0);
              const suggested = makingCost * 1.20;
              const manual = formManualPrice !== "" && !isNaN(parseFloat(formManualPrice))
                ? parseFloat(formManualPrice) : null;
              const effective = manual ?? suggested;
              if (makingCost > 0 || manual != null) return (
                <div className="flex items-center justify-between bg-brand-50 border border-brand-100 rounded-lg px-4 py-3">
                  <div className="flex flex-col gap-0.5 text-xs text-brand-700">
                    <span>Making cost: <strong>${makingCost.toFixed(2)}/{formUnit}</strong></span>
                    <span>Suggested (×1.20): <strong>${suggested.toFixed(2)}/{formUnit}</strong></span>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-brand-600 font-medium">Effective price</p>
                    <p className="text-lg font-bold text-brand-900">${effective.toFixed(2)}</p>
                  </div>
                </div>
              );
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

          {/* Unit + Par Level */}
          <div className="grid grid-cols-2 gap-3">
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
          </div>

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

          {/* Manual price override */}
          <div>
            <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">
              Manual Price Override <span className="text-neutral-400 font-normal">(leave blank to use suggested)</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 text-sm">$</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={formManualPrice}
                onChange={e => setFormManualPrice(e.target.value)}
                placeholder="Auto (suggested × 1.20)"
                className="w-full pl-7 pr-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
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
          </div>

          {/* Pricing info box for existing items */}
          {editing && (
            <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-4 space-y-2 text-sm">
              <p className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-2">Current Pricing</p>
              <div className="flex justify-between">
                <span className="text-neutral-500">Making cost</span>
                <span className="font-medium">${editing.makingCost.toFixed(2)}/{editing.baseUnit}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Suggested (×1.20)</span>
                <span className="font-medium">${editing.suggestedPrice.toFixed(2)}</span>
              </div>
              <div className="flex justify-between border-t border-neutral-200 pt-2">
                <span className="font-semibold text-neutral-700">Effective price</span>
                <span className="font-bold text-success-700">${editing.effectivePrice.toFixed(2)}</span>
              </div>
              {editing.makingCostUpdatedAt && (
                <p className="text-xs text-neutral-400">
                  Cost last updated: {new Date(editing.makingCostUpdatedAt).toLocaleDateString()}
                </p>
              )}
            </div>
          )}

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
                            const pct = foodCostPct(editing.makingCost, row.salesPrice);
                            return (
                              <tr key={row.id} className="hover:bg-neutral-50/50">
                                <td className="px-3 py-2.5 font-medium text-neutral-800">
                                  {row.locationName || row.locationId}
                                </td>
                                <td className="px-3 py-2.5 text-right font-semibold text-success-700">
                                  ${row.salesPrice.toFixed(2)}
                                </td>
                                <td className="px-3 py-2.5 text-right text-neutral-500">
                                  ${editing.makingCost.toFixed(2)}
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
                          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
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
                    {newPricingPrice && !isNaN(parseFloat(newPricingPrice)) && parseFloat(newPricingPrice) > 0 && (
                      <div className="flex items-center gap-2 text-xs text-neutral-600 bg-white border border-neutral-200 rounded px-2 py-1.5">
                        <TrendingUp className="h-3.5 w-3.5 text-brand-500" />
                        Food cost at this price: <strong className="ml-1">{foodCostPct(editing.makingCost, parseFloat(newPricingPrice))}</strong>
                        <span className="text-neutral-400 ml-1">(${editing.makingCost.toFixed(2)} ÷ ${parseFloat(newPricingPrice).toFixed(2)} × 100)</span>
                      </div>
                    )}
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
