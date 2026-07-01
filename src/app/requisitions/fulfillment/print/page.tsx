"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Printer } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { isHqFulfillment, isHqMaster, isHqOps } from "@/lib/roles";
import { getFulfillmentSummary } from "@/lib/storage";

// ─── Types ────────────────────────────────────────────────────────────────────

type FulfillmentGroup = {
  itemName: string;
  unit: string;
  isFGMode: boolean;
  packQty: number;
  totalRequested: number;
  totalAllocated: number;
  totalBackorder: number;
  items: FulfillmentRow[];
};

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
  packQty: number;
  unit: string;
};

// ─── URL param helpers ────────────────────────────────────────────────────────

const asBool = (value: string | null, fallback: boolean) => {
  if (value == null) return fallback;
  return value === "1" || value === "true";
};

const splitParam = (value: string | null) =>
  String(value ?? "")
    .split(",")
    .map((v) => decodeURIComponent(v).trim())
    .filter(Boolean);

// ─── Pack display helpers ─────────────────────────────────────────────────────
//
// Quantity semantics (mirrors storage.ts):
//   isFGMode = true  → quantityRequested / allocatedQty are PACK COUNTS
//                      base qty = packCount × packQty
//   isFGMode = false → quantities are already BASE UNITS
//
// These helpers are the single source of truth for how we display
// pick quantities throughout the document.

function packSizeLabel(group: FulfillmentGroup): string {
  if (!group.isFGMode) return group.unit || "ea";
  if (group.packQty > 1) return `${group.packQty} ${group.unit || "ea"} / pack`;
  return `${group.unit || "ea"} / ea`;
}

function pullLabel(group: FulfillmentGroup): string {
  if (!group.isFGMode) return fmtBase(group.totalAllocated, group.unit);
  const packs = group.totalAllocated;
  return packs === 0 ? "0 packs" : `${packs} pack${packs !== 1 ? "s" : ""}`;
}

function totalStagedLabel(group: FulfillmentGroup): string {
  if (!group.isFGMode) return fmtBase(group.totalAllocated, group.unit);
  return fmtBase(group.totalAllocated * (group.packQty || 1), group.unit);
}

function rowPullLabel(row: FulfillmentRow): string {
  if (!row.isFGMode) return fmtBase(row.allocatedQty, row.unit);
  const packs = row.allocatedQty;
  return packs === 0 ? "0 packs" : `${packs} pack${packs !== 1 ? "s" : ""}`;
}

function rowBaseLabel(row: FulfillmentRow): string {
  if (!row.isFGMode) return fmtBase(row.allocatedQty, row.unit);
  return fmtBase(row.allocatedQty * (row.packQty || 1), row.unit);
}

function rowRequestedLabel(row: FulfillmentRow): string {
  if (!row.isFGMode) return fmtBase(row.quantityRequested, row.unit);
  const packs = row.quantityRequested;
  const base = packs * (row.packQty || 1);
  return `${packs} pack${packs !== 1 ? "s" : ""} (${fmtBase(base, row.unit)})`;
}

function rowBackorderLabel(row: FulfillmentRow): string {
  if (row.backorderQty === 0) return "—";
  if (!row.isFGMode) return fmtBase(row.backorderQty, row.unit);
  const packs = row.backorderQty;
  const base = packs * (row.packQty || 1);
  return `${packs} pack${packs !== 1 ? "s" : ""} (${fmtBase(base, row.unit)})`;
}

function fmtBase(qty: number, unit?: string | null): string {
  const n = Number.isInteger(qty) ? String(qty) : qty.toFixed(2).replace(/\.?0+$/, "");
  return unit ? `${n} ${unit}` : n;
}

// ─── Storage zone assignment ──────────────────────────────────────────────────
//
// Items are grouped by a storage zone heuristic based on item name keywords.
// This is a display-only classification and does not touch inventory logic.

const ZONE_RULES: [RegExp, string][] = [
  [/freezer|frozen|ice cream|gelato|popsicle|sorbet/i, "Freezer"],
  [/chick|chicken|fish|lamb|beef|pork|mutton|seafood|prawn|shrimp|crab|tuna|salmon/i, "Cold Storage — Proteins"],
  [/milk|dairy|cheese|cream|yogurt|butter|ghee/i, "Cold Storage — Dairy"],
  [/sauce|ketchup|chutney|pickle|vinegar|mustard|mayo|dressing|condiment/i, "Sauces & Condiments"],
  [/masala|spice|chili|chilli|pepper|cumin|turmeric|coriander|herb|seasoning/i, "Dry — Spices & Seasonings"],
  [/rice|flour|grain|lentil|dal|legume|pulse|bean|chickpea|wheat|oats/i, "Dry — Grains & Pulses"],
  [/oil|ghee|shortening|fat/i, "Dry — Oils & Fats"],
  [/sugar|salt|baking|powder|starch|yeast/i, "Dry — Baking & Staples"],
  [/batter|dough|bread|bun|roti|naan|paratha|wrap/i, "Prepared — Breads & Batters"],
  [/ready|cooked|prepared|meal|biryani|curry|stew/i, "Prepared — Ready Foods"],
  [/juice|drink|beverage|water|soda|syrup/i, "Beverages"],
  [/box|bag|container|wrap|foil|packaging|label|sticker|napkin|tissue|glove/i, "Packaging & Supplies"],
];

function getStorageZone(itemName: string): string {
  for (const [pattern, zone] of ZONE_RULES) {
    if (pattern.test(itemName)) return zone;
  }
  return "General Storage";
}

// ─── Filter logic (mirrors fulfillment screen) ────────────────────────────────

function filterSummary(data: FulfillmentGroup[], params: URLSearchParams): FulfillmentGroup[] {
  const scope = params.get("scope") || "visible";
  const search = String(params.get("search") ?? "").trim().toLowerCase();
  const location = params.get("location") || "all";
  const status = params.get("status") || "all";
  const selectedLocations = new Set(splitParam(params.get("locations")));
  const selectedRequisitions = new Set(splitParam(params.get("requisitions")));
  const selectedItems = new Set(splitParam(params.get("items")));

  return data
    .map((group) => {
      const groupMatchesSearch =
        !search || group.itemName.toLowerCase().includes(search);
      const groupSelected =
        scope !== "items" || selectedItems.has(group.itemName);

      const items = group.items.filter((item) => {
        if (!groupMatchesSearch || !groupSelected) return false;
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
    return () => { cancelled = true; };
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
    () => data.flatMap((g) => g.items.map((it) => ({ ...it, isFGMode: it.isFGMode ?? g.isFGMode, packQty: it.packQty ?? g.packQty, unit: it.unit ?? g.unit }))),
    [data]
  );

  const locationNames = useMemo(
    () => Array.from(new Set(flatRows.map((r) => r.locationName).filter(Boolean))).sort(),
    [flatRows]
  );

  const requisitionNums = useMemo(
    () => Array.from(new Set(flatRows.map((r) => r.requisitionNumber || r.requisitionId).filter(Boolean))).sort(),
    [flatRows]
  );

  // Groups organised by storage zone for pick summary
  const zoneGroups = useMemo(() => {
    const map = new Map<string, FulfillmentGroup[]>();
    for (const g of data) {
      const zone = getStorageZone(g.itemName);
      if (!map.has(zone)) map.set(zone, []);
      map.get(zone)!.push(g);
    }
    // Sort zones: Freezer first, General last
    const zoneOrder = ["Freezer", "Cold Storage — Proteins", "Cold Storage — Dairy"];
    return Array.from(map.entries()).sort(([a], [b]) => {
      const ai = zoneOrder.indexOf(a);
      const bi = zoneOrder.indexOf(b);
      if (a === "General Storage") return 1;
      if (b === "General Storage") return -1;
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

  const totalAlloc = data.reduce((s, g) => s + g.totalAllocated, 0);
  const totalBO    = data.reduce((s, g) => s + g.totalBackorder, 0);
  const totalReq   = data.reduce((s, g) => s + g.totalRequested, 0);

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

  // ── Render ─────────────────────────────────────────────────────────────────

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
          line-height: 1.6;
        }
        .pl-doc-meta {
          text-align: right;
          font-size: 11px;
          color: #6b7280;
          white-space: nowrap;
        }
        .pl-doc-meta strong { color: #111827; font-size: 13px; }

        /* ── Stats row ── */
        .pl-stats {
          display: grid;
          grid-template-columns: repeat(6, minmax(0, 1fr));
          gap: 8px;
          margin-bottom: 18px;
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
          font-size: 14px;
          font-weight: 900;
          color: #111827;
        }
        .pl-stat-sub {
          font-size: 9px;
          color: #9ca3af;
          margin-top: 1px;
        }

        /* ── Zone group headers ── */
        .pl-zone-header {
          background: #f0fdf4;
          border: 1px solid #86efac;
          border-radius: 8px 8px 0 0;
          padding: 8px 12px;
          margin-top: 18px;
          display: flex;
          align-items: center;
          gap: 8px;
          break-inside: avoid;
          page-break-inside: avoid;
          break-after: avoid;
          page-break-after: avoid;
        }
        .pl-zone-title {
          font-size: 11px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #166534;
        }
        .pl-zone-count {
          font-size: 10px;
          color: #4b5563;
          margin-left: auto;
        }

        /* ── Tables ────────────────────────────────────────────────────────────
         * Critical print rules:
         *   thead { display: table-header-group } → repeats on every page
         *   tr { break-inside: avoid }            → rows don't split
         */
        .pl-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 11px;
          table-layout: auto;
        }
        .pl-table thead {
          display: table-header-group;
        }
        .pl-table tfoot {
          display: table-footer-group;
        }
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
        .pl-table tbody tr {
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .pl-table tbody tr:nth-child(even) { background: #f9fafb; }
        .pl-table tbody tr:hover { background: #f0fdf4; }

        /* ── Pick summary specific columns ── */
        .col-check  { width: 30px; text-align: center; font-size: 16px; }
        .col-zone   { width: 100px; }
        .col-pack   { width: 110px; }
        .col-pull   { width: 90px; font-weight: 700; }
        .col-total  { width: 90px; }
        .col-signed { width: 80px; }
        .col-notes  { min-width: 80px; }

        /* ── Pull quantity highlight ── */
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
        .bo-warn {
          font-size: 10px;
          font-weight: 700;
          color: #b45309;
        }

        /* ── Item section headers (allocation sheets) ── */
        .item-sheet-header {
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
        .item-sheet-name {
          font-size: 14px;
          font-weight: 900;
          color: #111827;
        }
        .item-sheet-meta {
          font-size: 10px;
          color: #6b7280;
          margin-top: 3px;
          line-height: 1.5;
        }
        .item-sheet-totals {
          display: flex;
          gap: 16px;
          text-align: right;
          font-size: 11px;
        }
        .item-sheet-total-val {
          font-size: 14px;
          font-weight: 900;
          color: #111827;
        }

        /* ── Backorder table ── */
        .bo-row td { background: #fffbeb !important; }

        /* ── Section titles ── */
        .pl-section-title {
          font-size: 16px;
          font-weight: 900;
          letter-spacing: -0.01em;
          color: #111827;
          margin: 0 0 12px;
          padding-bottom: 6px;
          border-bottom: 1.5px solid #e5e7eb;
        }

        /* ── Sign-off row ── */
        .pl-signoff {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 16px;
          margin-top: 20px;
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .pl-signoff-line {
          border-bottom: 1px solid #111827;
          height: 30px;
          margin-top: 14px;
        }
        .pl-signoff-label {
          margin-top: 4px;
          font-size: 9px;
          font-weight: 800;
          color: #4b5563;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        /* ── Appendix ── */
        .pl-appendix-list {
          font-size: 10px;
          color: #374151;
          line-height: 1.8;
          column-count: 3;
          column-gap: 16px;
        }

        /* ── Screen-only footer ── */
        .pl-screen-footer {
          font-size: 10px;
          color: #9ca3af;
          display: flex;
          justify-content: space-between;
          margin-top: 16px;
          padding-top: 8px;
          border-top: 1px solid #e5e7eb;
        }

        /* ═══════════════════════════════════════════════════════════════════
         * @media print — full multi-page output
         *
         * Root cause of "1 page" truncation: any ancestor with
         * min-height:100vh or overflow:hidden clips the print viewport.
         * We must reset all of them here.
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
            max-width: none;
            margin: 0 0 0 0;
            padding: 0;
            box-shadow: none;
            border-radius: 0;
          }
          .pl-card + .pl-card { margin-top: 0; }
          .pl-table thead {
            display: table-header-group !important;
          }
          .pl-table tfoot {
            display: table-footer-group !important;
          }
          .pl-table tbody tr {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }
          .pl-table tbody tr:hover { background: transparent !important; }
          .pl-table thead th {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .pl-screen-footer { display: none !important; }
          .pl-zone-header {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .bo-row td {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            background: #fffbeb !important;
          }
        }

        @page {
          size: letter portrait;
          margin: 12mm 14mm;
        }
      `}</style>

      <div
        className="pl-shell"
        style={{ minHeight: "100vh", paddingTop: 24, paddingBottom: 48 }}
      >
        {/* ── Screen toolbar ── */}
        <div className="pl-toolbar">
          <div className="pl-pdf-hint">
            💡 To save as PDF: File → Print → Destination → Save as PDF
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

        {/* ════════════════════════════════════════════════════════════════════
         * SECTION 1 — PICK SUMMARY
         * The warehouse-facing pick list. One row per item, grouped by zone.
         * Picker answers: what, how many packs, total qty.
         */}
        <div className="pl-card">
          {/* Document header */}
          <header className="pl-doc-header">
            <div>
              <div className="pl-brand">Stock Dharma · Warehouse Operations</div>
              <h1 className="pl-doc-title">HQ FULFILLMENT PICK LIST</h1>
              <div className="pl-doc-sub">
                Prepared by:{" "}
                <strong>{user?.name || user?.email || "HQ Staff"}</strong>
              </div>
              <div className="pl-doc-sub">
                {/* No giant comma-separated ID list here.
                    The full source register is in the Appendix. */}
                Locations: <strong>{locationNames.length}</strong>
                {"  ·  "}
                Requisitions: <strong>{requisitionNums.length}</strong>
                {"  ·  "}
                Items: <strong>{data.length}</strong>
                {"  ·  "}
                See allocation sheets on later pages.
              </div>
            </div>
            <div className="pl-doc-meta">
              <div>Print Date</div>
              <strong>{generatedAt.toLocaleDateString()}</strong>
              <div style={{ marginTop: 5 }}>Time</div>
              <strong>{generatedAt.toLocaleTimeString()}</strong>
            </div>
          </header>

          {/* Stats row */}
          <div className="pl-stats">
            <div className="pl-stat">
              <div className="pl-stat-label">Items</div>
              <div className="pl-stat-val">{data.length}</div>
            </div>
            <div className="pl-stat">
              <div className="pl-stat-label">Locations</div>
              <div className="pl-stat-val">{locationNames.length}</div>
            </div>
            <div className="pl-stat">
              <div className="pl-stat-label">Requisitions</div>
              <div className="pl-stat-val">{requisitionNums.length}</div>
            </div>
            <div className="pl-stat">
              <div className="pl-stat-label">Total Requested</div>
              <div className="pl-stat-val">{totalReq.toLocaleString()}</div>
              <div className="pl-stat-sub">units / packs</div>
            </div>
            <div className="pl-stat">
              <div className="pl-stat-label">Total Allocated</div>
              <div className="pl-stat-val" style={{ color: "#166534" }}>
                {totalAlloc.toLocaleString()}
              </div>
            </div>
            <div className="pl-stat">
              <div className="pl-stat-label">Backordered</div>
              <div
                className="pl-stat-val"
                style={{ color: totalBO > 0 ? "#b45309" : "#166534" }}
              >
                {totalBO.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Pick summary table — grouped by storage zone */}
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
              {zoneGroups.map(([zone, groups]) => (
                <div key={zone}>
                  <div className="pl-zone-header">
                    <span className="pl-zone-title">{zone}</span>
                    <span className="pl-zone-count">
                      {groups.length} item{groups.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <table className="pl-table" style={{ marginBottom: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
                    <thead>
                      <tr>
                        <th className="col-check th-green">✓</th>
                        <th className="th-green">Item Name</th>
                        <th className="col-pack th-green">Pack / Unit</th>
                        <th className="col-pull th-green">Pull Qty</th>
                        <th className="col-total th-green">Total to Stage</th>
                        <th className="col-signed th-green">Checked By</th>
                        <th className="col-notes th-green">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((group, idx) => {
                        const hasBO = group.totalBackorder > 0;
                        return (
                          <tr key={group.itemName}>
                            <td className="col-check" style={{ fontSize: 18 }}>□</td>
                            <td>
                              <div style={{ fontWeight: 700, fontSize: 12 }}>
                                {group.itemName}
                              </div>
                              <div style={{ fontSize: 9, color: "#6b7280", marginTop: 1 }}>
                                {group.items.length} location{group.items.length !== 1 ? "s" : ""}
                              </div>
                              {hasBO && (
                                <div className="bo-warn">
                                  ⚠ {rowBackorderLabel({
                                    ...group.items[0],
                                    backorderQty: group.totalBackorder,
                                    isFGMode: group.isFGMode,
                                    packQty: group.packQty,
                                    unit: group.unit,
                                    allocatedQty: 0,
                                    quantityRequested: 0,
                                    id: "", requisitionId: "", requisitionNumber: "",
                                    requisitionDate: "", requisitionStatus: "",
                                    locationName: "", locationId: "", fulfillmentNote: "",
                                  })} backordered
                                </div>
                              )}
                            </td>
                            <td className="col-pack">
                              <span style={{ fontSize: 11, color: "#374151" }}>
                                {packSizeLabel(group)}
                              </span>
                            </td>
                            <td className="col-pull">
                              <div className="pull-val">{pullLabel(group)}</div>
                              {group.isFGMode && group.packQty > 1 && (
                                <div className="pull-base">
                                  = {fmtBase(group.totalAllocated * group.packQty, group.unit)}
                                </div>
                              )}
                            </td>
                            <td className="col-total">
                              <span style={{ fontWeight: 600, fontSize: 12 }}>
                                {totalStagedLabel(group)}
                              </span>
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

        {/* ════════════════════════════════════════════════════════════════════
         * SECTION 2 — ITEM ALLOCATION / DISTRIBUTION SHEETS
         * One card per item. Shows per-location allocation breakdown.
         * Page break before first item, then each subsequent item starts
         * immediately below (no forced break per item to save paper).
         */}
        {data.length > 0 && (
          <div className="pl-card pl-section-break">
            <h2 className="pl-section-title">Item Allocation &amp; Distribution Sheets</h2>
            <p
              style={{
                fontSize: 11,
                color: "#6b7280",
                marginBottom: 18,
                marginTop: -6,
              }}
            >
              Per-location allocation detail for each item. Use these sheets to
              pack and label orders by destination.
            </p>

            {data.map((group, gi) => (
              <div
                key={group.itemName}
                style={{ marginBottom: 24, breakInside: "avoid", pageBreakInside: "avoid" }}
              >
                {/* Item card header */}
                <div className="item-sheet-header">
                  <div>
                    <div className="item-sheet-name">{group.itemName}</div>
                    <div className="item-sheet-meta">
                      Pack: <strong>{packSizeLabel(group)}</strong>
                      {"  ·  "}
                      Pull: <strong>{pullLabel(group)}</strong>
                      {"  ·  "}
                      Total staged: <strong>{totalStagedLabel(group)}</strong>
                    </div>
                  </div>
                  <div className="item-sheet-totals">
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", fontWeight: 700, textTransform: "uppercase" }}>Allocated</div>
                      <div className="item-sheet-total-val" style={{ color: "#166534" }}>
                        {pullLabel(group)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#6b7280", fontWeight: 700, textTransform: "uppercase" }}>Backordered</div>
                      <div
                        className="item-sheet-total-val"
                        style={{ color: group.totalBackorder > 0 ? "#b45309" : "#9ca3af" }}
                      >
                        {group.totalBackorder > 0
                          ? rowBackorderLabel({
                              backorderQty: group.totalBackorder,
                              isFGMode: group.isFGMode,
                              packQty: group.packQty,
                              unit: group.unit,
                              allocatedQty: 0,
                              quantityRequested: 0,
                              id: "", requisitionId: "", requisitionNumber: "",
                              requisitionDate: "", requisitionStatus: "",
                              locationName: "", locationId: "", fulfillmentNote: "",
                            })
                          : "None"}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Per-location allocation table */}
                <table className="pl-table">
                  <thead>
                    <tr>
                      <th>Location</th>
                      <th>Req #</th>
                      <th>Requested</th>
                      <th>Allocated</th>
                      <th>Backordered</th>
                      <th style={{ width: 60, textAlign: "center" }}>Packed ✓</th>
                      <th>Fulfillment Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((item) => (
                      <tr key={item.id} className={item.backorderQty > 0 ? "bo-row" : ""}>
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
                          <strong>{rowPullLabel(item)}</strong>
                          {item.isFGMode && item.packQty > 1 && (
                            <div style={{ fontSize: 9, color: "#6b7280" }}>
                              {rowBaseLabel(item)}
                            </div>
                          )}
                        </td>
                        <td>
                          {item.backorderQty > 0 ? (
                            <span className="bo-warn">{rowBackorderLabel(item)}</span>
                          ) : (
                            <span style={{ color: "#9ca3af" }}>—</span>
                          )}
                        </td>
                        <td style={{ textAlign: "center", fontSize: 18 }}>□</td>
                        <td style={{ fontSize: 10, color: "#374151" }}>
                          {item.fulfillmentNote || ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════
         * SECTION 3 — BACKORDERS & EXCEPTIONS
         * Only rendered when backorders exist. Page-break before.
         */}
        {backorderRows.length > 0 && (
          <div className="pl-card pl-section-break">
            <h2 className="pl-section-title" style={{ color: "#b45309" }}>
              ⚠ Backorders &amp; Exceptions
            </h2>
            <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 14, marginTop: -6 }}>
              {backorderRows.length} line{backorderRows.length !== 1 ? "s" : ""}{" "}
              with outstanding backorders. Follow up with the location or supplier.
            </p>

            <table className="pl-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Location</th>
                  <th>Req #</th>
                  <th>Requested</th>
                  <th>Allocated</th>
                  <th>Backordered</th>
                  <th>Reason / Note</th>
                  <th>Action / Follow-up</th>
                </tr>
              </thead>
              <tbody>
                {backorderRows.map((row) => (
                  <tr key={`bo-${row.id}`} className="bo-row">
                    <td style={{ fontWeight: 700 }}>
                      {/* Find group to get isFGMode / packQty */}
                      {data.find((g) => g.items.some((it) => it.id === row.id))?.itemName || ""}
                    </td>
                    <td>{row.locationName}</td>
                    <td style={{ fontFamily: "monospace", fontSize: 10 }}>
                      {row.requisitionNumber || row.requisitionId}
                    </td>
                    <td>{rowRequestedLabel(row)}</td>
                    <td>{rowPullLabel(row)}</td>
                    <td>
                      <span className="bo-warn">{rowBackorderLabel(row)}</span>
                    </td>
                    <td style={{ fontSize: 10 }}>{row.fulfillmentNote || ""}</td>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="pl-signoff" style={{ marginTop: 24 }}>
              {["Backorder Coordinator", "Date Actioned", "Resolution / Notes"].map(
                (label) => (
                  <div key={label}>
                    <div className="pl-signoff-line" />
                    <div className="pl-signoff-label">{label}</div>
                  </div>
                )
              )}
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════
         * APPENDIX — FULL FULFILLMENT SOURCE REGISTER
         * This is the ONLY section that lists every location ID and
         * requisition number. Kept separate from operational pages.
         */}
        {data.length > 0 && (
          <div className="pl-card pl-section-break">
            <h2 className="pl-section-title">
              Appendix — Full Fulfillment Source Register
            </h2>
            <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 14, marginTop: -6 }}>
              Complete record of all locations and requisitions included in this
              pick list. For audit and traceability only.
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 24,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 900,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "#374151",
                    marginBottom: 8,
                    borderBottom: "1px solid #e5e7eb",
                    paddingBottom: 4,
                  }}
                >
                  Locations ({locationNames.length})
                </div>
                <ol className="pl-appendix-list" style={{ columnCount: 1 }}>
                  {locationNames.map((loc, i) => (
                    <li key={loc} style={{ marginBottom: 2 }}>
                      {i + 1}. {loc}
                    </li>
                  ))}
                </ol>
              </div>

              <div>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 900,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    color: "#374151",
                    marginBottom: 8,
                    borderBottom: "1px solid #e5e7eb",
                    paddingBottom: 4,
                  }}
                >
                  Requisitions ({requisitionNums.length})
                </div>
                <ol className="pl-appendix-list" style={{ columnCount: 2 }}>
                  {requisitionNums.map((req, i) => (
                    <li key={req} style={{ marginBottom: 2 }}>
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
