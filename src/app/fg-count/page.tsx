"use client";

/**
 * /fg-count — Finished Goods Daily Count
 *
 * Fast daily stock-count workflow for finished goods only.
 * - Loads all active hq_sale_items
 * - Lets staff enter a physical count per item
 * - On "Save Count": computes delta vs current instock,
 *     calls updateSaleItemStock(id, delta) to set the new stock,
 *     calls logMovement() with:
 *       movement_type = 'count_variance_gain' (count > system)
 *       movement_type = 'count_variance_loss' (count < system)
 * - No new tables. No duplicate stock column. Single source of truth.
 *
 * Architecture:
 *   READ  hq_sale_items.instock  (via loadSaleItems)
 *   WRITE hq_sale_items.instock  (via updateSaleItemStock → delta)
 *   LOG   inventory_movements    (via logMovement → variance type)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import {
  loadSaleItems,
  updateSaleItemStock,
  logMovement,
  type SaleItem,
} from "@/lib/storage";
import {
  ClipboardCheck,
  Search,
  Save,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  Filter,
  ChevronDown,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CountRow {
  item:       SaleItem;
  countInput: string;   // raw text field — kept as string for UX
  saved:      boolean;
  saving:     boolean;
  error:      string | null;
  variance:   number | null; // computed: countNum - item.instock
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function varianceLabel(v: number | null) {
  if (v === null) return null;
  if (v === 0) return { label: "No change", color: "text-neutral-400", icon: <Minus className="h-3.5 w-3.5" /> };
  if (v > 0)   return { label: `+${fmt(v)}`, color: "text-green-600",   icon: <TrendingUp className="h-3.5 w-3.5" /> };
  return          { label: fmt(v),           color: "text-red-500",    icon: <TrendingDown className="h-3.5 w-3.5" /> };
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function FgCountPage() {
  return (
    <HQOnlyGuard>
      <FgCountContent />
    </HQOnlyGuard>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

function FgCountContent() {
  const [rows,        setRows]        = useState<CountRow[]>([]);
  const [isLoading,   setIsLoading]   = useState(true);
  const [isSavingAll, setIsSavingAll] = useState(false);
  const [search,      setSearch]      = useState("");
  const [filterCat,   setFilterCat]   = useState("All");
  const [saved,       setSaved]       = useState(0);

  // ── Load ───────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setIsLoading(true);
    const items = await loadSaleItems();
    const active = items.filter(i => i.isActive);
    setRows(
      active.map(item => ({
        item,
        countInput: "",  // blank = not yet entered
        saved:      false,
        saving:     false,
        error:      null,
        variance:   null,
      }))
    );
    setSaved(0);
    setIsLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const categories = ["All", ...Array.from(new Set(rows.map(r => r.item.category ?? "Uncategorised"))).sort()];

  const visible = rows.filter(r => {
    const matchSearch = !search || r.item.name.toLowerCase().includes(search.toLowerCase());
    const matchCat =
      filterCat === "All" ||
      (r.item.category ?? "Uncategorised") === filterCat;
    return matchSearch && matchCat;
  });

  const enteredCount   = visible.filter(r => r.countInput !== "").length;
  const varianceItems  = visible.filter(r => r.variance !== null && r.variance !== 0).length;
  const gainItems      = visible.filter(r => r.variance !== null && r.variance > 0).length;
  const lossItems      = visible.filter(r => r.variance !== null && r.variance < 0).length;

  // ── Input change ───────────────────────────────────────────────────────────
  const handleInput = (itemId: string, val: string) => {
    setRows(prev => prev.map(r => {
      if (r.item.id !== itemId) return r;
      const num    = parseFloat(val);
      const variance = val !== "" && !isNaN(num)
        ? num - r.item.instock
        : null;
      return { ...r, countInput: val, variance, saved: false, error: null };
    }));
  };

  // ── Save single row ────────────────────────────────────────────────────────
  const saveRow = async (row: CountRow): Promise<boolean> => {
    const num = parseFloat(row.countInput);
    if (isNaN(num) || num < 0) {
      setRows(prev => prev.map(r =>
        r.item.id === row.item.id ? { ...r, error: "Enter a valid number ≥ 0" } : r
      ));
      return false;
    }

    const delta = num - row.item.instock;
    if (delta === 0) {
      // No change — mark saved without DB write
      setRows(prev => prev.map(r =>
        r.item.id === row.item.id ? { ...r, saved: true, error: null } : r
      ));
      return true;
    }

    setRows(prev => prev.map(r =>
      r.item.id === row.item.id ? { ...r, saving: true, error: null } : r
    ));

    // Write stock
    const res = await updateSaleItemStock(row.item.id, delta);

    if (!res.success) {
      setRows(prev => prev.map(r =>
        r.item.id === row.item.id
          ? { ...r, saving: false, error: res.error?.message ?? "Save failed" }
          : r
      ));
      return false;
    }

    // Log variance movement (fire-and-forget)
    // item_id for hq_sale_items is the sale item id itself — used as movement reference.
    // location_id = LOC-HQ (commissary stock).
    logMovement({
      locationId:    "LOC-HQ",
      itemId:        row.item.id,
      movementType:  delta > 0 ? "count_variance_gain" : "count_variance_loss",
      quantity:      Math.abs(delta),
      unitCost:      row.item.makingCost > 0 ? row.item.makingCost : null,
      referenceType: "fg_count",
      notes:         `FG count: system ${fmt(row.item.instock)} → counted ${fmt(num)} (${delta > 0 ? "+" : ""}${fmt(delta)}) — ${row.item.name}`,
    });

    // Update local row with new stock value
    setRows(prev => prev.map(r =>
      r.item.id === row.item.id
        ? {
            ...r,
            saving:   false,
            saved:    true,
            error:    null,
            variance: delta,
            item:     { ...r.item, instock: res.newStock ?? num },
          }
        : r
    ));
    return true;
  };

  // ── Save all entered ───────────────────────────────────────────────────────
  const saveAll = async () => {
    const toSave = visible.filter(r => r.countInput !== "" && !r.saved && !r.saving);
    if (toSave.length === 0) return;

    setIsSavingAll(true);
    let ok = 0;
    for (const row of toSave) {
      const success = await saveRow(row);
      if (success) ok++;
    }
    setSaved(prev => prev + ok);
    setIsSavingAll(false);
  };

  // ── Keyboard: Enter moves to next row ─────────────────────────────────────
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const handleKeyDown = (e: React.KeyboardEvent, itemId: string) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const ids = visible.map(r => r.item.id);
    const idx = ids.indexOf(itemId);
    if (idx === -1) return;
    // try to save current Row
    const row = rows.find(r => r.item.id === itemId);
    if (row && row.countInput !== "") saveRow(row);
    // focus next
    const nextId = ids[idx + 1];
    if (nextId) inputRefs.current[nextId]?.focus();
  };

  // ── UI ─────────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-16 text-neutral-400 gap-2">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading FG Count…
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900 flex items-center gap-2">
            <ClipboardCheck className="h-6 w-6 text-brand-600" />
            Finished Goods Count
          </h2>
          <p className="text-sm text-neutral-500 mt-0.5">
            Enter physical counts below. Saves update live stock and log variances.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-600 rounded-lg hover:bg-neutral-50 transition-colors"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={saveAll}
            disabled={isSavingAll || visible.every(r => r.countInput === "" || r.saved)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors shadow-sm"
          >
            {isSavingAll
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
              : <><Save className="h-4 w-4" /> Save All</>}
          </button>
        </div>
      </div>

      {/* ── Summary cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Items Entered",    value: enteredCount,   color: "text-brand-600",   bg: "bg-brand-50   border-brand-100"   },
          { label: "Variances Found",  value: varianceItems,  color: "text-amber-600",   bg: "bg-amber-50   border-amber-100"   },
          { label: "Count Gains",      value: gainItems,      color: "text-green-600",   bg: "bg-green-50   border-green-100"   },
          { label: "Count Losses",     value: lossItems,      color: "text-red-600",     bg: "bg-red-50     border-red-100"     },
        ].map(s => (
          <div key={s.label} className={`rounded-xl border p-3 ${s.bg}`}>
            <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">{s.label}</p>
            <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <Card className="shadow-sm">
        <CardContent className="py-3 px-4 flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search item name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-400 bg-neutral-50"
            />
          </div>
          {/* Category */}
          <div className="relative min-w-[180px]">
            <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-400 pointer-events-none" />
            <select
              value={filterCat}
              onChange={e => setFilterCat(e.target.value)}
              className="w-full appearance-none pl-8 pr-7 py-1.5 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
            >
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-400 pointer-events-none" />
          </div>
          {/* Enter-key tip */}
          <p className="text-xs text-neutral-400 italic hidden sm:block">
            Tip: press <kbd className="px-1 py-0.5 rounded bg-neutral-100 border border-neutral-200 font-mono text-[10px]">Enter</kbd> to save and move to the next row
          </p>
        </CardContent>
      </Card>

      {/* ── Count table ────────────────────────────────────────────────── */}
      <Card className="shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Item", "Category", "System Stock", "Physical Count", "Variance", "Status"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-neutral-400 text-sm">
                    No items match your filters.
                  </td>
                </tr>
              ) : visible.map(row => {
                const vLabel = varianceLabel(row.variance);
                return (
                  <tr
                    key={row.item.id}
                    className={`transition-colors ${
                      row.saved
                        ? "bg-green-50/40"
                        : row.error
                        ? "bg-red-50/40"
                        : "hover:bg-neutral-50/60"
                    }`}
                  >
                    {/* Item name */}
                    <td className="px-4 py-2.5">
                      <p className="font-semibold text-neutral-900 leading-tight">{row.item.name}</p>
                      <p className="text-[10px] text-neutral-400 font-mono mt-0.5">{row.item.id}</p>
                    </td>

                    {/* Category */}
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-neutral-500">{row.item.category ?? "—"}</span>
                    </td>

                    {/* System stock */}
                    <td className="px-4 py-2.5">
                      <span className="font-mono font-semibold text-neutral-700 tabular-nums">
                        {fmt(row.item.instock)}
                      </span>
                      <span className="text-neutral-400 text-xs ml-1">{row.item.baseUnit}</span>
                    </td>

                    {/* Count input */}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <input
                          ref={el => { inputRefs.current[row.item.id] = el; }}
                          type="number"
                          min="0"
                          step="any"
                          placeholder={fmt(row.item.instock)}
                          value={row.countInput}
                          onChange={e => handleInput(row.item.id, e.target.value)}
                          onKeyDown={e => handleKeyDown(e, row.item.id)}
                          disabled={row.saving}
                          className={`w-24 px-2.5 py-1.5 border rounded-lg text-sm tabular-nums font-medium focus:outline-none focus:ring-2 focus:ring-brand-400 transition-colors disabled:opacity-50 ${
                            row.error
                              ? "border-red-300 bg-red-50 text-red-700"
                              : row.saved
                              ? "border-green-300 bg-green-50 text-green-700"
                              : "border-neutral-200 bg-white text-neutral-900"
                          }`}
                        />
                        {row.countInput !== "" && !row.saved && (
                          <button
                            onClick={() => saveRow(row)}
                            disabled={row.saving}
                            className="p-1.5 rounded-lg bg-brand-100 hover:bg-brand-200 text-brand-700 transition-colors disabled:opacity-50"
                            title="Save this row"
                          >
                            {row.saving
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Save className="h-3.5 w-3.5" />}
                          </button>
                        )}
                      </div>
                      {row.error && (
                        <p className="text-[10px] text-red-600 mt-0.5">{row.error}</p>
                      )}
                    </td>

                    {/* Variance */}
                    <td className="px-4 py-2.5">
                      {vLabel ? (
                        <span className={`inline-flex items-center gap-1 text-xs font-semibold tabular-nums ${vLabel.color}`}>
                          {vLabel.icon} {vLabel.label}
                        </span>
                      ) : (
                        <span className="text-neutral-300 text-xs">—</span>
                      )}
                    </td>

                    {/* Status */}
                    <td className="px-4 py-2.5">
                      {row.saved ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200">
                          <CheckCircle2 className="h-3 w-3" /> Saved
                        </span>
                      ) : row.error ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">
                          <AlertTriangle className="h-3 w-3" /> Error
                        </span>
                      ) : row.countInput !== "" ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                          Pending
                        </span>
                      ) : (
                        <span className="text-neutral-300 text-[11px]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer summary */}
        {saved > 0 && (
          <div className="px-4 py-3 bg-green-50 border-t border-green-100 flex items-center gap-2 text-sm text-green-700 font-medium">
            <CheckCircle2 className="h-4 w-4" />
            {saved} item{saved !== 1 ? "s" : ""} saved this session. Stock updated and variances logged.
          </div>
        )}
      </Card>
    </div>
  );
}
