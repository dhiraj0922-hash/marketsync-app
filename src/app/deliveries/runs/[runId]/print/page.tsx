"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Loader2, Printer } from "lucide-react";
import { getDeliveryRunById } from "@/lib/storage";
import {
  DeliveryTicketPrintDocument,
  DeliveryTicketPrintStyles,
} from "@/components/DeliveryTicketPrintDocument";

const cleanRunFileName = (runNumber?: string) =>
  `Delivery-Run-${String(runNumber || "run").replace(/[^a-zA-Z0-9-]+/g, "-")}-Tickets.pdf`;

export default function DeliveryRunTicketsPrintPage() {
  const params = useParams<{ runId: string }>();
  const searchParams = useSearchParams();
  const [run, setRun] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const hasAutoPrinted = useRef(false);
  const generatedAt = useMemo(() => new Date(), []);
  const mode = searchParams.get("mode");
  const shouldAutoPrint = mode === "print" || mode === "pdf" || searchParams.get("print") === "1" || searchParams.get("pdf") === "1";
  const pdfMode = mode === "pdf" || searchParams.get("pdf") === "1";

  useEffect(() => {
    let cancelled = false;
    async function loadRun() {
      setLoading(true);
      const res = await getDeliveryRunById(params.runId);
      if (cancelled) return;
      if (!res.success) {
        setError(res.error?.message ?? "Delivery run not found or access denied.");
        setRun(null);
      } else {
        setRun(res.data);
        document.title = cleanRunFileName(res.data?.runNumber).replace(/\.pdf$/, "");
      }
      setLoading(false);
    }
    loadRun();
    return () => { cancelled = true; };
  }, [params.runId]);

  useEffect(() => {
    if (!run || !shouldAutoPrint) return;
    if (hasAutoPrinted.current) return;
    hasAutoPrinted.current = true;
    const timer = window.setTimeout(() => window.print(), 450);
    return () => window.clearTimeout(timer);
  }, [run, shouldAutoPrint]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-slate-50 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading delivery run tickets...
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="rounded-2xl border border-red-200 bg-white p-6 text-center shadow-sm">
          <p className="text-sm font-semibold text-red-700">{error || "Delivery run not found."}</p>
        </div>
      </div>
    );
  }

  const tickets = [...(run.tickets ?? [])].sort((a, b) => (a.stopSequence ?? 999) - (b.stopSequence ?? 999));

  return (
    <main className="ticket-print-shell min-h-screen bg-slate-100 py-6">
      <DeliveryTicketPrintStyles />
      <div className="ticket-screen-actions">
        {pdfMode && (
          <div className="mr-auto rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700">
            Choose “Save as PDF” in the print dialog. Suggested filename: {cleanRunFileName(run.runNumber)}
          </div>
        )}
        <button onClick={() => window.print()} className="ticket-screen-button inline-flex items-center gap-2">
          <Printer className="h-4 w-4" /> Print All Tickets
        </button>
      </div>
      <div className="ticket-print-root">
        {tickets.length > 0 ? (
          tickets.map((ticket) => (
            <DeliveryTicketPrintDocument
              key={ticket.id}
              ticket={{ ...ticket, deliveryRun: run }}
              printMode="batch"
              generatedAt={generatedAt}
            />
          ))
        ) : (
          <article className="ticket-print-page">
            <h1 className="ticket-title">No Tickets Assigned</h1>
            <p>Delivery run {run.runNumber} does not have assigned delivery tickets yet.</p>
          </article>
        )}
      </div>
    </main>
  );
}
