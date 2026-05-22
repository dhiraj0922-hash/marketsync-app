"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin } from "@/lib/roles";
import {
  loadInventory,
  loadLocations,
  loadOutletInventory,
  upsertOutletInventoryRow,
  bulkUpsertOutletInventory,
  type OutletInventoryRow,
} from "@/lib/storage";
import {
  exportToExcel,
  downloadOutletTemplate,
  parseExcelFile,
  validateOutletRows,
  mapExcelRowToOutletRecord,
} from "@/lib/excel";
import {
  MapPin, Download, Upload, Save, Search, CheckCircle2,
  AlertTriangle, RefreshCw, X, ChevronDown, Eye, EyeOff,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────
interface MergedRow {
  // HQ master fields (read-only)
  itemId:         string;
  name:           string;
  category:       string;
  unit:           string;
  itemType:       string;
  cost:           number;
  supplierName:   string;
  parLevel:       number;        // HQ par (informational)
  inStock:        number;        // HQ stock
  // Outlet-editable fields
  outletId:       string | null; // location_inventory_items.id
  currentStock:   number;
  physicalCount:  number | null;
  minOnHand:      number;
  outletParLevel: number;
  localEnabled:   boolean;
  localNotes:     string;
  // UI state
  dirty:          boolean;
  saving:         boolean;
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function OutletInventoryPage() {
  const { user } = useAuth();
  const hq = isHqAdmin(user);

  const [hqItems,        setHqItems]        = useState<any[]>([]);
  const [outletRows,     setOutletRows]      = useState<OutletInventoryRow[]>([]);
  const [locations,      setLocations]       = useState<any[]>([]);
  const [selectedLoc,    setSelectedLoc]     = useState<string>("");
  const [loading,        setLoading]         = useState(true);
  const [search,         setSearch]          = useState("");
  const [showDisabled,   setShowDisabled]    = useState(false);
  const [savingAll,      setSavingAll]       = useState(false);

  // Import modal state
  const [importFile,     setImportFile]      = useState<File | null>(null);
  const [importRows,     setImportRows]      = useState<any[]>([]);
  const [validation,     setValidation]      = useState<any>(null);
  const [importing,      setImporting]       = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importDone,     setImportDone]      = useState<string | null>(null);

  // ── Resolve active location ──────────────────────────────────────────────
  const activeLocation = hq ? selectedLoc : (user?.locationId ?? "");

  // ── Load ─────────────────────────────────────────────────────────────────
  const loadAll = useCallback(async (locId: string) => {
    if (!locId) return;
    setLoading(true);
    try {
      const [hq, outlet] = await Promise.all([
        loadInventory("LOC-HQ"),
        loadOutletInventory(locId),
      ]);
      setHqItems(Array.isArray(hq) ? hq : []);
      setOutletRows(Array.isArray(outlet) ? outlet : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      if (hq) {
        const locs = await loadLocations();
        const outlets = locs.filter((l: any) => l.id !== "LOC-HQ");
        setLocations(outlets);
        if (outlets.length > 0) setSelectedLoc(outlets[0].id);
      } else {
        const locId = user?.locationId ?? "";
        setSelectedLoc(locId);
        await loadAll(locId);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hq]);

  useEffect(() => {
    if (activeLocation) loadAll(activeLocation);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLocation]);

  // ── Merge HQ + outlet rows ───────────────────────────────────────────────
  const [rows, setRows] = useState<MergedRow[]>([]);

  useEffect(() => {
    const outletMap = new Map<string, OutletInventoryRow>();
    outletRows.forEach((r) => outletMap.set(r.itemId, r));

    const merged: MergedRow[] = hqItems.map((hqItem) => {
      const outlet = outletMap.get(hqItem.itemId ?? hqItem.id);
      return {
        itemId:         hqItem.itemId ?? hqItem.id,
        name:           hqItem.name ?? "",
        category:       hqItem.category ?? "",
        unit:           hqItem.unit ?? hqItem.baseUnit ?? "",
        itemType:       hqItem.itemType ?? "",
        cost:           hqItem.cost ?? 0,
        supplierName:   hqItem.supplierName ?? "",
        parLevel:       hqItem.parLevel ?? 0,
        inStock:        hqItem.inStock ?? 0,
        outletId:       outlet?.id ?? null,
        currentStock:   outlet?.currentStock ?? 0,
        physicalCount:  outlet?.physicalCount ?? null,
        minOnHand:      outlet?.minOnHand ?? 0,
        outletParLevel: outlet?.parLevel ?? 0,
        localEnabled:   outlet?.localEnabled ?? true,
        localNotes:     outlet?.localNotes ?? "",
        dirty:          false,
        saving:         false,
      };
    });
    setRows(merged);
  }, [hqItems, outletRows]);

  // ── Filtered rows ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return rows.filter((r) => {
      if (!showDisabled && !r.localEnabled) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q) ||
        r.itemType.toLowerCase().includes(q)
      );
    });
  }, [rows, search, showDisabled]);

  // ── Inline edit helper ───────────────────────────────────────────────────
  const patchRow = (itemId: string, patch: Partial<MergedRow>) => {
    setRows((prev) =>
      prev.map((r) =>
        r.itemId === itemId ? { ...r, ...patch, dirty: true } : r
      )
    );
  };

  // ── Save one row ─────────────────────────────────────────────────────────
  const saveRow = async (row: MergedRow) => {
    setRows((prev) =>
      prev.map((r) => (r.itemId === row.itemId ? { ...r, saving: true } : r))
    );
    await upsertOutletInventoryRow({
      item_id:        row.itemId,
      location_id:    activeLocation,
      current_stock:  row.currentStock,
      physical_count: row.physicalCount,
      min_on_hand:    row.minOnHand,
      par_level:      row.outletParLevel,
      local_enabled:  row.localEnabled,
      local_notes:    row.localNotes || null,
    });
    setRows((prev) =>
      prev.map((r) =>
        r.itemId === row.itemId ? { ...r, saving: false, dirty: false } : r
      )
    );
  };

  // ── Save all dirty ───────────────────────────────────────────────────────
  const saveAll = async () => {
    setSavingAll(true);
    const dirty = rows.filter((r) => r.dirty);
    await Promise.all(dirty.map(saveRow));
    setSavingAll(false);
  };

  // ── Export ───────────────────────────────────────────────────────────────
  const handleExport = () => {
    const exportData = rows.map((r) => ({
      "Location Code":       activeLocation,
      "Inventory item":      r.name,
      "Category":            r.category,
      "UOM":                 r.unit,
      "Type":                r.itemType,
      "Price":               r.cost,
      "Ordering enabled":    r.localEnabled,
      "Min On Hand":         r.minOnHand,
      "Par level":           r.outletParLevel,
      "Current Stock":       r.currentStock,
      "Physical Count":      r.physicalCount ?? "",
      "Local Enabled":       r.localEnabled,
      "Local Notes":         r.localNotes,
    }));
    exportToExcel(exportData, `outlet_inventory_${activeLocation}`);
  };

  // ── Import flow ──────────────────────────────────────────────────────────
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);
    setValidation(null);
    setImportDone(null);
    try {
      const parsed = await parseExcelFile(file);
      setImportRows(parsed);
      const allLocIds = locations.map((l: any) => l.id);
      const v = validateOutletRows(parsed, hqItems, activeLocation, allLocIds);
      setValidation(v);
      setImportModalOpen(true);
    } catch (err: any) {
      alert(`Failed to parse file: ${err?.message}`);
    }
    e.target.value = "";
  };

  const confirmImport = async () => {
    setImporting(true);
    const mapped = importRows
      .map((r) => mapExcelRowToOutletRecord(r, hqItems, activeLocation))
      .filter(Boolean) as any[];
    const result = await bulkUpsertOutletInventory(mapped);
    setImporting(false);
    setImportModalOpen(false);
    setImportDone(
      `Import done: ${result.succeeded} rows saved${result.failed > 0 ? `, ${result.failed} failed` : ""}.`
    );
    await loadAll(activeLocation);
  };

  const dirtyCount = rows.filter((r) => r.dirty).length;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <MapPin className="h-6 w-6 text-brand-600" />
            Outlet Level Inventory
          </h2>
          <p className="text-neutral-500 text-sm mt-0.5">
            Per-outlet stock setup linked to HQ master items. Grey columns are HQ-controlled (read-only).
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => downloadOutletTemplate()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors"
          >
            <Download className="h-3.5 w-3.5" /> Template
          </button>
          <button
            onClick={handleExport}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> Export
          </button>
          <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors cursor-pointer">
            <Upload className="h-3.5 w-3.5" /> Import
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileChange} />
          </label>
          {dirtyCount > 0 && (
            <button
              onClick={saveAll}
              disabled={savingAll}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-60"
            >
              <Save className="h-3.5 w-3.5" />
              {savingAll ? "Saving…" : `Save Changes (${dirtyCount})`}
            </button>
          )}
        </div>
      </div>

      {/* Location selector (HQ only) */}
      {hq && (
        <div className="flex items-center gap-3 bg-brand-50 border border-brand-200 rounded-lg px-4 py-3">
          <MapPin className="h-4 w-4 text-brand-600 shrink-0" />
          <span className="text-sm font-semibold text-brand-800">Viewing location:</span>
          <select
            value={selectedLoc}
            onChange={(e) => setSelectedLoc(e.target.value)}
            className="text-sm border border-brand-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {locations.map((l: any) => (
              <option key={l.id} value={l.id}>{l.name ?? l.id}</option>
            ))}
          </select>
          <span className="text-xs text-brand-600 ml-auto">HQ view mode — edits update outlet data</span>
        </div>
      )}

      {/* Import result banner */}
      {importDone && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-2 text-sm text-green-800">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {importDone}
          <button onClick={() => setImportDone(null)} className="ml-auto text-green-600 hover:text-green-800"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
          <input
            type="text"
            placeholder="Search items…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
          />
        </div>
        <button
          onClick={() => setShowDisabled(!showDisabled)}
          className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${showDisabled ? "bg-neutral-800 text-white border-neutral-800" : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}
        >
          {showDisabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {showDisabled ? "Hide disabled" : "Show disabled"}
        </button>
        <span className="text-xs text-neutral-400 ml-auto">{filtered.length} items</span>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-16 text-neutral-400 animate-pulse text-sm">Loading outlet inventory…</div>
      ) : (
        <div className="border border-neutral-200 rounded-xl overflow-hidden bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-[11px] uppercase tracking-wider text-neutral-500 border-b border-neutral-200">
                <tr>
                  {/* HQ master columns - grey */}
                  <th className="px-4 py-3 text-left font-semibold bg-neutral-100">Item</th>
                  <th className="px-3 py-3 text-left font-semibold bg-neutral-100">Category</th>
                  <th className="px-3 py-3 text-left font-semibold bg-neutral-100">UOM</th>
                  <th className="px-3 py-3 text-left font-semibold bg-neutral-100">Type</th>
                  <th className="px-3 py-3 text-right font-semibold bg-neutral-100">HQ Price</th>
                  <th className="px-3 py-3 text-right font-semibold bg-neutral-100">HQ Stock</th>
                  {/* Outlet-editable columns - white */}
                  <th className="px-3 py-3 text-right font-semibold">Current Stock</th>
                  <th className="px-3 py-3 text-right font-semibold">Physical Count</th>
                  <th className="px-3 py-3 text-right font-semibold">Min On Hand</th>
                  <th className="px-3 py-3 text-right font-semibold">Par Level</th>
                  <th className="px-3 py-3 text-center font-semibold">Enabled</th>
                  <th className="px-3 py-3 text-left font-semibold">Notes</th>
                  <th className="px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={13} className="py-12 text-center text-neutral-400 text-sm">
                      {search ? `No items match "${search}".` : "No items found."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((row) => (
                    <tr
                      key={row.itemId}
                      className={`transition-colors ${row.dirty ? "bg-amber-50/40" : "hover:bg-neutral-50/50"} ${!row.localEnabled ? "opacity-50" : ""}`}
                    >
                      {/* HQ columns — read-only grey */}
                      <td className="px-4 py-2.5 bg-neutral-50/50">
                        <div className="font-semibold text-neutral-900">{row.name}</div>
                        <div className="text-[10px] text-neutral-400 font-mono">{row.itemId}</div>
                      </td>
                      <td className="px-3 py-2.5 bg-neutral-50/50 text-neutral-600">{row.category || "—"}</td>
                      <td className="px-3 py-2.5 bg-neutral-50/50 text-neutral-600">{row.unit || "—"}</td>
                      <td className="px-3 py-2.5 bg-neutral-50/50 text-neutral-500 text-xs">{row.itemType || "—"}</td>
                      <td className="px-3 py-2.5 bg-neutral-50/50 text-right tabular-nums text-neutral-700">
                        {row.cost > 0 ? `$${row.cost.toFixed(2)}` : "—"}
                      </td>
                      <td className="px-3 py-2.5 bg-neutral-50/50 text-right tabular-nums text-neutral-500">{row.inStock}</td>
                      {/* Outlet-editable columns */}
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          value={row.currentStock}
                          onChange={(e) => patchRow(row.itemId, { currentStock: parseFloat(e.target.value) || 0 })}
                          className="w-20 text-right tabular-nums border border-neutral-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          value={row.physicalCount ?? ""}
                          placeholder="—"
                          onChange={(e) => patchRow(row.itemId, { physicalCount: e.target.value === "" ? null : parseFloat(e.target.value) })}
                          className="w-20 text-right tabular-nums border border-neutral-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          value={row.minOnHand}
                          onChange={(e) => patchRow(row.itemId, { minOnHand: parseFloat(e.target.value) || 0 })}
                          className="w-20 text-right tabular-nums border border-neutral-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          value={row.outletParLevel}
                          onChange={(e) => patchRow(row.itemId, { outletParLevel: parseFloat(e.target.value) || 0 })}
                          className="w-20 text-right tabular-nums border border-neutral-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={row.localEnabled}
                          onChange={(e) => patchRow(row.itemId, { localEnabled: e.target.checked })}
                          className="accent-brand-600 w-4 h-4"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={row.localNotes}
                          placeholder="Notes…"
                          onChange={(e) => patchRow(row.itemId, { localNotes: e.target.value })}
                          className="w-32 border border-neutral-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </td>
                      <td className="px-4 py-2 text-right">
                        {row.dirty && (
                          <button
                            onClick={() => saveRow(row)}
                            disabled={row.saving}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-semibold bg-brand-600 text-white rounded hover:bg-brand-700 transition-colors disabled:opacity-50"
                          >
                            {row.saving ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                            {row.saving ? "…" : "Save"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Import Validation Modal */}
      {importModalOpen && validation && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-neutral-900">Import Validation</h3>
              <button onClick={() => setImportModalOpen(false)} className="text-neutral-400 hover:text-neutral-700">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ["Total Rows",    validation.totalRows],
                ["Matched Items", validation.matchedItems],
                ["Rows to Save",  validation.rowsToUpsert],
                ["Unmatched",     validation.unmatchedItems.length],
                ["Duplicates",    validation.duplicateRows.length],
                ["Errors",        validation.errors.length],
              ].map(([label, val]) => (
                <div key={label as string} className="bg-neutral-50 rounded-lg p-3">
                  <div className="text-xs text-neutral-500">{label}</div>
                  <div className={`text-lg font-bold ${Number(val) > 0 && label !== "Matched Items" && label !== "Rows to Save" && label !== "Total Rows" ? "text-amber-600" : "text-neutral-900"}`}>
                    {val}
                  </div>
                </div>
              ))}
            </div>

            {validation.errors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 max-h-32 overflow-y-auto text-xs text-red-700 space-y-1">
                {validation.errors.map((e: string, i: number) => <div key={i}>• {e}</div>)}
              </div>
            )}
            {validation.warnings.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 max-h-32 overflow-y-auto text-xs text-amber-700 space-y-1">
                {validation.warnings.map((w: string, i: number) => <div key={i}>• {w}</div>)}
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setImportModalOpen(false)}
                className="flex-1 px-4 py-2 text-sm font-medium border border-neutral-200 rounded-lg hover:bg-neutral-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmImport}
                disabled={!validation.valid || importing}
                className="flex-1 px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
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
