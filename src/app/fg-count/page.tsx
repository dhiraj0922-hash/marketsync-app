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
  loadFgCountSessions,
  loadFgCountSessionByDate,
  loadFgCountSessionById,
  calculateExpectedStockForDate,
  loadLatestFgCounts,
  saveFgCountLineAtomic,
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
  Bell,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CountRow {
  item:       SaleItem;
  countInput: string;   // raw text field — kept as string for UX
  saved:      boolean;
  saving:     boolean;
  error:      string | null;
  variance:   number | null; // computed: countNum - expectedStock
  expectedStock: number;     // system master count before count today
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
  if (v === 0) return { label: "No change", color: "text-slate-500", icon: <Minus className="h-3.5 w-3.5" /> };
  if (v > 0)   return { label: `+${fmt(v)}`, color: "text-emerald-700",   icon: <TrendingUp className="h-3.5 w-3.5" /> };
  return          { label: fmt(v),           color: "text-red-600",    icon: <TrendingDown className="h-3.5 w-3.5" /> };
}

function blankRows(items: SaleItem[], expectedMap: Record<string, number>): CountRow[] {
  return items.map(item => ({
    item,
    countInput: "",
    saved:      false,
    saving:     false,
    error:      null,
    variance:   null,
    expectedStock: expectedMap[item.id] ?? 0,
  }));
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function FgCountPage() {
  return (
    <HQOnlyGuard allowFulfillment={true}>
      <FgCountContent />
    </HQOnlyGuard>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

export function FgCountContent() {
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
  // Monotonic counter: each load call captures its own ID and checks it after
  // every await to detect stale responses when the date changes mid-flight.
  const requestIdRef = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
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
      return {
        ...row,
        countInput: String(line.physical_qty),
        saved:      true,
        saving:     false,
        error:      null,
        variance:   line.variance_qty,
        expectedStock: line.system_qty,
      };
    }));
    setSaved(lines.length);
    setActiveSessionId(sessionId);
    if (sessionId) sessionIdRef.current = sessionId;
    if (nextSessionName !== undefined) setSessionName(nextSessionName ?? "");
  }, []);

  // ── Load count sheet ───────────────────────────────────────────────────────
  // Single stable loader — never depends on rows, isLoading, activeSessionId,
  // or any other derived state. Triggered only by:
  //   1. Initial mount (countDate, refreshVersion=0)
  //   2. User changes the Count Date
  //   3. User clicks Refresh (refreshVersion bumps)
  // All other state changes (typing a count, editing session name, saving a row)
  // are purely local and MUST NOT re-run this function.
  const [latestCounts, setLatestCounts] = useState<Record<string, { lastCountDate: string | null; latestVariance: number }>>({});

  const loadCountSheet = useCallback(async (date: string) => {
    if (!date) return;

    // Each call gets a unique monotonic ID. After every await we verify we are
    // still the most-recent call; if not, we discard the stale result.
    const myRequestId = ++requestIdRef.current;

    if (process.env.NODE_ENV !== 'production') {
      console.log('[FG Count] load started', { date, requestId: myRequestId });
    }

    setIsLoading(true);
    setIsSessionLoading(false); // clear any previous session-only loading banner

    try {
      // Phase 1 — load items + latest-counts + expected stock in parallel
      const [items, counts, expectedMap] = await Promise.all([
        loadSaleItems(),
        loadLatestFgCounts(),
        calculateExpectedStockForDate(date, null),
      ]);

      // Stale check — date may have changed while the three fetches were running
      if (myRequestId !== requestIdRef.current) {
        if (process.env.NODE_ENV !== 'production') {
          console.log('[FG Count] stale response ignored', { date, requestId: myRequestId });
        }
        return;
      }

      const active = items.filter(i => i.isActive);
      setRows(blankRows(active, expectedMap));
      setSaved(0);
      setLatestCounts(counts || {});
      setActiveSessionId(null);
      setSessionName('');
      sessionIdRef.current = `FGC-${Date.now().toString(36).toUpperCase()}`;

      // Phase 2 — check for a saved session on this date
      const savedSession = await loadFgCountSessionByDate(date);

      // Stale check after the session fetch
      if (myRequestId !== requestIdRef.current) {
        if (process.env.NODE_ENV !== 'production') {
          console.log('[FG Count] stale response ignored (session)', { date, requestId: myRequestId });
        }
        return;
      }

      if (savedSession) {
        applySessionLines(
          savedSession.lines,
          savedSession.session.id,
          savedSession.session.session_name,
        );
      }

      if (process.env.NODE_ENV !== 'production') {
        console.log('[FG Count] load completed', { date, requestId: myRequestId, rowCount: active.length });
      }
    } catch (err) {
      console.error('[FG Count] load error', err);
    } finally {
      // Only clear the loading flag if this is still the latest request.
      // A newer request will clear it when it finishes.
      if (myRequestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  // applySessionLines has [] deps and is always stable.
  // Do NOT add rows, isLoading, activeSessionId, or any derived state here.
  }, [applySessionLines]);

  // ── Single loading effect ──────────────────────────────────────────────────
  // Fires only when the count date changes or the user explicitly refreshes.
  // `loadCountSheet` is stable (useCallback with stable deps), so adding it
  // here does NOT create a loop.
  useEffect(() => {
    // History-session restore: loadHistorySession sets this flag before changing
    // countDate so we apply the pre-loaded lines instead of doing a full reload.
    if (suppressNextDateLoadRef.current) {
      suppressNextDateLoadRef.current = false;
      if (process.env.NODE_ENV !== 'production') {
        console.log('[FG Count] load suppressed (history session restore)');
      }
      return;
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log('[FG Count] date changed', { date: countDate, version: refreshVersion });
    }
    void loadCountSheet(countDate);
  }, [countDate, refreshVersion, loadCountSheet]);

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
    (s, r) => s + r.expectedStock * r.item.makingCost, 0
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
        ? num - r.expectedStock
        : null;
      return { ...r, countInput: val, variance, saved: false, error: null };
    }));
  };

  const handleCountDateChange = (date: string) => {
    // Setting countDate is enough — the single loading useEffect will fire and
    // call loadCountSheet which resets rows, sessionId, and loads the new date.
    // Do NOT manually reset rows here; that would cause a double state flush.
    setCountDate(date);
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

    setRows(prev => prev.map(r =>
      r.item.id === row.item.id ? { ...r, saving: true, error: null } : r
    ));

    const sessionId = activeSessionId ?? sessionIdRef.current;
    sessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);

    // Dynamic Expected Stock check immediately before saving (Safeguard 4)
    const freshExpectedMap = await calculateExpectedStockForDate(countDate, sessionId);
    const freshExpected = freshExpectedMap[row.item.id] ?? 0;

    const res = await saveFgCountLineAtomic({
      sessionId,
      countDate,
      sessionName: sessionName.trim() || null,
      countedBy: user?.id ?? null,
      countedByName: countedByLabel,
      itemId: row.item.id,
      itemName: row.item.name,
      unit: row.item.baseUnit,
      physicalQty: num,
      unitCost: row.item.makingCost || 0,
    });

    if (!res.success) {
      setRows(prev => prev.map(r =>
        r.item.id === row.item.id
          ? { ...r, saving: false, error: res.error?.message ?? "Save failed" }
          : r
      ));
      return false;
    }

    // Update local row with saved atomic values
    setRows(prev => prev.map(r =>
      r.item.id === row.item.id
        ? {
            ...r,
            saving:   false,
            saved:    true,
            error:    null,
            variance: res.variance ?? (num - freshExpected),
            expectedStock: res.expectedStock ?? freshExpected,
            item:     { ...r.item, instock: num },
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
      <div className="-m-6 flex min-h-[calc(100vh-4rem)] items-center justify-center gap-2 bg-slate-50 p-16 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading FG Count…
      </div>
    );
  }

  return (
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-slate-50 p-4 text-slate-900 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-sm">
              <ClipboardCheck className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-black tracking-[0.18em] text-slate-950">STOCK DHARMA</p>
              <p className="text-xs font-medium text-slate-500">Page title: FG Count</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative min-w-0 sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search finished goods..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 outline-none transition focus:border-emerald-300 focus:ring-2 focus:ring-emerald-100"
              />
            </div>
            <button className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:bg-slate-50" aria-label="Notifications">
              <Bell className="h-4 w-4" />
            </button>
            <div className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-bold text-white">HQ Admin</div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-700">Finished Goods Control</p>
          <h2 className="mt-2 flex items-center gap-2 text-3xl font-bold tracking-tight text-slate-950">
            Finished Goods Count
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Enter physical counts, save date-based sessions, and review count variance history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={openHistory}
            className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
          >
            <History className="h-4 w-4" /> FG Count History
          </button>
          <button
            onClick={() => {
              if (process.env.NODE_ENV !== 'production') {
                console.log('[FG Count] manual refresh triggered');
              }
              setRefreshVersion(v => v + 1);
            }}
            className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={saveAll}
            disabled={!countDate || isSessionLoading || isSavingAll || visible.every(r => r.countInput === "" || r.saved)}
            className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSavingAll
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</>
              : <><Save className="h-4 w-4" /> Save All</>}
          </button>
        </div>
      </div>
      {isSessionLoading && (
        <div className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading count sheet for {countDate}…
        </div>
      )}

      {/* ── Session controls ───────────────────────────────────────────── */}
      <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
        <CardContent className="grid grid-cols-1 gap-3 px-4 py-4 md:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
              Count Date <span className="text-red-500">*</span>
            </label>
            <input
              type="date"
              value={countDate}
              onChange={e => handleCountDateChange(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-100"
              required
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
              Session Name
            </label>
            <input
              type="text"
              value={sessionName}
              onChange={e => setSessionName(e.target.value)}
              placeholder="Night Closing Count, Weekly Audit, etc."
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-100"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">
              Counted By
            </label>
            <input
              type="text"
              value={countedByLabel}
              readOnly
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Count summary cards ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: "Items Entered",    value: enteredCount,   color: "text-blue-700",    icon: ClipboardCheck, bg: "bg-blue-50 text-blue-700 ring-blue-100" },
          { label: "Variances Found",  value: varianceItems,  color: "text-slate-950",  icon: AlertTriangle, bg: "bg-amber-50 text-amber-700 ring-amber-100" },
          { label: "Count Gains",      value: gainItems,      color: "text-emerald-700", icon: TrendingUp, bg: "bg-emerald-50 text-emerald-700 ring-emerald-100" },
          { label: "Count Losses",     value: lossItems,      color: "text-red-700",     icon: TrendingDown, bg: "bg-red-50 text-red-700 ring-red-100" },
        ].map(s => (
          <div key={s.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">{s.label}</p>
                <p className={`mt-3 text-3xl font-semibold tracking-tight ${s.color}`}>{s.value}</p>
              </div>
              <div className={`rounded-xl p-2.5 ring-1 ${s.bg}`}>
                <s.icon className="h-4 w-4" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Value cards (making_cost based) ─────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">System FG Value</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">{$fmt(systemFgValue)}</p>
          <p className="mt-1 text-[10px] text-slate-400">Σ (system stock × making cost)</p>
        </div>
        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-blue-600">Physical FG Value</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-blue-700">
            {enteredCount > 0 ? $fmt(physicalFgValue) : <span className="text-blue-300">—</span>}
          </p>
          <p className="mt-1 text-[10px] text-blue-500/70">Σ (physical count × making cost)</p>
        </div>
        <div className={`rounded-2xl border p-4 shadow-sm ${
          varianceValue === 0 || enteredCount === 0
            ? "border-slate-200 bg-white"
            : varianceValue > 0
            ? "border-emerald-200 bg-emerald-50"
            : "border-red-200 bg-red-50"
        }`}>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Variance Value</p>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${
            enteredCount === 0 || varianceValue === 0
              ? "text-slate-400"
              : varianceValue > 0
              ? "text-emerald-700"
              : "text-red-700"
          }`}>
            {enteredCount > 0
              ? <>{varianceValue > 0 ? "+" : ""}{$fmt(varianceValue)}</>
              : "—"}
          </p>
          <p className="mt-1 text-[10px] text-slate-400">Σ (variance qty × making cost)</p>
        </div>
      </div>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
        <CardContent className="flex flex-wrap items-center gap-3 px-4 py-3">
          {/* Search */}
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search item name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-8 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-100"
            />
          </div>
          {/* Category */}
          <div className="relative min-w-[180px]">
            <Filter className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <select
              value={filterCat}
              onChange={e => setFilterCat(e.target.value)}
              className="w-full appearance-none rounded-xl border border-slate-200 bg-white py-2 pl-8 pr-7 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-100"
            >
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          </div>
          {/* Enter-key tip */}
          <p className="hidden text-xs italic text-slate-400 sm:block">
            Tip: press <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 font-mono text-[10px] text-slate-600">Enter</kbd> to save and move to the next row
          </p>
        </CardContent>
      </Card>

      {/* ── Count table ────────────────────────────────────────────────── */}
      <Card className="overflow-hidden rounded-2xl border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                {["Finished Good", "Expected Stock", "Physical Count", "Variance", "Last Count Date"].map(h => (
                  <th key={h} className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-500">
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
                        ? "bg-emerald-50"
                        : row.error
                        ? "bg-red-50"
                        : "hover:bg-slate-50"
                    }`}
                  >
                    {/* Finished Good */}
                    <td className="px-4 py-2.5">
                      <p className="font-semibold leading-tight text-slate-950">{row.item.name}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10px] text-slate-400">{row.item.id}</span>
                        {row.item.category && (
                          <span className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-600">
                            {row.item.category}
                          </span>
                        )}
                        {row.item.makingCost > 0 && (
                          <span className="font-mono text-[9px] text-slate-400">
                            ({$fmt(row.item.makingCost)}/{row.item.baseUnit})
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Expected Stock */}
                    <td className="px-4 py-2.5">
                      <span className="font-mono font-semibold tabular-nums text-slate-800">
                        {fmt(row.expectedStock)}
                      </span>
                      <span className="ml-1 text-xs text-slate-400">{row.item.baseUnit}</span>
                    </td>

                    {/* Physical Count */}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <input
                          ref={el => { inputRefs.current[row.item.id] = el; }}
                          type="number"
                          min="0"
                          step="any"
                          placeholder={fmt(row.expectedStock)}
                          value={row.countInput}
                          onChange={e => handleInput(row.item.id, e.target.value)}
                          onKeyDown={e => handleKeyDown(e, row.item.id)}
                          disabled={row.saving}
                          className={`w-24 rounded-lg border px-2.5 py-1.5 text-sm font-medium tabular-nums transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 ${
                            row.error
                              ? "border-red-200 bg-red-50 text-red-700"
                              : row.saved
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-slate-200 bg-white text-slate-900"
                          }`}
                        />
                        {row.countInput !== "" && !row.saved && (
                          <button
                            onClick={() => saveRow(row)}
                            disabled={row.saving}
                            className="rounded-lg bg-blue-50 p-1.5 text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-50"
                            title="Save this row"
                          >
                            {row.saving
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Save className="h-3.5 w-3.5" />}
                          </button>
                        )}
                        {row.saved && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                            <CheckCircle2 className="h-3 w-3" /> Saved
                          </span>
                        )}
                        {row.error && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                            <AlertTriangle className="h-3 w-3" /> Error
                          </span>
                        )}
                      </div>
                      {row.error && (
                        <p className="mt-0.5 text-[10px] text-red-600">{row.error}</p>
                      )}
                    </td>

                    {/* Variance */}
                    <td className="px-4 py-2.5">
                      {vLabel ? (
                        <div className="flex flex-col gap-0.5">
                          <span className={`inline-flex items-center gap-1 text-xs font-semibold tabular-nums ${vLabel.color}`}>
                            {vLabel.icon} {vLabel.label}
                          </span>
                          {row.variance !== null && row.item.makingCost > 0 && (
                            <span className="font-mono text-[10px] text-slate-400">
                              {row.variance > 0 ? "+" : ""}{$fmt(row.variance * row.item.makingCost)}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>

                    {/* Last Count Date */}
                    <td className="px-4 py-2.5 text-xs text-slate-600">
                      {latestCounts[row.item.id]?.lastCountDate
                        ? new Date(latestCounts[row.item.id].lastCountDate + 'T00:00:00').toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric"
                          })
                        : "Never"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer summary */}
        {saved > 0 && (
          <div className="flex items-center gap-2 border-t border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
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
