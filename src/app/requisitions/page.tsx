"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import {
  Inbox,
  Search,
  CheckCircle2,
  XSquare,
  PackageCheck,
  MapPin,
  Clock,
  Sparkles,
  CircleDollarSign,
  Printer,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Plus,
  AlertCircle,
  Loader2,
  Trash2,
  ArrowLeft,
  ShoppingCart,
  X,
  Warehouse,
} from "lucide-react";
import {
  loadRequisitions,
  saveRequisitions,
  loadFinishedGoods,
  saveFinishedGoods,
  loadInventory,
  loadSaleItems,
  loadLocations,
  saveNewRequisition,
  loadRequisitionItems,
  loadRequisitionItemsBatch,
  updateRequisitionStatus,
  updateRequisitionItemFulfilled,
  getHQAvailabilityLabel,
  sendHqRequisitionNotification,
  type SaleItem,
} from "@/lib/storage";
import {
  getCurrentUserProfile,
  getCurrentUserId,
  clearProfileCache,
  type UserProfile,
} from "@/lib/auth";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface LineItemDraft {
  // One of itemId (raw mode) or finishedGoodId (FG mode) will be set
  itemId:            string | null;
  finishedGoodId:    string | null;
  itemName:          string;         // snapshot: captured at selection time
  unit:              string;         // snapshot: captured at selection time
  packQty:           number;         // how many base units per pack; 1 for single-unit items
  unitPrice:         number;         // pack price = effectivePrice * packQty (captured at selection)
  quantityRequested: number;         // number of packs (or units when packQty=1)
  sourceCommissary:  string;         // snapshot: which commissary fulfills this line
}

// ─── Commissary routing constants ─────────────────────────────────────────────
const COMMISSARY_OPTIONS = ["Commissary HQ", "MOMOLOCO", "Veggie Paradise"] as const;
type CommissaryKey = typeof COMMISSARY_OPTIONS[number];

const COMMISSARY_COLORS: Record<string, string> = {
  "Commissary HQ":   "bg-brand-50   text-brand-700   border-brand-200",
  "MOMOLOCO":        "bg-warning-50  text-warning-700  border-warning-200",
  "Veggie Paradise": "bg-success-50  text-success-700  border-success-200",
};

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

function DarkPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-[#070707] p-6 text-zinc-100">
      <style>{stockIqDarkShellCss}</style>
      <div className="mx-auto max-w-[1408px] space-y-5">
        {children}
      </div>
    </div>
  );
}

// ─── Status badge helper ───────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    Draft:       "bg-zinc-500/15 text-zinc-300 border border-zinc-500/20",
    draft:       "bg-zinc-500/15 text-zinc-300 border border-zinc-500/20",
    Submitted:   "bg-amber-500/15 text-amber-300 border border-amber-500/20",
    submitted:   "bg-amber-500/15 text-amber-300 border border-amber-500/20",
    Approved:    "bg-blue-500/15 text-blue-300 border border-blue-500/20",
    approved:    "bg-blue-500/15 text-blue-300 border border-blue-500/20",
    Rejected:    "bg-red-500/15 text-red-300 border border-red-500/20",
    rejected:    "bg-red-500/15 text-red-300 border border-red-500/20",
    Fulfilled:   "bg-emerald-500/15 text-emerald-300 border border-emerald-500/20",
    fulfilled:   "bg-emerald-500/15 text-emerald-300 border border-emerald-500/20",
    Partial:     "bg-orange-500/15 text-orange-300 border border-orange-500/20",
    partial:     "bg-orange-500/15 text-orange-300 border border-orange-500/20",
    Backordered: "bg-red-500/15 text-red-300 border border-red-500/20",
    backordered: "bg-red-500/15 text-red-300 border border-red-500/20",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${map[status] ?? "bg-zinc-500/15 text-zinc-300 border border-zinc-500/20"}`}>
      {status}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOCATION MANAGER VIEW
// ═══════════════════════════════════════════════════════════════════════════════

function LocationManagerView({
  profile,
  inventoryItems,
  saleItems,
}: {
  profile: UserProfile;
  inventoryItems: any[];
  saleItems: SaleItem[];
}) {
  const fgMode = saleItems.some(s => s.isActive && s.isRequisitionable);
  const [requisitions, setRequisitions] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedReq, setSelectedReq] = useState<any>(null);
  const [reqLineItems, setReqLineItems] = useState<any[]>([]);
  const [lineItemsLoading, setLineItemsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [draftNotes, setDraftNotes] = useState("");
  const [lineItems, setLineItems] = useState<LineItemDraft[]>([]);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [storageFilter, setStorageFilter] = useState("all");
  const [catalogQtyById, setCatalogQtyById] = useState<Record<string, number>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [submitNotice, setSubmitNotice] = useState<{ type: "success" | "warning"; message: string } | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);

  const fetchReqs = useCallback(async () => {
    setIsLoading(true);
    try {
      const rows = await loadRequisitions();
      setRequisitions(Array.isArray(rows) ? rows : []);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchReqs(); }, [fetchReqs]);

  useEffect(() => {
    if (!selectedReq) { setReqLineItems([]); return; }
    let cancelled = false;
    setLineItemsLoading(true);
    loadRequisitionItems(selectedReq.id).then((res) => {
      if (!cancelled) {
        setReqLineItems(res.success ? (res.data ?? []) : []);
        setLineItemsLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [selectedReq]);

  const filtered = requisitions.filter((r) => {
    if (filterStatus !== "all" && String(r.status || "").toLowerCase() !== filterStatus) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!String(r.id).toLowerCase().includes(q) && !String(r.notes || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const catalogItems = useMemo(() => {
    if (fgMode) {
      return saleItems
        .filter(s => s.isActive && s.isRequisitionable)
        .map(s => {
          const packQty = s.packQty && s.packQty > 0 ? s.packQty : 1;
          const status = getHQAvailabilityLabel(s);
          return {
            id: s.id,
            name: s.name,
            category: "Finished Goods",
            unit: packQty > 1 ? `${packQty} ${s.baseUnit}/pack` : s.baseUnit,
            hqStock: s.instock ?? 0,
            cost: Number(s.effectivePrice ?? 0) * packQty,
            supplier: s.sourceCommissary || "Commissary HQ",
            storage: s.sourceCommissary || "Commissary HQ",
            status,
            added: lineItems.some(li => li.finishedGoodId === s.id),
          };
        });
    }

    return inventoryItems.map(i => {
      const stock = Number(i.inStock ?? i.instock ?? i.quantity ?? 0);
      const par = Number(i.parLevel ?? i.minStock ?? i.reorderPoint ?? 0);
      return {
        id: i.id,
        name: i.name,
        category: i.category || i.itemType || "Inventory",
        unit: i.unit || i.baseUnit || "unit",
        hqStock: stock,
        cost: Number(i.cost ?? i.unitCost ?? 0),
        supplier: i.supplierName || i.supplier || "Commissary HQ",
        storage: i.storage || i.storageLocation || i.location || "HQ Storage",
        status: stock <= 0 ? "out_of_stock" : par > 0 && stock <= par ? "low_stock" : "available",
        added: lineItems.some(li => li.itemId === i.id),
      };
    });
  }, [fgMode, inventoryItems, lineItems, saleItems]);

  const categoryOptions = useMemo(() => Array.from(new Set(catalogItems.map(i => i.category))).sort(), [catalogItems]);
  const supplierOptions = useMemo(() => Array.from(new Set(catalogItems.map(i => i.supplier))).sort(), [catalogItems]);
  const storageOptions = useMemo(() => Array.from(new Set(catalogItems.map(i => i.storage))).sort(), [catalogItems]);
  const visibleCatalogItems = useMemo(() => {
    const query = catalogSearch.trim().toLowerCase();
    return catalogItems.filter(item => {
      if (query && !item.name.toLowerCase().includes(query)) return false;
      if (categoryFilter !== "all" && item.category !== categoryFilter) return false;
      if (supplierFilter !== "all" && item.supplier !== supplierFilter) return false;
      if (storageFilter !== "all" && item.storage !== storageFilter) return false;
      return true;
    });
  }, [catalogItems, catalogSearch, categoryFilter, supplierFilter, storageFilter]);

  const draftTotal = lineItems.reduce((sum, li) => sum + li.quantityRequested * li.unitPrice, 0);
  const lowStockCount = catalogItems.filter(i => i.status === "low_stock" || i.status === "out_of_stock" || i.status === "not_available").length;
  const lastSubmittedOrder = requisitions[0]?.id ?? "None";

  const addItemById = (itemId: string) => {
    if (!itemId) return;
    const quantity = Math.max(1, Number(catalogQtyById[itemId] ?? 1));

    if (fgMode) {
      const saleItem = saleItems.find(s => s.id === itemId);
      if (!saleItem) return;
      if (lineItems.some(li => li.finishedGoodId === saleItem.id)) return;
      const packQty = (saleItem.packQty != null && saleItem.packQty > 0) ? saleItem.packQty : 1;
      const packPrice = saleItem.effectivePrice * packQty;
      setLineItems(prev => [
        ...prev,
        {
          itemId:            null,
          finishedGoodId:    saleItem.id,
          itemName:          saleItem.name,               // snapshot
          unit:              saleItem.baseUnit,            // snapshot
          packQty,                                         // snapshot: units-per-pack
          unitPrice:         packPrice,                    // pack price captured at selection time
          quantityRequested: quantity,                     // qty = number of packs
          sourceCommissary:  saleItem.sourceCommissary,   // commissary snapshot
        },
      ]);
    } else {
      if (lineItems.some(li => li.itemId === itemId)) return;
      const inv = inventoryItems.find(i => i.id === itemId);
      if (!inv) return;
      setLineItems(prev => [
        ...prev,
        {
          itemId:            inv.id,
          finishedGoodId:    null,
          itemName:          inv.name,
          unit:              inv.unit || inv.baseUnit || "",
          packQty:           1,                           // raw items always 1 unit
          unitPrice:         Number(inv.cost ?? 0),
          quantityRequested: quantity,
          sourceCommissary:  "Commissary HQ",   // raw items always route to HQ
        },
      ]);
    }
  };

  const removeLineItem = (id: string) =>
    setLineItems(prev => prev.filter(li => (li.finishedGoodId ?? li.itemId) !== id));

  const updateQty = (id: string, qty: number) =>
    setLineItems(prev =>
      prev.map(li => (li.finishedGoodId ?? li.itemId) === id ? { ...li, quantityRequested: Math.max(0, qty) } : li)
    );

  const showSubmitNotice = (type: "success" | "warning", message: string) => {
    setSubmitNotice({ type, message });
    window.setTimeout(() => setSubmitNotice(null), 5200);
  };

  // ── Commit create ─────────────────────────────────────────────────────────
  const handleCreate = async () => {
    setSaveError(null);
    if (lineItems.length === 0) { setSaveError("Add at least one item."); return; }
    if (lineItems.some(li => li.quantityRequested <= 0)) {
      setSaveError("All items must have a quantity greater than 0.");
      return;
    }

    setIsSaving(true);
    try {
      const userId = await getCurrentUserId();
      if (!userId) { setSaveError("Not authenticated."); return; }
      if (!profile.locationId) { setSaveError("Your profile has no location assigned."); return; }

      const reqId = `REQ-${Date.now()}`;
      const res = await saveNewRequisition(
        {
          id:          reqId,
          location_id: profile.locationId,
          created_by:  userId,
          status:      "submitted",
          notes:       draftNotes,
          date:        new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
        },
        lineItems.map(li => ({
          // FG-mode: set finished_good_id; raw-mode: set item_id
          item_id:                     li.finishedGoodId ? null     : li.itemId,
          finished_good_id:            li.finishedGoodId ?? null,
          item_name_snapshot:          li.itemName,
          unit_snapshot:               li.unit,
          source_commissary_snapshot:  li.sourceCommissary ?? "Commissary HQ",
          quantity_requested:          li.quantityRequested,
          unit_price:                  li.unitPrice,
          line_total:                  parseFloat((li.quantityRequested * li.unitPrice).toFixed(2)),
        }))
      );

      if (!res.success) {
        setSaveError(res.error?.message ?? "Save failed. Check console.");
        return;
      }

      const notifyRes = await sendHqRequisitionNotification(reqId);
      if (notifyRes.success) {
        showSubmitNotice("success", "Order submitted. HQ notification email sent.");
      } else {
        console.warn("[Requisitions] HQ notification failed:", notifyRes.error);
        showSubmitNotice("warning", "Order submitted. HQ email notification failed.");
      }

      setLineItems([]);
      setDraftNotes("");
      await fetchReqs();
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveDraft = () => {
    setDraftNotice(lineItems.length > 0 ? "Draft kept in this order cart." : "Add items before saving a draft.");
    window.setTimeout(() => setDraftNotice(null), 4000);
  };

  const renderStockBadge = (status: string) => {
    if (status === "available") return <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">In Stock</span>;
    if (status === "low_stock") return <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">Low Stock</span>;
    return <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">Backorder</span>;
  };

  if (isLoading) {
    return (
      <div className="-m-6 min-h-[calc(100vh-4rem)] bg-slate-50 p-6 text-slate-900">
        {submitNotice && (
          <div className={`fixed right-4 top-4 z-50 rounded-lg border px-4 py-3 text-sm font-semibold shadow-lg ${
            submitNotice.type === "success"
              ? "border-success-200 bg-success-50 text-success-700"
            : "border-warning-200 bg-warning-50 text-warning-700"
          }`}>
            {submitNotice.message}
          </div>
        )}
        <div className="flex items-center justify-center gap-2 p-16 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading order inventory...
        </div>
      </div>
    );
  }

  return (
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-slate-50 p-4 text-slate-900 sm:p-6">
      {submitNotice && (
        <div className={`fixed right-4 top-4 z-50 rounded-lg border px-4 py-3 text-sm font-semibold shadow-lg ${
          submitNotice.type === "success"
            ? "border-success-200 bg-success-50 text-success-700"
            : "border-warning-200 bg-warning-50 text-warning-700"
        }`}>
          {submitNotice.message}
        </div>
      )}
      {draftNotice && (
        <div className="fixed right-4 top-20 z-50 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700 shadow-lg">
          {draftNotice}
        </div>
      )}

      <div className="mx-auto max-w-[1440px] space-y-6">
        <header className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => window.history.back()}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-50"
              aria-label="Go back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.24em] text-emerald-700">STOCK DHARMA</p>
              <p className="mt-1 text-sm text-slate-500">Restaurant inventory command center</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
              <MapPin className="h-3.5 w-3.5" />
              {profile.locationId || "Location"}
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold capitalize text-slate-600">
              {String(profile.role || "location manager").replace(/_/g, " ")}
            </span>
            <button
              id="btn-submit-requisition"
              type="button"
              onClick={handleCreate}
              disabled={isSaving || lineItems.length === 0}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
              Submit Order
            </button>
          </div>
        </header>

        <section className="rounded-3xl border border-emerald-100 bg-gradient-to-br from-white via-emerald-50/70 to-slate-50 px-5 py-8 shadow-sm sm:px-8">
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-emerald-700">Order Inventory</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-5xl">Order Inventory</h1>
          <p className="mt-3 max-w-2xl text-base text-slate-600">Create and submit inventory requisitions for your location.</p>
        </section>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "Draft Order Total", value: `$${draftTotal.toFixed(2)}`, icon: <CircleDollarSign className="h-5 w-5" /> },
            { label: "Items in Cart", value: lineItems.length, icon: <ShoppingCart className="h-5 w-5" /> },
            { label: "Low Stock Items", value: lowStockCount, icon: <AlertCircle className="h-5 w-5" /> },
            { label: "Last Submitted Order", value: lastSubmittedOrder, icon: <ClipboardList className="h-5 w-5" /> },
          ].map((card) => (
            <div key={card.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">{card.label}</p>
                  <p className="mt-3 truncate text-2xl font-semibold text-slate-950">{card.value}</p>
                </div>
                <div className="rounded-xl bg-emerald-50 p-2 text-emerald-700">{card.icon}</div>
              </div>
            </div>
          ))}
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <main className="space-y-6">
            <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 p-4 sm:p-5">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-950">Catalog</h2>
                    <p className="mt-1 text-sm text-slate-500">Choose items from HQ inventory and add them to this requisition.</p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="relative min-w-0 sm:w-72">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        value={catalogSearch}
                        onChange={(e) => setCatalogSearch(e.target.value)}
                        placeholder="Search items"
                        className="min-h-11 w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none ring-emerald-600 transition focus:ring-2"
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {[
                        { value: categoryFilter, set: setCategoryFilter, options: categoryOptions, label: "Category" },
                        { value: supplierFilter, set: setSupplierFilter, options: supplierOptions, label: "Supplier" },
                        { value: storageFilter, set: setStorageFilter, options: storageOptions, label: "Storage" },
                      ].map(filter => (
                        <select
                          key={filter.label}
                          value={filter.value}
                          onChange={(e) => filter.set(e.target.value)}
                          className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none ring-emerald-600 transition focus:ring-2"
                        >
                          <option value="all">{filter.label}</option>
                          {filter.options.map(option => <option key={option} value={option}>{option}</option>)}
                        </select>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader className="bg-slate-50 text-xs uppercase tracking-[0.14em] text-slate-500">
                    <TableRow>
                      <TableHead className="px-5 py-3">Item Name</TableHead>
                      <TableHead className="py-3">Category</TableHead>
                      <TableHead className="py-3">Unit</TableHead>
                      <TableHead className="py-3">HQ Stock</TableHead>
                      <TableHead className="py-3">Cost</TableHead>
                      <TableHead className="py-3">Quantity</TableHead>
                      <TableHead className="py-3 text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleCatalogItems.map(item => {
                      const qty = catalogQtyById[item.id] ?? 1;
                      return (
                        <TableRow key={item.id} className="border-slate-100 hover:bg-emerald-50/30">
                          <TableCell className="px-5 py-4">
                            <div className="font-semibold text-slate-950">{item.name}</div>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {renderStockBadge(item.status)}
                              {item.added && <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">Added</span>}
                            </div>
                          </TableCell>
                          <TableCell className="py-4 text-sm text-slate-600">{item.category}</TableCell>
                          <TableCell className="py-4 text-sm text-slate-600">{item.unit}</TableCell>
                          <TableCell className="py-4 text-sm font-semibold text-slate-800">{item.hqStock}</TableCell>
                          <TableCell className="py-4 text-sm font-semibold text-slate-800">{item.cost > 0 ? `$${item.cost.toFixed(2)}` : "-"}</TableCell>
                          <TableCell className="py-4">
                            <input
                              type="number"
                              min={1}
                              value={qty}
                              onChange={(e) => setCatalogQtyById(prev => ({ ...prev, [item.id]: Math.max(1, Number(e.target.value)) }))}
                              className="h-10 w-20 rounded-lg border border-slate-200 px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
                            />
                          </TableCell>
                          <TableCell className="py-4 text-right">
                            <button
                              type="button"
                              onClick={() => addItemById(item.id)}
                              disabled={item.added}
                              className="inline-flex h-10 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
                            >
                              {item.added ? "Added" : "Add"}
                            </button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className="grid gap-3 p-4 md:hidden">
                {visibleCatalogItems.map(item => {
                  const qty = catalogQtyById[item.id] ?? 1;
                  return (
                    <div key={item.id} className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold text-slate-950">{item.name}</h3>
                          <p className="mt-1 text-sm text-slate-500">{item.category} · {item.unit}</p>
                        </div>
                        {renderStockBadge(item.status)}
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <div><span className="text-slate-500">HQ Stock</span><p className="font-semibold text-slate-900">{item.hqStock}</p></div>
                        <div><span className="text-slate-500">Cost</span><p className="font-semibold text-slate-900">{item.cost > 0 ? `$${item.cost.toFixed(2)}` : "-"}</p></div>
                      </div>
                      <div className="mt-4 flex gap-2">
                        <input
                          type="number"
                          min={1}
                          value={qty}
                          onChange={(e) => setCatalogQtyById(prev => ({ ...prev, [item.id]: Math.max(1, Number(e.target.value)) }))}
                          className="h-11 w-24 rounded-lg border border-slate-200 px-3 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => addItemById(item.id)}
                          disabled={item.added}
                          className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white disabled:bg-slate-200 disabled:text-slate-500"
                        >
                          {item.added ? "Added" : "Add item"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">Recent Requisitions</h2>
                  <p className="mt-1 text-sm text-slate-500">Review submitted orders and their current status.</p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative sm:w-64">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search requisitions"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="min-h-11 w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none ring-emerald-600 focus:ring-2"
                    />
                  </div>
                  <select
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                    className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none ring-emerald-600 focus:ring-2"
                  >
                    <option value="all">All Statuses</option>
                    <option value="draft">Draft</option>
                    <option value="submitted">Submitted</option>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                    <option value="fulfilled">Fulfilled</option>
                  </select>
                </div>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-slate-50 text-xs uppercase tracking-[0.14em] text-slate-500">
                    <TableRow>
                      <TableHead className="px-5 py-3">Order</TableHead>
                      <TableHead className="py-3">Date</TableHead>
                      <TableHead className="py-3">Items</TableHead>
                      <TableHead className="py-3">Total</TableHead>
                      <TableHead className="py-3">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.length > 0 ? filtered.map(req => (
                      <TableRow key={req.id} className="cursor-pointer border-slate-100 hover:bg-slate-50" onClick={() => setSelectedReq(req)}>
                        <TableCell className="px-5 py-4 font-semibold text-slate-950">{req.id}</TableCell>
                        <TableCell className="py-4 text-sm text-slate-600">{req.date}</TableCell>
                        <TableCell className="py-4 text-sm text-slate-600">{req.items}</TableCell>
                        <TableCell className="py-4 text-sm font-semibold text-slate-900">
                          {req.totalAmount > 0 ? `$${Number(req.totalAmount).toFixed(2)}` : "-"}
                        </TableCell>
                        <TableCell className="py-4"><StatusBadge status={req.status} /></TableCell>
                      </TableRow>
                    )) : (
                      <TableRow>
                        <TableCell colSpan={5} className="py-10 text-center text-sm text-slate-500">No requisitions found.</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </section>
          </main>

          <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 p-5">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">Order Cart</h2>
                  <p className="mt-1 text-sm text-slate-500">{lineItems.length} selected item{lineItems.length === 1 ? "" : "s"}</p>
                </div>
                <div className="rounded-xl bg-emerald-50 p-2 text-emerald-700"><ShoppingCart className="h-5 w-5" /></div>
              </div>
              <div className="space-y-4 p-5">
                {saveError && (
                  <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    {saveError}
                  </div>
                )}
                {lineItems.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
                    <Warehouse className="mx-auto h-8 w-8 text-slate-400" />
                    <p className="mt-3 text-sm font-semibold text-slate-700">No items added yet</p>
                    <p className="mt-1 text-sm text-slate-500">Add catalog items to prepare this requisition.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {lineItems.map(li => {
                      const id = li.finishedGoodId ?? li.itemId ?? "";
                      return (
                        <div key={id} className="rounded-xl border border-slate-200 bg-white p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <h3 className="truncate text-sm font-semibold text-slate-950">{li.itemName}</h3>
                              <p className="mt-1 text-xs text-slate-500">{li.unit} · ${li.unitPrice.toFixed(2)} each</p>
                            </div>
                            <button type="button" onClick={() => removeLineItem(id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Remove item">
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                          <div className="mt-3 flex items-center justify-between gap-3">
                            <input
                              type="number"
                              min={1}
                              value={li.quantityRequested}
                              onChange={(e) => updateQty(id, Number(e.target.value))}
                              className="h-10 w-24 rounded-lg border border-slate-200 px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
                            />
                            <span className="text-sm font-semibold text-slate-950">${(li.quantityRequested * li.unitPrice).toFixed(2)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Notes</span>
                  <textarea
                    rows={4}
                    value={draftNotes}
                    onChange={(e) => setDraftNotes(e.target.value)}
                    placeholder="Add delivery notes or order context"
                    className="mt-2 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-emerald-600 focus:ring-2"
                  />
                </label>
                <div className="rounded-xl bg-slate-50 p-4">
                  <div className="flex items-center justify-between text-sm text-slate-600">
                    <span>Draft total</span>
                    <span className="text-lg font-semibold text-slate-950">${draftTotal.toFixed(2)}</span>
                  </div>
                </div>
                <div className="grid gap-2">
                  <button
                    type="button"
                    onClick={handleSaveDraft}
                    className="min-h-11 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    Save Draft
                  </button>
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={isSaving || lineItems.length === 0}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    {isSaving ? "Submitting..." : "Submit Requisition"}
                  </button>
                </div>
              </div>
            </section>
          </aside>
        </div>

      <Drawer
        isOpen={!!selectedReq}
        onClose={() => { setSelectedReq(null); setReqLineItems([]); }}
        title={`Requisition ${selectedReq?.id}`}
        description={`Created ${selectedReq?.date} · Status: ${selectedReq?.status}`}
      >
        <div className="space-y-4">
          {selectedReq?.notes && (
            <div className="bg-brand-50 border border-brand-100 rounded-lg p-4">
              <h4 className="text-xs font-semibold text-brand-800 uppercase tracking-wider mb-1">Notes</h4>
              <p className="text-sm text-neutral-700">{selectedReq.notes}</p>
            </div>
          )}

          {/* Rejected banner */}
          {(selectedReq?.status === "rejected" || selectedReq?.status === "Rejected") && (
            <div className="bg-danger-50 border border-danger-200 rounded-lg p-4 flex items-center gap-3">
              <XSquare className="h-5 w-5 text-danger-600 shrink-0" />
              <p className="text-sm text-danger-700 font-medium">This requisition was rejected by HQ.</p>
            </div>
          )}

          {/* Pending review — only while draft or submitted */}
          {["draft", "submitted"].includes((selectedReq?.status ?? "").toLowerCase()) && (
            <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-4 flex items-center gap-3">
              <Loader2 className="h-4 w-4 text-neutral-400 shrink-0" />
              <p className="text-sm text-neutral-500">
                Awaiting HQ review. Line items will be visible once approved or actioned.
              </p>
            </div>
          )}

          {/* Line items — visible once HQ has actioned the requisition */}
          {reqLineItems.length > 0 && (() => {
            const fulfilledTotal = reqLineItems.reduce(
              (sum: number, li: any) => sum + Number(li.quantityFulfilled ?? 0) * Number(li.unitPrice ?? 0), 0
            );
            const requestedTotal = reqLineItems.reduce(
              (sum: number, li: any) => sum + Number(li.quantityRequested) * Number(li.unitPrice ?? 0), 0
            );
            const backorderTotal = Math.max(0, requestedTotal - fulfilledTotal);
            return (
              <div className="border border-neutral-200 rounded-lg overflow-hidden">
                <Table>
                  <TableHeader className="bg-neutral-50 text-[11px] uppercase text-neutral-500 tracking-wider">
                    <TableRow>
                      <TableHead className="py-2 px-4">Item</TableHead>
                      <TableHead className="py-2 text-right">Requested</TableHead>
                      <TableHead className="py-2 text-right">Fulfilled</TableHead>
                      <TableHead className="py-2 text-right">Backorder</TableHead>
                      <TableHead className="py-2 text-right">Unit Price</TableHead>
                      <TableHead className="py-2 text-right">Fulfilled $</TableHead>
                      <TableHead className="py-2">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reqLineItems.map((li: any) => {
                      const requested  = Number(li.quantityRequested  ?? 0);
                      const fulfilled  = Number(li.quantityFulfilled  ?? 0);
                      const backorder  = Math.max(0, requested - fulfilled);
                      const unitPrice  = Number(li.unitPrice ?? 0);
                      const lineTotal  = fulfilled * unitPrice;
                      const lineStatus = fulfilled >= requested ? "fulfilled" : fulfilled > 0 ? "partial" : "backordered";
                      return (
                        <TableRow key={li.id} className="hover:bg-neutral-50/50">
                          <TableCell className="py-3 px-4 text-sm font-medium text-neutral-800">{li.itemName}</TableCell>
                          <TableCell className="py-3 text-right text-sm text-neutral-700">{requested}</TableCell>
                          <TableCell className="py-3 text-right">
                            {li.quantityFulfilled != null
                              ? <span className="text-sm font-semibold text-success-700">{fulfilled}</span>
                              : <span className="text-neutral-400 text-xs">—</span>}
                          </TableCell>
                          <TableCell className="py-3 text-right">
                            {backorder > 0
                              ? <span className="text-sm font-bold text-danger-600">{backorder}</span>
                              : <span className="text-xs text-success-600 font-bold">—</span>}
                          </TableCell>
                          <TableCell className="py-3 text-right text-sm text-neutral-700">
                            {unitPrice > 0 ? `$${unitPrice.toFixed(2)}` : <span className="text-neutral-400">—</span>}
                          </TableCell>
                          <TableCell className="py-3 text-right">
                            <span className="text-sm font-semibold text-neutral-800">${lineTotal.toFixed(2)}</span>
                          </TableCell>
                          <TableCell className="py-3">
                            {li.quantityFulfilled != null
                              ? <StatusBadge status={lineStatus} />
                              : <span className="text-neutral-400 text-xs">Pending</span>}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                {/* Footer: fulfilled total + backorder value */}
                <div className="px-4 py-3 bg-neutral-50 border-t border-neutral-200 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-success-700 uppercase tracking-wider">Fulfilled Total</span>
                    <span className="text-base font-bold text-success-700">${fulfilledTotal.toFixed(2)}</span>
                  </div>
                  {backorderTotal > 0.005 && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-neutral-500">Backorder Value</span>
                      <span className="text-sm font-semibold text-danger-600">${backorderTotal.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Approved but no items returned yet — edge case */}
          {lineItemsLoading && (
            <div className="flex items-center gap-2 text-sm text-neutral-400 py-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading items…
            </div>
          )}
        </div>
      </Drawer>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HQ ADMIN VIEW  (unchanged logic, cleaned up)
// ═══════════════════════════════════════════════════════════════════════════════

// (locationsData hardcoded list removed — real locations loaded from DB via loadLocations())

function HQAdminView({
  finishedGoods: initialFG,
  profile,
}: {
  finishedGoods: any[];
  profile: import("@/lib/auth").UserProfile | null;
}) {
  const [requisitions, setRequisitions] = useState<any[]>([]);
  const [finishedGoods, setFinishedGoods] = useState<any[]>(initialFG);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterLocation, setFilterLocation] = useState("All"); // stores location.id or "All"
  const [filterFromDate, setFilterFromDate] = useState("");    // ISO date string "YYYY-MM-DD" or ""
  const [filterToDate, setFilterToDate] = useState("");        // ISO date string "YYYY-MM-DD" or ""
  const [selectedReq, setSelectedReq] = useState<any>(null);
  const [selectedReqIds, setSelectedReqIds] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "hq-production">("overview");
  const [activeCommissary, setActiveCommissary] = useState<string>("Commissary HQ");
  const [productionDate, setProductionDate] = useState<string>(
    new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  );
  const [expandedRows, setExpandedRows] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Line items fetched from requisition_items table on drawer open
  const [hqReqItems, setHqReqItems] = useState<any[]>([]);
  const [hqItemsLoading, setHqItemsLoading] = useState(false);
  // Cache line items per req id so table rows show real values once a req is opened
  const [reqItemsCache, setReqItemsCache] = useState<Map<string, any[]>>(new Map());

  // ── HQ Production: pre-load line items for all requisitions matching  ─────
  // the selected production date. This avoids N+1 fetches when hqProductionDemand
  // aggregates item-level data. productionItems is a Map<reqId, lineItems[]>.
  const [productionItems, setProductionItems] = useState<Map<string, any[]>>(new Map());

  // All statuses that represent active demand HQ must prepare for.
  // Defined here (not inside hqProductionDemand) so the useEffect below can use it too.
  const PRODUCTION_STATUSES = new Set(["submitted", "approved", "partial", "backordered", "fulfilled"]);

  // Real locations loaded from DB — used for the filter dropdown.
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const [reqs, fg, locs] = await Promise.all([
          loadRequisitions(),
          loadFinishedGoods(),
          loadLocations(),
        ]);
        setRequisitions(Array.isArray(reqs) ? reqs : []);
        setFinishedGoods(Array.isArray(fg) ? fg : []);
        setLocations(Array.isArray(locs) ? locs : []);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, []);

  // Batch-load line items for production date whenever date or requisitions list changes
  useEffect(() => {
    if (!requisitions.length || !productionDate) return;
    const normalize = (d: string): string => {
      if (!d) return "";
      if (isNaN(Date.parse(d))) return d.trim();
      return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    };
    const targetDate = normalize(productionDate);
    const relevant = requisitions.filter((r) => {
      const s = (r.status ?? "").toLowerCase();
      return PRODUCTION_STATUSES.has(s) && normalize(r.date ?? "") === targetDate;
    });
    if (!relevant.length) { setProductionItems(new Map()); return; }
    let cancelled = false;
    loadRequisitionItemsBatch(relevant.map((r) => r.id)).then((map) => {
      if (!cancelled) setProductionItems(map);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productionDate, requisitions]);


  // Fetch line items from requisition_items whenever a requisition is opened
  useEffect(() => {
    if (!selectedReq) { setHqReqItems([]); return; }
    // Serve from cache immediately to avoid flicker on re-open
    if (reqItemsCache.has(selectedReq.id)) {
      setHqReqItems(reqItemsCache.get(selectedReq.id)!);
      setHqItemsLoading(false);
      return;
    }
    let cancelled = false;
    setHqItemsLoading(true);
    loadRequisitionItems(selectedReq.id).then((res) => {
      if (!cancelled) {
        const items = res.success ? (res.data ?? []) : [];
        setHqReqItems(items);
        setHqItemsLoading(false);
        // Persist so table-level value helpers can use real data for this row
        setReqItemsCache(prev => new Map(prev).set(selectedReq.id, items));
      }
    });
    return () => { cancelled = true; };
  }, [selectedReq]);

  // ── Fulfill-qty draft map ─────────────────────────────────────────────────────
  // Controlled state for per-line fulfill qty inputs. Keyed by line-item id.
  // Reset when the drawer changes, initialise from DB data when items load.
  const [fulfillDraftMap, setFulfillDraftMap] = useState<Map<string, number>>(new Map());

  // Reset draft when the selected requisition changes (drawer opens/closes)
  useEffect(() => { setFulfillDraftMap(new Map()); }, [selectedReq?.id]);

  // Initialise missing entries from loaded line items
  useEffect(() => {
    if (!hqReqItems.length) return;
    setFulfillDraftMap(prev => {
      const next = new Map(prev);
      hqReqItems.forEach((li: any) => {
        if (next.has(li.id)) return; // preserve in-session edits
        const current   = Number(li.quantityFulfilled ?? 0);
        const requested = Number(li.quantityRequested  ?? 0);
        const hqStock   = li.hqAvailableStock;          // null for raw-item lines
        // If already partially fulfilled keep current value; otherwise default
        // to min(requested, hqStock) so HQ doesn't accidentally over-commit.
        const defaultVal = current > 0
          ? current
          : hqStock != null ? Math.min(requested, hqStock) : requested;
        next.set(li.id, defaultVal);
      });
      return next;
    });
  }, [hqReqItems]);

  // ── Fulfillment lock ──────────────────────────────────────────────────────────
  // Pure UI lock set by "Complete Fulfillment". Disables per-line inputs and
  // swaps the button to "Edit Fulfillment" so HQ can re-enter if needed.
  // No DB write — the DB is already up-to-date from per-line onBlur saves.
  const [isFulfillmentLocked, setIsFulfillmentLocked] = useState(false);
  // Lock when DB status is "fulfilled" — the only final state we write.
  // partial/backordered are UI-display-only and are not persisted to the DB.
  useEffect(() => {
    const status = (selectedReq?.status ?? "").toLowerCase();
    setIsFulfillmentLocked(status === "fulfilled");
  }, [selectedReq?.id, selectedReq?.status]);

  // ─── Value helpers ────────────────────────────────────────────────────────────
  //
  // Root cause of $0.00:
  //   getReqValue() only used cached line items (loaded on drawer open).
  //   For rows never opened the cache is empty → returns 0 for every row.
  //
  // Fix strategy:
  //   getDisplayValue(req)  — what to show in the table for any row:
  //     • If fulfilled/partial and items are cached → use actual fulfilled qty * price
  //     • If fulfilled/partial and items NOT cached → use req.totalAmount (best available)
  //     • If approved/submitted/draft → show req.totalAmount (requested value estimate)
  //   getReqFulfilledValue  — cache-only fulfilled value (used in drawer footer)
  //   getReqRequestedValue  — requested value (cache first, header fallback)
  //
  // req.totalAmount is written at requisition create time as sum(qty * unit_price)
  // and is accurate for the requested value. It's always present.

  /** Compute best available fulfilled value from cached items (0 if not cached). */
  const getReqFulfilledValue = (req: any): number => {
    const items = reqItemsCache.get(req.id) ?? (req.id === selectedReq?.id ? hqReqItems : null);
    if (!items) return 0;
    return items.reduce((sum: number, li: any) => {
      const price     = Number(li.unitPrice         ?? li.unit_price          ?? 0);
      const fulfilled = Number(li.quantityFulfilled ?? li.quantity_fulfilled  ?? 0);
      return sum + fulfilled * price;
    }, 0);
  };

  /**
   * Status-aware display value for a requisition row.
   * - fulfilled / partial: actual fulfilled value (cache) or totalAmount fallback
   * - approved / submitted / draft: totalAmount (requested estimate)
   * - rejected: totalAmount (informational)
   * Never returns NaN or negative.
   */
  const getDisplayValue = (req: any): { amount: number; isEstimate: boolean } => {
    const status = (req.status ?? "").toLowerCase();
    const headerAmount = Math.max(0, Number(req.totalAmount ?? req.total_amount ?? 0));

    if (status === "fulfilled" || status === "partial") {
      const fulfilledVal = getReqFulfilledValue(req);
      // If items are cached and fulfilled > 0, show exact fulfilled value
      const items = reqItemsCache.get(req.id) ?? (req.id === selectedReq?.id ? hqReqItems : null);
      if (items && fulfilledVal > 0) return { amount: fulfilledVal, isEstimate: false };
      // Items not yet loaded or 0 qty fulfilled — fall back to totalAmount
      return { amount: headerAmount, isEstimate: true };
    }

    // For all other statuses (approved, submitted, draft, rejected): show requested amount
    return { amount: headerAmount, isEstimate: status !== "rejected" };
  };

  const getReqRequestedValue = (req: any): number => {
    const items = reqItemsCache.get(req.id) ?? (req.id === selectedReq?.id ? hqReqItems : null);
    if (items && items.length > 0) {
      return items.reduce((sum: number, li: any) => {
        const price     = Number(li.unitPrice         ?? li.unit_price          ?? 0);
        const requested = Number(li.quantityRequested ?? li.quantity_requested  ?? 0);
        return sum + requested * price;
      }, 0);
    }
    return Math.max(0, Number(req.totalAmount ?? req.total_amount ?? 0));
  };

  // Keep getReqValue as an alias so the drawer footer still works unchanged
  const getReqValue = (req: any): number => getReqFulfilledValue(req);

  // ─── Canonical status sets ────────────────────────────────────────────────────
  const FULFILLABLE_STATUSES  = new Set(["approved", "partial", "backordered"]);
  const FULFILLED_STATUSES    = new Set(["fulfilled", "partial"]);
  const PENDING_STATUSES      = new Set(["draft", "submitted"]);

  const pendingCount   = requisitions.filter((r) => PENDING_STATUSES.has((r.status ?? "").toLowerCase())).length;
  const backorderCount = requisitions.filter((r) => (r.status ?? "").toLowerCase() === "backordered").length;

  // KPI: Total Value Supplied — use getDisplayValue so it works without requiring
  // every row to be opened first. For fulfilled rows getDisplayValue returns actual
  // fulfilled amount (if cached) or totalAmount (if not cached yet).
  let locValues = new Map<string, number>();
  let totalValueSupplied = 0;
  requisitions.forEach((r) => {
    const { amount } = getDisplayValue(r);
    if (!isNaN(amount) && amount > 0) {
      // Only count fulfilled/partial toward "supplied" KPI; others are "in flight"
      if (FULFILLED_STATUSES.has((r.status ?? "").toLowerCase())) {
        locValues.set(r.location, (locValues.get(r.location) || 0) + amount);
        totalValueSupplied += amount;
      }
    }
  });
  // topLocation: location with the largest committed/fulfilled value
  let topLocation = "N/A";
  let maxVal = 0;
  // Also include approved (committed) value in top-location ranking
  requisitions.forEach((r) => {
    if ([...FULFILLED_STATUSES, "approved"].includes((r.status ?? "").toLowerCase())) {
      const { amount } = getDisplayValue(r);
      locValues.set(r.location, (locValues.get(r.location) || 0) + amount);
    }
  });
  locValues.forEach((v, k) => { if (v > maxVal) { maxVal = v; topLocation = k; } });

  // Build a quick lookup: location.id → location.name for search and display.
  const locationById = new Map(locations.map((l) => [l.id, l.name]));

  const filteredReqs = requisitions.filter((r) => {
    // ── Status ────────────────────────────────────────────────────────────────
    if (filterStatus !== "all" && String(r.status || "").toLowerCase() !== filterStatus) return false;

    // ── Location — compare against location_id (r.location stores the FK) ────
    if (filterLocation !== "All" && r.location_id !== filterLocation) return false;

    // ── Date range ────────────────────────────────────────────────────────────
    if (filterFromDate || filterToDate) {
      // r.date may be "May 10, 2025" (locale string) or ISO — parse both
      const rDate = new Date(r.date ?? "");
      if (isNaN(rDate.getTime())) {
        // Unparseable date — exclude from date-filtered results
        if (filterFromDate || filterToDate) return false;
      } else {
        const rDateOnly = rDate.toISOString().slice(0, 10); // "YYYY-MM-DD"
        if (filterFromDate && rDateOnly < filterFromDate) return false;
        if (filterToDate   && rDateOnly > filterToDate)   return false;
      }
    }

    // ── Search: id, location_id, location name, requester, status ─────────────
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const locName = locationById.get(r.location_id ?? r.location ?? "") ?? "";
      const matches =
        String(r.id).toLowerCase().includes(q) ||
        String(r.location_id || r.location || "").toLowerCase().includes(q) ||
        locName.toLowerCase().includes(q) ||
        String(r.requestedBy || r.requestedby || "").toLowerCase().includes(q) ||
        String(r.status || "").toLowerCase().includes(q);
      if (!matches) return false;
    }

    return true;
  });

  const createMockRequest = async () => {
    if (finishedGoods.length === 0) return;
    const loc = locations.length
      ? locations[Math.floor(Math.random() * locations.length)].name
      : "HQ";
    const names = ["Alex R.", "Sarah J.", "Mike T.", "David W.", "Jessica K."];
    const user = names[Math.floor(Math.random() * names.length)];
    const numItems = Math.floor(Math.random() * 3) + 1;
    const items: any[] = [];
    const usedIds = new Set<string>();
    for (let i = 0; i < numItems; i++) {
      const candidate = finishedGoods[Math.floor(Math.random() * finishedGoods.length)];
      if (!candidate || usedIds.has(candidate.id)) continue;
      usedIds.add(candidate.id);
      items.push({ id: candidate.id, name: candidate.name, unit: candidate.unit, requestedQty: Math.floor(Math.random() * 15) + 5, fulfilledQty: 0, currentStock: candidate.currentStock });
    }
    if (items.length === 0) return;
    const newReq = {
      id: `REQ-${2000 + requisitions.length + 1}`,
      location: loc, requestedBy: user,
      date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      status: "Submitted", items: items.length, notes: "Auto-generated mock request.", lineItems: items,
    };
    const newArr = [newReq, ...requisitions];
    const res = await saveRequisitions(newArr);
    if (!res?.success) { alert(`DB Error: ${res?.error?.message}`); return; }
    setRequisitions(newArr);
  };

  const handleUpdateReqStatus = async (reqId: string, newStatus: string) => {
    // Use targeted single-row update — NOT a full array upsert — to avoid
    // CHECK constraint violations from legacy capitalized statuses in other rows.
    const res = await updateRequisitionStatus(reqId, newStatus);
    if (!res?.success) { alert(`DB Error: ${res?.error?.message}`); return; }
    const lower = newStatus.toLowerCase();
    setRequisitions((prev) => prev.map((r) => r.id === reqId ? { ...r, status: lower } : r));
    if (selectedReq?.id === reqId) setSelectedReq({ ...selectedReq, status: lower });
  };

  const handleToggleSelect = (reqId: string) =>
    setSelectedReqIds((prev) => prev.includes(reqId) ? prev.filter((id) => id !== reqId) : [...prev, reqId]);

  const handleFulfillSelected = async (forceIds?: string[]) => {
    const targets = forceIds || selectedReqIds;
    if (targets.length === 0) return;
    const selectedList = requisitions.filter((r) => targets.includes(r.id));
    if (selectedList.some((r) => !FULFILLABLE_STATUSES.has((r.status ?? "").toLowerCase()))) {
      alert("Only approved, partial, or backordered requests can be fulfilled.");
      return;
    }
    const _fg = [...finishedGoods];
    const _reqs = [...requisitions];
    let fullSuccess = true;
    let partialCount = 0;
    selectedList.forEach((req) => {
      const reqIndex = _reqs.findIndex((r) => r.id === req.id);
      if (reqIndex === -1) return;
      let allFulfilled = true;
      const updatedLineItems = (req.lineItems || []).map((li: any) => {
        const fgIndex = _fg.findIndex((f) => f.id === li.id);
        if (fgIndex === -1) { allFulfilled = false; return li; }
        const remaining = li.requestedQty - (li.fulfilledQty || 0);
        if (remaining <= 0) return li;
        const avail = _fg[fgIndex].currentStock;
        if (avail >= remaining) { _fg[fgIndex].currentStock -= remaining; return { ...li, fulfilledQty: (li.fulfilledQty || 0) + remaining }; }
        else if (avail > 0) { _fg[fgIndex].currentStock = 0; allFulfilled = false; fullSuccess = false; return { ...li, fulfilledQty: (li.fulfilledQty || 0) + avail }; }
        else { allFulfilled = false; fullSuccess = false; return li; }
      });
      _reqs[reqIndex].lineItems = updatedLineItems;
      if (allFulfilled) { _reqs[reqIndex].status = "fulfilled"; } else { _reqs[reqIndex].status = "partial"; partialCount++; }
    });
    const fgRes = await saveFinishedGoods(_fg);
    if (!fgRes?.success) { alert(`DB Error (Inventory): ${fgRes?.error?.message}`); return; }
    setFinishedGoods(_fg);
    const reqRes = await saveRequisitions(_reqs);
    if (!reqRes?.success) { alert(`DB Error (Requisitions): ${reqRes?.error?.message}`); return; }
    setRequisitions(_reqs);
    setSelectedReqIds([]);
    if (selectedReq) { const m = _reqs.find((r) => r.id === selectedReq.id); if (m) setSelectedReq(m); }
    if (fullSuccess) alert("Successfully fulfilled selected requisitions!");
    else alert(`${partialCount} requisition(s) partially fulfilled — in backorder.`);
  };

  const hqProductionDemand = () => {
    // Returns per-commissary aggregations:
    //   pending[commissary]   — items still to be produced by that commissary
    //   completed[commissary] — items fulfilled by that commissary today
    //
    // source_commissary_snapshot on each line item determines the commissary.
    // NULL (legacy rows) defaults to 'Commissary HQ'.

    const normalize = (d: string): string => {
      if (!d) return "";
      if (isNaN(Date.parse(d))) return d.trim();
      return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    };
    const targetDate = normalize(productionDate);

    type AggMap = Record<string, { totalQty: number; unit: string; locations: { loc: string; qty: number }[] }>;
    // One AggMap per commissary per section
    const pending:   Record<string, AggMap> = {};
    const completed: Record<string, AggMap> = {};
    for (const c of COMMISSARY_OPTIONS) { pending[c] = {}; completed[c] = {}; }

    const addToAgg = (agg: AggMap, name: string, unit: string, qty: number, loc: string) => {
      if (!name || qty <= 0) return;
      if (!agg[name]) agg[name] = { totalQty: 0, unit, locations: [] };
      agg[name].totalQty += qty;
      const existing = agg[name].locations.find((l) => l.loc === loc);
      if (existing) existing.qty += qty;
      else agg[name].locations.push({ loc, qty });
    };

    requisitions.forEach((req) => {
      const s = (req.status ?? "").toLowerCase();
      if (!PRODUCTION_STATUSES.has(s)) return;
      if (normalize(req.date ?? "") !== targetDate) return;

      const items = productionItems.get(req.id) ?? [];
      const locKey = req.location || req.location_id || "HQ";

      items.forEach((li: any) => {
        const requested  = Number(li.quantityRequested  ?? 0);
        const fulfilled  = Number(li.quantityFulfilled  ?? 0);
        const name = li.itemName ?? li.item_name_snapshot ?? li.itemId ?? "Unknown";
        const unit = li.unit ?? li.unit_snapshot ?? "";
        // Route to commissary — snapshot at order time, NULL falls back to HQ
        const commissary: string = li.sourceCommissary ?? "Commissary HQ";
        // Ensure the commissary bucket exists (for any future/custom values)
        if (!pending[commissary])   pending[commissary]   = {};
        if (!completed[commissary]) completed[commissary] = {};

        if (s === "fulfilled") {
          addToAgg(completed[commissary], name, unit, fulfilled, locKey);
        } else {
          addToAgg(pending[commissary], name, unit, requested, locKey);
        }
      });
    });

    return { pending, completed };
  };

  const { pending: pendingByCommissary, completed: completedByCommissary } = hqProductionDemand();
  // For backward compat with renderProductionTable which takes flat entries
  const activePendingEntries   = Object.entries(pendingByCommissary[activeCommissary]   ?? {});
  const activeCompletedEntries = Object.entries(completedByCommissary[activeCommissary] ?? {});

  // Legacy names kept so renderProductionTable call sites don't need changes
  const pendingEntries   = activePendingEntries;
  const completedEntries = activeCompletedEntries;

  const toggleExpand = (name: string) =>
    setExpandedRows((prev) => prev.includes(name) ? prev.filter((i) => i !== name) : [...prev, name]);

  // Helper to render a production aggregation table (shared by pending and completed sections)
  const renderProductionTable = (
    entries: [string, { totalQty: number; unit: string; locations: { loc: string; qty: number }[] }][],
    colorClass: string
  ) => (
    <div className="overflow-x-auto rounded-xl border border-neutral-200 print:border-none shadow-sm print:shadow-none">
      <Table className="bg-white print:bg-transparent">
        <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider print:bg-transparent">
          <TableRow>
            <TableHead className="w-[40px] px-4 print:px-0">#</TableHead>
            <TableHead className="py-3 px-4 print:px-0">Item Name</TableHead>
            <TableHead className="py-3 px-4 print:px-0">Qty</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([itemName, data], idx) => {
            const isExpanded = expandedRows.includes(itemName);
            return (
              <React.Fragment key={idx}>
                <TableRow className="hover:bg-brand-50/30 cursor-pointer print:hover:bg-transparent" onClick={() => toggleExpand(itemName)}>
                  <TableCell className="px-4 py-3 print:px-0">
                    <div className="print:hidden">{isExpanded ? <ChevronDown className="h-4 w-4 text-brand-600" /> : <ChevronRight className="h-4 w-4 text-neutral-400" />}</div>
                    <div className="hidden print:block text-neutral-500 font-medium">#{idx + 1}</div>
                  </TableCell>
                  <TableCell className="py-3 px-4 print:px-0"><span className="font-bold text-neutral-900 text-base">{itemName}</span></TableCell>
                  <TableCell className="py-3 px-4 print:px-0">
                    <span className={`font-bold text-base px-2 py-1 rounded-md print:bg-transparent ${colorClass}`}>{data.totalQty} {data.unit}</span>
                  </TableCell>
                </TableRow>
                <TableRow className={`bg-neutral-50/50 print:table-row print:bg-transparent ${isExpanded ? "table-row" : "hidden print:table-row"}`}>
                  <TableCell colSpan={3} className="px-10 py-3 print:px-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 py-2">
                      {data.locations.map((loc, lIdx) => (
                        <div key={lIdx} className="flex justify-between items-center text-sm py-1 border-b border-neutral-200 border-dashed last:border-0">
                          <span className="text-neutral-600 font-medium">{loc.loc}</span>
                          <span className="text-neutral-900 font-bold bg-white border border-neutral-200 px-2 rounded-md shadow-sm">{loc.qty} {data.unit}</span>
                        </div>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              </React.Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );

  if (isLoading) return (
    <DarkPageShell>
      <div className="flex justify-center p-12 text-zinc-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading Requisitions HQ Pipeline…
      </div>
    </DarkPageShell>
  );

  return (
    <DarkPageShell>
      {/* Header + Tab toggle */}
      <div className="flex flex-col gap-3 print:hidden lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-500">Requisitions</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Store Requisitions</h2>
          <p className="mt-1 text-sm text-zinc-500">Manage store demands and route against HQ Finished Goods.</p>
        </div>
        <div className="flex rounded-lg border border-white/10 bg-[#151515] p-1 shadow-inner shadow-black/30">
          <button onClick={() => setActiveTab("overview")}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${activeTab === "overview" ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20" : "text-zinc-400 hover:text-white"}`}>
            Store Requisitions
          </button>
          <button onClick={() => setActiveTab("hq-production")}
            className={`flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${activeTab === "hq-production" ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20" : "text-zinc-400 hover:text-white"}`}>
            <ClipboardList className="h-4 w-4" /> HQ Production
          </button>
        </div>
      </div>

      {activeTab === "overview" ? (
        <>
          <div className="flex flex-col items-start justify-between gap-4 print:hidden sm:flex-row sm:items-center">
            <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
              <button onClick={createMockRequest}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-[#151515] px-4 py-2 text-sm font-medium text-zinc-300 shadow-sm transition-colors hover:bg-[#1f1f1f] sm:w-auto">
                <Sparkles className="h-4 w-4 text-blue-300" /> + Mock Store Req
              </button>
              <button onClick={() => handleFulfillSelected()} disabled={selectedReqIds.length === 0}
                className={`flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium shadow-sm transition-colors sm:w-auto ${selectedReqIds.length > 0 ? "bg-blue-600 text-white shadow-blue-600/20 hover:bg-blue-500" : "cursor-not-allowed bg-[#202020] text-zinc-600"}`}>
                <PackageCheck className="h-4 w-4" /> Fulfill ({selectedReqIds.length}) Requests
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Pending Workflow", value: pendingCount.toString(), tone: "amber", icon: <Clock className="h-5 w-5" /> },
              { label: "Open Backorders", value: backorderCount.toString(), tone: "red", icon: <AlertCircle className="h-5 w-5" /> },
              { label: "Top Consuming Location", value: topLocation, tone: "blue", icon: <MapPin className="h-5 w-5" /> },
              { label: "Total Value Supplied", value: `$${totalValueSupplied.toFixed(2)}`, tone: "emerald", icon: <CircleDollarSign className="h-5 w-5" /> },
            ].map((stat, i) => (
              <Card key={i} className="rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
                <CardContent className="flex items-start justify-between p-4">
                  <div>
                    <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{stat.label}</span>
                    <span className="mt-3 block text-2xl font-semibold tracking-tight text-white">{stat.value}</span>
                  </div>
                  <div className={`rounded-lg p-2 ${
                    stat.tone === "emerald" ? "bg-emerald-500/15 text-emerald-300" :
                    stat.tone === "amber" ? "bg-amber-500/15 text-amber-300" :
                    stat.tone === "red" ? "bg-red-500/15 text-red-300" :
                    "bg-blue-500/15 text-blue-300"
                  }`}>
                    {stat.icon}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="overflow-hidden rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.32)]">
            <CardHeader className="flex flex-col justify-between gap-3 border-b border-white/10 bg-[#111111] px-4 py-4 sm:flex-row sm:items-center">
              <div className="relative w-full sm:w-[400px]">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="h-4 w-4 text-zinc-500" />
                </div>
                <input type="text" placeholder="Search Req ID, location, or requester…" value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#171717] py-2 pl-9 pr-4 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
              <div className="flex flex-wrap gap-2">
                <select className="rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm font-medium text-zinc-200 shadow-sm outline-none focus:ring-1 focus:ring-blue-500"
                  value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                  <option value="all">All Statuses</option>
                  <option value="draft">Draft</option>
                  <option value="submitted">Submitted</option>
                  <option value="approved">Approved</option>
                  <option value="partial">Partial</option>
                  <option value="backordered">Backordered</option>
                  <option value="fulfilled">Fulfilled</option>
                  <option value="rejected">Rejected</option>
                </select>
                {/* Location filter: hidden for location_manager — RLS already isolates their data */}
                {profile?.role !== "location_manager" && (
                  <select
                    className="rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm font-medium text-zinc-200 shadow-sm outline-none focus:ring-1 focus:ring-blue-500"
                    value={filterLocation}
                    onChange={(e) => setFilterLocation(e.target.value)}
                  >
                    <option value="All">All Locations (HQ View)</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                )}
                {profile?.role === "location_manager" && profile.locationId && (
                  <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm font-medium text-zinc-200">
                    <MapPin className="h-3.5 w-3.5 text-blue-300" />
                    {profile.locationId}
                  </div>
                )}
                {/* Date range filters */}
                <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                  From
                  <input type="date" value={filterFromDate} onChange={(e) => setFilterFromDate(e.target.value)}
                    className="rounded-lg border border-white/10 bg-[#171717] px-2 py-2 text-sm text-zinc-200 shadow-sm outline-none focus:ring-1 focus:ring-blue-500" />
                </label>
                <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                  To
                  <input type="date" value={filterToDate} onChange={(e) => setFilterToDate(e.target.value)}
                    className="rounded-lg border border-white/10 bg-[#171717] px-2 py-2 text-sm text-zinc-200 shadow-sm outline-none focus:ring-1 focus:ring-blue-500" />
                </label>
                {(filterStatus !== "all" || filterLocation !== "All" || filterFromDate || filterToDate || searchQuery) && (
                  <button onClick={() => { setFilterStatus("all"); setFilterLocation("All"); setFilterFromDate(""); setFilterToDate(""); setSearchQuery(""); }}
                    className="rounded-lg border border-white/10 bg-[#151515] px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:bg-[#202020] hover:text-white">
                    Clear filters
                  </button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader className="border-b border-white/10 bg-[#161616] text-xs uppercase tracking-[0.16em] text-zinc-500">
                  <TableRow>
                    <TableHead className="w-[40px] px-6 py-3">
                      <input type="checkbox" className="rounded border-white/20 bg-[#171717] text-blue-600 focus:ring-blue-500"
                        onChange={(e) => {
                          if (e.target.checked) {
                            const approvedIds = filteredReqs.filter((r) => FULFILLABLE_STATUSES.has((r.status ?? "").toLowerCase())).map((r) => r.id);
                            setSelectedReqIds((prev) => Array.from(new Set([...prev, ...approvedIds])));
                          } else setSelectedReqIds([]);
                        }} />
                    </TableHead>
                    <TableHead className="py-3">Request ID</TableHead>
                    <TableHead className="py-3">Location</TableHead>
                    <TableHead className="py-3">Requested By</TableHead>
                    <TableHead className="py-3">Date</TableHead>
                    <TableHead className="py-3">Items</TableHead>
                    <TableHead className="py-3">Req. Value</TableHead>
                    <TableHead className="py-3">Status</TableHead>
                    <TableHead className="px-6 py-3 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredReqs.length > 0 ? filteredReqs.map((req) => (
                    <TableRow key={req.id}
                      className={`cursor-pointer border-b border-white/5 transition-colors hover:bg-[#171717] ${selectedReqIds.includes(req.id) ? "bg-blue-500/10" : "bg-[#111111]"}`}
                      onClick={(e) => { if ((e.target as HTMLElement).closest('input[type="checkbox"]')) return; setSelectedReq(req); }}>
                      <TableCell className="px-6">
                        <input type="checkbox" checked={selectedReqIds.includes(req.id)} onChange={() => handleToggleSelect(req.id)}
                          disabled={!FULFILLABLE_STATUSES.has((req.status ?? "").toLowerCase())}
                          className="rounded border-white/20 bg-[#171717] text-blue-600 focus:ring-blue-500 disabled:opacity-50" />
                      </TableCell>
                      <TableCell className="py-4 font-semibold text-zinc-100">
                        <div className="flex items-center gap-2"><Inbox className="h-4 w-4 text-zinc-500" />{req.id}</div>
                      </TableCell>
                      <TableCell className="py-4 text-sm font-medium text-zinc-100">
                        <div className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 text-zinc-600" />{req.location}</div>
                      </TableCell>
                      <TableCell className="py-4 text-sm text-zinc-400">{req.requestedBy || req.requestedby || "—"}</TableCell>
                      <TableCell className="py-4 text-sm text-zinc-500">
                        <div className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5 text-zinc-600" />{req.date}</div>
                      </TableCell>
                      <TableCell className="py-4 text-sm font-medium text-zinc-300">{req.items}</TableCell>
                       <TableCell className="py-4 text-sm font-semibold">
                        {(() => {
                          const { amount, isEstimate } = getDisplayValue(req);
                          const status = (req.status ?? "").toLowerCase();
                          const isFulfilled = FULFILLED_STATUSES.has(status);
                          return (
                            <span className={isFulfilled ? "text-emerald-300" : "text-zinc-200"}>
                              ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              {isEstimate && !isFulfilled && (
                                <span className="ml-1 align-middle text-[10px] font-normal text-zinc-600">est.</span>
                              )}
                            </span>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="py-4">{(() => {
                        // Compute visual status from cached line items when DB status = fulfilled.
                        // DB only stores: draft/submitted/approved/rejected/fulfilled.
                        // partial/backordered are display-only derived from line quantities.
                        const dbStatus = (req.status ?? "").toLowerCase();
                        if (dbStatus !== "fulfilled") return <StatusBadge status={req.status} />;
                        const items = reqItemsCache.get(req.id);
                        if (!items?.length) return <StatusBadge status={req.status} />;
                        const allDone = items.every((li: any) =>
                          Number(li.quantityFulfilled ?? 0) >= Number(li.quantityRequested)
                        );
                        const anyFulfilled = items.some((li: any) =>
                          Number(li.quantityFulfilled ?? 0) > 0
                        );
                        const visual = allDone ? "fulfilled" : anyFulfilled ? "partial" : "backordered";
                        return <StatusBadge status={visual} />;
                      })()}</TableCell>
                      <TableCell className="px-6 py-4 text-right">
                        <span className="text-sm font-medium text-blue-300 transition-colors hover:text-blue-200">Review</span>
                      </TableCell>
                    </TableRow>
                  )) : (
                    <TableRow>
                      <TableCell colSpan={9} className="py-10 text-center text-sm text-zinc-500">No matching requests.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Review Drawer */}
          <Drawer isOpen={!!selectedReq} onClose={() => { setSelectedReq(null); setHqReqItems([]); }}
            title={`Requisition ${selectedReq?.id}`}
            description={`Submitted by ${selectedReq?.requestedBy || selectedReq?.requestedby || "—"} from ${selectedReq?.location} on ${selectedReq?.date}`}
            footer={
              <div className="w-full flex flex-col gap-2">
                {/* ── Fulfillment summary (shown once locked or fulfilled) ────── */}
                {(() => {
                  const status = (selectedReq?.status ?? "").toLowerCase();
                  if (!isFulfillmentLocked && !["fulfilled", "partial", "backordered"].includes(status)) return null;
                  if (!isFulfillmentLocked && status === "approved") return null;
                  // Compute final status from current in-memory items
                  const items = hqReqItems;
                  if (!items.length) return null;
                  const allDone = items.every((li: any) =>
                    (fulfillDraftMap.get(li.id) ?? Number(li.quantityFulfilled ?? 0)) >= Number(li.quantityRequested)
                  );
                  const anyFulfilled = items.some((li: any) =>
                    (fulfillDraftMap.get(li.id) ?? Number(li.quantityFulfilled ?? 0)) > 0
                  );
                  const finalStatus = allDone ? "fulfilled" : anyFulfilled ? "partial" : "backordered";
                  const fulfilledVal = items.reduce((sum: number, li: any) => {
                    const qty = fulfillDraftMap.get(li.id) ?? Number(li.quantityFulfilled ?? 0);
                    return sum + qty * Number(li.unitPrice ?? 0);
                  }, 0);
                  return (
                    <div className="flex items-center gap-3 bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-2.5">
                      <StatusBadge status={finalStatus} />
                      <span className="text-sm text-neutral-600">Fulfillment finalized</span>
                      <span className="ml-auto text-sm font-bold text-success-700">${fulfilledVal.toFixed(2)} supplied</span>
                    </div>
                  );
                })()}
                <div className="flex items-center justify-between w-full border-t border-neutral-200 pt-4 mt-2">
                  <div className="flex flex-col">
                    <span className="text-xs font-semibold uppercase text-neutral-500 tracking-wider">Value Supplied</span>
                    <span className="text-xl font-bold text-success-600 flex items-center gap-1">
                      <CircleDollarSign className="h-5 w-5" />
                      {selectedReq ? getReqValue(selectedReq).toFixed(2) : "0.00"}
                      <span className="text-sm font-medium text-neutral-400">/ ${selectedReq ? getReqRequestedValue(selectedReq).toFixed(2) : "0.00"}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {/* Approve / Reject — only for submitted/draft */}
                    {["submitted", "draft"].includes((selectedReq?.status ?? "").toLowerCase()) && (
                      <>
                        <button onClick={() => handleUpdateReqStatus(selectedReq.id, "rejected")}
                          className="px-4 py-2 text-sm font-medium bg-white border border-danger-200 text-danger-700 rounded-lg hover:bg-danger-50 transition-colors shadow-sm flex items-center gap-2">
                          <XSquare className="h-4 w-4" /> Reject
                        </button>
                        <button onClick={() => handleUpdateReqStatus(selectedReq.id, "approved")}
                          className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4" /> Approve
                        </button>
                      </>
                    )}
                    {/* Complete Fulfillment — shown for approved/partial/backordered when NOT locked */}
                    {FULFILLABLE_STATUSES.has((selectedReq?.status ?? "").toLowerCase()) && !isFulfillmentLocked && (
                      <button
                        onClick={async () => {
                          // ── 1. Validate: no unsaved draft changes ────────────────
                          const unsaved = hqReqItems.some((li: any) => {
                            const draft  = fulfillDraftMap.get(li.id);
                            const stored = Number(li.quantityFulfilled ?? 0);
                            return draft !== undefined && draft !== stored;
                          });
                          if (unsaved) {
                            alert("You have unsaved changes. Click off the input fields to save each line before completing.");
                            return;
                          }

                          // ── 2. Always write "fulfilled" to DB ─────────────────────
                          // DB CHECK constraint only allows: draft/submitted/approved/rejected/fulfilled.
                          // partial and backordered are computed UI-display statuses only.
                          const finalStatus = "fulfilled";

                          // ── 3. Persist to DB — minimal UPDATE, no location_id ────
                          const res = await updateRequisitionStatus(selectedReq.id, finalStatus);
                          if (!res.success) {
                            alert(`Failed to save status: ${res.error?.message}`);
                            return;
                          }

                          // ── 4. Compute fulfilled total for local state ─────────────
                          // Used to update the main table value column immediately without
                          // waiting for a page reload or cache re-fetch.
                          const fulfilledTotal = hqReqItems.reduce((sum: number, li: any) => {
                            const qty = fulfillDraftMap.get(li.id) ?? Number(li.quantityFulfilled ?? 0);
                            return sum + qty * Number(li.unitPrice ?? 0);
                          }, 0);

                          // ── 5. Sync local state ───────────────────────────────────────
                          // Update both status AND totalAmount so the main table "Value"
                          // column shows the supplied amount ($260.31) not the requested
                          // total ($380.88) even for rows whose cache was previously busted.
                          setSelectedReq((prev: any) =>
                            prev ? { ...prev, status: finalStatus, totalAmount: fulfilledTotal } : prev
                          );
                          setRequisitions((prev: any[]) =>
                            prev.map(r =>
                              r.id === selectedReq.id
                                ? { ...r, status: finalStatus, totalAmount: fulfilledTotal }
                                : r
                            )
                          );
                          // Repopulate cache with current items so getReqFulfilledValue
                          // can compute the visual badge and amount without another DB round-trip.
                          setReqItemsCache(prev => new Map(prev).set(selectedReq.id, hqReqItems));

                          // ── 6. Lock UI ────────────────────────────────────────────────
                          setIsFulfillmentLocked(true);
                        }}
                        className="px-4 py-2 text-sm font-semibold bg-success-600 text-white rounded-lg hover:bg-success-700 transition-colors shadow-sm flex items-center gap-2"
                      >
                        <PackageCheck className="h-4 w-4" /> Complete Fulfillment
                      </button>
                    )}
                    {/* Edit Fulfillment — unlock after completing */}
                    {FULFILLABLE_STATUSES.has((selectedReq?.status ?? "").toLowerCase()) && isFulfillmentLocked && (
                      <button
                        onClick={() => setIsFulfillmentLocked(false)}
                        className="px-4 py-2 text-sm font-medium bg-white border border-neutral-300 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors shadow-sm flex items-center gap-2"
                      >
                        <CheckCircle2 className="h-4 w-4" /> Edit Fulfillment
                      </button>
                    )}
                    {/* Completed badge — fully fulfilled requisitions */}
                    {(selectedReq?.status ?? "").toLowerCase() === "fulfilled" && !isFulfillmentLocked && (
                      <span className="px-4 py-2 text-sm font-medium text-success-700 flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4" /> Completed
                      </span>
                    )}
                  </div>
                </div>
              </div>
            }>
            <div className="space-y-6">
              <div className="bg-brand-50 border border-brand-100 rounded-lg p-4">
                <h4 className="text-xs font-semibold text-brand-800 uppercase tracking-wider mb-1">Notes / Reason</h4>
                <p className="text-sm text-neutral-700">{selectedReq?.notes || "No notes provided."}</p>
              </div>
              <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden mt-6">
                <Table>
                  <TableHeader className="bg-neutral-50/50 text-[11px] uppercase text-neutral-500 tracking-wider">
                    <TableRow>
                      <TableHead className="py-2 px-4">Item</TableHead>
                      <TableHead className="py-2 text-right">Requested</TableHead>
                      <TableHead className="py-2 text-right">HQ Stock</TableHead>
                      <TableHead className="py-2 text-center">Fulfill Qty</TableHead>
                      <TableHead className="py-2 text-right">Backorder</TableHead>
                      <TableHead className="py-2 text-right">Unit Price</TableHead>
                      <TableHead className="py-2 text-right">Fulfilled $</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {hqItemsLoading ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-6 text-neutral-400 text-sm">
                          <div className="flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" /> Loading items…
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : hqReqItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-6 text-neutral-400 text-sm">
                          No items found for this requisition.
                        </TableCell>
                      </TableRow>
                    ) : (() => {
                      const isEditable = FULFILLABLE_STATUSES.has((selectedReq?.status ?? "").toLowerCase()) && !isFulfillmentLocked;
                      const groups: Record<string, any[]> = {};
                      hqReqItems.forEach((item: any) => {
                        const c = item.sourceCommissary ?? "Commissary HQ";
                        if (!groups[c]) groups[c] = [];
                        groups[c].push(item);
                      });
                      return Object.entries(groups).map(([commissary, groupItems]) => (
                        <React.Fragment key={commissary}>
                          <TableRow className="bg-neutral-50">
                            <TableCell colSpan={7} className="py-1.5 px-4">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold border ${COMMISSARY_COLORS[commissary] ?? "bg-neutral-50 text-neutral-600 border-neutral-200"}`}>
                                {commissary}
                              </span>
                            </TableCell>
                          </TableRow>
                          {groupItems.map((item: any) => {
                            const requested  = Number(item.quantityRequested ?? 0);
                            const draftQty   = fulfillDraftMap.get(item.id) ?? Number(item.quantityFulfilled ?? 0);
                            const hqStock    = item.hqAvailableStock;
                            const maxFulfill = Math.min(requested, hqStock ?? requested);
                            const backorder  = Math.max(0, requested - draftQty);
                            const unitPrice  = Number(item.unitPrice ?? 0);
                            const lineTotal  = draftQty * unitPrice;
                            const lineStatus = draftQty >= requested ? "fulfilled" : draftQty > 0 ? "partial" : "backordered";
                            return (
                              <TableRow key={item.id} className="hover:bg-neutral-50/50">
                                {/* Item + line status */}
                                <TableCell className="py-3 px-4">
                                  <div className="font-medium text-sm text-neutral-900">{item.itemName}</div>
                                  <div className="mt-0.5"><StatusBadge status={lineStatus} /></div>
                                </TableCell>
                                {/* Requested qty */}
                                <TableCell className="py-3 text-right">
                                  <span className="text-sm font-medium text-neutral-800">{requested}</span>
                                  {item.unit && <span className="text-xs text-neutral-400 ml-1">{item.unit}</span>}
                                </TableCell>
                                {/* HQ available stock */}
                                <TableCell className="py-3 text-right">
                                  {hqStock != null ? (
                                    <span className={`text-sm font-semibold ${
                                      hqStock <= 0          ? "text-danger-600"  :
                                      hqStock < requested   ? "text-warning-600" :
                                                              "text-success-600"
                                    }`}>{hqStock}</span>
                                  ) : (
                                    <span className="text-neutral-400 text-sm">—</span>
                                  )}
                                </TableCell>
                                {/* Fulfill qty — controlled, disabled on non-approved */}
                                <TableCell className="py-3 text-center">
                                  <input
                                    type="number"
                                    min={0}
                                    max={maxFulfill}
                                    disabled={!isEditable}
                                    value={draftQty}
                                    onChange={(e) => {
                                      const clamped = Math.max(0, Math.min(maxFulfill, Number(e.target.value)));
                                      setFulfillDraftMap(prev => new Map(prev).set(item.id, clamped));
                                    }}
                                    onBlur={async () => {
                                      const newVal  = fulfillDraftMap.get(item.id) ?? Number(item.quantityFulfilled ?? 0);
                                      const current = Number(item.quantityFulfilled ?? 0);
                                      if (newVal === current) return;
                                      // UI guard: never exceed HQ stock
                                      if (hqStock != null && newVal > hqStock) {
                                        alert(`Cannot fulfill ${newVal} — only ${hqStock} in HQ stock.`);
                                        setFulfillDraftMap(prev => new Map(prev).set(item.id, current));
                                        return;
                                      }
                                      // Optimistic update
                                      setHqReqItems(prev => prev.map(li =>
                                        li.id === item.id ? { ...li, quantityFulfilled: newVal } : li
                                      ));
                                      const res = await updateRequisitionItemFulfilled(item.id, newVal, item.requisitionId);
                                      if (!res.success) {
                                        alert(`Failed to save: ${res.error?.message}`);
                                        // Rollback
                                        setFulfillDraftMap(prev => new Map(prev).set(item.id, current));
                                        setHqReqItems(prev => prev.map(li =>
                                          li.id === item.id ? { ...li, quantityFulfilled: current } : li
                                        ));
                                      } else if (res.newStatus) {
                                        setSelectedReq((prev: any) => prev ? { ...prev, status: res.newStatus } : prev);
                                        setRequisitions((prev: any[]) => prev.map(r =>
                                          r.id === item.requisitionId ? { ...r, status: res.newStatus } : r
                                        ));
                                        // Bust cache so re-open reflects latest fulfilled qtys
                                        setReqItemsCache(prev => { const m = new Map(prev); m.delete(item.requisitionId); return m; });
                                      }
                                    }}
                                    className={`w-20 px-2 py-1 text-sm font-bold rounded-md border text-center ${
                                      !isEditable
                                        ? "bg-neutral-50 text-neutral-400 border-neutral-200 cursor-not-allowed"
                                        : lineStatus === "fulfilled"
                                          ? "border-success-300 bg-success-50 text-success-800"
                                          : "border-neutral-300 bg-white text-neutral-800"
                                    } focus:outline-none focus:ring-2 focus:ring-brand-400`}
                                  />
                                </TableCell>
                                {/* Backorder */}
                                <TableCell className="py-3 text-right">
                                  {backorder > 0
                                    ? <span className="text-sm font-bold text-danger-600">{backorder}</span>
                                    : <span className="text-xs font-bold text-success-600">—</span>}
                                </TableCell>
                                {/* Unit price */}
                                <TableCell className="py-3 text-right">
                                  {unitPrice > 0
                                    ? <span className="text-sm font-medium text-neutral-700">${unitPrice.toFixed(2)}</span>
                                    : <span className="text-neutral-400 text-xs">—</span>}
                                </TableCell>
                                {/* Fulfilled line total */}
                                <TableCell className="py-3 text-right">
                                  <span className="text-sm font-semibold text-success-700">${lineTotal.toFixed(2)}</span>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </React.Fragment>
                      ));
                    })()}
                  </TableBody>
                </Table>
                {/* Footer — fulfilled total + backorder value + hint */}
                {hqReqItems.length > 0 && (() => {
                  const isEditable = FULFILLABLE_STATUSES.has((selectedReq?.status ?? "").toLowerCase()) && !isFulfillmentLocked;
                  const fulfilledVal = hqReqItems.reduce((sum: number, li: any) => {
                    const qty = fulfillDraftMap.get(li.id) ?? Number(li.quantityFulfilled ?? 0);
                    return sum + qty * Number(li.unitPrice ?? 0);
                  }, 0);
                  const requestedVal = hqReqItems.reduce((sum: number, li: any) =>
                    sum + Number(li.quantityRequested) * Number(li.unitPrice ?? 0), 0);
                  const backorderVal = Math.max(0, requestedVal - fulfilledVal);
                  return (
                    <div className="px-4 py-3 bg-neutral-50 border-t border-neutral-200 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-success-700 uppercase tracking-wider">Fulfilled Total</span>
                        <span className="text-base font-bold text-success-700">${fulfilledVal.toFixed(2)}</span>
                      </div>
                      {backorderVal > 0.005 && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-neutral-500">Backorder Value</span>
                          <span className="text-sm font-semibold text-danger-600">${backorderVal.toFixed(2)}</span>
                        </div>
                      )}
                      {!isEditable && (
                        <p className="text-xs text-neutral-400 pt-1 text-center">
                          Approve this requisition to enter fulfillment quantities.
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          </Drawer>
        </>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-neutral-100 pb-4 print:border-none print:pb-0">
            <div>
              <h3 className="text-xl font-bold tracking-tight text-neutral-900 print:text-2xl">HQ Production Summary</h3>
              <p className="text-neutral-500 text-sm print:hidden">Centralized preparation queue for selected date.</p>
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-2 w-full sm:w-auto mt-4 sm:mt-0 print:hidden">
              <input type="date"
                value={new Date(productionDate).toISOString().split("T")[0]}
                onChange={(e) => {
                  const [y, m, d] = e.target.value.split("-");
                  const dDate = new Date(Number(y), Number(m) - 1, Number(d));
                  setProductionDate(dDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }));
                }}
                className="px-3 py-1.5 text-sm font-medium border border-neutral-200 text-neutral-700 bg-white rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500" />
              <button onClick={() => window.print()}
                className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-neutral-900 text-white rounded-lg shadow-sm hover:bg-neutral-800 transition-colors w-full sm:w-auto justify-center">
                <Printer className="h-4 w-4" /> Print Kitchen Sheet
              </button>
            </div>
          </div>

          {/* ── Commissary tabs ─────────────────────────────────────────── */}
          <div className="flex gap-1 bg-neutral-100 p-1 rounded-lg border border-neutral-200 shadow-inner w-fit print:hidden">
            {COMMISSARY_OPTIONS.map(c => {
              const pCount = Object.keys(pendingByCommissary[c] ?? {}).length;
              const dCount = Object.keys(completedByCommissary[c] ?? {}).length;
              const total = pCount + dCount;
              return (
                <button key={c} onClick={() => setActiveCommissary(c)}
                  className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${
                    activeCommissary === c ? "bg-white text-brand-700 shadow-sm" : "text-neutral-600 hover:text-neutral-900"
                  }`}>
                  {c}
                  {total > 0 && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                      activeCommissary === c ? "bg-brand-100 text-brand-700" : "bg-neutral-200 text-neutral-600"
                    }`}>{total}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="print:block space-y-6">
            <div className="hidden print:block text-sm text-neutral-500 mb-4 pb-2 border-b border-neutral-200">Date: {productionDate}</div>

            {/* ── Pending Production ─────────────────────────────────── */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="h-2.5 w-2.5 rounded-full bg-warning-500" />
                <h4 className="text-sm font-bold text-neutral-700 uppercase tracking-wider">Pending Production</h4>
                {pendingEntries.length > 0 && (
                  <span className="ml-1 text-xs font-semibold bg-warning-50 border border-warning-200 text-warning-700 rounded-full px-2 py-0.5">{pendingEntries.length} item{pendingEntries.length !== 1 ? "s" : ""}</span>
                )}
              </div>
              {pendingEntries.length === 0 ? (
                <div className="text-center py-8 bg-neutral-50 border border-neutral-200 border-dashed rounded-xl">
                  <PackageCheck className="h-8 w-8 text-neutral-300 mx-auto mb-2" />
                  <p className="text-sm font-semibold text-neutral-500">No pending items for {activeCommissary} on {productionDate}</p>
                </div>
              ) : renderProductionTable(pendingEntries, "text-brand-700 bg-brand-50")}
            </div>

            {/* ── Completed Today ───────────────────────────────────────── */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="h-2.5 w-2.5 rounded-full bg-success-500" />
                <h4 className="text-sm font-bold text-neutral-700 uppercase tracking-wider">Completed Today</h4>
                {completedEntries.length > 0 && (
                  <span className="ml-1 text-xs font-semibold bg-success-50 border border-success-200 text-success-700 rounded-full px-2 py-0.5">{completedEntries.length} item{completedEntries.length !== 1 ? "s" : ""}</span>
                )}
              </div>
              {completedEntries.length === 0 ? (
                <div className="text-center py-8 bg-neutral-50 border border-neutral-200 border-dashed rounded-xl">
                  <CheckCircle2 className="h-8 w-8 text-neutral-300 mx-auto mb-2" />
                  <p className="text-sm font-semibold text-neutral-500">No fulfilled items for {activeCommissary} on {productionDate}</p>
                </div>
              ) : renderProductionTable(completedEntries, "text-success-700 bg-success-50")}
            </div>
          </div>
        </div>
      )}
    </DarkPageShell>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE ROOT — detects role and renders appropriate view
// ═══════════════════════════════════════════════════════════════════════════════

export default function Requisitions() {
  const [profile, setProfile]         = useState<UserProfile | null>(null);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [finishedGoods, setFinishedGoods]   = useState<any[]>([]);
  const [saleItems, setSaleItems]           = useState<SaleItem[]>([]);
  const [isBootstrapping, setIsBootstrapping] = useState(true);

  useEffect(() => {
    async function boot() {
      clearProfileCache();
      const [prof, inv, fg, si] = await Promise.all([
        getCurrentUserProfile(),
        loadInventory(),
        loadFinishedGoods(),
        loadSaleItems(),
      ]);
      setProfile(prof);
      setInventoryItems(Array.isArray(inv) ? inv : []);
      setFinishedGoods(Array.isArray(fg) ? fg : []);
      setSaleItems(Array.isArray(si) ? si : []);
      setIsBootstrapping(false);
    }
    boot();
  }, []);

  if (isBootstrapping) {
    return (
      <DarkPageShell>
        <div className="flex items-center justify-center gap-2 p-16 text-zinc-500">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      </DarkPageShell>
    );
  }

  // ── No profile: user is authenticated but has no user_profiles row ──────────
  // Do NOT fall back to HQAdminView — that would silently grant admin access.
  // Show a neutral restricted state with no controls.
  if (!profile) {
    return (
      <div className="flex flex-col items-center justify-center py-24 px-8 text-center space-y-5">
        <div className="w-14 h-14 rounded-full bg-warning-50 border border-warning-200 flex items-center justify-center">
          <AlertCircle className="h-7 w-7 text-warning-500" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-xl font-bold text-neutral-900">Access Not Configured</h2>
          <p className="text-neutral-500 text-sm max-w-sm">
            Your account does not have a role or location assigned yet. Contact your
            administrator to complete your profile setup before accessing requisitions.
          </p>
        </div>
        <div className="bg-neutral-50 border border-neutral-200 rounded-lg px-5 py-3 text-xs text-neutral-400 font-mono">
          No <code className="font-semibold text-neutral-600">user_profiles</code> row found for your auth account.
        </div>
      </div>
    );
  }

  // ── Unknown / unexpected role ────────────────────────────────────────────────
  if (profile.role !== "hq_admin" && profile.role !== "location_manager") {
    return (
      <div className="flex flex-col items-center justify-center py-24 px-8 text-center space-y-5">
        <div className="w-14 h-14 rounded-full bg-danger-50 border border-danger-200 flex items-center justify-center">
          <AlertCircle className="h-7 w-7 text-danger-500" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-xl font-bold text-neutral-900">Unrecognized Role</h2>
          <p className="text-neutral-500 text-sm max-w-sm">
            Your account has an unrecognized role value{" "}
            <code className="font-semibold text-neutral-700">"{profile.role}"</code>. Contact
            your administrator to correct your role assignment.
          </p>
        </div>
      </div>
    );
  }

  if (profile.role === "hq_admin") {
    return <HQAdminView finishedGoods={finishedGoods} profile={profile} />;
  }

  return <LocationManagerView profile={profile} inventoryItems={inventoryItems} saleItems={saleItems} />;

}
