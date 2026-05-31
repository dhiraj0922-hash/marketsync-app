"use client";
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin, isLocationManager, resolveLocationId } from "@/lib/roles";
import { loadLocations, loadOutletCatalog, loadOutletInventoryV2, loadOrders } from "@/lib/storage";
import OutletPerformanceView from "./OutletPerformanceView";
import {
  getCogsReport,
  getInventoryMovementReport,
  getFulfillmentProfitReport,
  deriveMarginInsights,
  isLabourItem,
  type CogsReport,
  type MovementRow,
  type MovementReport,
  type ProfitReport,
  type MarginInsights,
  type ReportBucket,
} from "@/lib/reports";
import {
  TrendingDown, TrendingUp, ArrowLeftRight, AlertTriangle,
  BarChart3, Loader2, RefreshCw, ChevronDown, Filter, DollarSign,
  HardHat, Clock, Store, ClipboardList,
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
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="animate-pulse flex flex-col items-center">
          <div className="h-8 w-8 rounded-full border-4 border-brand-500 border-t-transparent animate-spin mb-4" />
          <div className="text-neutral-500 text-sm font-medium">Validating access…</div>
        </div>
      </div>
    );
  }

  if (!user || (!isHqAdmin(user) && !isLocationManager(user))) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-5">
          <div className="text-red-500 font-bold text-lg">Access Denied</div>
          <p className="text-sm text-neutral-500 leading-relaxed">
            You do not have permission to view reports. Please contact your HQ administrator.
          </p>
        </div>
      </div>
    );
  }

  if (isLocationManager(user) && !user.locationId) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-5">
          <div className="text-warning-600 font-bold text-lg">No Location Assigned</div>
          <p className="text-sm text-neutral-500 leading-relaxed">
            No location assigned. Please contact HQ.
          </p>
        </div>
      </div>
    );
  }

  return <ReportsContent user={user} />;
}

type Tab = "cogs" | "movement" | "profit" | "labour" | "performance" | "stock_health" | "variance" | "local_spend";

function ReportsContent({ user }: { user: any }) {
  const isHQ = isHqAdmin(user);
  const [tab, setTab]               = useState<Tab>(isHQ ? "cogs" : "movement");
  const [locations, setLocations]   = useState<any[]>([]);
  const [locationId, setLocationId] = useState(isHQ ? "" : (user.locationId ?? ""));
  const [dateFrom, setDateFrom]     = useState(defaultFrom);
  const [dateTo, setDateTo]         = useState(today);
  const [movBucket, setMovBucket]   = useState<ReportBucket | "">("");

  const [cogsReport,    setCogsReport]    = useState<CogsReport    | null>(null);
  const [movReport,     setMovReport]     = useState<MovementReport | null>(null);
  const [profitReport,  setProfitReport]  = useState<ProfitReport  | null>(null);
  const [labourReport,  setLabourReport]  = useState<MovementReport | null>(null);
  const [stockCatalog,  setStockCatalog]  = useState<any[]>([]);
  const [stockOutlet,   setStockOutlet]   = useState<any[]>([]);
  const [poOrders,      setPoOrders]      = useState<any[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState<string | null>(null);

  useEffect(() => {
    loadLocations().then(locs => setLocations(Array.isArray(locs) ? locs : []));
  }, []);

  const runReport = useCallback(async () => {
    if (tab === "performance") return; // OutletPerformanceView fetches its own data
    setLoading(true);
    setError(null);
    const f = { locationId: locationId || null, dateFrom, dateTo };

    // Security note:
    // TODO: get_cogs_report, get_inventory_movement_report, and get_fulfillment_profit_report
    // should be hardened in the database to compare requested location_id against
    // user_profiles.location_id for the authenticated session if role != 'hq_admin'.

    if (tab === "cogs") {
      const { data, error: e } = await getCogsReport(f);
      if (e) setError(e); else setCogsReport(data);
    } else if (tab === "movement" || tab === "variance") {
      const { data, error: e } = await getInventoryMovementReport({
        ...f,
        bucket: tab === "movement" ? ((movBucket as ReportBucket) || null) : null,
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
    } else if (tab === "stock_health") {
      try {
        const [cat, outlet] = await Promise.all([
          loadOutletCatalog(),
          loadOutletInventoryV2(locationId || user.locationId)
        ]);
        setStockCatalog(Array.isArray(cat) ? cat : []);
        setStockOutlet(Array.isArray(outlet) ? outlet : []);
      } catch (err: any) {
        setError(err.message || "Failed to load stock health data.");
      }
    } else if (tab === "local_spend") {
      try {
        const loadedOrders = await loadOrders(locationId || user.locationId);
        setPoOrders(Array.isArray(loadedOrders) ? loadedOrders : []);
      } catch (err: any) {
        setError(err.message || "Failed to load PO spend data.");
      }
    } else {
      const { data, error: e } = await getFulfillmentProfitReport(f);
      if (e) setError(e); else setProfitReport(data);
    }
    setLoading(false);
  }, [tab, locationId, dateFrom, dateTo, movBucket, user.locationId]);

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
    (tab === "labour"   && labourReport  && labourReport.rows.length  === 0) ||
    (tab === "variance" && movReport     && movReport.rows.filter(r => r.movement_type === "count_variance_gain" || r.movement_type === "count_variance_loss").length === 0) ||
    (tab === "stock_health" && stockOutlet.filter(r => r.localEnabled).length === 0) ||
    (tab === "local_spend" && poOrders.length === 0);

  return (
    <div className="space-y-6">
      {/* ── Header */}
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Reports</h2>
        <p className="text-neutral-500 text-sm mt-0.5">
          {isHQ ? "COGS · Movement Ledger" : "Movement Ledger · Stock Health · Variance"}
        </p>
      </div>

      {/* ── Tabs */}
      <div className="flex flex-wrap gap-1 bg-neutral-100 p-1 rounded-xl w-fit">
        {(isHQ 
          ? (["cogs", "movement", "profit", "labour", "performance"] as Tab[])
          : (["movement", "stock_health", "variance", "local_spend"] as Tab[])
        ).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
              tab === t ? "bg-white text-brand-700 shadow-sm" : "text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {t === "cogs" 
              ? "COGS" 
              : t === "movement" 
              ? "Movement Ledger" 
              : t === "profit" 
              ? "Profit" 
              : t === "labour" 
              ? "Labour" 
              : t === "performance"
              ? "Outlet Performance"
              : t === "stock_health"
              ? "Stock Health & Value"
              : t === "variance"
              ? "Count Variance"
              : "Local Vendor Spend"}
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
              {isHQ ? (
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
              ) : (
                <div className="px-3 py-2 border border-neutral-200 bg-neutral-50 rounded-lg text-sm font-semibold text-neutral-700 flex items-center gap-1.5">
                  <Store className="h-4 w-4 text-brand-600" />
                  {locName(user.locationId)}
                </div>
              )}
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
            {tab !== "performance" && (
              <button
                onClick={runReport}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors shadow-sm"
              >
                {loading
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</>
                  : <><RefreshCw className="h-4 w-4" /> Run Report</>}
              </button>
            )}
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

      {/* ── Outlet Performance tab */}
      {tab === "performance" && (
        <OutletPerformanceView
          dateFrom={dateFrom}
          dateTo={dateTo}
          locationId={locationId}
          locations={locations}
        />
      )}

      {/* ── Stock Health & Value tab */}
      {!loading && tab === "stock_health" && stockCatalog.length > 0 && (
        <StockHealthView catalog={stockCatalog} outlet={stockOutlet} />
      )}

      {/* ── Count Variance tab */}
      {!loading && tab === "variance" && movReport && (
        <CountVarianceView report={movReport} locName={locName} />
      )}

      {/* ── Local Spend / PO Spend tab */}
      {!loading && tab === "local_spend" && (
        <LocalSpendView orders={poOrders} dateFrom={dateFrom} dateTo={dateTo} />
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

// ─── Movement context helper ─────────────────────────────────────────────────
// Derives a human-readable context label from inventory_movements.notes.
// Notes format varies by movement_type — see finished-goods/page.tsx executeProduction
// and fg-count/page.tsx saveRow for the exact strings written.
// No SQL change needed — all context is already stored in notes.
function getMovementContextLabel(r: MovementRow): string | null {
  // ── production_consumption ─────────────────────────────────────────────────
  // Note: "Production: 2× AGNI SAUCE PREP — consumed 500 g of PEPPERS, GREEN THAI"
  // × is Unicode U+00D7, — is em-dash U+2014
  if (r.movement_type === "production_consumption" && r.notes) {
    const m = r.notes.match(/Production:\s+\d+[\u00d7x]\s+(.+?)\s+[\u2014-]/);
    if (m) return `Used for: ${m[1].trim()}`;
    return r.notes; // plain-text fallback
  }

  // ── production_in ──────────────────────────────────────────────────────────
  // Note: "Production output: 2 batches of AGNI SAUCE PREP [prep_item]"
  if (r.movement_type === "production_in" && r.notes) {
    const m = r.notes.match(/Production output:\s+\d+ batches? of\s+(.+?)(\s+\[|$)/);
    if (m) return `Produced: ${m[1].trim()}`;
    return r.notes;
  }

  // ── count_variance_gain / count_variance_loss ──────────────────────────────
  // Note: JSON blob with display_note + optional session_name
  // e.g. { display_note: "FG count: system 44 -> counted 40 (-4) - DOSA BATTER", session_name: "Night Closing" }
  if (
    (r.movement_type === "count_variance_gain" ||
      r.movement_type === "count_variance_loss") &&
    r.notes
  ) {
    try {
      const parsed = JSON.parse(r.notes);
      const base    = typeof parsed.display_note === "string" ? parsed.display_note : null;
      const session = typeof parsed.session_name === "string" && parsed.session_name
        ? ` — ${parsed.session_name}`
        : "";
      if (base) return `${base}${session}`;
    } catch {
      // notes is plain text — fall through to return it directly
    }
    return r.notes;
  }

  // ── requisition / transfer / adjustment / other ────────────────────────────
  // notes is already human-readable plain text
  if (r.notes) return r.notes;

  // ── Fallback: reference_id or reference_type ───────────────────────────────
  return r.reference_id ?? r.reference_type ?? null;
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
                {["Date", "Location", "Item", "Type", "Bucket", "Qty", "Unit Cost", "Net Value", "Context"].map(h => (
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
                  <td className="px-4 py-2.5 text-xs text-neutral-600 max-w-[260px]">
                    {(() => {
                      const label = getMovementContextLabel(r);
                      return label ? (
                        <span className="block truncate leading-snug" title={label}>
                          {label}
                        </span>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      );
                    })()}
                    {r.reference_id && (
                      <span className="block font-mono text-[10px] text-neutral-400 truncate mt-0.5">
                        {r.reference_id}
                      </span>
                    )}
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

// ─── Stock Health & Value View ────────────────────────────────────────────────

function StockHealthView({ catalog, outlet }: { catalog: any[]; outlet: any[] }) {
  const merged: any[] = [];
  
  for (const oRow of outlet) {
    if (!oRow.localEnabled) continue;
    const catItem = catalog.find(c => c.itemId === oRow.itemId);
    if (!catItem) continue;

    const localCost = oRow.localPrice ? parseFloat(oRow.localPrice) : null;
    const catalogCost = catItem.price ? parseFloat(catItem.price) : 0;
    const unitCost = (localCost !== null && !isNaN(localCost)) ? localCost : catalogCost;
    const stockQty = oRow.currentStock || 0;
    const stockValue = stockQty * unitCost;

    let status: "Low Stock" | "Overstock" | "Healthy" = "Healthy";
    if (oRow.minOnHand > 0 && stockQty < oRow.minOnHand) {
      status = "Low Stock";
    } else if (oRow.parLevel > 0 && stockQty > oRow.parLevel) {
      status = "Overstock";
    }

    merged.push({
      itemId: oRow.itemId,
      name: catItem.name,
      supplier: oRow.localSupplier || catItem.supplier || "—",
      uom: catItem.uom || "—",
      currentStock: stockQty,
      unitCost,
      stockValue,
      minOnHand: oRow.minOnHand,
      parLevel: oRow.parLevel,
      status
    });
  }

  const totalStockValue = merged.reduce((sum, item) => sum + item.stockValue, 0);
  const lowStockCount = merged.filter(item => item.status === "Low Stock").length;
  const overstockCount = merged.filter(item => item.status === "Overstock").length;
  const missingCostCount = merged.filter(item => item.unitCost === 0).length;

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <SummaryCard
          icon={<DollarSign className="h-5 w-5 text-brand-600" />}
          label="Total Stock Value"
          value={$(totalStockValue)}
          sub={`${merged.length} active inventory items`}
          accent="brand"
        />
        <SummaryCard
          icon={<AlertTriangle className="h-5 w-5 text-red-500" />}
          label="Low Stock Items"
          value={String(lowStockCount)}
          sub="below min threshold"
          accent={lowStockCount > 0 ? "red" : "neutral"}
        />
        <SummaryCard
          icon={<TrendingUp className="h-5 w-5 text-green-600" />}
          label="Overstock Items"
          value={String(overstockCount)}
          sub="above par threshold"
          accent="green"
        />
        <SummaryCard
          icon={<AlertTriangle className="h-5 w-5 text-amber-500" />}
          label="Missing Unit Cost"
          value={String(missingCostCount)}
          sub="cost configured as $0"
          accent={missingCostCount > 0 ? "neutral" : "neutral"}
        />
      </div>

      {/* Detail Table */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <p className="text-sm font-semibold text-neutral-700">Stock Health & Asset Value Detail</p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Item", "Supplier", "UOM", "Current Stock", "Unit Cost", "Stock Value", "Min", "Par", "Status"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {merged.map(r => (
                <tr key={r.itemId} className="hover:bg-neutral-50/50">
                  <td className="px-4 py-2.5 font-medium text-neutral-900">{r.name}</td>
                  <td className="px-4 py-2.5 text-neutral-500">{r.supplier}</td>
                  <td className="px-4 py-2.5 text-neutral-600">{r.uom}</td>
                  <td className="px-4 py-2.5 tabular-nums font-semibold text-neutral-800">{qty(r.currentStock)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-500">{$(r.unitCost)}</td>
                  <td className="px-4 py-2.5 tabular-nums font-bold text-brand-700">{$(r.stockValue)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-500">{r.minOnHand || "—"}</td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-500">{r.parLevel || "—"}</td>
                  <td className="px-4 py-2.5">
                    {r.status === "Low Stock" ? (
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border bg-red-50 text-red-700 border-red-200">
                        Low Stock
                      </span>
                    ) : r.status === "Overstock" ? (
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border bg-green-50 text-green-700 border-green-200">
                        Overstock
                      </span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border bg-neutral-100 text-neutral-600 border-neutral-200">
                        Healthy
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-neutral-50 border-t border-neutral-200">
              <tr>
                <td colSpan={5} className="px-4 py-2.5 text-xs font-bold text-neutral-600 uppercase tracking-wider">Total Valuation</td>
                <td className="px-4 py-2.5 font-bold text-brand-700 tabular-nums">{$(totalStockValue)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Count Variance View ─────────────────────────────────────────────────────

function CountVarianceView({ report, locName }: { report: MovementReport; locName: (id: string | null) => string }) {
  const varianceRows = report.rows.filter(
    r => r.movement_type === "count_variance_gain" || r.movement_type === "count_variance_loss"
  );

  const totalGains = varianceRows
    .filter(r => r.movement_type === "count_variance_gain")
    .reduce((sum, r) => sum + r.signed_cost, 0);

  const totalLosses = varianceRows
    .filter(r => r.movement_type === "count_variance_loss")
    .reduce((sum, r) => sum + Math.abs(r.signed_cost), 0);

  return (
    <div className="space-y-4">
      {/* Variance KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard
          icon={<TrendingUp className="h-5 w-5 text-green-600" />}
          label="Total Variance Gains"
          value={$(totalGains)}
          sub="positive count adjustments"
          accent="green"
        />
        <SummaryCard
          icon={<TrendingDown className="h-5 w-5 text-red-500" />}
          label="Total Variance Losses"
          value={$(totalLosses)}
          sub="negative count adjustments"
          accent="red"
        />
        <SummaryCard
          icon={<ArrowLeftRight className="h-5 w-5 text-brand-500" />}
          label="Net Variance Impact"
          value={$(totalGains - totalLosses)}
          sub="gain vs loss total impact"
          accent={(totalGains - totalLosses) >= 0 ? "green" : "red"}
        />
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <p className="text-sm font-semibold text-neutral-700">Count Variance Log</p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Date", "Location", "Item", "Type", "Qty", "Value Impact", "Context", "Reference ID"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {varianceRows.map(r => {
                const isGain = r.movement_type === "count_variance_gain";
                return (
                  <tr key={r.id} className="hover:bg-neutral-50/50">
                    <td className="px-4 py-2.5 font-mono text-xs text-neutral-700 whitespace-nowrap">{r.movement_date}</td>
                    <td className="px-4 py-2.5 text-neutral-600 whitespace-nowrap">{locName(r.location_id)}</td>
                    <td className="px-4 py-2.5 font-medium text-neutral-900">{r.item_name ?? r.item_id ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      {isGain ? (
                        <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border bg-green-50 text-green-700 border-green-200">Gain</span>
                      ) : (
                        <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border bg-rose-50 text-rose-700 border-rose-200">Loss</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-neutral-700 font-semibold">{qty(r.quantity)}</td>
                    <td className={`px-4 py-2.5 tabular-nums font-bold ${isGain ? "text-green-700" : "text-red-700"}`}>
                      {isGain ? "+" : "-"}{$(Math.abs(r.signed_cost))}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-neutral-600 max-w-[260px] truncate">
                      {(() => {
                        const label = getMovementContextLabel(r);
                        return label || "—";
                      })()}
                    </td>
                    <td className="px-4 py-2.5 text-xs font-mono text-neutral-400 whitespace-nowrap">{r.reference_id ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Local Spend / PO Spend View ─────────────────────────────────────────────

function LocalSpendView({ orders, dateFrom, dateTo }: { orders: any[]; dateFrom: string; dateTo: string }) {
  const filtered = orders.filter(po => {
    if (dateFrom && po.date < dateFrom) return false;
    if (dateTo && po.date > dateTo) return false;
    return true;
  });

  const totalSpend = filtered
    .filter(po => po.status === "Delivered")
    .reduce((sum, po) => sum + (po.total || 0), 0);

  const pendingCount = filtered.filter(po => po.status === "Draft" || po.status === "Sent").length;
  const deliveredCount = filtered.filter(po => po.status === "Delivered").length;

  return (
    <div className="space-y-4">
      {/* Spend overview cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard
          icon={<DollarSign className="h-5 w-5 text-brand-600" />}
          label="Total Delivered Spend"
          value={$(totalSpend)}
          sub="sum of all POs marked Delivered"
          accent="brand"
        />
        <SummaryCard
          icon={<ClipboardList className="h-5 w-5 text-amber-500" />}
          label="Pending PO Orders"
          value={String(pendingCount)}
          sub="draft or sent to supplier"
          accent="neutral"
        />
        <SummaryCard
          icon={<ClipboardList className="h-5 w-5 text-green-600" />}
          label="Delivered PO Orders"
          value={String(deliveredCount)}
          sub="fully completed purchases"
          accent="green"
        />
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <p className="text-sm font-semibold text-neutral-700">Local Purchase Orders Spend Log</p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-100">
              <tr>
                {["Order Date", "PO Number", "Supplier", "Status", "Item Count", "Total Cost"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {filtered.map(po => (
                <tr key={po.id} className="hover:bg-neutral-50/50">
                  <td className="px-4 py-2.5 font-mono text-xs text-neutral-700 whitespace-nowrap">{po.date || po.deliveryDate || "—"}</td>
                  <td className="px-4 py-2.5 font-mono font-semibold text-brand-700 whitespace-nowrap">{po.poNumber}</td>
                  <td className="px-4 py-2.5 text-neutral-900 font-medium">{po.supplierName}</td>
                  <td className="px-4 py-2.5">
                    {po.status === "Delivered" ? (
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border bg-green-50 text-green-700 border-green-200">Delivered</span>
                    ) : po.status === "Sent" ? (
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border bg-blue-50 text-blue-700 border-blue-200">Sent</span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border bg-neutral-100 text-neutral-600 border-neutral-200">Draft</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-neutral-700">{po.items || (po.lineItems ? po.lineItems.length : 0)}</td>
                  <td className="px-4 py-2.5 tabular-nums font-bold text-neutral-900">{$(po.total || 0)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-neutral-50 border-t border-neutral-200">
              <tr>
                <td colSpan={5} className="px-4 py-2.5 text-xs font-bold text-neutral-600 uppercase tracking-wider">Total Delivered Purchases</td>
                <td className="px-4 py-2.5 font-bold text-neutral-900 tabular-nums">{$(totalSpend)}</td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
