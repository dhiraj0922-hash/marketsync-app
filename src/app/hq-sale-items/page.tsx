"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Drawer } from "@/components/ui/drawer";
import {
  PackageCheck, Search, Plus, Edit2, ToggleLeft, ToggleRight,
  TrendingUp, AlertCircle, Loader2, ChevronRight, DollarSign, Factory,
  CheckCircle2, XCircle, Layers
} from "lucide-react";
import {
  loadSaleItems, upsertSaleItem, loadRecipes,
  type SaleItem
} from "@/lib/storage";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";

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
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch]     = useState("");

  // Drawer state
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [editing, setEditing]  = useState<SaleItem | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Form state
  const [formName, setFormName]               = useState("");
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
      const [si, rec] = await Promise.all([loadSaleItems(), loadRecipes()]);
      setItems(Array.isArray(si) ? si : []);
      setRecipes(Array.isArray(rec) ? rec : []);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const openCreate = () => {
    setEditing(null);
    setFormName(""); setFormDesc(""); setFormUnit("ea");
    setFormParLevel(0); setFormManualPrice(""); setFormRecipeId("");
    setFormActive(true); setFormRequisitionable(true);
    setSaveError(null);
    setIsDrawerOpen(true);
  };

  const openEdit = (item: SaleItem) => {
    setEditing(item);
    setFormName(item.name);
    setFormDesc(item.description ?? "");
    setFormUnit(item.baseUnit);
    setFormParLevel(item.parLevel);
    setFormManualPrice(item.manualPrice != null ? String(item.manualPrice) : "");
    setFormRecipeId(item.sourceRecipeId ?? "");
    setFormActive(item.isActive);
    setFormRequisitionable(item.isRequisitionable);
    setSaveError(null);
    setIsDrawerOpen(true);
  };

  const handleSave = async () => {
    setSaveError(null);
    if (!formName.trim()) { setSaveError("Name is required."); return; }
    setIsSaving(true);
    try {
      const id = editing?.id ?? `SKU-${Date.now().toString(36).toUpperCase()}`;
      const linkedRecipe = recipes.find(r => r.id === formRecipeId);

      // Compute making_cost from linked recipe if available
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
        description:          formDesc.trim() || null,
        baseUnit:             formUnit,
        parLevel:             formParLevel,
        isActive:             formActive,
        isRequisitionable:    formRequisitionable,
        sourceRecipeId:       formRecipeId || null,
        sourceRecipeYieldQty: sourceYieldQty,
        makingCost,
        manualPrice,
        // These are computed server-side; pass zeros so mapSaleItemToDB only writes what we send
        instock:      editing?.instock ?? 0,
        suggestedPrice: 0,    // generated column — ignored by mapSaleItemToDB
        effectivePrice: 0,    // computed in app
        stockStatus:    'in_stock',
        makingCostUpdatedAt: null,
        createdAt: null,
        updatedAt: null,
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

  const toggleActive = async (item: SaleItem) => {
    await upsertSaleItem({ ...item, isActive: !item.isActive });
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, isActive: !i.isActive } : i));
  };

  const toggleRequisitionable = async (item: SaleItem) => {
    await upsertSaleItem({ ...item, isRequisitionable: !item.isRequisitionable });
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, isRequisitionable: !i.isRequisitionable } : i));
  };

  // ── Filtered list ─────────────────────────────────────────────────────────────
  const filtered = items.filter(i =>
    !search || i.name.toLowerCase().includes(search.toLowerCase()) ||
    i.id.toLowerCase().includes(search.toLowerCase())
  );

  // ── Stats ─────────────────────────────────────────────────────────────────────
  const totalActive       = items.filter(i => i.isActive).length;
  const totalRequisitionable = items.filter(i => i.isRequisitionable).length;
  const totalValue        = items.reduce((s, i) => s + i.instock * i.effectivePrice, 0);
  const outOfStock        = items.filter(i => i.stockStatus === "out_of_stock").length;

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
        <button
          id="btn-create-sale-item"
          onClick={openCreate}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm transition-colors"
        >
          <Plus className="h-4 w-4" /> New Finished Good
        </button>
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
          <div className="relative w-full sm:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search finished goods…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-4 py-1.5 border border-neutral-200 rounded-md text-sm w-full bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider">
              <TableRow>
                <TableHead className="py-3 px-6">Item / SKU</TableHead>
                <TableHead className="py-3">Unit</TableHead>
                <TableHead className="py-3">Making Cost</TableHead>
                <TableHead className="py-3">Suggested</TableHead>
                <TableHead className="py-3">Override Price</TableHead>
                <TableHead className="py-3">Effective Price</TableHead>
                <TableHead className="py-3">Stock</TableHead>
                <TableHead className="py-3">Status</TableHead>
                <TableHead className="py-3 text-right px-6">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length > 0 ? filtered.map(item => {
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
                    <TableCell className="py-4 text-sm text-neutral-700">{item.baseUnit}</TableCell>
                    <TableCell className="py-4 text-sm text-neutral-600">
                      {item.makingCost > 0
                        ? <><span className="font-medium text-neutral-800">${item.makingCost.toFixed(2)}</span><span className="text-neutral-400">/{item.baseUnit}</span></>
                        : <span className="text-neutral-300">—</span>}
                    </TableCell>
                    <TableCell className="py-4 text-sm">
                      <span className="font-medium text-neutral-700">
                        {item.suggestedPrice > 0 ? `$${item.suggestedPrice.toFixed(2)}` : "—"}
                      </span>
                    </TableCell>
                    <TableCell className="py-4 text-sm">
                      {item.manualPrice != null
                        ? <span className="font-semibold text-brand-700">${item.manualPrice.toFixed(2)}</span>
                        : <span className="text-neutral-300 text-xs italic">auto</span>}
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
                    {search
                      ? "No finished goods match your search."
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
        </div>
      </Drawer>
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
