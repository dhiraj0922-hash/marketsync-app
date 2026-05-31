"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin } from "@/lib/roles";
import {
  loadLocations, loadOutletCatalog, loadOutletInventoryV2,
  upsertOutletInventoryRowV2, bulkUpsertOutletInventoryV2,
  copyOutletInventoryItemsToLocationsV2,
  saveNewRequisition, sendHqRequisitionNotification,
  applyPhysicalCount,
  type OutletCatalogItem, type OutletInventoryRowV2, type CountApplyEntry,
  type CopyOutletInventoryResult,
} from "@/lib/storage";
import {
  exportToExcel, downloadOutletTemplate, parseExcelFile,
  validateOutletRows, mapExcelRowToOutletRecord,
} from "@/lib/excel";
import {
  MapPin, Download, Upload, Save, Search, CheckCircle2,
  RefreshCw, X, Store, Package, Plus, FileSpreadsheet, ClipboardList,
  AlertCircle, ClipboardCheck, TrendingUp, TrendingDown, Minus,
  Copy, Users,
} from "lucide-react";

type SourceFilter = "all" | "hq_supplied" | "local_vendor";
type ViewMode = "active" | "catalog" | "disabled" | "suggested";
const HQ_VIEW_MODES: [ViewMode, string][] = [
  ["active",    "Active"],
  ["catalog",   "Add"],
  ["disabled",  "Disabled"],
  ["suggested", "Suggested"],
];
const LOCATION_VIEW_MODES: [ViewMode, string][] = [
  ["active",    "Active"],
  ["suggested", "Suggested"],
];

const isValidCopyTargetLocation = (loc: any, sourceLocationId: string) => {
  const id = String(loc?.id ?? "").trim();
  const name = String(loc?.name ?? "").trim();
  const status = String(loc?.status ?? "").trim().toLowerCase();
  const isInactive = ["inactive", "disabled", "archived", "closed"].includes(status);

  return Boolean(
    id &&
    name &&
    id !== sourceLocationId &&
    id !== "LOC-HQ" &&
    id !== "LOC-NULL" &&
    name.toLowerCase() !== "null" &&
    !isInactive
  );
};

const isInvalidLocationRecord = (loc: any) => {
  const id = String(loc?.id ?? "").trim();
  const name = String(loc?.name ?? "").trim();
  const status = String(loc?.status ?? "").trim().toLowerCase();
  return !id || !name || id === "LOC-NULL" || name.toLowerCase() === "null" || ["inactive", "disabled", "archived", "closed"].includes(status);
};

interface MergedRow {
  itemId: string; name: string; category: string; uom: string;
  type: string; sourceType: "hq_supplied" | "local_vendor";
  supplier: string; price: number; taxRate: number; orderingEnabled: boolean;
  hqSaleItemId: string | null;
  // outlet
  outletRowId: string | null;
  currentStock: number; physicalCount: number | null;
  minOnHand: number; parLevel: number;
  localEnabled: boolean; localNotes: string;
  localSupplier: string; localPrice: string; // string so input stays controlled
  dirty: boolean; saving: boolean;
}

function merge(catalog: OutletCatalogItem[], outlet: OutletInventoryRowV2[]): MergedRow[] {
  const map = new Map(outlet.map((r) => [r.itemId, r]));
  return catalog.map((c) => {
    const o = map.get(c.itemId);
    return {
      itemId: c.itemId, name: c.name, category: c.category ?? "",
      uom: c.uom ?? "", type: c.type, sourceType: c.sourceType,
      supplier: c.supplier ?? "", price: c.price, taxRate: c.taxRate,
      orderingEnabled: c.orderingEnabled, hqSaleItemId: c.hqSaleItemId ?? null,
      outletRowId: o?.id ?? null,
      currentStock: o?.currentStock ?? 0,
      physicalCount: o?.physicalCount ?? null,
      minOnHand: o?.minOnHand ?? 0, parLevel: o?.parLevel ?? 0,
      localEnabled: o?.localEnabled ?? false, localNotes: o?.localNotes ?? "",
      localSupplier: o?.localSupplier ?? "", localPrice: o?.localPrice != null ? String(o.localPrice) : "",
      dirty: false, saving: false,
    };
  });
}

export default function OutletInventoryPage() {
  const { user } = useAuth();
  const hq = isHqAdmin(user);

  const [catalog,      setCatalog]      = useState<OutletCatalogItem[]>([]);
  const [outletData,   setOutletData]   = useState<OutletInventoryRowV2[]>([]);
  const [locations,    setLocations]    = useState<any[]>([]);
  const [selectedLoc,  setSelectedLoc]  = useState("");
  const [rows,         setRows]         = useState<MergedRow[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState("");
  const [srcFilter,    setSrcFilter]    = useState<SourceFilter>("all");
  const [viewMode,     setViewMode]     = useState<ViewMode>("active");
  const [savingAll,    setSavingAll]    = useState(false);

  // Suggested Order View Filters
  const [suggestedQtyOnly, setSuggestedQtyOnly] = useState(false);

  // Requisition Modal State
  const [reqModalOpen, setReqModalOpen] = useState(false);
  const [reqNotes,     setReqNotes]     = useState("");
  const [reqSaving,    setReqSaving]    = useState(false);

  // Physical Count Modal State
  const [countModalOpen,  setCountModalOpen]  = useState(false);
  const [countNotes,      setCountNotes]      = useState("");
  const [countApplying,   setCountApplying]   = useState(false);

  // Bulk enable state (catalog mode)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [bulkEnabling,    setBulkEnabling]    = useState(false);

  // Copy selected location inventory setup to other outlets
  const [copyModalOpen, setCopyModalOpen] = useState(false);
  const [copyTargets, setCopyTargets] = useState<Set<string>>(new Set());
  const [copyMinPar, setCopyMinPar] = useState(true);
  const [copySupplierSettings, setCopySupplierSettings] = useState(true);
  const [copyStockCounts, setCopyStockCounts] = useState(false);
  const [copyUpdateExisting, setCopyUpdateExisting] = useState(false);
  const [copyRunning, setCopyRunning] = useState(false);
  const [copyResult, setCopyResult] = useState<CopyOutletInventoryResult | null>(null);

  // import state (old excel.ts validation modal — kept for backward compat)
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importRows,   setImportRows]   = useState<any[]>([]);
  const [validation,   setValidation]   = useState<any>(null);
  const [importing,    setImporting]    = useState(false);
  const [toast,        setToast]        = useState<string | null>(null);

  // ── Stock Import (Phase 2) ────────────────────────────────────────────────
  // Separate from catalog import. Only updates location_inventory_items fields.
  const [stockImportOpen,     setStockImportOpen]     = useState(false);
  const [stockImportMatched,  setStockImportMatched]  = useState<any[]>([]);
  const [stockImportUnmatched,setStockImportUnmatched]= useState<any[]>([]);
  const [stockCommitting,     setStockCommitting]     = useState(false);

  // ── Location resolution ──────────────────────────────────────────────────
  // activeLoc is the single source of truth for all DB calls.
  // For HQ admin:          activeLoc = selectedLoc (controlled via dropdown)
  // For location_manager:  activeLoc = user.locationId (immutable — never user-settable)
  const activeLoc = hq ? selectedLoc : (user?.locationId ?? "");

  const loadAll = useCallback(async (locId: string) => {
    if (!locId) return;
    setLoading(true);
    try {
      const [cat, outlet] = await Promise.all([loadOutletCatalog(), loadOutletInventoryV2(locId)]);
      setCatalog(Array.isArray(cat) ? cat : []);
      setOutletData(Array.isArray(outlet) ? outlet : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    (async () => {
      if (hq) {
        // HQ admin: fetch all outlet locations and default to the first one
        const locs = await loadLocations();
        const outlets = locs.filter((l: any) => l.id !== "LOC-HQ");
        setLocations(outlets);
        if (outlets.length) setSelectedLoc(outlets[0].id);
        // loadAll will fire via the activeLoc useEffect below
      } else {
        // Location manager: no location list needed; activeLoc is always user.locationId
        // Do NOT call loadLocations() — they must not receive the full list.
        const loc = user?.locationId ?? "";
        // Ensure selectedLoc reflects their location (defensive — activeLoc ignores it anyway)
        if (loc) setSelectedLoc(loc);
        // Trigger initial load directly since activeLoc depends on user?.locationId
        if (loc) await loadAll(loc);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hq]);

  useEffect(() => { if (activeLoc) loadAll(activeLoc); }, [activeLoc, loadAll]);
  useEffect(() => { setRows(merge(catalog, outletData)); }, [catalog, outletData]);
  // Clear selection when location or view mode changes
  useEffect(() => { setSelectedItemIds(new Set()); }, [activeLoc, viewMode]);
  useEffect(() => {
    if (!hq && (viewMode === "catalog" || viewMode === "disabled")) {
      setViewMode("active");
    }
  }, [hq, viewMode]);

  // Suggested order helpers
  const getRowPrice = useCallback((r: MergedRow) => {
    if (r.localPrice !== "" && r.localPrice != null) {
      const p = parseFloat(r.localPrice);
      if (!isNaN(p)) return p;
    }
    return r.price;
  }, []);

  const getRowSupplier = useCallback((r: MergedRow) => {
    return r.localSupplier || r.supplier || "—";
  }, []);

  const getRowSuggestedQty = useCallback((r: MergedRow) => {
    if (!r.parLevel || r.parLevel <= 0) return 0;
    return Math.max(r.parLevel - r.currentStock, 0);
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return rows.filter((r) => {
      // View mode gates
      if (viewMode === "active") {
        if (!r.outletRowId || !r.localEnabled) return false;
      }
      if (viewMode === "disabled") {
        if (!r.outletRowId || r.localEnabled) return false;
      }
      if (viewMode === "suggested") {
        if (!r.outletRowId || !r.localEnabled) return false;
        if (suggestedQtyOnly && getRowSuggestedQty(r) <= 0) return false;
      }

      if (srcFilter !== "all" && r.sourceType !== srcFilter) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.category.toLowerCase().includes(q) && !r.supplier.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, srcFilter, viewMode, suggestedQtyOnly, getRowSuggestedQty]);

  const activeLocationLabel = useMemo(() => {
    const loc = locations.find((l: any) => l.id === activeLoc);
    return loc ? `${loc.name ?? loc.id} / ${loc.id}` : activeLoc;
  }, [activeLoc, locations]);

  const copyTargetLocations = useMemo(() => {
    const validLocations = locations.filter((loc: any) => isValidCopyTargetLocation(loc, activeLoc));
    const skippedLocations = locations.filter(isInvalidLocationRecord);

    if (process.env.NODE_ENV === "development" && skippedLocations.length > 0) {
      console.warn("[OutletInventory] Skipping invalid copy target locations", skippedLocations);
    }

    return validLocations;
  }, [locations, activeLoc]);

  const selectedCopyRows = useMemo(
    () => rows.filter((r) => selectedItemIds.has(r.itemId) && r.outletRowId),
    [rows, selectedItemIds]
  );

  const visibleSelectableRows = useMemo(
    () => filtered.filter((r) => viewMode === "catalog" ? !r.localEnabled : Boolean(r.outletRowId)),
    [filtered, viewMode]
  );

  const patch = (itemId: string, p: Partial<MergedRow>) =>
    setRows((prev) => prev.map((r) => r.itemId === itemId ? { ...r, ...p, dirty: true } : r));

  const saveRow = async (row: MergedRow) => {
    setRows((prev) => prev.map((r) => r.itemId === row.itemId ? { ...r, saving: true } : r));
    await upsertOutletInventoryRowV2({
      item_id: row.itemId, location_id: activeLoc,
      current_stock: row.currentStock,
      // physical_count is NEVER written by saveRow — it is exclusively managed
      // by applyPhysicalCount. Passing null here prevents stale count values
      // from being persisted to DB when the user saves other fields.
      physical_count: null,
      min_on_hand: row.minOnHand, par_level: row.parLevel,
      local_enabled: row.localEnabled, local_notes: row.localNotes || null,
      local_supplier: row.localSupplier || null,
      local_price: row.localPrice !== "" ? parseFloat(row.localPrice) : null,
    });
    setRows((prev) => prev.map((r) => r.itemId === row.itemId ? { ...r, saving: false, dirty: false } : r));
  };

  const saveAll = async () => {
    setSavingAll(true);
    await Promise.all(rows.filter((r) => r.dirty).map(saveRow));
    setSavingAll(false);
  };

  // Rows eligible for physical count:
  //   - must be active (localEnabled) with an existing outlet row
  //   - physicalCount must be a valid finite number (not null, not NaN, not undefined)
  //   - 0 is a valid count (stock-out confirmation)
  const countableRows = useMemo(() =>
    rows.filter((r) => r.localEnabled && r.outletRowId && r.physicalCount !== null && Number.isFinite(r.physicalCount)),
  [rows]);

  const handleApplyCount = async () => {
    if (countableRows.length === 0) return;
    setCountApplying(true);
    try {
      const entries: CountApplyEntry[] = countableRows.map((r) => ({
        itemId:        r.itemId,
        locationId:    activeLoc,
        previousStock: r.currentStock,
        physicalCount: r.physicalCount as number,
        varianceQty:   (r.physicalCount as number) - r.currentStock,
        minOnHand:     r.minOnHand,
        parLevel:      r.parLevel,
        localEnabled:  r.localEnabled,
        localNotes:    r.localNotes || null,
        localSupplier: r.localSupplier || null,
        localPrice:    r.localPrice !== "" ? parseFloat(r.localPrice) : null,
      }));

      const result = await applyPhysicalCount(
        entries,
        user?.id ?? null,
        countNotes.trim() || null
      );

      setCountModalOpen(false);
      setCountNotes("");

      if (result.failed === 0) {
        // Optimistically clear physicalCount for all applied rows in local state
        // so countableRows empties immediately (before DB reload arrives).
        // Also update currentStock to match what we just wrote to DB.
        const appliedIds = new Set(entries.map((e) => e.itemId));
        setRows((prev) =>
          prev.map((r) =>
            appliedIds.has(r.itemId)
              ? {
                  ...r,
                  physicalCount: null,
                  currentStock: entries.find((e) => e.itemId === r.itemId)?.physicalCount ?? r.currentStock,
                  dirty: false,
                }
              : r
          )
        );
        setToast(`Physical count applied for ${result.succeeded} item${result.succeeded !== 1 ? "s" : ""}. Stock updated.`);
      } else {
        setToast(`Count applied: ${result.succeeded} succeeded, ${result.failed} failed.`);
        console.warn("[ApplyCount] errors:", result.errors);
      }

      await loadAll(activeLoc);
    } finally {
      setCountApplying(false);
    }
  };

  // Lazy-create a location row with local_enabled=true (catalog → active)
  const enableItem = async (row: MergedRow) => {
    if (!hq) return;
    setRows((prev) => prev.map((r) => r.itemId === row.itemId ? { ...r, saving: true } : r));
    await upsertOutletInventoryRowV2({
      item_id: row.itemId, location_id: activeLoc,
      current_stock: 0, physical_count: null,
      min_on_hand: 0, par_level: 0,
      local_enabled: true, local_notes: null,
    });
    await loadAll(activeLoc);          // reload so row appears in Active view
    setToast(`"${row.name}" enabled for ${activeLoc}.`);
  };

  // Bulk-enable a set of catalog items for the active location
  const handleBulkEnable = async (itemIds: string[]) => {
    if (!hq) return;
    if (itemIds.length === 0 || !activeLoc) return;
    setBulkEnabling(true);
    try {
      const outletMap = new Map(outletData.map((o) => [o.itemId, o]));
      const records = itemIds.map((id) => {
        const existing = outletMap.get(id);
        return {
          item_id:        id,
          location_id:    activeLoc,
          local_enabled:  true,
          current_stock:  existing?.currentStock  ?? 0,
          physical_count: existing?.physicalCount ?? null,
          min_on_hand:    existing?.minOnHand     ?? 0,
          par_level:      existing?.parLevel      ?? 0,
          local_notes:    existing?.localNotes    ?? null,
          local_supplier: existing?.localSupplier ?? null,
          local_price:    existing?.localPrice    ?? null,
        };
      });
      const result = await bulkUpsertOutletInventoryV2(records);
      const locLabel = locations.find((l: any) => l.id === activeLoc)?.name ?? activeLoc;
      setToast(`Enabled ${result.succeeded} item${result.succeeded !== 1 ? "s" : ""} for ${locLabel}.${result.failed ? ` (${result.failed} failed)` : ""}`);
      setSelectedItemIds(new Set());
      await loadAll(activeLoc);
    } finally {
      setBulkEnabling(false);
    }
  };

  const openCopyModal = () => {
    if (!hq || !activeLoc) {
      setToast("Select a source location before copying inventory setup.");
      return;
    }
    if (selectedCopyRows.length === 0) {
      setToast("Select existing outlet inventory rows to copy.");
      return;
    }
    if (copyTargetLocations.length === 0) {
      setToast("No target outlet locations are available.");
      return;
    }
    setCopyTargets(new Set(copyTargetLocations.map((l: any) => l.id)));
    setCopyMinPar(true);
    setCopySupplierSettings(true);
    setCopyStockCounts(false);
    setCopyUpdateExisting(false);
    setCopyResult(null);
    setCopyModalOpen(true);
  };

  const handleCopyToLocations = async () => {
    const validTargetIds = new Set(copyTargetLocations.map((loc: any) => loc.id));
    const targetIds = Array.from(copyTargets).filter((id) => validTargetIds.has(id));
    if (!activeLoc) {
      setToast("Select a source location before copying inventory setup.");
      return;
    }
    if (selectedCopyRows.length === 0) {
      setToast("Select at least one existing source item.");
      return;
    }
    if (targetIds.length === 0) {
      setToast("Select at least one target location.");
      return;
    }

    setCopyRunning(true);
    try {
      const result = await copyOutletInventoryItemsToLocationsV2({
        sourceLocationId: activeLoc,
        targetLocationIds: targetIds,
        itemIds: selectedCopyRows.map((r) => r.itemId),
        copyMinPar,
        copySupplierSettings,
        copyStockCounts,
        updateExistingSetupFields: copyUpdateExisting,
      });
      setCopyResult(result);
      setToast(`Copy complete: ${result.created} created, ${result.skipped} skipped, ${result.updated} updated, ${result.failed} failed.`);
    } finally {
      setCopyRunning(false);
    }
  };

  const handleExport = () => {
    const data = rows.map((r) => ({
      "Source Type": r.sourceType, "Inventory item": r.name,
      "Category": r.category, "UOM": r.uom, "Type": r.type,
      "Supplier": r.supplier, "Price": r.price, "Tax rate": r.taxRate,
      "Ordering enabled": r.orderingEnabled,
      "Min On Hand": r.minOnHand, "Par level": r.parLevel,
      "Current Stock": r.currentStock, "Physical Count": r.physicalCount ?? "",
      "Local Supplier": r.localSupplier, "Local Price": r.localPrice,
      "Local Enabled": r.localEnabled, "Local Notes": r.localNotes,
    }));
    exportToExcel(data, `outlet_inventory_${activeLoc}`);
  };

  // Exports the entire active suggested order list to Excel
  const handleExportSuggested = () => {
    const data = rows
      .filter((r) => r.outletRowId && r.localEnabled)
      .map((r) => {
        const suggestedQty = getRowSuggestedQty(r);
        const price = getRowPrice(r);
        const cost = suggestedQty * price;
        return {
          "Item": r.name,
          "Source Type": r.sourceType === "hq_supplied" ? "HQ Supplied" : "Local Vendor",
          "Category": r.category,
          "UOM": r.uom,
          "Current Stock": r.currentStock,
          "Min On Hand": r.minOnHand,
          "Par Level": r.parLevel,
          "Suggested Order Qty": suggestedQty,
          "Supplier": getRowSupplier(r),
          "Price": price,
          "Estimated Cost": cost,
        };
      });
    exportToExcel(data, `suggested_order_${activeLoc}`);
  };

  // Exports only the local vendor items where suggested qty > 0 to Excel
  const handleExportLocalVendor = () => {
    const data = rows
      .filter((r) => r.outletRowId && r.localEnabled && r.sourceType === "local_vendor" && getRowSuggestedQty(r) > 0)
      .map((r) => {
        const suggestedQty = getRowSuggestedQty(r);
        const price = getRowPrice(r);
        const cost = suggestedQty * price;
        return {
          "Local Vendor Item": r.name,
          "Category": r.category,
          "UOM": r.uom,
          "Current Stock": r.currentStock,
          "Min On Hand": r.minOnHand,
          "Par Level": r.parLevel,
          "Suggested Order Qty": suggestedQty,
          "Local Supplier": getRowSupplier(r),
          "Local Price": price,
          "Estimated Cost": cost,
        };
      });
    exportToExcel(data, `local_vendor_purchase_list_${activeLoc}`);
  };

  // Create HQ Requisition list (HQ supplied items with qty > 0)
  const hqRequisitionLines = useMemo(() => {
    return rows
      .filter((r) => r.outletRowId && r.localEnabled && r.sourceType === "hq_supplied" && getRowSuggestedQty(r) > 0)
      .map((r) => {
        const qty = getRowSuggestedQty(r);
        const price = getRowPrice(r);
        return {
          row: r,
          qty,
          price,
          total: qty * price
        };
      });
  }, [rows, getRowSuggestedQty, getRowPrice]);

  const hqRequisitionGrandTotal = useMemo(() => {
    return hqRequisitionLines.reduce((sum, line) => sum + line.total, 0);
  }, [hqRequisitionLines]);

  const handleSubmitRequisition = async () => {
    if (hqRequisitionLines.length === 0) return;
    setReqSaving(true);
    try {
      const reqId = `REQ-${Date.now()}`;
      const header = {
        id:          reqId,
        location_id: activeLoc,
        created_by:  user?.id || "System",
        status:      "submitted",
        notes:       reqNotes.trim(),
        date:        new Date().toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric"
        }),
      };

      const items = hqRequisitionLines.map((line) => {
        if (!line.row.hqSaleItemId) {
          throw new Error(`Catalog item "${line.row.name}" is missing a valid hq_sale_item_id.`);
        }
        return {
          item_id:                     null,
          finished_good_id:            line.row.hqSaleItemId,
          item_name_snapshot:          line.row.name,
          unit_snapshot:               line.row.uom || "ea",
          source_commissary_snapshot:  "Commissary HQ",
          quantity_requested:          line.qty,
          unit_price:                  line.price,
          line_total:                  parseFloat(line.total.toFixed(2)),
        };
      });

      const res = await saveNewRequisition(header, items);
      if (res.success) {
        // Non-blocking HQ notification — mirrors requisitions/page.tsx pattern.
        // All lines here are hq_supplied (local_vendor items are filtered out
        // by hqRequisitionLines which enforces sourceType === "hq_supplied").
        const notifyRes = await sendHqRequisitionNotification(reqId);
        if (notifyRes.success) {
          setToast("HQ requisition created. HQ notification email sent.");
        } else {
          console.warn("[OutletInventory] HQ notification failed:", notifyRes.error);
          setToast("HQ requisition created. HQ email notification failed.");
        }
        setReqModalOpen(false);
        setReqNotes("");
        // Reload all stock levels
        await loadAll(activeLoc);
      } else {
        alert(`Failed to save requisition: ${res.error?.message || "Unknown Database Error"}`);
      }
    } catch (err: any) {
      alert(`Error submitting requisition: ${err?.message || err}`);
    } finally {
      setReqSaving(false);
    }
  };


  // ── Stock Import Phase 2 ─────────────────────────────────────────────────
  // Parses a MarketMan-style CSV/XLSX and matches rows to outlet_catalog_items
  // by item_id (if present) or by normalized name+supplier+uom.
  // Only location_inventory_items fields are written — catalog is never touched.
  const handleStockImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!activeLoc) {
      alert("Select a location before importing stock.");
      e.target.value = "";
      return;
    }
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    try {
      // ── Parse file (XLSX or CSV) ────────────────────────────────────────
      let rawRows: Record<string, any>[];
      if (file.name.match(/\.csv$/i)) {
        const text = await file.text();
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) { alert("CSV has no data rows."); return; }
        const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
        rawRows = lines.slice(1).map(line => {
          const cols = line.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
          const row: Record<string, any> = {};
          headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });
          return row;
        });
      } else {
        const buf = await file.arrayBuffer();
        const XLSX = await import("xlsx");
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rawRows = XLSX.utils.sheet_to_json(ws, { defval: "" });
      }

      // ── MarketMan column aliases ─────────────────────────────────────────
      const STOCK_ALIASES: Record<string, string> = {
        "Product":               "Name",
        "Item":                  "Name",
        "Item Name":             "Name",
        "Vendor":                "Supplier",
        "Ordering Unit":         "UOM",
        "Unit":                  "UOM",
        "On Hand":               "Current Stock",
        "Quantity On Hand":      "Current Stock",
        "Stock":                 "Current Stock",
        "Count":                 "Physical Count",
        "Last Count":            "Physical Count",
        "Min on hand":           "Min",
        "Par Level":             "Par",
      };

      const rows = rawRows.map(raw => {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(raw)) {
          const canon = STOCK_ALIASES[k] ?? k;
          if (!(canon in out)) out[canon] = v;
        }
        return out;
      });

      // ── Build lookup maps from outlet_catalog_items ─────────────────────
      const norm = (s: any) => String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");

      // item_id → catalog row
      const byItemId = new Map<string, OutletCatalogItem>();
      // normalized "name|supplier|uom" → catalog row
      const byNSU    = new Map<string, OutletCatalogItem>();
      // normalized "name|uom" → catalog row (supplier-agnostic fallback)
      const byNU     = new Map<string, OutletCatalogItem>();

      for (const c of catalog) {
        byItemId.set(c.itemId, c);
        const nsu = `${norm(c.name)}|${norm(c.supplier)}|${norm(c.uom)}`;
        const nu  = `${norm(c.name)}|${norm(c.uom)}`;
        if (!byNSU.has(nsu)) byNSU.set(nsu, c);
        if (!byNU.has(nu))   byNU.set(nu, c);
      }

      // ── Match each row ───────────────────────────────────────────────────
      const matched:   any[] = [];
      const unmatched: any[] = [];

      for (const r of rows) {
        const nameRaw     = String(r["Name"]     ?? "").trim();
        const supplierRaw = String(r["Supplier"] ?? "").trim();
        const uomRaw      = String(r["UOM"]      ?? "").trim();
        const itemIdRaw   = String(r["Item ID"]  ?? "").trim();

        if (!nameRaw && !itemIdRaw) continue; // totally blank row

        // Parse numeric fields — undefined means column absent (don't update)
        const hasStock = "Current Stock" in r && r["Current Stock"] !== "";
        const hasCount = "Physical Count" in r && r["Physical Count"] !== "";
        const hasMin   = "Min"            in r && r["Min"]           !== "";
        const hasPar   = "Par"            in r && r["Par"]           !== "";

        const parsedStock = hasStock ? parseFloat(String(r["Current Stock"])) : null;
        const parsedCount = hasCount ? parseFloat(String(r["Physical Count"])) : null;
        const parsedMin   = hasMin   ? parseFloat(String(r["Min"]))           : null;
        const parsedPar   = hasPar   ? parseFloat(String(r["Par"]))           : null;

        // Attempt match
        let catalogRow: OutletCatalogItem | undefined;
        if (itemIdRaw)                     catalogRow = byItemId.get(itemIdRaw);
        if (!catalogRow && nameRaw) {
          const nsu = `${norm(nameRaw)}|${norm(supplierRaw)}|${norm(uomRaw)}`;
          catalogRow = byNSU.get(nsu);
        }
        if (!catalogRow && nameRaw) {
          const nu = `${norm(nameRaw)}|${norm(uomRaw)}`;
          catalogRow = byNU.get(nu);
        }
        if (!catalogRow && nameRaw) {
          // last resort: name-only match
          catalogRow = catalog.find(c => norm(c.name) === norm(nameRaw));
        }

        if (catalogRow) {
          matched.push({
            catalogRow,
            rawName: nameRaw || catalogRow.name,
            currentStock: hasStock && !isNaN(parsedStock!) ? parsedStock : null,
            physicalCount: hasCount && !isNaN(parsedCount!) ? parsedCount : null,
            minOnHand: hasMin && !isNaN(parsedMin!) ? parsedMin : null,
            parLevel: hasPar && !isNaN(parsedPar!) ? parsedPar : null,
          });
        } else {
          unmatched.push({ rawName: nameRaw || itemIdRaw, supplierRaw, uomRaw });
        }
      }

      setStockImportMatched(matched);
      setStockImportUnmatched(unmatched);
      setStockImportOpen(true);
    } catch (err: any) {
      alert(`Stock import parse error: ${err?.message ?? err}`);
    }
  };

  const commitStockImport = async () => {
    if (!activeLoc || stockImportMatched.length === 0) return;
    setStockCommitting(true);
    const now = new Date().toISOString();
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const m of stockImportMatched) {
      const cat: OutletCatalogItem = m.catalogRow;
      // Find existing outlet row to preserve fields not being updated
      const existing = outletData.find(o => o.itemId === cat.itemId);

      const payload: Parameters<typeof upsertOutletInventoryRowV2>[0] = {
        item_id:        cat.itemId,
        location_id:    activeLoc,
        // stock fields — use import value if present, else preserve existing
        current_stock:  m.currentStock  !== null ? m.currentStock  : (existing?.currentStock  ?? 0),
        physical_count: m.physicalCount !== null ? m.physicalCount : (existing?.physicalCount ?? null),
        min_on_hand:    m.minOnHand     !== null ? m.minOnHand     : (existing?.minOnHand     ?? 0),
        par_level:      m.parLevel      !== null ? m.parLevel      : (existing?.parLevel      ?? 0),
        // preserve outlet-only non-stock fields from existing row
        local_enabled:  existing?.localEnabled  ?? true,
        local_notes:    existing?.localNotes    ?? null,
        local_supplier: existing?.localSupplier ?? null,
        local_purchase_option: existing?.localPurchaseOption ?? null,
        local_price:    existing?.localPrice    ?? null,
        local_product_code: existing?.localProductCode ?? null,
        last_counted_at: (m.physicalCount !== null || m.currentStock !== null) ? now : (existing?.lastCountedAt ?? null),
      };

      const res = await upsertOutletInventoryRowV2(payload);
      if (res.success) { succeeded++; } else {
        failed++;
        errors.push(`${cat.name}: ${res.error?.message ?? "error"}`);
      }
    }

    setStockCommitting(false);
    setStockImportOpen(false);
    setStockImportMatched([]);
    setStockImportUnmatched([]);
    if (errors.length > 0) {
      alert(`Stock import: ${succeeded} saved, ${failed} failed.\n${errors.join("\n")}`);
    } else {
      setToast(`Stock import done: ${succeeded} row${succeeded !== 1 ? "s" : ""} updated for ${activeLoc}.`);
    }
    await loadAll(activeLoc);
  };

  // legacy import handlers (kept for backward compat with excel.ts validation)
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseExcelFile(file);
      setImportRows(parsed);
      const v = validateOutletRows(parsed, catalog, activeLoc, locations.map((l: any) => l.id));
      setValidation(v);
      setImportModalOpen(true);
    } catch (err: any) { alert(`Parse error: ${err?.message}`); }
    e.target.value = "";
  };

  const confirmImport = async () => {
    setImporting(true);
    const mapped = importRows.map((r) => mapExcelRowToOutletRecord(r, catalog, activeLoc)).filter(Boolean) as any[];
    const result = await bulkUpsertOutletInventoryV2(mapped);
    setImporting(false);
    setImportModalOpen(false);
    setToast(`Import done: ${result.succeeded} rows saved${result.failed ? `, ${result.failed} failed` : ""}.`);
    await loadAll(activeLoc);
  };

  const dirtyCount = rows.filter((r) => r.dirty).length;
  const viewModes = hq ? HQ_VIEW_MODES : LOCATION_VIEW_MODES;

  const srcBadge = (src: "hq_supplied" | "local_vendor") =>
    src === "hq_supplied"
      ? <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">HQ</span>
      : <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200">LOCAL</span>;

  return (
    <div className="space-y-4 p-3 sm:p-5 lg:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div className="min-w-0">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Store className="h-5 w-5 sm:h-6 sm:w-6 text-brand-600 shrink-0" /> Outlet Inventory
          </h2>
          <p className="text-neutral-500 text-xs sm:text-sm mt-0.5">
            HQ-supplied and local vendor items per outlet.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {viewMode === "suggested" ? (
            <>
              <button onClick={handleExportSuggested} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50">
                <FileSpreadsheet className="h-3.5 w-3.5 text-green-600" />
                <span className="hidden sm:inline">Export Suggested</span>
              </button>
              <button onClick={handleExportLocalVendor} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50">
                <Download className="h-3.5 w-3.5 text-teal-600" />
                <span className="hidden sm:inline">Export Local PO</span>
              </button>
              <button
                onClick={() => setReqModalOpen(true)}
                disabled={hqRequisitionLines.length === 0}
                className="inline-flex items-center gap-1.5 px-3 sm:px-4 py-2 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ClipboardList className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">HQ Requisition ({hqRequisitionLines.length})</span>
                <span className="sm:hidden">{hqRequisitionLines.length}</span>
              </button>
            </>
          ) : (
            <>
              <button onClick={downloadOutletTemplate} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50" title="Download template">
                <Download className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Template</span>
              </button>
              <button onClick={handleExport} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 disabled:opacity-50" title="Export">
                <Download className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Export</span>
              </button>
              <label
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 cursor-pointer ${!activeLoc ? "opacity-40 cursor-not-allowed" : ""}`}
                title={activeLoc ? "Import stock levels from MarketMan or CSV/XLSX" : "Select a location first"}
              >
                <Upload className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Import Stock</span>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  disabled={!activeLoc}
                  onChange={handleStockImport}
                />
              </label>
              {hq && (
                <button
                  onClick={openCopyModal}
                  disabled={!activeLoc || selectedCopyRows.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Copy selected existing outlet inventory rows to other locations"
                >
                  <Copy className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Copy Selected ({selectedCopyRows.length})</span>
                  <span className="sm:hidden">{selectedCopyRows.length}</span>
                </button>
              )}
              {/* Apply Physical Count — only shown in Active Items view with pending counts */}
              {viewMode === "active" && countableRows.length > 0 && (
                <button
                  onClick={() => setCountModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 sm:px-4 py-2 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors shadow-sm"
                >
                  <ClipboardCheck className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Apply Count ({countableRows.length})</span>
                  <span className="sm:hidden">{countableRows.length}</span>
                </button>
              )}
              {dirtyCount > 0 && (
                <button onClick={saveAll} disabled={savingAll} className="inline-flex items-center gap-1.5 px-3 sm:px-4 py-2 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-60">
                  <Save className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{savingAll ? "Saving…" : `Save (${dirtyCount})`}</span>
                  <span className="sm:hidden">{dirtyCount}</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Location selector — HQ admin gets dropdown; location manager gets a locked read-only pill */}
      {hq ? (
        <div className="flex items-center gap-3 bg-brand-50 border border-brand-200 rounded-lg px-4 py-2.5">
          <MapPin className="h-4 w-4 text-brand-600 shrink-0" />
          <span className="text-sm font-semibold text-brand-800">Location:</span>
          <select
            value={selectedLoc}
            onChange={(e) => setSelectedLoc(e.target.value)}
            className="text-sm border border-brand-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {locations.map((l: any) => <option key={l.id} value={l.id}>{l.name ?? l.id}</option>)}
          </select>
        </div>
      ) : activeLoc ? (
        <div className="flex items-center gap-2 bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-2">
          <MapPin className="h-4 w-4 text-brand-600 shrink-0" />
          <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Your Location</span>
          <span className="text-sm font-bold text-neutral-900">{activeLoc}</span>
        </div>
      ) : null}

      {/* Toast */}
      {toast && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-2 text-sm text-green-800">
          <CheckCircle2 className="h-4 w-4 shrink-0" />{toast}
          <button onClick={() => setToast(null)} className="ml-auto"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-wrap">
        <div className="relative w-full sm:w-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
          <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-3 py-2.5 sm:py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white w-full sm:w-48" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {viewModes.map(([m, label]) => (
            <button key={m} onClick={() => setViewMode(m)}
              className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors min-h-[40px] ${viewMode === m ? "bg-brand-600 text-white border-brand-600" : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}>
              {label}
            </button>
          ))}
          {(["all", "hq_supplied", "local_vendor"] as SourceFilter[]).map((f) => (
            <button key={f} onClick={() => setSrcFilter(f)}
              className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors min-h-[40px] ${srcFilter === f ? "bg-neutral-700 text-white border-neutral-700" : "bg-white border-neutral-200 text-neutral-500 hover:bg-neutral-50"} text-[10px]`}>
              {f === "all" ? "All" : f === "hq_supplied" ? "HQ" : "Local"}
            </button>
          ))}
          {viewMode === "suggested" && (
            <button
              onClick={() => setSuggestedQtyOnly(!suggestedQtyOnly)}
              className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors min-h-[40px] ${suggestedQtyOnly ? "bg-amber-600 text-white border-amber-600 hover:bg-amber-700" : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}
            >
              Qty &gt; 0
            </button>
          )}
        </div>
        <span className="text-xs text-neutral-400 sm:ml-auto">{filtered.length} items</span>
      </div>

      {/* Catalog mode: hint + bulk-enable toolbar */}
      {hq && viewMode === "catalog" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 bg-violet-50 border border-violet-200 rounded-lg px-4 py-2.5 text-xs text-violet-800">
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span><strong>Add From Catalog:</strong> Check items and click <strong>Enable Selected</strong>, or use <strong>Enable All Visible</strong> to bulk-activate items matching your current search/filter.</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => handleBulkEnable(Array.from(selectedItemIds))}
              disabled={selectedItemIds.size === 0 || bulkEnabling || !activeLoc}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {bulkEnabling ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {bulkEnabling ? "Enabling…" : `Enable Selected (${selectedItemIds.size})`}
            </button>
            <button
              onClick={() => handleBulkEnable(filtered.filter((r) => !r.localEnabled).map((r) => r.itemId))}
              disabled={filtered.filter((r) => !r.localEnabled).length === 0 || bulkEnabling || !activeLoc}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {bulkEnabling ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Enable All Visible ({filtered.filter((r) => !r.localEnabled).length})
            </button>
            {selectedItemIds.size > 0 && (
              <button
                onClick={() => setSelectedItemIds(new Set())}
                className="inline-flex items-center gap-1 px-2.5 py-2 text-xs text-neutral-500 hover:text-neutral-700 border border-neutral-200 rounded-lg bg-white hover:bg-neutral-50"
              >
                <X className="h-3 w-3" /> Clear Selection
              </button>
            )}
          </div>
        </div>
      )}

      {hq && viewMode !== "catalog" && viewMode !== "suggested" && selectedItemIds.size > 0 && (
        <div className="flex items-center gap-2 flex-wrap bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 text-xs text-slate-700">
          <Users className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          <span className="font-semibold">{selectedCopyRows.length} existing item{selectedCopyRows.length !== 1 ? "s" : ""} selected</span>
          <button
            onClick={openCopyModal}
            disabled={selectedCopyRows.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy to Locations
          </button>
          <button
            onClick={() => setSelectedItemIds(new Set())}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg bg-white hover:bg-slate-50"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        </div>
      )}

      {/* Suggested Mode header alert */}
      {viewMode === "suggested" && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-xs text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
          <span>
            <strong>Suggested Order view:</strong> Order quantities are calculated as <code>max(Par Level - Stock, 0)</code>. Items with Par Level = 0 or null result in 0 suggested order. Adjust Par Levels on the <strong>Active Items</strong> tab.
          </span>
        </div>
      )}

      {/* Table — desktop (md+) */}
      {loading ? (
        <div className="flex justify-center py-16 text-neutral-400 animate-pulse text-sm">Loading outlet inventory…</div>
      ) : catalog.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-400">
          <Package className="h-10 w-10" />
          <p className="text-sm font-medium">No outlet catalog items yet.</p>
          <p className="text-xs">Run <code className="bg-neutral-100 px-1 rounded">migration_outlet_catalog.sql</code> to seed from HQ finished goods, then import local vendor items via Excel.</p>
        </div>
      ) : (
        <>
          {/* ── Mobile card list (active / disabled views only; < md) ───────── */}
          {(viewMode === "active" || viewMode === "disabled") && (
            <div className="md:hidden space-y-3">
              {filtered.length === 0 ? (
                <div className="py-10 text-center text-neutral-400 text-sm">
                  {viewMode === "active" ? "No active items — switch to Add to enable items." : "No disabled items."}
                </div>
              ) : filtered.map((row) => (
                <div
                  key={row.itemId}
                  className={`bg-white border border-neutral-200 rounded-xl p-4 space-y-3 ${row.dirty ? "border-amber-300 bg-amber-50/30" : ""}`}
                >
                  {/* Card header */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-neutral-900 text-sm leading-tight truncate">{row.name}</p>
                      <p className="text-[10px] text-neutral-400 font-mono mt-0.5">{row.itemId}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {srcBadge(row.sourceType)}
                      {row.dirty && (
                        <button onClick={() => saveRow(row)} disabled={row.saving}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 min-h-[36px]">
                          {row.saving ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                          {row.saving ? "…" : "Save"}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Key fields grid */}
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-neutral-50 rounded-lg p-2 text-center">
                      <p className="text-[10px] text-neutral-400 font-medium uppercase tracking-wide">Stock</p>
                      <input type="number" min={0} value={row.currentStock}
                        onChange={(e) => patch(row.itemId, { currentStock: parseFloat(e.target.value) || 0 })}
                        className="w-full text-center text-sm font-bold text-neutral-900 bg-transparent border-none outline-none mt-0.5 tabular-nums" />
                    </div>
                    <div className="bg-indigo-50 rounded-lg p-2 text-center border border-indigo-100">
                      <p className="text-[10px] text-indigo-500 font-medium uppercase tracking-wide">Count</p>
                      <input type="number" min={0}
                        value={row.physicalCount ?? ""}
                        placeholder="—"
                        onChange={(e) => {
                          if (e.target.value === "") { patch(row.itemId, { physicalCount: null }); }
                          else { const p = parseFloat(e.target.value); patch(row.itemId, { physicalCount: Number.isFinite(p) ? p : null }); }
                        }}
                        className="w-full text-center text-sm font-bold text-indigo-700 bg-transparent border-none outline-none mt-0.5 tabular-nums placeholder:text-indigo-300" />
                    </div>
                    <div className="bg-neutral-50 rounded-lg p-2 text-center">
                      <p className="text-[10px] text-neutral-400 font-medium uppercase tracking-wide">Par</p>
                      <input type="number" min={0} value={row.parLevel}
                        onChange={(e) => patch(row.itemId, { parLevel: parseFloat(e.target.value) || 0 })}
                        className="w-full text-center text-sm font-bold text-neutral-900 bg-transparent border-none outline-none mt-0.5 tabular-nums" />
                    </div>
                  </div>

                  {/* Secondary info */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
                    {row.category && <span>{row.category}</span>}
                    {row.uom && <span className="text-neutral-400">{row.uom}</span>}
                    {row.supplier && <span>{row.supplier}</span>}
                    {row.localPrice && <span className="font-semibold text-neutral-700">${parseFloat(row.localPrice).toFixed(2)}</span>}
                  </div>

                  {/* On/Off toggle */}
                  <div className="flex items-center justify-between border-t border-neutral-100 pt-2">
                    <span className="text-xs text-neutral-500">Active for location</span>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={row.localEnabled}
                        onChange={(e) => patch(row.itemId, { localEnabled: e.target.checked })}
                        className="accent-brand-600 w-4 h-4" />
                      <span className="text-xs font-medium text-neutral-700">{row.localEnabled ? "On" : "Off"}</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Desktop table (md+) / all views ─────────────────────────────── */}
          <div className={`border border-neutral-200 rounded-xl overflow-hidden bg-white ${
            (viewMode === "active" || viewMode === "disabled") ? "hidden md:block" : ""
          }`}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-neutral-500 border-b border-neutral-200">
                {viewMode === "suggested" ? (
                  <tr>
                    <th className="px-4 py-3 text-left bg-neutral-100 font-semibold">Item</th>
                    <th className="px-3 py-3 text-left bg-neutral-100 font-semibold">Source</th>
                    <th className="px-3 py-3 text-left bg-neutral-100 font-semibold">Category</th>
                    <th className="px-3 py-3 text-left bg-neutral-100 font-semibold">UOM</th>
                    <th className="px-3 py-3 text-right bg-neutral-100 font-semibold">Stock</th>
                    <th className="px-3 py-3 text-right bg-neutral-100 font-semibold">Min</th>
                    <th className="px-3 py-3 text-right bg-neutral-100 font-semibold">Par</th>
                    <th className="px-3 py-3 text-right bg-neutral-100 font-semibold text-amber-700 bg-amber-50">Suggested</th>
                    <th className="px-3 py-3 text-left bg-neutral-100 font-semibold">Supplier</th>
                    <th className="px-3 py-3 text-right bg-neutral-100 font-semibold">Price</th>
                    <th className="px-4 py-3 text-right bg-neutral-100 font-semibold text-brand-700 bg-brand-50">Est. Cost</th>
                  </tr>
                ) : (
                  <tr>
                    {/* Checkbox column — HQ bulk actions */}
                    {hq && (
                      <th className="px-3 py-3 text-center bg-neutral-100 w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all visible items"
                          className="accent-green-600 w-3.5 h-3.5"
                          checked={visibleSelectableRows.length > 0 && visibleSelectableRows.every((r) => selectedItemIds.has(r.itemId))}
                          onChange={(e) => {
                            const itemIds = visibleSelectableRows.map((r) => r.itemId);
                            if (e.target.checked) {
                              setSelectedItemIds((prev) => new Set([...prev, ...itemIds]));
                            } else {
                              setSelectedItemIds((prev) => { const next = new Set(prev); itemIds.forEach((id) => next.delete(id)); return next; });
                            }
                          }}
                        />
                      </th>
                    )}
                    <th className="px-4 py-3 text-left bg-neutral-100 font-semibold">Item</th>
                    <th className="px-3 py-3 text-left bg-neutral-100 font-semibold">Source</th>
                    <th className="px-3 py-3 text-left bg-neutral-100 font-semibold">Category</th>
                    <th className="px-3 py-3 text-left bg-neutral-100 font-semibold">UOM</th>
                    <th className="px-3 py-3 text-left bg-neutral-100 font-semibold">Supplier</th>
                    <th className="px-3 py-3 text-right bg-neutral-100 font-semibold">Price</th>
                    <th className="px-3 py-3 text-right font-semibold">Stock</th>
                    <th className="px-3 py-3 text-right font-semibold">Count</th>
                    <th className="px-3 py-3 text-right font-semibold">Min</th>
                    <th className="px-3 py-3 text-right font-semibold">Par</th>
                    <th className="px-3 py-3 text-left font-semibold">Local Supplier</th>
                    <th className="px-3 py-3 text-right font-semibold">Local $</th>
                    <th className="px-3 py-3 text-center font-semibold">On</th>
                    <th className="px-3 py-3 text-left font-semibold">Notes</th>
                    <th className="px-4 py-3 text-right font-semibold">Save</th>
                  </tr>
                )}
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={viewMode === "suggested" ? 11 : hq ? 16 : 15} className="py-10 text-center text-neutral-400 text-sm">
                      {viewMode === "active" ? "No active items — switch to Add From Catalog to enable items for this location." :
                       viewMode === "disabled" ? "No disabled items for this location." :
                       viewMode === "suggested" ? (suggestedQtyOnly ? "No items need ordering (Suggested Qty > 0)." : "No active items to compute suggestions.") :
                       "No catalog items match your filters."}
                    </td>
                  </tr>
                ) : filtered.map((row) => {
                  const suggestedQty = getRowSuggestedQty(row);
                  const price = getRowPrice(row);
                  const supplier = getRowSupplier(row);
                  const estCost = suggestedQty * price;

                  if (viewMode === "suggested") {
                    return (
                      <tr key={row.itemId} className={`hover:bg-neutral-50/30 ${suggestedQty > 0 ? "bg-amber-50/20" : "opacity-75"}`}>
                        <td className="px-4 py-2 font-semibold text-neutral-900 text-xs">
                          {row.name}
                          <div className="text-[9px] text-neutral-400 font-mono font-normal">{row.itemId}</div>
                        </td>
                        <td className="px-3 py-2">{srcBadge(row.sourceType)}</td>
                        <td className="px-3 py-2 text-xs text-neutral-600">{row.category || "—"}</td>
                        <td className="px-3 py-2 text-xs text-neutral-600">{row.uom || "—"}</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-neutral-700">{row.currentStock}</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-neutral-700">{row.minOnHand}</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-neutral-700">{row.parLevel}</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums font-bold text-amber-700 bg-amber-50/50">
                          {suggestedQty}
                        </td>
                        <td className="px-3 py-2 text-xs text-neutral-600">{supplier}</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-neutral-700">${price.toFixed(2)}</td>
                        <td className="px-4 py-2 text-right text-xs tabular-nums font-bold text-brand-700 bg-brand-50/40">
                          ${estCost.toFixed(2)}
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr key={row.itemId} className={`${row.dirty ? "bg-amber-50/40" : "hover:bg-neutral-50/30"} ${viewMode === "catalog" && !row.localEnabled ? "" : !row.localEnabled ? "opacity-50" : ""}`}>
                      {/* Checkbox cell — catalog mode selects inactive catalog rows; other modes select existing outlet rows for copy */}
                      {hq && (
                        <td className="px-3 py-2 text-center">
                          {viewMode !== "catalog" || !row.localEnabled ? (
                            <input
                              type="checkbox"
                              aria-label={`Select ${row.name}`}
                              className="accent-green-600 w-3.5 h-3.5"
                              disabled={viewMode !== "catalog" && !row.outletRowId}
                              checked={selectedItemIds.has(row.itemId)}
                              onChange={(e) => {
                                setSelectedItemIds((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(row.itemId);
                                  else next.delete(row.itemId);
                                  return next;
                                });
                              }}
                            />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-500 mx-auto" />
                          )}
                        </td>
                      )}
                      {/* Read-only catalog columns */}
                      <td className="px-4 py-2 bg-neutral-50/60">
                        <div className="font-semibold text-neutral-900 text-xs leading-tight">{row.name}</div>
                        <div className="text-[9px] text-neutral-400 font-mono">{row.itemId}</div>
                      </td>
                      <td className="px-3 py-2 bg-neutral-50/60">{srcBadge(row.sourceType)}</td>
                      <td className="px-3 py-2 bg-neutral-50/60 text-xs text-neutral-600">{row.category || "—"}</td>
                      <td className="px-3 py-2 bg-neutral-50/60 text-xs text-neutral-600">{row.uom || "—"}</td>
                      <td className="px-3 py-2 bg-neutral-50/60 text-xs text-neutral-500">{row.supplier || "—"}</td>
                      <td className="px-3 py-2 bg-neutral-50/60 text-right text-xs tabular-nums text-neutral-700">{row.price > 0 ? `$${row.price.toFixed(2)}` : "—"}</td>
                      {/* Editable outlet columns */}
                      {[
                        ["currentStock", row.currentStock],
                        ["minOnHand",    row.minOnHand],
                        ["parLevel",     row.parLevel],
                      ].map(([key, val]) => (
                        <td key={key as string} className="px-2 py-1.5">
                          <input type="number" min={0} value={val as number}
                            onChange={(e) => patch(row.itemId, { [key]: parseFloat(e.target.value) || 0 })}
                            className="w-16 text-right text-xs tabular-nums border border-neutral-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500" />
                        </td>
                      ))}
                      <td className="px-2 py-1.5">
                        <input
                          type="number"
                          min={0}
                          value={row.physicalCount ?? ""}
                          placeholder="—"
                          onChange={(e) => {
                            if (e.target.value === "") {
                              patch(row.itemId, { physicalCount: null });
                            } else {
                              const parsed = parseFloat(e.target.value);
                              // Only accept valid finite numbers; reject NaN from partial input
                              patch(row.itemId, { physicalCount: Number.isFinite(parsed) ? parsed : null });
                            }
                          }}
                          className="w-16 text-right text-xs tabular-nums border border-neutral-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="text" value={row.localSupplier} placeholder="Supplier…"
                          onChange={(e) => patch(row.itemId, { localSupplier: e.target.value })}
                          className="w-28 text-xs border border-neutral-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500" />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" min={0} value={row.localPrice} placeholder="—"
                          onChange={(e) => patch(row.itemId, { localPrice: e.target.value })}
                          className="w-16 text-right text-xs tabular-nums border border-neutral-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500" />
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <input type="checkbox" checked={row.localEnabled}
                          onChange={(e) => patch(row.itemId, { localEnabled: e.target.checked })}
                          className="accent-brand-600 w-3.5 h-3.5" />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="text" value={row.localNotes} placeholder="Notes…"
                          onChange={(e) => patch(row.itemId, { localNotes: e.target.value })}
                          className="w-28 text-xs border border-neutral-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500" />
                      </td>
                      <td className="px-4 py-1.5 text-right">
                        {viewMode === "catalog" && !row.outletRowId ? (
                          <button onClick={() => enableItem(row)} disabled={row.saving}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-semibold bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
                            {row.saving ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : <Plus className="h-2.5 w-2.5" />}
                            {row.saving ? "…" : "Enable"}
                          </button>
                        ) : row.dirty ? (
                          <button onClick={() => saveRow(row)} disabled={row.saving}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50">
                            {row.saving ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : <Save className="h-2.5 w-2.5" />}
                            {row.saving ? "…" : "Save"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}

      {/* Copy Location Inventory Modal */}
      {copyModalOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white shadow-2xl border border-neutral-200">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-neutral-200 bg-white px-5 py-4">
              <div>
                <h3 className="text-base font-bold text-neutral-900 flex items-center gap-2">
                  <Copy className="h-4 w-4 text-slate-700" />
                  Copy Selected Items to Locations
                </h3>
                <p className="text-xs text-neutral-500 mt-1">
                  Source: <span className="font-semibold text-neutral-800">{activeLocationLabel}</span>
                  {" · "}
                  {selectedCopyRows.length} selected item{selectedCopyRows.length !== 1 ? "s" : ""}
                </p>
              </div>
              <button
                onClick={() => setCopyModalOpen(false)}
                className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                aria-label="Close copy modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-5 px-5 py-4">
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                Existing target rows are skipped by default. Stock and physical counts are protected unless you explicitly copy them for newly-created rows.
              </div>

              <section className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-sm font-bold text-neutral-900">Target Locations</h4>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCopyTargets(new Set(copyTargetLocations.map((l: any) => l.id)))}
                      className="text-xs font-semibold text-brand-700 hover:text-brand-900"
                    >
                      Select All
                    </button>
                    <button
                      onClick={() => setCopyTargets(new Set())}
                      className="text-xs font-semibold text-neutral-500 hover:text-neutral-800"
                    >
                      Clear All
                    </button>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  {copyTargetLocations.map((loc: any) => (
                    <label key={loc.id} className="flex items-center gap-3 rounded-lg border border-neutral-200 px-3 py-2.5 text-sm hover:bg-neutral-50">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand-600"
                        checked={copyTargets.has(loc.id)}
                        onChange={(e) => {
                          setCopyTargets((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(loc.id);
                            else next.delete(loc.id);
                            return next;
                          });
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-neutral-900">{loc.name ?? loc.id}</span>
                        <span className="block text-xs text-neutral-500">{loc.id}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              <section className="space-y-2">
                <h4 className="text-sm font-bold text-neutral-900">Copy Options</h4>
                <div className="grid gap-2">
                  {[
                    {
                      checked: copyMinPar,
                      onChange: setCopyMinPar,
                      title: "Copy min/par levels",
                      body: "New rows receive source min_on_hand and par_level. Existing rows are skipped unless update is enabled.",
                    },
                    {
                      checked: copySupplierSettings,
                      onChange: setCopySupplierSettings,
                      title: "Copy local supplier, price, and order settings",
                      body: "Copies local supplier, local purchase option, local price, product code, and enabled state.",
                    },
                    {
                      checked: copyStockCounts,
                      onChange: setCopyStockCounts,
                      title: "Copy stock/count values for newly-created rows",
                      body: "Default is off. When off, new target rows start with current_stock 0 and physical_count 0.",
                    },
                    {
                      checked: copyUpdateExisting,
                      onChange: setCopyUpdateExisting,
                      title: "Update existing setup fields",
                      body: "Optional. Updates min/par and local supplier settings on existing rows, but never overwrites stock, counts, or notes.",
                    },
                  ].map((option) => (
                    <label key={option.title} className="flex items-start gap-3 rounded-lg border border-neutral-200 px-3 py-2.5">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 accent-brand-600"
                        checked={option.checked}
                        onChange={(e) => option.onChange(e.target.checked)}
                      />
                      <span>
                        <span className="block text-sm font-semibold text-neutral-900">{option.title}</span>
                        <span className="block text-xs text-neutral-500">{option.body}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              {copyResult && (
                <section className="rounded-xl border border-green-200 bg-green-50 px-4 py-3">
                  <h4 className="text-sm font-bold text-green-900">Copy Result</h4>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="rounded-lg bg-white px-3 py-2"><span className="block text-neutral-500">Created</span><span className="font-bold text-neutral-900">{copyResult.created}</span></div>
                    <div className="rounded-lg bg-white px-3 py-2"><span className="block text-neutral-500">Skipped</span><span className="font-bold text-neutral-900">{copyResult.skipped}</span></div>
                    <div className="rounded-lg bg-white px-3 py-2"><span className="block text-neutral-500">Updated</span><span className="font-bold text-neutral-900">{copyResult.updated}</span></div>
                    <div className="rounded-lg bg-white px-3 py-2"><span className="block text-neutral-500">Failed</span><span className="font-bold text-neutral-900">{copyResult.failed}</span></div>
                  </div>
                  {copyResult.errors.length > 0 && (
                    <div className="mt-3 max-h-28 overflow-y-auto rounded-lg bg-white px-3 py-2 text-xs text-red-700">
                      {copyResult.errors.map((error, idx) => <div key={`${error}-${idx}`}>{error}</div>)}
                    </div>
                  )}
                </section>
              )}
            </div>

            <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-neutral-200 bg-white px-5 py-4">
              <button
                onClick={() => setCopyModalOpen(false)}
                className="px-4 py-2 text-sm font-semibold border border-neutral-200 rounded-lg hover:bg-neutral-50"
              >
                Close
              </button>
              <button
                onClick={handleCopyToLocations}
                disabled={copyRunning || copyTargets.size === 0 || selectedCopyRows.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {copyRunning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                {copyRunning ? "Copying..." : "Confirm Copy"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HQ Requisition Confirmation Review Modal */}
      {reqModalOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-5 w-5 text-brand-600" />
                <h3 className="text-base font-bold text-neutral-900">Review Draft HQ Requisition</h3>
              </div>
              <button onClick={() => setReqModalOpen(false)}><X className="h-5 w-5 text-neutral-400" /></button>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            <p className="text-xs text-neutral-500">
              The following active HQ Supplied items have suggested order quantities. Please review their quantities and prices before saving this requisition to the database.
            </p>

            <div className="max-h-64 overflow-y-auto border border-neutral-200 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-neutral-50 sticky top-0 text-[10px] uppercase font-semibold text-neutral-500 border-b">
                  <tr>
                    <th className="px-4 py-2 text-left">Item Name</th>
                    <th className="px-3 py-2 text-left">UOM</th>
                    <th className="px-3 py-2 text-right">Suggested Qty</th>
                    <th className="px-3 py-2 text-right">Unit Price</th>
                    <th className="px-4 py-2 text-right">Total Price</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {hqRequisitionLines.map(({ row, qty, price, total }) => (
                    <tr key={row.itemId} className="hover:bg-neutral-50/50">
                      <td className="px-4 py-2 font-medium text-neutral-900">{row.name}</td>
                      <td className="px-3 py-2 text-neutral-500">{row.uom || "ea"}</td>
                      <td className="px-3 py-2 text-right font-bold text-amber-700">{qty}</td>
                      <td className="px-3 py-2 text-right text-neutral-700">${price.toFixed(2)}</td>
                      <td className="px-4 py-2 text-right font-bold text-neutral-900">${total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between items-center bg-neutral-50 p-3 rounded-lg border">
              <span className="text-xs font-semibold text-neutral-600 uppercase">Grand Total Requisition Value:</span>
              <span className="text-base font-extrabold text-brand-700">${hqRequisitionGrandTotal.toFixed(2)}</span>
            </div>

            </div> {/* end scrollable body */}


            {/* Sticky footer — always visible */}
            <div className="px-6 pb-6 pt-4 border-t border-neutral-100 space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-neutral-700 block">Requisition Notes / Instructions:</label>
                <textarea
                  value={reqNotes}
                  onChange={(e) => setReqNotes(e.target.value)}
                  placeholder="Add commissary instructions, delivery details, or special requests..."
                  rows={2}
                  className="w-full text-xs border border-neutral-200 rounded-lg p-2.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setReqModalOpen(false)}
                  className="flex-1 px-4 py-3 text-xs font-semibold border border-neutral-200 rounded-lg hover:bg-neutral-50 transition"
                >
                  Cancel &amp; Edit Levels
                </button>
                <button
                  onClick={handleSubmitRequisition}
                  disabled={reqSaving}
                  className="flex-1 px-4 py-3 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition flex items-center justify-center gap-2"
                >
                  {reqSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  {reqSaving ? "Submitting…" : "Submit HQ Requisition"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Stock Import Preview Modal ─────────────────────────────────────── */}
      {stockImportOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[92vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100 shrink-0">
              <div className="flex items-center gap-2">
                <Upload className="h-5 w-5 text-brand-600" />
                <div>
                  <h3 className="text-base font-bold text-neutral-900">Import Stock Levels</h3>
                  <p className="text-xs text-neutral-400 mt-0.5">
                    Location: <span className="font-semibold text-neutral-700">{locations.find((l: any) => l.id === activeLoc)?.name ?? activeLoc}</span>
                    {" · "}Catalog items will <strong>not</strong> be modified.
                  </p>
                </div>
              </div>
              <button onClick={() => { setStockImportOpen(false); setStockImportMatched([]); setStockImportUnmatched([]); }}>
                <X className="h-5 w-5 text-neutral-400" />
              </button>
            </div>

            {/* Summary bar */}
            <div className="grid grid-cols-3 gap-3 px-6 py-4 border-b border-neutral-100 shrink-0">
              {[
                { label: "Matched",   value: stockImportMatched.length,   color: "text-green-700",  bg: "bg-green-50",  border: "border-green-200" },
                { label: "Unmatched", value: stockImportUnmatched.length,  color: "text-amber-700",  bg: "bg-amber-50",  border: "border-amber-200" },
                { label: "Will Update", value: stockImportMatched.filter(m => m.currentStock !== null || m.physicalCount !== null).length, color: "text-brand-700", bg: "bg-brand-50", border: "border-brand-200" },
              ].map(s => (
                <div key={s.label} className={`rounded-xl border ${s.border} ${s.bg} px-3 py-2.5 text-center`}>
                  <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

              {/* Matched rows */}
              {stockImportMatched.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                    Matched rows — will update location_inventory_items
                  </p>
                  <div className="border border-neutral-200 rounded-xl overflow-hidden">
                    <div className="overflow-x-auto max-h-52">
                      <table className="w-full text-xs">
                        <thead className="bg-neutral-50 text-[10px] uppercase tracking-wider text-neutral-500 border-b border-neutral-200 sticky top-0">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">Item</th>
                            <th className="px-3 py-2 text-right font-semibold">Stock</th>
                            <th className="px-3 py-2 text-right font-semibold">Count</th>
                            <th className="px-3 py-2 text-right font-semibold">Min</th>
                            <th className="px-3 py-2 text-right font-semibold">Par</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-100">
                          {stockImportMatched.map((m, i) => (
                            <tr key={i} className="hover:bg-neutral-50/60">
                              <td className="px-3 py-2 font-medium text-neutral-800 max-w-[160px] truncate">
                                {m.catalogRow.name}
                                {m.catalogRow.supplier && (
                                  <span className="block text-[10px] text-neutral-400 font-normal">{m.catalogRow.supplier}</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {m.currentStock !== null
                                  ? <span className="font-semibold text-green-700">{m.currentStock}</span>
                                  : <span className="text-neutral-300">—</span>}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {m.physicalCount !== null
                                  ? <span className="font-semibold text-indigo-700">{m.physicalCount}</span>
                                  : <span className="text-neutral-300">—</span>}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                                {m.minOnHand !== null ? m.minOnHand : <span className="text-neutral-300">—</span>}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                                {m.parLevel !== null ? m.parLevel : <span className="text-neutral-300">—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* Unmatched rows */}
              {stockImportUnmatched.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-amber-600 mb-2">
                    Unmatched rows — not in Location Catalog, will be skipped
                  </p>
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 max-h-32 overflow-y-auto space-y-1">
                    {stockImportUnmatched.map((u, i) => (
                      <div key={i} className="text-xs text-amber-800">
                        • <span className="font-medium">{u.rawName}</span>
                        {u.supplierRaw && <span className="text-amber-600"> — {u.supplierRaw}</span>}
                        {u.uomRaw && <span className="text-amber-500"> ({u.uomRaw})</span>}
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-neutral-400 mt-1">
                    Add these items to Location Catalog first, then re-import.
                  </p>
                </div>
              )}

              {stockImportMatched.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-6 text-neutral-400">
                  <AlertCircle className="h-8 w-8" />
                  <p className="text-sm font-medium">No rows matched any catalog items.</p>
                  <p className="text-xs text-center">Check that items exist in the Location Catalog with matching names, suppliers, or UOMs.</p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-neutral-100 flex gap-3 shrink-0">
              <button
                onClick={() => { setStockImportOpen(false); setStockImportMatched([]); setStockImportUnmatched([]); }}
                className="flex-1 px-4 py-2.5 text-xs font-semibold border border-neutral-200 rounded-lg hover:bg-neutral-50"
              >
                Cancel
              </button>
              <button
                onClick={commitStockImport}
                disabled={stockCommitting || stockImportMatched.length === 0}
                className="flex-1 px-4 py-2.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {stockCommitting
                  ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Importing…</>
                  : <><CheckCircle2 className="h-3.5 w-3.5" /> Update {stockImportMatched.length} Row{stockImportMatched.length !== 1 ? "s" : ""}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import modal */}
      {importModalOpen && validation && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold">Import Validation</h3>
              <button onClick={() => setImportModalOpen(false)}><X className="h-5 w-5 text-neutral-400" /></button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {[
                ["Total Rows",   validation.totalRows],
                ["Matched",      validation.matchedItems],
                ["To Save",      validation.rowsToUpsert],
                ["Unmatched",    validation.unmatchedItems.length],
                ["Duplicates",   validation.duplicateRows.length],
                ["Errors",       validation.errors.length],
              ].map(([l, v]) => (
                <div key={l as string} className="bg-neutral-50 rounded-lg p-2.5">
                  <div className="text-xs text-neutral-500">{l}</div>
                  <div className={`text-lg font-bold ${Number(v) > 0 && l !== "Matched" && l !== "To Save" && l !== "Total Rows" ? "text-amber-600" : "text-neutral-900"}`}>{v}</div>
                </div>
              ))}
            </div>
            {validation.errors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 max-h-28 overflow-y-auto text-xs text-red-700 space-y-1">
                {validation.errors.map((e: string, i: number) => <div key={i}>• {e}</div>)}
              </div>
            )}
            {validation.warnings.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 max-h-24 overflow-y-auto text-xs text-amber-700 space-y-1">
                {validation.warnings.slice(0, 5).map((w: string, i: number) => <div key={i}>• {w}</div>)}
                {validation.warnings.length > 5 && <div className="text-neutral-400">…and {validation.warnings.length - 5} more</div>}
              </div>
            )}
            <div className="flex gap-3">
              <button onClick={() => setImportModalOpen(false)} className="flex-1 px-4 py-2 text-sm border border-neutral-200 rounded-lg hover:bg-neutral-50">Cancel</button>
              <button onClick={confirmImport} disabled={!validation.valid || importing}
                className="flex-1 px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center gap-2">
                {importing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {importing ? "Importing…" : `Import ${validation.rowsToUpsert} rows`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Physical Count Confirmation Modal ──────────────────────────────── */}
      {countModalOpen && (() => {
        const positive = countableRows.filter((r) => (r.physicalCount as number) > r.currentStock).length;
        const negative = countableRows.filter((r) => (r.physicalCount as number) < r.currentStock).length;
        const zero     = countableRows.filter((r) => (r.physicalCount as number) === r.currentStock).length;
        return (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[90vh] flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
                <div className="flex items-center gap-2">
                  <ClipboardCheck className="h-5 w-5 text-indigo-600" />
                  <h3 className="text-base font-bold text-neutral-900">Apply Physical Count</h3>
                </div>
                <button onClick={() => { setCountModalOpen(false); setCountNotes(""); }}>
                  <X className="h-5 w-5 text-neutral-400" />
                </button>
              </div>
              {/* Scrollable body */}
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              {/* Summary */}
              <p className="text-sm text-neutral-600">
                Apply count for <strong>{countableRows.length} item{countableRows.length !== 1 ? "s" : ""}</strong>?
                This will set <strong>Current Stock = Physical Count</strong> and update <code className="bg-neutral-100 px-1 rounded text-xs">last_counted_at</code> for each item.
              </p>

              {/* Variance breakdown */}
              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col items-center gap-1 rounded-xl border border-green-200 bg-green-50 px-4 py-3">
                  <TrendingUp className="h-4 w-4 text-green-600" />
                  <span className="text-xl font-bold text-green-700">{positive}</span>
                  <span className="text-[10px] font-semibold text-green-600 uppercase tracking-wider">Positive</span>
                </div>
                <div className="flex flex-col items-center gap-1 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                  <TrendingDown className="h-4 w-4 text-red-500" />
                  <span className="text-xl font-bold text-red-600">{negative}</span>
                  <span className="text-[10px] font-semibold text-red-500 uppercase tracking-wider">Negative</span>
                </div>
                <div className="flex flex-col items-center gap-1 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3">
                  <Minus className="h-4 w-4 text-neutral-400" />
                  <span className="text-xl font-bold text-neutral-600">{zero}</span>
                  <span className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">No Change</span>
                </div>
              </div>

              {/* Item preview — up to 6 rows */}
              <div className="border border-neutral-200 rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-neutral-50 text-[10px] uppercase tracking-wider text-neutral-500 border-b border-neutral-200">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Item</th>
                      <th className="px-3 py-2 text-right font-semibold">Current</th>
                      <th className="px-3 py-2 text-right font-semibold">Count</th>
                      <th className="px-3 py-2 text-right font-semibold">Variance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {countableRows.map((r) => {
                      const variance = (r.physicalCount as number) - r.currentStock;
                      return (
                        <tr key={r.itemId} className="hover:bg-neutral-50/50">
                          <td className="px-3 py-2 font-medium text-neutral-800 max-w-[160px] truncate">{r.name}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-neutral-600">{r.currentStock}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold text-neutral-800">{r.physicalCount}</td>
                          <td className={`px-3 py-2 text-right tabular-nums font-bold ${variance > 0 ? "text-green-600" : variance < 0 ? "text-red-500" : "text-neutral-400"}`}>
                            {variance > 0 ? "+" : ""}{variance}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Optional notes */}
              <div>
                <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">
                  Count Notes (optional)
                </label>
                <textarea
                  rows={2}
                  value={countNotes}
                  onChange={(e) => setCountNotes(e.target.value)}
                  placeholder="Reason for count, counted by, shift, etc."
                  className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-neutral-50 resize-none"
                />
              </div>

              </div> {/* end scrollable body */}

              {/* Footer — sticky at bottom */}
              <div className="px-6 pb-6 pt-4 border-t border-neutral-100 flex gap-3">
                <button
                  onClick={() => { setCountModalOpen(false); setCountNotes(""); }}
                  className="flex-1 px-4 py-3 text-xs font-semibold border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleApplyCount}
                  disabled={countApplying}
                  className="flex-1 px-4 py-3 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  {countApplying
                    ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Applying…</>
                    : <><ClipboardCheck className="h-3.5 w-3.5" /> Apply Count ({countableRows.length})</>}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
