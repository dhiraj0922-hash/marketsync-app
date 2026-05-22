"use client";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin } from "@/lib/roles";
import {
  loadLocations, loadOutletCatalog, loadOutletInventoryV2,
  upsertOutletInventoryRowV2, bulkUpsertOutletInventoryV2,
  type OutletCatalogItem, type OutletInventoryRowV2,
} from "@/lib/storage";
import {
  exportToExcel, downloadOutletTemplate, parseExcelFile,
  validateOutletRows, mapExcelRowToOutletRecord,
} from "@/lib/excel";
import {
  MapPin, Download, Upload, Save, Search, CheckCircle2,
  AlertTriangle, RefreshCw, X, Store, Package,
} from "lucide-react";

type SourceFilter = "all" | "hq_supplied" | "local_vendor";

interface MergedRow {
  itemId: string; name: string; category: string; uom: string;
  type: string; sourceType: "hq_supplied" | "local_vendor";
  supplier: string; price: number; taxRate: number; orderingEnabled: boolean;
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
      orderingEnabled: c.orderingEnabled,
      outletRowId: o?.id ?? null,
      currentStock: o?.currentStock ?? 0,
      physicalCount: o?.physicalCount ?? null,
      minOnHand: o?.minOnHand ?? 0, parLevel: o?.parLevel ?? 0,
      localEnabled: o?.localEnabled ?? true, localNotes: o?.localNotes ?? "",
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
  const [showDisabled, setShowDisabled] = useState(false);
  const [savingAll,    setSavingAll]    = useState(false);

  // import state
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importRows,   setImportRows]   = useState<any[]>([]);
  const [validation,   setValidation]   = useState<any>(null);
  const [importing,    setImporting]    = useState(false);
  const [toast,        setToast]        = useState<string | null>(null);

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
        const locs = await loadLocations();
        const outlets = locs.filter((l: any) => l.id !== "LOC-HQ");
        setLocations(outlets);
        if (outlets.length) setSelectedLoc(outlets[0].id);
      } else {
        const loc = user?.locationId ?? "";
        setSelectedLoc(loc);
        await loadAll(loc);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hq]);

  useEffect(() => { if (activeLoc) loadAll(activeLoc); }, [activeLoc, loadAll]);
  useEffect(() => { setRows(merge(catalog, outletData)); }, [catalog, outletData]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return rows.filter((r) => {
      if (srcFilter !== "all" && r.sourceType !== srcFilter) return false;
      if (!showDisabled && !r.localEnabled) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.category.toLowerCase().includes(q) && !r.supplier.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, srcFilter, showDisabled]);

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
          {dirtyCount > 0 && (
            <button onClick={saveAll} disabled={savingAll} className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-60">
              <Save className="h-3.5 w-3.5" />{savingAll ? "Saving…" : `Save Changes (${dirtyCount})`}
            </button>
          )}
        </div>
      </div>

      {/* HQ location selector */}
      {hq && (
        <div className="flex items-center gap-3 bg-brand-50 border border-brand-200 rounded-lg px-4 py-2.5">
          <MapPin className="h-4 w-4 text-brand-600 shrink-0" />
          <span className="text-sm font-semibold text-brand-800">Location:</span>
          <select value={selectedLoc} onChange={(e) => setSelectedLoc(e.target.value)}
            className="text-sm border border-brand-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-brand-500">
            {locations.map((l: any) => <option key={l.id} value={l.id}>{l.name ?? l.id}</option>)}
          </select>
        </div>
      )}

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
        {(["all", "hq_supplied", "local_vendor"] as SourceFilter[]).map((f) => (
          <button key={f} onClick={() => setSrcFilter(f)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${srcFilter === f ? "bg-brand-600 text-white border-brand-600" : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}>
            {f === "all" ? "All Items" : f === "hq_supplied" ? "HQ Supplied" : "Local Vendor"}
          </button>
        ))}
        <button onClick={() => setShowDisabled(!showDisabled)}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${showDisabled ? "bg-neutral-800 text-white border-neutral-800" : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}>
          {showDisabled ? "Hide disabled" : "Show disabled"}
        </button>
        <span className="text-xs text-neutral-400 ml-auto">{filtered.length} items</span>
      </div>

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
                <tr>
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
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={15} className="py-10 text-center text-neutral-400 text-sm">No items match your filters.</td></tr>
                ) : filtered.map((row) => (
                  <tr key={row.itemId} className={`${row.dirty ? "bg-amber-50/40" : "hover:bg-neutral-50/30"} ${!row.localEnabled ? "opacity-50" : ""}`}>
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
                      {row.dirty && (
                        <button onClick={() => saveRow(row)} disabled={row.saving}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50">
                          {row.saving ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : <Save className="h-2.5 w-2.5" />}
                          {row.saving ? "…" : "Save"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
    </div>
  );
}
