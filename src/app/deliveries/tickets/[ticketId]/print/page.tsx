"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Loader2, Printer } from "lucide-react";
import { getDeliveryTicketById } from "@/lib/storage";
import {
  DeliveryTicketPrintDocument,
  DeliveryTicketPrintStyles,
} from "@/components/DeliveryTicketPrintDocument";

const cleanFileName = (ticketNumber?: string) =>
  `Delivery-Ticket-${String(ticketNumber || "ticket").replace(/[^a-zA-Z0-9-]+/g, "-")}.pdf`;

export default function DeliveryTicketPrintPage() {
  const params = useParams<{ ticketId: string }>();
  const searchParams = useSearchParams();
  const [ticket, setTicket] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const hasAutoPrinted = useRef(false);
  const generatedAt = useMemo(() => new Date(), []);
  const mode = searchParams.get("mode");
  const shouldAutoPrint = mode === "print" || mode === "pdf" || searchParams.get("print") === "1" || searchParams.get("pdf") === "1";
  const pdfMode = mode === "pdf" || searchParams.get("pdf") === "1";

  useEffect(() => {
    let cancelled = false;
    async function loadTicket() {
      setLoading(true);
      const res = await getDeliveryTicketById(params.ticketId);
      if (cancelled) return;
      if (!res.success) {
        setError(res.error?.message ?? "Delivery ticket not found or access denied.");
        setTicket(null);
      } else {
        setTicket(res.data);
        document.title = cleanFileName(res.data?.ticketNumber).replace(/\.pdf$/, "");
      }
      setLoading(false);
    }
    loadTicket();
    return () => { cancelled = true; };
  }, [params.ticketId]);

  useEffect(() => {
    if (!ticket || !shouldAutoPrint) return;
    if (hasAutoPrinted.current) return;
    hasAutoPrinted.current = true;
    const timer = window.setTimeout(() => window.print(), 350);
    return () => window.clearTimeout(timer);
  }, [shouldAutoPrint, ticket]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-slate-50 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading delivery ticket...
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

  return (
    <main className="ticket-print-shell min-h-screen bg-slate-100 py-6">
      <DeliveryTicketPrintStyles />
      <div className="ticket-screen-actions">
        {pdfMode && (
          <div className="mr-auto rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700">
            Choose “Save as PDF” in the print dialog. Suggested filename: {cleanFileName(ticket.ticketNumber)}
          </div>
        )}
        <button onClick={() => window.print()} className="ticket-screen-button inline-flex items-center gap-2">
          <Printer className="h-4 w-4" /> Print / Save PDF
        </button>
      </div>
      <div className="ticket-print-root">
        <DeliveryTicketPrintDocument ticket={ticket} generatedAt={generatedAt} />
      </div>
    </main>
  );
}
