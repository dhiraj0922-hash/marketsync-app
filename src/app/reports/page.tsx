"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { loadLocations } from "@/lib/storage";
import {
  getCogsReport,
  getInventoryMovementReport,
  getFulfillmentProfitReport,
  deriveMarginInsights,
  isLabourItem,
  type CogsReport,
  type MovementReport,
  type ProfitReport,
  type MarginInsights,
  type ReportBucket,
} from "@/lib/reports";
import {
  TrendingDown, TrendingUp, ArrowLeftRight, AlertTriangle,
  BarChart3, Loader2, RefreshCw, ChevronDown, Filter, DollarSign,
  HardHat, Clock,
} from "lucide-react";

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
const $   = (n: number) => `$${fmt(n)}`;
const qty = (n: number) => fmt(n, Number.isInteger(n) ? 0 : 2);

const today       = new Date().toISOString().split("T")[0];
const defaultFrom = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split("T")[0];
})();

const BUCKET_LABELS: Record<string, string> = {
  purchase_in:    "Purchases",
  production_in:  "Production In",
  transfer_in:    "Transfer In",
  transfer_out:   "Transfer Out",
  cogs:           "Consumption / COGS",
  waste:          "Waste / Spoilage",
  variance_gain:  "Count Variance +",
  variance_loss:  "Count Variance −",
  adjustment_in:  "Adjustment In",
  adjustment_out: "Adjustment Out",
  return_out:     "Return Out",
  other:          "Other",
};

const BUCKET_COLORS: Record<string, string> = {
  purchase_in:    "bg-blue-50 text-blue-700 border-blue-200",
  production_in:  "bg-indigo-50 text-indigo-700 border-indigo-200",
  transfer_in:    "bg-teal-50 text-teal-700 border-teal-200",
  transfer_out:   "bg-orange-50 text-orange-700 border-orange-200",
  cogs:           "bg-red-50 text-red-700 border-red-200",
  waste:          "bg-yellow-50 text-yellow-700 border-yellow-200",
  variance_gain:  "bg-green-50 text-green-700 border-green-200",
  variance_loss:  "bg-rose-50 text-rose-700 border-rose-200",
  adjustment_in:  "bg-purple-50 text-purple-700 border-purple-200",
  adjustment_out: "bg-pink-50 text-pink-700 border-pink-200",
  return_out:     "bg-amber-50 text-amber-700 border-amber-200",
  other:          "bg-neutral-100 text-neutral-600 border-neutral-200",
};

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function ReportsPage() {
  return (
    <HQOnlyGuard>
      <ReportsContent />
    </HQOnlyGuard>
  );
}

type Tab = "cogs" | "movement" | "profit" | "labour";

function ReportsContent() {
  const [tab, setTab]               = useState<Tab>("cogs");
  const [locations, setLocations]   = useState<any[]>([]);
  const [locationId, setLocationId] = useState("");
  const [dateFrom, setDateFrom]     = useState(defaultFrom);
  const [dateTo, setDateTo]         = useState(today);
  const [movBucket, setMovBucket]   = useState<ReportBucket | "">("");

  const [cogsReport,    setCogsReport]    = useState<CogsReport    | null>(null);
  const [movReport,     setMovReport]     = useState<MovementReport | null>(null);
  const [profitReport,  setProfitReport]  = useState<ProfitReport  | null>(null);
  const [labourReport,  setLabourReport]  = useState<MovementReport | null>(null);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState<string | null>(null);

  useEffect(() => {
    loadLocations().then(locs => setLocations(Array.isArray(locs) ? locs : []));
  }, []);

  const runReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    const f = { locationId: locationId || null, dateFrom, dateTo };

    if (tab === "cogs") {
      const { data, error: e } = await getCogsReport(f);
      if (e) setError(e); else setCogsReport(data);
    } else if (tab === "movement") {
      const { data, error: e } = await getInventoryMovementReport({
        ...f,
        bucket: (movBucket as ReportBucket) || null,
      });
      if (e) setError(e); else setMovReport(data);
    } else if (tab === "labour") {
      // Fetch the full movement ledger (no bucket filter — production_consumption
      // maps to the 'cogs' bucket but we want to be sure we catch all rows),
      // then filter client-side to labour items only.
      const { data, error: e } = await getInventoryMovementReport({ ...f, bucket: null });
      if (e) {
        setError(e);
      } else if (data) {
        const labourRows = data.rows.filter(
          r => r.movement_type === "production_consumption" && isLabourItem(r.item_name)
        );
        let totalInValue  = 0;
        let totalOutValue = 0;
        const byBucket: Partial<Record<ReportBucket, number>> = {};
        for (const r of labourRows) {
          if (r.signed_cost >= 0) totalInValue  += r.signed_cost;
          else                    totalOutValue += Math.abs(r.signed_cost);
          byBucket[r.report_bucket] = (byBucket[r.report_bucket] ?? 0) + Math.abs(r.total_cost);
        }
        setLabourReport({
          rows: labourRows,
          totalInValue,
          totalOutValue,
          totalNetValue: totalInValue - totalOutValue,
          byBucket,
        });
      }
    } else {
      const { data, error: e } = await getFulfillmentProfitReport(f);
      if (e) setError(e); else setProfitReport(data);
    }
    setLoading(false);
  }, [tab, locationId, dateFrom, dateTo, movBucket]);

  // Auto-run on tab switch when no data yet
  useEffect(() => { runReport(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const locName = (id: string | null) => {
    if (!id) return "—";
    return locations.find(l => l.id === id)?.name ?? id;
  };

  const empty =
    (tab === "cogs"     && cogsReport    && cogsReport.rows.length    === 0) ||
    (tab === "movement" && movReport     && movReport.rows.length     === 0) ||
    (tab === "profit"   && profitReport  && profitReport.rows.length  === 0) ||
    (tab === "labour"   && labourReport  && labourReport.rows.length  === 0);

  return (
    <div className="space-y-6">
      {/* ── Header */}
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Reports</h2>
        <p className="text-neutral-500 text-sm mt-0.5">COGS · Movement Ledger</p>
      </div>

      {/* ── Tabs */}
      <div className="flex gap-1 bg-neutral-100 p-1 rounded-xl w-fit">
        {(["cogs", "movement", "profit", "labour"] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
              tab === t ? "bg-white text-brand-700 shadow-sm" : "text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {t === "cogs" ? "COGS" : t === "movement" ? "Movement Ledger" : t === "profit" ? "Profit" : "Labour"}
          </button>
        ))}
      </div>

      {/* ── Filters */}
      <Card className="shadow-sm">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-end gap-4">
            {/* Location */}
            <div className="space-y-1 min-w-[180px]">
              <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider flex items-center gap-1">
                <Filter className="h-3 w-3" /> Location
              </label>
              <div className="relative">
                <select
                  value={locationId}
                  onChange={e => setLocationId(e.target.value)}
                  className="w-full appearance-none pl-3 pr-8 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                >
                  <option value="">All Locations</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-400 pointer-events-none" />
              </div>
            </div>

            {/* Date From */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">From</label>
              <input
                type="date" value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="pl-3 pr-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-400"
              />
            </div>

            {/* Date To */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">To</label>
              <input
                type="date" value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="pl-3 pr-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-400"
              />
            </div>

            {/* Bucket (movement only) */}
            {tab === "movement" && (
              <div className="space-y-1 min-w-[200px]">
                <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Bucket</label>
                <div className="relative">
                  <select
                    value={movBucket}
                    onChange={e => setMovBucket(e.target.value as ReportBucket | "")}
                    className="w-full appearance-none pl-3 pr-8 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                  >
                    <option value="">All buckets</option>
                    {Object.entries(BUCKET_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-400 pointer-events-none" />
                </div>
              </div>
            )}

            {/* Run */}
            <button
              onClick={runReport}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors shadow-sm"
            >
              {loading
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</>
                : <><RefreshCw className="h-4 w-4" /> Run Report</>}
            </button>
          </div>
        </CardContent>
      </Card>

      {/* ── Error */}
      {error && (
        <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ── Loading skeleton */}
      {loading && (
        <div className="grid grid-cols-3 gap-4">
          {[0, 1, 2].map(i => (
            <div key={i} className="h-24 bg-neutral-100 animate-pulse rounded-xl" />
          ))}
        </div>
      )}

      {/* ── COGS tab */}
      {!loading && tab === "cogs" && cogsReport && cogsReport.rows.length > 0 && (
        <CogsView report={cogsReport} locName={locName} />
      )}

      {/* ── Movement tab */}
      {!loading && tab === "movement" && movReport && movReport.rows.length > 0 && (
        <MovementView report={movReport} locName={locName} />
      )}

      {/* ── Profit tab */}
      {!loading && tab === "profit" && profitReport && profitReport.rows.length > 0 && (
        <ProfitView report={profitReport} locName={locName} />
      )}

      {/* ── Labour tab */}
      {!loading && tab === "labour" && labourReport && labourReport.rows.length > 0 && (
        <LabourView report={labourReport} locName={locName} />
      )}

      {/* ── Empty state */}
      {!loading && !error && empty && (
        <div className="py-16 text-center text-neutral-400 text-sm">
          <BarChart3 className="h-10 w-10 mx-auto mb-3 opacity-30" />
          No data for the selected filters and date range.
        </div>
      )}
    </div>
  );
}

// ─── COGS view ──────────────────────────────────────────────────────────────────

function CogsView({ report, locName }: { report: CogsReport; locName: (id: string | null) => string }) {
  return (
    <div className="space-y-4">
      {/* 3-card split: Ingredient / Labour / Total */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard icon={<TrendingDown className="h-5 w-5 text-orange-500" />}
          label="Ingredient Cost" value={$(report.ingredientCogs)}
          sub={`${report.rows.filter(r => !r.is_labour).length} ingredient lines`} accent="red" />
        <SummaryCard icon={<TrendingDown className="h-5 w-5 text-violet-500" />}
          label="Labour Cost" value={$(report.labourCogs)}
          sub={report.labourCogs > 0 ? `${report.rows.filter(r => r.is_labour).length} labour lines` : "no labour rows yet"}
          accent={report.labourCogs > 0 ? "neutral" : "neutral"} />
        <SummaryCard icon={<BarChart3 className="h-5 w-5 text-red-600" />}
          label="Total COGS" value={$(report.totalCogs)} sub={`${report.rows.length} total lines`} accent="red" />
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <p className="text-sm font-semibold text-neutral-700">COGS Detail — by Day · Item</p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Date", "Location", "Item", "Type", "Qty", "COGS Value"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {report.rows.map((r, i) => (
                <tr key={i} className="hover:bg-neutral-50/50">
                  <td className="px-4 py-2.5 font-mono text-xs text-neutral-700">{r.movement_date}</td>
                  <td className="px-4 py-2.5 text-neutral-600">{locName(r.location_id)}</td>
                  <td className="px-4 py-2.5 font-medium text-neutral-900">{r.item_name ?? r.item_id ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    {r.is_labour ? (
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border bg-violet-50 text-violet-700 border-violet-200">Labour</span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border bg-orange-50 text-orange-700 border-orange-200">Ingredient</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-700">{qty(r.total_qty)}</td>
                  <td className="px-4 py-2.5 tabular-nums font-semibold text-red-700">{$(r.cogs_value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-neutral-50 border-t border-neutral-200">
              <tr>
                <td colSpan={5} className="px-4 py-2.5 text-xs font-bold text-neutral-600 uppercase tracking-wider">Total</td>
                <td className="px-4 py-2.5 font-bold text-red-700 tabular-nums">{$(report.totalCogs)}</td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Movement view ──────────────────────────────────────────────────────────────────

function MovementView({ report, locName }: { report: MovementReport; locName: (id: string | null) => string }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SummaryCard icon={<TrendingUp className="h-5 w-5 text-green-600" />}
          label="Total In" value={$(report.totalInValue)} sub="inbound value" accent="green" />
        <SummaryCard icon={<TrendingDown className="h-5 w-5 text-red-500" />}
          label="Total Out" value={$(report.totalOutValue)} sub="outbound value" accent="red" />
        <SummaryCard icon={<ArrowLeftRight className="h-5 w-5 text-brand-500" />}
          label="Net Movement" value={$(report.totalNetValue)}
          sub={report.totalNetValue >= 0 ? "net gain" : "net loss"}
          accent={report.totalNetValue >= 0 ? "green" : "red"} />
        <SummaryCard icon={<BarChart3 className="h-5 w-5 text-neutral-500" />}
          label="Transactions" value={String(report.rows.length)} sub="movement rows" accent="neutral" />
      </div>

      {/* Bucket roll-up chips */}
      {Object.keys(report.byBucket).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(report.byBucket).map(([bucket, val]) => (
            <span key={bucket} className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full border ${BUCKET_COLORS[bucket] ?? BUCKET_COLORS.other}`}>
              {BUCKET_LABELS[bucket] ?? bucket}
              <span className="opacity-70">·</span>
              {$(val as number)}
            </span>
          ))}
        </div>
      )}

      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <p className="text-sm font-semibold text-neutral-700">Movement Ledger</p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Date", "Location", "Item", "Type", "Bucket", "Qty", "Unit Cost", "Net Value", "Ref"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {report.rows.map(r => (
                <tr key={r.id} className="hover:bg-neutral-50/50">
                  <td className="px-4 py-2.5 font-mono text-xs text-neutral-700 whitespace-nowrap">{r.movement_date}</td>
                  <td className="px-4 py-2.5 text-neutral-600 whitespace-nowrap">{locName(r.location_id)}</td>
                  <td className="px-4 py-2.5 font-medium text-neutral-900">{r.item_name ?? r.item_id ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-[10px] bg-neutral-100 border border-neutral-200 text-neutral-600 px-1.5 py-0.5 rounded">
                      {r.movement_type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${BUCKET_COLORS[r.report_bucket] ?? BUCKET_COLORS.other}`}>
                      {BUCKET_LABELS[r.report_bucket] ?? r.report_bucket}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-700">{qty(r.quantity)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-500">{$(r.unit_cost)}</td>
                  <td className={`px-4 py-2.5 tabular-nums font-semibold ${r.signed_cost >= 0 ? "text-green-700" : "text-red-700"}`}>
                    {r.signed_cost >= 0 ? "+" : ""}{$(r.signed_cost)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-neutral-400 font-mono">
                    {r.reference_type ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Profit view ──────────────────────────────────────────────────────────────

function ProfitView({ report, locName }: { report: ProfitReport; locName: (id: string | null) => string }) {
  const avgDisplay = report.avgMarginPct != null
    ? `${fmt(report.avgMarginPct)}%`
    : "—";

  // Derive top / worst items from already-fetched rows — no extra RPC
  const insights: MarginInsights = deriveMarginInsights(report);

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SummaryCard
          icon={<DollarSign className="h-5 w-5 text-green-600" />}
          label="Total Revenue"
          value={$(report.totalRevenue)}
          sub={`${report.rows.length} fulfillment lines`}
          accent="green" />
        <SummaryCard
          icon={<TrendingDown className="h-5 w-5 text-red-500" />}
          label="Total Making Cost"
          value={$(report.totalCogs)}
          sub="incl. labour in recipe cost"
          accent="red" />
        <SummaryCard
          icon={<TrendingUp className="h-5 w-5 text-brand-500" />}
          label="Gross Profit"
          value={$(report.totalProfit)}
          sub={report.totalProfit >= 0 ? "net gain" : "net loss"}
          accent={report.totalProfit >= 0 ? "green" : "red"} />
        <SummaryCard
          icon={<BarChart3 className="h-5 w-5 text-neutral-500" />}
          label="Avg Margin"
          value={avgDisplay}
          sub="weighted by revenue"
          accent="neutral" />
      </div>

      {/* Top & Worst margin items — shown only when enough distinct items exist */}
      {(insights.top.length > 0 || insights.worst.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

          {/* Top margin items */}
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <p className="text-sm font-semibold text-neutral-700 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-green-600" />
                Top Margin Items
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-neutral-50">
                {insights.top.map((item, i) => (
                  <li key={item.item_name} className="flex items-center justify-between px-4 py-2.5 hover:bg-neutral-50/50">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-bold text-neutral-400 w-4 shrink-0">{i + 1}</span>
                      <span className="text-sm font-medium text-neutral-900 truncate">{item.item_name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-xs tabular-nums text-neutral-500">{$(item.total_profit)}</span>
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${
                        (item.margin_pct ?? 0) >= 20
                          ? "bg-green-50 text-green-700 border-green-200"
                          : "bg-yellow-50 text-yellow-700 border-yellow-200"
                      }`}>
                        {item.margin_pct != null ? `${fmt(item.margin_pct)}%` : "—"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {/* Worst margin items */}
          <Card className="shadow-sm">
            <CardHeader className="pb-2">
              <p className="text-sm font-semibold text-neutral-700 flex items-center gap-2">
                <TrendingDown className="h-4 w-4 text-red-500" />
                Worst Margin Items
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-neutral-50">
                {insights.worst.map((item, i) => (
                  <li key={item.item_name} className="flex items-center justify-between px-4 py-2.5 hover:bg-neutral-50/50">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-bold text-neutral-400 w-4 shrink-0">{i + 1}</span>
                      <span className="text-sm font-medium text-neutral-900 truncate">{item.item_name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-xs tabular-nums text-neutral-500">{$(item.total_profit)}</span>
                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${
                        (item.margin_pct ?? 0) < 0
                          ? "bg-red-50 text-red-700 border-red-200"
                          : "bg-yellow-50 text-yellow-700 border-yellow-200"
                      }`}>
                        {item.margin_pct != null ? `${fmt(item.margin_pct)}%` : "—"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

        </div>
      )}

      {/* Detail table */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <p className="text-sm font-semibold text-neutral-700">Profit Detail — Fulfilled Requisitions</p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Date", "Location", "Item", "Qty", "Unit Price", "Revenue", "COGS", "Profit", "Margin %"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {report.rows.map((r, i) => {
                const isPos = r.profit >= 0;
                return (
                  <tr key={i} className="hover:bg-neutral-50/50">
                    <td className="px-4 py-2.5 font-mono text-xs text-neutral-700 whitespace-nowrap">{r.movement_date}</td>
                    <td className="px-4 py-2.5 text-neutral-600 whitespace-nowrap">{locName(r.location_id)}</td>
                    <td className="px-4 py-2.5 font-medium text-neutral-900">{r.item_name ?? "—"}</td>
                    <td className="px-4 py-2.5 tabular-nums text-neutral-700">{qty(r.qty)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-neutral-500">{$(r.unit_price)}</td>
                    <td className="px-4 py-2.5 tabular-nums font-semibold text-green-700">{$(r.revenue)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-red-600">{$(r.cogs)}</td>
                    <td className={`px-4 py-2.5 tabular-nums font-semibold ${isPos ? "text-green-700" : "text-red-700"}`}>
                      {isPos ? "+" : ""}{$(r.profit)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">
                      {r.margin_pct != null ? (
                        <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${
                          r.margin_pct >= 20
                            ? "bg-green-50 text-green-700 border-green-200"
                            : r.margin_pct >= 0
                            ? "bg-yellow-50 text-yellow-700 border-yellow-200"
                            : "bg-red-50 text-red-700 border-red-200"
                        }`}>
                          {fmt(r.margin_pct)}%
                        </span>
                      ) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-neutral-50 border-t border-neutral-200">
              <tr>
                <td colSpan={5} className="px-4 py-2.5 text-xs font-bold text-neutral-600 uppercase tracking-wider">Total</td>
                <td className="px-4 py-2.5 font-bold text-green-700 tabular-nums">{$(report.totalRevenue)}</td>
                <td className="px-4 py-2.5 font-bold text-red-600 tabular-nums">{$(report.totalCogs)}</td>
                <td className={`px-4 py-2.5 font-bold tabular-nums ${report.totalProfit >= 0 ? "text-green-700" : "text-red-700"}`}>
                  {report.totalProfit >= 0 ? "+" : ""}{$(report.totalProfit)}
                </td>
                <td className="px-4 py-2.5 font-bold text-neutral-700 tabular-nums">
                  {report.avgMarginPct != null ? `${fmt(report.avgMarginPct)}%` : "—"}
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Labour view ─────────────────────────────────────────────────────────────
// Shows only production_consumption rows for labour items (LABOUR/LABOR in name).
// Does NOT modify COGS/profit math — purely a visibility layer over existing data.

function LabourView({ report, locName }: { report: MovementReport; locName: (id: string | null) => string }) {
  const totalLabourCost = report.rows.reduce((s, r) => s + Math.abs(r.total_cost), 0);
  const totalLabourQty  = report.rows.reduce((s, r) => s + r.quantity, 0);
  const avgRate         = totalLabourQty > 0 ? totalLabourCost / totalLabourQty : 0;

  return (
    <div className="space-y-4">
      {/* ── Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard
          icon={<HardHat className="h-5 w-5 text-violet-500" />}
          label="Total Labour Cost"
          value={`$${totalLabourCost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          sub={`${report.rows.length} labour movement${report.rows.length !== 1 ? "s" : ""}`}
          accent="neutral" />
        <SummaryCard
          icon={<Clock className="h-5 w-5 text-violet-400" />}
          label="Total Labour Hours / Units"
          value={totalLabourQty.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
          sub="sum of logged quantities"
          accent="neutral" />
        <SummaryCard
          icon={<TrendingUp className="h-5 w-5 text-violet-600" />}
          label="Avg Labour Rate"
          value={`$${avgRate.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / unit`}
          sub="total cost ÷ total qty"
          accent="neutral" />
      </div>

      {/* ── Detail table */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <HardHat className="h-4 w-4 text-violet-500" />
            <p className="text-sm font-semibold text-neutral-700">Labour Detail — Production Consumption</p>
          </div>
          <p className="text-xs text-neutral-400 mt-0.5">
            Rows filtered to <span className="font-mono">movement_type = 'production_consumption'</span> where item name contains LABOUR / LABOR.
            Existing COGS and profit figures are unchanged.
          </p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Date", "Location", "Labour Item", "Qty / Hrs", "Unit Rate", "Total Cost", "Production Ref", "Notes"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {report.rows.map(r => (
                <tr key={r.id} className="hover:bg-violet-50/30">
                  <td className="px-4 py-2.5 font-mono text-xs text-neutral-700 whitespace-nowrap">{r.movement_date}</td>
                  <td className="px-4 py-2.5 text-neutral-600 whitespace-nowrap">{locName(r.location_id)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border bg-violet-50 text-violet-700 border-violet-200">Labour</span>
                      <span className="font-medium text-neutral-900">{r.item_name ?? r.item_id ?? "—"}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-700">
                    {r.quantity.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-500">
                    ${r.unit_cost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums font-semibold text-violet-700">
                    ${Math.abs(r.total_cost).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-neutral-400 font-mono whitespace-nowrap">
                    {r.reference_id ?? r.reference_type ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-neutral-500 max-w-[200px] truncate" title={r.notes ?? ""}>
                    {r.notes ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-neutral-50 border-t border-neutral-200">
              <tr>
                <td colSpan={5} className="px-4 py-2.5 text-xs font-bold text-neutral-600 uppercase tracking-wider">Total</td>
                <td className="px-4 py-2.5 font-bold text-violet-700 tabular-nums">
                  ${totalLabourCost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Shared ───────────────────────────────────────────────────────────────────

function SummaryCard({
  icon, label, value, sub, accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent: "brand" | "green" | "red" | "neutral";
}) {
  const bg: Record<string, string> = {
    brand:   "bg-brand-50 border-brand-100",
    green:   "bg-green-50 border-green-100",
    red:     "bg-red-50   border-red-100",
    neutral: "bg-neutral-50 border-neutral-100",
  };
  return (
    <div className={`rounded-xl border p-4 ${bg[accent] ?? bg.neutral}`}>
      <div className="flex items-center gap-2 mb-2">{icon}<span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">{label}</span></div>
      <p className="text-2xl font-bold text-neutral-900 tabular-nums">{value}</p>
      <p className="text-xs text-neutral-500 mt-0.5">{sub}</p>
    </div>
  );
}
