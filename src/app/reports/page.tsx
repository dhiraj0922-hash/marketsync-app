"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { loadLocations } from "@/lib/storage";
import {
  getCogsReport, getInventoryMovementReport, getInventoryVarianceReport,
  type CogsRow, type MovementRow, type VarianceRow,
  type CogsReport, type MovementReport, type VarianceReport, type ReportBucket,
} from "@/lib/reports";
import {
  TrendingDown, TrendingUp, ArrowLeftRight, AlertTriangle,
  BarChart3, Loader2, RefreshCw, Filter, ChevronDown,
} from "lucide-react";

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtCurrency(n: number) { return `$${fmt(n)}`; }
function fmtQty(n: number)      { return fmt(n, n % 1 === 0 ? 0 : 2); }

const today      = new Date().toISOString().split("T")[0];
const defaultFrom = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split("T")[0]; })();

const BUCKET_LABELS: Record<ReportBucket | string, string> = {
  purchase_in:    "Purchases",
  transfer_in:    "Transfer In",
  transfer_out:   "Transfer Out",
  cogs:           "Consumption / COGS",
  waste:          "Waste / Spoilage",
  variance_gain:  "Count Variance +",
  variance_loss:  "Count Variance −",
  adjustment_in:  "Adjustment In",
  adjustment_out: "Adjustment Out",
  return_in:      "Return In",
  return_out:     "Return Out",
  other:          "Other",
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  return (
    <HQOnlyGuard>
      <ReportsContent />
    </HQOnlyGuard>
  );
}

type Tab = "cogs" | "movement" | "variance";

function ReportsContent() {
  const [tab, setTab]               = useState<Tab>("cogs");
  const [locations, setLocations]   = useState<any[]>([]);
  const [locationId, setLocationId] = useState<string>("");
  const [dateFrom, setDateFrom]     = useState(defaultFrom);
  const [dateTo, setDateTo]         = useState(today);

  // Report data
  const [cogsReport,     setCogsReport]     = useState<CogsReport     | null>(null);
  const [movReport,      setMovReport]      = useState<MovementReport  | null>(null);
  const [varReport,      setVarReport]      = useState<VarianceReport  | null>(null);
  const [movBucket,      setMovBucket]      = useState<ReportBucket | "">("");

  const [loading, setLoading]   = useState(false);
  const [error,   setError]     = useState<string | null>(null);

  // Load locations for filter
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
    } else {
      const { data, error: e } = await getInventoryVarianceReport({ ...f, status: "approved" });
      if (e) setError(e); else setVarReport(data);
    }
    setLoading(false);
  }, [tab, locationId, dateFrom, dateTo, movBucket]);

  // Auto-run when tab changes if data is missing
  useEffect(() => { runReport(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolveLocation = (id: string | null) => {
    if (!id) return "—";
    return locations.find(l => l.id === id)?.name ?? id;
  };

  // ── Render
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Reports</h2>
          <p className="text-neutral-500 text-sm mt-0.5">COGS · Movement Ledger · Inventory Variance</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-neutral-100 p-1 rounded-xl w-fit">
        {(["cogs", "movement", "variance"] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
              tab === t
                ? "bg-white text-brand-700 shadow-sm"
                : "text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {t === "cogs" ? "COGS" : t === "movement" ? "Movement" : "Variance"}
          </button>
        ))}
      </div>

      {/* Filters */}
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
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="pl-3 pr-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-400"
              />
            </div>

            {/* Date To */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="pl-3 pr-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-400"
              />
            </div>

            {/* Bucket filter (movement only) */}
            {tab === "movement" && (
              <div className="space-y-1 min-w-[180px]">
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

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 p-4 bg-danger-50 border border-danger-200 rounded-xl text-danger-700 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="grid grid-cols-3 gap-4">
          {[0,1,2].map(i => (
            <div key={i} className="h-24 bg-neutral-100 animate-pulse rounded-xl" />
          ))}
        </div>
      )}

      {/* ── COGS TAB ── */}
      {!loading && tab === "cogs" && cogsReport && (
        <CogsView report={cogsReport} resolveLocation={resolveLocation} />
      )}

      {/* ── MOVEMENT TAB ── */}
      {!loading && tab === "movement" && movReport && (
        <MovementView report={movReport} resolveLocation={resolveLocation} />
      )}

      {/* ── VARIANCE TAB ── */}
      {!loading && tab === "variance" && varReport && (
        <VarianceView report={varReport} resolveLocation={resolveLocation} />
      )}

      {/* Empty state */}
      {!loading && !error && (
        (tab === "cogs"     && cogsReport     && cogsReport.rows.length === 0) ||
        (tab === "movement" && movReport      && movReport.rows.length === 0) ||
        (tab === "variance" && varReport      && varReport.rows.length === 0)
      ) && (
        <div className="py-16 text-center text-neutral-400 text-sm">
          <BarChart3 className="h-10 w-10 mx-auto mb-3 opacity-30" />
          No data for the selected filters and date range.
        </div>
      )}
    </div>
  );
}

// ─── COGS View ────────────────────────────────────────────────────────────────

function CogsView({ report, resolveLocation }: { report: CogsReport; resolveLocation: (id: string | null) => string }) {
  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard
          icon={<TrendingDown className="h-5 w-5 text-danger-500" />}
          label="Total COGS"
          value={fmtCurrency(report.totalCogs)}
          sub={`${report.rows.length} line items`}
          color="danger"
        />
        <SummaryCard
          icon={<BarChart3 className="h-5 w-5 text-brand-500" />}
          label="Total Qty Consumed"
          value={fmtQty(report.totalQty)}
          sub="across all items"
          color="brand"
        />
        <SummaryCard
          icon={<BarChart3 className="h-5 w-5 text-neutral-500" />}
          label="Unique Items"
          value={String(Object.keys(report.byItem).length)}
          sub="consumed in period"
          color="neutral"
        />
      </div>

      {/* Table */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <p className="text-sm font-semibold text-neutral-700">COGS Detail — by Day / Item</p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Date", "Location", "Item", "Qty", "Unit", "COGS Value"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {report.rows.map((r, i) => (
                <tr key={i} className="hover:bg-neutral-50/50">
                  <td className="px-4 py-2.5 text-neutral-700 font-mono text-xs">{r.movement_date}</td>
                  <td className="px-4 py-2.5 text-neutral-600">{resolveLocation(r.location_id)}</td>
                  <td className="px-4 py-2.5 font-medium text-neutral-900">{r.item_name ?? r.item_id ?? "—"}</td>
                  <td className="px-4 py-2.5 text-neutral-700 tabular-nums">{fmtQty(r.total_qty)}</td>
                  <td className="px-4 py-2.5 text-neutral-500">{r.unit ?? "—"}</td>
                  <td className="px-4 py-2.5 font-semibold text-danger-700 tabular-nums">{fmtCurrency(r.cogs_value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-neutral-50 border-t border-neutral-200">
              <tr>
                <td colSpan={5} className="px-4 py-2.5 text-xs font-bold text-neutral-600 uppercase tracking-wider">Total</td>
                <td className="px-4 py-2.5 font-bold text-danger-700 tabular-nums">{fmtCurrency(report.totalCogs)}</td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Movement View ────────────────────────────────────────────────────────────

function MovementView({ report, resolveLocation }: { report: MovementReport; resolveLocation: (id: string | null) => string }) {
  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <SummaryCard
          icon={<TrendingUp className="h-5 w-5 text-success-500" />}
          label="Total In"
          value={fmtCurrency(report.totalInValue)}
          sub="inbound value"
          color="success"
        />
        <SummaryCard
          icon={<TrendingDown className="h-5 w-5 text-danger-500" />}
          label="Total Out"
          value={fmtCurrency(report.totalOutValue)}
          sub="outbound value"
          color="danger"
        />
        <SummaryCard
          icon={<ArrowLeftRight className="h-5 w-5 text-brand-500" />}
          label="Net Movement"
          value={fmtCurrency(report.totalNetValue)}
          sub={report.totalNetValue >= 0 ? "positive" : "negative"}
          color={report.totalNetValue >= 0 ? "success" : "danger"}
        />
        <SummaryCard
          icon={<BarChart3 className="h-5 w-5 text-neutral-500" />}
          label="Transactions"
          value={String(report.rows.length)}
          sub="movement rows"
          color="neutral"
        />
      </div>

      {/* By bucket summary */}
      {Object.keys(report.byBucket).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(report.byBucket).map(([bucket, val]) => (
            <span key={bucket} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full bg-neutral-100 text-neutral-700 border border-neutral-200">
              <span className="text-neutral-400">{BUCKET_LABELS[bucket] ?? bucket}</span>
              <span>{fmtCurrency(val as number)}</span>
            </span>
          ))}
        </div>
      )}

      {/* Table */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <p className="text-sm font-semibold text-neutral-700">Movement Ledger</p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Date", "Location", "Item", "Type", "Bucket", "Qty", "Unit Cost", "Total", "Reference"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {report.rows.map((r) => (
                <tr key={r.id} className="hover:bg-neutral-50/50">
                  <td className="px-4 py-2.5 text-neutral-700 font-mono text-xs whitespace-nowrap">{r.movement_date}</td>
                  <td className="px-4 py-2.5 text-neutral-600 whitespace-nowrap">{resolveLocation(r.location_id)}</td>
                  <td className="px-4 py-2.5 font-medium text-neutral-900">{r.item_name ?? r.item_id ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-mono bg-neutral-100 text-neutral-600 border border-neutral-200">
                      {r.movement_type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <BucketBadge bucket={r.report_bucket} />
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-700">{fmtQty(r.quantity)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-600">{fmtCurrency(r.unit_cost)}</td>
                  <td className={`px-4 py-2.5 tabular-nums font-semibold ${r.signed_cost >= 0 ? "text-success-700" : "text-danger-700"}`}>
                    {r.signed_cost >= 0 ? "+" : ""}{fmtCurrency(r.signed_cost)}
                  </td>
                  <td className="px-4 py-2.5 text-neutral-400 text-xs font-mono">
                    {r.reference_type && <span>{r.reference_type}</span>}
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

// ─── Variance View ────────────────────────────────────────────────────────────

function VarianceView({ report, resolveLocation }: { report: VarianceReport; resolveLocation: (id: string | null) => string }) {
  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <SummaryCard
          icon={<TrendingUp className="h-5 w-5 text-success-500" />}
          label="Variance Gain"
          value={fmtCurrency(report.totalGain)}
          sub="counted more than system"
          color="success"
        />
        <SummaryCard
          icon={<TrendingDown className="h-5 w-5 text-danger-500" />}
          label="Variance Loss"
          value={fmtCurrency(report.totalLoss)}
          sub="counted less than system"
          color="danger"
        />
        <SummaryCard
          icon={<AlertTriangle className="h-5 w-5 text-warning-500" />}
          label="Net Variance"
          value={fmtCurrency(report.netVariance)}
          sub={report.netVariance >= 0 ? "net gain" : "net loss"}
          color={report.netVariance >= 0 ? "success" : "danger"}
        />
        <SummaryCard
          icon={<BarChart3 className="h-5 w-5 text-neutral-500" />}
          label="Lines"
          value={String(report.rows.length)}
          sub="variance lines"
          color="neutral"
        />
      </div>

      {/* Table */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <p className="text-sm font-semibold text-neutral-700">Approved Variance Detail</p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Count Date", "Location", "Item", "System Qty", "Counted Qty", "Variance", "Unit Cost", "Variance Value"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {report.rows.map((r, i) => (
                <tr key={i} className="hover:bg-neutral-50/50">
                  <td className="px-4 py-2.5 font-mono text-xs text-neutral-700 whitespace-nowrap">{r.count_date}</td>
                  <td className="px-4 py-2.5 text-neutral-600 whitespace-nowrap">{resolveLocation(r.location_id)}</td>
                  <td className="px-4 py-2.5 font-medium text-neutral-900">{r.item_name ?? r.item_id ?? "—"}</td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-600">{fmtQty(r.system_qty)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-600">{fmtQty(r.counted_qty)}</td>
                  <td className={`px-4 py-2.5 tabular-nums font-semibold ${
                    r.variance_qty > 0 ? "text-success-700" : r.variance_qty < 0 ? "text-danger-700" : "text-neutral-400"
                  }`}>
                    {r.variance_qty > 0 ? "+" : ""}{fmtQty(r.variance_qty)} {r.unit}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-600">{fmtCurrency(r.unit_cost)}</td>
                  <td className={`px-4 py-2.5 tabular-nums font-bold ${
                    r.variance_value > 0 ? "text-success-700" : r.variance_value < 0 ? "text-danger-700" : "text-neutral-400"
                  }`}>
                    {r.variance_value > 0 ? "+" : ""}{fmtCurrency(r.variance_value)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-neutral-50 border-t border-neutral-200">
              <tr>
                <td colSpan={7} className="px-4 py-2.5 text-xs font-bold text-neutral-600 uppercase tracking-wider">Net Variance</td>
                <td className={`px-4 py-2.5 font-bold tabular-nums ${report.netVariance >= 0 ? "text-success-700" : "text-danger-700"}`}>
                  {report.netVariance > 0 ? "+" : ""}{fmtCurrency(report.netVariance)}
                </td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Shared sub-components ───────────────────────────────────────────────────

function SummaryCard({
  icon, label, value, sub, color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  color: "brand" | "success" | "danger" | "warning" | "neutral";
}) {
  const bg: Record<string, string> = {
    brand:   "bg-brand-50   border-brand-100",
    success: "bg-success-50 border-success-100",
    danger:  "bg-danger-50  border-danger-100",
    warning: "bg-warning-50 border-warning-100",
    neutral: "bg-neutral-50 border-neutral-100",
  };
  return (
    <div className={`rounded-xl border p-4 ${bg[color] ?? bg.neutral}`}>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-2xl font-bold text-neutral-900 tabular-nums">{value}</p>
      <p className="text-xs text-neutral-500 mt-0.5">{sub}</p>
    </div>
  );
}

const BUCKET_COLORS: Record<string, string> = {
  purchase_in:    "bg-blue-50 text-blue-700 border-blue-200",
  transfer_in:    "bg-teal-50 text-teal-700 border-teal-200",
  transfer_out:   "bg-orange-50 text-orange-700 border-orange-200",
  cogs:           "bg-danger-50 text-danger-700 border-danger-200",
  waste:          "bg-yellow-50 text-yellow-700 border-yellow-200",
  variance_gain:  "bg-success-50 text-success-700 border-success-200",
  variance_loss:  "bg-red-50 text-red-700 border-red-200",
  adjustment_in:  "bg-purple-50 text-purple-700 border-purple-200",
  adjustment_out: "bg-pink-50 text-pink-700 border-pink-200",
  other:          "bg-neutral-100 text-neutral-600 border-neutral-200",
};

function BucketBadge({ bucket }: { bucket: string }) {
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${BUCKET_COLORS[bucket] ?? BUCKET_COLORS.other}`}>
      {BUCKET_LABELS[bucket] ?? bucket}
    </span>
  );
}
