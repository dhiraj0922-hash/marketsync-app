"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin } from "@/lib/roles";
import {
  loadLocations, loadOutletCatalog, loadOutletInventoryV2,
  upsertOutletInventoryRowV2, bulkUpsertOutletInventoryV2,
  saveNewRequisition, sendHqRequisitionNotification,
  applyPhysicalCount,
  type OutletCatalogItem, type OutletInventoryRowV2, type CountApplyEntry,
} from "@/lib/storage";
import {
  exportToExcel, downloadOutletTemplate, parseExcelFile,
  validateOutletRows, mapExcelRowToOutletRecord,
} from "@/lib/excel";
import {
  MapPin, Download, Upload, Save, Search, CheckCircle2,
  RefreshCw, X, Store, Package, Plus, FileSpreadsheet, ClipboardList,
  AlertCircle, ClipboardCheck, TrendingUp, TrendingDown, Minus,
} from "lucide-react";

type SourceFilter = "all" | "hq_supplied" | "local_vendor";
type ViewMode = "active" | "catalog" | "disabled" | "suggested";

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

  // import state
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importRows,   setImportRows]   = useState<any[]>([]);
  const [validation,   setValidation]   = useState<any>(null);
  const [importing,    setImporting]    = useState(false);
  const [toast,        setToast]        = useState<string | null>(null);

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

  const patch = (itemId: string, p: Partial<MergedRow>) =>
    setRows((prev) => prev.map((r) => r.itemId === itemId ? { ...r, ...p, dirty: true } : r));

  const saveRow = async (row: MergedRow) => {
    setRows((prev) => prev.map((r) => r.itemId === row.itemId ? { ...r, saving: true } : r));
    await upsertOutletInventoryRowV2({
      item_id: row.itemId, location_id: activeLoc,
      current_stock: row.currentStock, physical_count: row.physicalCount,
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

  // Rows eligible for physical count: active (localEnabled), has a physicalCount entered
  const countableRows = useMemo(() =>
    rows.filter((r) => r.localEnabled && r.outletRowId && r.physicalCount !== null),
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

  const srcBadge = (src: "hq_supplied" | "local_vendor") =>
    src === "hq_supplied"
      ? <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">HQ</span>
      : <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200">LOCAL</span>;

  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Store className="h-6 w-6 text-brand-600" /> Outlet Level Inventory
          </h2>
          <p className="text-neutral-500 text-sm mt-0.5">
            HQ-supplied and local vendor items per outlet. Grey = catalog read-only. White = outlet-editable.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {viewMode === "suggested" ? (
            <>
              <button onClick={handleExportSuggested} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50">
                <FileSpreadsheet className="h-3.5 w-3.5 text-green-600" /> Export Suggested Order
              </button>
              <button
                onClick={handleExportLocalVendor}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50"
              >
                <Download className="h-3.5 w-3.5 text-teal-600" /> Export Local Purchase List
              </button>
              <button
                onClick={() => setReqModalOpen(true)}
                disabled={hqRequisitionLines.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ClipboardList className="h-3.5 w-3.5" /> Requisition HQ Items ({hqRequisitionLines.length})
              </button>
            </>
          ) : (
            <>
              <button onClick={downloadOutletTemplate} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50">
                <Download className="h-3.5 w-3.5" /> Template
              </button>
              <button onClick={handleExport} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 disabled:opacity-50">
                <Download className="h-3.5 w-3.5" /> Export
              </button>
              <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 cursor-pointer">
                <Upload className="h-3.5 w-3.5" /> Import
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileChange} />
              </label>
              {/* Apply Physical Count — only shown in Active Items view with pending counts */}
              {viewMode === "active" && countableRows.length > 0 && (
                <button
                  onClick={() => setCountModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors shadow-sm"
                >
                  <ClipboardCheck className="h-3.5 w-3.5" />
                  Apply Physical Count ({countableRows.length})
                </button>
              )}
              {dirtyCount > 0 && (
                <button onClick={saveAll} disabled={savingAll} className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-60">
                  <Save className="h-3.5 w-3.5" />{savingAll ? "Saving…" : `Save Changes (${dirtyCount})`}
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
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
          <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white w-48" />
        </div>
        {([
          ["active",    "Active Items"],
          ["catalog",   "Add From Catalog"],
          ["disabled",  "Disabled"],
          ["suggested", "Suggested Order"],
        ] as [ViewMode, string][]).map(([m, label]) => (
          <button key={m} onClick={() => setViewMode(m)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${viewMode === m ? "bg-brand-600 text-white border-brand-600" : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}>
            {label}
          </button>
        ))}
        {(["all", "hq_supplied", "local_vendor"] as SourceFilter[]).map((f) => (
          <button key={f} onClick={() => setSrcFilter(f)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${srcFilter === f ? "bg-neutral-700 text-white border-neutral-700" : "bg-white border-neutral-200 text-neutral-500 hover:bg-neutral-50"} text-[10px]`}>
            {f === "all" ? "All" : f === "hq_supplied" ? "HQ" : "Local"}
          </button>
        ))}
        {viewMode === "suggested" && (
          <button
            onClick={() => setSuggestedQtyOnly(!suggestedQtyOnly)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${suggestedQtyOnly ? "bg-amber-600 text-white border-amber-600 hover:bg-amber-700" : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}
          >
            Suggested Qty &gt; 0
          </button>
        )}
        <span className="text-xs text-neutral-400 ml-auto">{filtered.length} items</span>
      </div>

      {/* Catalog mode: hint + bulk-enable toolbar */}
      {viewMode === "catalog" && (
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

      {/* Suggested Mode header alert */}
      {viewMode === "suggested" && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-xs text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
          <span>
            <strong>Suggested Order view:</strong> Order quantities are calculated as <code>max(Par Level - Stock, 0)</code>. Items with Par Level = 0 or null result in 0 suggested order. Adjust Par Levels on the <strong>Active Items</strong> tab.
          </span>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-16 text-neutral-400 animate-pulse text-sm">Loading outlet inventory…</div>
      ) : catalog.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-400">
          <Package className="h-10 w-10" />
          <p className="text-sm font-medium">No outlet catalog items yet.</p>
          <p className="text-xs">Run <code className="bg-neutral-100 px-1 rounded">migration_outlet_catalog.sql</code> to seed from HQ finished goods, then import local vendor items via Excel.</p>
        </div>
      ) : (
        <div className="border border-neutral-200 rounded-xl overflow-hidden bg-white">
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
                    {/* Checkbox column — only in catalog mode */}
                    {viewMode === "catalog" && (
                      <th className="px-3 py-3 text-center bg-neutral-100 w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all visible catalog items"
                          className="accent-green-600 w-3.5 h-3.5"
                          checked={filtered.filter((r) => !r.localEnabled).length > 0 && filtered.filter((r) => !r.localEnabled).every((r) => selectedItemIds.has(r.itemId))}
                          onChange={(e) => {
                            const notEnabled = filtered.filter((r) => !r.localEnabled).map((r) => r.itemId);
                            if (e.target.checked) {
                              setSelectedItemIds((prev) => new Set([...prev, ...notEnabled]));
                            } else {
                              setSelectedItemIds((prev) => { const next = new Set(prev); notEnabled.forEach((id) => next.delete(id)); return next; });
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
                    <td colSpan={viewMode === "suggested" ? 11 : viewMode === "catalog" ? 16 : 15} className="py-10 text-center text-neutral-400 text-sm">
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
                      {/* Checkbox cell — catalog mode only, only for not-yet-enabled items */}
                      {viewMode === "catalog" && (
                        <td className="px-3 py-2 text-center">
                          {!row.localEnabled ? (
                            <input
                              type="checkbox"
                              aria-label={`Select ${row.name}`}
                              className="accent-green-600 w-3.5 h-3.5"
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
                        <input type="number" min={0} value={row.physicalCount ?? ""} placeholder="—"
                          onChange={(e) => patch(row.itemId, { physicalCount: e.target.value === "" ? null : parseFloat(e.target.value) })}
                          className="w-16 text-right text-xs tabular-nums border border-neutral-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500" />
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
      )}

      {/* HQ Requisition Confirmation Review Modal */}
      {reqModalOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-5 w-5 text-brand-600" />
                <h3 className="text-base font-bold text-neutral-900">Review Draft HQ Requisition</h3>
              </div>
              <button onClick={() => setReqModalOpen(false)}><X className="h-5 w-5 text-neutral-400" /></button>
            </div>

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

            <div className="space-y-1">
              <label className="text-xs font-semibold text-neutral-700 block">Requisition Notes / Instructions:</label>
              <textarea
                value={reqNotes}
                onChange={(e) => setReqNotes(e.target.value)}
                placeholder="Add commissary instructions, delivery details, or special requests..."
                rows={3}
                className="w-full text-xs border border-neutral-200 rounded-lg p-2.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setReqModalOpen(false)}
                className="flex-1 px-4 py-2.5 text-xs font-semibold border border-neutral-200 rounded-lg hover:bg-neutral-50 transition"
              >
                Cancel &amp; Edit Levels
              </button>
              <button
                onClick={handleSubmitRequisition}
                disabled={reqSaving}
                className="flex-1 px-4 py-2.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition flex items-center justify-center gap-2"
              >
                {reqSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {reqSaving ? "Submitting Requisition..." : "Submit HQ Requisition"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import modal */}
      {importModalOpen && validation && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
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
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-5">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ClipboardCheck className="h-5 w-5 text-indigo-600" />
                  <h3 className="text-base font-bold text-neutral-900">Apply Physical Count</h3>
                </div>
                <button onClick={() => { setCountModalOpen(false); setCountNotes(""); }}>
                  <X className="h-5 w-5 text-neutral-400" />
                </button>
              </div>

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

              {/* Footer buttons */}
              <div className="flex gap-3 pt-1">
                <button
                  onClick={() => { setCountModalOpen(false); setCountNotes(""); }}
                  className="flex-1 px-4 py-2.5 text-xs font-semibold border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleApplyCount}
                  disabled={countApplying}
                  className="flex-1 px-4 py-2.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
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

