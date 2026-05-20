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

import { Fragment, useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { useAuth } from "@/components/AuthProvider";
import {
  loadSaleItems,
  updateSaleItemStock,
  logMovement,
  loadFgCountSessions,
  loadFgCountSessionByDate,
  loadFgCountSessionById,
  upsertFgCountSessionWithLines,
  type SaleItem,
  type FgCountLineRow,
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
  History,
  ChevronRight,
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

interface HistorySession {
  key: string;
  sessionId: string;
  date: string;
  sessionName: string;
  countedBy: string;
  items: FgCountLineRow[];
  varianceValue: number;
  gainValue: number;
  lossValue: number;
}

type HistoryRangePreset = "today" | "7d" | "30d" | "custom";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const $fmt = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

const todayISO = () => {
  const d = new Date();
  const offsetMs = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, 10);
};

const addDaysISO = (dateISO: string, days: number) => {
  const date = new Date(`${dateISO}T00:00:00`);
  date.setDate(date.getDate() + days);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
};

function varianceLabel(v: number | null) {
  if (v === null) return null;
  if (v === 0) return { label: "No change", color: "text-zinc-500", icon: <Minus className="h-3.5 w-3.5" /> };
  if (v > 0)   return { label: `+${fmt(v)}`, color: "text-emerald-400",   icon: <TrendingUp className="h-3.5 w-3.5" /> };
  return          { label: fmt(v),           color: "text-red-400",    icon: <TrendingDown className="h-3.5 w-3.5" /> };
}

function blankRows(items: SaleItem[]): CountRow[] {
  return items.map(item => ({
    item,
    countInput: "",
    saved:      false,
    saving:     false,
    error:      null,
    variance:   null,
  }));
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
  const { user } = useAuth();
  const [rows,        setRows]        = useState<CountRow[]>([]);
  const [isLoading,   setIsLoading]   = useState(true);
  const [isSavingAll, setIsSavingAll] = useState(false);
  const [search,      setSearch]      = useState("");
  const [filterCat,   setFilterCat]   = useState("All");
  const [saved,       setSaved]       = useState(0);
  const [countDate,   setCountDate]   = useState(todayISO);
  const [sessionName, setSessionName] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isSessionLoading, setIsSessionLoading] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historySessions, setHistorySessions] = useState<HistorySession[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyRangePreset, setHistoryRangePreset] = useState<HistoryRangePreset>("7d");
  const [historyFromDate, setHistoryFromDate] = useState(() => addDaysISO(todayISO(), -6));
  const [historyToDate, setHistoryToDate] = useState(todayISO);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const sessionIdRef = useRef(`FGC-${Date.now().toString(36).toUpperCase()}`);
  const suppressNextDateLoadRef = useRef(false);
  const countedByLabel = user?.name || user?.email || "Unknown user";

  const resolveHistoryRange = useCallback((preset = historyRangePreset) => {
    const today = todayISO();
    if (preset === "today") return { from: today, to: today };
    if (preset === "30d") return { from: addDaysISO(today, -29), to: today };
    if (preset === "custom") return { from: historyFromDate, to: historyToDate };
    return { from: addDaysISO(today, -6), to: today };
  }, [historyFromDate, historyRangePreset, historyToDate]);

  const applySessionLines = useCallback((lines: FgCountLineRow[], sessionId: string | null, nextSessionName?: string | null) => {
    const lineByItem = new Map(lines.map(line => [line.item_id, line]));
    setRows(prev => prev.map(row => {
      const line = lineByItem.get(row.item.id);
      if (!line) {
        return { ...row, countInput: "", saved: false, saving: false, error: null, variance: null };
      }
      const variance = line.physical_qty - row.item.instock;
      return {
        ...row,
        countInput: String(line.physical_qty),
        saved:      true,
        saving:     false,
        error:      null,
        variance,
      };
    }));
    setSaved(lines.length);
    setActiveSessionId(sessionId);
    if (sessionId) sessionIdRef.current = sessionId;
    if (nextSessionName !== undefined) setSessionName(nextSessionName ?? "");
  }, []);

  const loadSessionForDate = useCallback(async (date: string) => {
    if (!date) return;
    setIsSessionLoading(true);
    setRows(prev => prev.map(row => ({
      ...row,
      countInput: "",
      saved: false,
      saving: false,
      error: null,
      variance: null,
    })));
    setSaved(0);
    setActiveSessionId(null);
    sessionIdRef.current = `FGC-${Date.now().toString(36).toUpperCase()}`;

    try {
      const savedSession = await loadFgCountSessionByDate(date);
      if (savedSession) {
        applySessionLines(savedSession.lines, savedSession.session.id, savedSession.session.session_name);
      } else {
        setSessionName("");
      }
    } finally {
      setIsSessionLoading(false);
    }
  }, [applySessionLines]);

  // ── Load ───────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setIsLoading(true);
    const items = await loadSaleItems();
    const active = items.filter(i => i.isActive);
    setRows(blankRows(active));
    setSaved(0);
    sessionIdRef.current = `FGC-${Date.now().toString(36).toUpperCase()}`;
    setIsLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (isLoading || rows.length === 0) return;
    if (suppressNextDateLoadRef.current) {
      suppressNextDateLoadRef.current = false;
      return;
    }
    loadSessionForDate(countDate);
  }, [countDate, isLoading, rows.length, loadSessionForDate]);

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

  // ── Value totals (making_cost based) ──────────────────────────────────────
  const systemFgValue = visible.reduce(
    (s, r) => s + r.item.instock * r.item.makingCost, 0
  );
  const physicalFgValue = visible.reduce((s, r) => {
    const num = parseFloat(r.countInput);
    return s + (r.countInput !== "" && !isNaN(num) ? num * r.item.makingCost : 0);
  }, 0);
  const varianceValue = visible.reduce((s, r) => {
    return s + (r.variance !== null ? r.variance * r.item.makingCost : 0);
  }, 0);

  const loadHistoryRange = useCallback(async () => {
    setIsHistoryLoading(true);
    try {
      const range = resolveHistoryRange();
      const sessions = await loadFgCountSessions({
        dateFrom: range.from,
        dateTo: range.to,
      });
      const loaded = await Promise.all(
        sessions.map(session => loadFgCountSessionById(session.id))
      );
      setHistorySessions(
        loaded
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
          .map(entry => {
            const varianceValue = entry.lines.reduce((sum, line) => sum + line.variance_value, 0);
            return {
              key: entry.session.id,
              sessionId: entry.session.id,
              date: entry.session.count_date,
              sessionName: entry.session.session_name?.trim() || "Unnamed Session",
              countedBy: entry.session.counted_by_name || entry.session.counted_by || "Unknown user",
              items: entry.lines,
              varianceValue,
              gainValue: entry.lines.reduce((sum, line) => sum + Math.max(0, line.variance_value), 0),
              lossValue: entry.lines.reduce((sum, line) => sum + Math.abs(Math.min(0, line.variance_value)), 0),
            };
          })
      );
      setExpandedSession(null);
    } finally {
      setIsHistoryLoading(false);
    }
  }, [resolveHistoryRange]);

  const openHistory = async () => {
    setIsHistoryOpen(true);
    await loadHistoryRange();
  };

  useEffect(() => {
    if (!isHistoryOpen) return;
    loadHistoryRange();
  }, [historyRangePreset, historyFromDate, historyToDate, isHistoryOpen, loadHistoryRange]);

  const loadHistorySession = async (sessionId: string) => {
    const savedSession = await loadFgCountSessionById(sessionId);
    if (!savedSession) return;
    suppressNextDateLoadRef.current = true;
    setCountDate(savedSession.session.count_date);
    applySessionLines(savedSession.lines, savedSession.session.id, savedSession.session.session_name);
    setIsHistoryOpen(false);
  };

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

  const handleCountDateChange = (date: string) => {
    setCountDate(date);
    setRows(prev => prev.map(row => ({
      ...row,
      countInput: "",
      saved: false,
      saving: false,
      error: null,
      variance: null,
    })));
    setSaved(0);
  };

  const persistCountLines = async (countRows: CountRow[]) => {
    const sessionId = activeSessionId ?? sessionIdRef.current;
    sessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);

    return upsertFgCountSessionWithLines({
      session: {
        id: sessionId,
        countDate,
        sessionName: sessionName.trim() || null,
        countedBy: user?.id ?? null,
        countedByName: countedByLabel,
      },
      lines: countRows.map(row => {
        const physicalQty = parseFloat(row.countInput);
        const varianceQty = physicalQty - row.item.instock;
        const unitCost = row.item.makingCost || 0;
        return {
          itemId: row.item.id,
          itemName: row.item.name,
          unit: row.item.baseUnit,
          systemQty: row.item.instock,
          physicalQty,
          varianceQty,
          unitCost,
          varianceValue: varianceQty * unitCost,
        };
      }),
    });
  };

  // ── Save single row ────────────────────────────────────────────────────────
  const saveRow = async (row: CountRow): Promise<boolean> => {
    if (!countDate) {
      setRows(prev => prev.map(r =>
        r.item.id === row.item.id ? { ...r, error: "Count date is required" } : r
      ));
      return false;
    }

    const num = parseFloat(row.countInput);
    if (isNaN(num) || num < 0) {
      setRows(prev => prev.map(r =>
        r.item.id === row.item.id ? { ...r, error: "Enter a valid number ≥ 0" } : r
      ));
      return false;
    }

    const delta = num - row.item.instock;
    setRows(prev => prev.map(r =>
      r.item.id === row.item.id ? { ...r, saving: true, error: null } : r
    ));

    const persistResult = await persistCountLines([row]);
    if (!persistResult.success) {
      setRows(prev => prev.map(r =>
        r.item.id === row.item.id
          ? { ...r, saving: false, error: persistResult.error?.message ?? "Session save failed" }
          : r
      ));
      return false;
    }

    if (delta === 0) {
      setRows(prev => prev.map(r =>
        r.item.id === row.item.id ? { ...r, saving: false, saved: true, error: null } : r
      ));
      return true;
    }

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
    const varianceValue = delta * row.item.makingCost;
    logMovement({
      locationId:    "LOC-HQ",
      itemId:        row.item.id,
      movementType:  delta > 0 ? "count_variance_gain" : "count_variance_loss",
      quantity:      Math.abs(delta),
      unitCost:      row.item.makingCost > 0 ? row.item.makingCost : null,
      referenceType: "fg_count",
      referenceId:   sessionIdRef.current,
      notes:         JSON.stringify({
        kind: "fg_count_session",
        count_date: countDate,
        session_name: sessionName.trim() || null,
        counted_by: user?.id ?? null,
        counted_by_name: countedByLabel,
        item_name: row.item.name,
        unit: row.item.baseUnit,
        system_qty: row.item.instock,
        physical_qty: num,
        variance_qty: delta,
        variance_value: varianceValue,
        display_note: `FG count: system ${fmt(row.item.instock)} -> counted ${fmt(num)} (${delta > 0 ? "+" : ""}${fmt(delta)}) - ${row.item.name}`,
      }),
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
      <div className="flex items-center justify-center p-16 text-zinc-500 gap-2">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading FG Count…
      </div>
    );
  }

  return (
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-[#070707] p-6 text-zinc-100">
      <style>{`
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
      `}</style>
      <div className="mx-auto max-w-[1408px] space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-500">FG Count</p>
          <h2 className="mt-2 flex items-center gap-2 text-2xl font-semibold tracking-tight text-white">
            <ClipboardCheck className="h-6 w-6 text-blue-400" />
            Finished Goods Count
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Enter physical counts below. Saves update live stock and log variances.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={openHistory}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#151515] px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-[#1f1f1f]"
          >
            <History className="h-4 w-4" /> FG Count History
          </button>
          <button
            onClick={load}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#151515] px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-[#1f1f1f]"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={saveAll}
            disabled={!countDate || isSessionLoading || isSavingAll || visible.every(r => r.countInput === "" || r.saved)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSavingAll
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
              : <><Save className="h-4 w-4" /> Save All</>}
          </button>
        </div>
      </div>
      {isSessionLoading && (
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#151515] px-3 py-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading count sheet for {countDate}…
        </div>
      )}

      {/* ── Session controls ───────────────────────────────────────────── */}
      <Card className="rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.32)]">
        <CardContent className="grid grid-cols-1 gap-3 px-4 py-4 md:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
              Count Date <span className="text-red-500">*</span>
            </label>
            <input
              type="date"
              value={countDate}
              onChange={e => handleCountDateChange(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
              Session Name
            </label>
            <input
              type="text"
              value={sessionName}
              onChange={e => setSessionName(e.target.value)}
              placeholder="Night Closing Count, Weekly Audit, etc."
              className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
              Counted By
            </label>
            <input
              type="text"
              value={countedByLabel}
              readOnly
              className="w-full rounded-lg border border-white/10 bg-[#0d0d0d] px-3 py-2 text-sm text-zinc-400"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Count summary cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: "Items Entered",    value: enteredCount,   color: "text-blue-400",    icon: ClipboardCheck, bg: "bg-blue-500" },
          { label: "Variances Found",  value: varianceItems,  color: "text-violet-400",  icon: AlertTriangle, bg: "bg-violet-500" },
          { label: "Count Gains",      value: gainItems,      color: "text-emerald-400", icon: TrendingUp, bg: "bg-emerald-500" },
          { label: "Count Losses",     value: lossItems,      color: "text-red-400",     icon: TrendingDown, bg: "bg-red-500" },
        ].map(s => (
          <div key={s.label} className="rounded-xl border border-white/10 bg-[#151515] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">{s.label}</p>
                <p className={`mt-3 text-3xl font-semibold tracking-tight ${s.color}`}>{s.value}</p>
              </div>
              <div className={`rounded-lg p-2.5 text-white shadow-lg ${s.bg}`}>
                <s.icon className="h-4 w-4" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Value cards (making_cost based) ─────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-white/10 bg-[#111111] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.24)]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">System FG Value</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-white">{$fmt(systemFgValue)}</p>
          <p className="mt-1 text-[10px] text-zinc-600">Σ (system stock × making cost)</p>
        </div>
        <div className="rounded-xl border border-blue-500/20 bg-[#101827] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.24)]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-200/60">Physical FG Value</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-blue-200">
            {enteredCount > 0 ? $fmt(physicalFgValue) : <span className="text-zinc-600">—</span>}
          </p>
          <p className="mt-1 text-[10px] text-blue-100/40">Σ (physical count × making cost)</p>
        </div>
        <div className={`rounded-xl border p-4 shadow-[0_18px_50px_rgba(0,0,0,0.24)] ${
          varianceValue === 0 || enteredCount === 0
            ? "border-white/10 bg-[#111111]"
            : varianceValue > 0
            ? "border-emerald-500/20 bg-emerald-500/10"
            : "border-red-500/20 bg-red-500/10"
        }`}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Variance Value</p>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${
            enteredCount === 0 || varianceValue === 0
              ? "text-zinc-600"
              : varianceValue > 0
              ? "text-emerald-300"
              : "text-red-300"
          }`}>
            {enteredCount > 0
              ? <>{varianceValue > 0 ? "+" : ""}{$fmt(varianceValue)}</>
              : "—"}
          </p>
          <p className="mt-1 text-[10px] text-zinc-600">Σ (variance qty × making cost)</p>
        </div>
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <Card className="rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.24)]">
        <CardContent className="flex flex-wrap items-center gap-3 px-4 py-3">
          {/* Search */}
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              placeholder="Search item name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-[#171717] py-2 pl-8 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          {/* Category */}
          <div className="relative min-w-[180px]">
            <Filter className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <select
              value={filterCat}
              onChange={e => setFilterCat(e.target.value)}
              className="w-full appearance-none rounded-lg border border-white/10 bg-[#171717] py-2 pl-8 pr-7 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          </div>
          {/* Enter-key tip */}
          <p className="hidden text-xs italic text-zinc-600 sm:block">
            Tip: press <kbd className="rounded border border-white/10 bg-[#1f1f1f] px-1 py-0.5 font-mono text-[10px]">Enter</kbd> to save and move to the next row
          </p>
        </CardContent>
      </Card>

      {/* ── Count table ────────────────────────────────────────────────── */}
      <Card className="overflow-hidden rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.32)]">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-white/5 bg-[#151515]">
              <tr>
                {["Item", "Category", "Making Cost", "System Stock", "System Value", "Physical Count", "Physical Value", "Variance", "Variance Value", "Status"].map(h => (
                  <th key={h} className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-sm text-zinc-500">
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
                        ? "bg-emerald-500/10"
                        : row.error
                        ? "bg-red-500/10"
                        : "hover:bg-white/[0.03]"
                    }`}
                  >
                    {/* Item name */}
                    <td className="px-4 py-2.5">
                      <p className="font-semibold leading-tight text-white">{row.item.name}</p>
                      <p className="mt-0.5 font-mono text-[10px] text-zinc-600">{row.item.id}</p>
                    </td>

                    {/* Category */}
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-zinc-500">{row.item.category ?? "—"}</span>
                    </td>

                    {/* Making Cost */}
                    <td className="px-4 py-2.5">
                      {row.item.makingCost > 0 ? (
                        <span className="font-mono text-xs tabular-nums text-zinc-300">
                          {$fmt(row.item.makingCost)}
                          <span className="text-zinc-600">/{row.item.baseUnit}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                          No cost
                        </span>
                      )}
                    </td>

                    {/* System stock */}
                    <td className="px-4 py-2.5">
                      <span className="font-mono font-semibold tabular-nums text-zinc-300">
                        {fmt(row.item.instock)}
                      </span>
                      <span className="ml-1 text-xs text-zinc-600">{row.item.baseUnit}</span>
                    </td>

                    {/* System Value */}
                    <td className="px-4 py-2.5">
                      <span className="font-mono text-xs tabular-nums text-zinc-400">
                        {$fmt(row.item.instock * row.item.makingCost)}
                      </span>
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
                          className={`w-24 rounded-lg border px-2.5 py-1.5 text-sm font-medium tabular-nums transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 ${
                            row.error
                              ? "border-red-500/30 bg-red-500/10 text-red-300"
                              : row.saved
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                              : "border-white/10 bg-[#171717] text-zinc-100"
                          }`}
                        />
                        {row.countInput !== "" && !row.saved && (
                          <button
                            onClick={() => saveRow(row)}
                            disabled={row.saving}
                            className="rounded-lg bg-blue-500/15 p-1.5 text-blue-300 transition-colors hover:bg-blue-500/25 disabled:opacity-50"
                            title="Save this row"
                          >
                            {row.saving
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Save className="h-3.5 w-3.5" />}
                          </button>
                        )}
                      </div>
                      {row.error && (
                        <p className="mt-0.5 text-[10px] text-red-400">{row.error}</p>
                      )}
                    </td>

                    {/* Physical Value */}
                    <td className="px-4 py-2.5">
                      {row.countInput !== "" && !isNaN(parseFloat(row.countInput)) ? (
                        <span className="font-mono text-xs font-semibold tabular-nums text-blue-300">
                          {$fmt(parseFloat(row.countInput) * row.item.makingCost)}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-700">—</span>
                      )}
                    </td>

                    {/* Variance qty */}
                    <td className="px-4 py-2.5">
                      {vLabel ? (
                        <span className={`inline-flex items-center gap-1 text-xs font-semibold tabular-nums ${vLabel.color}`}>
                          {vLabel.icon} {vLabel.label}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-700">—</span>
                      )}
                    </td>

                    {/* Variance Value */}
                    <td className="px-4 py-2.5">
                      {row.variance !== null ? (
                        <span className={`font-mono tabular-nums text-xs font-semibold ${
                          row.variance === 0
                            ? "text-zinc-500"
                            : row.variance > 0
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}>
                          {row.variance > 0 ? "+" : ""}{$fmt(row.variance * row.item.makingCost)}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-700">—</span>
                      )}
                    </td>

                    {/* Status */}
                    <td className="px-4 py-2.5">
                      {row.saved ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" /> Saved
                        </span>
                      ) : row.error ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-300">
                          <AlertTriangle className="h-3 w-3" /> Error
                        </span>
                      ) : row.countInput !== "" ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                          Pending
                        </span>
                      ) : (
                        <span className="text-[11px] text-zinc-700">—</span>
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
          <div className="flex items-center gap-2 border-t border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            {saved} item{saved !== 1 ? "s" : ""} saved this session. Stock updated and variances logged.
          </div>
        )}
      </Card>

      <Drawer
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        title="FG Count History"
        description="Historical variance sessions grouped by count date and session."
      >
        <div className="space-y-3">
          <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
            <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
              <div className="min-w-[180px]">
                <label className="text-[10px] uppercase tracking-wider font-bold text-neutral-500 block mb-1">
                  Date Filter
                </label>
                <select
                  value={historyRangePreset}
                  onChange={e => setHistoryRangePreset(e.target.value as HistoryRangePreset)}
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                >
                  <option value="today">Today</option>
                  <option value="7d">Last 7 Days</option>
                  <option value="30d">Last 30 Days</option>
                  <option value="custom">Custom Range</option>
                </select>
              </div>
              {historyRangePreset === "custom" && (
                <>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-bold text-neutral-500 block mb-1">
                      From
                    </label>
                    <input
                      type="date"
                      value={historyFromDate}
                      onChange={e => setHistoryFromDate(e.target.value)}
                      className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-bold text-neutral-500 block mb-1">
                      To
                    </label>
                    <input
                      type="date"
                      value={historyToDate}
                      onChange={e => setHistoryToDate(e.target.value)}
                      className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                    />
                  </div>
                </>
              )}
              <button
                type="button"
                onClick={loadHistoryRange}
                disabled={isHistoryLoading}
                className="px-3 py-2 text-sm font-semibold bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {isHistoryLoading
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <RefreshCw className="h-4 w-4" />}
                Refresh
              </button>
            </div>
          </div>

          {isHistoryLoading ? (
            <div className="flex items-center justify-center p-10 text-neutral-400 gap-2">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading count history…
            </div>
          ) : historySessions.length === 0 ? (
            <div className="bg-white border border-neutral-200 rounded-xl p-8 text-center text-sm text-neutral-400">
              No FG count variance history found yet.
            </div>
          ) : (
            <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 border-b border-neutral-100">
                  <tr>
                    {["", "Date", "Session Name", "Counted By", "Items Counted", "Variance Value", "Gain / Loss"].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {historySessions.map(session => {
                    const open = expandedSession === session.key;
                    return (
                      <Fragment key={session.key}>
                        <tr
                          key={session.key}
                          onClick={() => loadHistorySession(session.sessionId)}
                          className="hover:bg-neutral-50 cursor-pointer"
                          title="Load this count session"
                        >
                          <td className="px-3 py-3 w-8">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedSession(open ? null : session.key);
                              }}
                              className="p-1 rounded hover:bg-neutral-100 text-neutral-500"
                            >
                              {open
                                ? <ChevronDown className="h-4 w-4" />
                                : <ChevronRight className="h-4 w-4" />}
                            </button>
                          </td>
                          <td className="px-3 py-3 font-medium text-neutral-900 whitespace-nowrap">{session.date}</td>
                          <td className="px-3 py-3 text-neutral-700">{session.sessionName}</td>
                          <td className="px-3 py-3 text-neutral-500">{session.countedBy}</td>
                          <td className="px-3 py-3 font-mono tabular-nums text-neutral-700">{session.items.length}</td>
                          <td className={`px-3 py-3 font-mono tabular-nums font-semibold ${
                            session.varianceValue > 0
                              ? "text-green-700"
                              : session.varianceValue < 0
                              ? "text-red-600"
                              : "text-neutral-400"
                          }`}>
                            {session.varianceValue > 0 ? "+" : ""}{$fmt(session.varianceValue)}
                          </td>
                          <td className="px-3 py-3 text-xs">
                            <span className="text-green-700 font-semibold">+{$fmt(session.gainValue)}</span>
                            <span className="text-neutral-300 px-1">/</span>
                            <span className="text-red-600 font-semibold">-{$fmt(session.lossValue)}</span>
                          </td>
                        </tr>
                        {open && (
                          <tr key={`${session.key}-items`} className="bg-neutral-50/60">
                            <td colSpan={7} className="px-3 py-3">
                              <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
                                <table className="w-full text-xs">
                                  <thead className="bg-neutral-50 border-b border-neutral-100">
                                    <tr>
                                      {["Item", "System Qty", "Physical Qty", "Variance Qty", "Variance Value"].map(h => (
                                        <th key={h} className="px-3 py-2 text-left font-semibold text-neutral-500 uppercase tracking-wider">
                                          {h}
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-neutral-50">
                                    {session.items.map(line => {
                                      return (
                                        <tr key={line.id}>
                                          <td className="px-3 py-2">
                                            <p className="font-semibold text-neutral-900">{line.item_name || line.item_id || "Unknown item"}</p>
                                            <p className="text-[10px] text-neutral-400 font-mono">{line.item_id}</p>
                                          </td>
                                          <td className="px-3 py-2 font-mono tabular-nums text-neutral-600">
                                            {fmt(line.system_qty)} {line.unit ?? ""}
                                          </td>
                                          <td className="px-3 py-2 font-mono tabular-nums text-neutral-600">
                                            {fmt(line.physical_qty)} {line.unit ?? ""}
                                          </td>
                                          <td className={`px-3 py-2 font-mono tabular-nums font-semibold ${
                                            line.variance_qty > 0 ? "text-green-700" : line.variance_qty < 0 ? "text-red-600" : "text-neutral-400"
                                          }`}>
                                            {line.variance_qty > 0 ? "+" : ""}{fmt(line.variance_qty)} {line.unit ?? ""}
                                          </td>
                                          <td className={`px-3 py-2 font-mono tabular-nums font-semibold ${
                                            line.variance_value > 0 ? "text-green-700" : line.variance_value < 0 ? "text-red-600" : "text-neutral-400"
                                          }`}>
                                            {line.variance_value > 0 ? "+" : ""}{$fmt(line.variance_value)}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Drawer>
      </div>
    </div>
  );
}
