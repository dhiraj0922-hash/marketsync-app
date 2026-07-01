"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { CheckSquare, Loader2, Package, Printer } from "lucide-react";
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
  const packLabel = item.packLabelSnapshot as string | null;
  const packQty   = item.packQtySnapshot   as number | null;
  const packUnit  = item.packUnitSnapshot  as string | null;
  const packCount = item.shippedPackCount  as number | null;
  const baseQty   = item.shippedBaseQty    as number | null;
  const shippedQty = Number(item.shippedQty ?? 0);
  const unitStr   = packUnit ?? item.unit ?? "";

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
    const sizeStr = packLabel ?? (packQty != null && packUnit ? `${packQty} ${packUnit}` : "packed");
    return {
      packSize: sizeStr,
      pull: `${packCount}`,
      total: fmtQty(baseQty, unitStr),
      isMissing: false,
      isLoose: false,
    };
  }

  // Loose
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
  const shouldAutoPrint = searchParams.get("print") === "1" || searchParams.get("mode") === "print";

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const res = await getDeliveryTicketById(params.ticketId);
      if (cancelled) return;
      if (!res.success) {
        setError(res.error?.message ?? "Delivery ticket not found or access denied.");
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
    const t = window.setTimeout(() => window.print(), 350);
    return () => window.clearTimeout(t);
  }, [shouldAutoPrint, ticket]);

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
          <p className="text-sm font-semibold text-red-700">{error || "Delivery ticket not found."}</p>
        </div>
      </div>
    );
  }

  const items: any[] = Array.isArray(ticket.items) ? ticket.items : [];
  const missingCount = items.filter((it) => it.shippedQty > 0 && it.packQtySnapshot == null).length;

  return (
    <main className="packing-shell min-h-screen bg-slate-50 py-6 print:bg-white print:py-0">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
        .packing-shell {
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
          color: #111827;
        }
        .packing-page {
          max-width: 8.5in;
          margin: 0 auto;
          background: #ffffff;
          padding: 32px;
        }
        .packing-screen-bar {
          max-width: 8.5in;
          margin: 0 auto 12px;
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
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }
        .packing-btn-primary {
          background: #10b981;
          border-color: #059669;
          color: #fff;
        }
        .packing-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          border-bottom: 2px solid #111827;
          padding-bottom: 16px;
          margin-bottom: 20px;
        }
        .packing-brand {
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: #6b7280;
        }
        .packing-title {
          font-size: 26px;
          font-weight: 900;
          letter-spacing: -0.03em;
          margin-top: 4px;
        }
        .packing-sub {
          font-size: 12px;
          color: #6b7280;
          margin-top: 4px;
        }
        .packing-meta {
          text-align: right;
          font-size: 11px;
          color: #6b7280;
        }
        .packing-meta strong { color: #111827; }
        .packing-warn-banner {
          margin-bottom: 14px;
          padding: 10px 14px;
          background: #fffbeb;
          border: 1px solid #fbbf24;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 700;
          color: #92400e;
        }
        .packing-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        .packing-table thead th {
          background: #f0fdf4;
          border: 1px solid #86efac;
          padding: 9px 10px;
          text-align: left;
          font-size: 10px;
          font-weight: 900;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #166534;
        }
        .packing-table tbody td {
          border: 1px solid #e5e7eb;
          padding: 12px 10px;
          vertical-align: top;
        }
        .packing-table tbody tr:hover { background: #f9fafb; }
        .packing-check-col { width: 40px; text-align: center; font-size: 20px; }
        .packing-item-name { font-weight: 700; font-size: 13px; }
        .packing-item-unit { font-size: 11px; color: #6b7280; margin-top: 2px; }
        .packing-pull {
          font-size: 22px;
          font-weight: 900;
          color: #065f46;
          text-align: center;
        }
        .packing-pull-label { font-size: 10px; color: #6b7280; text-align: center; margin-top: 2px; }
        .packing-total { font-size: 13px; font-weight: 600; }
        .packing-size { font-size: 12px; color: #374151; }
        .packing-missing {
          font-size: 10px;
          font-weight: 700;
          color: #b45309;
          background: #fffbeb;
          border: 1px solid #fbbf24;
          border-radius: 4px;
          padding: 2px 6px;
          display: inline-block;
          margin-top: 4px;
        }
        .packing-loose {
          display: inline-block;
          border: 1px solid #d1d5db;
          border-radius: 4px;
          padding: 2px 6px;
          font-size: 10px;
          color: #6b7280;
        }
        .packing-footer {
          margin-top: 28px;
          border-top: 1px solid #e5e7eb;
          padding-top: 10px;
          font-size: 10px;
          color: #9ca3af;
          display: flex;
          justify-content: space-between;
        }
        @media print {
          .packing-screen-bar { display: none !important; }
          .packing-shell { background: white !important; }
          .packing-page { max-width: none; margin: 0; padding: 0; }
          .packing-table tbody tr:hover { background: transparent; }
        }
        @page { size: Letter; margin: 0.45in; }
      `}</style>

      {/* Screen-only toolbar */}
      <div className="packing-screen-bar">
        <button className="packing-btn packing-btn-primary" onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Print Packing List
        </button>
        <button className="packing-btn" onClick={() => window.close()}>
          Close
        </button>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#6b7280" }}>
          Generated {generatedAt.toLocaleString()}
        </span>
      </div>

      <div className="packing-page">
        {/* Header */}
        <header className="packing-header">
          <div>
            <div className="packing-brand">
              <Package style={{ display: "inline", height: 12, width: 12, marginRight: 4 }} />
              Stock Dharma · Warehouse
            </div>
            <div className="packing-title">PACKING LIST</div>
            <div className="packing-sub">
              Ticket: <strong>{ticket.ticketNumber}</strong>
              {" · "}
              Req: <strong>{ticket.requisitionId ?? "—"}</strong>
              {" · "}
              Status: <strong>{labelize(ticket.status ?? "draft")}</strong>
            </div>
            <div className="packing-sub">
              Destination: <strong>{ticket.destinationName ?? "—"}</strong>
            </div>
          </div>
          <div className="packing-meta">
            <div>Print Date</div>
            <strong>{generatedAt.toLocaleDateString()}</strong>
            <div style={{ marginTop: 6 }}>Time</div>
            <strong>{generatedAt.toLocaleTimeString()}</strong>
            <div style={{ marginTop: 6 }}>
              Run: <strong>{ticket.deliveryRun?.runNumber ?? "Unassigned"}</strong>
            </div>
          </div>
        </header>

        {/* Warning banner */}
        {missingCount > 0 && (
          <div className="packing-warn-banner">
            ⚠ {missingCount} item{missingCount !== 1 ? "s" : ""} missing pack configuration —
            confirm quantities manually before dispatch.
          </div>
        )}

        {/* Packing table */}
        {items.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 13 }}>No items on this ticket.</p>
        ) : (
          <table className="packing-table">
            <thead>
              <tr>
                <th className="packing-check-col">✓</th>
                <th>Item</th>
                <th>Pack Size</th>
                <th style={{ textAlign: "center" }}>Pull (packs)</th>
                <th>Total Qty</th>
                <th style={{ minWidth: 72 }}>Checked By</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item: any, i: number) => {
                const pk = getPackInfo(item);
                return (
                  <tr key={item.id ?? i}>
                    <td className="packing-check-col" style={{ fontSize: 24 }}>□</td>
                    <td>
                      <div className="packing-item-name">{item.itemName}</div>
                      <div className="packing-item-unit">{item.unit ?? ""}</div>
                      {pk.isMissing && (
                        <span className="packing-missing">
                          Pack config missing — confirm manually before dispatch
                        </span>
                      )}
                    </td>
                    <td>
                      {pk.isLoose ? (
                        <span className="packing-loose">Loose</span>
                      ) : pk.isMissing ? (
                        <span style={{ color: "#b45309", fontSize: 12 }}>—</span>
                      ) : (
                        <span className="packing-size">{pk.packSize}</span>
                      )}
                    </td>
                    <td>
                      {pk.isLoose || pk.isMissing ? (
                        <div className="packing-pull-label" style={{ textAlign: "center" }}>—</div>
                      ) : (
                        <>
                          <div className="packing-pull">{pk.pull}</div>
                          <div className="packing-pull-label">packs</div>
                        </>
                      )}
                    </td>
                    <td>
                      <div className="packing-total">{pk.total}</div>
                    </td>
                    <td />
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Warehouse sign-off */}
        <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          <div>
            <div style={{ borderBottom: "1px solid #111827", height: 34, marginTop: 18 }} />
            <div style={{ marginTop: 5, fontSize: 10, fontWeight: 800, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Packed By
            </div>
          </div>
          <div>
            <div style={{ borderBottom: "1px solid #111827", height: 34, marginTop: 18 }} />
            <div style={{ marginTop: 5, fontSize: 10, fontWeight: 800, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Checked By
            </div>
          </div>
          <div>
            <div style={{ borderBottom: "1px solid #111827", height: 34, marginTop: 18 }} />
            <div style={{ marginTop: 5, fontSize: 10, fontWeight: 800, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Date / Time
            </div>
          </div>
        </div>

        <footer className="packing-footer">
          <span>Stock Dharma · Packing List · {ticket.ticketNumber}</span>
          <span>{generatedAt.toLocaleString()}</span>
        </footer>
      </div>
    </main>
  );
}
