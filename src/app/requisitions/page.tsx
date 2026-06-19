"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
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
  Truck,
  X,
  Warehouse,
  Save,
} from "lucide-react";
import { isActiveLocation, isStoreLocation } from "@/lib/locationRegistry";
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
  loadOutletCatalog,
  loadBackorders,
  loadBackorderFulfillments,
  fulfillBackorder,
  createDeliveryTicketFromRequisition,
  getDeliveryTicketForRequisition,
  saveRequisitionEdits,
  type SaleItem,
  type OutletCatalogItem,
} from "@/lib/storage";
import {
  getCurrentUserProfile,
  getCurrentUserId,
  clearProfileCache,
  type UserProfile,
} from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { isHqFulfillment } from "@/lib/roles";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface LineItemDraft {
  // Exactly one of the three FKs will be set:
  itemId:            string | null;  // inventory_items.id (HQ raw mode)
  finishedGoodId:    string | null;  // hq_sale_items.id  (HQ FG mode)
  catalogItemId:     string | null;  // outlet_catalog_items.item_id (local vendor)
  sourceType:        'hq_supplied' | 'local_vendor';
  supplierSnapshot:  string | null;  // snapshot at selection time
  itemName:          string;         // snapshot: captured at selection time
  unit:              string;         // snapshot: captured at selection time
  packQty:           number;         // how many base units per pack; 1 for single-unit items
  unitPrice:         number;         // pack price = effectivePrice * packQty (captured at selection)
  quantityRequested: number;         // number of packs (or units when packQty=1)
  sourceCommissary:  string;         // snapshot: which commissary fulfills this line
  requisitionItemId?: string | null;
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

  @media print {
    html, body,
    body .flex.bg-neutral-50.text-neutral-900.min-h-screen,
    div[class*="min-h-screen"],
    div[class*="h-screen"],
    div[class*="overflow-hidden"],
    div[class*="overflow-y-auto"],
    main,
    main[class*="overflow-y-auto"],
    .scroll-container,
    .overflow-auto,
    .overflow-y-auto {
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      overflow: visible !important;
      position: relative !important;
      background: #ffffff !important;
      color: #000000 !important;
    }

    aside,
    header,
    nav,
    .print\:hidden,
    .print-hidden,
    .no-print,
    button,
    input,
    select,
    [role="tablist"],
    .bg-neutral-100.p-1.rounded-lg.border {
      display: none !important;
    }

    .hq-production-print-area {
      display: block !important;
      width: 100% !important;
      background: #ffffff !important;
      color: #000000 !important;
    }

    .hq-production-print-area table,
    .hq-production-print-area td,
    .hq-production-print-area th,
    .hq-production-print-area tr {
      background: #ffffff !important;
      color: #000000 !important;
      border-color: #e5e7eb !important;
    }

    .hq-production-print-area span {
      background: transparent !important;
      color: #000000 !important;
      border: none !important;
    }

    tr.hidden.print\:table-row {
      display: table-row !important;
    }

    .print-row, tr, table {
      break-inside: avoid !important;
      page-break-inside: avoid !important;
    }
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
  const [editingRequisitionId, setEditingRequisitionId] = useState<string | null>(null);
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
  // Local vendor catalog items (from outlet_catalog_items)
  const [localCatalogItems, setLocalCatalogItems] = useState<OutletCatalogItem[]>([]);

  const [activeHistoryTab, setActiveHistoryTab] = useState<"orders" | "backorders">("orders");
  const [backorders, setBackorders] = useState<any[]>([]);
  const [backordersLoading, setBackordersLoading] = useState(false);
  const [boSearchQuery, setBoSearchQuery] = useState("");
  const [boFilterStatus, setBoFilterStatus] = useState("all");

  const fetchReqs = useCallback(async () => {
    setIsLoading(true);
    try {
      const [rows, localCat, bo] = await Promise.all([
        loadRequisitions(profile.locationId),
        loadOutletCatalog(false, profile), // active items only
        loadBackorders(profile.locationId || undefined),
      ]);
      setRequisitions(Array.isArray(rows) ? rows : []);
      setLocalCatalogItems(
        (Array.isArray(localCat) ? localCat : [])
          .filter((c: OutletCatalogItem) =>
            c.isActive &&
            c.orderingEnabled &&
            c.sourceType === 'local_vendor'
          )
      );
      setBackorders(Array.isArray(bo) ? bo : []);
    } finally {
      setIsLoading(false);
    }
  }, [profile.locationId]);

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

  const filteredBackorders = useMemo(() => {
    return backorders.filter((bo) => {
      const boStatus = (bo.status ?? "").toLowerCase();
      const filterStatus = boFilterStatus.toLowerCase();
      if (filterStatus !== "all" && boStatus !== filterStatus) return false;

      if (boSearchQuery) {
        const q = boSearchQuery.toLowerCase();
        if (
          !String(bo.itemName || "").toLowerCase().includes(q) &&
          !String(bo.itemId || "").toLowerCase().includes(q) &&
          !String(bo.originalRequisitionId || "").toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [backorders, boFilterStatus, boSearchQuery]);

  const catalogItems = useMemo(() => {
    // ── HQ items (FG mode or raw mode) ─────────────────────────────────────
    let hqItems: any[] = [];
    if (fgMode) {
      hqItems = saleItems
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
            sourceType: 'hq_supplied' as const,
            added: lineItems.some(li => li.finishedGoodId === s.id),
            packQty,
            baseUnit: s.baseUnit,
          };
        });
    } else {
      hqItems = inventoryItems.map(i => {
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
          sourceType: 'hq_supplied' as const,
          added: lineItems.some(li => li.itemId === i.id),
        };
      });
    }

    // ── Local vendor items (outlet_catalog_items) ────────────────────────
    const localItems = localCatalogItems.map(c => ({
      id: c.itemId,
      name: c.name,
      category: c.category || c.type || "Local Vendor",
      unit: c.uom || "unit",
      hqStock: null, // local vendor items have no HQ stock
      cost: c.price,
      supplier: c.supplier || "Unassigned Supplier",
      storage: c.supplier || "Local Vendor",
      status: "available" as const,
      sourceType: 'local_vendor' as const,
      packQty: c.packQty,
      added: lineItems.some(li => li.catalogItemId === c.itemId),
    }));

    return [...hqItems, ...localItems];
  }, [fgMode, inventoryItems, lineItems, saleItems, localCatalogItems]);

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

  const draftTotal = lineItems.filter(li => li.quantityRequested > 0).reduce((sum, li) => sum + li.quantityRequested * li.unitPrice, 0);
  const lowStockCount = catalogItems.filter(i => i.status === "low_stock" || i.status === "out_of_stock" || i.status === "not_available").length;
  const lastSubmittedOrder = requisitions[0]?.id ?? "None";

  const addItemById = (itemId: string) => {
    if (!itemId) return;
    // Only add if user has explicitly typed a qty > 0. Never default to 1.
    const rawQty = catalogQtyById[itemId];
    const quantity = Math.max(0, Number(rawQty ?? 0));
    if (quantity <= 0) return; // user must enter a positive number first

    // ── Local vendor path ──────────────────────────────────────────────────
    const localItem = localCatalogItems.find(c => c.itemId === itemId);
    if (localItem) {
      if (lineItems.some(li => li.catalogItemId === localItem.itemId)) return; // already added
      const packQty = localItem.packQty > 0 ? localItem.packQty : 1;
      setLineItems(prev => [
        ...prev,
        {
          itemId:            null,
          finishedGoodId:    null,
          catalogItemId:     localItem.itemId,
          sourceType:        'local_vendor',
          supplierSnapshot:  localItem.supplier ?? null,
          itemName:          localItem.name,
          unit:              localItem.uom || 'unit',
          packQty,
          unitPrice:         localItem.price,
          quantityRequested: quantity,
          sourceCommissary:  localItem.supplier || 'Local Vendor',
        },
      ]);
      return;
    }

    // ── HQ FG path ───────────────────────────────────────────────────
    if (fgMode) {
      const saleItem = saleItems.find(s => s.id === itemId);
      if (!saleItem) return;
      if (lineItems.some(li => li.finishedGoodId === saleItem.id)) return;
      const packQty = (saleItem.packQty != null && saleItem.packQty > 0) ? saleItem.packQty : 1;
      const packPrice = saleItem.effectivePrice * packQty;
      const packCount = Math.ceil(quantity / packQty);
      setLineItems(prev => [
        ...prev,
        {
          itemId:            null,
          finishedGoodId:    saleItem.id,
          catalogItemId:     null,
          sourceType:        'hq_supplied',
          supplierSnapshot:  saleItem.sourceCommissary || 'Commissary HQ',
          itemName:          saleItem.name,
          unit:              saleItem.baseUnit,
          packQty,
          unitPrice:         packPrice,
          quantityRequested: packCount,
          sourceCommissary:  saleItem.sourceCommissary,
        },
      ]);
    } else {
      // ── HQ raw inventory path ───────────────────────────────────────
      if (lineItems.some(li => li.itemId === itemId)) return;
      const inv = inventoryItems.find(i => i.id === itemId);
      if (!inv) return;
      setLineItems(prev => [
        ...prev,
        {
          itemId:            inv.id,
          finishedGoodId:    null,
          catalogItemId:     null,
          sourceType:        'hq_supplied',
          supplierSnapshot:  inv.supplierName || inv.supplier || 'Commissary HQ',
          itemName:          inv.name,
          unit:              inv.unit || inv.baseUnit || "",
          packQty:           1,
          unitPrice:         Number(inv.cost ?? 0),
          quantityRequested: quantity,
          sourceCommissary:  "Commissary HQ",
        },
      ]);
    }
  };

  const removeLineItem = (id: string) =>
    setLineItems(prev => prev.filter(li => (li.catalogItemId ?? li.finishedGoodId ?? li.itemId) !== id));

  const updateQty = (id: string, qty: number) =>
    setLineItems(prev =>
      prev.map(li => (li.catalogItemId ?? li.finishedGoodId ?? li.itemId) === id ? { ...li, quantityRequested: Math.max(0, qty) } : li)
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
          item_id:                     li.catalogItemId ? null : (li.finishedGoodId ? null : li.itemId),
          finished_good_id:            li.finishedGoodId ?? null,
          catalog_item_id:             li.catalogItemId ?? null,
          source_type:                 li.sourceType,
          supplier_snapshot:           li.supplierSnapshot ?? null,
          pack_qty_snapshot:           li.packQty ?? 1,
          item_name_snapshot:          li.itemName,
          unit_snapshot:               li.unit,
          source_commissary_snapshot:  li.sourceType === 'local_vendor' ? null : (li.sourceCommissary ?? "Commissary HQ"),
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

  const handleStartEditRequisition = () => {
    if (!selectedReq) return;
    
    const draftItems: LineItemDraft[] = reqLineItems.map((li: any) => {
      const isLocal = li.sourceType === 'local_vendor' || li.source_type === 'local_vendor';
      
      return {
        itemId:            isLocal ? null : (li.finishedGoodId || li.finished_good_id ? null : (li.itemId ?? li.item_id)),
        finishedGoodId:    isLocal ? null : (li.finishedGoodId ?? li.finished_good_id ?? null),
        catalogItemId:     isLocal ? (li.catalogItemId ?? li.catalog_item_id ?? li.itemId ?? li.item_id) : null,
        sourceType:        isLocal ? 'local_vendor' : 'hq_supplied',
        supplierSnapshot:  li.supplierSnapshot ?? li.supplier_snapshot ?? null,
        itemName:          li.itemName ?? li.item_name_snapshot,
        unit:              li.unit ?? li.unit_snapshot,
        packQty:           li.packQtySnapshot ?? li.packQty ?? 1,
        unitPrice:         li.unitPrice ?? li.unit_price ?? 0,
        quantityRequested: li.quantityRequested ?? li.quantity_requested ?? 0,
        sourceCommissary:  li.sourceCommissary ?? li.source_commissary_snapshot ?? 'Commissary HQ',
        requisitionItemId: li.id,
      };
    });
    
    setLineItems(draftItems);
    setDraftNotes(selectedReq.notes || "");
    setEditingRequisitionId(selectedReq.id);
    setSelectedReq(null);
    setReqLineItems([]);
  };

  const handleUpdateRequisition = async () => {
    if (!editingRequisitionId) return;
    setSaveError(null);
    if (lineItems.length === 0) { setSaveError("Add at least one item."); return; }
    if (lineItems.some(li => li.quantityRequested <= 0)) {
      setSaveError("All items must have a quantity greater than 0.");
      return;
    }

    setIsSaving(true);
    try {
      const res = await saveRequisitionEdits(
        editingRequisitionId,
        draftNotes,
        lineItems.map(li => ({
          requisitionItemId:           li.requisitionItemId ?? null,
          item_id:                     li.catalogItemId ? null : (li.finishedGoodId ? null : li.itemId),
          finished_good_id:            li.finishedGoodId ?? null,
          catalog_item_id:             li.catalogItemId ?? null,
          source_type:                 li.sourceType,
          supplier_snapshot:           li.supplierSnapshot ?? null,
          pack_qty_snapshot:           li.packQty ?? 1,
          item_name_snapshot:          li.itemName,
          unit_snapshot:               li.unit,
          source_commissary_snapshot:  li.sourceType === 'local_vendor' ? null : (li.sourceCommissary ?? "Commissary HQ"),
          quantity_requested:          li.quantityRequested,
          unit_price:                  li.unitPrice,
          line_total:                  parseFloat((li.quantityRequested * li.unitPrice).toFixed(2)),
        }))
      );

      if (!res.success) {
        setSaveError(res.error?.message ?? "Save failed. Check console.");
        return;
      }

      const notifyRes = await sendHqRequisitionNotification(editingRequisitionId);
      if (notifyRes.success) {
        showSubmitNotice("success", "Changes saved. HQ notification email sent.");
      } else {
        console.warn("[Requisitions] HQ notification failed:", notifyRes.error);
        showSubmitNotice("warning", "Changes saved. HQ email notification failed.");
      }

      setLineItems([]);
      setDraftNotes("");
      setEditingRequisitionId(null);
      await fetchReqs();
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setLineItems([]);
    setDraftNotes("");
    setEditingRequisitionId(null);
    setSaveError(null);
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
              disabled={isSaving || lineItems.filter(li => li.quantityRequested > 0).length === 0}
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
            { label: "Items in Cart", value: lineItems.filter(li => li.quantityRequested > 0).length, icon: <ShoppingCart className="h-5 w-5" /> },
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

        {editingRequisitionId && (
          <div className="rounded-2xl border border-indigo-200 bg-indigo-50/80 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shadow-sm animate-in fade-in slide-in-from-top duration-200">
            <div className="flex items-start sm:items-center gap-3">
              <AlertCircle className="h-5 w-5 text-indigo-600 shrink-0 mt-0.5 sm:mt-0 animate-pulse" />
              <div>
                <p className="text-sm font-semibold text-indigo-900">Editing Requisition Mode Active</p>
                <p className="text-xs text-indigo-700 mt-0.5">
                  You are editing requisition <strong className="font-semibold text-indigo-900">{editingRequisitionId}</strong>. You can modify quantities, remove items, or add new items from the catalog. Click "Save Changes" to apply or "Cancel Edit" to discard.
                </p>
              </div>
            </div>
            <button
              onClick={handleCancelEdit}
              className="text-xs font-bold uppercase tracking-wider text-indigo-600 hover:text-indigo-800 transition py-1 px-3 border border-indigo-200 rounded-lg hover:bg-indigo-100/50 bg-white shrink-0 self-start sm:self-center"
            >
              Cancel Edit
            </button>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <main className="space-y-6">
            <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 p-4 sm:p-5">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-950">Catalog</h2>
                    <p className="mt-1 text-sm text-slate-500">Order from HQ Finished Goods or Local Vendor suppliers.</p>
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
                      <TableHead className="py-3">Source</TableHead>
                      <TableHead className="py-3">Category</TableHead>
                      <TableHead className="py-3">Unit</TableHead>
                      <TableHead className="py-3">Supplier</TableHead>
                      <TableHead className="py-3">Cost</TableHead>
                      <TableHead className="py-3">Quantity</TableHead>
                      <TableHead className="py-3 text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleCatalogItems.map(item => {
                      const isLocal = (item as any).sourceType === 'local_vendor';
                      return (
                        <TableRow key={item.id} className="border-slate-100 hover:bg-emerald-50/30">
                          <TableCell className="px-5 py-4">
                            <div className="font-semibold text-slate-950">{item.name}</div>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {!isLocal && renderStockBadge(item.status)}
                              {item.added && <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">Added</span>}
                            </div>
                          </TableCell>
                          <TableCell className="py-4">
                            {isLocal
                              ? <span className="inline-flex rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-700">Local Vendor</span>
                              : <span className="inline-flex rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-700">HQ Supplied</span>
                            }
                          </TableCell>
                          <TableCell className="py-4 text-sm text-slate-600">{item.category}</TableCell>
                          <TableCell className="py-4 text-sm text-slate-600">{item.unit}</TableCell>
                          <TableCell className="py-4 text-sm text-slate-600">{item.supplier || "—"}</TableCell>
                          <TableCell className="py-4 text-sm font-semibold text-slate-800">{item.cost > 0 ? `$${item.cost.toFixed(2)}` : "-"}</TableCell>
                          <TableCell className="py-4">
                            <input
                              type="number"
                              min={0}
                              value={catalogQtyById[item.id] ?? 0}
                              onChange={(e) => {
                                const newQty = Math.max(0, Number(e.target.value) || 0);
                                setCatalogQtyById(prev => ({ ...prev, [item.id]: newQty }));
                                // If item is already in cart and user zeroes out, remove it
                                if (newQty <= 0 && item.added) {
                                  setLineItems(prev => prev.filter(li => (li.catalogItemId ?? li.finishedGoodId ?? li.itemId) !== item.id));
                                }
                                // If item is already in cart and user changes qty, sync cart qty too
                                if (newQty > 0 && item.added) {
                                  setLineItems(prev => prev.map(li => {
                                    if ((li.catalogItemId ?? li.finishedGoodId ?? li.itemId) === item.id) {
                                      const isFG = !!li.finishedGoodId;
                                      const resolvedQty = isFG ? Math.ceil(newQty / (li.packQty || 1)) : newQty;
                                      return { ...li, quantityRequested: resolvedQty };
                                    }
                                    return li;
                                  }));
                                }
                              }}
                              className="h-10 w-20 rounded-lg border border-slate-200 px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
                            />
                          </TableCell>
                          <TableCell className="py-4 text-right">
                            <button
                              type="button"
                              onClick={() => addItemById(item.id)}
                              disabled={item.added || (catalogQtyById[item.id] ?? 0) <= 0}
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
                  const isLocal = (item as any).sourceType === 'local_vendor';
                  return (
                    <div key={item.id} className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold text-slate-950">{item.name}</h3>
                          <p className="mt-1 text-sm text-slate-500">{item.category} · {item.unit}</p>
                          {item.supplier && <p className="mt-0.5 text-xs text-slate-400">{item.supplier}</p>}
                        </div>
                        {isLocal
                          ? <span className="inline-flex rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-700 shrink-0">Local Vendor</span>
                          : renderStockBadge(item.status)
                        }
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        {isLocal
                          ? <div><span className="text-slate-500">Supplier</span><p className="font-semibold text-slate-900">{item.supplier || "—"}</p></div>
                          : <div><span className="text-slate-500">HQ Stock</span><p className="font-semibold text-slate-900">{item.hqStock}</p></div>
                        }
                        <div><span className="text-slate-500">Cost</span><p className="font-semibold text-slate-900">{item.cost > 0 ? `$${item.cost.toFixed(2)}` : "-"}</p></div>
                      </div>
                      <div className="mt-4 flex gap-2">
                        <input
                          type="number"
                          min={0}
                          value={catalogQtyById[item.id] ?? 0}
                          onChange={(e) => {
                            const newQty = Math.max(0, Number(e.target.value) || 0);
                            setCatalogQtyById(prev => ({ ...prev, [item.id]: newQty }));
                            if (newQty <= 0 && item.added) {
                              setLineItems(prev => prev.filter(li => (li.catalogItemId ?? li.finishedGoodId ?? li.itemId) !== item.id));
                            }
                            if (newQty > 0 && item.added) {
                              setLineItems(prev => prev.map(li =>
                                (li.catalogItemId ?? li.finishedGoodId ?? li.itemId) === item.id
                                  ? { ...li, quantityRequested: newQty }
                                  : li
                              ));
                            }
                          }}
                          className="h-11 w-24 rounded-lg border border-slate-200 px-3 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => addItemById(item.id)}
                          disabled={item.added || (catalogQtyById[item.id] ?? 0) <= 0}
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
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => setActiveHistoryTab("orders")}
                      className={`text-lg font-semibold border-b-2 px-1 pb-1 transition ${
                        activeHistoryTab === "orders" ? "border-emerald-600 text-slate-955" : "border-transparent text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      Recent Requisitions
                    </button>
                    <button
                      onClick={() => setActiveHistoryTab("backorders")}
                      className={`text-lg font-semibold border-b-2 px-1 pb-1 transition flex items-center gap-1.5 ${
                        activeHistoryTab === "backorders" ? "border-emerald-600 text-slate-955" : "border-transparent text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      Backorders
                      {backorders.filter(b => b.status === 'open' || b.status === 'partially_fulfilled').length > 0 && (
                        <span className="bg-rose-100 text-rose-700 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                          {backorders.filter(b => b.status === 'open' || b.status === 'partially_fulfilled').length}
                        </span>
                      )}
                    </button>
                  </div>
                  <p className="mt-2 text-sm text-slate-500">
                    {activeHistoryTab === "orders"
                      ? "Review submitted orders and their current status."
                      : "Outstanding backorder items owed to your location."}
                  </p>
                </div>

                {activeHistoryTab === "orders" ? (
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
                ) : (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="relative sm:w-64">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Search backorder items"
                        value={boSearchQuery}
                        onChange={(e) => setBoSearchQuery(e.target.value)}
                        className="min-h-11 w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none ring-emerald-600 focus:ring-2"
                      />
                    </div>
                    <select
                      value={boFilterStatus}
                      onChange={(e) => setBoFilterStatus(e.target.value)}
                      className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none ring-emerald-600 focus:ring-2"
                    >
                      <option value="all">All Statuses</option>
                      <option value="open">Open</option>
                      <option value="partially_fulfilled">Partially Fulfilled</option>
                      <option value="fulfilled">Fulfilled</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </div>
                )}
              </div>
              <div className="overflow-x-auto">
                <Table>
                  {activeHistoryTab === "orders" ? (
                    <>
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
                            <TableCell className="px-5 py-4 font-semibold text-slate-955">{req.id}</TableCell>
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
                    </>
                  ) : (
                    <>
                      <TableHeader className="bg-slate-50 text-xs uppercase tracking-[0.14em] text-slate-500">
                        <TableRow>
                          <TableHead className="px-5 py-3">Original Requisition</TableHead>
                          <TableHead className="py-3">Item Name / SKU</TableHead>
                          <TableHead className="py-3 text-right">Requested</TableHead>
                          <TableHead className="py-3 text-right">Fulfilled</TableHead>
                          <TableHead className="py-3 text-right">Remaining</TableHead>
                          <TableHead className="py-3 text-right">Unit Price</TableHead>
                          <TableHead className="py-3">Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredBackorders.length > 0 ? filteredBackorders.map(bo => (
                          <TableRow key={bo.id} className="border-slate-100 hover:bg-slate-50">
                            <TableCell className="px-5 py-4 font-semibold text-slate-955">{bo.originalRequisitionId}</TableCell>
                            <TableCell className="py-4 text-sm">
                              <div className="font-semibold text-slate-900">{bo.itemName}</div>
                              <div className="text-slate-500 text-xs mt-0.5">{bo.itemId} ({bo.sourceType})</div>
                            </TableCell>
                            <TableCell className="py-4 text-right text-sm text-slate-700 font-semibold">
                              {bo.isFGMode ? `${bo.requestedQty} pack${bo.requestedQty !== 1 ? 's' : ''} (${bo.requestedQty * bo.packQty} ${bo.unit})` : `${bo.requestedQty} ${bo.unit}`}
                            </TableCell>
                            <TableCell className="py-4 text-right text-sm text-slate-700">
                              {bo.isFGMode ? `${bo.fulfilledQty} pack${bo.fulfilledQty !== 1 ? 's' : ''} (${bo.fulfilledQty * bo.packQty} ${bo.unit})` : `${bo.fulfilledQty} ${bo.unit}`}
                            </TableCell>
                            <TableCell className="py-4 text-right text-sm font-semibold text-rose-600">
                              {bo.isFGMode ? `${bo.remainingQty} pack${bo.remainingQty !== 1 ? 's' : ''} (${bo.remainingQty * bo.packQty} ${bo.unit})` : `${bo.remainingQty} ${bo.unit}`}
                            </TableCell>
                            <TableCell className="py-4 text-right text-sm text-slate-700">
                              {bo.isFGMode ? `$${Number(bo.unitPrice).toFixed(2)}/pack` : `$${Number(bo.unitPrice).toFixed(2)}`}
                            </TableCell>
                            <TableCell className="py-4"><StatusBadge status={bo.status} /></TableCell>
                          </TableRow>
                        )) : (
                          <TableRow>
                            <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">No backorders found.</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </>
                  )}
                </Table>
              </div>
            </section>
          </main>

          <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 p-5">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">Order Cart</h2>
                  <p className="mt-1 text-sm text-slate-500">{lineItems.filter(li => li.quantityRequested > 0).length} selected item{lineItems.filter(li => li.quantityRequested > 0).length === 1 ? "" : "s"}</p>
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
                      const id = li.catalogItemId ?? li.finishedGoodId ?? li.itemId ?? "";
                      const isLocal = li.sourceType === 'local_vendor';
                      return (
                        <div key={id} className={`rounded-xl border p-3 ${isLocal ? 'border-teal-200 bg-teal-50/30' : 'border-slate-200 bg-white'}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <h3 className="truncate text-sm font-semibold text-slate-950">{li.itemName}</h3>
                                {isLocal
                                  ? <span className="inline-flex rounded-full border border-teal-200 bg-teal-100 px-1.5 py-0.5 text-[10px] font-bold text-teal-700">LOCAL</span>
                                  : <span className="inline-flex rounded-full border border-violet-200 bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">HQ</span>
                                }
                              </div>
                              <p className="mt-1 text-xs text-slate-500">
                                {li.finishedGoodId ? (
                                  <>
                                    Pack Size: {li.packQty} {li.unit} · Pack Price: ${li.unitPrice.toFixed(2)}
                                  </>
                                ) : (
                                  <>
                                    {li.unit} · ${li.unitPrice.toFixed(2)} each
                                  </>
                                )}
                                {li.supplierSnapshot && <span className="ml-1 text-slate-400">· {li.supplierSnapshot}</span>}
                              </p>
                            </div>
                            <button type="button" onClick={() => removeLineItem(id)} className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Remove item">
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                          <div className="mt-3 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                min={1}
                                value={li.quantityRequested}
                                onChange={(e) => updateQty(id, Number(e.target.value))}
                                className="h-10 w-20 rounded-lg border border-slate-200 px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
                              />
                              <span className="text-xs text-slate-500 font-medium">
                                {li.finishedGoodId ? `pack(s) (${li.quantityRequested * li.packQty} ${li.unit})` : li.unit}
                              </span>
                            </div>
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
                  {editingRequisitionId ? (
                    <>
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        disabled={isSaving}
                        className="min-h-11 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Cancel Edit
                      </button>
                      <button
                        type="button"
                        onClick={handleUpdateRequisition}
                        disabled={isSaving || lineItems.length === 0}
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        {isSaving ? "Saving..." : "Save Changes"}
                      </button>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>
              </div>
            </section>
          </aside>
        </div>

      <Drawer
        isOpen={!!selectedReq}
        variant="dialog"
        onClose={() => { setSelectedReq(null); setReqLineItems([]); }}
        title={`Requisition ${selectedReq?.id}`}
        description={`Created ${selectedReq?.date} · Status: ${selectedReq?.status}`}
        footer={
          selectedReq ? (
            <div className="flex items-center justify-between w-full">
              <div>
                {!['submitted', 'pending', 'requested'].includes(String(selectedReq.status || '').toLowerCase()) ? (
                  <span className="text-xs font-semibold text-slate-500 bg-slate-100 rounded-lg px-2.5 py-1 border border-slate-200">
                    Locked after HQ acceptance
                  </span>
                ) : (
                  <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1 border border-emerald-200">
                    Editable pre-acceptance
                  </span>
                )}
              </div>
              <div>
                {['submitted', 'pending', 'requested'].includes(String(selectedReq.status || '').toLowerCase()) && (
                  <button
                    onClick={handleStartEditRequisition}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white transition hover:bg-indigo-700"
                  >
                    Edit Request
                  </button>
                )}
              </div>
            </div>
          ) : null
        }
      >
        <div className="space-y-3">
          {/* Notes — compact inline */}
          <div className="flex items-start gap-1.5 text-sm">
            <span className="shrink-0 font-semibold text-neutral-500 text-xs uppercase tracking-wider pt-0.5">Notes:</span>
            <span className="text-neutral-700">{selectedReq?.notes || <span className="text-neutral-400 italic">No notes provided.</span>}</span>
          </div>

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
                      <TableHead className="py-1.5 px-3">Item</TableHead>
                      <TableHead className="py-1.5 text-right">Requested</TableHead>
                      <TableHead className="py-1.5 text-right">Fulfilled</TableHead>
                      <TableHead className="py-1.5 text-right">Backorder</TableHead>
                      <TableHead className="py-1.5 text-right">Unit Price</TableHead>
                      <TableHead className="py-1.5 text-right">Fulfilled $</TableHead>
                      <TableHead className="py-1.5">Status</TableHead>
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
                      const packQty    = li.isFGMode ? (li.packQtySnapshot ?? 1) : 1;
                      return (
                        <TableRow key={li.id} className="hover:bg-neutral-50/50">
                          <TableCell className="py-2 px-3">
                            <div className="text-sm font-medium text-neutral-800">{li.itemName}</div>
                            {(() => {
                              const bo = backorders.find(b => b.original_requisition_item_id === li.id);
                              if (!bo) return null;
                              const boQty = Number(bo.backorder_qty ?? 0);
                              const boRem = Number(bo.remaining_qty ?? 0);
                              return (
                                <div className="text-[10px] text-neutral-500 mt-1 border-t border-dashed border-neutral-200 pt-1 space-y-0.5">
                                  <div className="font-semibold text-rose-600">
                                    Backordered: {li.isFGMode ? `${boQty} pack${boQty !== 1 ? 's' : ''} (${boQty * packQty} ${li.unit})` : `${boQty} ${li.unit_snapshot || li.unitSnapshot || ''}`}
                                  </div>
                                  <div className="font-medium text-amber-600">
                                    Remaining: {li.isFGMode ? `${boRem} pack${boRem !== 1 ? 's' : ''} (${boRem * packQty} ${li.unit})` : `${boRem} ${li.unit_snapshot || li.unitSnapshot || ''}`}
                                  </div>
                                  <div className="text-neutral-500 capitalize">Status: {bo.status.replace(/_/g, ' ')}</div>
                                </div>
                              );
                            })()}
                          </TableCell>
                          <TableCell className="py-2 text-right text-sm text-neutral-700">
                            {li.isFGMode ? `${requested} pack${requested !== 1 ? 's' : ''} (${requested * packQty} ${li.unit})` : requested}
                          </TableCell>
                          <TableCell className="py-2 text-right">
                            {li.quantityFulfilled != null
                              ? <span className="text-sm font-semibold text-success-700">{li.isFGMode ? `${fulfilled} pack${fulfilled !== 1 ? 's' : ''} (${fulfilled * packQty} ${li.unit})` : fulfilled}</span>
                              : <span className="text-neutral-400 text-xs">—</span>}
                          </TableCell>
                          <TableCell className="py-2 text-right">
                            {backorder > 0
                              ? <span className="text-sm font-bold text-danger-600">{li.isFGMode ? `${backorder} pack${backorder !== 1 ? 's' : ''} (${backorder * packQty} ${li.unit})` : backorder}</span>
                              : <span className="text-xs text-success-600 font-bold">—</span>}
                          </TableCell>
                          <TableCell className="py-2 text-right text-sm text-neutral-700">
                            {unitPrice > 0 ? (li.isFGMode ? `$${unitPrice.toFixed(2)}/pack` : `$${unitPrice.toFixed(2)}`) : <span className="text-neutral-400">—</span>}
                          </TableCell>
                          <TableCell className="py-2 text-right">
                            <span className="text-sm font-semibold text-neutral-800">${lineTotal.toFixed(2)}</span>
                          </TableCell>
                          <TableCell className="py-2">
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
  const router = useRouter();
  const [requisitions, setRequisitions] = useState<any[]>([]);
  const [finishedGoods, setFinishedGoods] = useState<any[]>(initialFG);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterLocation, setFilterLocation] = useState("All"); // stores location.id or "All"
  const [filterFromDate, setFilterFromDate] = useState("");    // ISO date string "YYYY-MM-DD" or ""
  const [filterToDate, setFilterToDate] = useState("");        // ISO date string "YYYY-MM-DD" or ""
  const [selectedReq, setSelectedReq] = useState<any>(null);
  const [selectedReqIds, setSelectedReqIds] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "hq-production" | "backorders">("overview");
  const [activeCommissary, setActiveCommissary] = useState<string>("Commissary HQ");
  const [productionDate, setProductionDate] = useState<string>(
    new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  );
  const [expandedRows, setExpandedRows] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Line items fetched from requisition_items table on drawer open
  const [hqReqItems, setHqReqItems] = useState<any[]>([]);
  const [hqItemsLoading, setHqItemsLoading] = useState(false);
  const [deliveryTicketForReq, setDeliveryTicketForReq] = useState<any | null>(null);
  const [deliveryTicketLoading, setDeliveryTicketLoading] = useState(false);
  // Cache line items per req id so table rows show real values once a req is opened
  const [reqItemsCache, setReqItemsCache] = useState<Map<string, any[]>>(new Map());

  // Backorders state
  const [backorders, setBackorders] = useState<any[]>([]);
  const [backordersLoading, setBackordersLoading] = useState(false);
  const [boSearchQuery, setBoSearchQuery] = useState("");
  const [boFilterStatus, setBoFilterStatus] = useState("all");
  const [boFilterLocation, setBoFilterLocation] = useState("all");

  const [selectedFulfillBo, setSelectedFulfillBo] = useState<any>(null);
  const [qtyToFulfill, setQtyToFulfill] = useState<number>(0);
  const [fulfillNotes, setFulfillNotes] = useState<string>("");
  const [isFulfillingBo, setIsFulfillingBo] = useState(false);
  const [boFulfillError, setBoFulfillError] = useState<string | null>(null);
  const [hqStock, setHqStock] = useState<number | null>(null);
  const [hqStockLoading, setHqStockLoading] = useState(false);

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
        const [reqs, fg, locs, bo] = await Promise.all([
          loadRequisitions(),
          loadFinishedGoods(),
          loadLocations(),
          loadBackorders(),
        ]);
        setRequisitions(Array.isArray(reqs) ? reqs : []);
        setFinishedGoods(Array.isArray(fg) ? fg : []);
        setLocations(Array.isArray(locs) ? locs : []);
        setBackorders(Array.isArray(bo) ? bo : []);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, []);

  // Fetch HQ stock details for the selected backorder item
  useEffect(() => {
    if (!selectedFulfillBo) {
      setHqStock(null);
      return;
    }
    setHqStockLoading(true);
    const itemId = selectedFulfillBo.item_id;
    if (selectedFulfillBo.source_type === "finished_good") {
      supabase.from("hq_sale_items").select("instock").eq("id", itemId).single()
        .then(({ data, error }) => {
          if (error) {
            console.error("Error fetching finished goods stock", error);
            setHqStock(null);
          } else {
            setHqStock(data ? Number(data.instock ?? 0) : 0);
          }
          setHqStockLoading(false);
        });
    } else {
      supabase.from("inventory_items").select("instock").eq("item_id", itemId).eq("location_id", "LOC-HQ").single()
        .then(({ data, error }) => {
          if (error) {
            console.error("Error fetching raw item stock", error);
            setHqStock(null);
          } else {
            setHqStock(data ? Number(data.instock ?? 0) : 0);
          }
          setHqStockLoading(false);
        });
    }
  }, [selectedFulfillBo]);

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
    if (!selectedReq) { setHqReqItems([]); setDeliveryTicketForReq(null); return; }
    let deliveryCancelled = false;
    setDeliveryTicketLoading(true);
    getDeliveryTicketForRequisition(selectedReq.id).then((res) => {
      if (deliveryCancelled) return;
      setDeliveryTicketForReq(res.success ? (res.data ?? null) : null);
      setDeliveryTicketLoading(false);
    });
    // Serve from cache immediately to avoid flicker on re-open
    if (reqItemsCache.has(selectedReq.id)) {
      setHqReqItems(reqItemsCache.get(selectedReq.id)!);
      setHqItemsLoading(false);
      return () => { deliveryCancelled = true; };
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
    return () => { cancelled = true; deliveryCancelled = true; };
  }, [selectedReq]);

  // ── Fulfill-qty draft map ─────────────────────────────────────────────────────
  // Controlled state for per-line fulfill qty inputs. Keyed by line-item id.
  // Reset when the drawer changes, initialise from DB data when items load.
  const [fulfillDraftMap, setFulfillDraftMap] = useState<Map<string, number>>(new Map());

  // Reset draft when the selected requisition changes (drawer opens/closes)
  useEffect(() => { setFulfillDraftMap(new Map()); }, [selectedReq?.id]);

  const getSafeFulfillQty = useCallback((li: any) => {
    const requested = Number(li.quantityRequested ?? 0);
    const hqStock = li.hqAvailableStock;
    if (requested <= 0) return 0;
    if (hqStock != null) return Math.max(0, Math.min(requested, Number(hqStock) || 0));
    return requested;
  }, []);

  const setAllFulfillQuantitiesToRequested = useCallback(() => {
    setFulfillDraftMap(() => {
      const next = new Map<string, number>();
      hqReqItems.forEach((li: any) => {
        next.set(li.id, getSafeFulfillQty(li));
      });
      return next;
    });
  }, [getSafeFulfillQty, hqReqItems]);

  const setLineFulfillQuantity = useCallback((lineId: string, qty: number) => {
    setFulfillDraftMap(prev => new Map(prev).set(lineId, qty));
  }, []);

  const persistFulfillmentDrafts = useCallback(async () => {
    const changed: Array<{ item: any; newVal: number; current: number }> = [];

    for (const li of hqReqItems) {
      const requested = Number(li.quantityRequested ?? 0);
      const hqStock = li.hqAvailableStock;
      const maxFulfill = Math.min(requested, hqStock ?? requested);
      const current = Number(li.quantityFulfilled ?? 0);
      const draft = fulfillDraftMap.get(li.id);
      const newVal = Math.max(0, Math.min(maxFulfill, Number(draft ?? current) || 0));

      if (newVal !== current) {
        changed.push({ item: li, newVal, current });
      }
    }

    for (const change of changed) {
      const res = await updateRequisitionItemFulfilled(change.item.id, change.newVal, change.item.requisitionId);
      if (!res.success) {
        throw new Error(res.error?.message ?? `Failed to save ${change.item.itemName ?? "line item"}`);
      }
      setHqReqItems(prev => prev.map(li =>
        li.id === change.item.id ? { ...li, quantityFulfilled: change.newVal } : li
      ));
      if (res.newStatus) {
        setSelectedReq((prev: any) => prev ? { ...prev, status: res.newStatus } : prev);
        setRequisitions((prev: any[]) => prev.map(r =>
          r.id === change.item.requisitionId ? { ...r, status: res.newStatus } : r
        ));
      }
    }

    if (changed.length > 0 && selectedReq?.id) {
      setReqItemsCache(prev => {
        const next = new Map(prev);
        next.delete(selectedReq.id);
        return next;
      });
    }
  }, [fulfillDraftMap, hqReqItems, selectedReq?.id]);

  // Initialise missing entries from loaded line items
  useEffect(() => {
    if (!hqReqItems.length) return;
    setFulfillDraftMap(prev => {
      const next = new Map(prev);
      hqReqItems.forEach((li: any) => {
        if (next.has(li.id)) return; // preserve in-session edits
        const current = Number(li.quantityFulfilled ?? 0);
        const defaultVal = current > 0 ? current : getSafeFulfillQty(li);
        next.set(li.id, defaultVal);
      });
      return next;
    });
  }, [getSafeFulfillQty, hqReqItems]);

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
  const backorderCount = backorders.filter((b) =>
    (b.status === "open" || b.status === "partially_fulfilled") &&
    Number(b.remainingQty ?? 0) > 0
  ).length;

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

  const filteredBackorders = useMemo(() => {
    return backorders.filter((bo) => {
      const boStatus = (bo.status ?? "").toLowerCase();
      const filterStatus = boFilterStatus.toLowerCase();
      if (filterStatus !== "all" && boStatus !== filterStatus) return false;
      if (boFilterLocation !== "all" && bo.locationId !== boFilterLocation) return false;

      if (boSearchQuery) {
        const q = boSearchQuery.toLowerCase();
        if (
          !String(bo.itemName || "").toLowerCase().includes(q) &&
          !String(bo.itemId || "").toLowerCase().includes(q) &&
          !String(bo.originalRequisitionId || "").toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [backorders, boFilterStatus, boFilterLocation, boSearchQuery]);

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
    if (lower === "fulfilled") {
      try {
        const updatedBo = await loadBackorders();
        setBackorders(updatedBo);
      } catch (boErr) {
        console.error("Failed to load backorders", boErr);
      }
    }
  };

  const handleDeliveryTicketAction = async () => {
    if (!selectedReq) return;
    if (deliveryTicketForReq) {
      router.push("/deliveries");
      return;
    }
    setDeliveryTicketLoading(true);
    const res = await createDeliveryTicketFromRequisition(selectedReq.id);
    setDeliveryTicketLoading(false);
    if (!res.success) {
      alert(`Delivery ticket failed: ${res.error?.message ?? "Unknown error"}`);
      return;
    }
    setDeliveryTicketForReq(res.data ?? null);
    router.push("/deliveries");
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
            Requests
          </button>
          <button onClick={() => setActiveTab("hq-production")}
            className={`flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${activeTab === "hq-production" ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20" : "text-zinc-400 hover:text-white"}`}>
            <ClipboardList className="h-4 w-4" /> HQ Production
          </button>
          <button onClick={() => setActiveTab("backorders")}
            className={`flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${activeTab === "backorders" ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20" : "text-zinc-400 hover:text-white"}`}>
            <Warehouse className="h-4 w-4" /> Backorders
            {backorders.filter(b => b.status === 'open' || b.status === 'partially_fulfilled').length > 0 && (
              <span className="bg-rose-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {backorders.filter(b => b.status === 'open' || b.status === 'partially_fulfilled').length}
              </span>
            )}
          </button>
        </div>
      </div>

      {activeTab === "overview" && (
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
                    {locations.filter(l => isActiveLocation(l) && isStoreLocation(l)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
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
            variant="dialog"
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
                    {["approved", "fulfilled"].includes((selectedReq?.status ?? "").toLowerCase()) && (
                      <button
                        onClick={handleDeliveryTicketAction}
                        disabled={deliveryTicketLoading}
                        className="px-4 py-2 text-sm font-medium bg-white border border-brand-200 text-brand-700 rounded-lg hover:bg-brand-50 transition-colors shadow-sm flex items-center gap-2 disabled:opacity-50"
                      >
                        <Truck className="h-4 w-4" />
                        {deliveryTicketLoading
                          ? "Checking Ticket..."
                          : deliveryTicketForReq
                            ? "View Delivery Ticket"
                            : "Generate Delivery Ticket"}
                      </button>
                    )}
                    {/* Approve / Reject — only for submitted/draft */}
                    {["submitted", "draft"].includes((selectedReq?.status ?? "").toLowerCase()) && !isHqFulfillment(profile) && (
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
                          try {
                            await persistFulfillmentDrafts();
                          } catch (error: any) {
                            alert(`Failed to save fulfillment quantities: ${error?.message ?? "Unknown error"}`);
                            return;
                          }

                          // ── 1. Always write "fulfilled" to DB ─────────────────────
                          // DB CHECK constraint only allows: draft/submitted/approved/rejected/fulfilled.
                          // partial and backordered are computed UI-display statuses only.
                          const finalStatus = "fulfilled";

                          // ── 2. Persist to DB — minimal UPDATE, no location_id ────
                          const res = await updateRequisitionStatus(selectedReq.id, finalStatus);
                          if (!res.success) {
                            alert(`Failed to save status: ${res.error?.message}`);
                            return;
                          }

                          // Refresh backorders state
                          try {
                            const updatedBo = await loadBackorders();
                            setBackorders(updatedBo);
                          } catch (boErr) {
                            console.error("Failed to load backorders after fulfillment completion", boErr);
                          }

                          // ── 3. Compute fulfilled total for local state ─────────────
                          // Used to update the main table value column immediately without
                          // waiting for a page reload or cache re-fetch.
                          const fulfilledTotal = hqReqItems.reduce((sum: number, li: any) => {
                            const qty = fulfillDraftMap.get(li.id) ?? Number(li.quantityFulfilled ?? 0);
                            return sum + qty * Number(li.unitPrice ?? 0);
                          }, 0);

                          // ── 4. Sync local state ───────────────────────────────────────
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

                          // ── 5. Lock UI ────────────────────────────────────────────────
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
            <div className="space-y-3">
              {/* Notes — compact inline, no large box when empty */}
              <div className="flex items-start gap-1.5 text-sm">
                <span className="shrink-0 font-semibold text-neutral-500 text-xs uppercase tracking-wider pt-0.5">Notes:</span>
                <span className="text-neutral-700">{selectedReq?.notes || <span className="text-neutral-400 italic">No notes provided.</span>}</span>
              </div>
              {FULFILLABLE_STATUSES.has((selectedReq?.status ?? "").toLowerCase()) && !isFulfillmentLocked && hqReqItems.length > 0 && (
                <div className="flex flex-col gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-emerald-900">Fulfillment shortcut</p>
                    <p className="text-xs text-emerald-700">Defaults each line to requested quantity, capped by available HQ stock.</p>
                  </div>
                  <button
                    type="button"
                    onClick={setAllFulfillQuantitiesToRequested}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
                  >
                    <PackageCheck className="h-4 w-4" /> Fulfill All as Requested
                  </button>
                </div>
              )}
              <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden overflow-x-auto">
                <Table>
                  <TableHeader className="bg-neutral-50/50 text-[11px] uppercase text-neutral-500 tracking-wider">
                    <TableRow>
                      <TableHead className="py-1.5 px-3">Item</TableHead>
                      <TableHead className="py-1.5 text-right">Requested</TableHead>
                      <TableHead className="py-1.5 text-right">HQ Stock</TableHead>
                      <TableHead className="py-1.5 text-center">Fulfill Qty</TableHead>
                      <TableHead className="py-1.5 text-right">Backorder</TableHead>
                      <TableHead className="py-1.5 text-right">Unit Price</TableHead>
                      <TableHead className="py-1.5 text-right">Fulfilled $</TableHead>
                      <TableHead className="py-1.5 text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {hqItemsLoading ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-6 text-neutral-400 text-sm">
                          <div className="flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" /> Loading items…
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : hqReqItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-6 text-neutral-400 text-sm">
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
                            <TableCell colSpan={8} className="py-1 px-3">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold border ${COMMISSARY_COLORS[commissary] ?? "bg-neutral-50 text-neutral-600 border-neutral-200"}`}>
                                {commissary}
                              </span>
                            </TableCell>
                          </TableRow>
                          {groupItems.map((item: any) => {
                            const requested  = Number(item.quantityRequested ?? 0);
                            const draftQty   = fulfillDraftMap.get(item.id) ?? Number(item.quantityFulfilled ?? 0);
                            const hqStock    = item.hqAvailableStock;
                            const packQty    = item.isFGMode ? (item.packQtySnapshot ?? 1) : 1;
                            const hqStockPacks = item.isFGMode && hqStock != null ? Math.floor(hqStock / packQty) : hqStock;
                            const maxFulfill = Math.min(requested, hqStockPacks ?? requested);
                            const backorder  = Math.max(0, requested - draftQty);
                            const unitPrice  = Number(item.unitPrice ?? 0);
                            const lineTotal  = draftQty * unitPrice;
                            const lineStatus = item.isFGMode && hqStock != null && hqStock < packQty
                              ? "out_of_stock"
                              : hqStock != null && hqStock <= 0
                              ? "out_of_stock"
                              : draftQty >= requested
                              ? "fulfilled"
                              : draftQty > 0
                              ? "partial"
                              : "backordered";
                            return (
                              <TableRow key={item.id} className="hover:bg-neutral-50/50">
                                {/* Item + line status */}
                                <TableCell className="py-2 px-3">
                                  <div className="font-medium text-sm text-neutral-900">{item.itemName}</div>
                                  <div className="mt-0.5">
                                    {lineStatus === "out_of_stock" ? (
                                      <span className="inline-flex rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">Out of Stock</span>
                                    ) : lineStatus === "partial" ? (
                                      <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">Partial</span>
                                    ) : lineStatus === "backordered" ? (
                                      <span className="inline-flex rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">Backorder</span>
                                    ) : (
                                      <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">Fulfilled</span>
                                    )}
                                  </div>
                                </TableCell>
                                {/* Requested qty */}
                                <TableCell className="py-2 text-right">
                                  <span className="text-sm font-medium text-neutral-800">
                                    {item.isFGMode ? `${requested} pack${requested !== 1 ? 's' : ''} (${requested * packQty} ${item.unit})` : requested}
                                  </span>
                                  {!item.isFGMode && item.unit && <span className="text-xs text-neutral-400 ml-1">{item.unit}</span>}
                                </TableCell>
                                {/* HQ available stock */}
                                <TableCell className="py-2 text-right">
                                  {hqStock != null ? (
                                    <span className={`text-sm font-semibold ${
                                      hqStock <= 0 || (item.isFGMode && hqStock < packQty) ? "text-danger-600"  :
                                      (item.isFGMode ? hqStockPacks < requested : hqStock < requested) ? "text-warning-600" :
                                                              "text-success-600"
                                    }`}>
                                      {item.isFGMode ? `${hqStockPacks} pack${hqStockPacks !== 1 ? 's' : ''} (${hqStock} ${item.unit})` : `${hqStock} ${item.unit || "ea"}`}
                                    </span>
                                  ) : (
                                    <span className="text-neutral-400 text-sm">—</span>
                                  )}
                                </TableCell>
                                {/* Fulfill qty — controlled, disabled on non-approved */}
                                <TableCell className="py-2 text-center">
                                  <div className="flex flex-col items-center">
                                    <input
                                      type="number"
                                      min={0}
                                      max={maxFulfill}
                                      disabled={!isEditable}
                                      value={draftQty}
                                      onChange={(e) => {
                                        const clamped = Math.max(0, Math.min(maxFulfill, Number(e.target.value)));
                                        setLineFulfillQuantity(item.id, clamped);
                                      }}
                                      onBlur={async () => {
                                        const newVal  = fulfillDraftMap.get(item.id) ?? Number(item.quantityFulfilled ?? 0);
                                        const current = Number(item.quantityFulfilled ?? 0);
                                        if (newVal === current) return;
                                        // UI guard: never exceed HQ stock
                                        const maxAllowedVal = item.isFGMode && hqStock != null ? Math.floor(hqStock / packQty) : hqStock;
                                        if (maxAllowedVal != null && newVal > maxAllowedVal) {
                                          alert(item.isFGMode 
                                            ? `Cannot fulfill ${newVal} pack(s) — only ${maxAllowedVal} pack(s) (${hqStock} ${item.unit}) available in HQ stock.`
                                            : `Cannot fulfill ${newVal} — only ${hqStock} in HQ stock.`
                                          );
                                          setLineFulfillQuantity(item.id, current);
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
                                          setLineFulfillQuantity(item.id, current);
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
                                    {item.isFGMode && (
                                      <span className="text-[10px] text-neutral-500 font-medium mt-0.5">
                                        {draftQty * packQty} {item.unit}
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                                {/* Backorder */}
                                <TableCell className="py-2 text-right">
                                  {backorder > 0
                                    ? <span className="text-sm font-bold text-danger-600">{item.isFGMode ? `${backorder} pack${backorder !== 1 ? 's' : ''} (${backorder * packQty} ${item.unit})` : backorder}</span>
                                    : <span className="text-xs font-bold text-success-600">—</span>}
                                </TableCell>
                                {/* Unit price */}
                                <TableCell className="py-2 text-right">
                                  {unitPrice > 0
                                    ? <span className="text-sm font-medium text-neutral-700">{item.isFGMode ? `$${unitPrice.toFixed(2)}/pack` : `$${unitPrice.toFixed(2)}`}</span>
                                    : <span className="text-neutral-400 text-xs">—</span>}
                                </TableCell>
                                {/* Fulfilled line total */}
                                <TableCell className="py-2 text-right">
                                  <span className="text-sm font-semibold text-success-700">${lineTotal.toFixed(2)}</span>
                                </TableCell>
                                <TableCell className="py-2 text-right">
                                  {isEditable ? (
                                    <button
                                      type="button"
                                      onClick={() => setLineFulfillQuantity(item.id, 0)}
                                      className="rounded-md border border-rose-200 bg-white px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                                    >
                                      Mark Backorder
                                    </button>
                                  ) : (
                                    <span className="text-xs text-neutral-300">—</span>
                                  )}
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
      )}

      {activeTab === "hq-production" && (
        <div className="space-y-6 hq-production-print-area">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-neutral-100 pb-4 print:hidden">
            <div>
              <h3 className="text-xl font-bold tracking-tight text-neutral-900">HQ Production Summary</h3>
              <p className="text-neutral-500 text-sm">Centralized preparation queue for selected date.</p>
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
            {/* Print-only header */}
            <div className="hidden print:block border-b-2 border-neutral-900 pb-4 mb-6">
              <h1 className="text-3xl font-extrabold tracking-tight text-neutral-950">STOCK DHARMA</h1>
              <h2 className="text-xl font-bold text-neutral-800 mt-1">HQ Production Summary</h2>
              <div className="text-sm font-medium text-neutral-600 mt-2">
                Date: {productionDate} &nbsp;|&nbsp; Supplier/Commissary: {activeCommissary}
              </div>
            </div>

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

      {activeTab === "backorders" && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-white/10 pb-4">
            <div>
              <h3 className="text-xl font-bold tracking-tight text-white">HQ Backorder Queue</h3>
              <p className="text-zinc-500 text-sm">Fulfill outstanding backorder shortages to locations.</p>
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between bg-[#111111] border border-white/10 rounded-xl p-4">
            <div className="relative flex-1 max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                placeholder="Search items, requisitions..."
                value={boSearchQuery}
                onChange={(e) => setBoSearchQuery(e.target.value)}
                className="w-full h-10 rounded-lg border border-white/10 bg-[#151515] py-2 pl-9 pr-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={boFilterStatus}
                onChange={(e) => setBoFilterStatus(e.target.value)}
                className="h-10 rounded-lg border border-white/10 bg-[#151515] px-3 text-sm text-zinc-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Statuses</option>
                <option value="open">Open</option>
                <option value="partially_fulfilled">Partially Fulfilled</option>
                <option value="fulfilled">Fulfilled</option>
                <option value="cancelled">Cancelled</option>
              </select>

              <select
                value={boFilterLocation}
                onChange={(e) => setBoFilterLocation(e.target.value)}
                className="h-10 rounded-lg border border-white/10 bg-[#151515] px-3 text-sm text-zinc-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Locations</option>
                {locations.filter(l => isActiveLocation(l) && isStoreLocation(l)).map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* List Table */}
          <Card className="rounded-xl border-white/10 bg-[#111111] shadow-xl overflow-hidden">
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader className="bg-[#151515] text-xs uppercase tracking-[0.14em] text-zinc-400">
                  <TableRow className="border-b border-white/5">
                    <TableHead className="px-6 py-3.5">Location</TableHead>
                    <TableHead className="py-3.5">Item</TableHead>
                    <TableHead className="py-3.5">Original Requisition #</TableHead>
                    <TableHead className="py-3.5 text-right">Requested Qty</TableHead>
                    <TableHead className="py-3.5 text-right">Initially Fulfilled Qty</TableHead>
                    <TableHead className="py-3.5 text-right">Remaining Qty</TableHead>
                    <TableHead className="py-3.5">Unit</TableHead>
                    <TableHead className="py-3.5 text-right">Unit Price</TableHead>
                    <TableHead className="py-3.5">Status</TableHead>
                    <TableHead className="py-3.5">Created Date</TableHead>
                    <TableHead className="px-6 py-3.5 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backordersLoading ? (
                    <TableRow>
                      <TableCell colSpan={11} className="py-10 text-center text-zinc-500 text-sm">
                        <div className="flex items-center justify-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" /> Loading backorders...
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : filteredBackorders.length > 0 ? (
                    filteredBackorders.map((bo) => {
                      const isFulfillable = bo.status === "open" || bo.status === "partially_fulfilled";
                      const createdDateStr = bo.createdAt ? new Date(bo.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric"
                      }) : "—";
                      return (
                        <TableRow key={bo.id} className="border-b border-white/5 hover:bg-[#151515]/50 transition-colors">
                          <TableCell className="px-6 py-4 font-medium text-zinc-100">{bo.locationId}</TableCell>
                          <TableCell className="py-4 text-sm">
                            <div className="font-semibold text-zinc-100">{bo.itemName}</div>
                            <div className="text-zinc-500 text-xs mt-0.5">{bo.itemId} ({bo.sourceType})</div>
                          </TableCell>
                          <TableCell className="py-4 text-sm text-zinc-400">{bo.originalRequisitionId}</TableCell>
                          <TableCell className="py-4 text-right text-sm text-zinc-300">
                            {bo.requestedQty}
                          </TableCell>
                          <TableCell className="py-4 text-right text-sm text-zinc-300">
                            {bo.fulfilledQty}
                          </TableCell>
                          <TableCell className="py-4 text-right text-sm font-semibold text-amber-400">
                            {bo.remainingQty}
                          </TableCell>
                          <TableCell className="py-4 text-sm text-zinc-300">
                            {bo.unit}
                          </TableCell>
                          <TableCell className="py-4 text-right text-sm text-zinc-400">
                            ${Number(bo.unitPrice).toFixed(2)}
                          </TableCell>
                          <TableCell className="py-4">
                            <StatusBadge status={bo.status} />
                          </TableCell>
                          <TableCell className="py-4 text-sm text-zinc-400">
                            {createdDateStr}
                          </TableCell>
                          <TableCell className="px-6 py-4 text-right">
                            {isFulfillable ? (
                              <button
                                onClick={() => {
                                  setSelectedFulfillBo(bo);
                                  setQtyToFulfill(bo.remainingQty);
                                }}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-xs font-semibold text-white hover:bg-blue-500 transition-colors"
                              >
                                Fulfill
                              </button>
                            ) : (
                              <span className="text-xs text-zinc-600">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={11} className="py-10 text-center text-sm text-zinc-500">
                        No backorders found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Fulfill Backorder Drawer — styled light-themed as per Drawer component styling */}
      <Drawer
        isOpen={!!selectedFulfillBo}
        onClose={() => {
          setSelectedFulfillBo(null);
          setQtyToFulfill(0);
          setFulfillNotes("");
          setBoFulfillError(null);
        }}
        title="Fulfill Requisition Backorder"
        description="Fulfill shortages to restaurant locations from HQ inventory."
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-800">
            <div>
              <span className="text-xs text-neutral-500 uppercase font-semibold">Location</span>
              <p className="mt-1 font-bold text-neutral-900">{selectedFulfillBo?.locationId}</p>
            </div>
            <div>
              <span className="text-xs text-neutral-500 uppercase font-semibold">Item SKU/ID</span>
              <p className="mt-1 font-bold text-neutral-900">{selectedFulfillBo?.itemId}</p>
            </div>
            <div className="col-span-2 border-t border-neutral-100 pt-2 mt-2">
              <span className="text-xs text-neutral-500 uppercase font-semibold">Item Name</span>
              <p className="mt-1 font-bold text-neutral-900">{selectedFulfillBo?.itemName}</p>
            </div>
            <div className="border-t border-neutral-100 pt-2 mt-2">
              <span className="text-xs text-neutral-500 uppercase font-semibold">Requested / Fulfilled</span>
              <p className="mt-1 text-neutral-900 font-medium">{selectedFulfillBo?.requestedQty} / {selectedFulfillBo?.fulfilledQty} {selectedFulfillBo?.unit}</p>
            </div>
            <div className="border-t border-neutral-100 pt-2 mt-2">
              <span className="text-xs text-neutral-500 uppercase font-semibold">Remaining Backorder</span>
              <p className="mt-1 text-amber-600 font-bold">{selectedFulfillBo?.remainingQty} {selectedFulfillBo?.unit}</p>
            </div>
            <div className="border-t border-neutral-100 pt-2 mt-2">
              <span className="text-xs text-neutral-500 uppercase font-semibold">HQ Stock Available</span>
              <p className="mt-1 font-bold">
                {hqStockLoading ? (
                  <span className="text-neutral-400">Loading...</span>
                ) : hqStock === null ? (
                  <span className="text-rose-600">Not found / Out of Stock</span>
                ) : (
                  <span className={hqStock <= 0 ? "text-rose-600" : hqStock < (selectedFulfillBo?.remainingQty ?? 0) ? "text-amber-600" : "text-emerald-600"}>
                    {hqStock} {selectedFulfillBo?.unit}
                  </span>
                )}
              </p>
            </div>
            <div className="border-t border-neutral-100 pt-2 mt-2">
              <span className="text-xs text-neutral-500 uppercase font-semibold">Unit Price</span>
              <p className="mt-1 text-neutral-900 font-medium">${Number(selectedFulfillBo?.unitPrice ?? 0).toFixed(2)}</p>
            </div>
          </div>

          {boFulfillError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{boFulfillError}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-neutral-500">Fulfill Quantity</label>
            <input
              type="number"
              min={0.01}
              step="any"
              max={selectedFulfillBo?.remainingQty}
              value={qtyToFulfill || ""}
              onChange={(e) => setQtyToFulfill(Number(e.target.value))}
              placeholder={`Max ${selectedFulfillBo?.remainingQty}`}
              className="mt-2 w-full h-11 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-neutral-500">Notes / Remarks</label>
            <textarea
              rows={3}
              value={fulfillNotes}
              onChange={(e) => setFulfillNotes(e.target.value)}
              placeholder="e.g., Sourced from reserve warehouse, delivered via van"
              className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-neutral-200">
            <button
              type="button"
              onClick={() => setSelectedFulfillBo(null)}
              className="h-11 rounded-lg border border-neutral-300 bg-transparent px-4 text-sm font-semibold text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                if (qtyToFulfill <= 0 || qtyToFulfill > (selectedFulfillBo?.remainingQty ?? 0)) {
                  setBoFulfillError(`Fulfill quantity must be between 0.01 and ${selectedFulfillBo?.remainingQty}.`);
                  return;
                }
                if (hqStock !== null && hqStock < qtyToFulfill) {
                  setBoFulfillError(`Cannot fulfill ${qtyToFulfill} — only ${hqStock} available in HQ stock.`);
                  return;
                }
                setIsFulfillingBo(true);
                setBoFulfillError(null);
                try {
                  const res = await fulfillBackorder(selectedFulfillBo.id, qtyToFulfill, fulfillNotes);
                  if (res.success) {
                    // Refresh backorders
                    const updatedBo = await loadBackorders();
                    setBackorders(updatedBo);
                    setSelectedFulfillBo(null);
                    setQtyToFulfill(0);
                    setFulfillNotes("");
                  } else {
                    setBoFulfillError(res.error?.message || "Failed to fulfill backorder.");
                  }
                } catch (err: any) {
                  setBoFulfillError(err?.message || "An unexpected error occurred.");
                } finally {
                  setIsFulfillingBo(false);
                }
              }}
              disabled={isFulfillingBo || qtyToFulfill <= 0 || (hqStock !== null && hqStock < qtyToFulfill)}
              className="h-11 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isFulfillingBo ? "Fulfilling..." : "Submit Fulfillment"}
            </button>
          </div>
        </div>
      </Drawer>
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
      try {
        const prof = await getCurrentUserProfile();
        setProfile(prof);
        if (prof) {
          const isHqRequisitionRole = ["hq_master", "hq_admin", "hq_ops", "hq_fulfillment"].includes(prof.role);
          if (isHqRequisitionRole) {
            // HQAdminView will load finishedGoods and requisitions internally on mount
          } else if (prof.role === "location_manager") {
            const [inv, si] = await Promise.all([
              loadInventory(prof.locationId),
              loadSaleItems(),
            ]);
            setInventoryItems(Array.isArray(inv) ? inv : []);
            setSaleItems(Array.isArray(si) ? si : []);
          }
        }
      } catch (e) {
        console.error("Bootstrapping requisitions failed:", e);
      } finally {
        setIsBootstrapping(false);
      }
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
  const isHqRequisitionRole = ["hq_master", "hq_admin", "hq_ops", "hq_fulfillment"].includes(profile.role);
  if (!isHqRequisitionRole && profile.role !== "location_manager") {
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

  if (isHqRequisitionRole) {
    return <HQAdminView finishedGoods={finishedGoods} profile={profile} />;
  }

  return <LocationManagerView profile={profile} inventoryItems={inventoryItems} saleItems={saleItems} />;

}
