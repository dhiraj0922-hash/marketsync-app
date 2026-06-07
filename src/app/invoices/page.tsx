"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { Drawer } from "@/components/ui/drawer";
import {
  CheckCircle2,
  CircleDollarSign,
  Download,
  Eye,
  FileText,
  Loader2,
  MapPin,
  ReceiptText,
  Search,
} from "lucide-react";
import {
  finalizeInvoice,
  generateInvoices,
  generateMonthlyInvoices,
  loadInvoiceItems,
  loadInvoices,
  loadLocations,
  markInvoicePaid,
  type Invoice,
  type InvoiceItem,
  type MonthlyInvoiceSummary,
  getLocationBillingProfile,
  type LocationBillingProfile,
} from "@/lib/storage";

function monthLabel(value: string) {
  const date = new Date(`${value.slice(0, 7)}-01T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function formatPeriod(invoice: Invoice) {
  const start = new Date(invoice.periodStart + "T00:00:00");
  const end = new Date(invoice.periodEnd + "T00:00:00");
  
  const opt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  
  if (invoice.billingFrequency === "daily") {
    return start.toLocaleDateString("en-US", opt);
  }
  return `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${end.toLocaleDateString("en-US", opt)}`;
}

function money(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
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
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("PDF download is only available in the browser.");
  }

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

  previewWindow.document.write(`
    <!doctype html>
    <html>
      <head><title>${pdfFileName(invoiceNumber)}</title></head>
      <body style="font-family: system-ui, sans-serif; padding: 24px; color: #0f172a;">
        <p style="font-size: 14px;">Preparing invoice PDF...</p>
      </body>
    </html>
  `);
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

  // Header banner
  setBodyStyle(20, "bold");
  doc.setTextColor(37, 99, 235); // Sleek brand blue color
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

  // Invoice Details Grid
  const colWidth = 240;
  
  // Left Column - Invoice Meta
  let detailsY = y;
  setBodyStyle(10, "bold");
  doc.text("INVOICE SUMMARY", left, detailsY);
  detailsY += 16;
  setBodyStyle(9, "normal");
  doc.text(`Invoice Number: ${invoice.invoiceNumber}`, left, detailsY);
  detailsY += 14;
  const periodStr = invoice.billingFrequency === "daily"
    ? new Date(invoice.periodStart + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : `${new Date(invoice.periodStart + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${new Date(invoice.periodEnd + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  doc.text(`Billing Period: ${periodStr}`, left, detailsY);
  detailsY += 14;
  doc.text(`Status: ${invoice.status.toUpperCase()}`, left, detailsY);
  detailsY += 14;
  doc.text(`Issued Date: ${new Date(invoice.generatedAt).toLocaleDateString()}`, left, detailsY);
  detailsY += 14;

  // Split requisitions to fit 230 width
  if (requisitions.length > 0) {
    detailsY += 6;
    setBodyStyle(9, "bold");
    doc.text("Requisitions included:", left, detailsY);
    detailsY += 12;
    setBodyStyle(8, "normal");
    const reqLines = doc.splitTextToSize(requisitions.join(", "), 220) as string[];
    reqLines.forEach((line) => {
      doc.text(line, left, detailsY);
      detailsY += 10;
    });
  }

  // Right Column - Location details (Physical Store vs Legal Corp)
  let rightY = y;
  
  // Resolve physical store info (or fallback to basic location name)
  const storeName = locationName;
  const storeAddr = billingProfile?.storeAddress 
    ? `${billingProfile.storeAddress}, ${billingProfile.storeCity || ""}, ${billingProfile.storeProvince || ""} ${billingProfile.storePostalCode || ""}`.trim()
    : "Physical address not configured";
  const storePhone = billingProfile?.storePhone ? `Phone: ${billingProfile.storePhone}` : "Phone: —";
  const storeManager = billingProfile?.storeManagerName ? `Mgr: ${billingProfile.storeManagerName}` : "";

  setBodyStyle(10, "bold");
  doc.text("STORE LOCATION", left + colWidth, rightY);
  rightY += 16;
  setBodyStyle(9, "normal");
  doc.text(storeName, left + colWidth, rightY);
  rightY += 14;
  
  // Wrap store address to fit right column
  const storeAddrLines = doc.splitTextToSize(storeAddr, 260) as string[];
  storeAddrLines.forEach((line) => {
    doc.text(line, left + colWidth, rightY);
    rightY += 13;
  });
  doc.text(storePhone, left + colWidth, rightY);
  rightY += 13;
  if (storeManager) {
    doc.text(storeManager, left + colWidth, rightY);
    rightY += 13;
  }

  rightY += 10;

  // Legal billing profile details ("BILL TO")
  setBodyStyle(10, "bold");
  doc.text("BILL TO (LEGAL CORPORATION)", left + colWidth, rightY);
  rightY += 16;
  setBodyStyle(9, "normal");

  const corpName = billingProfile?.legalName ?? `Franchise Location: ${locationName}`;
  const corpIncAddress = billingProfile?.incorporationAddress ?? "";
  const corpBillAddress = billingProfile?.billingAddress 
    ? `${billingProfile.billingAddress}, ${billingProfile.billingCity || ""}, ${billingProfile.billingProvince || ""} ${billingProfile.billingPostalCode || ""}`.trim()
    : (billingProfile?.storeAddress 
        ? `${billingProfile.storeAddress}, ${billingProfile.storeCity || ""}, ${billingProfile.storeProvince || ""} ${billingProfile.storePostalCode || ""}`.trim()
        : "Address not configured");
  
  const hstStr = billingProfile?.hstNumber ? `HST Number: ${billingProfile.hstNumber}` : "HST Number: Not Configured";
  const bnStr = billingProfile?.businessNumber ? `Business Number: ${billingProfile.businessNumber}` : "";
  const billEmailStr = billingProfile?.billingEmail ? `Billing Email: ${billingProfile.billingEmail}` : "";

  doc.text(corpName, left + colWidth, rightY);
  rightY += 14;
  
  if (corpIncAddress) {
    const incLines = doc.splitTextToSize(`Corp: ${corpIncAddress}`, 260) as string[];
    incLines.forEach((line) => {
      doc.text(line, left + colWidth, rightY);
      rightY += 13;
    });
  }
  
  const billLines = doc.splitTextToSize(`Billing: ${corpBillAddress}`, 260) as string[];
  billLines.forEach((line) => {
    doc.text(line, left + colWidth, rightY);
    rightY += 13;
  });

  doc.text(hstStr, left + colWidth, rightY);
  rightY += 13;
  if (bnStr) {
    doc.text(bnStr, left + colWidth, rightY);
    rightY += 13;
  }
  if (billEmailStr) {
    doc.text(billEmailStr, left + colWidth, rightY);
    rightY += 13;
  }

  // Advance y to the bottom of both columns
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
      itemLines.forEach((line, index) => {
        doc.text(line, left, y + index * 11);
      });
      doc.text(clipText(item.requisitionId ?? "-", 18), 246, y);
      doc.text(String(item.quantity), 356, y, { align: "right" });
      doc.text(money(item.unitPrice), 448, y, { align: "right" });
      doc.text(money(item.lineTotal), 570, y, { align: "right" });
      y += rowHeight;
    });
  }

  ensureSpace(76);
  drawRule();
  setBodyStyle(10, "bold");
  doc.text(`Subtotal: ${money(invoice.subtotal)}`, 570, y, { align: "right" });
  y += 16;
  doc.text(`Tax: ${money(invoice.taxAmount)}`, 570, y, { align: "right" });
  y += 18;
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

function MonthlyInvoicesContent() {
  const defaultMonth = new Date().toISOString().slice(0, 7);
  const defaultDate = new Date().toISOString().slice(0, 10);

  // Filtering state
  const [filterFrequency, setFilterFrequency] = useState<"all" | "daily" | "biweekly" | "monthly">("all");
  const [filterMonth, setFilterMonth] = useState(defaultMonth);
  const [filterDate, setFilterDate] = useState(defaultDate);
  const [locationId, setLocationId] = useState("all");

  // Generation state
  const [genFrequency, setGenFrequency] = useState<"daily" | "biweekly" | "monthly">("monthly");
  const [genMonth, setGenMonth] = useState(defaultMonth);
  const [genDate, setGenDate] = useState(defaultDate);

  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isItemsLoading, setIsItemsLoading] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "warning"; message: string } | null>(null);
  const [lastSummary, setLastSummary] = useState<MonthlyInvoiceSummary[]>([]);

  const locationNameById = useMemo(() => {
    const map = new Map<string, string>();
    locations.forEach((loc) => map.set(loc.id, loc.name || loc.id));
    return map;
  }, [locations]);

  const selectedLocationFilter = locationId === "all" ? null : locationId;

  const fetchInvoices = useCallback(async () => {
    setIsLoading(true);
    try {
      const rows = await loadInvoices({
        month: filterMonth,
        date: filterDate,
        locationId: selectedLocationFilter,
        billingFrequency: filterFrequency,
      });
      setInvoices(rows);
    } finally {
      setIsLoading(false);
    }
  }, [filterMonth, filterDate, selectedLocationFilter, filterFrequency]);

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
    if (!selectedInvoice) {
      setInvoiceItems([]);
      return;
    }
    let cancelled = false;
    setIsItemsLoading(true);
    loadInvoiceItems(selectedInvoice.id).then((items) => {
      if (!cancelled) {
        setInvoiceItems(items);
        setIsItemsLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [selectedInvoice]);

  const totals = useMemo(() => {
    return invoices.reduce(
      (acc, invoice) => ({
        subtotal: acc.subtotal + invoice.subtotal,
        tax: acc.tax + invoice.taxAmount,
        total: acc.total + invoice.totalAmount,
      }),
      { subtotal: 0, tax: 0, total: 0 }
    );
  }, [invoices]);

  const requisitionNumbers = useMemo(() => {
    return Array.from(new Set(invoiceItems.map((item) => item.requisitionId).filter(Boolean))) as string[];
  }, [invoiceItems]);

  async function handleGenerate() {
    setIsGenerating(true);
    setNotice(null);
    setLastSummary([]);
    try {
      const periodStart = genFrequency === "monthly"
        ? `${genMonth.slice(0, 7)}-01`
        : genDate;

      const result = await generateInvoices(genFrequency, periodStart, selectedLocationFilter);
      if (!result.success) {
        setNotice({ type: "warning", message: result.error?.message ?? "Invoice generation failed." });
        return;
      }
      const generated = result.data ?? [];
      setLastSummary(generated);
      setNotice({
        type: generated.length > 0 ? "success" : "warning",
        message: generated.length > 0
          ? `Generated ${generated.length} draft invoice${generated.length === 1 ? "" : "s"}.`
          : "No eligible fulfilled or partial requisitions found for this period.",
      });
      await fetchInvoices();
    } finally {
      setIsGenerating(false);
    }
  }

  async function runInvoiceAction(invoice: Invoice, action: "finalize" | "paid") {
    setActionLoadingId(invoice.id);
    try {
      const result = action === "finalize"
        ? await finalizeInvoice(invoice.id)
        : await markInvoicePaid(invoice.id);
      if (!result.success) {
        setNotice({ type: "warning", message: result.error?.message ?? "Invoice update failed." });
        return;
      }
      setNotice({
        type: "success",
        message: action === "finalize" ? `${invoice.invoiceNumber} finalized.` : `${invoice.invoiceNumber} marked paid.`,
      });
      await fetchInvoices();
      if (selectedInvoice?.id === invoice.id) {
        const refreshed = await loadInvoices({
          month: filterMonth,
          date: filterDate,
          locationId: selectedLocationFilter,
          billingFrequency: filterFrequency,
        });
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
      const locationName = locationNameById.get(invoice.locationId) ?? invoice.locationId;
      const billingProfile = await getLocationBillingProfile(invoice.locationId);
      console.log("Invoice PDF debug", {
        invoice_number: invoice.invoiceNumber,
        loaded_items_count: items.length,
        subtotal: invoice.subtotal,
      });
      await saveInvoicePdf(invoice, items, locationName, billingProfile, previewWindow);
    } catch (error) {
      console.error("Invoice PDF download failed", error);
      if (previewWindow && !previewWindow.closed) {
        previewWindow.document.body.innerHTML = "<p style=\"font-family: system-ui, sans-serif; padding: 24px; color: #92400e;\">PDF download failed. Please return to Stock Dharma and try again.</p>";
      }
      setNotice({
        type: "warning",
        message: "PDF download failed. Please try again or open the invoice and retry.",
      });
    } finally {
      setPdfLoadingId(null);
    }
  }

  return (
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-slate-50 p-4 text-slate-900 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <section className="rounded-3xl border border-emerald-100 bg-gradient-to-br from-white via-emerald-50/70 to-slate-50 p-5 shadow-sm sm:p-7">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
            <div className="max-w-3xl">
              <p className="text-xs font-bold uppercase tracking-[0.24em] text-emerald-700">STOCK DHARMA</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-5xl">HQ Location Invoices</h1>
              <p className="mt-3 text-base text-slate-600">
                Generate draft daily, biweekly, and monthly invoices from fulfilled requisition quantities.
              </p>
            </div>
          </div>
          
          <div className="flex flex-col gap-4 border-t border-emerald-100/50 pt-5 mt-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 max-w-2xl">
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-800">Billing Cycle</span>
                <select
                  value={genFrequency}
                  onChange={(e) => setGenFrequency(e.target.value as any)}
                  className="mt-1.5 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
                >
                  <option value="daily">Daily</option>
                  <option value="biweekly">Biweekly (14 Days)</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-800">
                  {genFrequency === "monthly" ? "Invoice Month" : "Period Start Date"}
                </span>
                <input
                  type={genFrequency === "monthly" ? "month" : "date"}
                  value={genFrequency === "monthly" ? genMonth : genDate}
                  onChange={(e) => genFrequency === "monthly" ? setGenMonth(e.target.value) : setGenDate(e.target.value)}
                  className="mt-1.5 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
                />
              </label>
            </div>

            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60 xl:mb-0.5"
            >
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ReceiptText className="h-4 w-4" />}
              {isGenerating ? "Generating..." : `Generate ${genFrequency.charAt(0).toUpperCase() + genFrequency.slice(1)} Invoices`}
            </button>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_auto]">
          <label className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Billing Cycle Filter</span>
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
            <span className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Location</span>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="mt-2 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none ring-emerald-600 focus:ring-2"
            >
              <option value="all">All Locations</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-3 gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm xl:min-w-[360px]">
            <div>
              <p className="text-xs font-semibold text-slate-500">Subtotal</p>
              <p className="mt-2 text-lg font-semibold text-slate-950">{money(totals.subtotal)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500">Tax</p>
              <p className="mt-2 text-lg font-semibold text-slate-950">{money(totals.tax)}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500">Total</p>
              <p className="mt-2 text-lg font-semibold text-emerald-700">{money(totals.total)}</p>
            </div>
          </div>
        </section>

        {notice && (
          <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold ${
            notice.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-200 bg-amber-50 text-amber-700"
          }`}>
            <CheckCircle2 className="h-4 w-4" />
            {notice.message}
          </div>
        )}

        {lastSummary.length > 0 && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            <p className="font-semibold">Generated this run</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {lastSummary.map((summary) => (
                <span key={summary.invoiceId} className="rounded-full bg-white px-3 py-1 text-xs font-semibold shadow-sm">
                  {summary.invoiceNumber} · {summary.requisitionCount} requisition{summary.requisitionCount === 1 ? "" : "s"} · {money(summary.totalAmount)}
                </span>
              ))}
            </div>
          </div>
        )}

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">Invoice Summary</h2>
              <p className="mt-1 text-sm text-slate-500">
                {filterFrequency === "all" ? "All Cycles" : filterFrequency.toUpperCase()} · {filterFrequency === "daily" || filterFrequency === "biweekly" ? filterDate : monthLabel(filterMonth)} · {locationId === "all" ? "All Locations" : locationNameById.get(locationId) ?? locationId}
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
                  <th className="px-3 py-3 text-right font-semibold">Tax</th>
                  <th className="px-3 py-3 text-right font-semibold">Total</th>
                  <th className="px-3 py-3 text-left font-semibold">Generated</th>
                  <th className="px-5 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading ? (
                  <tr>
                    <td colSpan={9} className="px-5 py-12 text-center text-slate-400">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                    </td>
                  </tr>
                ) : invoices.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-5 py-12 text-center text-sm text-slate-500">
                      No invoices found for this selection.
                    </td>
                  </tr>
                ) : invoices.map((invoice) => (
                  <tr key={invoice.id} className="transition hover:bg-emerald-50/30">
                    <td className="px-5 py-4 font-semibold text-slate-950">{invoice.invoiceNumber}</td>
                    <td className="px-3 py-4 text-slate-600">
                      <span className="inline-flex items-center gap-1.5">
                        <MapPin className="h-3.5 w-3.5 text-emerald-700" />
                        {locationNameById.get(invoice.locationId) ?? invoice.locationId}
                      </span>
                    </td>
                    <td className="px-3 py-4 text-slate-600">
                      <div className="flex flex-col">
                        <span className="font-semibold text-slate-900 capitalize">
                          {invoice.billingFrequency || "monthly"}
                        </span>
                        <span className="text-xs text-slate-500">
                          {formatPeriod(invoice)}
                        </span>
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
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {pdfLoadingId === invoice.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                          Download PDF
                        </button>
                        <button
                          onClick={() => runInvoiceAction(invoice, "finalize")}
                          disabled={invoice.status !== "draft" || actionLoadingId === invoice.id}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <FileText className="h-3.5 w-3.5" /> Finalize
                        </button>
                        <button
                          onClick={() => runInvoiceAction(invoice, "paid")}
                          disabled={invoice.status === "paid" || invoice.status === "void" || actionLoadingId === invoice.id}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {actionLoadingId === invoice.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleDollarSign className="h-3.5 w-3.5" />}
                          Mark Paid
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <Drawer
          isOpen={!!selectedInvoice}
          onClose={() => setSelectedInvoice(null)}
          title={selectedInvoice ? `Invoice ${selectedInvoice.invoiceNumber}` : "Invoice"}
          description={selectedInvoice ? `${locationNameById.get(selectedInvoice.locationId) ?? selectedInvoice.locationId} · ${selectedInvoice.billingFrequency.toUpperCase()} (${formatPeriod(selectedInvoice)})` : undefined}
        >
          {selectedInvoice && (
            <div className="space-y-5">
              <div className="flex justify-end">
                <button
                  onClick={() => handleDownloadPdf(selectedInvoice, invoiceItems)}
                  disabled={isItemsLoading || pdfLoadingId === selectedInvoice.id}
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pdfLoadingId === selectedInvoice.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Download PDF
                </button>
              </div>

              <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Location</p>
                  <p className="mt-1 font-semibold text-slate-950">{locationNameById.get(selectedInvoice.locationId) ?? selectedInvoice.locationId}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Billing Period</p>
                  <p className="mt-1 font-semibold text-slate-950">{formatPeriod(selectedInvoice)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</p>
                  <p className="mt-1 font-semibold capitalize text-slate-950">{selectedInvoice.status}</p>
                </div>
              </div>

              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Requisitions included</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {requisitionNumbers.length > 0
                    ? requisitionNumbers.map((reqId) => (
                        <span key={reqId} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">{reqId}</span>
                      ))
                    : <span className="text-sm text-slate-400">No requisition references found.</span>}
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-slate-200">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-3 text-left">Item</th>
                        <th className="px-3 py-3 text-left">Requisition</th>
                        <th className="px-3 py-3 text-right">Qty Fulfilled</th>
                        <th className="px-3 py-3 text-right">Unit Price</th>
                        <th className="px-4 py-3 text-right">Line Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {isItemsLoading ? (
                        <tr><td colSpan={5} className="py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
                      ) : invoiceItems.length === 0 ? (
                        <tr><td colSpan={5} className="py-8 text-center text-sm text-slate-500">No invoice items found.</td></tr>
                      ) : invoiceItems.map((item) => (
                        <tr key={item.id}>
                          <td className="px-4 py-3 font-medium text-slate-950">{item.itemName}</td>
                          <td className="px-3 py-3 text-slate-600">{item.requisitionId ?? "-"}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-slate-700">{item.quantity}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-slate-700">{money(item.unitPrice)}</td>
                          <td className="px-4 py-3 text-right tabular-nums font-semibold text-slate-950">{money(item.lineTotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="ml-auto max-w-sm space-y-2 rounded-xl bg-slate-50 p-4">
                <div className="flex justify-between text-sm"><span className="text-slate-500">Subtotal</span><span className="font-semibold">{money(selectedInvoice.subtotal)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-slate-500">Tax</span><span className="font-semibold">{money(selectedInvoice.taxAmount)}</span></div>
                <div className="flex justify-between border-t border-slate-200 pt-2 text-base"><span className="font-semibold text-slate-700">Total</span><span className="font-bold text-emerald-700">{money(selectedInvoice.totalAmount)}</span></div>
              </div>
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
