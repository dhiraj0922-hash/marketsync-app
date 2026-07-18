"use client";

/**
 * /fg-count — Finished Goods Count — Enterprise Workflow
 *
 * ARCHITECTURE (DO NOT CHANGE):
 *   - No schema changes
 *   - No RPC changes
 *   - No inventory posting changes
 *   - No approval logic changes
 *   - Storage APIs used:
 *       loadEnterpriseFgCountSessions, loadEnterpriseFgCountSessionById,
 *       createEnterpriseFgCountSession, saveEnterpriseFgCountDraft,
 *       submitEnterpriseFgCountSession
 *   - The old saveFgCountLineAtomic / loadFgCountSessionByDate path is
 *     kept for the atomic row-save inside the count sheet only.
 *
 * WORKFLOW:
 *   Dashboard  →  [+ Start New FG Count]  →  Create Session Modal
 *     →  Detail / Count Sheet  →  Save Draft  →  Submit  →  (Approve)
 *   Dashboard  →  click existing session row  →  Detail / Count Sheet
 */

import { Fragment, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { useAuth } from "@/components/AuthProvider";
import {
  loadSaleItems,
  loadEnterpriseFgCountSessions,
  loadEnterpriseFgCountSessionById,
  createEnterpriseFgCountSession,
  saveEnterpriseFgCountDraft,
  submitEnterpriseFgCountSession,
  calculateExpectedStockForDate,
  loadLatestFgCounts,
  saveFgCountLineAtomic,
  type SaleItem,
  type FgCountLineRow,
  type EnterpriseFgCountSession,
  type EnterpriseFgCountLine,
  type EnterpriseFgCountStatus,
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
  Plus,
  ArrowLeft,
  Calendar,
  MapPin,
  User,
  Tag,
  Send,
  FileText,
  X,
  Info,
  AlertCircle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type PageView = "dashboard" | "detail";

interface CountRow {
  item:          SaleItem;
  countInput:    string;
  saved:         boolean;
  saving:        boolean;
  error:         string | null;
  variance:      number | null;
  expectedStock: number;
}

type HistoryRangePreset = "today" | "7d" | "30d" | "custom";

const COUNT_TYPES = [
  "Opening Count",
  "Closing Count",
  "Weekly Count",
  "Monthly Count",
  "Cycle Count",
  "Spot Audit",
] as const;

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

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const autoSessionName = (dateISO: string, countType: string): string => {
  const d = new Date(`${dateISO}T00:00:00`);
  const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${label} ${countType}`;
};

function varianceLabel(v: number | null) {
  if (v === null) return null;
  if (v === 0)   return { label: "No change", color: "text-slate-500", icon: <Minus className="h-3.5 w-3.5" /> };
  if (v > 0)     return { label: `+${fmt(v)}`, color: "text-emerald-700", icon: <TrendingUp className="h-3.5 w-3.5" /> };
  return           { label: fmt(v),            color: "text-red-600",    icon: <TrendingDown className="h-3.5 w-3.5" /> };
}

// Status badge
const STATUS_CONFIG: Record<EnterpriseFgCountStatus, { label: string; bg: string; text: string; dot: string }> = {
  draft:      { label: "Draft",      bg: "bg-amber-50  border-amber-200",   text: "text-amber-700",   dot: "bg-amber-400"   },
  submitted:  { label: "Submitted",  bg: "bg-blue-50   border-blue-200",    text: "text-blue-700",    dot: "bg-blue-500"    },
  approved:   { label: "Approved",   bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", dot: "bg-emerald-500" },
  rejected:   { label: "Rejected",   bg: "bg-red-50    border-red-200",     text: "text-red-700",     dot: "bg-red-500"     },
  cancelled:  { label: "Cancelled",  bg: "bg-slate-50  border-slate-200",   text: "text-slate-500",   dot: "bg-slate-400"   },
};

function StatusBadge({ status }: { status: EnterpriseFgCountStatus }) {
  const c = STATUS_CONFIG[status] ?? STATUS_CONFIG.draft;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${c.bg} ${c.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  );
}

function blankRows(items: SaleItem[], expectedMap: Record<string, number>): CountRow[] {
  return items.map(item => ({
    item,
    countInput:    "",
    saved:         false,
    saving:        false,
    error:         null,
    variance:      null,
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
  const countedByLabel = user?.name || user?.email || "Unknown user";

  // ── View state ────────────────────────────────────────────────────────────
  const [view,           setView]          = useState<PageView>("dashboard");
  const [activeSession,  setActiveSession] = useState<EnterpriseFgCountSession | null>(null);

  // ── Dashboard state ───────────────────────────────────────────────────────
  const [sessions,         setSessions]       = useState<EnterpriseFgCountSession[]>([]);
  const [dashLoading,      setDashLoading]    = useState(true);
  const [dashRefreshKey,   setDashRefreshKey] = useState(0);

  // ── Create Session modal ──────────────────────────────────────────────────
  const [createOpen,      setCreateOpen]     = useState(false);
  const [createLoading,   setCreateLoading]  = useState(false);
  const [createError,     setCreateError]    = useState<string | null>(null);
  const [createDate,      setCreateDate]     = useState(todayISO);
  const [createType,      setCreateType]     = useState<string>("Closing Count");
  const [createName,      setCreateName]     = useState("");
  const [createNotes,     setCreateNotes]    = useState("");
  // duplicate detection state
  const [dupDetected,     setDupDetected]    = useState(false);
  const [dupSessionId,    setDupSessionId]   = useState<string | null>(null);

  // ── Count-sheet state (detail view) ──────────────────────────────────────
  const [rows,            setRows]          = useState<CountRow[]>([]);
  const [sheetLoading,    setSheetLoading]  = useState(false);
  const [isSavingDraft,   setIsSavingDraft] = useState(false);
  const [isSubmitting,    setIsSubmitting]  = useState(false);
  const [search,          setSearch]        = useState("");
  const [filterCat,       setFilterCat]     = useState("All");
  const [latestCounts,    setLatestCounts]  = useState<Record<string, { lastCountDate: string | null; latestVariance: number }>>({});
  const [submitConfirm,   setSubmitConfirm] = useState(false);
  const [actionMsg,       setActionMsg]     = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [saleItems,       setSaleItems]     = useState<SaleItem[]>([]);
  const sessionIdRef = useRef<string>("");
  const inputRefs    = useRef<Record<string, HTMLInputElement | null>>({});

  // ── History drawer ────────────────────────────────────────────────────────
  const [isHistoryOpen,       setIsHistoryOpen]       = useState(false);
  const [historyRangePreset,  setHistoryRangePreset]  = useState<HistoryRangePreset>("7d");
  const [historyFromDate,     setHistoryFromDate]      = useState(() => addDaysISO(todayISO(), -6));
  const [historyToDate,       setHistoryToDate]        = useState(todayISO);
  const [historySessions,     setHistorySessions]      = useState<EnterpriseFgCountSession[]>([]);
  const [isHistoryLoading,    setIsHistoryLoading]     = useState(false);

  // ─── Dashboard load ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setDashLoading(true);
      try {
        const data = await loadEnterpriseFgCountSessions({ dateFrom: addDaysISO(todayISO(), -90) });
        if (!cancelled) setSessions(data);
      } finally {
        if (!cancelled) setDashLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [dashRefreshKey]);

  // ─── Dashboard summary cards ──────────────────────────────────────────────
  const draftCount    = sessions.filter(s => s.status === "draft").length;
  const pendingCount  = sessions.filter(s => s.status === "submitted").length;
  const thisMonth     = todayISO().slice(0, 7);
  const approvedMonth = sessions.filter(s => s.status === "approved" && s.businessDate?.startsWith(thisMonth)).length;
  const varianceMTD   = sessions
    .filter(s => s.status === "approved" && s.businessDate?.startsWith(thisMonth))
    .reduce((sum, s) => sum + s.varianceValue, 0);

  // ─── Create session modal helpers ─────────────────────────────────────────
  const openCreateModal = () => {
    const today = todayISO();
    setCreateDate(today);
    setCreateType("Closing Count");
    setCreateName(autoSessionName(today, "Closing Count"));
    setCreateNotes("");
    setCreateError(null);
    setDupDetected(false);
    setDupSessionId(null);
    setCreateOpen(true);
  };

  // Auto-update session name when date or type changes
  const handleCreateDateChange = (d: string) => {
    setCreateDate(d);
    setCreateName(autoSessionName(d, createType));
    setDupDetected(false);
  };
  const handleCreateTypeChange = (t: string) => {
    setCreateType(t);
    setCreateName(autoSessionName(createDate, t));
    setDupDetected(false);
  };

  const handleCreate = async (forceAdditional = false) => {
    if (!createName.trim()) { setCreateError("Session name is required."); return; }
    if (!createDate)        { setCreateError("Business date is required."); return; }
    setCreateLoading(true);
    setCreateError(null);
    try {
      const res = await createEnterpriseFgCountSession({
        locationId:       "LOC-HQ",
        businessDate:     createDate,
        sessionName:      createName.trim(),
        countType:        createType,
        notes:            createNotes.trim() || null,
        counterName:      countedByLabel,
        createAdditional: forceAdditional,
      });
      if (!res.success) {
        if (res.duplicate && res.existingSessionId) {
          setDupDetected(true);
          setDupSessionId(res.existingSessionId);
          setCreateError(res.message ?? `A ${createType} already exists for ${fmtDate(createDate)}.`);
          return;
        }
        setCreateError(res.message ?? "Failed to create session.");
        return;
      }
      setCreateOpen(false);
      setDashRefreshKey(k => k + 1);
      // Navigate directly to the new session
      if (res.sessionId) await openSessionById(res.sessionId);
    } finally {
      setCreateLoading(false);
    }
  };

  const openExistingFromDup = async () => {
    if (!dupSessionId) return;
    setCreateOpen(false);
    await openSessionById(dupSessionId);
  };

  // ─── Open a session detail view ───────────────────────────────────────────
  const openSessionById = async (sessionId: string) => {
    setSheetLoading(true);
    setView("detail");
    setSearch("");
    setFilterCat("All");
    setActionMsg(null);
    setSubmitConfirm(false);
    try {
      const [detail, items, counts, expectedMap] = await Promise.all([
        loadEnterpriseFgCountSessionById(sessionId),
        loadSaleItems(),
        loadLatestFgCounts(),
        calculateExpectedStockForDate(todayISO(), sessionId),
      ]);
      if (!detail) { setView("dashboard"); return; }
      setActiveSession(detail.session);
      sessionIdRef.current = detail.session.id;
      setSaleItems(items.filter(i => i.isActive));
      setLatestCounts(counts || {});

      // Build count rows — merge existing counts into blank rows
      const activeItems = items.filter(i => i.isActive);
      const lineByItem  = new Map<string, EnterpriseFgCountLine>(detail.lines.map(l => [l.itemId, l]));
      setRows(
        activeItems.map(item => {
          const line = lineByItem.get(item.id);
          const exp  = line?.expectedQty ?? expectedMap[item.id] ?? 0;
          if (line && line.physicalQtyEntered) {
            return { item, countInput: String(line.physicalQty), saved: true, saving: false, error: null, variance: line.varianceQty, expectedStock: exp };
          }
          return { item, countInput: "", saved: false, saving: false, error: null, variance: null, expectedStock: exp };
        })
      );
    } finally {
      setSheetLoading(false);
    }
  };

  // ─── Back to dashboard ────────────────────────────────────────────────────
  const goToDashboard = () => {
    setView("dashboard");
    setActiveSession(null);
    setRows([]);
    setActionMsg(null);
    setSubmitConfirm(false);
    setDashRefreshKey(k => k + 1);
  };

  // ─── Count sheet: input handling ──────────────────────────────────────────
  const handleInput = (itemId: string, val: string) => {
    setRows(prev => prev.map(r => {
      if (r.item.id !== itemId) return r;
      const num      = parseFloat(val);
      const variance = val !== "" && !isNaN(num) ? num - r.expectedStock : null;
      return { ...r, countInput: val, variance, saved: false, error: null };
    }));
  };

  const handleKeyDown = (e: React.KeyboardEvent, itemId: string) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const ids = visible.map(r => r.item.id);
    const idx = ids.indexOf(itemId);
    if (idx === -1) return;
    const row = rows.find(r => r.item.id === itemId);
    if (row && row.countInput !== "") saveRow(row);
    const nextId = ids[idx + 1];
    if (nextId) inputRefs.current[nextId]?.focus();
  };

  // ─── Save single row (atomic) ─────────────────────────────────────────────
  const saveRow = async (row: CountRow): Promise<boolean> => {
    if (!activeSession) return false;
    const date = activeSession.businessDate || activeSession.countDate;
    const num  = parseFloat(row.countInput);
    if (isNaN(num) || num < 0) {
      setRows(prev => prev.map(r => r.item.id === row.item.id ? { ...r, error: "Enter a valid number ≥ 0" } : r));
      return false;
    }
    setRows(prev => prev.map(r => r.item.id === row.item.id ? { ...r, saving: true, error: null } : r));

    const freshExpectedMap = await calculateExpectedStockForDate(date, sessionIdRef.current);
    const freshExpected    = freshExpectedMap[row.item.id] ?? 0;

    const res = await saveFgCountLineAtomic({
      sessionId:     sessionIdRef.current,
      countDate:     date,
      sessionName:   activeSession.sessionName ?? null,
      countedBy:     user?.id ?? null,
      countedByName: countedByLabel,
      itemId:        row.item.id,
      itemName:      row.item.name,
      unit:          row.item.baseUnit,
      physicalQty:   num,
      unitCost:      row.item.makingCost || 0,
    });

    if (!res.success) {
      setRows(prev => prev.map(r => r.item.id === row.item.id ? { ...r, saving: false, error: res.error?.message ?? "Save failed" } : r));
      return false;
    }
    setRows(prev => prev.map(r =>
      r.item.id === row.item.id
        ? { ...r, saving: false, saved: true, error: null, variance: res.variance ?? (num - freshExpected), expectedStock: res.expectedStock ?? freshExpected, item: { ...r.item, instock: num } }
        : r
    ));
    return true;
  };

  // ─── Save Draft ───────────────────────────────────────────────────────────
  const handleSaveDraft = async () => {
    if (!activeSession || activeSession.status === "approved") return;
    setIsSavingDraft(true);
    setActionMsg(null);

    // First flush all entered but unsaved rows via the atomic saver
    const unsaved = rows.filter(r => r.countInput !== "" && !r.saved && !r.saving);
    for (const row of unsaved) await saveRow(row);

    // Then call the draft RPC so session notes / metadata is updated
    const enteredRows = rows.filter(r => r.countInput !== "");
    const res = await saveEnterpriseFgCountDraft({
      sessionId: activeSession.id,
      notes:     activeSession.notes,
      lines:     enteredRows.map(r => ({ itemId: r.item.id, physicalQty: parseFloat(r.countInput) || 0, notes: null })),
    });

    setIsSavingDraft(false);
    if (res.success) {
      setActionMsg({ type: "success", text: "Draft saved successfully." });
      setTimeout(() => setActionMsg(null), 3000);
    } else {
      setActionMsg({ type: "error", text: res.message ?? "Save failed." });
    }
  };

  // ─── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!activeSession) return;
    setIsSubmitting(true);
    setActionMsg(null);

    // Flush unsaved rows first
    const unsaved = rows.filter(r => r.countInput !== "" && !r.saved && !r.saving);
    for (const row of unsaved) await saveRow(row);

    const res = await submitEnterpriseFgCountSession(activeSession.id);
    setIsSubmitting(false);
    setSubmitConfirm(false);

    if (res.success) {
      setActiveSession(prev => prev ? { ...prev, status: "submitted" } : prev);
      setActionMsg({ type: "success", text: "Count submitted for review." });
    } else {
      setActionMsg({ type: "error", text: res.message ?? "Submit failed." });
    }
  };

  // ─── Derived count-sheet state ────────────────────────────────────────────
  const categories = useMemo(() => ["All", ...Array.from(new Set(rows.map(r => r.item.category ?? "Uncategorised"))).sort()], [rows]);

  const visible = useMemo(() => rows.filter(r => {
    const matchSearch = !search || r.item.name.toLowerCase().includes(search.toLowerCase());
    const matchCat    = filterCat === "All" || (r.item.category ?? "Uncategorised") === filterCat;
    return matchSearch && matchCat;
  }), [rows, search, filterCat]);

  const enteredCount  = visible.filter(r => r.countInput !== "").length;
  const varianceItems = visible.filter(r => r.variance !== null && r.variance !== 0).length;
  const gainItems     = visible.filter(r => r.variance !== null && r.variance > 0).length;
  const lossItems     = visible.filter(r => r.variance !== null && r.variance < 0).length;

  const systemFgValue   = visible.reduce((s, r) => s + r.expectedStock * r.item.makingCost, 0);
  const physicalFgValue = visible.reduce((s, r) => {
    const num = parseFloat(r.countInput);
    return s + (r.countInput !== "" && !isNaN(num) ? num * r.item.makingCost : 0);
  }, 0);
  const varianceValue   = visible.reduce((s, r) => s + (r.variance !== null ? r.variance * r.item.makingCost : 0), 0);

  const isReadOnly = activeSession?.status === "approved" || activeSession?.status === "rejected" || activeSession?.status === "cancelled";

  // ─── History drawer ───────────────────────────────────────────────────────
  const resolveHistoryRange = useCallback((preset = historyRangePreset) => {
    const today = todayISO();
    if (preset === "today") return { from: today, to: today };
    if (preset === "30d")   return { from: addDaysISO(today, -29), to: today };
    if (preset === "custom") return { from: historyFromDate, to: historyToDate };
    return { from: addDaysISO(today, -6), to: today };
  }, [historyFromDate, historyRangePreset, historyToDate]);

  const loadHistoryRange = useCallback(async () => {
    setIsHistoryLoading(true);
    try {
      const { from, to } = resolveHistoryRange();
      const data = await loadEnterpriseFgCountSessions({ dateFrom: from, dateTo: to });
      setHistorySessions(data);
    } finally {
      setIsHistoryLoading(false);
    }
  }, [resolveHistoryRange]);

  useEffect(() => {
    if (!isHistoryOpen) return;
    loadHistoryRange();
  }, [historyRangePreset, historyFromDate, historyToDate, isHistoryOpen, loadHistoryRange]);

  const openHistory = () => { setIsHistoryOpen(true); };
  const openHistorySession = async (sessionId: string) => {
    setIsHistoryOpen(false);
    await openSessionById(sessionId);
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────

  // ─── DASHBOARD ────────────────────────────────────────────────────────────
  if (view === "dashboard") {
    return (
      <div className="-m-6 min-h-[calc(100vh-4rem)] bg-slate-50 p-4 text-slate-900 sm:p-6">
        <div className="mx-auto w-full max-w-screen-2xl space-y-6">

          {/* Page header */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-700">
                Finished Goods Control
              </p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-950">
                Finished Goods Counts
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                Track and manage daily, weekly and monthly finished goods counts.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={openHistory}
                className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
              >
                <History className="h-4 w-4" /> FG Count History
              </button>
              <button
                onClick={() => setDashRefreshKey(k => k + 1)}
                className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <button
                onClick={openCreateModal}
                className="flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700"
              >
                <Plus className="h-4 w-4" /> Start New FG Count
              </button>
            </div>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {[
              { label: "Draft Sessions",      value: draftCount,     color: "text-amber-700",   bg: "bg-amber-50  ring-amber-100",   icon: FileText   },
              { label: "Pending Review",       value: pendingCount,   color: "text-blue-700",    bg: "bg-blue-50   ring-blue-100",    icon: ClipboardCheck },
              { label: "Approved This Month",  value: approvedMonth,  color: "text-emerald-700", bg: "bg-emerald-50 ring-emerald-100", icon: CheckCircle2 },
              {
                label: "Variance MTD",
                value: varianceMTD >= 0 ? `+${$fmt(varianceMTD)}` : $fmt(varianceMTD),
                color: varianceMTD >= 0 ? "text-emerald-700" : "text-red-700",
                bg: "bg-slate-50 ring-slate-100",
                icon: varianceMTD >= 0 ? TrendingUp : TrendingDown,
              },
            ].map(s => (
              <div key={s.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">{s.label}</p>
                    <p className={`mt-3 text-2xl font-bold tracking-tight ${s.color}`}>{s.value}</p>
                  </div>
                  <div className={`rounded-xl p-2.5 ring-1 ${s.bg}`}>
                    <s.icon className={`h-4 w-4 ${s.color}`} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Sessions table */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-4">
              <h2 className="text-base font-semibold text-slate-900">Recent FG Count Sessions</h2>
              <p className="mt-0.5 text-xs text-slate-500">Click any row to open or continue a count.</p>
            </div>
            {dashLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin" /> Loading sessions…
              </div>
            ) : sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50">
                  <ClipboardCheck className="h-7 w-7 text-emerald-600" />
                </div>
                <p className="text-sm font-semibold text-slate-700">No FG count sessions yet</p>
                <p className="text-xs text-slate-400">Click <strong>Start New FG Count</strong> to create the first session.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-100 bg-slate-50">
                    <tr>
                      {["Session Name", "Business Date", "Location", "Count Type", "Status", "Variance", "Created By", "Approved By"].map(h => (
                        <th key={h} className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {sessions.map(s => (
                      <tr
                        key={s.id}
                        onClick={() => openSessionById(s.id)}
                        className="cursor-pointer transition-colors hover:bg-slate-50"
                      >
                        <td className="px-4 py-3">
                          <p className="font-semibold text-slate-950">{s.sessionName ?? "—"}</p>
                          <p className="mt-0.5 font-mono text-[10px] text-slate-400">{s.id}</p>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-700">{fmtDate(s.businessDate)}</td>
                        <td className="px-4 py-3 text-slate-600">{s.locationName ?? s.locationId}</td>
                        <td className="px-4 py-3 text-slate-600">{s.countType}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={s.status} />
                        </td>
                        <td className={`px-4 py-3 font-mono font-semibold tabular-nums text-sm ${s.varianceValue > 0 ? "text-emerald-700" : s.varianceValue < 0 ? "text-red-600" : "text-slate-400"}`}>
                          {s.status === "draft" ? (
                            <span className="text-xs font-normal italic text-slate-400">In Progress</span>
                          ) : (
                            <>{s.varianceValue > 0 ? "+" : ""}{$fmt(s.varianceValue)}</>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500">{s.countedByName ?? s.counterName ?? "—"}</td>
                        <td className="px-4 py-3 text-xs text-slate-500">{s.approvedByName ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ── Create Session Modal ─────────────────────────────────────────── */}
        {createOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
            <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl">
              {/* Modal header */}
              <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
                <div>
                  <h2 className="text-base font-bold text-slate-950">Create Finished Goods Count</h2>
                  <p className="mt-0.5 text-xs text-slate-500">Configure the new count session.</p>
                </div>
                <button
                  onClick={() => setCreateOpen(false)}
                  className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Modal body */}
              <div className="space-y-4 px-6 py-5">
                {createError && (
                  <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <span>{createError}</span>
                  </div>
                )}

                {/* Duplicate detected */}
                {dupDetected && (
                  <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 space-y-2">
                    <p className="font-semibold">An existing session was found for this date and count type.</p>
                    <div className="flex gap-2">
                      <button
                        onClick={openExistingFromDup}
                        className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                      >
                        Open Existing Count
                      </button>
                      <button
                        onClick={() => setCreateOpen(false)}
                        className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleCreate(true)}
                        disabled={createLoading}
                        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                      >
                        Create Additional Count
                      </button>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  {/* Business Date */}
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Business Date</label>
                    <input
                      type="date"
                      value={createDate}
                      onChange={e => handleCreateDateChange(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                    />
                  </div>
                  {/* Count Type */}
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Count Type</label>
                    <select
                      value={createType}
                      onChange={e => handleCreateTypeChange(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                    >
                      {COUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>

                {/* Session Name */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Session Name</label>
                  <input
                    type="text"
                    value={createName}
                    onChange={e => setCreateName(e.target.value)}
                    placeholder="Jul 18 Closing FG Count"
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>

                {/* Counter Name (read-only) */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Counter Name</label>
                  <input
                    type="text"
                    value={countedByLabel}
                    readOnly
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500"
                  />
                </div>

                {/* Notes */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Notes (optional)</label>
                  <textarea
                    rows={2}
                    value={createNotes}
                    onChange={e => setCreateNotes(e.target.value)}
                    placeholder="Add any notes about this count session…"
                    className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>
              </div>

              {/* Modal footer */}
              <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-6 py-4">
                <button
                  onClick={() => setCreateOpen(false)}
                  disabled={createLoading}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleCreate(false)}
                  disabled={createLoading || !createName.trim() || !createDate}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {createLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Create Count
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── History Drawer ───────────────────────────────────────────────── */}
        <Drawer
          isOpen={isHistoryOpen}
          onClose={() => setIsHistoryOpen(false)}
          title="FG Count History"
          description="Historical finished goods count sessions."
        >
          <HistoryDrawerContent
            sessions={historySessions}
            isLoading={isHistoryLoading}
            rangePreset={historyRangePreset}
            fromDate={historyFromDate}
            toDate={historyToDate}
            onPresetChange={setHistoryRangePreset}
            onFromChange={setHistoryFromDate}
            onToChange={setHistoryToDate}
            onRefresh={loadHistoryRange}
            onOpen={openHistorySession}
          />
        </Drawer>
      </div>
    );
  }

  // ─── DETAIL / COUNT SHEET ─────────────────────────────────────────────────
  return (
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-slate-50 p-4 text-slate-900 sm:p-6">
      <div className="mx-auto w-full max-w-screen-2xl space-y-6">

        {/* Back navigation */}
        <button
          onClick={goToDashboard}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-800 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to FG Count Dashboard
        </button>

        {sheetLoading ? (
          <div className="flex items-center justify-center gap-2 py-24 text-slate-400">
            <Loader2 className="h-6 w-6 animate-spin" /> Loading count sheet…
          </div>
        ) : (
          <>
            {/* Session identity header */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-sm">
                    <ClipboardCheck className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h1 className="text-xl font-bold text-slate-950">{activeSession?.sessionName ?? "FG Count"}</h1>
                      {activeSession && <StatusBadge status={activeSession.status} />}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                      <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" /> {fmtDate(activeSession?.businessDate)}</span>
                      <span className="flex items-center gap-1"><MapPin   className="h-3.5 w-3.5" /> {activeSession?.locationName ?? activeSession?.locationId ?? "—"}</span>
                      <span className="flex items-center gap-1"><Tag      className="h-3.5 w-3.5" /> {activeSession?.countType}</span>
                      <span className="flex items-center gap-1"><User     className="h-3.5 w-3.5" /> {activeSession?.countedByName ?? activeSession?.counterName ?? countedByLabel}</span>
                    </div>
                  </div>
                </div>

                {/* Top actions */}
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={openHistory} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
                    <History className="h-4 w-4" /> FG Count History
                  </button>
                  <button onClick={() => openSessionById(activeSession!.id)} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
                    <RefreshCw className="h-4 w-4" /> Refresh
                  </button>
                  {!isReadOnly && activeSession?.status !== "submitted" && (
                    <button
                      onClick={handleSaveDraft}
                      disabled={isSavingDraft}
                      className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
                    >
                      {isSavingDraft ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      Save Draft
                    </button>
                  )}
                  {!isReadOnly && activeSession?.status !== "submitted" && (
                    <button
                      onClick={() => setSubmitConfirm(true)}
                      disabled={isSubmitting || enteredCount === 0}
                      className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      Submit
                    </button>
                  )}
                  {activeSession?.status === "submitted" && (
                    <div className="flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700">
                      <Info className="h-3.5 w-3.5" /> Submitted — awaiting approval
                    </div>
                  )}
                  {isReadOnly && (
                    <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Read Only
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Action message */}
            {actionMsg && (
              <div className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium ${actionMsg.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>
                {actionMsg.type === "success" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                {actionMsg.text}
              </div>
            )}

            {/* Summary cards */}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {[
                { label: "Items Entered",   value: enteredCount,  color: "text-blue-700",    bg: "bg-blue-50   ring-blue-100",    icon: ClipboardCheck },
                { label: "Variances Found", value: varianceItems, color: "text-slate-950",   bg: "bg-amber-50  ring-amber-100",   icon: AlertTriangle  },
                { label: "Count Gains",     value: gainItems,     color: "text-emerald-700", bg: "bg-emerald-50 ring-emerald-100", icon: TrendingUp     },
                { label: "Count Losses",    value: lossItems,     color: "text-red-700",     bg: "bg-red-50    ring-red-100",     icon: TrendingDown   },
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

            {/* Value cards */}
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
              <div className={`rounded-2xl border p-4 shadow-sm ${varianceValue === 0 || enteredCount === 0 ? "border-slate-200 bg-white" : varianceValue > 0 ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Variance Value</p>
                <p className={`mt-2 text-2xl font-semibold tabular-nums ${enteredCount === 0 || varianceValue === 0 ? "text-slate-400" : varianceValue > 0 ? "text-emerald-700" : "text-red-700"}`}>
                  {enteredCount > 0 ? <>{varianceValue > 0 ? "+" : ""}{$fmt(varianceValue)}</> : "—"}
                </p>
                <p className="mt-1 text-[10px] text-slate-400">Σ (variance qty × making cost)</p>
              </div>
            </div>

            {/* Filters */}
            <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
              <CardContent className="flex flex-wrap items-center gap-3 px-4 py-3">
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
                <p className="hidden text-xs italic text-slate-400 sm:block">
                  Tip: press <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 font-mono text-[10px] text-slate-600">Enter</kbd> to save and move to the next row
                </p>
              </CardContent>
            </Card>

            {/* Count table */}
            <Card className="overflow-hidden rounded-2xl border-slate-200 bg-white shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50">
                    <tr>
                      {["Finished Good", "Expected Stock", "Physical Count", "Variance", "Last Count Date"].map(h => (
                        <th key={h} className="whitespace-nowrap px-4 py-3 text-left text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {visible.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-500">No items match your filters.</td>
                      </tr>
                    ) : visible.map(row => {
                      const vLabel = varianceLabel(row.variance);
                      return (
                        <tr key={row.item.id} className={`transition-colors ${row.saved ? "bg-emerald-50" : row.error ? "bg-red-50" : "hover:bg-slate-50"}`}>
                          {/* Finished Good */}
                          <td className="px-4 py-2.5">
                            <p className="font-semibold leading-tight text-slate-950">{row.item.name}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-[10px] text-slate-400">{row.item.id}</span>
                              {row.item.category && (
                                <span className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-600">{row.item.category}</span>
                              )}
                              {row.item.makingCost > 0 && (
                                <span className="font-mono text-[9px] text-slate-400">({$fmt(row.item.makingCost)}/{row.item.baseUnit})</span>
                              )}
                            </div>
                          </td>
                          {/* Expected Stock */}
                          <td className="px-4 py-2.5">
                            <span className="font-mono font-semibold tabular-nums text-slate-800">{fmt(row.expectedStock)}</span>
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
                                disabled={row.saving || isReadOnly}
                                className={`w-24 rounded-lg border px-2.5 py-1.5 text-sm font-medium tabular-nums transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 ${row.error ? "border-red-200 bg-red-50 text-red-700" : row.saved ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-900"}`}
                              />
                              {row.countInput !== "" && !row.saved && !isReadOnly && (
                                <button
                                  onClick={() => saveRow(row)}
                                  disabled={row.saving}
                                  className="rounded-lg bg-blue-50 p-1.5 text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-50"
                                  title="Save this row"
                                >
                                  {row.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
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
                            {row.error && <p className="mt-0.5 text-[10px] text-red-600">{row.error}</p>}
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
                              ? new Date(latestCounts[row.item.id].lastCountDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                              : "Never"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>

      {/* Submit confirmation modal */}
      {submitConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100">
                <Send className="h-5 w-5 text-emerald-700" />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-950">Submit Count for Review</h2>
                <p className="text-xs text-slate-500">This will move the session to Submitted status. No inventory changes yet.</p>
              </div>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-sm text-slate-700 space-y-1">
              <p><span className="font-semibold">Session:</span> {activeSession?.sessionName}</p>
              <p><span className="font-semibold">Items entered:</span> {enteredCount} of {visible.length}</p>
              <p><span className="font-semibold">Variance:</span> {varianceValue > 0 ? "+" : ""}{$fmt(varianceValue)}</p>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setSubmitConfirm(false)} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Confirm Submit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History Drawer (detail view) */}
      <Drawer
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        title="FG Count History"
        description="Historical finished goods count sessions."
      >
        <HistoryDrawerContent
          sessions={historySessions}
          isLoading={isHistoryLoading}
          rangePreset={historyRangePreset}
          fromDate={historyFromDate}
          toDate={historyToDate}
          onPresetChange={setHistoryRangePreset}
          onFromChange={setHistoryFromDate}
          onToChange={setHistoryToDate}
          onRefresh={loadHistoryRange}
          onOpen={openHistorySession}
        />
      </Drawer>
    </div>
  );
}

// ─── History Drawer Content (shared between Dashboard and Detail) ─────────────

function HistoryDrawerContent({
  sessions,
  isLoading,
  rangePreset,
  fromDate,
  toDate,
  onPresetChange,
  onFromChange,
  onToChange,
  onRefresh,
  onOpen,
}: {
  sessions:        EnterpriseFgCountSession[];
  isLoading:       boolean;
  rangePreset:     HistoryRangePreset;
  fromDate:        string;
  toDate:          string;
  onPresetChange:  (p: HistoryRangePreset) => void;
  onFromChange:    (d: string) => void;
  onToChange:      (d: string) => void;
  onRefresh:       () => void;
  onOpen:          (sessionId: string) => void;
}) {
  return (
    <div className="space-y-3">
      {/* Filter controls */}
      <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="min-w-[180px]">
            <label className="text-[10px] uppercase tracking-wider font-bold text-neutral-500 block mb-1">Date Filter</label>
            <select
              value={rangePreset}
              onChange={e => onPresetChange(e.target.value as HistoryRangePreset)}
              className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
            >
              <option value="today">Today</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
              <option value="custom">Custom Range</option>
            </select>
          </div>
          {rangePreset === "custom" && (
            <>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-bold text-neutral-500 block mb-1">From</label>
                <input type="date" value={fromDate} onChange={e => onFromChange(e.target.value)} className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider font-bold text-neutral-500 block mb-1">To</label>
                <input type="date" value={toDate} onChange={e => onToChange(e.target.value)} className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1" />
              </div>
            </>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="px-3 py-2 text-sm font-semibold bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
      </div>

      {/* Sessions list */}
      {isLoading ? (
        <div className="flex items-center justify-center p-10 text-neutral-400 gap-2">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading count history…
        </div>
      ) : sessions.length === 0 ? (
        <div className="bg-white border border-neutral-200 rounded-xl p-8 text-center text-sm text-neutral-400">
          No FG count sessions found in this date range.
        </div>
      ) : (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Date", "Session Name", "Type", "Status", "Counted By", "Variance"].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {sessions.map(s => (
                <tr
                  key={s.id}
                  onClick={() => onOpen(s.id)}
                  className="hover:bg-neutral-50 cursor-pointer"
                  title="Open this count session"
                >
                  <td className="px-3 py-3 font-medium text-neutral-900 whitespace-nowrap">{fmtDate(s.businessDate)}</td>
                  <td className="px-3 py-3 text-neutral-700">
                    <p className="font-medium">{s.sessionName ?? "—"}</p>
                    <p className="text-[10px] font-mono text-neutral-400">{s.id}</p>
                  </td>
                  <td className="px-3 py-3 text-neutral-500 text-xs">{s.countType}</td>
                  <td className="px-3 py-3"><StatusBadge status={s.status} /></td>
                  <td className="px-3 py-3 text-neutral-500 text-xs">{s.countedByName ?? s.counterName ?? "—"}</td>
                  <td className={`px-3 py-3 font-mono tabular-nums font-semibold text-xs ${s.varianceValue > 0 ? "text-green-700" : s.varianceValue < 0 ? "text-red-600" : "text-neutral-400"}`}>
                    {s.status === "draft" ? <span className="text-xs italic text-neutral-400">In Progress</span> : <>{s.varianceValue > 0 ? "+" : ""}{$fmt(s.varianceValue)}</>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
