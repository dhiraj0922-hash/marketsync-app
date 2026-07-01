"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Loader2, Package, Printer } from "lucide-react";
import { getDeliveryTicketById } from "@/lib/storage";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const labelize = (v: string) =>
  v.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

function fmtQty(qty: number, unit?: string | null): string {
  const s = Number.isInteger(qty) ? String(qty) : qty.toFixed(1);
  return unit ? `${s} ${unit}` : s;
}

interface PackInfo {
  packSize: string;
  pull: string;
  total: string;
  isMissing: boolean;
  isLoose: boolean;
}

function getPackInfo(item: any): PackInfo {
  const packLabel  = item.packLabelSnapshot as string | null;
  const packQty    = item.packQtySnapshot   as number | null;
  const packUnit   = item.packUnitSnapshot  as string | null;
  const packCount  = item.shippedPackCount  as number | null;
  const baseQty    = item.shippedBaseQty    as number | null;
  const shippedQty = Number(item.shippedQty ?? 0);
  const unitStr    = packUnit ?? item.unit ?? "";

  // Missing — no pack info at all
  if (packQty == null && packLabel == null && packCount == null && baseQty == null) {
    return {
      packSize: "Pack config missing",
      pull: "—",
      total: fmtQty(shippedQty, item.unit),
      isMissing: true,
      isLoose: false,
    };
  }

  // Pack-based
  if (packCount != null && baseQty != null) {
    const sizeStr =
      packLabel ??
      (packQty != null && packUnit ? `${packQty} ${packUnit}` : "packed");
    return {
      packSize: sizeStr,
      pull: `${packCount}`,
      total: fmtQty(baseQty, unitStr),
      isMissing: false,
      isLoose: false,
    };
  }

  // Loose / base-unit
  return {
    packSize: packLabel ?? "Loose",
    pull: "—",
    total: fmtQty(baseQty ?? shippedQty, unitStr),
    isMissing: false,
    isLoose: true,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PackingViewPage() {
  const params       = useParams<{ ticketId: string }>();
  const searchParams = useSearchParams();
  const [ticket, setTicket]   = useState<any | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const hasAutoPrinted = useRef(false);
  const generatedAt   = useMemo(() => new Date(), []);
  const shouldAutoPrint =
    searchParams.get("print") === "1" || searchParams.get("mode") === "print";

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const res = await getDeliveryTicketById(params.ticketId);
      if (cancelled) return;
      if (!res.success) {
        setError(
          res.error?.message ?? "Delivery ticket not found or access denied."
        );
      } else {
        setTicket(res.data);
        document.title = `Packing List — ${res.data?.ticketNumber ?? ""}`;
      }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [params.ticketId]);

  useEffect(() => {
    if (!ticket || !shouldAutoPrint) return;
    if (hasAutoPrinted.current) return;
    hasAutoPrinted.current = true;
    const t = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(t);
  }, [shouldAutoPrint, ticket]);

  /* ── loading / error states ── */
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-slate-50 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading packing list…
      </div>
    );
  }
  if (error || !ticket) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="rounded-2xl border border-red-200 bg-white p-6 text-center shadow-sm">
          <p className="text-sm font-semibold text-red-700">
            {error || "Delivery ticket not found."}
          </p>
        </div>
      </div>
    );
  }

  const items: any[]  = Array.isArray(ticket.items) ? ticket.items : [];
  const missingCount  = items.filter(
    (it) => it.shippedQty > 0 && it.packQtySnapshot == null
  ).length;
  const ticketNum     = ticket.ticketNumber ?? "";

  return (
    <>
      {/*
       * ── STYLE BLOCK ──────────────────────────────────────────────────────────
       *
       * Print-safe rules:
       *
       * 1. html/body must be height:auto and overflow:visible so the browser
       *    renders the full document height, not just the scroll viewport.
       *    Without this, Chrome prints only "1 page" regardless of content.
       *
       * 2. thead { display: table-header-group } makes the header row repeat
       *    automatically on every printed page (W3C standard).
       *
       * 3. tbody tr { break-inside: avoid } keeps each row on one page.
       *    Combined with page-break-inside: avoid for older browsers.
       *
       * 4. tfoot { display: table-footer-group } pins the summary sign-off
       *    section to the bottom of the last page.
       *
       * 5. No transform, scale, fixed positioning, or CSS zoom is used.
       *    These break the browser print layout engine.
       *
       * 6. .packing-shell uses height:auto (not min-h-screen) in print.
       *    The Tailwind class is only applied on screen via a wrapping div.
       */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');

        /* ── Base (screen + print) ── */
        .packing-shell {
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
          color: #111827;
          background: #f8fafc;
        }
        .packing-content {
          max-width: 8.5in;
          margin: 0 auto;
          background: #ffffff;
          padding: 32px 36px;
        }

        /* ── Screen toolbar ── */
        .packing-toolbar {
          max-width: 8.5in;
          margin: 0 auto 12px;
          padding: 0 4px;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .packing-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border: 1px solid #d1d5db;
          background: #fff;
          border-radius: 10px;
          padding: 8px 14px;
          font-family: inherit;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.15s;
        }
        .packing-btn:hover { background: #f3f4f6; }
        .packing-btn-primary {
          background: #10b981;
          border-color: #059669;
          color: #fff;
        }
        .packing-btn-primary:hover { background: #059669; }

        /* ── Document header ── */
        .packing-doc-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          border-bottom: 2.5px solid #111827;
          padding-bottom: 14px;
          margin-bottom: 18px;
          /* keep header on first page only — do not repeat */
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .packing-brand {
          font-size: 10px;
          font-weight: 900;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: #6b7280;
          margin-bottom: 4px;
        }
        .packing-title {
          font-size: 24px;
          font-weight: 900;
          letter-spacing: -0.02em;
          margin: 0 0 4px;
        }
        .packing-sub {
          font-size: 11px;
          color: #6b7280;
          margin-top: 3px;
          line-height: 1.5;
        }
        .packing-meta {
          text-align: right;
          font-size: 11px;
          color: #6b7280;
          white-space: nowrap;
        }
        .packing-meta strong { color: #111827; }

        /* ── Warning banner ── */
        .packing-warn {
          margin-bottom: 12px;
          padding: 9px 12px;
          background: #fffbeb;
          border: 1px solid #fbbf24;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 700;
          color: #92400e;
          break-inside: avoid;
          page-break-inside: avoid;
        }

        /* ── Main packing table ────────────────────────────────────────────────
         *
         * thead { display: table-header-group }
         *   → repeats column headings on every printed page automatically.
         *
         * tr { break-inside: avoid }
         *   → prevents a single data row from splitting across a page break.
         */
        .packing-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
          table-layout: auto;
        }
        .packing-table thead {
          /* CRITICAL: repeat header on every printed page */
          display: table-header-group;
        }
        .packing-table tfoot {
          display: table-footer-group;
        }
        .packing-table thead th {
          background: #f0fdf4;
          border: 1px solid #86efac;
          padding: 8px 10px;
          text-align: left;
          font-size: 9px;
          font-weight: 900;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #166534;
          vertical-align: bottom;
        }
        .packing-table tbody td {
          border: 1px solid #e5e7eb;
          padding: 10px 10px;
          vertical-align: top;
        }
        .packing-table tbody tr {
          /* CRITICAL: do not split a single row across a page break */
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .packing-table tbody tr:hover { background: #f9fafb; }

        /* Column sizing */
        .col-check  { width: 36px;  text-align: center; }
        .col-pull   { width: 80px;  text-align: center; }
        .col-size   { width: 130px; }
        .col-total  { width: 110px; }
        .col-signed { width: 90px;  }

        /* Cell content helpers */
        .packing-check-cell { font-size: 20px; text-align: center; }
        .packing-item-name  { font-weight: 700; font-size: 12px; }
        .packing-item-unit  { font-size: 10px; color: #6b7280; margin-top: 1px; }
        .packing-pull-num {
          font-size: 20px;
          font-weight: 900;
          color: #065f46;
          text-align: center;
          line-height: 1;
        }
        .packing-pull-lbl { font-size: 9px; color: #6b7280; text-align: center; margin-top: 2px; }
        .packing-total-val { font-size: 12px; font-weight: 600; }
        .packing-size-val  { font-size: 11px; color: #374151; }
        .packing-loose-badge {
          display: inline-block;
          border: 1px solid #d1d5db;
          border-radius: 4px;
          padding: 1px 5px;
          font-size: 9px;
          color: #6b7280;
        }
        .packing-miss-badge {
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

        /* ── Sign-off / footer area ── */
        .packing-signoff {
          margin-top: 24px;
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 16px;
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .packing-signoff-line {
          border-bottom: 1px solid #111827;
          height: 32px;
          margin-top: 16px;
        }
        .packing-signoff-label {
          margin-top: 4px;
          font-size: 9px;
          font-weight: 800;
          color: #4b5563;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        /* ── Print-only page footer (repeated via tfoot) ── */
        .packing-page-footer td {
          border: none !important;
          padding-top: 8px;
          font-size: 9px;
          color: #9ca3af;
        }

        /* ── Screen-only doc footer ── */
        .packing-doc-footer {
          margin-top: 20px;
          border-top: 1px solid #e5e7eb;
          padding-top: 8px;
          font-size: 10px;
          color: #9ca3af;
          display: flex;
          justify-content: space-between;
        }

        /* ═══════════════════════════════════════════════════════════════════
         * @media print — the critical section
         * ═══════════════════════════════════════════════════════════════════
         *
         * Chrome's print engine uses the scroll container's rendered height
         * to decide how many pages to produce. If any ancestor has:
         *   - height / min-height in viewport units (vh) or pixels
         *   - overflow: hidden / auto / scroll
         *   - fixed or sticky positioning
         * …then only the "visible" area prints, cutting off remaining content.
         *
         * The fix: in print media, every ancestor of the packing table must
         * have height:auto, overflow:visible, and position:static.
         */
        @media print {
          /* 1. Neutralise html + body constraints */
          html,
          body {
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: visible !important;
            background: white !important;
            margin: 0 !important;
            padding: 0 !important;
          }

          /* 2. Neutralise all ancestor wrappers Next.js may inject
                (#__next, [data-nextjs-scroll-focus-boundary], etc.) */
          #__next,
          [data-nextjs-scroll-focus-boundary],
          [id^="radix-"],
          body > div {
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: visible !important;
            position: static !important;
          }

          /* 3. This page's own shell / content */
          .packing-shell,
          .packing-content {
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: visible !important;
            position: static !important;
            background: white !important;
            padding: 0 !important;
            margin: 0 !important;
            max-width: none !important;
            width: 100% !important;
          }

          /* 4. Hide screen-only chrome */
          .packing-toolbar,
          .packing-doc-footer,
          nav,
          header:not(.packing-doc-header) {
            display: none !important;
          }

          /* 5. Table — allow natural multi-page flow */
          .packing-table {
            width: 100% !important;
            font-size: 10px;
          }
          .packing-table thead {
            /* Repeat column headers on every printed page */
            display: table-header-group !important;
          }
          .packing-table tfoot {
            display: table-footer-group !important;
          }
          .packing-table tbody tr {
            /* Never split a single row across a page break */
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }
          .packing-table tbody tr:hover {
            background: transparent !important;
          }
          .packing-table thead th {
            /* Ensure backgrounds print (Chrome blocks backgrounds by default) */
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            background: #f0fdf4 !important;
          }

          /* 6. Pull number — slightly smaller in print */
          .packing-pull-num { font-size: 16px; }

          /* 7. Sign-off stays together */
          .packing-signoff {
            break-before: avoid;
            page-break-before: avoid;
          }
        }

        /* ── @page rule — paper size and margins ── */
        @page {
          size: letter portrait;
          margin: 12mm 14mm;
        }
      `}</style>

      {/* ── Screen wrapper — provides background + scroll ──────────────────── */}
      <div className="packing-shell" style={{ minHeight: "100vh", paddingTop: 24, paddingBottom: 48 }}>

        {/* Screen toolbar — hidden in print via CSS */}
        <div className="packing-toolbar">
          <button
            className="packing-btn packing-btn-primary"
            onClick={() => window.print()}
          >
            <Printer style={{ height: 14, width: 14 }} /> Print Packing List
          </button>
          <button className="packing-btn" onClick={() => window.close()}>
            Close
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "#6b7280" }}>
            Generated {generatedAt.toLocaleString()}
          </span>
        </div>

        {/* ── Printable content area ──────────────────────────────────────── */}
        <div className="packing-content">

          {/* Document header — first page only */}
          <header className="packing-doc-header">
            <div>
              <div className="packing-brand">
                Stock Dharma · Warehouse Packing List
              </div>
              <h1 className="packing-title">PACKING LIST</h1>
              <div className="packing-sub">
                Ticket: <strong>{ticketNum}</strong>
                {" · "}
                Req: <strong>{ticket.requisitionId ?? "—"}</strong>
                {" · "}
                Status: <strong>{labelize(ticket.status ?? "draft")}</strong>
              </div>
              <div className="packing-sub">
                Destination:{" "}
                <strong>{ticket.destinationName ?? "—"}</strong>
              </div>
              <div className="packing-sub">
                Run:{" "}
                <strong>
                  {ticket.deliveryRun?.runNumber ?? "Unassigned"}
                </strong>
              </div>
            </div>
            <div className="packing-meta">
              <div>Print Date</div>
              <strong>{generatedAt.toLocaleDateString()}</strong>
              <div style={{ marginTop: 6 }}>Time</div>
              <strong>{generatedAt.toLocaleTimeString()}</strong>
              <div style={{ marginTop: 6 }}>Items</div>
              <strong>{items.length}</strong>
            </div>
          </header>

          {/* Warning banner */}
          {missingCount > 0 && (
            <div className="packing-warn">
              ⚠ {missingCount} item{missingCount !== 1 ? "s" : ""} missing
              pack configuration — confirm quantities manually before
              dispatch.
            </div>
          )}

          {/* ── Packing table ────────────────────────────────────────────── */}
          {items.length === 0 ? (
            <p style={{ color: "#6b7280", fontSize: 13 }}>
              No items on this ticket.
            </p>
          ) : (
            <table className="packing-table">
              {/*
               * thead with display:table-header-group repeats on every page.
               * Do NOT use display:block or display:flex on thead/tbody/tfoot —
               * it breaks multi-page repetition.
               */}
              <thead>
                <tr>
                  <th className="col-check">✓</th>
                  <th>Item</th>
                  <th className="col-size">Pack Size</th>
                  <th className="col-pull">Pull<br />(packs)</th>
                  <th className="col-total">Total Qty</th>
                  <th className="col-signed">Checked By</th>
                </tr>
              </thead>

              {/*
               * tfoot appears at the bottom of the LAST page.
               * It shows the sign-off lines so warehouse staff can sign
               * immediately after the last item row.
               */}
              <tfoot>
                {/* Spacer row */}
                <tr className="packing-page-footer">
                  <td colSpan={6} style={{ paddingTop: 20, paddingBottom: 0, borderTop: "1px solid #e5e7eb" }}>
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr",
                      gap: 16,
                    }}>
                      {[
                        "Packed By",
                        "Checked By",
                        "Date / Time",
                      ].map((label) => (
                        <div key={label}>
                          <div style={{
                            borderBottom: "1px solid #111827",
                            height: 30,
                            marginTop: 12,
                          }} />
                          <div style={{
                            marginTop: 4,
                            fontSize: 8,
                            fontWeight: 800,
                            color: "#4b5563",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                          }}>
                            {label}
                          </div>
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
                {/* Print page footer */}
                <tr className="packing-page-footer">
                  <td colSpan={6}>
                    <div style={{
                      display: "flex",
                      justifyContent: "space-between",
                      paddingTop: 6,
                      borderTop: "1px solid #e5e7eb",
                      fontSize: 8,
                      color: "#9ca3af",
                    }}>
                      <span>
                        Stock Dharma · Packing List · {ticketNum}
                      </span>
                      <span>{generatedAt.toLocaleDateString()}</span>
                    </div>
                  </td>
                </tr>
              </tfoot>

              <tbody>
                {items.map((item: any, i: number) => {
                  const pk = getPackInfo(item);
                  return (
                    <tr key={item.id ?? i}>
                      {/* Checkbox */}
                      <td className="col-check packing-check-cell">
                        □
                      </td>

                      {/* Item name + unit + missing warning */}
                      <td>
                        <div className="packing-item-name">
                          {item.itemName}
                        </div>
                        <div className="packing-item-unit">
                          {item.unit ?? ""}
                        </div>
                        {pk.isMissing && (
                          <span className="packing-miss-badge">
                            Pack config missing — confirm manually
                          </span>
                        )}
                      </td>

                      {/* Pack size */}
                      <td className="col-size">
                        {pk.isLoose ? (
                          <span className="packing-loose-badge">
                            Loose
                          </span>
                        ) : pk.isMissing ? (
                          <span style={{ color: "#b45309", fontSize: 10 }}>
                            —
                          </span>
                        ) : (
                          <span className="packing-size-val">
                            {pk.packSize}
                          </span>
                        )}
                      </td>

                      {/* Pull count */}
                      <td className="col-pull">
                        {pk.isLoose || pk.isMissing ? (
                          <div style={{
                            textAlign: "center",
                            color: "#9ca3af",
                            fontSize: 11,
                          }}>
                            —
                          </div>
                        ) : (
                          <>
                            <div className="packing-pull-num">
                              {pk.pull}
                            </div>
                            <div className="packing-pull-lbl">packs</div>
                          </>
                        )}
                      </td>

                      {/* Total qty */}
                      <td className="col-total">
                        <div className="packing-total-val">
                          {pk.total}
                        </div>
                      </td>

                      {/* Checked-by write-in */}
                      <td className="col-signed" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Screen-only footer (hidden in print) */}
          <div className="packing-doc-footer">
            <span>
              Stock Dharma · Packing List · {ticketNum}
            </span>
            <span>{generatedAt.toLocaleString()}</span>
          </div>
        </div>{/* end .packing-content */}
      </div>{/* end .packing-shell */}
    </>
  );
}
