/**
 * src/lib/reports.ts
 *
 * Reports System — Phase 1
 * All data fetched via Supabase RPC only. No direct table queries.
 * All financial figures computed in SQL views — never on the client.
 *
 * Real schema:
 *   inventory_items : id TEXT, name TEXT, instock NUMERIC, cost NUMERIC, location_id TEXT
 *   inventory_movements : id BIGINT, location_id TEXT, item_id TEXT, movement_type TEXT, …
 */

import { supabase } from "@/lib/supabase";

// ─── Shared filter ────────────────────────────────────────────────────────────

export interface ReportFilters {
  locationId?: string | null;
  dateFrom?:   string;   // ISO date "YYYY-MM-DD"
  dateTo?:     string;   // ISO date "YYYY-MM-DD"
}

// ─── Report bucket type ───────────────────────────────────────────────────────

export type ReportBucket =
  | "purchase_in"
  | "production_in"
  | "transfer_in"
  | "transfer_out"
  | "cogs"
  | "waste"
  | "variance_gain"
  | "variance_loss"
  | "adjustment_in"
  | "adjustment_out"
  | "return_out"
  | "other";

// ─── Labour detection ─────────────────────────────────────────────────────────
// Labour items are regular inventory_items named LABOUR*/LABOR* (case-insensitive).
// No schema change needed — we match on item_name at report time.
export function isLabourItem(name: string | null | undefined): boolean {
  if (!name) return false;
  const u = name.toUpperCase();
  return u.includes("LABOUR") || u.includes("LABOR");
}

// ─── COGS ─────────────────────────────────────────────────────────────────────

export interface CogsRow {
  movement_date: string;
  location_id:   string | null;
  item_id:       string | null;
  item_name:     string | null;
  total_qty:     number;
  cogs_value:    number;
  is_labour:     boolean;  // derived client-side
}

export interface CogsReport {
  rows:           CogsRow[];
  totalCogs:      number;
  totalQty:       number;
  labourCogs:     number;   // Σ cogs_value where item_name contains LABOUR/LABOR
  ingredientCogs: number;   // totalCogs - labourCogs
  byDate:         Record<string, number>;   // date → cogs_value
  byItem:         Record<string, number>;   // item_name → cogs_value
}

export async function getCogsReport(
  filters: ReportFilters,
): Promise<{ data: CogsReport | null; error: string | null }> {
  const { data, error } = await supabase.rpc("get_cogs_report", {
    p_location_id: filters.locationId ?? null,
    p_date_from:   filters.dateFrom   ?? isoDate(daysAgo(30)),
    p_date_to:     filters.dateTo     ?? isoDate(new Date()),
  });

  if (error) {
    console.error("[reports] getCogsReport:", error.message);
    return { data: null, error: error.message };
  }

  const rows: CogsRow[] = (data ?? []).map((r: any): CogsRow => ({
    movement_date: r.movement_date ?? "",
    location_id:   r.location_id   ?? null,
    item_id:       r.item_id       ?? null,
    item_name:     r.item_name     ?? null,
    total_qty:     Number(r.total_qty  ?? 0),
    cogs_value:    Number(r.cogs_value ?? 0),
    is_labour:     isLabourItem(r.item_name),
  }));

  const totalCogs     = rows.reduce((s, r) => s + r.cogs_value, 0);
  const totalQty      = rows.reduce((s, r) => s + r.total_qty,  0);
  const labourCogs    = rows.filter(r => r.is_labour).reduce((s, r) => s + r.cogs_value, 0);
  const ingredientCogs = totalCogs - labourCogs;
  const byDate:   Record<string, number> = {};
  const byItem:   Record<string, number> = {};
  for (const r of rows) {
    byDate[r.movement_date] = (byDate[r.movement_date] ?? 0) + r.cogs_value;
    const k = r.item_name ?? r.item_id ?? "Unknown";
    byItem[k] = (byItem[k] ?? 0) + r.cogs_value;
  }

  return { data: { rows, totalCogs, totalQty, labourCogs, ingredientCogs, byDate, byItem }, error: null };
}

// ─── Inventory Movement ───────────────────────────────────────────────────────

export interface MovementRow {
  id:             number;
  created_at:     string;
  movement_date:  string;
  location_id:    string | null;
  item_id:        string | null;
  item_name:      string | null;
  movement_type:  string;
  report_bucket:  ReportBucket;
  quantity:       number;
  unit_cost:      number;
  total_cost:     number;
  signed_cost:    number;
  reference_type: string | null;
  reference_id:   string | null;
  notes:          string | null;
}

export interface MovementReport {
  rows:          MovementRow[];
  totalInValue:  number;   // sum of positive signed_cost
  totalOutValue: number;   // sum of abs(negative signed_cost)
  totalNetValue: number;
  byBucket:      Partial<Record<ReportBucket, number>>;
}

export async function getInventoryMovementReport(
  filters: ReportFilters & { itemId?: string | null; bucket?: ReportBucket | null },
): Promise<{ data: MovementReport | null; error: string | null }> {
  // RPC expects TIMESTAMPTZ — convert date strings to start/end of day UTC
  const from = filters.dateFrom
    ? `${filters.dateFrom}T00:00:00Z`
    : new Date(Date.now() - 30 * 86_400_000).toISOString();
  const to = filters.dateTo
    ? `${filters.dateTo}T23:59:59Z`
    : new Date().toISOString();

  const { data, error } = await supabase.rpc("get_inventory_movement_report", {
    p_location_id: filters.locationId ?? null,
    p_item_id:     filters.itemId     ?? null,
    p_date_from:   from,
    p_date_to:     to,
    p_bucket:      filters.bucket     ?? null,
  });

  if (error) {
    console.error("[reports] getInventoryMovementReport:", error.message);
    return { data: null, error: error.message };
  }

  const rows: MovementRow[] = (data ?? []).map((r: any): MovementRow => ({
    id:             Number(r.id            ?? 0),
    created_at:     r.created_at           ?? "",
    movement_date:  r.movement_date        ?? "",
    location_id:    r.location_id          ?? null,
    item_id:        r.item_id              ?? null,
    item_name:      r.item_name            ?? null,
    movement_type:  r.movement_type        ?? "",
    report_bucket:  (r.report_bucket ?? "other") as ReportBucket,
    quantity:       Number(r.quantity      ?? 0),
    unit_cost:      Number(r.unit_cost     ?? 0),
    total_cost:     Number(r.total_cost    ?? 0),
    signed_cost:    Number(r.signed_cost   ?? 0),
    reference_type: r.reference_type       ?? null,
    reference_id:   r.reference_id         ?? null,
    notes:          r.notes                ?? null,
  }));

  let totalInValue  = 0;
  let totalOutValue = 0;
  const byBucket: Partial<Record<ReportBucket, number>> = {};

  for (const r of rows) {
    if (r.signed_cost >= 0) totalInValue  += r.signed_cost;
    else                    totalOutValue += Math.abs(r.signed_cost);
    byBucket[r.report_bucket] =
      (byBucket[r.report_bucket] ?? 0) + Math.abs(r.total_cost);
  }

  return {
    data: { rows, totalInValue, totalOutValue, totalNetValue: totalInValue - totalOutValue, byBucket },
    error: null,
  };
}

// ─── Fulfillment Profit ───────────────────────────────────────────────────────

export interface ProfitRow {
  movement_date: string;
  location_id:   string | null;
  item_name:     string | null;
  qty:           number;
  unit_price:    number;
  revenue:       number;
  making_cost:   number;
  cogs:          number;
  profit:        number;
  margin_pct:    number | null;   // null when revenue = 0 (DB returns NULL)
}

export interface ProfitReport {
  rows:         ProfitRow[];
  totalRevenue: number;
  totalCogs:    number;
  totalProfit:  number;
  avgMarginPct: number | null;   // null when no revenue rows
}

export async function getFulfillmentProfitReport(
  filters: ReportFilters,
): Promise<{ data: ProfitReport | null; error: string | null }> {
  const { data, error } = await supabase.rpc("get_fulfillment_profit_report", {
    p_location_id: filters.locationId ?? null,
    p_date_from:   filters.dateFrom   ?? isoDate(daysAgo(30)),
    p_date_to:     filters.dateTo     ?? isoDate(new Date()),
  });

  if (error) {
    console.error("[reports] getFulfillmentProfitReport:", error.message);
    return { data: null, error: error.message };
  }

  const rows: ProfitRow[] = (data ?? []).map((r: any): ProfitRow => ({
    movement_date: r.movement_date ?? "",
    location_id:   r.location_id   ?? null,
    item_name:     r.item_name     ?? null,
    qty:           Number(r.qty          ?? 0),
    unit_price:    Number(r.unit_price   ?? 0),
    revenue:       Number(r.revenue      ?? 0),
    making_cost:   Number(r.making_cost  ?? 0),
    cogs:          Number(r.cogs         ?? 0),
    profit:        Number(r.profit       ?? 0),
    margin_pct:    r.margin_pct != null ? Number(r.margin_pct) : null,
  }));

  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalCogs    = rows.reduce((s, r) => s + r.cogs,    0);
  const totalProfit  = rows.reduce((s, r) => s + r.profit,  0);

  // Average margin: weighted by revenue (not simple row average)
  const avgMarginPct = totalRevenue > 0
    ? (totalProfit / totalRevenue) * 100
    : null;

  return { data: { rows, totalRevenue, totalCogs, totalProfit, avgMarginPct }, error: null };
}


// ─── Margin Insights (derived, no extra RPC) ──────────────────────────────────
// Aggregates ProfitReport rows client-side — no additional network call.
// Groups by item_name, computes per-item totals + weighted margin_pct, then
// returns sorted slices for the Top/Worst cards in ProfitView.

export interface MarginInsightRow {
  item_name:     string;
  total_revenue: number;
  total_cogs:    number;
  total_profit:  number;
  margin_pct:    number | null;  // null if total_revenue = 0
}

export interface MarginInsights {
  top:   MarginInsightRow[];  // highest margin first, up to 5
  worst: MarginInsightRow[];  // lowest margin first, up to 5 (excludes null-margin rows)
}

/** Pure function — derives margin rankings from an existing ProfitReport. */
export function deriveMarginInsights(report: ProfitReport, n = 5): MarginInsights {
  // Aggregate all fulfillment rows by item_name
  const byItem = new Map<string, { rev: number; cogs: number; profit: number }>();

  for (const r of report.rows) {
    const key = r.item_name ?? "Unknown";
    const cur = byItem.get(key) ?? { rev: 0, cogs: 0, profit: 0 };
    byItem.set(key, {
      rev:    cur.rev    + r.revenue,
      cogs:   cur.cogs   + r.cogs,
      profit: cur.profit + r.profit,
    });
  }

  const aggregated: MarginInsightRow[] = Array.from(byItem.entries()).map(([name, v]) => ({
    item_name:     name,
    total_revenue: v.rev,
    total_cogs:    v.cogs,
    total_profit:  v.profit,
    // Weighted margin: derived from aggregated totals, not row averages
    margin_pct: v.rev > 0
      ? Math.round((v.profit / v.rev) * 100 * 100) / 100  // 2dp
      : null,
  }));

  // Rows with a known margin_pct, sorted for ranking
  const withMargin = aggregated.filter(r => r.margin_pct !== null);
  withMargin.sort((a, b) => (b.margin_pct ?? 0) - (a.margin_pct ?? 0));

  return {
    top:   withMargin.slice(0, n),
    worst: [...withMargin].reverse().slice(0, n),
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────


function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}
