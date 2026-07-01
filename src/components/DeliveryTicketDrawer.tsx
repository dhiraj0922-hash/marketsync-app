"use client";

/**
 * DeliveryTicketDrawer
 *
 * Canonical single-ticket drawer, extracted from src/app/deliveries/page.tsx.
 * Reused by:
 *   - deliveries/page.tsx (full HQ admin / driver / manager controls)
 *   - requisitions/fulfillment/page.tsx (hq_fulfillment = view/print only)
 *
 * Permission props:
 *   canEditAdmin    – true only for hq_master/hq_admin:
 *                     status change buttons, address edit fields,
 *                     "Update Address from Store Profile" button.
 *
 *   canActOnTicket  – true for roles allowed to act operationally
 *                     (hq_master, hq_ops, driver, location_manager):
 *                     Save Lines, Mark Arrived, Mark Delivered,
 *                     Report Issue, editable qty fields, receiver field.
 *
 *   hq_fulfillment users: both false → view/print only.
 */

import React, { useEffect, useState } from "react";
import { Drawer } from "@/components/ui/drawer";
import {
  ChevronRight,
  Clock,
  FileText,
  MapPin,
  Printer,
  RefreshCw,
  Truck,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  markDeliveryTicketArrived,
  markDeliveryTicketDelivered,
  reportDeliveryTicketIssue,
  updateDeliveryTicket,
  updateDeliveryTicketItems,
  updateDeliveryTicketStatus,
  updateTicketAddressFromProfile,
  type DeliveryTicketStatus,
} from "@/lib/storage";
import type { AppUser } from "@/lib/roles";

// ─── Helper types & constants ─────────────────────────────────────────────────

const ticketStatuses: DeliveryTicketStatus[] = [
  "draft",
  "assigned",
  "loaded",
  "out_for_delivery",
  "delivered",
  "issue_reported",
  "cancelled",
];

const labelize = (value: string) =>
  value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

const getTicketPrintUrl = (ticketId: string, mode?: "print" | "pdf") =>
  `/deliveries/tickets/${ticketId}/print${mode ? `?mode=${mode}` : ""}`;

function formatDateTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function statusBadge(status: string) {
  const classes =
    status === "delivered" || status === "completed"
      ? "bg-emerald-50 text-emerald-700 border-emerald-100"
      : status === "loaded"
      ? "bg-green-50 text-green-700 border-green-100"
      : status === "assigned"
      ? "bg-blue-50 text-blue-700 border-blue-100"
      : status === "out_for_delivery" || status === "in_progress"
      ? "bg-amber-50 text-amber-700 border-amber-100"
      : status === "cancelled" || status === "issue_reported"
      ? "bg-red-50 text-red-700 border-red-100"
      : "bg-slate-100 text-slate-700 border-slate-200";
  return (
    <Badge
      variant="neutral"
      className={`rounded-md border px-2 py-0.5 ${classes}`}
    >
      {labelize(status || "draft")}
    </Badge>
  );
}

function InfoLine({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase text-neutral-500">
        {icon}
        {label}
      </div>
      <p className="mt-1 whitespace-pre-line text-sm font-medium text-neutral-900">
        {value || "—"}
      </p>
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

export type DeliveryTicketDrawerProps = {
  ticket: any | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  user: AppUser | null;
  /**
   * true only for hq_master / hq_admin:
   * controls status dropdown, address edit fields,
   * "Update Address from Store Profile".
   */
  canEditAdmin: boolean;
  /**
   * true for operational roles (hq_master, hq_ops, driver, location_manager):
   * controls Save Lines, Mark Arrived, Mark Delivered, Report Issue,
   * editable qty inputs, receiver/signature field.
   */
  canActOnTicket: boolean;
  onToast: (message: string) => void;
};

// ─── Component ────────────────────────────────────────────────────────────────

export function DeliveryTicketDrawer({
  ticket,
  onClose,
  onRefresh,
  user,
  canEditAdmin,
  canActOnTicket,
  onToast,
}: DeliveryTicketDrawerProps) {
  // Local drafts for editable line items and receiver field
  const [ticketItemDrafts, setTicketItemDrafts] = useState<any[]>([]);
  const [receivedBy, setReceivedBy] = useState("");

  // Sync drafts whenever the ticket changes
  useEffect(() => {
    setTicketItemDrafts(
      ticket?.items ? ticket.items.map((item: any) => ({ ...item })) : []
    );
    setReceivedBy(ticket?.receivedBy ?? "");
  }, [ticket]);

  // ── Internal action handlers ────────────────────────────────────────────────

  const openTicketPrintView = (
    t: any,
    mode: "view" | "print" | "pdf" = "view"
  ) => {
    if (!t?.id) {
      onToast("Delivery ticket is missing an internal ID.");
      return;
    }
    const printMode = mode === "view" ? undefined : mode;
    const url = getTicketPrintUrl(t.id, printMode);
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (!win) {
      onToast("Browser blocked the print window. Allow pop-ups and try again.");
    }
  };

  const saveTicketItems = async () => {
    if (!ticket) return;
    const res = await updateDeliveryTicketItems(ticket.id, ticketItemDrafts);
    if (!res.success) {
      alert(
        `Could not save ticket items: ${res.error?.message ?? "Unknown error"}`
      );
      return;
    }
    onToast("Delivery ticket items updated.");
    await onRefresh();
  };

  const markDelivered = async () => {
    if (!ticket) return;
    for (const item of ticketItemDrafts) {
      const del = Number(item.deliveredQty ?? 0);
      const iss = Number(item.issueQty ?? 0);
      const shp = Number(item.shippedQty ?? 0);
      if (del + iss !== shp) {
        alert(
          `Cannot complete delivery for ${item.itemName}: Delivered Quantity (${del}) + Issue Quantity (${iss}) must equal Shipped Quantity (${shp}).`
        );
        return;
      }
    }
    const res = await markDeliveryTicketDelivered(
      ticket.id,
      receivedBy.trim(),
      ticketItemDrafts
    );
    if (!res.success) {
      alert(
        `Could not mark delivered: ${res.error?.message ?? "Unknown error"}`
      );
      return;
    }
    onToast("Delivery ticket closed.");
    onClose();
    await onRefresh();
  };

  const markArrived = async () => {
    if (!ticket) return;
    const res = await markDeliveryTicketArrived(ticket.id);
    if (!res.success) {
      alert(`Could not mark arrived: ${res.error?.message ?? "Unknown error"}`);
      return;
    }
    onToast("Stop marked arrived.");
    await onRefresh();
  };

  const reportIssue = async () => {
    if (!ticket) return;
    const res = await reportDeliveryTicketIssue(ticket.id, {
      items: ticketItemDrafts,
      deliveryNotes: ticket.deliveryNotes ?? "",
      receivedBy: ticket.receivedBy ?? "",
    });
    if (!res.success) {
      alert(
        `Could not report issue: ${res.error?.message ?? "Unknown error"}`
      );
      return;
    }
    onToast("Delivery issue reported.");
    onClose();
    await onRefresh();
  };

  // ── Whether current user is a location manager (for label variation) ─────────
  const isManagerUser =
    user?.role === "location_manager";

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Drawer
      isOpen={!!ticket}
      onClose={onClose}
      title={`Delivery Ticket ${ticket?.ticketNumber ?? ""}`}
      description={`Requisition ${ticket?.requisitionId ?? "—"} · ${ticket?.destinationName ?? "—"}`}
      variant="dialog"
      footer={
        ticket && (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            {/* Print actions — always visible */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => openTicketPrintView(ticket, "print")}
                className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
              >
                <Printer className="h-4 w-4" /> Print Ticket
              </button>
              <button
                onClick={() => openTicketPrintView(ticket, "pdf")}
                className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
              >
                <FileText className="h-4 w-4" /> Download PDF
              </button>
              <button
                onClick={() => openTicketPrintView(ticket, "view")}
                className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
              >
                <ChevronRight className="h-4 w-4" /> Open Print View
              </button>
            </div>

            {/* Operational / admin actions — gated by permission */}
            <div className="flex flex-wrap gap-2">
              {/* Status controls — admin only */}
              {canEditAdmin &&
                ticketStatuses.map((status) => (
                  <button
                    key={status}
                    onClick={async () => {
                      const res = await updateDeliveryTicketStatus(
                        ticket.id,
                        status
                      );
                      if (!res.success) {
                        alert(res.error?.message ?? "Update failed");
                      } else {
                        await onRefresh();
                      }
                    }}
                    className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs font-semibold text-neutral-700 hover:bg-slate-50"
                  >
                    {labelize(status)}
                  </button>
                ))}

              {/* Operational actions */}
              {canActOnTicket && (
                <button
                  onClick={saveTicketItems}
                  className="rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white"
                >
                  Save Lines
                </button>
              )}
              {canActOnTicket && (
                <button
                  onClick={markArrived}
                  className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white"
                >
                  Mark Arrived
                </button>
              )}
              {canActOnTicket && (
                <button
                  onClick={reportIssue}
                  className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white"
                >
                  Report Issue
                </button>
              )}
              {canActOnTicket && (
                <button
                  onClick={markDelivered}
                  className="rounded-lg bg-success-600 px-3 py-2 text-sm font-semibold text-white"
                >
                  {isManagerUser ? "Confirm Receipt" : "Mark Delivered"}
                </button>
              )}
            </div>
          </div>
        )
      }
    >
      {ticket && (
        <div className="space-y-4 text-neutral-700">
          {/* Print / dispatch banner — always visible */}
          <div className="flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-bold text-blue-950">
                Dispatch paperwork
              </p>
              <p className="text-xs text-blue-700">
                Print or save this delivery ticket before the driver starts the
                run.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => openTicketPrintView(ticket, "print")}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                <Printer className="h-4 w-4" /> Print Ticket
              </button>
              <button
                onClick={() => openTicketPrintView(ticket, "pdf")}
                className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100"
              >
                <FileText className="h-4 w-4" /> Download PDF
              </button>
              <button
                onClick={() => openTicketPrintView(ticket, "view")}
                className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100"
              >
                <ChevronRight className="h-4 w-4" /> Open Print View
              </button>
            </div>
          </div>

          {/* Ticket document body */}
          <div
            id="delivery-ticket-print"
            className="rounded-xl border border-neutral-200 bg-white p-5"
          >
            <div className="flex flex-col gap-3 border-b border-neutral-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-neutral-500">
                  STOCK DHARMA Delivery Ticket
                </p>
                <h2 className="mt-1 text-2xl font-bold text-neutral-950">
                  {ticket.ticketNumber}
                </h2>
                <p className="text-sm text-neutral-500">
                  Requisition {ticket.requisitionId}
                </p>
              </div>
              <div className="text-left sm:text-right">
                {statusBadge(ticket.status)}
                <p className="mt-2 text-xs text-neutral-500">
                  Run: {ticket.deliveryRun?.runNumber ?? "Unassigned"}
                </p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <InfoLine
                icon={<MapPin className="h-4 w-4" />}
                label="Destination"
                value={`${ticket.destinationName || "—"}\n${
                  ticket.destinationAddress || "No address snapshot"
                }`}
              />
              <InfoLine
                icon={<Truck className="h-4 w-4" />}
                label="Driver / Vehicle"
                value={`${ticket.deliveryRun?.driver?.name ?? "—"}\n${
                  ticket.deliveryRun?.vehicle?.vehicleName ?? "—"
                }`}
              />
              <InfoLine
                icon={<Clock className="h-4 w-4" />}
                label="Arrived At"
                value={formatDateTime(ticket.arrivedAt)}
              />
              <InfoLine
                icon={<Clock className="h-4 w-4" />}
                label="Delivered At"
                value={formatDateTime(ticket.deliveredAt)}
              />
              <InfoLine
                icon={<UserRound className="h-4 w-4" />}
                label="Received By"
                value={ticket.receivedBy || "Signature required"}
              />
            </div>

            {/* Line items */}
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase text-neutral-500">
                    <th className="py-2">Item</th>
                    <th className="py-2 text-right">Requested</th>
                    <th className="py-2 text-right">Approved</th>
                    <th className="py-2 text-right">Shipped</th>
                    <th className="py-2 text-right">Delivered</th>
                    <th className="py-2 text-right">Issue</th>
                  </tr>
                </thead>
                <tbody>
                  {ticketItemDrafts.map((item, index) => (
                    <tr
                      key={item.id}
                      className="border-b border-neutral-100"
                    >
                      <td className="py-2 font-medium text-neutral-900">
                        {item.itemName}
                        <div className="text-xs text-neutral-400">
                          {item.unit}
                        </div>
                      </td>
                      <td className="py-2 text-right">{item.requestedQty}</td>
                      <td className="py-2 text-right">{item.approvedQty}</td>
                      <td className="py-2 text-right">{item.shippedQty}</td>
                      <td className="py-2 text-right">
                        {canActOnTicket ? (
                          <input
                            type="number"
                            min="0"
                            value={item.deliveredQty}
                            onChange={(e) =>
                              setTicketItemDrafts((prev) =>
                                prev.map((row, idx) =>
                                  idx === index
                                    ? {
                                        ...row,
                                        deliveredQty: Number(e.target.value),
                                      }
                                    : row
                                )
                              )
                            }
                            className="w-20 rounded border border-neutral-200 px-2 py-1 text-right"
                          />
                        ) : (
                          item.deliveredQty
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {canActOnTicket ? (
                          <div className="flex justify-end gap-2">
                            <input
                              type="number"
                              min="0"
                              value={item.issueQty}
                              onChange={(e) =>
                                setTicketItemDrafts((prev) =>
                                  prev.map((row, idx) =>
                                    idx === index
                                      ? {
                                          ...row,
                                          issueQty: Number(e.target.value),
                                        }
                                      : row
                                  )
                                )
                              }
                              className="w-16 rounded border border-neutral-200 px-2 py-1 text-right"
                            />
                            <input
                              value={item.issueReason ?? ""}
                              onChange={(e) =>
                                setTicketItemDrafts((prev) =>
                                  prev.map((row, idx) =>
                                    idx === index
                                      ? { ...row, issueReason: e.target.value }
                                      : row
                                  )
                                )
                              }
                              placeholder="Reason"
                              className="w-32 rounded border border-neutral-200 px-2 py-1"
                            />
                          </div>
                        ) : (
                          item.issueQty
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase text-neutral-500">
                  Notes
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">
                  {ticket.notes || "—"}
                </p>
              </div>
              <div className="border-t border-neutral-300 pt-8 text-sm text-neutral-500">
                Receiver signature
              </div>
            </div>
          </div>

          {/* Address edit section — admin only */}
          {canEditAdmin && (
            <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-3">
              <p className="text-xs font-bold uppercase tracking-wider text-neutral-500">
                Edit Destination Address &amp; Info
              </p>

              <div>
                <label className="block text-[10px] font-semibold uppercase text-neutral-500">
                  Destination Name
                </label>
                <input
                  defaultValue={ticket.destinationName ?? ""}
                  onBlur={async (e) => {
                    await updateDeliveryTicket(ticket.id, {
                      destinationName: e.target.value,
                    });
                    await onRefresh();
                  }}
                  placeholder="Destination Name"
                  className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-[10px] font-semibold uppercase text-neutral-500">
                  Destination Address
                </label>
                <textarea
                  defaultValue={ticket.destinationAddress ?? ""}
                  onBlur={async (e) => {
                    await updateDeliveryTicket(ticket.id, {
                      destinationAddress: e.target.value,
                    });
                    await onRefresh();
                  }}
                  placeholder="Destination Address"
                  className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm min-h-16"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-semibold uppercase text-neutral-500">
                    Contact Person
                  </label>
                  <input
                    defaultValue={ticket.destinationContact ?? ""}
                    onBlur={async (e) => {
                      await updateDeliveryTicket(ticket.id, {
                        destinationContact: e.target.value,
                      });
                      await onRefresh();
                    }}
                    placeholder="Contact name"
                    className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold uppercase text-neutral-500">
                    Contact Phone
                  </label>
                  <input
                    defaultValue={ticket.destinationPhone ?? ""}
                    onBlur={async (e) => {
                      await updateDeliveryTicket(ticket.id, {
                        destinationPhone: e.target.value,
                      });
                      await onRefresh();
                    }}
                    placeholder="Contact phone"
                    className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="pt-2">
                <button
                  onClick={async () => {
                    const res: any = await updateTicketAddressFromProfile(
                      ticket.id
                    );
                    if (res.success && res.data) {
                      onToast("Delivery address updated from store profile.");
                      await onRefresh();
                    } else {
                      alert(
                        `Address update failed: ${
                          res.error?.message ?? "Unknown error"
                        }`
                      );
                    }
                  }}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs font-semibold text-neutral-700 hover:bg-neutral-100"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Update Address from
                  Store Profile
                </button>
              </div>
            </div>
          )}

          {/* Receiver / notes section — operational roles only */}
          {canActOnTicket && (
            <div className="rounded-xl border border-neutral-200 bg-white p-4">
              <label className="text-xs font-semibold uppercase text-neutral-500">
                Received by
              </label>
              <input
                value={receivedBy}
                onChange={(e) => setReceivedBy(e.target.value)}
                placeholder="Receiver name"
                className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
              />
              <label className="mt-3 block text-xs font-semibold uppercase text-neutral-500">
                Ticket notes
              </label>
              <textarea
                defaultValue={ticket.notes ?? ""}
                onBlur={async (e) => {
                  await updateDeliveryTicket(ticket.id, {
                    notes: e.target.value,
                  });
                  await onRefresh();
                }}
                className="mt-1 min-h-20 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
              />
              <label className="mt-3 block text-xs font-semibold uppercase text-neutral-500">
                Delivery notes
              </label>
              <textarea
                defaultValue={ticket.deliveryNotes ?? ""}
                onBlur={async (e) => {
                  await updateDeliveryTicket(ticket.id, {
                    deliveryNotes: e.target.value,
                  });
                  await onRefresh();
                }}
                className="mt-1 min-h-20 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
              />
            </div>
          )}

          {/* Read-only notes for view-only users (hq_fulfillment) */}
          {!canActOnTicket && (ticket.notes || ticket.deliveryNotes) && (
            <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-3">
              {ticket.notes && (
                <div>
                  <p className="text-xs font-semibold uppercase text-neutral-500">
                    Ticket Notes
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">
                    {ticket.notes}
                  </p>
                </div>
              )}
              {ticket.deliveryNotes && (
                <div>
                  <p className="text-xs font-semibold uppercase text-neutral-500">
                    Delivery Notes
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">
                    {ticket.deliveryNotes}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
