"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Printer } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { isHqFulfillment, isHqMaster, isHqOps } from "@/lib/roles";
import { getFulfillmentSummary } from "@/lib/storage";

type PrintOptions = {
  includeBreakdown: boolean;
  includeRequisitionNumber: boolean;
  includeBackorders: boolean;
  includeNotes: boolean;
  includePickedQty: boolean;
  includeCheckedBy: boolean;
  pageBreakPerLocation: boolean;
  onlyAllocated: boolean;
  includeRequested: boolean;
};

const asBool = (value: string | null, fallback: boolean) => {
  if (value == null) return fallback;
  return value === "1" || value === "true";
};

const splitParam = (value: string | null) =>
  String(value ?? "")
    .split(",")
    .map(v => decodeURIComponent(v).trim())
    .filter(Boolean);

const fmtQty = (value: number, unit?: string) => `${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${unit || "ea"}`;

function filterSummary(data: any[], params: URLSearchParams) {
  const scope = params.get("scope") || "visible";
  const search = String(params.get("search") ?? "").trim().toLowerCase();
  const location = params.get("location") || "all";
  const status = params.get("status") || "all";
  const selectedLocations = new Set(splitParam(params.get("locations")));
  const selectedRequisitions = new Set(splitParam(params.get("requisitions")));
  const selectedItems = new Set(splitParam(params.get("items")));

  return data
    .map(group => {
      const groupMatchesSearch = !search || String(group.itemName ?? "").toLowerCase().includes(search);
      const groupSelected = scope !== "items" || selectedItems.has(group.itemName);
      const items = (group.items ?? []).filter((item: any) => {
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
        totalRequested: items.reduce((sum: number, item: any) => sum + Number(item.quantityRequested ?? 0), 0),
        totalAllocated: items.reduce((sum: number, item: any) => sum + Number(item.allocatedQty ?? 0), 0),
        totalBackorder: items.reduce((sum: number, item: any) => sum + Number(item.backorderQty ?? 0), 0),
      };
    })
    .filter(group => group.items.length > 0);
}

export default function FulfillmentPickListPrintPage() {
  const { user, loading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasAutoPrinted = useRef(false);

  const allowed = isHqMaster(user) || isHqOps(user) || isHqFulfillment(user);
  const options: PrintOptions = useMemo(() => ({
    includeBreakdown: asBool(searchParams.get("includeBreakdown"), true),
    includeRequisitionNumber: asBool(searchParams.get("includeRequisitionNumber"), true),
    includeBackorders: asBool(searchParams.get("includeBackorders"), true),
    includeNotes: asBool(searchParams.get("includeNotes"), true),
    includePickedQty: asBool(searchParams.get("includePickedQty"), true),
    includeCheckedBy: asBool(searchParams.get("includeCheckedBy"), true),
    pageBreakPerLocation: asBool(searchParams.get("pageBreakPerLocation"), false),
    onlyAllocated: asBool(searchParams.get("onlyAllocated"), false),
    includeRequested: asBool(searchParams.get("includeRequested"), true),
  }), [searchParams]);
  const mode = searchParams.get("mode");
  const generatedAt = useMemo(() => new Date(), []);

  useEffect(() => {
    if (authLoading || !allowed) return;
    let cancelled = false;
    async function loadPrintData() {
      setLoading(true);
      setError(null);
      try {
        const summary = await getFulfillmentSummary();
        if (!cancelled) setData(filterSummary(summary, searchParams));
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? "Could not load fulfillment pick list.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadPrintData();
    return () => { cancelled = true; };
  }, [allowed, authLoading, searchParams]);

  useEffect(() => {
    if (loading || error || data.length === 0 || mode !== "print") return;
    if (hasAutoPrinted.current) return;
    hasAutoPrinted.current = true;
    const timer = window.setTimeout(() => window.print(), 350);
    return () => window.clearTimeout(timer);
  }, [data.length, error, loading, mode]);

  const flatRows = data.flatMap(group => group.items.map((item: any) => ({ ...item, itemName: group.itemName, groupUnit: group.unit })));
  const locationNames = Array.from(new Set(flatRows.map((row: any) => row.locationName).filter(Boolean))).sort();
  const requisitions = Array.from(new Set(flatRows.map((row: any) => row.requisitionNumber || row.requisitionId).filter(Boolean))).sort();
  const totalRequested = data.reduce((sum, group) => sum + Number(group.totalRequested ?? 0), 0);
  const totalAllocated = data.reduce((sum, group) => sum + Number(group.totalAllocated ?? 0), 0);
  const totalBackorder = data.reduce((sum, group) => sum + Number(group.totalBackorder ?? 0), 0);

  if (authLoading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-white text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading pick list...
      </div>
    );
  }

  if (!allowed) {
    return <div className="flex min-h-screen items-center justify-center bg-white p-8 text-sm font-semibold text-red-700">Access denied. HQ fulfillment access is required.</div>;
  }

  if (error) {
    return <div className="flex min-h-screen items-center justify-center bg-white p-8 text-sm font-semibold text-red-700">{error}</div>;
  }

  return (
    <main className="pick-print-shell min-h-screen bg-slate-100 py-6">
      <style>{`
        @page { size: Letter; margin: 0.45in; }
        .pick-print-page { width: min(100%, 8.5in); margin: 0 auto 18px; background: white; color: #111827; padding: 28px; box-shadow: 0 12px 35px rgba(15, 23, 42, 0.12); }
        .pick-actions { width: min(100%, 8.5in); margin: 0 auto 12px; display: flex; justify-content: flex-end; gap: 8px; }
        .pick-button { border: 1px solid #cbd5e1; border-radius: 10px; background: white; padding: 9px 12px; font-size: 13px; font-weight: 700; color: #334155; }
        .pick-title { font-size: 24px; font-weight: 900; letter-spacing: -0.02em; margin: 4px 0; }
        .pick-meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 16px 0; }
        .pick-meta div { border: 1px solid #e5e7eb; border-radius: 10px; padding: 9px; }
        .pick-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; font-weight: 800; }
        .pick-value { font-size: 14px; font-weight: 800; margin-top: 2px; }
        .pick-table { width: 100%; border-collapse: collapse; font-size: 11px; }
        .pick-table th { text-align: left; border-bottom: 2px solid #111827; padding: 7px 6px; text-transform: uppercase; font-size: 9px; letter-spacing: 0.06em; }
        .pick-table td { border-bottom: 1px solid #e5e7eb; padding: 7px 6px; vertical-align: top; }
        .pick-breakdown { margin: 7px 0 14px 22px; border-left: 3px solid #d1fae5; padding-left: 10px; break-inside: avoid; }
        .location-page { break-before: page; }
        .signature-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 30px; }
        .signature-line { border-top: 1px solid #111827; padding-top: 6px; font-size: 11px; font-weight: 700; }
        thead { display: table-header-group; }
        tr, .item-block { break-inside: avoid; }
        @media print {
          body { background: white !important; }
          .pick-actions { display: none !important; }
          .pick-print-shell { background: white !important; padding: 0 !important; }
          .pick-print-page { width: auto; margin: 0; padding: 0; box-shadow: none; }
        }
      `}</style>

      <div className="pick-actions">
        <div className="mr-auto rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700">
          To save as PDF, choose “Save as PDF” in the print dialog. Suggested filename: Stock-Dharma-Pick-List-{new Date().toISOString().slice(0, 10)}.pdf
        </div>
        <button onClick={() => window.print()} className="pick-button inline-flex items-center gap-2"><Printer className="h-4 w-4" /> Print / Save PDF</button>
      </div>

      <section className="pick-print-page">
        <header>
          <div className="pick-label">STOCK DHARMA</div>
          <h1 className="pick-title">HQ FULFILLMENT PICK LIST</h1>
          <p className="text-sm text-slate-600">Prepared By: {user?.name || user?.email || "HQ"} · Print Date/Time: {generatedAt.toLocaleString()}</p>
          <p className="mt-1 text-xs text-slate-500">Selected Locations: {locationNames.length ? locationNames.join(", ") : "None"} · Requisitions: {requisitions.length ? requisitions.join(", ") : "None"}</p>
        </header>

        <div className="pick-meta">
          <div><p className="pick-label">Total Items</p><p className="pick-value">{data.length}</p></div>
          <div><p className="pick-label">Total Locations</p><p className="pick-value">{locationNames.length}</p></div>
          <div><p className="pick-label">Requested Qty</p><p className="pick-value">{totalRequested.toLocaleString()}</p></div>
          <div><p className="pick-label">Allocated Qty</p><p className="pick-value">{totalAllocated.toLocaleString()}</p></div>
          <div><p className="pick-label">Backordered Qty</p><p className="pick-value">{totalBackorder.toLocaleString()}</p></div>
        </div>

        {data.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm font-semibold text-slate-500">No fulfillment lines match this print selection.</div>
        ) : options.pageBreakPerLocation ? (
          locationNames.map(locationName => {
            const rows = flatRows.filter((row: any) => row.locationName === locationName && (!options.onlyAllocated || Number(row.allocatedQty ?? 0) > 0));
            return (
              <section key={locationName} className="location-page">
                <h2 className="mb-1 text-xl font-black text-slate-950">{locationName}</h2>
                <p className="mb-3 text-xs text-slate-500">Location packing list · Requisitions: {Array.from(new Set(rows.map((row: any) => row.requisitionNumber || row.requisitionId))).join(", ")}</p>
                <table className="pick-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Item</th>{options.includeRequisitionNumber && <th>Req #</th>}{options.includeRequested && <th>Requested</th>}<th>Allocated</th>{options.includeBackorders && <th>Backorder</th>}{options.includeNotes && <th>Note</th>}{options.includePickedQty && <th>Picked Qty</th>}{options.includeCheckedBy && <th>Checked By</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row: any, index: number) => (
                      <tr key={`${locationName}-${row.id}`}>
                        <td>{index + 1}</td><td><strong>{row.itemName}</strong><br /><span className="text-slate-500">{row.unit || row.groupUnit || "ea"}</span></td>{options.includeRequisitionNumber && <td>{row.requisitionNumber || row.requisitionId}</td>}{options.includeRequested && <td>{fmtQty(row.quantityRequested, row.unit)}</td>}<td>{fmtQty(row.allocatedQty, row.unit)}</td>{options.includeBackorders && <td>{fmtQty(row.backorderQty, row.unit)}</td>}{options.includeNotes && <td>{row.fulfillmentNote || ""}</td>}{options.includePickedQty && <td>&nbsp;</td>}{options.includeCheckedBy && <td>&nbsp;</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="signature-grid">
                  <div className="signature-line">Packed By</div>
                  <div className="signature-line">Checked By</div>
                  <div className="signature-line">Driver Handover</div>
                </div>
              </section>
            );
          })
        ) : (
          <table className="pick-table">
            <thead>
              <tr>
                <th>#</th><th>Item Name</th><th>Pack / Unit</th>{options.includeRequested && <th>Total Requested</th>}<th>Total Allocated</th>{options.includeBackorders && <th>Total Backordered</th>}{options.includePickedQty && <th>Picked Qty</th>}{options.includeCheckedBy && <th>Checked By</th>}{options.includeNotes && <th>Notes</th>}
              </tr>
            </thead>
            <tbody>
              {data.map((group, index) => {
                const visibleItems = options.onlyAllocated ? group.items.filter((item: any) => Number(item.allocatedQty ?? 0) > 0) : group.items;
                if (visibleItems.length === 0) return null;
                return (
                  <tr key={group.itemName} className="item-block">
                    <td>{index + 1}</td>
                    <td colSpan={options.includeRequested ? 1 : 1}>
                      <strong>{group.itemName}</strong>
                      {options.includeBreakdown && (
                        <div className="pick-breakdown">
                          <table className="pick-table">
                            <thead><tr><th>Location</th>{options.includeRequisitionNumber && <th>Req #</th>}<th>Requested</th><th>Allocated</th>{options.includeBackorders && <th>Backorder</th>}{options.includeNotes && <th>Fulfillment Note</th>}</tr></thead>
                            <tbody>
                              {visibleItems.map((item: any) => (
                                <tr key={item.id}>
                                  <td>{item.locationName}</td>{options.includeRequisitionNumber && <td>{item.requisitionNumber || item.requisitionId}</td>}<td>{fmtQty(item.quantityRequested, item.unit)}</td><td>{fmtQty(item.allocatedQty, item.unit)}</td>{options.includeBackorders && <td>{fmtQty(item.backorderQty, item.unit)}</td>}{options.includeNotes && <td>{item.fulfillmentNote || ""}</td>}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </td>
                    <td>{group.isFGMode ? `${group.packQty || 1} ${group.unit || "ea"} / pack` : group.unit || "ea"}</td>
                    {options.includeRequested && <td>{fmtQty(group.totalRequested, group.unit)}</td>}
                    <td>{fmtQty(group.totalAllocated, group.unit)}</td>
                    {options.includeBackorders && <td>{fmtQty(group.totalBackorder, group.unit)}</td>}
                    {options.includePickedQty && <td>&nbsp;</td>}
                    {options.includeCheckedBy && <td>&nbsp;</td>}
                    {options.includeNotes && <td>&nbsp;</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
