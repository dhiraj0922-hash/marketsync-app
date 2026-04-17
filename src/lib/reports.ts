/**
 * src/lib/reports.ts
 *
 * Reports System — Phase 1
 * All data fetched via Supabase RPC only. No direct table queries.
 * Financial calculations live in SQL views (never on the client).
 */

import { supabase } from "@/lib/supabase";

// ─── Shared filter ────────────────────────────────────────────────────────────

export interface ReportFilters {
  locationId?: string | null;
  dateFrom?: string;   // ISO date "YYYY-MM-DD"
  dateTo?: string;     // ISO date "YYYY-MM-DD"
}

// ─── COGS ─────────────────────────────────────────────────────────────────────

export interface CogsRow {
  movement_date:  string;
  location_id:    string | null;
  item_id:        string | null;
  item_name:      string | null;
  total_qty:      number;
  unit:           string | null;
  cogs_value:     number;
}

export interface CogsReport {
  rows:        CogsRow[];
  totalCogs:   number;
  totalQty:    number;
  byDate:      Record<string, number>;  // date → cogs_value
  byItem:      Record<string, number>;  // item_name → cogs_value
}

export async function getCogsReport(
  filters: ReportFilters
): Promise<{ data: CogsReport | null; error: string | null }> {
  const { data, error } = await supabase.rpc("get_cogs_report", {
    p_location_id: filters.locationId ?? null,
    p_date_from:   filters.dateFrom   ?? toISODate(daysAgo(30)),
    p_date_to:     filters.dateTo     ?? toISODate(new Date()),
  });

  if (error) {
    console.error("[reports] getCogsReport RPC error:", error.message);
    return { data: null, error: error.message };
  }

  const rows: CogsRow[] = (data ?? []).map(normalizeCogsRow);
  const totalCogs = rows.reduce((s, r) => s + r.cogs_value, 0);
  const totalQty  = rows.reduce((s, r) => s + r.total_qty, 0);

  const byDate: Record<string, number> = {};
  const byItem: Record<string, number> = {};
  for (const r of rows) {
    byDate[r.movement_date] = (byDate[r.movement_date] ?? 0) + r.cogs_value;
    const k = r.item_name ?? r.item_id ?? "Unknown";
    byItem[k] = (byItem[k] ?? 0) + r.cogs_value;
  }

  return { data: { rows, totalCogs, totalQty, byDate, byItem }, error: null };
}

function normalizeCogsRow(r: any): CogsRow {
  return {
    movement_date: r.movement_date ?? "",
    location_id:   r.location_id  ?? null,
    item_id:       r.item_id      ?? null,
    item_name:     r.item_name    ?? null,
    total_qty:     Number(r.total_qty  ?? 0),
    unit:          r.unit         ?? null,
    cogs_value:    Number(r.cogs_value ?? 0),
  };
}

// ─── Inventory Movement ───────────────────────────────────────────────────────

export type ReportBucket =
  | "purchase_in"
  | "transfer_in"
  | "transfer_out"
  | "cogs"
  | "waste"
  | "variance_gain"
  | "variance_loss"
  | "adjustment_in"
  | "adjustment_out"
  | "return_in"
  | "return_out"
  | "other";

export interface MovementRow {
  id:             string;
  movement_date:  string;
  location_id:    string | null;
  item_id:        string | null;
  item_name:      string | null;
  movement_type:  string;
  report_bucket:  ReportBucket;
  quantity:       number;
  unit:           string | null;
  unit_cost:      number;
  total_cost:     number;
  signed_cost:    number;
  reference_type: string | null;
  reference_id:   string | null;
  notes:          string | null;
  moved_at:       string;
}

export interface MovementReport {
  rows:             MovementRow[];
  totalInValue:     number;   // sum of positive signed_cost
  totalOutValue:    number;   // sum of negative signed_cost (stored as positive)
  totalNetValue:    number;   // totalInValue - totalOutValue
  byBucket:         Record<ReportBucket, number>;
}

export async function getInventoryMovementReport(
  filters: ReportFilters & { bucket?: ReportBucket | null }
): Promise<{ data: MovementReport | null; error: string | null }> {
  const { data, error } = await supabase.rpc("get_inventory_movement_report", {
    p_location_id: filters.locationId ?? null,
    p_date_from:   filters.dateFrom   ?? toISODate(daysAgo(30)),
    p_date_to:     filters.dateTo     ?? toISODate(new Date()),
    p_bucket:      filters.bucket     ?? null,
  });

  if (error) {
    console.error("[reports] getInventoryMovementReport RPC error:", error.message);
    return { data: null, error: error.message };
  }

  const rows: MovementRow[] = (data ?? []).map(normalizeMovementRow);

  let totalInValue  = 0;
  let totalOutValue = 0;
  const byBucket = {} as Record<ReportBucket, number>;

  for (const r of rows) {
    if (r.signed_cost >= 0) {
      totalInValue += r.signed_cost;
    } else {
      totalOutValue += Math.abs(r.signed_cost);
    }
    byBucket[r.report_bucket] = (byBucket[r.report_bucket] ?? 0) + Math.abs(r.total_cost);
  }

  return {
    data: {
      rows,
      totalInValue,
      totalOutValue,
      totalNetValue: totalInValue - totalOutValue,
      byBucket,
    },
    error: null,
  };
}

function normalizeMovementRow(r: any): MovementRow {
  return {
    id:             r.id            ?? "",
    movement_date:  r.movement_date ?? "",
    location_id:    r.location_id   ?? null,
    item_id:        r.item_id       ?? null,
    item_name:      r.item_name     ?? null,
    movement_type:  r.movement_type ?? "",
    report_bucket:  (r.report_bucket ?? "other") as ReportBucket,
    quantity:       Number(r.quantity    ?? 0),
    unit:           r.unit          ?? null,
    unit_cost:      Number(r.unit_cost   ?? 0),
    total_cost:     Number(r.total_cost  ?? 0),
    signed_cost:    Number(r.signed_cost ?? 0),
    reference_type: r.reference_type ?? null,
    reference_id:   r.reference_id  ?? null,
    notes:          r.notes         ?? null,
    moved_at:       r.moved_at      ?? "",
  };
}

// ─── Variance ─────────────────────────────────────────────────────────────────

export interface VarianceRow {
  session_id:     string;
  location_id:    string;
  count_date:     string;
  status:         string;
  item_id:        string | null;
  item_name:      string | null;
  unit:           string | null;
  system_qty:     number;
  counted_qty:    number;
  variance_qty:   number;
  unit_cost:      number;
  variance_value: number;
}

export interface VarianceReport {
  rows:           VarianceRow[];
  totalVariance:  number;       // sum of abs(variance_value)
  totalGain:      number;       // sum where variance_value > 0
  totalLoss:      number;       // sum where variance_value < 0 (stored positive)
  netVariance:    number;       // totalGain - totalLoss
}

export async function getInventoryVarianceReport(
  filters: ReportFilters & { status?: string }
): Promise<{ data: VarianceReport | null; error: string | null }> {
  const { data, error } = await supabase.rpc("get_inventory_variance_report", {
    p_location_id: filters.locationId ?? null,
    p_date_from:   filters.dateFrom   ?? toISODate(daysAgo(90)),
    p_date_to:     filters.dateTo     ?? toISODate(new Date()),
    p_status:      filters.status     ?? "approved",
  });

  if (error) {
    console.error("[reports] getInventoryVarianceReport RPC error:", error.message);
    return { data: null, error: error.message };
  }

  const rows: VarianceRow[] = (data ?? []).map(normalizeVarianceRow);

  let totalGain = 0;
  let totalLoss = 0;

  for (const r of rows) {
    if (r.variance_value > 0) totalGain += r.variance_value;
    else totalLoss += Math.abs(r.variance_value);
  }

  return {
    data: {
      rows,
      totalVariance: totalGain + totalLoss,
      totalGain,
      totalLoss,
      netVariance: totalGain - totalLoss,
    },
    error: null,
  };
}

function normalizeVarianceRow(r: any): VarianceRow {
  return {
    session_id:     r.session_id     ?? "",
    location_id:    r.location_id    ?? "",
    count_date:     r.count_date     ?? "",
    status:         r.status         ?? "",
    item_id:        r.item_id        ?? null,
    item_name:      r.item_name      ?? null,
    unit:           r.unit           ?? null,
    system_qty:     Number(r.system_qty     ?? 0),
    counted_qty:    Number(r.counted_qty    ?? 0),
    variance_qty:   Number(r.variance_qty   ?? 0),
    unit_cost:      Number(r.unit_cost      ?? 0),
    variance_value: Number(r.variance_value ?? 0),
  };
}

// ─── Stock Count approval ─────────────────────────────────────────────────────

export async function approveStockCount(
  sessionId: string,
  approvedByUserId: string
): Promise<{ success: boolean; movementsCreated?: number; error?: string }> {
  const { data, error } = await supabase.rpc("approve_stock_count", {
    p_session_id:  sessionId,
    p_approved_by: approvedByUserId,
  });

  if (error) {
    console.error("[reports] approveStockCount RPC error:", error.message);
    return { success: false, error: error.message };
  }

  const result = data as { success: boolean; movements_created?: number; error?: string };
  if (!result?.success) {
    return { success: false, error: result?.error ?? "Approval failed" };
  }
  return { success: true, movementsCreated: result.movements_created ?? 0 };
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}
