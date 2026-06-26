"use client";

import React from "react";

type DeliveryTicketPrintDocumentProps = {
  ticket: any;
  printMode?: "single" | "batch";
  generatedAt?: Date;
};

const formatDateTime = (value?: string | Date | null) => {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
};

const labelize = (value?: string | null) =>
  String(value || "draft").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

function Detail({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="ticket-detail">
      <div className="ticket-detail-label">{label}</div>
      <div className="ticket-detail-value">{value || "—"}</div>
    </div>
  );
}

export function DeliveryTicketPrintStyles() {
  return (
    <style>{`
      .ticket-print-shell {
        color: #111827;
        background: #ffffff;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .ticket-print-page {
        width: 100%;
        max-width: 8.5in;
        min-height: 11in;
        margin: 0 auto;
        background: #ffffff;
        padding: 32px;
        page-break-after: always;
      }
      .ticket-print-page:last-child { page-break-after: auto; }
      .ticket-topline {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        border-bottom: 2px solid #111827;
        padding-bottom: 16px;
      }
      .ticket-brand {
        font-size: 12px;
        font-weight: 900;
        letter-spacing: 0.18em;
      }
      .ticket-title {
        margin-top: 6px;
        font-size: 30px;
        font-weight: 900;
        letter-spacing: -0.03em;
      }
      .ticket-number {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        font-size: 18px;
        font-weight: 800;
      }
      .ticket-status {
        display: inline-block;
        margin-top: 6px;
        border: 1px solid #111827;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
      }
      .ticket-section {
        margin-top: 20px;
        break-inside: avoid;
      }
      .ticket-section-title {
        font-size: 12px;
        font-weight: 900;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #374151;
        border-bottom: 1px solid #d1d5db;
        padding-bottom: 6px;
        margin-bottom: 10px;
      }
      .ticket-detail-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }
      .ticket-detail {
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 9px 10px;
        min-height: 56px;
      }
      .ticket-detail-label {
        font-size: 9px;
        font-weight: 900;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #6b7280;
      }
      .ticket-detail-value {
        margin-top: 4px;
        white-space: pre-line;
        font-size: 12px;
        font-weight: 650;
        color: #111827;
      }
      .ticket-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
      }
      .ticket-table thead {
        display: table-header-group;
      }
      .ticket-table th {
        border: 1px solid #9ca3af;
        background: #f3f4f6;
        padding: 7px 6px;
        text-align: left;
        font-size: 9px;
        font-weight: 900;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #374151;
      }
      .ticket-table td {
        border: 1px solid #d1d5db;
        padding: 7px 6px;
        vertical-align: top;
      }
      .ticket-write-cell {
        min-width: 64px;
        height: 30px;
      }
      .ticket-notes {
        border: 1px solid #d1d5db;
        border-radius: 8px;
        min-height: 58px;
        padding: 10px;
        white-space: pre-line;
        font-size: 12px;
      }
      .ticket-proof-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .ticket-signature-line {
        border-bottom: 1px solid #111827;
        height: 34px;
        margin-top: 18px;
      }
      .ticket-signature-label {
        margin-top: 5px;
        font-size: 10px;
        font-weight: 800;
        color: #4b5563;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .ticket-footer {
        display: flex;
        justify-content: space-between;
        margin-top: 24px;
        border-top: 1px solid #d1d5db;
        padding-top: 10px;
        font-size: 10px;
        color: #6b7280;
      }
      .ticket-screen-actions {
        max-width: 8.5in;
        margin: 16px auto;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .ticket-screen-button {
        border: 1px solid #d1d5db;
        background: #ffffff;
        border-radius: 10px;
        padding: 9px 12px;
        font-size: 13px;
        font-weight: 700;
      }
      @page {
        size: Letter;
        margin: 0.45in;
      }
      @media print {
        html, body {
          background: #ffffff !important;
        }
        body * {
          visibility: hidden;
        }
        .ticket-print-root, .ticket-print-root * {
          visibility: visible;
        }
        .ticket-print-root {
          position: absolute;
          inset: 0;
          width: 100%;
          background: #ffffff !important;
        }
        .ticket-screen-actions {
          display: none !important;
        }
        .ticket-print-page {
          max-width: none;
          min-height: auto;
          margin: 0;
          padding: 0;
          box-shadow: none;
        }
        .ticket-section, .ticket-proof-grid {
          break-inside: avoid;
        }
        .ticket-table tr {
          break-inside: avoid;
        }
      }
      @media (max-width: 760px) {
        .ticket-print-page { padding: 18px; }
        .ticket-topline { flex-direction: column; }
        .ticket-detail-grid { grid-template-columns: 1fr; }
        .ticket-proof-grid { grid-template-columns: 1fr; }
      }
    `}</style>
  );
}

export function DeliveryTicketPrintDocument({
  ticket,
  printMode = "single",
  generatedAt = new Date(),
}: DeliveryTicketPrintDocumentProps) {
  const run = ticket.deliveryRun;
  const driver = run?.driver;
  const vehicle = run?.vehicle;
  const items = Array.isArray(ticket.items) ? ticket.items : [];

  return (
    <article className={`ticket-print-page ${printMode === "batch" ? "ticket-print-batch-page" : ""}`}>
      <header className="ticket-topline">
        <div>
          <div className="ticket-brand">STOCK DHARMA</div>
          <div className="ticket-title">DELIVERY TICKET</div>
          <div style={{ marginTop: 6, fontSize: 12, color: "#4b5563" }}>
            Ticket generated from Stock Dharma
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="ticket-number">{ticket.ticketNumber}</div>
          <div className="ticket-status">{labelize(ticket.status)}</div>
          <div style={{ marginTop: 8, fontSize: 11, color: "#4b5563" }}>
            Print Date/Time<br />
            <strong>{formatDateTime(generatedAt)}</strong>
          </div>
        </div>
      </header>

      <section className="ticket-section">
        <h2 className="ticket-section-title">Dispatch Details</h2>
        <div className="ticket-detail-grid">
          <Detail label="Delivery Run" value={run?.runNumber || "Unassigned"} />
          <Detail label="Delivery Date" value={run?.runDate || ticket.estimatedArrivalTime || ""} />
          <Detail label="Driver" value={`${driver?.name || run?.driverName || "—"}${driver?.phone ? `\n${driver.phone}` : ""}`} />
          <Detail label="Vehicle" value={`${vehicle?.vehicleName || "—"}${vehicle?.plateNumber ? ` / ${vehicle.plateNumber}` : ""}`} />
          <Detail label="Estimated KM" value={run?.estimatedDistanceKm != null ? `${run.estimatedDistanceKm} km` : "—"} />
          <Detail label="Estimated Minutes" value={run?.estimatedDurationMinutes != null ? `${run.estimatedDurationMinutes} min` : "—"} />
        </div>
      </section>

      <section className="ticket-section">
        <h2 className="ticket-section-title">Delivery Destination</h2>
        <div className="ticket-detail-grid">
          <Detail label="Location" value={ticket.destinationName || "—"} />
          <Detail label="Full Delivery Address" value={ticket.destinationAddress || "No address snapshot"} />
          <Detail label="Requisition" value={ticket.requisitionId || "—"} />
          <Detail label="Contact Person" value={ticket.destinationContact || "—"} />
          <Detail label="Contact Phone" value={ticket.destinationPhone || "—"} />
          <Detail label="Ticket ID" value={ticket.id} />
        </div>
      </section>

      <section className="ticket-section">
        <h2 className="ticket-section-title">Items</h2>
        <table className="ticket-table">
          <thead>
            <tr>
              <th style={{ width: 28 }}>#</th>
              <th>Item Name</th>
              <th>Unit</th>
              <th>Requested</th>
              <th>Approved</th>
              <th>Shipped</th>
              <th>Delivered</th>
              <th>Issue</th>
              <th>Issue Reason</th>
            </tr>
          </thead>
          <tbody>
            {items.length > 0 ? items.map((item: any, index: number) => (
              <tr key={item.id || index}>
                <td>{index + 1}</td>
                <td><strong>{item.itemName}</strong></td>
                <td>{item.unit || ""}</td>
                <td>{item.requestedQty}</td>
                <td>{item.approvedQty}</td>
                <td>{item.shippedQty}</td>
                <td className="ticket-write-cell">{item.deliveredQty || ""}</td>
                <td className="ticket-write-cell">{item.issueQty || ""}</td>
                <td className="ticket-write-cell">{item.issueReason || ""}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan={9}>No ticket items found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="ticket-section">
        <h2 className="ticket-section-title">Notes</h2>
        <div className="ticket-detail-grid">
          <div>
            <div className="ticket-detail-label">Delivery Notes</div>
            <div className="ticket-notes">{ticket.deliveryNotes || ticket.notes || ""}</div>
          </div>
          <div>
            <div className="ticket-detail-label">Route Notes</div>
            <div className="ticket-notes">{run?.notes || ""}</div>
          </div>
          <div>
            <div className="ticket-detail-label">Special Handling Instructions</div>
            <div className="ticket-notes" />
          </div>
        </div>
      </section>

      <section className="ticket-section">
        <h2 className="ticket-section-title">Proof of Delivery</h2>
        <div className="ticket-proof-grid">
          <div>
            <div className="ticket-signature-line">{ticket.receivedBy || ""}</div>
            <div className="ticket-signature-label">Received By Name</div>
          </div>
          <div>
            <div className="ticket-signature-line" />
            <div className="ticket-signature-label">Receiver Signature</div>
          </div>
          <div>
            <div className="ticket-signature-line" />
            <div className="ticket-signature-label">Date</div>
          </div>
          <div>
            <div className="ticket-signature-line" />
            <div className="ticket-signature-label">Time</div>
          </div>
          <div>
            <div className="ticket-signature-line" />
            <div className="ticket-signature-label">Driver Signature</div>
          </div>
          <div>
            <div className="ticket-signature-line" />
            <div className="ticket-signature-label">Delivery / Shortage Notes</div>
          </div>
        </div>
      </section>

      <footer className="ticket-footer">
        <span>Ticket generated from Stock Dharma</span>
        <span>{ticket.ticketNumber}</span>
      </footer>
    </article>
  );
}
