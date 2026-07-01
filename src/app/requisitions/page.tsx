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
  Info,
  ArrowRight,
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
  saveRequisitionDraft,
  submitRequisitionDraft,
  loadActiveRequisitionDraft,
  loadRequisitionItems,
  loadRequisitionItemsBatch,
  updateRequisitionStatus,
  approveRequisition,
  rejectRequisition,
  updateRequisitionItemFulfilled,
  getHQAvailabilityLabel,
  sendHqRequisitionNotification,
  loadOutletCatalog,
  loadBackorders,
  loadBackorderFulfillments,
  // fulfillBackorder is deprecated — canonical re-fulfillment uses the main drawer.
  // Kept in storage.ts for location-manager history view compatibility.
  createDeliveryTicketFromRequisition,
  finalizeRequisitionFulfillment,
  getDeliveryTicketForRequisition,
  getDeliveryTicketById,
  saveRequisitionEdits,
  type SaleItem,
  type OutletCatalogItem,
} from "@/lib/storage";
import { DeliveryTicketDrawer } from "@/components/DeliveryTicketDrawer";
import {
  getCurrentUserProfile,
  clearProfileCache,
  type UserProfile,
} from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { isHqFulfillment, isHqMaster, isHqOps } from "@/lib/roles";

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
    <div className="-mx-4 -my-4 sm:-mx-5 sm:-my-5 lg:-mx-8 lg:-my-5 xl:-mx-10 min-h-[calc(100vh-4rem)] bg-[#070707] px-4 py-5 sm:px-5 lg:px-8 xl:px-10 text-zinc-100">
      <style>{stockIqDarkShellCss}</style>
      <div className="w-full space-y-5">
        {children}
      </div>
    </div>
  );
}

// ─── Status badge helper ───────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    Draft:                 "bg-zinc-500/15 text-zinc-300 border border-zinc-500/20",
    draft:                 "bg-zinc-500/15 text-zinc-300 border border-zinc-500/20",
    Submitted:             "bg-amber-500/15 text-amber-300 border border-amber-500/20",
    submitted:             "bg-amber-500/15 text-amber-300 border border-amber-500/20",
    Approved:              "bg-blue-500/15 text-blue-300 border border-blue-500/20",
    approved:              "bg-blue-500/15 text-blue-300 border border-blue-500/20",
    Rejected:              "bg-red-500/15 text-red-300 border border-red-500/20",
    rejected:              "bg-red-500/15 text-red-300 border border-red-500/20",
    Fulfilled:             "bg-emerald-500/15 text-emerald-300 border border-emerald-500/20",
    fulfilled:             "bg-emerald-500/15 text-emerald-300 border border-emerald-500/20",
    "Partially Fulfilled": "bg-orange-500/15 text-orange-300 border border-orange-500/20",
    partially_fulfilled:   "bg-orange-500/15 text-orange-300 border border-orange-500/20",
    Partial:               "bg-orange-500/15 text-orange-300 border border-orange-500/20",
    partial:               "bg-orange-500/15 text-orange-300 border border-orange-500/20",
    Backordered:           "bg-red-500/15 text-red-300 border border-red-500/20",
    backordered:           "bg-red-500/15 text-red-300 border border-red-500/20",
  };
  const label = status === "partially_fulfilled" ? "Partially Fulfilled" : status;
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${map[status] ?? "bg-zinc-500/15 text-zinc-300 border border-zinc-500/20"}`}>
      {label}
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
  const [activeDraftRequisitionId, setActiveDraftRequisitionId] = useState<string | null>(null);
  const [isDraftCartRestored, setIsDraftCartRestored] = useState(false);
  const [isRestoringDraft, setIsRestoringDraft] = useState(false);
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

  const clearDraftCartState = useCallback(() => {
    setLineItems([]);
    setDraftNotes("");
    setCatalogQtyById({});
    setActiveDraftRequisitionId(null);
    setIsDraftCartRestored(false);
  }, []);

  const mapDraftLineForSave = useCallback((li: LineItemDraft) => ({
    item_id: li.sourceType === 'hq_supplied' && !li.finishedGoodId ? li.itemId : null,
    finished_good_id: li.sourceType === 'hq_supplied' ? li.finishedGoodId : null,
    catalog_item_id: li.sourceType === 'local_vendor' ? li.catalogItemId : null,
    source_type: li.sourceType,
    supplier_snapshot: li.supplierSnapshot ?? null,
    pack_qty_snapshot: li.packQty ?? 1,
    item_name_snapshot: li.itemName,
    unit_snapshot: li.unit,
    source_commissary_snapshot: li.sourceType === 'local_vendor' ? null : (li.sourceCommissary ?? "Commissary HQ"),
    quantity_requested: li.quantityRequested,
    unit_price: li.unitPrice,
    line_total: parseFloat((li.quantityRequested * li.unitPrice).toFixed(2)),
  }), []);

  useEffect(() => {
    if (!profile.locationId) return;
    let cancelled = false;

    async function restoreDraft() {
      setIsRestoringDraft(true);
      try {
        const res = await loadActiveRequisitionDraft(profile.locationId || "");
        if (cancelled) return;
        if (!res.success) {
          console.warn("[Requisitions] active draft restore failed", res.error);
          return;
        }
        if (!res.data?.requisition?.id) return;

        const draftItems: LineItemDraft[] = (res.data.items ?? []).map((li: any) => {
          const isLocal = li.sourceType === 'local_vendor' || li.source_type === 'local_vendor';
          const finishedGoodId = isLocal ? null : (li.finishedGoodId ?? li.finished_good_id ?? null);
          return {
            itemId: isLocal ? null : (finishedGoodId ? null : (li.itemId ?? li.item_id ?? null)),
            finishedGoodId,
            catalogItemId: isLocal ? (li.catalogItemId ?? li.catalog_item_id ?? null) : null,
            sourceType: (isLocal ? 'local_vendor' : 'hq_supplied') as 'hq_supplied' | 'local_vendor',
            supplierSnapshot: li.supplierSnapshot ?? li.supplier_snapshot ?? null,
            itemName: li.itemName ?? li.item_name_snapshot ?? "",
            unit: li.unit ?? li.unit_snapshot ?? "",
            packQty: li.packQtySnapshot ?? li.packQty ?? li.pack_qty_snapshot ?? 1,
            unitPrice: li.unitPrice ?? li.unit_price ?? 0,
            quantityRequested: li.quantityRequested ?? li.quantity_requested ?? 0,
            sourceCommissary: li.sourceCommissary ?? li.source_commissary_snapshot ?? (isLocal ? "Local Vendor" : "Commissary HQ"),
            requisitionItemId: li.id ?? null,
          };
        }).filter((li) => (li.catalogItemId || li.finishedGoodId || li.itemId) && li.quantityRequested > 0);

        const restoredQty: Record<string, number> = {};
        draftItems.forEach(li => {
          const id = li.catalogItemId ?? li.finishedGoodId ?? li.itemId;
          if (id) restoredQty[id] = li.quantityRequested;
        });

        setActiveDraftRequisitionId(res.data.requisition.id);
        setIsDraftCartRestored(true);
        setLineItems(draftItems);
        setDraftNotes(res.data.requisition.notes || "");
        setCatalogQtyById(restoredQty);
        if (draftItems.length > 0) {
          setDraftNotice(`Restored saved draft ${res.data.requisition.id}.`);
          window.setTimeout(() => setDraftNotice(null), 4000);
        }
      } finally {
        if (!cancelled) setIsRestoringDraft(false);
      }
    }

    restoreDraft();
    return () => { cancelled = true; };
  }, [profile.locationId]);

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

  // ── Single source-of-truth quantity helper ───────────────────────────────────────────────────
  //
  // All quantity changes — catalog input, cart input, Add button, mobile card,
  // and Edit Request mode — must go through this one function.
  //
  // rawCatalogQty  : the value that appears in the catalog input (units or packs,
  //                  exactly what the user typed).
  // fromCart       : when true, rawCatalogQty is already in "cart units"
  //                  (i.e. the cart input changed, not the catalog input).
  //
  // The function:
  //   1. Clamps to ≥0
  //   2. Updates catalogQtyById
  //   3. Computes quantityRequested for the matching line item
  //      (for FG items the cart stores packs, not raw units)
  //   4. If item is already in cart:
  //        qty > 0 → updates quantityRequested
  //        qty = 0 → removes line item from cart
  //   5. If called fromCart also back-syncs catalogQtyById
  const updateItemQuantity = (itemId: string, rawCatalogQty: number | string, { fromCart = false } = {}) => {
    const qty = Math.max(0, Number(rawCatalogQty) || 0);

    setLineItems(prev => {
      const inCart = prev.some(
        li => (li.catalogItemId ?? li.finishedGoodId ?? li.itemId) === itemId
      );
      if (!inCart) return prev; // not yet added — only catalogQtyById needs updating

      if (qty <= 0) {
        // Remove from cart when zeroed
        return prev.filter(
          li => (li.catalogItemId ?? li.finishedGoodId ?? li.itemId) !== itemId
        );
      }

      return prev.map(li => {
        if ((li.catalogItemId ?? li.finishedGoodId ?? li.itemId) !== itemId) return li;
        // FG items: cart quantityRequested is in packs.
        // When the catalog input changes (fromCart=false) we interpret the
        // user’s value as a pack count directly — the catalog input for FG
        // items already shows packs (same as the cart).
        // When the cart input changes (fromCart=true) the value is already packs.
        const cartQty = qty; // for both FG and non-FG, catalog input = pack count
        return { ...li, quantityRequested: cartQty };
      });
    });

    // Always keep catalogQtyById in sync
    setCatalogQtyById(prev => ({ ...prev, [itemId]: qty }));
  };

  // Cart-side quantity change: update lineItems AND back-sync catalogQtyById.
  // When qty becomes 0 the line is removed and catalog resets to 0.
  const updateQty = (id: string, qty: number) => {
    updateItemQuantity(id, qty, { fromCart: true });
  };

  const removeLineItem = (id: string) => {
    setLineItems(prev => prev.filter(li => (li.catalogItemId ?? li.finishedGoodId ?? li.itemId) !== id));
    // Reset catalog input to 0 when item is manually removed via the ✕ button
    setCatalogQtyById(prev => ({ ...prev, [id]: 0 }));
  };

  // ── Add item to cart (called by "Add" button) ──────────────────────────────
  // Reads the current catalogQtyById value and creates a new cart line.
  // Never defaults to qty=1 — user must have entered a positive number.
  // After adding, catalogQtyById retains its value so the input stays in sync.
  const addItemById = (itemId: string) => {
    if (!itemId) return;
    const rawQty = catalogQtyById[itemId];
    const quantity = Math.max(0, Number(rawQty ?? 0));
    if (quantity <= 0) return;

    // ── Local vendor path ──────────────────────────────────────────────────
    const localItem = localCatalogItems.find(c => c.itemId === itemId);
    if (localItem) {
      if (lineItems.some(li => li.catalogItemId === localItem.itemId)) return;
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

    // ── HQ FG path ────────────────────────────────────────────────────────
    // The catalog input shows pack count for FG items — use quantity directly.
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
          catalogItemId:     null,
          sourceType:        'hq_supplied',
          supplierSnapshot:  saleItem.sourceCommissary || 'Commissary HQ',
          itemName:          saleItem.name,
          unit:              saleItem.baseUnit,
          packQty,
          unitPrice:         packPrice,
          quantityRequested: quantity, // catalog input = pack count directly
          sourceCommissary:  saleItem.sourceCommissary,
        },
      ]);
    } else {
      // ── HQ raw inventory path ──────────────────────────────────────────
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
      if (!profile.locationId) { setSaveError("Your profile has no location assigned."); return; }

      const saveRes = await saveRequisitionDraft(
        profile.locationId,
        draftNotes,
        lineItems.map(mapDraftLineForSave)
      );

      if (!saveRes.success || !saveRes.data?.requisitionId) {
        setSaveError(saveRes.error?.message ?? "Draft save failed. Check console.");
        return;
      }

      const submitRes = await submitRequisitionDraft(saveRes.data.requisitionId, profile.locationId);
      if (!submitRes.success) {
        setSaveError(submitRes.error?.message ?? "Draft submit failed. Check console.");
        setActiveDraftRequisitionId(saveRes.data.requisitionId);
        setIsDraftCartRestored(true);
        return;
      }

      const submittedReqId = submitRes.data?.requisitionId ?? saveRes.data.requisitionId;
      const notifyRes = await sendHqRequisitionNotification(submittedReqId);
      if (notifyRes.success) {
        showSubmitNotice("success", "Order submitted. HQ notification email sent.");
      } else {
        console.warn("[Requisitions] HQ notification failed:", notifyRes.error);
        showSubmitNotice("warning", "Order submitted. HQ email notification failed.");
      }

      clearDraftCartState();
      await fetchReqs();
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveDraft = async () => {
    setSaveError(null);
    if (lineItems.length === 0) {
      setDraftNotice("Add items before saving a draft.");
      window.setTimeout(() => setDraftNotice(null), 4000);
      return;
    }
    if (lineItems.some(li => li.quantityRequested <= 0)) {
      setSaveError("All items must have a quantity greater than 0.");
      return;
    }
    if (!profile.locationId) {
      setSaveError("Your profile has no location assigned.");
      return;
    }

    setIsSaving(true);
    try {
      const res = await saveRequisitionDraft(
        profile.locationId,
        draftNotes,
        lineItems.map(mapDraftLineForSave)
      );
      if (!res.success || !res.data?.requisitionId) {
        setSaveError(res.error?.message ?? "Draft save failed. Check console.");
        return;
      }
      setActiveDraftRequisitionId(res.data.requisitionId);
      setIsDraftCartRestored(true);
      setDraftNotice(`Draft saved as ${res.data.requisitionId}.`);
      window.setTimeout(() => setDraftNotice(null), 4000);
      await fetchReqs();
    } finally {
      setIsSaving(false);
    }
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

    // Populate catalogQtyById so the catalog inputs reflect the loaded quantities.
    // This ensures catalog input and cart quantity are in sync from the moment
    // Edit Request mode is entered.
    const initialCatalogQty: Record<string, number> = {};
    draftItems.forEach(li => {
      const id = li.catalogItemId ?? li.finishedGoodId ?? li.itemId;
      if (id) initialCatalogQty[id] = li.quantityRequested;
    });
    setCatalogQtyById(prev => ({ ...prev, ...initialCatalogQty }));

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
      <div className="w-full">
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
    <div className="w-full space-y-6">
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
              disabled={isSaving || isRestoringDraft || lineItems.filter(li => li.quantityRequested > 0).length === 0}
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
                              onChange={(e) => updateItemQuantity(item.id, e.target.value)}
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
                              onChange={(e) => updateItemQuantity(item.id, e.target.value)}
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
                {!editingRequisitionId && isDraftCartRestored && activeDraftRequisitionId && (
                  <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                    <Save className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Saved draft <strong>{activeDraftRequisitionId}</strong> restored. Save again to update it, or submit this same draft.
                    </span>
                  </div>
                )}
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
                        disabled={isSaving || isRestoringDraft || lineItems.length === 0}
                        className="min-h-11 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSaving ? "Saving Draft..." : "Save Draft"}
                      </button>
                      <button
                        type="button"
                        onClick={handleCreate}
                        disabled={isSaving || isRestoringDraft || lineItems.length === 0}
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
            <div className="bg-danger-50 border border-danger-200 rounded-lg p-4 flex flex-col gap-1.5">
              <div className="flex items-center gap-3">
                <XSquare className="h-5 w-5 text-danger-600 shrink-0" />
                <p className="text-sm text-danger-700 font-medium">This requisition was rejected by HQ.</p>
              </div>
              {selectedReq?.rejectionReason && (
                <p className="text-xs text-danger-600 pl-8">
                  <span className="font-semibold">Reason:</span> {selectedReq.rejectionReason}
                </p>
              )}
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

  // ── Delivery Ticket Drawer ──────────────────────────────────────────────────────────
  // Used when hq_fulfillment (or any role) clicks "View Delivery Ticket".
  // Non-fulfillment roles navigate to /deliveries instead (existing behavior).
  const [dtDrawerTicket, setDtDrawerTicket] = useState<any | null>(null);
  const [dtLoading, setDtLoading] = useState(false);

  const isHqFulfillmentUser = isHqFulfillment(profile);

  // ── Rejection modal state ─────────────────────────────────────────────────
  const [rejectModalReqId, setRejectModalReqId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [rejectActionLoading, setRejectActionLoading] = useState(false);
  const [approveActionLoading, setApproveActionLoading] = useState(false);

  // Backorders state
  const [backorders, setBackorders] = useState<any[]>([]);
  const [backordersLoading, setBackordersLoading] = useState(false);
  const [boSearchQuery, setBoSearchQuery] = useState("");
  const [boFilterStatus, setBoFilterStatus] = useState("all");
  const [boFilterLocation, setBoFilterLocation] = useState("all");

  // Backorder focus state — set when "Fulfill Remaining" is clicked from the Backorders tab.
  // backorderFocusLineId: the specific requisition_items.id to prefill with remaining qty.
  // backorderFocusRemaining: the remaining qty from the backorder record.
  // All other lines on the same requisition are locked to their committed quantityFulfilled.
  const [backorderFocusLineId, setBackorderFocusLineId] = useState<string | null>(null);
  const [backorderFocusRemaining, setBackorderFocusRemaining] = useState<number>(0);

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

  // (Old selectedFulfillBo stock-fetch effect removed — drawer retired.)

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

  // Reset draft and idempotency key when selected requisition changes
  const [fulfillmentAttemptKey, setFulfillmentAttemptKey] = useState<string | null>(null);
  const [isFulfillmentLoading, setIsFulfillmentLoading] = useState(false);

  useEffect(() => {
    setFulfillDraftMap(new Map());
    setFulfillmentAttemptKey(null);
  }, [selectedReq?.id]);

  const getSafeFulfillQty = useCallback((li: any) => {
    const requested = Number(li.quantityRequested ?? 0);
    const hqStock = li.hqAvailableStock;
    if (requested <= 0) return 0;
    if (hqStock != null) {
      if (li.isFGMode) {
        const packQty = Number(li.packQty ?? li.packQtySnapshot ?? 1);
        const availablePacks = Math.max(0, Math.floor(Number(hqStock) / packQty));
        return Math.min(requested, availablePacks);
      } else {
        return Math.max(0, Math.min(requested, Number(hqStock) || 0));
      }
    }
    return requested;
  }, []);

  const fulfillAllAvailable = useCallback(() => {
    setFulfillDraftMap(() => {
      const next = new Map<string, number>();
      hqReqItems.forEach((li: any) => {
        next.set(li.id, getSafeFulfillQty(li));
      });
      return next;
    });
  }, [getSafeFulfillQty, hqReqItems]);

  const markAllShortagesAsBackorder = useCallback(() => {
    setFulfillDraftMap(() => {
      const next = new Map<string, number>();
      hqReqItems.forEach((li: any) => {
        const requested = Number(li.quantityRequested ?? 0);
        const hqStock = li.hqAvailableStock;
        if (hqStock != null) {
          const packQty = li.isFGMode ? (li.packQtySnapshot ?? 1) : 1;
          const hqStockPacks = li.isFGMode ? Math.floor(hqStock / packQty) : hqStock;
          if (hqStockPacks < requested) {
            next.set(li.id, 0); // shortage -> backorder
          } else {
            next.set(li.id, requested); // full supply
          }
        } else {
          next.set(li.id, requested);
        }
      });
      return next;
    });
  }, [hqReqItems]);

  const clearFulfillmentDraft = useCallback(() => {
    setFulfillDraftMap(() => {
      const next = new Map<string, number>();
      hqReqItems.forEach((li: any) => {
        next.set(li.id, 0);
      });
      return next;
    });
  }, [hqReqItems]);

  const setLineFulfillQuantity = useCallback((lineId: string, qty: number) => {
    setFulfillDraftMap(prev => new Map(prev).set(lineId, qty));
  }, []);

  // Initialise missing entries from loaded line items.
  //
  // Three cases:
  //   1. Fully fulfilled (status=fulfilled): always show committed DB value — read-only.
  //   2. Re-entry from Backorders tab (backordered/partially_fulfilled + backorderFocusLineId):
  //        - Focused line: prefill to safe remaining qty (min of stock, remaining, maxRemaining).
  //        - All other lines: committed quantityFulfilled — never auto-increase.
  //   3. First-time approval (status=approved, no focus): default to getSafeFulfillQty.
  useEffect(() => {
    if (!hqReqItems.length) return;
    const reqStatus = (selectedReq?.status ?? "").toLowerCase();
    const isTrulyLocked  = reqStatus === "fulfilled";
    const isReEntry      = reqStatus === "partially_fulfilled" || reqStatus === "backordered";
    setFulfillDraftMap(prev => {
      const next = new Map(prev);
      hqReqItems.forEach((li: any) => {
        if (next.has(li.id)) return; // preserve in-session edits
        if (isTrulyLocked) {
          // Fully fulfilled — always committed value.
          next.set(li.id, Number(li.quantityFulfilled ?? 0));
        } else if (isReEntry && backorderFocusLineId && li.id === backorderFocusLineId) {
          // Focused backorder line: prefill to the safe remaining qty.
          const safeFulfill    = getSafeFulfillQty(li);
          const alreadyCommitted = Number(li.quantityFulfilled ?? 0);
          const maxRemaining   = Math.max(0, Number(li.quantityRequested ?? 0) - alreadyCommitted);
          next.set(li.id, Math.min(safeFulfill, backorderFocusRemaining, maxRemaining));
        } else if (isReEntry) {
          // Non-focused lines on a re-entry: lock to committed value. Do NOT auto-increase.
          next.set(li.id, Number(li.quantityFulfilled ?? 0));
        } else {
          // Fresh approved requisition: default to max available.
          const current = Number(li.quantityFulfilled ?? 0);
          const defaultVal = current > 0 ? current : getSafeFulfillQty(li);
          next.set(li.id, defaultVal);
        }
      });
      return next;
    });
  }, [getSafeFulfillQty, hqReqItems, selectedReq?.status, backorderFocusLineId, backorderFocusRemaining]);

  // ── Fulfillment lock ──────────────────────────────────────────────────────────
  // Pure UI lock set by "Complete Fulfillment". Disables per-line inputs and
  // swaps the button to "Edit Fulfillment" so HQ can re-enter if needed.
  // No DB write — the DB is already up-to-date from per-line onBlur saves.
  const [isFulfillmentLocked, setIsFulfillmentLocked] = useState(false);
  // Lock when DB status is "fulfilled" — permanently done, cannot re-enter.
  // partially_fulfilled / backordered remain editable for follow-up fulfillment.
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

    if (status === "fulfilled" || status === "partially_fulfilled" || status === "backordered" || status === "partial") {
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
  // partially_fulfilled and backordered are re-enterable (follow-up fulfillment).
  // fulfilled is permanently locked (handled by isFulfillmentLocked).
  const FULFILLABLE_STATUSES  = new Set(["approved", "partially_fulfilled", "backordered"]);

  // Role guard: only hq_master, hq_admin (normalised to hq_master), and hq_ops
  // may complete fulfillment and cause stock deductions.
  // hq_fulfillment may review and approve/reject but not finalize fulfillment.
  const canCompleteFulfillment = !isHqFulfillment(profile);
  const FULFILLED_STATUSES    = new Set(["fulfilled", "partially_fulfilled", "backordered", "partial"]);
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
      // hq_fulfillment: open full ticket drawer inline — they can't access /deliveries
      if (isHqFulfillmentUser) {
        console.log("[fulfillment-ticket-open]", {
          deliveryTicketId: deliveryTicketForReq.id,
          deliveryTicketNumber: deliveryTicketForReq.ticketNumber,
          href: typeof window !== "undefined" ? window.location.href : "",
        });
        setDtLoading(true);
        try {
          // Always fetch the full ticket (with items + run) for the drawer
          const res = await getDeliveryTicketById(deliveryTicketForReq.id);
          console.log("[fulfillment-ticket-deeplink]", {
            ticketId: deliveryTicketForReq.id,
            loadedTicketId: res.data?.id,
            loadedTicketNumber: res.data?.ticketNumber,
          });
          if (res.success && res.data) {
            setDtDrawerTicket(res.data);
          } else {
            alert(`Could not load delivery ticket: ${res.error?.message ?? "Unknown error"}`);
          }
        } finally {
          setDtLoading(false);
        }
        return;
      }
      // All other roles: navigate to /deliveries (existing behavior)
      router.push("/deliveries");
      return;
    }
    // Ticket does not exist yet — generate it (hq_fulfillment cannot reach this branch
    // since the button is hidden for them when no ticket exists)
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
    // Returns per-commissary aggregations.
    // Pack fields (isFGMode, packQty) are carried through so renderProductionTable
    // can display Pack Size / Required Qty / Total Base Qty per item.
    //
    // Quantity semantics (same as Delivery Ticket Pack Breakdown / Fulfillment Pick List):
    //   isFGMode = true  → quantityRequested is PACK COUNT
    //                      baseQty = packCount × packQty
    //   isFGMode = false → quantityRequested is BASE UNITS (loose/raw)
    //   packQty null/0   → configuration missing; never invent pack math

    const normalize = (d: string): string => {
      if (!d) return "";
      if (isNaN(Date.parse(d))) return d.trim();
      return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    };
    const targetDate = normalize(productionDate);

    type LocEntry = { loc: string; qty: number; baseQty: number };
    type AggEntry = {
      totalQty:  number;       // always PACK COUNT for FG, BASE UNITS for loose
      unit:      string;
      isFGMode:  boolean;
      packQty:   number | null; // null or 0 = missing config
      locations: LocEntry[];
    };
    type AggMap = Record<string, AggEntry>;

    const pending:   Record<string, AggMap> = {};
    const completed: Record<string, AggMap> = {};
    for (const c of COMMISSARY_OPTIONS) { pending[c] = {}; completed[c] = {}; }

    const addToAgg = (
      agg: AggMap,
      name: string,
      unit: string,
      qty: number,         // pack count (FG) or base units (loose)
      loc: string,
      isFGMode: boolean,
      packQty: number | null
    ) => {
      if (!name || qty <= 0) return;
      const pq = (packQty != null && Number(packQty) > 0) ? Number(packQty) : null;
      const baseQty = (isFGMode && pq) ? qty * pq : qty;
      if (!agg[name]) {
        agg[name] = { totalQty: 0, unit, isFGMode, packQty: pq, locations: [] };
      }
      agg[name].totalQty += qty;
      const existing = agg[name].locations.find((l) => l.loc === loc);
      if (existing) {
        existing.qty     += qty;
        existing.baseQty += baseQty;
      } else {
        agg[name].locations.push({ loc, qty, baseQty });
      }
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
        const isFGMode: boolean = !!li.isFGMode;
        // packQtySnapshot is already resolved in mapReqItemRow; default 1 is set there.
        // We treat packQty=1 the same as packQty>1 — just one unit per pack.
        const packQty: number | null = li.packQtySnapshot != null ? Number(li.packQtySnapshot) : null;
        const commissary: string = li.sourceCommissary ?? "Commissary HQ";
        if (!pending[commissary])   pending[commissary]   = {};
        if (!completed[commissary]) completed[commissary] = {};

        if (s === "fulfilled") {
          addToAgg(completed[commissary], name, unit, fulfilled, locKey, isFGMode, packQty);
        } else {
          addToAgg(pending[commissary], name, unit, requested, locKey, isFGMode, packQty);
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

  // ─── Pack display helpers for HQ Production ───────────────────────────────
  // Identical semantics to Delivery Ticket Pack Breakdown and Fulfillment Pick List:
  //   FG item with valid packQty → qty = pack count, base = qty × packQty
  //   Loose/raw item             → qty = base units, packSize = Loose
  //   Missing/zero packQty on FG → show amber warning, no pack math

  type ProdAggEntry = {
    totalQty:  number;
    unit:      string;
    isFGMode:  boolean;
    packQty:   number | null;
    locations: { loc: string; qty: number; baseQty: number }[];
  };

  function prodPackSizeLabel(entry: ProdAggEntry): string {
    if (!entry.isFGMode) return "Loose";
    if (!entry.packQty || entry.packQty <= 0) return "—";
    return `${entry.packQty} ${entry.unit || "ea"} / pack`;
  }

  function prodRequiredLabel(qty: number, entry: ProdAggEntry): string {
    if (!entry.isFGMode) return `${qty} ${entry.unit || "ea"}`;
    if (!entry.packQty || entry.packQty <= 0) return `${qty} packs`;
    return `${qty} pack${qty !== 1 ? "s" : ""}`;
  }

  function prodTotalBaseLabel(qty: number, entry: ProdAggEntry): string {
    if (!entry.isFGMode) return `${qty} ${entry.unit || "ea"}`;
    if (!entry.packQty || entry.packQty <= 0) return "—";
    return `${qty * entry.packQty} ${entry.unit || "ea"}`;
  }

  const missingPackConfig = (entry: ProdAggEntry) =>
    entry.isFGMode && (!entry.packQty || entry.packQty <= 0);

  // Helper to render a production aggregation table (shared by pending and completed sections)
  const renderProductionTable = (
    entries: [string, ProdAggEntry][],
    colorClass: string
  ) => (
    <div className="overflow-x-auto rounded-xl border border-neutral-200 print:border-none shadow-sm print:shadow-none">
      <Table className="bg-white print:bg-transparent">
        <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider print:bg-transparent">
          <TableRow>
            <TableHead className="w-[40px] px-4 print:px-0">#</TableHead>
            <TableHead className="py-3 px-4 print:px-0">Item</TableHead>
            <TableHead className="py-3 px-4 print:px-0 hidden sm:table-cell">Pack Size</TableHead>
            <TableHead className="py-3 px-4 print:px-0">Required</TableHead>
            <TableHead className="py-3 px-4 print:px-0 hidden sm:table-cell">Total Base Qty</TableHead>
            <TableHead className="py-3 px-4 print:px-0 hidden md:table-cell text-center">Destinations</TableHead>
            <TableHead className="py-3 px-4 print:px-0 print:hidden w-[36px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([itemName, data], idx) => {
            const entry = data as ProdAggEntry;
            const isExpanded = expandedRows.includes(itemName);
            const isMissing  = missingPackConfig(entry);
            return (
              <React.Fragment key={idx}>
                {/* Main row */}
                <TableRow
                  className="hover:bg-brand-50/30 cursor-pointer print:hover:bg-transparent"
                  onClick={() => toggleExpand(itemName)}
                >
                  {/* # / expand icon */}
                  <TableCell className="px-4 py-3 print:px-0">
                    <div className="print:hidden">
                      {isExpanded
                        ? <ChevronDown className="h-4 w-4 text-brand-600" />
                        : <ChevronRight className="h-4 w-4 text-neutral-400" />}
                    </div>
                    <div className="hidden print:block text-neutral-500 font-medium">#{idx + 1}</div>
                  </TableCell>

                  {/* Item name + missing-config warning */}
                  <TableCell className="py-3 px-4 print:px-0">
                    <span className="font-bold text-neutral-900 text-sm">{itemName}</span>
                    {isMissing && (
                      <div className="mt-0.5 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 inline-block">
                        Pack config missing — confirm before production
                      </div>
                    )}
                  </TableCell>

                  {/* Pack Size */}
                  <TableCell className="py-3 px-4 print:px-0 hidden sm:table-cell">
                    <span className={`text-xs font-semibold px-2 py-1 rounded-md ${
                      entry.isFGMode && !isMissing
                        ? "bg-blue-50 text-blue-700 border border-blue-100"
                        : isMissing
                        ? "bg-amber-50 text-amber-700 border border-amber-200"
                        : "bg-neutral-100 text-neutral-600"
                    }`}>
                      {prodPackSizeLabel(entry)}
                    </span>
                  </TableCell>

                  {/* Required / Production Qty */}
                  <TableCell className="py-3 px-4 print:px-0">
                    <span className={`font-bold text-sm px-2 py-1 rounded-md print:bg-transparent ${colorClass}`}>
                      {prodRequiredLabel(entry.totalQty, entry)}
                    </span>
                  </TableCell>

                  {/* Total Base Qty */}
                  <TableCell className="py-3 px-4 print:px-0 hidden sm:table-cell">
                    {isMissing ? (
                      <span className="text-xs text-amber-600 font-semibold">Confirm manually</span>
                    ) : (
                      <span className="text-sm font-semibold text-neutral-700">
                        {prodTotalBaseLabel(entry.totalQty, entry)}
                      </span>
                    )}
                  </TableCell>

                  {/* Destination count */}
                  <TableCell className="py-3 px-4 print:px-0 hidden md:table-cell text-center">
                    <span className="text-sm font-semibold text-neutral-600">
                      {entry.locations.length}
                    </span>
                  </TableCell>

                  {/* Expand chevron (screen only) */}
                  <TableCell className="py-3 px-2 print:hidden text-right">
                    <span className="text-[10px] text-neutral-400 font-medium">
                      {isExpanded ? "hide" : "detail"}
                    </span>
                  </TableCell>
                </TableRow>

                {/* Expanded per-location rows */}
                <TableRow className={`bg-neutral-50/50 print:table-row print:bg-transparent ${isExpanded ? "table-row" : "hidden print:table-row"}`}>
                  <TableCell colSpan={7} className="px-10 py-3 print:px-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 py-2">
                      {entry.locations.map((loc, lIdx) => (
                        <div key={lIdx} className="flex justify-between items-start text-sm py-1.5 border-b border-neutral-200 border-dashed last:border-0">
                          <span className="text-neutral-600 font-medium truncate max-w-[55%]">{loc.loc}</span>
                          <div className="text-right">
                            <div className="font-bold text-neutral-900 bg-white border border-neutral-200 px-2 rounded-md shadow-sm text-xs">
                              {prodRequiredLabel(loc.qty, entry)}
                            </div>
                            {entry.isFGMode && !isMissing && (
                              <div className="text-[10px] text-neutral-500 mt-0.5">
                                {prodTotalBaseLabel(loc.qty, entry)}
                              </div>
                            )}
                          </div>
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
    <>
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
          <Drawer isOpen={!!selectedReq} onClose={() => { setSelectedReq(null); setHqReqItems([]); setBackorderFocusLineId(null); setBackorderFocusRemaining(0); }}  
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
                    {/* Ticket button: hq_fulfillment only sees it when a ticket exists. */}
                    {["approved", "fulfilled"].includes((selectedReq?.status ?? "").toLowerCase()) &&
                     (deliveryTicketForReq || !isHqFulfillmentUser) && (
                      <button
                        onClick={handleDeliveryTicketAction}
                        disabled={deliveryTicketLoading || dtLoading}
                        className="px-4 py-2 text-sm font-medium bg-white border border-brand-200 text-brand-700 rounded-lg hover:bg-brand-50 transition-colors shadow-sm flex items-center gap-2 disabled:opacity-50"
                      >
                        <Truck className="h-4 w-4" />
                        {(deliveryTicketLoading || dtLoading)
                          ? "Checking Ticket..."
                          : deliveryTicketForReq
                            ? "View Delivery Ticket"
                            : "Generate Delivery Ticket"}
                      </button>
                    )}
                    {/* Approve / Reject — submitted/draft reqs only */}
                    {["submitted", "draft"].includes((selectedReq?.status ?? "").toLowerCase()) && (() => {
                      const isFF = isHqFulfillment(profile);

                      // Use the same isHqLine() logic as storage.ts.
                      // A line is HQ if: has finished_good_id, OR source_type='hq_supplied',
                      // OR source_type is null/missing and no catalog_item_id (legacy HQ row).
                      // A line is local_vendor ONLY when source_type='local_vendor' and no FG id.
                      const isHqLine = (li: any): boolean => {
                        const fg  = li.finishedGoodId ?? li.finished_good_id ?? null;
                        const st  = (li.sourceType ?? li.source_type ?? '').toLowerCase().trim();
                        const cat = li.catalogItemId ?? li.catalog_item_id ?? null;
                        if (fg) return true;
                        if (st === 'hq_supplied') return true;
                        if (st === 'local_vendor') return false;
                        return !cat; // legacy null: HQ if no catalog_item_id
                      };

                      const hasHqLines  = hqReqItems.length > 0 && hqReqItems.some(isHqLine);
                      const hasLvLines  = hqReqItems.length > 0 && hqReqItems.some((li: any) => !isHqLine(li));
                      const allLv       = hqReqItems.length > 0 && !hasHqLines;
                      const isMixed     = hasHqLines && hasLvLines;

                      // For hq_fulfillment: block only when ALL lines are confirmed local_vendor.
                      // Unknown/null source_type is treated as HQ (safe default).
                      if (isFF && allLv) {
                        return (
                          <div className="px-3 py-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg">
                            Local-vendor requisition — HQ approval not required.
                          </div>
                        );
                      }

                      return (
                        <>
                          {isMixed && (
                            <div className="px-3 py-1.5 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg">
                              Mixed requisition — HQ items require HQ fulfillment; local-vendor items are excluded from HQ approval.
                            </div>
                          )}
                          <button
                            onClick={() => {
                              setRejectModalReqId(selectedReq.id);
                              setRejectionReason("");
                            }}
                            disabled={rejectActionLoading || approveActionLoading}
                            className="px-4 py-2 text-sm font-medium bg-white border border-danger-200 text-danger-700 rounded-lg hover:bg-danger-50 transition-colors shadow-sm flex items-center gap-2 disabled:opacity-50"
                          >
                            <XSquare className="h-4 w-4" /> Reject
                          </button>
                          <button
                            onClick={async () => {
                              if (!selectedReq || approveActionLoading) return;
                              setApproveActionLoading(true);
                              try {
                                const res = await approveRequisition(
                                  selectedReq.id,
                                  profile?.id ?? '',
                                  profile?.role ?? null
                                );
                                if (res.success) {
                                  // Refresh the local list
                                  setRequisitions(prev =>
                                    prev.map(r =>
                                      r.id === selectedReq.id
                                        ? { ...r, status: 'approved', approvedBy: profile?.id, approvedAt: new Date().toISOString() }
                                        : r
                                    )
                                  );
                                  setSelectedReq((prev: any) => prev ? { ...prev, status: 'approved' } : prev);
                                } else {
                                  alert(`Approval failed: ${res.error?.message ?? 'Unknown error'}`);
                                }
                              } finally {
                                setApproveActionLoading(false);
                              }
                            }}
                            disabled={approveActionLoading || rejectActionLoading}
                            className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm flex items-center gap-2 disabled:opacity-50"
                          >
                            {approveActionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                            {approveActionLoading ? 'Approving...' : 'Approve'}
                          </button>
                        </>
                      );
                    })()}
                    {/* hq_fulfillment: read-only notice replaces Complete Fulfillment */}
                    {!canCompleteFulfillment && selectedReq && FULFILLABLE_STATUSES.has((selectedReq.status ?? "").toLowerCase()) && (
                      <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                        <Info className="h-4 w-4 shrink-0" />
                        Fulfillment review only — contact hq_admin or hq_ops to complete this fulfillment.
                      </div>
                    )}
                    {/* Complete Fulfillment — shown only for management roles (not hq_fulfillment) on fulfillable statuses */}
                    {selectedReq && canCompleteFulfillment && FULFILLABLE_STATUSES.has((selectedReq.status ?? "").toLowerCase()) && !isFulfillmentLocked && (() => {
                      // ── Pre-flight: classify every line before allowing submission ──────────
                      // Local vendor items must NEVER go through the HQ atomic RPC.
                      const localVendorLines = hqReqItems.filter((li: any) =>
                        li.sourceType === 'local_vendor'
                      );
                      // Unmapped HQ lines: source_type is hq_supplied (or legacy null) but
                      // both item_id AND finished_good_id are null → RPC will crash with
                      // "Shared item_id not resolved for inventory item NULL"
                      const unmappedHqLines = hqReqItems.filter((li: any) =>
                        li.sourceType !== 'local_vendor' &&
                        !li.itemId &&
                        !li.finishedGoodId
                      );
                      const hasPreflightErrors = localVendorLines.length > 0 || unmappedHqLines.length > 0;

                      return (
                        <>
                                {/* Pre-flight warning banner — shown only when there are blocking items */}
                          {hasPreflightErrors && (
                            <div className="w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                              <p className="font-semibold mb-1">⚠ Cannot finalize: mapping issues detected</p>
                              {localVendorLines.length > 0 && (() => {
                                // Inline HQ FC supplier detection — uses the same alias list as
                                // isHqFulfillmentCentreSupplier() but without an extra fetch.
                                // supplierSnapshot is a text field snapshotted at order time.
                                const HQ_FC_ALIASES = [
                                  'veggie paradise', 'veggieparadise', 'vp',
                                  'momo loco', 'momoloco', 'momo-loco',
                                ];
                                const normSnap = (s: string | null | undefined) =>
                                  (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
                                const isHqFcSnap = (snap: string | null | undefined) =>
                                  HQ_FC_ALIASES.includes(normSnap(snap));

                                return (
                                  <div className="mt-1">
                                    <p className="font-medium text-amber-700">
                                      {localVendorLines.length} item{localVendorLines.length > 1 ? 's' : ''} blocked from HQ fulfillment — individual setup required:
                                    </p>
                                    <ul className="mt-0.5 space-y-0.5 pl-3">
                                      {localVendorLines.map((li: any) => {
                                        const isHqFc = isHqFcSnap(li.supplierSnapshot ?? li.supplier_snapshot);
                                        return (
                                          <li key={li.id} className="list-disc text-amber-700">
                                            {li.itemName ?? li.catalogItemId ?? li.id}
                                            {isHqFc ? (
                                              <span className="ml-1 font-semibold text-slate-600 text-[10px]">
                                                [HQ Supplier Item — Setup Required]
                                              </span>
                                            ) : (
                                              <span className="ml-1 font-mono text-[10px] text-amber-500">[local_vendor]</span>
                                            )}
                                          </li>
                                        );
                                      })}
                                    </ul>
                                    {localVendorLines.some((li: any) => isHqFcSnap(li.supplierSnapshot ?? li.supplier_snapshot)) && (
                                      <p className="mt-1 text-[10px] text-slate-500 italic">
                                        Items marked "HQ Supplier Item — Setup Required" are from approved HQ suppliers
                                        (Veggie Paradise, Momo Loco) but have not yet been individually linked to an HQ Sale Item.
                                        Contact HQ admin to complete setup before fulfillment.
                                      </p>
                                    )}
                                  </div>
                                );
                              })()}
                              {unmappedHqLines.length > 0 && (
                                <div className="mt-1">
                                  <p className="font-medium text-amber-700">
                                    {unmappedHqLines.length} HQ item{unmappedHqLines.length > 1 ? 's' : ''} missing inventory mapping:
                                  </p>
                                  <ul className="mt-0.5 space-y-0.5 pl-3">
                                    {unmappedHqLines.map((li: any) => (
                                      <li key={li.id} className="list-disc text-amber-700">
                                        {li.itemName ?? li.id}
                                        <span className="ml-1 font-mono text-[10px] text-amber-500">
                                          [{li.sourceType ?? 'legacy'} · no item_id or finished_good_id]
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          )}
                      <button
                        disabled={isFulfillmentLoading || hasPreflightErrors}
                        onClick={async () => {
                          setIsFulfillmentLoading(true);
                          try {
                            let activeKey = fulfillmentAttemptKey;
                            if (!activeKey) {
                              activeKey = crypto.randomUUID();
                              setFulfillmentAttemptKey(activeKey);
                            }

                            const linesToSubmit = hqReqItems.map((li: any) => {
                              const val = fulfillDraftMap.has(li.id) ? Number(fulfillDraftMap.get(li.id)) : Number(li.quantityFulfilled ?? 0);
                              return {
                                lineId: li.id,
                                fulfilledQty: val,
                                availableQty: li.hqAvailableStock ?? 0
                              };
                            });

                            const res = await finalizeRequisitionFulfillment(
                              selectedReq.id,
                              linesToSubmit,
                              profile?.id || "",
                              profile?.fullName || "HQ User",
                              activeKey
                            );

                            if (!res.success) {
                              console.error("[Complete Fulfillment] RPC call failed:", res.error);
                              const dbMsg = res.dbErrorMessage
                                ? `\n\nDatabase error: ${res.dbErrorMessage}`
                                : "";
                              alert(`Fulfillment could not be finalized safely. Please retry or contact HQ admin.${dbMsg}`);
                              return;
                            }

                            // On success:
                            try {
                              const updatedBo = await loadBackorders();
                              setBackorders(updatedBo);
                            } catch (boErr) {
                              console.error("Failed to load backorders after fulfillment completion", boErr);
                            }

                            const newStatus = res.newStatus || "fulfilled";
                            const newTotal = res.totalAmount ?? linesToSubmit.reduce((sum, l) => {
                              const item = hqReqItems.find((li: any) => li.id === l.lineId);
                              return sum + (l.fulfilledQty * Number(item?.unitPrice ?? 0));
                            }, 0);

                            setSelectedReq((prev: any) =>
                              prev ? { ...prev, status: newStatus, totalAmount: newTotal } : prev
                            );
                            setRequisitions((prev: any[]) =>
                              prev.map(r =>
                                r.id === selectedReq.id
                                  ? { ...r, status: newStatus, totalAmount: newTotal }
                                  : r
                              )
                            );

                            // Update hqReqItems locally to reflect the finalized quantityFulfilled
                            setHqReqItems((prev: any[]) =>
                              prev.map(li => {
                                const submitted = linesToSubmit.find(l => l.lineId === li.id);
                                if (submitted) {
                                  return {
                                    ...li,
                                    quantityFulfilled: submitted.fulfilledQty,
                                    backorderQty: li.quantityRequested - submitted.fulfilledQty
                                  };
                                }
                                return li;
                              })
                            );

                            // Update cache
                            setReqItemsCache(prev => {
                              const next = new Map(prev);
                              const updatedItems = hqReqItems.map(li => {
                                const submitted = linesToSubmit.find(l => l.lineId === li.id);
                                if (submitted) {
                                  return { ...li, quantityFulfilled: submitted.fulfilledQty };
                                }
                                return li;
                              });
                              next.set(selectedReq.id, updatedItems);
                              return next;
                            });

                            setIsFulfillmentLocked(true);
                          } catch (err: any) {
                            console.error("[Complete Fulfillment] Unexpected error:", err);
                            alert("Fulfillment could not be finalized safely. Please retry or contact HQ admin.");
                          } finally {
                            setIsFulfillmentLoading(false);
                          }
                        }}
                        className="px-4 py-2 text-sm font-semibold bg-success-600 text-white rounded-lg hover:bg-success-700 disabled:opacity-50 transition-colors shadow-sm flex items-center gap-2"
                      >
                        {isFulfillmentLoading ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" /> Finalizing...
                          </>
                        ) : (
                          <>
                            <PackageCheck className="h-4 w-4" /> Complete Fulfillment
                          </>
                        )}
                      </button>
                        </>
                      );
                    })()}
                    {/* Completed badge — finalized requisitions */}
                    {selectedReq && ["fulfilled", "partially_fulfilled", "backordered"].includes((selectedReq.status ?? "").toLowerCase()) && (
                      <span className="px-4 py-2 text-sm font-semibold text-success-700 flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4" /> Finalized ({(selectedReq.status ?? "").replace(/_/g, " ")})
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
              {selectedReq && canCompleteFulfillment && FULFILLABLE_STATUSES.has((selectedReq.status ?? "").toLowerCase()) && !isFulfillmentLocked && hqReqItems.length > 0 && (
                <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3 space-y-2.5 shadow-sm">
                  <div>
                    <h4 className="text-xs font-bold text-neutral-500 uppercase tracking-wider">Fulfillment Control Panel</h4>
                    <p className="text-[11px] text-neutral-400">Quickly apply defaults to all line items in this requisition.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={fulfillAllAvailable}
                      className="px-3 py-1.5 text-xs font-semibold rounded bg-success-600 text-white hover:bg-success-700 transition-colors shadow-sm"
                    >
                      Fulfill All Available
                    </button>
                    <button
                      type="button"
                      onClick={markAllShortagesAsBackorder}
                      className="px-3 py-1.5 text-xs font-semibold rounded bg-amber-600 text-white hover:bg-amber-700 transition-colors shadow-sm"
                    >
                      Mark All Shortages as Backorder
                    </button>
                    <button
                      type="button"
                      onClick={clearFulfillmentDraft}
                      className="px-3 py-1.5 text-xs font-semibold rounded bg-neutral-200 text-neutral-700 hover:bg-neutral-300 transition-colors shadow-sm"
                    >
                      Clear Fulfillment Draft
                    </button>
                  </div>
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
                  const isEditable = canCompleteFulfillment && FULFILLABLE_STATUSES.has((selectedReq?.status ?? "").toLowerCase()) && !isFulfillmentLocked;
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
                            const isFinalized = ["fulfilled", "partially_fulfilled", "backordered"].includes((selectedReq?.status ?? "").toLowerCase());
                            // For finalized requisitions always read the committed DB value.
                            // For active/approved requisitions use the live draft map.
                            const committedQty = Number(item.quantityFulfilled ?? 0);
                            const draftQty = isFinalized
                              ? committedQty
                              : (fulfillDraftMap.get(item.id) ?? committedQty);
                            // Backorder: use committed backorder_qty from DB when finalized,
                            // otherwise derive from draft (requested - draftQty).
                            const committedBackorder = Number(item.backorderQty ?? item.backorder_qty ?? Math.max(0, requested - committedQty));
                            const backorder = isFinalized ? committedBackorder : Math.max(0, requested - draftQty);
                            const hqStock    = item.hqAvailableStock;
                            const packQty    = item.isFGMode ? (item.packQtySnapshot ?? 1) : 1;
                            const hqStockPacks = item.isFGMode && hqStock != null ? Math.floor(hqStock / packQty) : hqStock;
                            const maxFulfill = Math.min(requested, hqStockPacks ?? requested);
                            const unitPrice  = Number(item.unitPrice ?? 0);
                            const lineTotal  = draftQty * unitPrice;
                            let badgeLabel = "Pending";
                            let badgeStyle = "border-neutral-200 bg-neutral-50 text-neutral-600"; // grey

                            if ((selectedReq?.status ?? "").toLowerCase() === "rejected") {
                              badgeLabel = "Cancelled";
                              badgeStyle = "border-red-200 bg-red-50 text-red-700";
                            } else if (isFinalized) {
                              // Derive badge purely from committed DB values for finalized rows
                              if (draftQty >= requested) {
                                badgeLabel = "Fully Supplied";
                                badgeStyle = "border-emerald-200 bg-emerald-50 text-emerald-700";
                              } else if (draftQty > 0) {
                                badgeLabel = "Partial / Backordered";
                                badgeStyle = "border-amber-200 bg-amber-50 text-amber-700";
                              } else {
                                badgeLabel = "Backordered";
                                badgeStyle = "border-rose-200 bg-rose-50 text-rose-700";
                              }
                            } else if (item.isFGMode && hqStock != null && hqStock < packQty) {
                              badgeLabel = "Out of Stock";
                              badgeStyle = "border-rose-200 bg-rose-50 text-rose-700";
                            } else if (hqStock != null && hqStock <= 0) {
                              badgeLabel = "Out of Stock";
                              badgeStyle = "border-rose-200 bg-rose-50 text-rose-700";
                            } else if (draftQty >= requested) {
                              badgeLabel = "Fully Supplied";
                              badgeStyle = "border-emerald-200 bg-emerald-50 text-emerald-700";
                            } else if (draftQty > 0) {
                              badgeLabel = "Partial / Backordered";
                              badgeStyle = "border-amber-200 bg-amber-50 text-amber-700";
                            } else {
                              badgeLabel = "Pending";
                              badgeStyle = "border-neutral-200 bg-neutral-50 text-neutral-600";
                            }

                            return (
                              <TableRow
                                key={item.id}
                                className={`hover:bg-neutral-50/50 transition-colors ${
                                  backorderFocusLineId === item.id
                                    ? "ring-2 ring-inset ring-amber-400 bg-amber-50/60"
                                    : ""
                                }`}
                              >
                                {/* Item + line status */}
                                <TableCell className="py-2 px-3">
                                  <div className="font-medium text-sm text-neutral-900 flex items-center gap-1.5">
                                    {item.itemName}
                                    {backorderFocusLineId === item.id && (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                                        <ArrowRight className="h-2.5 w-2.5" /> Backorder Focus
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-0.5">
                                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${badgeStyle}`}>
                                      {badgeLabel}
                                    </span>
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
                                        const val = Number(e.target.value);
                                        const clamped = Math.max(0, Math.min(maxFulfill, isNaN(val) ? 0 : val));
                                        setLineFulfillQuantity(item.id, clamped);
                                      }}
                                      className={`w-20 px-2 py-1 text-sm font-bold rounded-md border text-center ${
                                        !isEditable
                                          ? "bg-neutral-50 text-neutral-400 border-neutral-200 cursor-not-allowed"
                                          : badgeLabel === "Fully Supplied"
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
                                {/* Action: Quick buttons */}
                                <TableCell className="py-2 text-right">
                                  {isEditable ? (
                                    <div className="inline-flex gap-1 justify-end">
                                      <button
                                        type="button"
                                        onClick={() => setLineFulfillQuantity(item.id, requested)}
                                        className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-brand-50 text-brand-700 border border-brand-200 hover:bg-brand-100 transition-colors"
                                      >
                                        All
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setLineFulfillQuantity(item.id, maxFulfill)}
                                        className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-success-50 text-success-700 border border-success-200 hover:bg-success-100 transition-colors"
                                      >
                                        Avail
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setLineFulfillQuantity(item.id, 0)}
                                        className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 transition-colors"
                                      >
                                        BO
                                      </button>
                                    </div>
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
                {/* Footer — Reconciliation Summary */}
                {hqReqItems.length > 0 && (() => {
                  const isEditable = canCompleteFulfillment && FULFILLABLE_STATUSES.has((selectedReq?.status ?? "").toLowerCase()) && !isFulfillmentLocked;
                  
                  // Compute values — for finalized reqs use committed DB values exclusively.
                  const isFooterFinalized = ["fulfilled", "partially_fulfilled", "backordered"].includes((selectedReq?.status ?? "").toLowerCase());
                  const requestedVal = hqReqItems.reduce((sum: number, li: any) =>
                    sum + Number(li.quantityRequested) * Number(li.unitPrice ?? 0), 0);
                  const suppliedVal = hqReqItems.reduce((sum: number, li: any) => {
                    // For finalized: always use committed quantityFulfilled (even if 0).
                    // For active: prefer live draft map so HQ sees their current selections.
                    const qty = isFooterFinalized
                      ? Number(li.quantityFulfilled ?? 0)
                      : (fulfillDraftMap.has(li.id) ? Number(fulfillDraftMap.get(li.id)) : Number(li.quantityFulfilled ?? 0));
                    return sum + qty * Number(li.unitPrice ?? 0);
                  }, 0);
                  const backorderedVal = requestedVal - suppliedVal;

                  // Compute counts
                  const totalItems = hqReqItems.length;
                  let fullySuppliedCount = 0;
                  let partiallySuppliedCount = 0;
                  let backorderedCount = 0;

                  hqReqItems.forEach((li: any) => {
                    const qty = isFooterFinalized
                      ? Number(li.quantityFulfilled ?? 0)
                      : (fulfillDraftMap.has(li.id) ? Number(fulfillDraftMap.get(li.id)) : Number(li.quantityFulfilled ?? 0));
                    const req = Number(li.quantityRequested ?? 0);
                    if (qty >= req) {
                      fullySuppliedCount++;
                    } else if (qty > 0) {
                      partiallySuppliedCount++;
                    } else {
                      backorderedCount++;
                    }
                  });

                  return (
                    <div className="px-4 py-4 bg-neutral-50 border-t border-neutral-200 space-y-4">
                      {/* Reconciliation Title */}
                      <p className="text-xs font-bold text-neutral-500 uppercase tracking-wider">Reconciliation Summary</p>
                      
                      {/* Values Grid */}
                      <div className="grid grid-cols-3 gap-2">
                        <div className="bg-white border border-neutral-200 rounded-lg p-2.5 shadow-sm text-center">
                          <p className="text-[10px] font-semibold text-neutral-400 uppercase">Requested Value</p>
                          <p className="text-sm font-bold text-neutral-800 mt-0.5">${requestedVal.toFixed(2)}</p>
                        </div>
                        <div className="bg-white border border-success-200 rounded-lg p-2.5 shadow-sm text-center">
                          <p className="text-[10px] font-semibold text-success-600 uppercase">Supplied Value</p>
                          <p className="text-sm font-bold text-success-700 mt-0.5">${suppliedVal.toFixed(2)}</p>
                        </div>
                        <div className="bg-white border border-rose-200 rounded-lg p-2.5 shadow-sm text-center">
                          <p className="text-[10px] font-semibold text-danger-600 uppercase">Backordered Value</p>
                          <p className="text-sm font-bold text-danger-700 mt-0.5">${backorderedVal.toFixed(2)}</p>
                        </div>
                      </div>

                      {/* Quantities & Status Counts */}
                      <div className="bg-white border border-neutral-200 rounded-lg p-3 space-y-2 text-xs text-neutral-600 shadow-sm">
                        <div className="flex justify-between items-center">
                          <span className="font-medium">Requested Items:</span>
                          <span className="font-bold text-neutral-900">{totalItems}</span>
                        </div>
                        <div className="h-px bg-neutral-100 my-1" />
                        <div className="grid grid-cols-3 gap-2 text-center text-[11px] font-semibold">
                          <div className="text-success-700">
                            <span>Fully Supplied</span>
                            <span className="block text-sm font-bold mt-0.5">{fullySuppliedCount}</span>
                          </div>
                          <div className="text-amber-700">
                            <span>Partially Supplied</span>
                            <span className="block text-sm font-bold mt-0.5">{partiallySuppliedCount}</span>
                          </div>
                          <div className="text-rose-700">
                            <span>Backordered</span>
                            <span className="block text-sm font-bold mt-0.5">{backorderedCount}</span>
                          </div>
                        </div>
                                      </div>

                      {!isEditable && !isFulfillmentLocked && (
                        <p className="text-xs text-neutral-400 pt-1 text-center italic">
                          Approve this requisition to edit fulfillment quantities.
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
              <h2 className="text-xl font-bold text-neutral-800 mt-1">HQ Kitchen Production Sheet</h2>
              <div className="text-sm font-medium text-neutral-600 mt-2">
                Date: {productionDate} &nbsp;|&nbsp; Commissary: {activeCommissary}
              </div>
              <div className="text-xs text-neutral-500 mt-1">
                Required = Pack Count for FG items · Total Base Qty = Packs × Pack Size · Loose = base qty direct.
                '—' in Total Base = pack config missing, confirm with kitchen before production.
              </div>
            </div>

            {/* ── Screen-only: Batch summary stats ── */}
            {(() => {
              const allEntries = [...pendingEntries, ...completedEntries] as [string, ProdAggEntry][];
              const destSet = new Set(allEntries.flatMap(([, e]) => e.locations.map(l => l.loc)));
              const normDate = (d: string) => {
                if (!d) return "";
                if (isNaN(Date.parse(d))) return d.trim();
                return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
              };
              const targetNorm = normDate(productionDate);
              const reqSet = new Set(
                requisitions
                  .filter(r => PRODUCTION_STATUSES.has((r.status ?? "").toLowerCase()) && normDate(r.date ?? "") === targetNorm)
                  .map(r => r.id)
              );
              const missingCount = allEntries.filter(([, e]) => e.isFGMode && (!e.packQty || e.packQty <= 0)).length;
              return (
                <div className="print:hidden grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 mb-2">
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-center">
                    <div className="text-2xl font-black text-amber-700">{pendingEntries.length}</div>
                    <div className="text-[10px] font-bold text-amber-600 uppercase tracking-wide mt-0.5">Pending Items</div>
                  </div>
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-center">
                    <div className="text-2xl font-black text-emerald-700">{completedEntries.length}</div>
                    <div className="text-[10px] font-bold text-emerald-600 uppercase tracking-wide mt-0.5">Completed</div>
                  </div>
                  <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-3 text-center">
                    <div className="text-2xl font-black text-neutral-700">{destSet.size}</div>
                    <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-wide mt-0.5">Destinations</div>
                  </div>
                  <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-3 text-center">
                    <div className="text-2xl font-black text-neutral-700">{reqSet.size}</div>
                    <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-wide mt-0.5">Requisitions</div>
                  </div>
                  <div className={`rounded-xl p-3 text-center border ${
                    missingCount > 0 ? "bg-amber-50 border-amber-200" : "bg-neutral-50 border-neutral-200"
                  }`}>
                    <div className={`text-2xl font-black ${missingCount > 0 ? "text-amber-700" : "text-neutral-400"}`}>
                      {missingCount}
                    </div>
                    <div className={`text-[10px] font-bold uppercase tracking-wide mt-0.5 ${
                      missingCount > 0 ? "text-amber-600" : "text-neutral-400"
                    }`}>
                      Missing Pack Config
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ── Pending Production ── */}
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
              <p className="text-zinc-500 text-sm">Outstanding backorder shortages to locations.</p>
            </div>
            {/* KPI pills */}
            <div className="flex flex-wrap gap-2">
              {(() => {
                const openLines = backorders.filter(b =>
                  (b.status === 'open' || b.status === 'partially_fulfilled') &&
                  Number(b.remainingQty ?? 0) > 0
                );
                const outstandingValue = openLines.reduce(
                  (s, b) => s + Number(b.remainingQty ?? 0) * Number(b.unitPrice ?? 0), 0
                );
                const locCount = new Set(openLines.map(b => b.locationId)).size;
                return (
                  <>
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-900/30 border border-amber-700/40 text-amber-300 text-xs font-semibold">
                      {openLines.length} open line{openLines.length !== 1 ? 's' : ''}
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-800 border border-white/10 text-zinc-300 text-xs font-semibold">
                      ${outstandingValue.toFixed(2)} outstanding
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-800 border border-white/10 text-zinc-300 text-xs font-semibold">
                      {locCount} location{locCount !== 1 ? 's' : ''}
                    </span>
                  </>
                );
              })()}
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
                <option value="open_only">Open / Partial</option>
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
                    <TableHead className="py-3.5">Requisition #</TableHead>
                    <TableHead className="py-3.5 text-right">Requested</TableHead>
                    <TableHead className="py-3.5 text-right">Supplied</TableHead>
                    <TableHead className="py-3.5 text-right">Outstanding</TableHead>
                    <TableHead className="py-3.5">Unit</TableHead>
                    <TableHead className="py-3.5 text-right">Unit Price</TableHead>
                    <TableHead className="py-3.5 text-right">Backorder Value</TableHead>
                    <TableHead className="py-3.5">Status</TableHead>
                    <TableHead className="py-3.5">Created</TableHead>
                    <TableHead className="px-6 py-3.5 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backordersLoading ? (
                    <TableRow>
                      <TableCell colSpan={12} className="py-10 text-center text-zinc-500 text-sm">
                        <div className="flex items-center justify-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" /> Loading backorders...
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : filteredBackorders.length > 0 ? (
                    filteredBackorders.map((bo) => {
                      const isOpen = bo.status === 'open' || bo.status === 'partially_fulfilled';
                      const remainingQty = Number(bo.remainingQty ?? 0);
                      const isFulfillable = isOpen && remainingQty > 0;
                      const isLocalVendor = bo.sourceType === 'local_vendor';
                      const boValue = remainingQty * Number(bo.unitPrice ?? 0);
                      const createdDateStr = bo.createdAt
                        ? new Date(bo.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                        : '—';
                      const reasonLabel: Record<string, string> = {
                        out_of_stock:                    'Out of Stock',
                        awaiting_production:             'Awaiting Production',
                        awaiting_supplier_delivery:      'Awaiting Supplier',
                        hq_supplier_setup_required:      'Supplier Setup Required',
                        local_vendor_not_hq_fulfillable: 'Local Vendor',
                        manual_hold:                     'Manual Hold',
                      };
                      const reasonText = bo.backorderReason
                        ? (reasonLabel[bo.backorderReason] ?? bo.backorderReason)
                        : null;
                      return (
                        <TableRow
                          key={bo.id}
                          className={`border-b border-white/5 transition-colors ${
                            isLocalVendor
                              ? 'opacity-50 bg-[#0e0e0e]'
                              : 'hover:bg-[#151515]/50'
                          }`}
                        >
                          <TableCell className="px-6 py-4 font-medium text-zinc-100">
                            {locationById.get(bo.locationId) ?? bo.locationId}
                          </TableCell>
                          <TableCell className="py-4 text-sm">
                            <div className="font-semibold text-zinc-100">{bo.itemName}</div>
                            <div className="text-zinc-500 text-xs mt-0.5">
                              {bo.sourceType}
                              {reasonText && (
                                <span className="ml-1.5 text-amber-500">· {reasonText}</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="py-4 text-xs text-zinc-400 font-mono">{bo.originalRequisitionId}</TableCell>
                          <TableCell className="py-4 text-right text-sm text-zinc-300">{bo.requestedQty}</TableCell>
                          <TableCell className="py-4 text-right text-sm text-zinc-300">{bo.fulfilledQty}</TableCell>
                          <TableCell className="py-4 text-right text-sm font-semibold text-amber-400">{remainingQty}</TableCell>
                          <TableCell className="py-4 text-sm text-zinc-300">{bo.unit}</TableCell>
                          <TableCell className="py-4 text-right text-sm text-zinc-400">${Number(bo.unitPrice ?? 0).toFixed(2)}</TableCell>
                          <TableCell className="py-4 text-right text-sm font-semibold text-amber-300">${boValue.toFixed(2)}</TableCell>
                          <TableCell className="py-4">
                            <StatusBadge status={bo.status} />
                          </TableCell>
                          <TableCell className="py-4 text-sm text-zinc-400">{createdDateStr}</TableCell>
                          <TableCell className="px-6 py-4">
                            <div className="flex items-center justify-end gap-2">
                              {/* Review — always available (opens main req drawer, read-only for hq_fulfillment) */}
                              <button
                                onClick={() => {
                                  const req = requisitions.find(r => r.id === bo.originalRequisitionId);
                                  if (!req) {
                                    alert(`Requisition ${bo.originalRequisitionId} not found.`);
                                    return;
                                  }
                                  setBackorderFocusLineId(null);
                                  setBackorderFocusRemaining(0);
                                  setSelectedReq(req);
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-700 text-xs font-medium text-zinc-200 hover:bg-zinc-600 transition-colors"
                              >
                                Review
                              </button>
                              {/* Fulfill Remaining — only for management roles and only for open/partial non-local-vendor rows */}
                              {canCompleteFulfillment && isFulfillable && !isLocalVendor && (
                                <button
                                  onClick={() => {
                                    const req = requisitions.find(r => r.id === bo.originalRequisitionId);
                                    if (!req) {
                                      alert(`Requisition ${bo.originalRequisitionId} not found.`);
                                      return;
                                    }
                                    // Set focused line — draft initializer will use this
                                    setBackorderFocusLineId(bo.originalRequisitionItemId ?? null);
                                    setBackorderFocusRemaining(remainingQty);
                                    setSelectedReq(req);
                                  }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 text-xs font-semibold text-white hover:bg-blue-500 transition-colors"
                                >
                                  <ArrowRight className="h-3 w-3" />
                                  Fulfill Remaining
                                </button>
                              )}
                              {/* Local vendor badge — not HQ fulfillable */}
                              {isLocalVendor && (
                                <span className="text-xs text-zinc-600 italic">local vendor</span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={12} className="py-10 text-center text-sm text-zinc-500">
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

      {/* Old fulfillBackorder drawer removed — replaced by the canonical requisition fulfillment drawer.
           fulfillBackorder() in storage.ts is retained for location-manager backorder history view. */}

      {/* ── Rejection Modal ──────────────────────────────────────────────────── */}
      {rejectModalReqId && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-danger-100">
                <XSquare className="h-5 w-5 text-danger-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-neutral-900">Reject Requisition</h3>
                <p className="text-xs text-neutral-500">This action cannot be undone.</p>
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-neutral-700 mb-1.5">
                Rejection Reason <span className="text-danger-600">*</span>
              </label>
              <textarea
                rows={3}
                value={rejectionReason}
                onChange={e => setRejectionReason(e.target.value)}
                placeholder="Explain why this requisition is being rejected…"
                className="w-full border border-neutral-300 rounded-lg p-3 text-sm text-neutral-900 resize-none focus:outline-none focus:ring-2 focus:ring-danger-400 placeholder:text-neutral-400"
                autoFocus
              />
              {rejectionReason.trim() === '' && (
                <p className="mt-1 text-xs text-danger-600">A reason is required before rejecting.</p>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 pt-2 border-t border-neutral-100">
              <button
                onClick={() => { setRejectModalReqId(null); setRejectionReason(''); }}
                disabled={rejectActionLoading}
                className="px-4 py-2 text-sm font-medium text-neutral-600 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!rejectionReason.trim() || rejectActionLoading) return;
                  setRejectActionLoading(true);
                  try {
                    const res = await rejectRequisition(
                      rejectModalReqId,
                      profile?.id ?? '',
                      rejectionReason.trim(),
                      profile?.role ?? null
                    );
                    if (res.success) {
                      setRequisitions(prev =>
                        prev.map(r =>
                          r.id === rejectModalReqId
                            ? { ...r, status: 'rejected', rejectionReason: rejectionReason.trim(), rejectedBy: profile?.id, rejectedAt: new Date().toISOString() }
                            : r
                        )
                      );
                      if (selectedReq?.id === rejectModalReqId) {
                        setSelectedReq((prev: any) => prev ? {
                          ...prev,
                          status: 'rejected',
                          rejectionReason: rejectionReason.trim(),
                          rejectedBy: profile?.id,
                          rejectedAt: new Date().toISOString()
                        } : prev);
                      }
                      setRejectModalReqId(null);
                      setRejectionReason('');
                    } else {
                      alert(`Rejection failed: ${res.error?.message ?? 'Unknown error'}`);
                    }
                  } finally {
                    setRejectActionLoading(false);
                  }
                }}
                disabled={!rejectionReason.trim() || rejectActionLoading}
                className="px-4 py-2 text-sm font-medium bg-danger-600 text-white rounded-lg hover:bg-danger-700 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {rejectActionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <XSquare className="h-4 w-4" />}
                {rejectActionLoading ? 'Rejecting...' : 'Confirm Rejection'}
              </button>
            </div>
          </div>
        </div>
      )}
      </DarkPageShell>

      {/* ── Delivery Ticket Drawer ─────────────────────────────────────────────
         Opened by hq_fulfillment clicking "View Delivery Ticket". Other roles
         navigate to /deliveries and use the full deliveries page instead. */}
      <DeliveryTicketDrawer
        ticket={dtDrawerTicket}
        onClose={() => setDtDrawerTicket(null)}
        onRefresh={async () => {
          if (dtDrawerTicket?.id) {
            const res = await getDeliveryTicketById(dtDrawerTicket.id);
            if (res.success && res.data) setDtDrawerTicket(res.data);
          }
        }}
        user={profile ? { id: profile.id, email: "", name: profile.fullName ?? "", role: profile.role ?? null, locationId: profile.locationId ?? null } : null}
        canEditAdmin={isHqMaster(profile)}
        canActOnTicket={isHqMaster(profile) || isHqOps(profile)}
        onToast={() => {}}
      />
    </>
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
