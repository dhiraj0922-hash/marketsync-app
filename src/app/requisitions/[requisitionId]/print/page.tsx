"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Printer, ArrowLeft, Loader2, AlertCircle, ShieldAlert } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import {
  canPrintRequisition,
  isLocationManager,
  isHqFulfillment,
} from "@/lib/roles";
import {
  getRequisitionForPrint,
  type RequisitionPrintData,
  type PrintLineItem,
  type PrintSourceLabel,
} from "@/lib/storage";
import "./print.css";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtQty(n: number | null, unit?: string | null): string {
  if (n === null) return "—";
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
  return unit ? `${s} ${unit}` : s;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtDate(raw: string | null | undefined): string {
  if (!raw) return "—";
  // raw may be "Jul 1, 2026" (already formatted) or ISO
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return raw;
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: "Draft",
    submitted: "Submitted",
    approved: "Approved",
    rejected: "Rejected",
    fulfilled: "Fulfilled",
    partially_fulfilled: "Partially Fulfilled",
    backordered: "Backordered",
    partial: "Partial",
  };
  return map[status.toLowerCase()] ?? status;
}

// ─── Source badge ─────────────────────────────────────────────────────────────

const SOURCE_CONFIG: Record<
  PrintSourceLabel,
  { label: string; screenClass: string; printText: string }
> = {
  hq_pick: {
    label: "HQ PICK",
    screenClass: "bg-violet-100 text-violet-800 border border-violet-300",
    printText: "[HQ PICK]",
  },
  local_vendor: {
    label: "LOCAL VENDOR — DO NOT PICK FROM HQ",
    screenClass: "bg-amber-100 text-amber-800 border border-amber-300",
    printText: "[LOCAL VENDOR]",
  },
  hq_setup_required: {
    label: "HQ SETUP REQUIRED — DO NOT PICK",
    screenClass: "bg-red-100 text-red-800 border border-red-300",
    printText: "[SETUP REQUIRED]",
  },
};

function SourceBadge({ label }: { label: PrintSourceLabel }) {
  const cfg = SOURCE_CONFIG[label];
  return (
    <>
      {/* Screen version */}
      <span
        className={`no-print inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold whitespace-nowrap ${cfg.screenClass}`}
      >
        {cfg.label}
      </span>
      {/* Print version */}
      <span className="source-badge hidden" aria-hidden="true">
        {cfg.printText}
      </span>
    </>
  );
}

// ─── Line row ─────────────────────────────────────────────────────────────────

function LineRow({ item }: { item: PrintLineItem }) {
  const hasBackorder = item.backorderQty > 0;

  return (
    <tr>
      {/* # */}
      <td className="text-right text-zinc-500 tabular-nums">{item.lineNumber}</td>

      {/* Item */}
      <td>
        <div className="item-name font-semibold text-sm leading-snug">{item.itemName}</div>
        {hasBackorder && (
          <div className="backorder-warn text-red-700 text-xs mt-0.5 no-print">
            ⚠ Backordered: {fmtQty(item.backorderQty, item.isFGMode ? "packs" : item.unit)}
          </div>
        )}
        {hasBackorder && (
          <div className="backorder-warn hidden text-[7pt] font-bold mt-0.5" aria-hidden="true">
            ⚠ Backordered: {item.backorderQty} {item.isFGMode ? "packs" : (item.unit ?? "")}
          </div>
        )}
        {item.fulfillmentNote && (
          <div className="fulfillment-note text-zinc-500 text-[11px] italic mt-0.5">
            {item.fulfillmentNote}
          </div>
        )}
      </td>

      {/* SKU / Item ID */}
      <td className="font-mono text-xs text-zinc-500 whitespace-nowrap">
        {item.itemId ?? "—"}
      </td>

      {/* Source */}
      <td>
        <SourceBadge label={item.sourceLabel} />
      </td>

      {/* Supplier */}
      <td className="text-xs">{item.supplier}</td>

      {/* Unit / Pack */}
      <td className="text-xs whitespace-nowrap">{item.unitPackLabel}</td>

      {/* Requested */}
      <td className="qty-em text-right tabular-nums">
        {item.isFGMode
          ? `${item.quantityRequested}${item.quantityRequested !== 1 ? " packs" : " pack"}`
          : fmtQty(item.quantityRequested, item.unit)}
      </td>

      {/* Approved */}
      <td className="qty-em text-right tabular-nums">
        {item.quantityApproved === null
          ? "—"
          : item.isFGMode
          ? `${item.quantityApproved}${item.quantityApproved !== 1 ? " packs" : " pack"}`
          : fmtQty(item.quantityApproved, item.unit)}
      </td>

      {/* Fulfilled / Picked */}
      <td className="qty-em text-right tabular-nums">
        {item.quantityFulfilled === null
          ? "—"
          : item.isFGMode
          ? `${item.quantityFulfilled}${item.quantityFulfilled !== 1 ? " packs" : " pack"}`
          : fmtQty(item.quantityFulfilled, item.unit)}
      </td>

      {/* Backordered */}
      <td className={`text-right tabular-nums ${hasBackorder ? "qty-backorder text-red-700 font-bold" : "text-zinc-400"}`}>
        {hasBackorder
          ? item.isFGMode
            ? `${item.backorderQty}${item.backorderQty !== 1 ? " packs" : " pack"}`
            : fmtQty(item.backorderQty, item.unit)
          : "—"}
      </td>

      {/* Picker Check */}
      <td className="text-center">
        <span className="check-box inline-block w-[14px] h-[14px] border-[1.5px] border-zinc-600 rounded-sm" />
      </td>
    </tr>
  );
}

// ─── Print document ───────────────────────────────────────────────────────────

function PrintDocument({
  data,
  printedBy,
}: {
  data: RequisitionPrintData;
  printedBy: string;
}) {
  const { requisition, items } = data;
  const printedAt = new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="print-document font-sans text-black bg-white rounded-xl shadow-sm border border-zinc-200 p-10">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="print-doc-header flex items-start justify-between gap-4 border-b-2 border-black pb-2 mb-3">
        <div>
          <div className="print-org-name text-xl font-bold tracking-tight">Stock Dharma</div>
          <div className="text-xs text-zinc-500 mt-0.5">Commissary HQ</div>
        </div>
        <div className="print-doc-title text-right text-lg font-black tracking-widest uppercase">
          Requisition Pick List
        </div>
      </div>

      {/* ── Meta grid ──────────────────────────────────────────────────────── */}
      <div className="print-meta-grid grid grid-cols-2 gap-x-8 gap-y-1 text-sm mb-4">
        <div>
          <span className="print-meta-label text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Req #</span>
          <span className="ml-2 font-bold font-mono">{requisition.id}</span>
        </div>
        <div>
          <span className="print-meta-label text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Status</span>
          <span className={`ml-2 print-status-badge inline-block border font-bold text-[10px] px-1.5 py-0.5 uppercase tracking-wider
            ${requisition.status.toLowerCase() === 'fulfilled' ? 'border-emerald-500 text-emerald-700 bg-emerald-50' :
              requisition.status.toLowerCase() === 'backordered' ? 'border-amber-500 text-amber-700 bg-amber-50' :
              requisition.status.toLowerCase() === 'approved' ? 'border-blue-500 text-blue-700 bg-blue-50' :
              'border-zinc-400 text-zinc-700 bg-zinc-50'}`}>
            {statusLabel(requisition.status)}
          </span>
        </div>
        <div>
          <span className="print-meta-label text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Location</span>
          <span className="ml-2 font-semibold">{requisition.location ?? "—"}</span>
        </div>
        <div>
          <span className="print-meta-label text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Requested By</span>
          <span className="ml-2">{requisition.requestedBy ?? "—"}</span>
        </div>
        <div>
          <span className="print-meta-label text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Request Date</span>
          <span className="ml-2">{fmtDate(requisition.date)}</span>
        </div>
        <div>
          <span className="print-meta-label text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Items</span>
          <span className="ml-2">{items.length}</span>
        </div>
        {requisition.notes && (
          <div className="col-span-2">
            <span className="print-meta-label text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Notes</span>
            <span className="ml-2 italic text-zinc-700">{requisition.notes}</span>
          </div>
        )}
        <div>
          <span className="print-meta-label text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Printed</span>
          <span className="ml-2 text-xs text-zinc-500">{printedAt}</span>
        </div>
        <div>
          <span className="print-meta-label text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Printed By</span>
          <span className="ml-2 text-xs text-zinc-500">{printedBy}</span>
        </div>
      </div>

      {/* ── Line items table ────────────────────────────────────────────────── */}
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500 italic py-4">No line items on this requisition.</p>
      ) : (
        <table className="print-table w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="text-right w-6">#</th>
              <th className="text-left min-w-[120px]">Item</th>
              <th className="text-left w-24">SKU / Item ID</th>
              <th className="text-left w-32">Source</th>
              <th className="text-left w-28">Supplier</th>
              <th className="text-left w-24">Unit / Pack</th>
              <th className="text-right w-16">Requested</th>
              <th className="text-right w-16">Approved</th>
              <th className="text-right w-20">Fulfilled / Picked</th>
              <th className="text-right w-20">Backordered</th>
              <th className="text-center w-10">✓ Check</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <LineRow key={item.id} item={item} />
            ))}
          </tbody>
        </table>
      )}

      {/* ── Sign-off footer ─────────────────────────────────────────────────── */}
      <div className="print-signoff mt-10 pt-6 border-t-2 border-black">
        <div className="grid grid-cols-2 gap-x-10 gap-y-6">
          {[
            "Prepared by",
            "Picked by",
            "Checked by",
            "Date / Time",
          ].map((label) => (
            <div key={label}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-5">
                {label}
              </div>
              <div className="border-b border-zinc-400 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function RequisitionPrintPage() {
  const params   = useParams();
  const router   = useRouter();
  const { user: profile } = useAuth();
  const requisitionId = String(params?.requisitionId ?? "");

  const [loading, setLoading]       = useState(true);
  const [printData, setPrintData]   = useState<RequisitionPrintData | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [errorCode, setErrorCode]   = useState<string | null>(null);

  const didFetch = useRef(false);

  // ── Auth guard (UI layer) ───────────────────────────────────────────────────
  // DB-layer guard is enforced by the get_requisition_for_print RPC.
  useEffect(() => {
    if (!profile || !profile.role) return; // wait for profile
    if (!canPrintRequisition(profile)) {
      setError("You do not have permission to print requisitions.");
      setErrorCode("FORBIDDEN");
      setLoading(false);
    }
  }, [profile]);

  // ── Data fetch ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!profile || !profile.role) return;
    if (!canPrintRequisition(profile)) return;
    if (!requisitionId) { setError("No requisition ID provided."); setLoading(false); return; }
    if (didFetch.current) return;
    didFetch.current = true;

    // UI-layer draft guard for location managers (belt-and-suspenders; RPC also checks).
    // We skip the fetch entirely to avoid showing a confusing RPC error.
    // The RPC will also reject if somehow bypassed here.
    setLoading(true);
    getRequisitionForPrint(requisitionId).then((res) => {
      if (res.success) {
        setPrintData(res.data);
      } else {
        setError(res.error);
        setErrorCode(res.code ?? null);
      }
      setLoading(false);
    });
  }, [profile, requisitionId]);

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (loading || !profile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="flex items-center gap-3 text-zinc-500">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading pick list…</span>
        </div>
      </div>
    );
  }

  // ── Error / access denied ───────────────────────────────────────────────────
  if (error) {
    const isForbidden = errorCode === "FORBIDDEN";
    return (
      <div className="min-h-screen flex items-center justify-center bg-white p-6 no-print">
        <div className="max-w-md w-full rounded-xl border border-zinc-200 bg-white shadow-sm p-8 text-center">
          {isForbidden
            ? <ShieldAlert className="mx-auto h-10 w-10 text-red-500 mb-4" />
            : <AlertCircle className="mx-auto h-10 w-10 text-amber-500 mb-4" />}
          <h1 className="text-lg font-bold text-zinc-900 mb-2">
            {isForbidden ? "Access Denied" : "Could Not Load Pick List"}
          </h1>
          <p className="text-sm text-zinc-600 mb-6">{error}</p>
          <button
            onClick={() => router.push("/requisitions")}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-100 text-sm font-semibold text-zinc-700 hover:bg-zinc-200 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Go Back
          </button>
        </div>
      </div>
    );
  }

  if (!printData) return null;

  const printedBy =
    (profile as any).fullName ||
    (profile as any).full_name ||
    profile.name ||
    profile.email ||
    "—";

  return (
    <div className="print-page bg-zinc-100 min-h-screen">
      {/* ── Screen toolbar (hidden in print) ──────────────────────────────── */}
      <div className="no-print sticky top-0 z-50 bg-white border-b border-zinc-200 shadow-sm px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/requisitions")}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-100 text-sm font-medium text-zinc-700 hover:bg-zinc-200 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <div>
            <span className="text-sm font-semibold text-zinc-900">
              Pick List — {printData.requisition.id}
            </span>
            <span className="ml-2 text-xs text-zinc-500">
              {printData.requisition.location}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isHqFulfillment(profile) && (
            <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 font-medium">
              Print / View only
            </span>
          )}
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors shadow-sm"
          >
            <Printer className="h-4 w-4" /> Print
          </button>
        </div>
      </div>

      {/* ── Screen preview card ─────────────────────────────────────────────── */}
      <div className="max-w-5xl mx-auto px-4 py-8 print-document-shell">
        <PrintDocument data={printData} printedBy={printedBy} />
        <p className="mt-4 text-center text-xs text-zinc-400">
          Print preview — click <strong>Print</strong> to send to printer or save as PDF.
        </p>
      </div>
    </div>
  );
}
