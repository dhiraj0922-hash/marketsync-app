"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { Drawer } from "@/components/ui/drawer";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  Download,
  Eye,
  FileText,
  Loader2,
  MapPin,
  ReceiptText,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import {
  finalizeInvoice,
  generateInvoices,
  generateMonthlyInvoices,
  getInvoiceEligibilityAudit,
  loadInvoiceItems,
  loadInvoices,
  loadLocations,
  markInvoicePaid,
  voidInvoice,
  type Invoice,
  type InvoiceEligibilityRow,
  type InvoiceItem,
  type MonthlyInvoiceSummary,
  getLocationBillingProfile,
  type LocationBillingProfile,
} from "@/lib/storage";

// ─── Period helpers ───────────────────────────────────────────────────────────

/** Compute the last day of a month given YYYY-MM */
function lastDayOfMonth(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(y, m, 0); // day 0 of next month = last day of this month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Compute biweekly period end given start date string YYYY-MM-DD */
function biweeklyEnd(startStr: string): string {
  const d = new Date(startStr + "T00:00:00");
  const day = d.getDate();
  if (day <= 15) {
    // First half: end on 15th
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-15`;
  } else {
    // Second half: end on last day of month
    return lastDayOfMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
}

/** Derives period start from a biweekly date selection */
function biweeklyStart(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDate();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return day <= 15 ? `${y}-${m}-01` : `${y}-${m}-16`;
}

/** Compute [periodStart, periodEnd] for a given frequency and picker value */
function computePeriod(
  frequency: "daily" | "biweekly" | "monthly",
  monthPicker: string,  // YYYY-MM (for monthly)
  datePicker: string    // YYYY-MM-DD (for daily/biweekly)
): { periodStart: string; periodEnd: string } {
  if (frequency === "monthly") {
    return {
      periodStart: `${monthPicker.slice(0, 7)}-01`,
      periodEnd: lastDayOfMonth(monthPicker.slice(0, 7)),
    };
  }
  if (frequency === "biweekly") {
    const start = biweeklyStart(datePicker);
    return { periodStart: start, periodEnd: biweeklyEnd(start) };
  }
  // daily
  return { periodStart: datePicker, periodEnd: datePicker };
}

// ─── Display helpers ──────────────────────────────────────────────────────────

function monthLabel(value: string) {
  const date = new Date(`${value.slice(0, 7)}-01T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function formatDateShort(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatPeriod(invoice: Invoice) {
  const start = new Date(invoice.periodStart + "T00:00:00");
  const end = new Date(invoice.periodEnd + "T00:00:00");
  const opt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  if (invoice.billingFrequency === "daily") {
    return start.toLocaleDateString("en-US", opt);
  }
  return `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", opt)}`;
}

function formatPeriodFromDates(start: string, end: string) {
  if (start === end) return formatDateShort(start);
  return `${formatDateShort(start)} – ${formatDateShort(end)}`;
}

function money(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "CAD" });
}

function statusClass(status: Invoice["status"]) {
  const map: Record<Invoice["status"], string> = {
    draft: "border-slate-200 bg-slate-50 text-slate-600",
    finalized: "border-blue-200 bg-blue-50 text-blue-700",
    sent: "border-amber-200 bg-amber-50 text-amber-700",
    paid: "border-emerald-200 bg-emerald-50 text-emerald-700",
    void: "border-rose-200 bg-rose-50 text-rose-700",
  };
  return map[status] ?? map.draft;
}

function clipText(value: string | number | null | undefined, maxLength: number) {
  const text = String(value ?? "-").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function pdfFileName(invoiceNumber: string) {
  const safeName = invoiceNumber.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safeName || "invoice"}.pdf`;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function openPdfPreviewWindow(invoiceNumber: string) {
  if (typeof window === "undefined") return null;
  const previewWindow = window.open("", "_blank");
  if (!previewWindow) return null;
  previewWindow.document.write(`<!doctype html><html><head><title>${pdfFileName(invoiceNumber)}</title></head>
    <body style="font-family:system-ui,sans-serif;padding:24px;color:#0f172a;"><p style="font-size:14px;">Preparing invoice PDF...</p></body></html>`);
  previewWindow.document.close();
  return previewWindow;
}

async function saveInvoicePdf(
  invoice: Invoice,
  items: InvoiceItem[],
  locationName: string,
  billingProfile: LocationBillingProfile | null,
  previewWindow?: Window | null
) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
  const pageBottom = 720;
  const left = 42;
  let y = 52;

  const setBodyStyle = (size = 10, style: "normal" | "bold" = "normal") => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.setTextColor(15, 23, 42);
  };

  const ensureSpace = (height = 18) => {
    if (y + height <= pageBottom) return;
    doc.addPage();
    y = 52;
    setBodyStyle();
  };

  const write = (text: string, x = left, size = 10, style: "normal" | "bold" = "normal", step = 16) => {
    ensureSpace(step);
    setBodyStyle(size, style);
    doc.text(text, x, y);
    y += step;
  };

  const drawRule = () => {
    ensureSpace(12);
    doc.setDrawColor(203, 213, 225);
    doc.line(left, y, 570, y);
    y += 12;
  };

  const writeTableHeader = () => {
    ensureSpace(24);
    setBodyStyle(9, "bold");
    doc.text("Item", left, y);
    doc.text("Requisition", 246, y);
    doc.text("Qty", 356, y, { align: "right" });
    doc.text("Unit Price", 448, y, { align: "right" });
    doc.text("Line Total", 570, y, { align: "right" });
    y += 10;
    drawRule();
  };

  const requisitions = Array.from(new Set(items.map((item) => item.requisitionId).filter(Boolean))) as string[];

  // Header
  setBodyStyle(20, "bold");
  doc.setTextColor(37, 99, 235);
  doc.text("STOCK DHARMA", left, y);
  y += 22;
  setBodyStyle(10, "normal");
  doc.setTextColor(100, 116, 139);
  const frequencyLabel = invoice.billingFrequency
    ? invoice.billingFrequency.charAt(0).toUpperCase() + invoice.billingFrequency.slice(1)
    : "Monthly";
  doc.text(`${frequencyLabel} Location Invoice`, left, y);
  y += 18;
  drawRule();

  const colWidth = 240;
  let detailsY = y;

  setBodyStyle(10, "bold");
  doc.text("INVOICE SUMMARY", left, detailsY);
  detailsY += 16;
  setBodyStyle(9, "normal");
  doc.text(`Invoice Number: ${invoice.invoiceNumber}`, left, detailsY); detailsY += 14;
  const periodStr = formatPeriod(invoice);
  doc.text(`Billing Period: ${periodStr}`, left, detailsY); detailsY += 14;
  doc.text(`Billing Cycle: ${frequencyLabel}`, left, detailsY); detailsY += 14;
  doc.text(`Status: ${invoice.status.toUpperCase()}`, left, detailsY); detailsY += 14;
  doc.text(`Issued: ${new Date(invoice.generatedAt).toLocaleDateString()}`, left, detailsY); detailsY += 14;

  if (requisitions.length > 0) {
    detailsY += 6;
    setBodyStyle(9, "bold");
    doc.text("Requisitions included:", left, detailsY); detailsY += 12;
    setBodyStyle(8, "normal");
    const reqLines = doc.splitTextToSize(requisitions.join(", "), 220) as string[];
    reqLines.forEach((line) => { doc.text(line, left, detailsY); detailsY += 10; });
  }

  let rightY = y;
  const storeName = invoice.locationNameSnapshot ?? locationName;
  const storeAddr = billingProfile?.storeAddress
    ? `${billingProfile.storeAddress}, ${billingProfile.storeCity ?? ""}, ${billingProfile.storeProvince ?? ""} ${billingProfile.storePostalCode ?? ""}`.trim()
    : "Physical address not configured";
  const storePhone = billingProfile?.storePhone ? `Phone: ${billingProfile.storePhone}` : "Phone: —";

  setBodyStyle(10, "bold");
  doc.text("STORE LOCATION", left + colWidth, rightY); rightY += 16;
  setBodyStyle(9, "normal");
  doc.text(storeName, left + colWidth, rightY); rightY += 14;
  const storeAddrLines = doc.splitTextToSize(storeAddr, 260) as string[];
  storeAddrLines.forEach((line) => { doc.text(line, left + colWidth, rightY); rightY += 13; });
  doc.text(storePhone, left + colWidth, rightY); rightY += 19;

  setBodyStyle(10, "bold");
  doc.text("BILL TO", left + colWidth, rightY); rightY += 16;
  setBodyStyle(9, "normal");
  const corpName = billingProfile?.legalName ?? `Franchise Location: ${storeName}`;
  const corpBillAddress = billingProfile?.billingAddress
    ? `${billingProfile.billingAddress}, ${billingProfile.billingCity ?? ""}, ${billingProfile.billingProvince ?? ""} ${billingProfile.billingPostalCode ?? ""}`.trim()
    : storeAddr;
  doc.text(corpName, left + colWidth, rightY); rightY += 14;
  const billLines = doc.splitTextToSize(corpBillAddress, 260) as string[];
  billLines.forEach((line) => { doc.text(line, left + colWidth, rightY); rightY += 13; });
  if (billingProfile?.hstNumber) { doc.text(`HST: ${billingProfile.hstNumber}`, left + colWidth, rightY); rightY += 13; }

  y = Math.max(detailsY, rightY) + 15;
  drawRule();
  writeTableHeader();

  if (items.length === 0) {
    write("No invoice line items found.", left, 10, "normal", 22);
  } else {
    items.forEach((item) => {
      const itemLines = doc.splitTextToSize(item.itemName || "-", 190) as string[];
      const rowHeight = Math.max(18, itemLines.length * 11 + 6);
      ensureSpace(rowHeight);
      setBodyStyle(9);
      itemLines.forEach((line, index) => { doc.text(line, left, y + index * 11); });
      doc.text(clipText(item.requisitionId ?? "-", 18), 246, y);
      doc.text(`${item.quantity}${item.unitSnapshot ? ` ${item.unitSnapshot}` : ""}`, 356, y, { align: "right" });
      doc.text(money(item.unitPrice), 448, y, { align: "right" });
      doc.text(money(item.lineTotal), 570, y, { align: "right" });
      y += rowHeight;
    });
  }

  ensureSpace(96);
  drawRule();
  setBodyStyle(10, "bold");
  doc.text(`Subtotal: ${money(invoice.subtotal)}`, 570, y, { align: "right" }); y += 16;
  doc.text(`${invoice.taxName ?? "HST"} (${((invoice.taxRate ?? 0.13) * 100).toFixed(0)}%): ${money(invoice.taxAmount)}`, 570, y, { align: "right" }); y += 18;
  doc.setFontSize(12);
  doc.text(`Total: ${money(invoice.totalAmount)}`, 570, y, { align: "right" });

  const pdfBlob = doc.output("blob");
  const fileName = pdfFileName(invoice.invoiceNumber);
  const pdfUrl = URL.createObjectURL(pdfBlob);

  if (previewWindow && !previewWindow.closed) {
    previewWindow.location.href = pdfUrl;
  }
  downloadBlob(pdfBlob, fileName);
  window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 30000);
}

// ─── Eligibility Audit Table ──────────────────────────────────────────────────

function EligibilityAuditTable({
  rows,
}: {
  rows: InvoiceEligibilityRow[];
}) {
  const eligibleCount = rows.filter((r) => r.isEligible || r.result === "Eligible").length;
  const excludedCount = rows.length - eligibleCount;

  // Sort eligible requisitions first, then by fulfillment anchor.
  const sorted = [...rows].sort((a, b) => {
    const aEligible = a.isEligible || a.result === "Eligible";
    const bEligible = b.isEligible || b.result === "Eligible";
    if (aEligible !== bEligible) return aEligible ? -1 : 1;
    return new Date(b.fulfillmentDate ?? 0).getTime() - new Date(a.fulfillmentDate ?? 0).getTime();
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 px-3 py-1 text-emerald-700 font-semibold">
          <CheckCircle2 className="h-3.5 w-3.5" /> {eligibleCount} eligible
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 border border-rose-200 px-3 py-1 text-rose-700 font-semibold">
          <XCircle className="h-3.5 w-3.5" /> {excludedCount} excluded
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Requisition ID</th>
              <th className="px-3 py-2 text-left">Location</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Fulfillment Anchor</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-right">Fulfilled Qty</th>
              <th className="px-3 py-2 text-right">Backorder Qty</th>
              <th className="px-3 py-2 text-right">Fulfilled Value</th>
              <th className="px-3 py-2 text-left">Existing Invoice</th>
              <th className="px-3 py-2 text-left">Result</th>
              <th className="px-3 py-2 text-left">Exclusion Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map((row) => {
              const isEligible = row.isEligible || row.result === "Eligible";
              return (
                <tr
                  key={row.requisitionId}
                  className={isEligible ? "hover:bg-emerald-50/30" : "hover:bg-rose-50/20"}
                >
                  <td className="px-3 py-2 font-mono text-[11px] font-semibold text-slate-800">
                    {row.requestId || row.requisitionId}
                    <div className="text-[9px] font-normal text-slate-400">{row.requisitionId}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{row.locationName}</td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">{row.status}</span>
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {row.fulfillmentDate
                      ? new Date(row.fulfillmentDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                      : <span className="text-rose-500">—</span>}
                    {row.fulfillmentSource && row.fulfillmentSource !== "unavailable" && (
                      <div className="text-[9px] text-slate-400 mt-0.5">{row.fulfillmentSource}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{row.sourceTypeSummary || "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.fulfilledQty}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.backorderQty || "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(row.fulfilledValue)}</td>
                  <td className="px-3 py-2 font-mono text-[10px] text-slate-500">
                    {row.existingInvoiceNo ?? "—"}
                    {row.existingInvStatus && (
                      <div className="text-[9px] text-slate-400">{row.existingInvStatus}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {isEligible ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Eligible
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-rose-600 font-semibold">
                        <XCircle className="h-3.5 w-3.5" /> Excluded
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500 italic">{row.exclusionReason ?? "—"}</td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-slate-400">
                  No requisitions found for this period and location.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Void Invoice Dialog ──────────────────────────────────────────────────────

function VoidInvoiceDialog({
  invoice,
  onVoided,
  onCancel,
}: {
  invoice: Invoice;
  onVoided: () => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("Incorrect billing period / test generation");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleVoid() {
    if (!reason.trim()) { setError("Void reason is required."); return; }
    setLoading(true);
    setError(null);
    const result = await voidInvoice(invoice.id, reason.trim());
    setLoading(false);
    if (!result.success) { setError(result.error ?? "Void failed."); return; }
    onVoided();
  }

  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 space-y-4">
      <div className="flex items-center gap-2 text-rose-700">
        <ShieldAlert className="h-5 w-5" />
        <span className="font-semibold">Void Invoice — {invoice.invoiceNumber}</span>
      </div>
      <p className="text-sm text-rose-800">
        Voiding this invoice will unlink all associated requisitions so they can be re-invoiced in a corrected batch.
        This action is permanent and logged.
      </p>
      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wider text-rose-700">Void Reason *</span>
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm"
        >
          <option>Incorrect billing period / test generation</option>
          <option>Duplicate invoice</option>
          <option>Wrong location</option>
          <option>Data error — please regenerate</option>
        </select>
      </label>
      {error && <p className="text-sm text-rose-700 font-semibold">{error}</p>}
      <div className="flex gap-3">
        <button
          onClick={handleVoid}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
          Confirm Void
        </button>
        <button onClick={onCancel} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

function MonthlyInvoicesContent() {
  const defaultMonth = new Date().toISOString().slice(0, 7);
  const defaultDate = new Date().toISOString().slice(0, 10);

  // ── GENERATOR STATE (completely separate from summary filters) ─────────────
  const [genFrequency, setGenFrequency] = useState<"daily" | "biweekly" | "monthly">("monthly");
  const [genMonth, setGenMonth] = useState(defaultMonth);     // YYYY-MM (for monthly)
  const [genDate, setGenDate] = useState(defaultDate);         // YYYY-MM-DD (for daily/biweekly)
  const [genLocationId, setGenLocationId] = useState("all");  // generator-only location

  // ── SUMMARY FILTER STATE (completely separate from generator) ──────────────
  const [filterFrequency, setFilterFrequency] = useState<"all" | "daily" | "biweekly" | "monthly">("all");
  const [filterMonth, setFilterMonth] = useState(defaultMonth);
  const [filterDate, setFilterDate] = useState(defaultDate);
  const [filterLocationId, setFilterLocationId] = useState("all");

  // ── Shared ─────────────────────────────────────────────────────────────────
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isItemsLoading, setIsItemsLoading] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "warning" | "error"; message: string } | null>(null);
  const [lastSummary, setLastSummary] = useState<MonthlyInvoiceSummary[]>([]);
  const [voidingInvoice, setVoidingInvoice] = useState<Invoice | null>(null);

  // ── Eligibility audit state ────────────────────────────────────────────────
  const [showAudit, setShowAudit] = useState(false);
  const [auditRows, setAuditRows] = useState<InvoiceEligibilityRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditScopeKey, setAuditScopeKey] = useState<string | null>(null);

  const locationNameById = useMemo(() => {
    const map = new Map<string, string>();
    locations.forEach((loc) => map.set(loc.id, loc.name || loc.id));
    return map;
  }, [locations]);

  const selectedSummaryLocationFilter = filterLocationId === "all" ? null : filterLocationId;
  const selectedGenLocationFilter = genLocationId === "all" ? null : genLocationId;

  // ── Derived period for generator ───────────────────────────────────────────
  const genPeriod = useMemo(
    () => computePeriod(genFrequency, genMonth, genDate),
    [genFrequency, genMonth, genDate]
  );

  const currentScopeKey = useMemo(
    () => `${genFrequency}|${genPeriod.periodStart}|${genPeriod.periodEnd}|${selectedGenLocationFilter ?? "all"}`,
    [genFrequency, genPeriod.periodStart, genPeriod.periodEnd, selectedGenLocationFilter]
  );

  const resetAuditForScopeChange = useCallback(() => {
    setAuditRows([]);
    setAuditError(null);
    setAuditScopeKey(null);
    setLastSummary([]);
  }, []);

  // ── Fetch invoices using SUMMARY filter state ──────────────────────────────
  const fetchInvoices = useCallback(async () => {
    setIsLoading(true);
    try {
      const rows = await loadInvoices({
        month: filterMonth,
        date: filterDate,
        locationId: selectedSummaryLocationFilter,
        billingFrequency: filterFrequency === "all" ? "all" : filterFrequency,
      });
      setInvoices(rows);
    } finally {
      setIsLoading(false);
    }
  }, [filterMonth, filterDate, selectedSummaryLocationFilter, filterFrequency]);

  useEffect(() => {
    (async () => {
      const locs = await loadLocations();
      setLocations(
        Array.isArray(locs)
          ? locs
              .filter((loc: any) => loc.id !== "LOC-HQ")
              .map((loc: any) => ({ id: loc.id, name: loc.name ?? loc.id }))
          : []
      );
    })();
  }, []);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  useEffect(() => {
    if (!selectedInvoice) { setInvoiceItems([]); return; }
    let cancelled = false;
    setIsItemsLoading(true);
    loadInvoiceItems(selectedInvoice.id).then((items) => {
      if (!cancelled) { setInvoiceItems(items); setIsItemsLoading(false); }
    });
    return () => { cancelled = true; };
  }, [selectedInvoice]);

  const totals = useMemo(
    () => invoices.reduce(
      (acc, inv) => ({ subtotal: acc.subtotal + inv.subtotal, tax: acc.tax + inv.taxAmount, total: acc.total + inv.totalAmount }),
      { subtotal: 0, tax: 0, total: 0 }
    ),
    [invoices]
  );

  const requisitionNumbers = useMemo(
    () => Array.from(new Set(invoiceItems.map((item) => item.requisitionId).filter(Boolean))) as string[],
    [invoiceItems]
  );

  // ── Run audit ──────────────────────────────────────────────────────────────
  async function handleRunAudit() {
    // DIAGNOSTIC — confirm location UUID is being passed, not name/code/"all"
    const auditLocationId = genLocationId === 'all' ? null : genLocationId;
    console.log('[Audit] invoking get_invoice_eligibility_audit with:', {
      genFrequency,
      periodStart: genPeriod.periodStart,
      periodEnd: genPeriod.periodEnd,
      genLocationId,               // raw dropdown value
      auditLocationId,             // what RPC will receive: null or UUID
      selectedGenLocation: locationNameById.get(genLocationId) ?? (genLocationId === 'all' ? 'All Locations' : genLocationId),
    });

    setAuditLoading(true);
    setAuditError(null);
    setShowAudit(true);
    const result = await getInvoiceEligibilityAudit(
      genFrequency,
      genPeriod.periodStart,
      genPeriod.periodEnd,
      auditLocationId  // always null when 'all', UUID otherwise
    );
    setAuditLoading(false);
    if (!result.success) {
      setAuditError(result.error ?? 'Audit failed.');
      setAuditScopeKey(null);
      return;
    }
    setAuditRows(result.data ?? []);
    setAuditScopeKey(currentScopeKey);
  }

  // ── Generate ───────────────────────────────────────────────────────────────
  async function handleGenerate() {
    const hasFreshEligiblePreview = auditScopeKey === currentScopeKey
      && auditRows.some((row) => row.isEligible || row.result === "Eligible");
    if (!hasFreshEligiblePreview) {
      setNotice({
        type: "warning",
        message: "Run Preview Billable Requisitions first. Generate is only enabled from a fresh eligibility preview for the selected period and location.",
      });
      setShowAudit(true);
      return;
    }

    // DIAGNOSTIC — confirm location UUID is being passed, not name/code/"all"
    const generateLocationId = genLocationId === 'all' ? null : genLocationId;
    console.log('[Generate] invoking generate_invoices with:', {
      genFrequency,
      periodStart: genPeriod.periodStart,
      genLocationId,               // raw dropdown value
      generateLocationId,          // what RPC will receive: null or UUID
      selectedGenLocation: locationNameById.get(genLocationId) ?? (genLocationId === 'all' ? 'All Locations' : genLocationId),
    });

    setIsGenerating(true);
    setNotice(null);
    setLastSummary([]);
    try {
      const result = await generateInvoices(
        genFrequency,
        genPeriod.periodStart,
        generateLocationId  // always null when 'all', UUID otherwise
      );
      if (!result.success) {
        setNotice({ type: 'error', message: result.error?.message ?? 'Invoice generation failed.' });
        return;
      }
      const generated = result.data ?? [];
      setLastSummary(generated);

      if (generated.length > 0) {
        // Sync summary filters to the generated period so invoices appear immediately
        setFilterFrequency(genFrequency);
        if (genFrequency === 'monthly') {
          setFilterMonth(genMonth);
        } else {
          // For biweekly/daily: store the derived period start so filter loads correctly
          setFilterDate(genPeriod.periodStart);
        }
        // If only one location was invoiced, auto-focus summary on that location
        if (generated.length === 1) {
          setFilterLocationId(generated[0].locationId);
        } else {
          setFilterLocationId(generateLocationId ?? 'all');
        }
        setNotice({
          type: 'success',
          message: `Generated ${generated.length} draft invoice${generated.length === 1 ? '' : 's'} for ${formatPeriodFromDates(genPeriod.periodStart, genPeriod.periodEnd)}.`,
        });
      } else {
        setNotice({
          type: 'warning',
          message: `No eligible fulfilled requisitions found for ${formatPeriodFromDates(genPeriod.periodStart, genPeriod.periodEnd)}${
            generateLocationId ? ` at ${locationNameById.get(generateLocationId) ?? generateLocationId}` : ''
          }. Run the Eligibility Audit to see why.`,
        });
      }

      await fetchInvoices();
      await handleRunAudit();
    } finally {
      setIsGenerating(false);
    }
  }

  async function runInvoiceAction(invoice: Invoice, action: "finalize" | "paid") {
    if (invoice.subtotal > 0 && invoice.taxAmount <= 0) {
      setNotice({
        type: "error",
        message: `${invoice.invoiceNumber} cannot be ${action === "finalize" ? "finalized" : "marked paid"} because HST is CA$0.00 on a positive subtotal. Run the HST repair migration and regenerate/repair this draft first.`,
      });
      return;
    }

    setActionLoadingId(invoice.id);
    try {
      const result = action === "finalize" ? await finalizeInvoice(invoice.id) : await markInvoicePaid(invoice.id);
      if (!result.success) {
        setNotice({ type: "error", message: result.error?.message ?? "Invoice update failed." });
        return;
      }
      setNotice({
        type: "success",
        message: action === "finalize" ? `${invoice.invoiceNumber} finalized.` : `${invoice.invoiceNumber} marked paid.`,
      });
      await fetchInvoices();
      if (selectedInvoice?.id === invoice.id) {
        const refreshed = await loadInvoices({ month: filterMonth, date: filterDate, locationId: selectedSummaryLocationFilter, billingFrequency: filterFrequency === "all" ? "all" : filterFrequency });
        setSelectedInvoice(refreshed.find((row) => row.id === invoice.id) ?? null);
      }
    } finally {
      setActionLoadingId(null);
    }
  }

  async function handleDownloadPdf(invoice: Invoice, currentItems?: InvoiceItem[]) {
    const previewWindow = openPdfPreviewWindow(invoice.invoiceNumber);
    setPdfLoadingId(invoice.id);
    setNotice(null);
    try {
      const items = currentItems && currentItems.length > 0 ? currentItems : await loadInvoiceItems(invoice.id);
      const locationName = invoice.locationNameSnapshot ?? locationNameById.get(invoice.locationId) ?? invoice.locationId;
      const billingProfile = await getLocationBillingProfile(invoice.locationId);
      await saveInvoicePdf(invoice, items, locationName, billingProfile, previewWindow);
    } catch (err) {
      console.error("Invoice PDF download failed", err);
      if (previewWindow && !previewWindow.closed) {
        previewWindow.document.body.innerHTML = `<p style="font-family:system-ui,sans-serif;padding:24px;color:#92400e;">PDF download failed. Please try again.</p>`;
      }
      setNotice({ type: "error", message: "PDF download failed. Please try again." });
    } finally {
      setPdfLoadingId(null);
    }
  }

  async function handleVoided() {
    setVoidingInvoice(null);
    setNotice({ type: "success", message: "Invoice voided. Requisitions are now available for re-invoicing." });
    await fetchInvoices();
    if (selectedInvoice) {
      const refreshed = await loadInvoices({ month: filterMonth, date: filterDate, locationId: selectedSummaryLocationFilter, billingFrequency: filterFrequency === "all" ? "all" : filterFrequency });
      const updated = refreshed.find((r) => r.id === selectedInvoice.id);
      setSelectedInvoice(updated ?? null);
    }
  }

  const genPeriodLabel = useMemo(
    () => formatPeriodFromDates(genPeriod.periodStart, genPeriod.periodEnd),
    [genPeriod]
  );

  const auditSummary = useMemo(() => {
    const eligibleRows = auditRows.filter((row) => row.isEligible || row.result === "Eligible");
    const excludedRows = auditRows.filter((row) => !(row.isEligible || row.result === "Eligible"));
    const excludedByReason = (needle: string) =>
      excludedRows.filter((row) => (row.exclusionReason ?? "").toLowerCase().includes(needle)).length;
    const subtotal = eligibleRows.reduce((sum, row) => sum + Number(row.fulfilledValue || 0), 0);
    const partialIncluded = eligibleRows.filter((row) => {
      const status = String(row.status ?? "").toLowerCase();
      return row.backorderQty > 0 || status.includes("partial") || status.includes("backorder");
    }).length;

    return {
      reviewed: auditRows.length,
      eligible: eligibleRows.length,
      partialIncluded,
      alreadyInvoicedExcluded: excludedRows.filter((row) => row.existingInvoiceId || (row.exclusionReason ?? "").toLowerCase().includes("already invoiced")).length,
      localVendorExcluded: excludedByReason("local vendor"),
      noFulfilledQtyExcluded: excludedByReason("no fulfilled"),
      cancelledRejectedExcluded: excludedRows.filter((row) => {
        const status = String(row.status ?? "").toLowerCase();
        const reason = String(row.exclusionReason ?? "").toLowerCase();
        return ["cancelled", "canceled", "rejected", "void"].some((word) => status.includes(word) || reason.includes(word));
      }).length,
      subtotal,
      hst: Math.round(subtotal * 0.13 * 100) / 100,
      total: subtotal + Math.round(subtotal * 0.13 * 100) / 100,
    };
  }, [auditRows]);

  const hasFreshAudit = auditScopeKey === currentScopeKey;
  const canGenerateFromPreview = hasFreshAudit && auditSummary.eligible > 0 && !auditLoading && !isGenerating;

  // Derived filter period for biweekly summary — shows "Jul 1–15, 2026" not raw date
  const filterPeriod = useMemo(() => {
    if (filterFrequency === 'biweekly') {
      const start = biweeklyStart(filterDate);
      return { periodStart: start, periodEnd: biweeklyEnd(start) };
    }
    if (filterFrequency === 'daily') return { periodStart: filterDate, periodEnd: filterDate };
    return null;  // monthly uses filterMonth
  }, [filterFrequency, filterDate]);

  const filterPeriodLabel = useMemo(() => {
    if (filterFrequency === 'monthly') return monthLabel(filterMonth);
    if (filterPeriod) return formatPeriodFromDates(filterPeriod.periodStart, filterPeriod.periodEnd);
    return filterDate;
  }, [filterFrequency, filterMonth, filterDate, filterPeriod]);

  return (
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-slate-50 p-4 text-slate-900 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">

        {/* ── Generator Section ──────────────────────────────────────────── */}
        <section className="rounded-3xl border border-emerald-100 bg-gradient-to-br from-white via-emerald-50/70 to-slate-50 p-5 shadow-sm sm:p-7">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
            <div className="max-w-3xl">
              <p className="text-xs font-bold uppercase tracking-[0.24em] text-emerald-700">STOCK DHARMA</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-5xl">HQ Location Invoices</h1>
              <p className="mt-3 text-base text-slate-600">
                Generate daily, biweekly, and monthly invoices from fulfilled HQ requisition quantities.
              </p>
            </div>
          </div>

          <div className="border-t border-emerald-100/50 pt-5 mt-5">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Step 1 — Select Billing Scope</p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
              {/* Billing Cycle */}
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-800">Billing Cycle</span>
                <select
                  value={genFrequency}
                  onChange={(e) => {
                    setGenFrequency(e.target.value as any);
                    resetAuditForScopeChange();
                  }}
                  className="mt-1.5 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
                >
                  <option value="daily">Daily</option>
                  <option value="biweekly">Biweekly (Half-Month)</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>

              {/* Period Picker */}
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-800">
                  {genFrequency === 'monthly'
                    ? 'Invoice Month'
                    : genFrequency === 'biweekly'
                    ? 'Period Half (pick any date in half)'
                    : 'Date'}
                </span>
                <input
                  type={genFrequency === 'monthly' ? 'month' : 'date'}
                  value={genFrequency === 'monthly' ? genMonth : genDate}
                  onChange={(e) => {
                    if (genFrequency === 'monthly') setGenMonth(e.target.value);
                    else setGenDate(e.target.value);
                    resetAuditForScopeChange();
                  }}
                  className="mt-1.5 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
                />
                {/* Always show derived period range so user sees Jul 1–15 not raw date */}
                <span className="mt-1 block text-[11px] font-semibold text-emerald-700">
                  Period: {genPeriodLabel}
                </span>
                {genFrequency === 'biweekly' && (
                  <span className="mt-0.5 block text-[10px] text-slate-400">
                    Picks 1st–15th if day ≤ 15, else 16th–EOM
                  </span>
                )}
              </label>

              {/* Generator Location (separate from filter) */}
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-800">Generate For</span>
                <select
                  value={genLocationId}
                  onChange={(e) => {
                    setGenLocationId(e.target.value);
                    resetAuditForScopeChange();
                  }}
                  className="mt-1.5 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
                >
                  <option value="all">All Locations</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name}</option>
                  ))}
                </select>
              </label>

              {/* Actions */}
              <div className="flex flex-col gap-2 justify-end">
                <button
                  onClick={handleRunAudit}
                  disabled={auditLoading}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-white px-4 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                >
                  {auditLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Step 2 — Preview Billable Requisitions
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={!canGenerateFromPreview}
                  className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ReceiptText className="h-3.5 w-3.5" />}
                  Step 4 — Generate Draft Invoice
                </button>
              </div>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Selected Period</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{genPeriodLabel}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Selected Location</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {selectedGenLocationFilter ? locationNameById.get(selectedGenLocationFilter) ?? selectedGenLocationFilter : "All Locations"}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Preview Status</p>
                <p className={`mt-1 text-sm font-semibold ${hasFreshAudit ? "text-emerald-700" : "text-amber-700"}`}>
                  {hasFreshAudit ? `${auditSummary.eligible} eligible of ${auditSummary.reviewed} reviewed` : "Run preview before generating"}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Estimated Total</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {money(auditSummary.subtotal)} + HST {money(auditSummary.hst)} = {money(auditSummary.total)}
                </p>
              </div>
            </div>
            {!canGenerateFromPreview && (
              <p className="mt-3 text-xs font-medium text-amber-700">
                Generate is locked until Step 2 returns at least one eligible requisition for the exact selected period and location.
              </p>
            )}
          </div>
        </section>

        {/* ── Notice ─────────────────────────────────────────────────────── */}
        {notice && (
          <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold ${
            notice.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : notice.type === "warning"
              ? "border-amber-200 bg-amber-50 text-amber-700"
              : "border-rose-200 bg-rose-50 text-rose-700"
          }`}>
            {notice.type === "success" ? <CheckCircle2 className="h-4 w-4" />
              : notice.type === "warning" ? <AlertTriangle className="h-4 w-4" />
              : <XCircle className="h-4 w-4" />}
            {notice.message}
          </div>
        )}

        {/* ── Last generated summary chips ──────────────────────────────── */}
        {lastSummary.length > 0 && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            <p className="font-semibold mb-2">Generated this run — {formatPeriodFromDates(genPeriod.periodStart, genPeriod.periodEnd)}</p>
            <div className="flex flex-wrap gap-2">
              {lastSummary.map((summary) => (
                <span key={summary.invoiceId} className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold shadow-sm border border-emerald-100">
                  {summary.invoiceNumber} · {summary.locationName ?? summary.locationId} ·&nbsp;
                  {summary.requisitionCount} req{summary.requisitionCount === 1 ? "" : "s"} ·&nbsp;
                  Sub {money(summary.subtotal)} · HST {money(summary.taxAmount)} ·&nbsp;
                  <strong>Total {money(summary.totalAmount)}</strong>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── Eligibility Audit Panel ────────────────────────────────────── */}
        {showAudit && (
          <section className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-amber-900">Step 2 / Step 3 — Preview and Detail Audit</h2>
                <p className="text-xs text-amber-700 mt-0.5">
                  {genFrequency.charAt(0).toUpperCase() + genFrequency.slice(1)} · {genPeriodLabel}
                  {selectedGenLocationFilter ? ` · ${locationNameById.get(selectedGenLocationFilter) ?? selectedGenLocationFilter}` : " · All Locations"}
                </p>
              </div>
              <button
                onClick={() => setShowAudit(false)}
                className="text-amber-600 hover:text-amber-800 text-sm font-medium"
              >
                Close
              </button>
            </div>
            {auditLoading && (
              <div className="flex items-center gap-2 text-amber-700">
                <Loader2 className="h-4 w-4 animate-spin" /> Running audit...
              </div>
            )}
            {auditError && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                <strong>Audit error:</strong> {auditError}
              </div>
            )}
            {!auditLoading && !auditError && (
              <>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {[
                    ["Requisitions reviewed", auditSummary.reviewed],
                    ["Eligible fulfilled requisitions", auditSummary.eligible],
                    ["Partial fulfilled included", auditSummary.partialIncluded],
                    ["Already invoiced excluded", auditSummary.alreadyInvoicedExcluded],
                    ["Local vendor excluded", auditSummary.localVendorExcluded],
                    ["No fulfilled qty excluded", auditSummary.noFulfilledQtyExcluded],
                    ["Cancelled/rejected excluded", auditSummary.cancelledRejectedExcluded],
                    ["Estimated total", money(auditSummary.total)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-amber-100 bg-white p-3 shadow-sm">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
                    </div>
                  ))}
                </div>
                <div className="rounded-xl border border-emerald-100 bg-white p-4 text-sm text-slate-700">
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <span><strong>Estimated subtotal:</strong> {money(auditSummary.subtotal)}</span>
                    <span><strong>Estimated HST:</strong> {money(auditSummary.hst)}</span>
                    <span><strong>Estimated total:</strong> {money(auditSummary.total)}</span>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    This preview is generated by the same shared candidate source used by invoice generation.
                  </p>
                </div>
                <EligibilityAuditTable rows={auditRows} />
              </>
            )}
          </section>
        )}

        {/* ── Summary Filters ─────────────────────────────────────────────── */}
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_auto]">
          <label className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Summary Cycle Filter</span>
            <select
              value={filterFrequency}
              onChange={(e) => setFilterFrequency(e.target.value as any)}
              className="mt-2 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
            >
              <option value="all">All Cycles</option>
              <option value="daily">Daily</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
              {filterFrequency === "daily" || filterFrequency === "biweekly" ? "Period Start Date" : "Invoice Month"}
            </span>
            <input
              type={filterFrequency === "daily" || filterFrequency === "biweekly" ? "date" : "month"}
              value={filterFrequency === "daily" || filterFrequency === "biweekly" ? filterDate : filterMonth}
              onChange={(e) => filterFrequency === "daily" || filterFrequency === "biweekly" ? setFilterDate(e.target.value) : setFilterMonth(e.target.value)}
              className="mt-2 min-h-11 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
            />
          </label>
          <label className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Filter by Location</span>
            <select
              value={filterLocationId}
              onChange={(e) => setFilterLocationId(e.target.value)}
              className="mt-2 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
            >
              <option value="all">All Locations</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>{loc.name}</option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-3 gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm xl:min-w-[360px]">
            <div>
              <p className="text-xs font-semibold text-slate-500">Subtotal</p>
              <p className="mt-2 text-lg font-semibold text-slate-950">{money(totals.subtotal)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500">HST</p>
              <p className="mt-2 text-lg font-semibold text-slate-950">{money(totals.tax)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500">Total</p>
              <p className="mt-2 text-lg font-semibold text-emerald-700">{money(totals.total)}</p>
            </div>
          </div>
        </section>

        {/* ── Invoice Table ──────────────────────────────────────────────── */}
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Invoice Summary</h2>
              <p className="mt-1 text-sm text-slate-500">
                {filterFrequency === 'all' ? 'All Cycles' : filterFrequency.charAt(0).toUpperCase() + filterFrequency.slice(1)} ·{' '}
                {filterPeriodLabel} ·{' '}
                {filterLocationId === 'all' ? 'All Locations' : (locationNameById.get(filterLocationId) ?? filterLocationId)}
              </p>
            </div>
            <div className="inline-flex items-center gap-2 text-sm text-slate-500">
              <Search className="h-4 w-4" />
              {invoices.length} invoice{invoices.length === 1 ? "" : "s"}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-5 py-3 text-left font-semibold">Invoice #</th>
                  <th className="px-3 py-3 text-left font-semibold">Location</th>
                  <th className="px-3 py-3 text-left font-semibold">Billing Period</th>
                  <th className="px-3 py-3 text-left font-semibold">Status</th>
                  <th className="px-3 py-3 text-right font-semibold">Subtotal</th>
                  <th className="px-3 py-3 text-right font-semibold">HST</th>
                  <th className="px-3 py-3 text-right font-semibold">Total</th>
                  <th className="px-3 py-3 text-left font-semibold">Generated</th>
                  <th className="px-5 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading ? (
                  <tr><td colSpan={9} className="px-5 py-12 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
                ) : invoices.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-5 py-12 text-center text-sm text-slate-500">
                      No invoices found for this selection.
                      {filterFrequency !== "all" && (
                        <div className="mt-2 text-xs text-slate-400">
                          Try "All Cycles" or run an Eligibility Audit to check why requisitions may be excluded.
                        </div>
                      )}
                    </td>
                  </tr>
                ) : (
                  invoices.map((invoice) => (
                    <tr key={invoice.id} className={`transition hover:bg-emerald-50/30 ${invoice.status === "void" ? "opacity-50" : ""}`}>
                      <td className="px-5 py-4 font-semibold text-slate-950">{invoice.invoiceNumber}</td>
                      <td className="px-3 py-4 text-slate-600">
                        <span className="inline-flex items-center gap-1.5">
                          <MapPin className="h-3.5 w-3.5 text-emerald-700" />
                          {invoice.locationNameSnapshot ?? locationNameById.get(invoice.locationId) ?? invoice.locationId}
                        </span>
                      </td>
                      <td className="px-3 py-4 text-slate-600">
                        <div className="flex flex-col">
                          <span className="font-semibold text-slate-900 capitalize">{invoice.billingFrequency || "monthly"}</span>
                          <span className="text-xs text-slate-500">{formatPeriod(invoice)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-4">
                        <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${statusClass(invoice.status)}`}>
                          {invoice.status}
                        </span>
                      </td>
                      <td className="px-3 py-4 text-right tabular-nums text-slate-700">{money(invoice.subtotal)}</td>
                      <td className="px-3 py-4 text-right tabular-nums text-slate-700">{money(invoice.taxAmount)}</td>
                      <td className="px-3 py-4 text-right tabular-nums font-semibold text-slate-950">{money(invoice.totalAmount)}</td>
                      <td className="px-3 py-4 text-slate-600">{new Date(invoice.generatedAt).toLocaleDateString()}</td>
                      <td className="px-5 py-4">
                        <div className="flex flex-wrap justify-end gap-2">
                          <button
                            onClick={() => setSelectedInvoice(invoice)}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            <Eye className="h-3.5 w-3.5" /> View
                          </button>
                          <button
                            onClick={() => handleDownloadPdf(invoice)}
                            disabled={pdfLoadingId === invoice.id}
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {pdfLoadingId === invoice.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                            PDF
                          </button>
                          {invoice.status === "draft" && (
                            <>
                              <button
                                onClick={() => runInvoiceAction(invoice, "finalize")}
                                disabled={actionLoadingId === invoice.id}
                                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-40"
                              >
                                <FileText className="h-3.5 w-3.5" /> Finalize
                              </button>
                              <button
                                onClick={() => setVoidingInvoice(invoice)}
                                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                              >
                                <XCircle className="h-3.5 w-3.5" /> Void
                              </button>
                            </>
                          )}
                          {invoice.status !== "paid" && invoice.status !== "void" && (
                            <button
                              onClick={() => runInvoiceAction(invoice, "paid")}
                              disabled={actionLoadingId === invoice.id}
                              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-40"
                            >
                              {actionLoadingId === invoice.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleDollarSign className="h-3.5 w-3.5" />}
                              Mark Paid
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Void Dialog (inline) ──────────────────────────────────────── */}
        {voidingInvoice && (
          <VoidInvoiceDialog
            invoice={voidingInvoice}
            onVoided={handleVoided}
            onCancel={() => setVoidingInvoice(null)}
          />
        )}

        {/* ── Invoice Detail Drawer ──────────────────────────────────────── */}
        <Drawer
          isOpen={!!selectedInvoice}
          onClose={() => { setSelectedInvoice(null); setVoidingInvoice(null); }}
          title={selectedInvoice ? `Invoice ${selectedInvoice.invoiceNumber}` : "Invoice"}
          description={selectedInvoice
            ? `${selectedInvoice.locationNameSnapshot ?? locationNameById.get(selectedInvoice.locationId) ?? selectedInvoice.locationId} · ${selectedInvoice.billingFrequency.toUpperCase()} (${formatPeriod(selectedInvoice)})`
            : undefined}
        >
          {selectedInvoice && (
            <div className="space-y-5">
              <div className="flex flex-wrap gap-2 justify-end">
                <button
                  onClick={() => handleDownloadPdf(selectedInvoice, invoiceItems)}
                  disabled={isItemsLoading || pdfLoadingId === selectedInvoice.id}
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
                >
                  {pdfLoadingId === selectedInvoice.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Download PDF
                </button>
                {selectedInvoice.status === "draft" && (
                  <button
                    onClick={() => setVoidingInvoice(selectedInvoice)}
                    className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 text-sm font-semibold text-rose-700 hover:bg-rose-100"
                  >
                    <XCircle className="h-4 w-4" /> Void Invoice
                  </button>
                )}
              </div>

              {voidingInvoice?.id === selectedInvoice.id && (
                <VoidInvoiceDialog
                  invoice={selectedInvoice}
                  onVoided={handleVoided}
                  onCancel={() => setVoidingInvoice(null)}
                />
              )}

              <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Location</p>
                  <p className="mt-1 font-semibold text-slate-950">
                    {selectedInvoice.locationNameSnapshot ?? locationNameById.get(selectedInvoice.locationId) ?? selectedInvoice.locationId}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Billing Period</p>
                  <p className="mt-1 font-semibold text-slate-950">{formatPeriod(selectedInvoice)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</p>
                  <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${statusClass(selectedInvoice.status)}`}>
                    {selectedInvoice.status}
                  </span>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Billing Cycle</p>
                  <p className="mt-1 font-semibold capitalize text-slate-950">{selectedInvoice.billingFrequency}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Generated</p>
                  <p className="mt-1 text-slate-700">{new Date(selectedInvoice.generatedAt).toLocaleString()}</p>
                </div>
                {selectedInvoice.voidReason && (
                  <div className="col-span-full">
                    <p className="text-xs font-semibold uppercase tracking-wide text-rose-500">Void Reason</p>
                    <p className="mt-1 text-rose-700">{selectedInvoice.voidReason}</p>
                  </div>
                )}
              </div>

              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Requisitions Included</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {requisitionNumbers.length > 0
                    ? requisitionNumbers.map((reqId) => (
                        <span key={reqId} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">{reqId}</span>
                      ))
                    : <span className="text-sm text-slate-400">Loading...</span>}
                </div>
              </div>

              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500 mb-2">Line Items</p>
                {isItemsLoading ? (
                  <div className="flex items-center gap-2 text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading items...</div>
                ) : invoiceItems.length === 0 ? (
                  <p className="text-sm text-slate-400">No line items found.</p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                        <tr>
                          <th className="px-3 py-2 text-left">Item</th>
                          <th className="px-3 py-2 text-left">Requisition</th>
                          <th className="px-3 py-2 text-right">Fulfilled Qty</th>
                          <th className="px-3 py-2 text-left">Source</th>
                          <th className="px-3 py-2 text-right">Unit Price</th>
                          <th className="px-3 py-2 text-right">Line Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {invoiceItems.map((item) => (
                          <tr key={item.id}>
                            <td className="px-3 py-2 font-medium text-slate-800">{item.itemName}</td>
                            <td className="px-3 py-2 font-mono text-slate-500">{item.requisitionId ?? "—"}</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {item.quantity}{item.unitSnapshot ? ` ${item.unitSnapshot}` : ""}
                            </td>
                            <td className="px-3 py-2 text-slate-500">
                              {item.sourceTypeSnapshot ?? "hq_supplied"}
                              {item.packQtySnapshot ? <div className="text-[10px] text-slate-400">Pack {item.packQtySnapshot}</div> : null}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{money(item.unitPrice)}</td>
                            <td className="px-3 py-2 text-right tabular-nums font-semibold">{money(item.lineTotal)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Totals */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">Subtotal</span>
                  <span className="font-semibold tabular-nums">{money(selectedInvoice.subtotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{selectedInvoice.taxName ?? "HST"} ({((selectedInvoice.taxRate ?? 0.13) * 100).toFixed(0)}%)</span>
                  <span className="font-semibold tabular-nums">{money(selectedInvoice.taxAmount)}</span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold">
                  <span>Total</span>
                  <span className="text-emerald-700">{money(selectedInvoice.totalAmount)}</span>
                </div>
              </div>

              {/* Actions */}
              {selectedInvoice.status !== "void" && (
                <div className="flex flex-wrap gap-3">
                  {selectedInvoice.status === "draft" && (
                    <button
                      onClick={() => runInvoiceAction(selectedInvoice, "finalize")}
                      disabled={actionLoadingId === selectedInvoice.id}
                      className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-40"
                    >
                      <FileText className="h-4 w-4" /> Finalize Invoice
                    </button>
                  )}
                  {selectedInvoice.status !== "paid" && (
                    <button
                      onClick={() => runInvoiceAction(selectedInvoice, "paid")}
                      disabled={actionLoadingId === selectedInvoice.id}
                      className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-40"
                    >
                      {actionLoadingId === selectedInvoice.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleDollarSign className="h-4 w-4" />}
                      Mark Paid
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </Drawer>
      </div>
    </div>
  );
}

export default function InvoicesPage() {
  return (
    <HQOnlyGuard>
      <MonthlyInvoicesContent />
    </HQOnlyGuard>
  );
}
