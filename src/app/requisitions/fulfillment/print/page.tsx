"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Printer } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { isHqFulfillment, isHqMaster, isHqOps } from "@/lib/roles";
import { getFulfillmentSummary } from "@/lib/storage";

// ─── Types ────────────────────────────────────────────────────────────────────

type FulfillmentRow = {
  id: string;
  requisitionId: string;
  requisitionNumber: string;
  requisitionDate: string;
  requisitionStatus: string;
  locationName: string;
  locationId: string;
  quantityRequested: number;
  allocatedQty: number;
  backorderQty: number;
  fulfillmentNote: string;
  isFGMode: boolean;
  packQty: number | null;
  unit: string | null;
  sourceType: string | null;
};

type FulfillmentGroup = {
  itemName: string;
  unit: string | null;
  isFGMode: boolean;
  packQty: number | null;
  totalRequested: number;
  totalAllocated: number;
  totalBackorder: number;
  items: FulfillmentRow[];
};

// ─── URL param helpers ────────────────────────────────────────────────────────

const asBool = (v: string | null, fallback: boolean) =>
  v == null ? fallback : v === "1" || v === "true";

const splitParam = (v: string | null) =>
  String(v ?? "")
    .split(",")
    .map((s) => decodeURIComponent(s).trim())
    .filter(Boolean);

// ─── Pack quantity helpers ────────────────────────────────────────────────────
//
// Safeguard 2 / 3 / 4:
//
//   isFGMode = true  → totalRequested / allocatedQty are PACK COUNTS
//                      base qty = packCount × packQty
//                      packQty must be > 0 to compute base quantity
//
//   isFGMode = false → quantities are already BASE UNITS
//                      "Loose" — no pack math
//
//   packQty null / 0 → configuration missing; never invent pack math

function isPackValid(g: { isFGMode: boolean; packQty: number | null }): boolean {
  return g.isFGMode && g.packQty != null && Number(g.packQty) > 0;
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function fmtBase(qty: number, unit: string | null): string {
  return unit ? `${fmtNum(qty)} ${unit}` : fmtNum(qty);
}

/** Returns the warehouse-facing "Pull Qty" string for a GROUP. */
function groupPullLabel(g: FulfillmentGroup): string {
  if (!g.isFGMode) {
    // Loose / raw: pull = total allocated in base units
    return fmtBase(g.totalAllocated, g.unit);
  }
  if (!isPackValid(g)) {
    return "—";
  }
  const packs = g.totalAllocated;
  return `${packs} pack${packs !== 1 ? "s" : ""}`;
}

/** Returns the "Total to Stage" string for a GROUP. */
function groupTotalStaged(g: FulfillmentGroup): string {
  if (!g.isFGMode) {
    return fmtBase(g.totalAllocated, g.unit);
  }
  if (!isPackValid(g)) {
    return "—";
  }
  return fmtBase(g.totalAllocated * Number(g.packQty), g.unit);
}

/** Pack size label (e.g. "16 oz / pack"). */
function packSizeLabel(g: FulfillmentGroup): string {
  if (!g.isFGMode) return "Loose";
  if (!isPackValid(g)) return "—";
  return `${fmtNum(Number(g.packQty))} ${g.unit || "ea"} / pack`;
}

/** Per-row requested label. */
function rowRequestedLabel(row: FulfillmentRow): string {
  if (!row.isFGMode) return fmtBase(row.quantityRequested, row.unit);
  if (!isPackValid(row)) return `${fmtNum(row.quantityRequested)} packs (pack config missing)`;
  const packs = row.quantityRequested;
  const base = packs * Number(row.packQty);
  return `${packs} pack${packs !== 1 ? "s" : ""} (${fmtBase(base, row.unit)})`;
}

/** Per-row allocated label. */
function rowAllocLabel(row: FulfillmentRow): string {
  if (!row.isFGMode) return fmtBase(row.allocatedQty, row.unit);
  if (!isPackValid(row)) return `${fmtNum(row.allocatedQty)} packs`;
  const packs = row.allocatedQty;
  return `${packs} pack${packs !== 1 ? "s" : ""} (${fmtBase(packs * Number(row.packQty), row.unit)})`;
}

/** Per-row backorder label. */
function rowBackorderLabel(row: FulfillmentRow): string {
  if (row.backorderQty === 0) return "—";
  if (!row.isFGMode) return fmtBase(row.backorderQty, row.unit);
  if (!isPackValid(row)) return `${fmtNum(row.backorderQty)} packs`;
  const packs = row.backorderQty;
  return `${packs} pack${packs !== 1 ? "s" : ""} (${fmtBase(packs * Number(row.packQty), row.unit)})`;
}

// ─── Grouping by source/type — Safeguard 5 ───────────────────────────────────
//
// We must NOT infer storage location from item name.
// Real fields available on each group:
//   - isFGMode    (boolean) — FG vs raw inventory
//   - sourceType  (string | null) — 'hq_supplied' | 'local_vendor' | null
//   - unit         (string | null) — the base unit
//
// Groups available in the data — the first item's sourceType drives the section.

function getSection(g: FulfillmentGroup): string {
  if (g.isFGMode) return "HQ Finished Goods (Packs)";
  const st = (g.items[0]?.sourceType ?? "").toLowerCase().trim();
  if (st === "hq_supplied") return "HQ-Supplied Raw Inventory";
  if (st === "local_vendor") return "Local Vendor Items";
  return "General Inventory";
}

// ─── Date filter helpers (mirrors fulfillment screen) ────────────────────────
//
// The `date` field on requisitions is the submission/requisition date.
// We normalise any format (ISO or locale string) to YYYY-MM-DD for comparison.

type DateFilterMode = "today" | "tomorrow" | "this_week" | "custom" | "range" | "all";

function toIso(d: Date): string { return d.toISOString().slice(0, 10); }
function todayIso(): string { return toIso(new Date()); }
function tomorrowIso(): string { const d = new Date(); d.setDate(d.getDate() + 1); return toIso(d); }
function weekEndIso(): string {
  const d = new Date(); const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? 6 : 7 - day)); return toIso(d);
}

function normaliseReqDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return null;
  return toIso(parsed);
}

function fmtDisplayDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function resolveActiveDateRange(params: URLSearchParams): [string | null, string | null] {
  const mode = (params.get("dateMode") || "all") as DateFilterMode;
  const t = todayIso();
  switch (mode) {
    case "today":     return [t, t];
    case "tomorrow":  return [tomorrowIso(), tomorrowIso()];
    case "this_week": return [t, weekEndIso()];
    case "custom":    { const d = params.get("customDate") || t; return [d, d]; }
    case "range":     return [params.get("rangeFrom") || t, params.get("rangeTo") || t];
    case "all":       return [null, null];
  }
}

function dateFilterLabel(params: URLSearchParams): string {
  const mode = (params.get("dateMode") || "all") as DateFilterMode;
  const includeOverdue = params.get("includeOverdue") === "1";
  const extra = includeOverdue ? " + Overdue Open" : "";
  const t = todayIso();
  switch (mode) {
    case "today":     return `Today — submitted ${fmtDisplayDate(t)}${extra}`;
    case "tomorrow":  return `Tomorrow — submitted ${fmtDisplayDate(tomorrowIso())}${extra}`;
    case "this_week": return `This Week — submitted this week${extra}`;
    case "custom":    { const d = params.get("customDate") || t; return `submitted on ${fmtDisplayDate(d)}${extra}`; }
    case "range":     {
      const f = params.get("rangeFrom") || t, to = params.get("rangeTo") || t;
      return `submitted ${fmtDisplayDate(f)} – ${fmtDisplayDate(to)}${extra}`;
    }
    case "all":       return "All Open Requisitions (any submission date)";
  }
}

function batchRef(params: URLSearchParams): string | null {
  const mode = (params.get("dateMode") || "all") as DateFilterMode;
  if (mode === "all") return null;
  const t = todayIso();
  const base = mode === "today" ? t
    : mode === "tomorrow" ? tomorrowIso()
    : mode === "custom" ? (params.get("customDate") || t)
    : mode === "range" ? (params.get("rangeFrom") || t)
    : t;
  return `REQ-BATCH-${base.replace(/-/g, "")}-001`;
}

// ─── Architecture note ────────────────────────────────────────────────────────
// The `date` field on requisitions is the SUBMISSION date only.
// It does not represent when the goods are actually needed for delivery.
//
// TODO (future): Add a `required_by_date` (or `requested_delivery_date`) column
// to the requisitions table. Once that field exists:
//   - Fulfillment batching should filter by required_by_date, not date.
//   - Delivery planning and dispatch scheduling should also use required_by_date.
//   - The UI label can then say "Fulfillment Date" or "Required Delivery Date".
//   - filterSummary below filters item.requisitionDate which maps to req.date;
//     swap the source field here when the column is available.
// Until then, all filtering is by requisition SUBMISSION date and is labelled
// accordingly as "Requisition Date Batch".

// ─── Filter logic (mirrors fulfillment screen) ────────────────────────────────

function filterSummary(
  data: FulfillmentGroup[],
  params: URLSearchParams
): FulfillmentGroup[] {
  const scope = params.get("scope") || "visible";
  const search = String(params.get("search") ?? "").trim().toLowerCase();
  const location = params.get("location") || "all";
  const status = params.get("status") || "all";
  const selectedLocations = new Set(splitParam(params.get("locations")));
  const selectedRequisitions = new Set(splitParam(params.get("requisitions")));
  const selectedItems = new Set(splitParam(params.get("items")));

  // Date filter
  const [dateFrom, dateTo] = resolveActiveDateRange(params);
  const includeOverdue = params.get("includeOverdue") === "1";
  const noDateFilter = dateFrom === null && dateTo === null;

  const reqDateInBatch = (rawDate: string | null | undefined): boolean => {
    if (noDateFilter) return true;
    const iso = normaliseReqDate(rawDate);
    if (!iso) return false;
    if (dateFrom && iso >= dateFrom && dateTo && iso <= dateTo) return true;
    if (includeOverdue && dateFrom && iso < dateFrom) return true;
    return false;
  };

  return data
    .map((group) => {
      const groupMatchesSearch = !search || group.itemName.toLowerCase().includes(search);
      const groupSelected = scope !== "items" || selectedItems.has(group.itemName);

      const items = group.items.filter((item) => {
        if (!groupMatchesSearch || !groupSelected) return false;
        // Date filter applies to every item regardless of scope
        if (!reqDateInBatch(item.requisitionDate)) return false;
        if (scope === "visible") {
          if (location !== "all" && item.locationName !== location) return false;
          if (status !== "all" && item.requisitionStatus !== status) return false;
        }
        if (scope === "locations" && !selectedLocations.has(item.locationName)) return false;
        if (scope === "requisitions" && !selectedRequisitions.has(item.requisitionId)) return false;
        return true;
      });

      return {
        ...group,
        items,
        totalRequested: items.reduce((s, it) => s + Number(it.quantityRequested ?? 0), 0),
        totalAllocated: items.reduce((s, it) => s + Number(it.allocatedQty ?? 0), 0),
        totalBackorder: items.reduce((s, it) => s + Number(it.backorderQty ?? 0), 0),
      };
    })
    .filter((g) => g.items.length > 0);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FulfillmentPickListPrintPage() {
  const { user, loading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const [data, setData] = useState<FulfillmentGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasAutoPrinted = useRef(false);

  const allowed = isHqMaster(user) || isHqOps(user) || isHqFulfillment(user);
  const mode = searchParams.get("mode");
  const generatedAt = useMemo(() => new Date(), []);

  useEffect(() => {
    if (authLoading || !allowed) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const summary = await getFulfillmentSummary();
        if (!cancelled)
          setData(filterSummary(summary as FulfillmentGroup[], searchParams));
      } catch (err: any) {
        if (!cancelled)
          setError(err?.message ?? "Could not load fulfillment pick list.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, authLoading]);

  useEffect(() => {
    if (loading || error || data.length === 0 || mode !== "print") return;
    if (hasAutoPrinted.current) return;
    hasAutoPrinted.current = true;
    const t = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(t);
  }, [data.length, error, loading, mode]);

  // ── Derived data ────────────────────────────────────────────────────────────

  const flatRows: FulfillmentRow[] = useMemo(
    () =>
      data.flatMap((g) =>
        g.items.map((it) => ({
          ...it,
          isFGMode: it.isFGMode ?? g.isFGMode,
          packQty: it.packQty ?? g.packQty,
          unit: it.unit ?? g.unit,
        }))
      ),
    [data]
  );

  const locationNames = useMemo(
    () =>
      Array.from(new Set(flatRows.map((r) => r.locationName).filter(Boolean))).sort(),
    [flatRows]
  );

  const requisitionNums = useMemo(
    () =>
      Array.from(
        new Set(
          flatRows.map((r) => r.requisitionNumber || r.requisitionId).filter(Boolean)
        )
      ).sort(),
    [flatRows]
  );

  // Sections grouped by real source/type field (Safeguard 5)
  const sectionGroups = useMemo(() => {
    const map = new Map<string, FulfillmentGroup[]>();
    for (const g of data) {
      const section = getSection(g);
      if (!map.has(section)) map.set(section, []);
      map.get(section)!.push(g);
    }
    // Fixed canonical order
    const order = [
      "HQ Finished Goods (Packs)",
      "HQ-Supplied Raw Inventory",
      "Local Vendor Items",
      "General Inventory",
    ];
    return Array.from(map.entries()).sort(([a], [b]) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.localeCompare(b);
    });
  }, [data]);

  const backorderRows = useMemo(
    () => flatRows.filter((r) => Number(r.backorderQty ?? 0) > 0),
    [flatRows]
  );

  // Item count and location/requisition counts only — no cross-unit totals (Safeguard 1)
  const totalItems     = data.length;
  const totalLocations = locationNames.length;
  const totalReqs      = requisitionNums.length;
  const totalBO        = backorderRows.length; // line count, not qty sum

  // ── Guard states ────────────────────────────────────────────────────────────

  if (authLoading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-white text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading pick list…
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white p-8 text-sm font-semibold text-red-700">
        Access denied. HQ fulfillment access is required.
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white p-8 text-sm font-semibold text-red-700">
        {error}
      </div>
    );
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');

        /* ── Base ── */
        .pl-shell {
          font-family: Inter, ui-sans-serif, system-ui, sans-serif;
          color: #111827;
          background: #f1f5f9;
        }

        /* ── Screen toolbar ── */
        .pl-toolbar {
          max-width: 9in;
          margin: 0 auto 12px;
          padding: 0 4px;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .pl-pdf-hint {
          font-size: 11px;
          color: #1d4ed8;
          background: #eff6ff;
          border: 1px solid #bfdbfe;
          border-radius: 8px;
          padding: 6px 10px;
          font-weight: 600;
        }
        .pl-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border: 1px solid #cbd5e1;
          background: #fff;
          border-radius: 10px;
          padding: 8px 14px;
          font-family: inherit;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }
        .pl-btn-primary {
          background: #166534;
          border-color: #14532d;
          color: #fff;
        }

        /* ── Card / page wrapper ── */
        .pl-card {
          max-width: 9in;
          margin: 0 auto 18px;
          background: #fff;
          padding: 28px 32px;
          border-radius: 12px;
          box-shadow: 0 4px 24px rgba(15,23,42,0.10);
        }

        /* ── Page break helpers ── */
        .pl-section-break {
          break-before: page;
          page-break-before: always;
        }

        /* ── Document header ── */
        .pl-doc-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          border-bottom: 2.5px solid #111827;
          padding-bottom: 14px;
          margin-bottom: 16px;
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .pl-brand {
          font-size: 10px;
          font-weight: 900;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #6b7280;
          margin-bottom: 4px;
        }
        .pl-doc-title {
          font-size: 22px;
          font-weight: 900;
          letter-spacing: -0.02em;
          margin: 0 0 4px;
        }
        .pl-doc-sub {
          font-size: 11px;
          color: #6b7280;
          margin-top: 3px;
          line-height: 1.7;
        }
        .pl-doc-sub strong { color: #111827; }
        .pl-doc-meta {
          text-align: right;
          font-size: 11px;
          color: #6b7280;
          white-space: nowrap;
        }
        .pl-doc-meta strong { color: #111827; font-size: 13px; }

        /* ── Count stats (items / locations / requisitions / backorder lines)
         *   Safeguard 1: no cross-unit quantity sums in header stats.
         *   We show only item counts and line counts — never summed base qty.
         */
        .pl-stats {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
          margin-bottom: 20px;
        }
        .pl-stat {
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 8px 10px;
        }
        .pl-stat-label {
          font-size: 9px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #6b7280;
          margin-bottom: 2px;
        }
        .pl-stat-val {
          font-size: 16px;
          font-weight: 900;
          color: #111827;
        }
        .pl-stat-sub {
          font-size: 9px;
          color: #9ca3af;
          margin-top: 1px;
        }
        .pl-stat-bo .pl-stat-val  { color: #b45309; }
        .pl-stat-ok .pl-stat-val  { color: #166534; }

        /* ── Section header (replaces "zone" — uses real source field) ── */
        .pl-section-hdr {
          background: #f0fdf4;
          border: 1px solid #86efac;
          border-radius: 8px 8px 0 0;
          padding: 7px 12px;
          margin-top: 18px;
          display: flex;
          align-items: center;
          gap: 8px;
          break-inside: avoid;
          page-break-inside: avoid;
          break-after: avoid;
          page-break-after: avoid;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .pl-section-hdr-title {
          font-size: 10px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #166534;
        }
        .pl-section-hdr-count {
          font-size: 10px;
          color: #4b5563;
          margin-left: auto;
        }

        /* ── Main pick table ── */
        .pl-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 11px;
          table-layout: auto;
        }
        /* CRITICAL: thead repeats on every printed page */
        .pl-table thead { display: table-header-group; }
        .pl-table tfoot { display: table-footer-group; }
        .pl-table thead th {
          background: #f8fafc;
          border: 1px solid #d1d5db;
          padding: 7px 8px;
          text-align: left;
          font-size: 9px;
          font-weight: 900;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #374151;
          vertical-align: bottom;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .pl-table thead th.th-green {
          background: #f0fdf4 !important;
          color: #166534;
          border-color: #86efac;
        }
        .pl-table tbody td {
          border: 1px solid #e5e7eb;
          padding: 9px 8px;
          vertical-align: top;
        }
        /* CRITICAL: rows never split across a page break */
        .pl-table tbody tr {
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .pl-table tbody tr:nth-child(even) { background: #f9fafb; }
        .pl-table tbody tr:hover { background: #f0fdf4; }

        /* ── Column widths ── */
        .col-check  { width: 30px; text-align: center; font-size: 16px; }
        .col-pack   { width: 120px; }
        .col-pull   { width: 100px; }
        .col-total  { width: 100px; }
        .col-signed { width: 80px; }
        .col-notes  { min-width: 70px; }

        /* ── Pull quantity emphasis ── */
        .pull-val {
          font-weight: 900;
          font-size: 13px;
          color: #065f46;
        }
        .pull-base {
          font-size: 9px;
          color: #6b7280;
          margin-top: 1px;
        }

        /* ── Missing pack config warning (Safeguard 4) ── */
        .pack-missing {
          display: inline-block;
          font-size: 9px;
          font-weight: 700;
          color: #b45309;
          background: #fffbeb;
          border: 1px solid #fbbf24;
          border-radius: 4px;
          padding: 1px 5px;
          margin-top: 3px;
        }

        /* ── Backorder inline warning ── */
        .bo-warn {
          font-size: 10px;
          font-weight: 700;
          color: #b45309;
        }

        /* ── Allocation sheet item header ── */
        .item-hdr {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          background: #f8fafc;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          padding: 10px 14px;
          margin-bottom: 8px;
          break-inside: avoid;
          page-break-inside: avoid;
          break-after: avoid;
          page-break-after: avoid;
        }
        .item-hdr-name { font-size: 14px; font-weight: 900; color: #111827; }
        .item-hdr-meta { font-size: 10px; color: #6b7280; margin-top: 3px; line-height: 1.5; }
        .item-hdr-totals { display: flex; gap: 16px; text-align: right; font-size: 11px; }
        .item-hdr-tv { font-size: 14px; font-weight: 900; color: #111827; }

        /* ── Backorder rows ── */
        .bo-row td { background: #fffbeb !important; }

        /* ── Section title ── */
        .pl-section-title {
          font-size: 16px;
          font-weight: 900;
          color: #111827;
          margin: 0 0 10px;
          padding-bottom: 6px;
          border-bottom: 1.5px solid #e5e7eb;
        }
        .pl-section-title-bo { color: #b45309; }

        /* ── Sign-off grid ── */
        .pl-signoff {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 16px;
          margin-top: 20px;
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .pl-signoff-line { border-bottom: 1px solid #111827; height: 30px; margin-top: 14px; }
        .pl-signoff-label { margin-top: 4px; font-size: 9px; font-weight: 800; color: #4b5563; text-transform: uppercase; letter-spacing: 0.08em; }

        /* ── Appendix ── */
        .pl-appendix-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
        .pl-appendix-subhdr {
          font-size: 10px; font-weight: 900; text-transform: uppercase;
          letter-spacing: 0.08em; color: #374151; margin-bottom: 8px;
          border-bottom: 1px solid #e5e7eb; padding-bottom: 4px;
        }
        .pl-appendix-list {
          font-size: 10px; color: #374151; line-height: 1.8;
          padding-left: 0; list-style: none;
        }

        /* ── Screen-only footer ── */
        .pl-screen-footer {
          font-size: 10px; color: #9ca3af;
          display: flex; justify-content: space-between;
          margin-top: 16px; padding-top: 8px;
          border-top: 1px solid #e5e7eb;
        }

        /* ═══════════════════════════════════════════════════════════════════
         * @media print — multi-page output
         *
         * All ancestors that could have height:100vh or overflow:hidden
         * must be reset to height:auto + overflow:visible in print.
         * This is the fix for the "1 page" truncation bug.
         */
        @media print {
          html, body {
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: visible !important;
            background: white !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          #__next,
          [data-nextjs-scroll-focus-boundary],
          body > div {
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: visible !important;
            position: static !important;
          }
          .pl-shell {
            height: auto !important;
            min-height: 0 !important;
            overflow: visible !important;
            background: white !important;
            padding: 0 !important;
          }
          .pl-toolbar { display: none !important; }
          .pl-card {
            max-width: none; margin: 0; padding: 0;
            box-shadow: none; border-radius: 0;
          }
          .pl-table thead { display: table-header-group !important; }
          .pl-table tfoot { display: table-footer-group !important; }
          .pl-table tbody tr {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }
          .pl-table tbody tr:hover { background: transparent !important; }
          .pl-table thead th,
          .pl-section-hdr,
          .bo-row td {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .pl-screen-footer { display: none !important; }
        }

        @page { size: letter portrait; margin: 12mm 14mm; }
      `}</style>

      <div
        className="pl-shell"
        style={{ minHeight: "100vh", paddingTop: 24, paddingBottom: 48 }}
      >
        {/* Screen toolbar */}
        <div className="pl-toolbar">
          <div className="pl-pdf-hint">
            💡 File → Print → Destination → Save as PDF
          </div>
          <button
            className="pl-btn pl-btn-primary"
            style={{ marginLeft: "auto" }}
            onClick={() => window.print()}
          >
            <Printer style={{ height: 14, width: 14 }} /> Print / Save PDF
          </button>
          <button className="pl-btn" onClick={() => window.close()}>
            Close
          </button>
        </div>

        {/* ══════════════════════════════════════════════════════════════════
         * PAGE 1 — HQ FULFILLMENT PICK SUMMARY
         *
         * Safeguard 1: Stats show COUNTS (items, locations, requisitions,
         *   backorder LINES) — not summed quantities across different units.
         * Safeguard 5: Items grouped by real source/type field, not inferred
         *   from item name.
         * Safeguard 9: This is the first page. Appendix is last.
         */}
        <div className="pl-card">
          {/* Header */}
          <header className="pl-doc-header">
            <div>
              <div className="pl-brand">Stock Dharma · Warehouse Operations</div>
              <h1 className="pl-doc-title">HQ FULFILLMENT PICK LIST</h1>
              {/* Batch ref and requisition date batch */}
              {batchRef(searchParams) && (
                <div className="pl-doc-sub" style={{ marginBottom: 2 }}>
                  Requisition Batch:{" "}
                  <strong style={{ fontFamily: "monospace", letterSpacing: "0.05em", color: "#1d4ed8" }}>
                    {batchRef(searchParams)}
                  </strong>
                </div>
              )}
              <div className="pl-doc-sub">
                Requisition Date Batch:{" "}
                <strong>{dateFilterLabel(searchParams)}</strong>
              </div>
              <div className="pl-doc-sub">
                Prepared by:{" "}
                <strong>{user?.name || user?.email || "HQ Staff"}</strong>
                {"  ·  "}
                <strong>{totalItems}</strong> item{totalItems !== 1 ? "s" : ""}
                {"  ·  "}
                <strong>{totalLocations}</strong> location{totalLocations !== 1 ? "s" : ""}
                {"  ·  "}
                <strong>{totalReqs}</strong> requisition{totalReqs !== 1 ? "s" : ""}
                {totalBO > 0 && (
                  <>
                    {"  ·  "}
                    <span style={{ color: "#b45309", fontWeight: 700 }}>
                      ⚠ {totalBO} backorder line{totalBO !== 1 ? "s" : ""}
                    </span>
                  </>
                )}
              </div>
              <div className="pl-doc-sub" style={{ color: "#9ca3af", fontSize: 10 }}>
                Quantities shown per item in their own unit.
                Pack counts and base quantities are not mixed or summed.
              </div>
            </div>
            <div className="pl-doc-meta">
              <div>Print Date</div>
              <strong>{generatedAt.toLocaleDateString()}</strong>
              <div style={{ marginTop: 5 }}>Time</div>
              <strong>{generatedAt.toLocaleTimeString()}</strong>
            </div>
          </header>


          {/* Stats — counts only, no cross-unit sums (Safeguard 1) */}
          <div className="pl-stats">
            <div className="pl-stat">
              <div className="pl-stat-label">Line Items</div>
              <div className="pl-stat-val">{totalItems}</div>
            </div>
            <div className="pl-stat">
              <div className="pl-stat-label">Locations</div>
              <div className="pl-stat-val">{totalLocations}</div>
            </div>
            <div className="pl-stat">
              <div className="pl-stat-label">Requisitions</div>
              <div className="pl-stat-val">{totalReqs}</div>
            </div>
            <div className={`pl-stat ${totalBO > 0 ? "pl-stat-bo" : "pl-stat-ok"}`}>
              <div className="pl-stat-label">Backorder Lines</div>
              <div className="pl-stat-val">{totalBO}</div>
              <div className="pl-stat-sub">
                {totalBO === 0 ? "All lines allocated" : "require follow-up"}
              </div>
            </div>
          </div>

          {/* Pick summary table, grouped by source/type section */}
          {data.length === 0 ? (
            <div
              style={{
                padding: "32px",
                textAlign: "center",
                color: "#6b7280",
                fontSize: 13,
                border: "2px dashed #e5e7eb",
                borderRadius: 8,
              }}
            >
              No fulfillment lines match this print selection.
            </div>
          ) : (
            <>
              {sectionGroups.map(([section, groups]) => (
                <div key={section}>
                  {/* Section header uses real source/type, not item-name inference */}
                  <div className="pl-section-hdr">
                    <span className="pl-section-hdr-title">{section}</span>
                    <span className="pl-section-hdr-count">
                      {groups.length} item{groups.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <table className="pl-table">
                    <thead>
                      <tr>
                        <th className="col-check th-green">✓</th>
                        <th className="th-green">Item Name</th>
                        <th className="col-pack th-green">Pack / Unit</th>
                        {/* Safeguard 2: Pull Qty = packs for FG, base for loose */}
                        <th className="col-pull th-green">Pull Qty</th>
                        <th className="col-total th-green">Total to Stage</th>
                        <th className="col-signed th-green">Checked By</th>
                        <th className="col-notes th-green">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((group) => {
                        const packMissing =
                          group.isFGMode &&
                          (group.packQty == null || Number(group.packQty) === 0);
                        const hasBO = group.totalBackorder > 0;
                        return (
                          <tr key={group.itemName}>
                            <td className="col-check" style={{ fontSize: 18 }}>
                              □
                            </td>
                            <td>
                              <div style={{ fontWeight: 700, fontSize: 12 }}>
                                {group.itemName}
                              </div>
                              <div style={{ fontSize: 9, color: "#6b7280", marginTop: 1 }}>
                                {group.items.length} location
                                {group.items.length !== 1 ? "s" : ""}
                              </div>
                              {/* Safeguard 4 */}
                              {packMissing && (
                                <span className="pack-missing">
                                  Pack configuration missing — confirm before picking
                                </span>
                              )}
                              {/* Backorder inline notice */}
                              {hasBO && !packMissing && (
                                <div className="bo-warn" style={{ marginTop: 2 }}>
                                  ⚠{" "}
                                  {rowBackorderLabel({
                                    ...group.items[0],
                                    backorderQty: group.totalBackorder,
                                    allocatedQty: 0,
                                    quantityRequested: 0,
                                    isFGMode: group.isFGMode,
                                    packQty: group.packQty,
                                    unit: group.unit,
                                    id: "",
                                    requisitionId: "",
                                    requisitionNumber: "",
                                    requisitionDate: "",
                                    requisitionStatus: "",
                                    locationName: "",
                                    locationId: "",
                                    fulfillmentNote: "",
                                    sourceType: null,
                                  })}{" "}
                                  backordered
                                </div>
                              )}
                            </td>
                            <td className="col-pack">
                              {packMissing ? (
                                <span style={{ color: "#9ca3af", fontSize: 10 }}>—</span>
                              ) : (
                                <span style={{ fontSize: 11, color: "#374151" }}>
                                  {packSizeLabel(group)}
                                </span>
                              )}
                            </td>
                            <td className="col-pull">
                              {packMissing ? (
                                <span style={{ color: "#b45309", fontSize: 10, fontWeight: 700 }}>
                                  Confirm
                                </span>
                              ) : (
                                <>
                                  <div className="pull-val">{groupPullLabel(group)}</div>
                                  {/* Show base qty below pack count for FG items */}
                                  {group.isFGMode && isPackValid(group) && (
                                    <div className="pull-base">
                                      = {fmtBase(
                                        group.totalAllocated * Number(group.packQty),
                                        group.unit
                                      )}
                                    </div>
                                  )}
                                </>
                              )}
                            </td>
                            <td className="col-total">
                              {packMissing ? (
                                <span style={{ color: "#9ca3af" }}>—</span>
                              ) : (
                                <span style={{ fontWeight: 600, fontSize: 12 }}>
                                  {groupTotalStaged(group)}
                                </span>
                              )}
                            </td>
                            <td className="col-signed" />
                            <td className="col-notes" />
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}

              {/* Pick summary sign-off */}
              <div className="pl-signoff">
                {["Prepared By", "Verified By", "Date / Time"].map((label) => (
                  <div key={label}>
                    <div className="pl-signoff-line" />
                    <div className="pl-signoff-label">{label}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="pl-screen-footer">
            <span>Stock Dharma · HQ Fulfillment Pick List</span>
            <span>{generatedAt.toLocaleString()}</span>
          </div>
        </div>

        {/* ══════════════════════════════════════════════════════════════════
         * PAGE 2+ — ITEM ALLOCATION / DISTRIBUTION SHEETS
         *
         * Safeguard 7: allocation detail moved here, separated from summary.
         * Safeguard 9: comes after pick summary, before backorders.
         */}
        {data.length > 0 && (
          <div className="pl-card pl-section-break">
            <h2 className="pl-section-title">
              Item Allocation &amp; Distribution Sheets
            </h2>
            <p
              style={{
                fontSize: 11,
                color: "#6b7280",
                marginBottom: 18,
                marginTop: -6,
              }}
            >
              Per-location allocation detail. Use these sheets to pack and label
              orders by destination. Pack math is only shown where a valid pack
              configuration exists.
            </p>

            {data.map((group) => {
              const packMissing =
                group.isFGMode &&
                (group.packQty == null || Number(group.packQty) === 0);
              return (
                <div
                  key={group.itemName}
                  style={{
                    marginBottom: 24,
                    breakInside: "avoid",
                    pageBreakInside: "avoid",
                  }}
                >
                  {/* Item card header */}
                  <div className="item-hdr">
                    <div>
                      <div className="item-hdr-name">{group.itemName}</div>
                      <div className="item-hdr-meta">
                        {packMissing ? (
                          <span className="pack-missing">
                            Pack configuration missing — confirm before picking
                          </span>
                        ) : (
                          <>
                            Pack: <strong>{packSizeLabel(group)}</strong>
                            {"  ·  "}
                            Pull: <strong>{groupPullLabel(group)}</strong>
                            {"  ·  "}
                            Stage: <strong>{groupTotalStaged(group)}</strong>
                          </>
                        )}
                      </div>
                    </div>
                    {!packMissing && (
                      <div className="item-hdr-totals">
                        <div>
                          <div
                            style={{
                              fontSize: 9,
                              color: "#6b7280",
                              fontWeight: 700,
                              textTransform: "uppercase",
                            }}
                          >
                            Allocated
                          </div>
                          <div className="item-hdr-tv" style={{ color: "#166534" }}>
                            {groupPullLabel(group)}
                          </div>
                        </div>
                        {group.totalBackorder > 0 && (
                          <div>
                            <div
                              style={{
                                fontSize: 9,
                                color: "#b45309",
                                fontWeight: 700,
                                textTransform: "uppercase",
                              }}
                            >
                              Backordered
                            </div>
                            <div className="item-hdr-tv" style={{ color: "#b45309" }}>
                              {rowBackorderLabel({
                                backorderQty: group.totalBackorder,
                                isFGMode: group.isFGMode,
                                packQty: group.packQty,
                                unit: group.unit,
                                allocatedQty: 0,
                                quantityRequested: 0,
                                id: "",
                                requisitionId: "",
                                requisitionNumber: "",
                                requisitionDate: "",
                                requisitionStatus: "",
                                locationName: "",
                                locationId: "",
                                fulfillmentNote: "",
                                sourceType: null,
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <table className="pl-table">
                    <thead>
                      <tr>
                        <th>Location</th>
                        <th>Req #</th>
                        <th>Requested</th>
                        <th>Allocated</th>
                        <th>Backordered</th>
                        <th style={{ width: 60, textAlign: "center" }}>
                          Packed ✓
                        </th>
                        <th>Fulfillment Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map((item) => (
                        <tr
                          key={item.id}
                          className={item.backorderQty > 0 ? "bo-row" : ""}
                        >
                          <td>
                            <div style={{ fontWeight: 700, fontSize: 11 }}>
                              {item.locationName}
                            </div>
                            <div style={{ fontSize: 9, color: "#6b7280" }}>
                              {item.requisitionDate || ""}
                            </div>
                          </td>
                          <td style={{ fontFamily: "monospace", fontSize: 10 }}>
                            {item.requisitionNumber || item.requisitionId}
                          </td>
                          <td>{rowRequestedLabel(item)}</td>
                          <td>
                            <strong>{rowAllocLabel(item)}</strong>
                          </td>
                          <td>
                            {item.backorderQty > 0 ? (
                              <span className="bo-warn">
                                {rowBackorderLabel(item)}
                              </span>
                            ) : (
                              <span style={{ color: "#9ca3af" }}>—</span>
                            )}
                          </td>
                          <td style={{ textAlign: "center", fontSize: 18 }}>
                            □
                          </td>
                          <td style={{ fontSize: 10, color: "#374151" }}>
                            {item.fulfillmentNote || ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
         * BACKORDERS — only rendered when backorders exist (Safeguard 8)
         * Safeguard 9: after allocation sheets, before source register.
         */}
        {backorderRows.length > 0 && (
          <div className="pl-card pl-section-break">
            <h2 className="pl-section-title pl-section-title-bo">
              ⚠ Backorders &amp; Exceptions
            </h2>
            <p
              style={{
                fontSize: 11,
                color: "#6b7280",
                marginBottom: 14,
                marginTop: -6,
              }}
            >
              {backorderRows.length} line
              {backorderRows.length !== 1 ? "s" : ""} with outstanding
              backorders. Follow up before dispatch.
            </p>

            <table className="pl-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Location</th>
                  <th>Req #</th>
                  <th>Backordered Qty</th>
                  <th>Fulfillment Note</th>
                  {/* Safeguard 8: Follow-up Status column */}
                  <th>Follow-up Status</th>
                </tr>
              </thead>
              <tbody>
                {backorderRows.map((row) => {
                  const parentGroup = data.find((g) =>
                    g.items.some((it) => it.id === row.id)
                  );
                  return (
                    <tr key={`bo-${row.id}`} className="bo-row">
                      <td style={{ fontWeight: 700 }}>
                        {parentGroup?.itemName ?? ""}
                      </td>
                      <td>{row.locationName}</td>
                      <td style={{ fontFamily: "monospace", fontSize: 10 }}>
                        {row.requisitionNumber || row.requisitionId}
                      </td>
                      <td>
                        <span className="bo-warn">
                          {rowBackorderLabel(row)}
                        </span>
                      </td>
                      <td style={{ fontSize: 10 }}>
                        {row.fulfillmentNote || ""}
                      </td>
                      {/* Follow-up Status write-in */}
                      <td />
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="pl-signoff" style={{ marginTop: 24 }}>
              {[
                "Backorder Coordinator",
                "Date Actioned",
                "Resolution / Notes",
              ].map((label) => (
                <div key={label}>
                  <div className="pl-signoff-line" />
                  <div className="pl-signoff-label">{label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
         * APPENDIX — SOURCE REGISTER
         * Safeguard 1: The only page that lists all location names and
         *   requisition numbers. Never appears on the first page.
         * Safeguard 9: must be last.
         */}
        {data.length > 0 && (
          <div className="pl-card pl-section-break">
            <h2 className="pl-section-title">
              Appendix — Full Fulfillment Source Register
            </h2>
            <p
              style={{
                fontSize: 11,
                color: "#6b7280",
                marginBottom: 16,
                marginTop: -6,
              }}
            >
              Complete record of all locations and requisitions included in this
              pick list. For audit and traceability purposes only — do not use
              for picking.
            </p>

            <div className="pl-appendix-grid">
              <div>
                <div className="pl-appendix-subhdr">
                  Locations ({locationNames.length})
                </div>
                <ol className="pl-appendix-list">
                  {locationNames.map((loc, i) => (
                    <li key={loc}>
                      {i + 1}. {loc}
                    </li>
                  ))}
                </ol>
              </div>
              <div>
                <div className="pl-appendix-subhdr">
                  Requisitions ({requisitionNums.length})
                </div>
                <ol className="pl-appendix-list" style={{ columnCount: 2, columnGap: 12 }}>
                  {requisitionNums.map((req, i) => (
                    <li key={req}>
                      {i + 1}. {req}
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <div
              style={{
                marginTop: 24,
                fontSize: 10,
                color: "#9ca3af",
                display: "flex",
                justifyContent: "space-between",
                borderTop: "1px solid #e5e7eb",
                paddingTop: 8,
              }}
            >
              <span>
                Stock Dharma · HQ Fulfillment · Printed by{" "}
                {user?.name || user?.email || "HQ Staff"}
              </span>
              <span>{generatedAt.toLocaleString()}</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
