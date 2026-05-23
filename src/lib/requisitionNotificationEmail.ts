export type HqRequisitionEmailLine = {
  item_name_snapshot?: string | null;
  inventory_items?: { name?: string | null } | { name?: string | null }[] | null;
  hq_sale_items?: { name?: string | null; base_unit?: string | null } | { name?: string | null; base_unit?: string | null }[] | null;
  quantity_requested?: number | string | null;
  unit_snapshot?: string | null;
  unit_price?: number | string | null;
  line_total?: number | string | null;
};

export type HqRequisitionEmailData = {
  requisitionId: string;
  locationName: string;
  submittedBy?: string | null;
  submittedAt: string;
  requestedDeliveryDate?: string | null;
  notes?: string | null;
  totalValue?: number | string | null;
  lineItems: HqRequisitionEmailLine[];
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function money(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return `$${num.toFixed(2)}`;
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function itemName(line: HqRequisitionEmailLine): string {
  const saleItem = firstRelation(line.hq_sale_items);
  const inventoryItem = firstRelation(line.inventory_items);
  return line.item_name_snapshot
    || saleItem?.name
    || inventoryItem?.name
    || "Item";
}

function itemUnit(line: HqRequisitionEmailLine): string {
  const saleItem = firstRelation(line.hq_sale_items);
  return line.unit_snapshot || saleItem?.base_unit || "";
}

export function buildHqRequisitionSubject(data: HqRequisitionEmailData): string {
  return `${data.locationName} submitted requisition ${data.requisitionId}`;
}

export function buildHqRequisitionText(data: HqRequisitionEmailData): string {
  const lines = data.lineItems.map((line) => {
    return [
      `- ${itemName(line)}`,
      `  Quantity: ${line.quantity_requested ?? ""} ${itemUnit(line)}`.trimEnd(),
      line.line_total != null ? `  Line total: ${money(line.line_total)}` : "",
    ].filter(Boolean).join("\n");
  });

  return [
    `Location: ${data.locationName}`,
    data.submittedBy ? `Submitted by: ${data.submittedBy}` : "",
    `Requisition/order number: ${data.requisitionId}`,
    `Submitted date/time: ${data.submittedAt}`,
    data.requestedDeliveryDate ? `Requested delivery date: ${data.requestedDeliveryDate}` : "",
    data.totalValue != null ? `Total value: ${money(data.totalValue)}` : "",
    data.notes ? `Notes: ${data.notes}` : "",
    "",
    "Items:",
    lines.join("\n\n"),
    "",
    "Please log in to StockIQ to approve/fulfill this order.",
  ].filter((line) => line !== "").join("\n");
}

export function buildHqRequisitionHtml(data: HqRequisitionEmailData): string {
  const rows = data.lineItems.map((line) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(itemName(line))}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${escapeHtml(line.quantity_requested ?? "")}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(itemUnit(line))}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(data.notes || "")}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${escapeHtml(line.line_total != null ? money(line.line_total) : "")}</td>
    </tr>
  `).join("");

  return `
    <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;">
      <h1 style="font-size:20px;margin:0 0 12px;">New StockIQ Requisition</h1>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin:0 0 18px;">
        <tbody>
          <tr><td style="padding:4px 0;color:#6b7280;">Location</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(data.locationName)}</td></tr>
          ${data.submittedBy ? `<tr><td style="padding:4px 0;color:#6b7280;">Submitted by</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(data.submittedBy)}</td></tr>` : ""}
          <tr><td style="padding:4px 0;color:#6b7280;">Requisition/order number</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(data.requisitionId)}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Submitted date/time</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(data.submittedAt)}</td></tr>
          ${data.requestedDeliveryDate ? `<tr><td style="padding:4px 0;color:#6b7280;">Requested delivery</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(data.requestedDeliveryDate)}</td></tr>` : ""}
          ${data.totalValue != null ? `<tr><td style="padding:4px 0;color:#6b7280;">Total value</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(money(data.totalValue))}</td></tr>` : ""}
        </tbody>
      </table>
      <table style="border-collapse:collapse;width:100%;font-size:13px;border:1px solid #e5e7eb;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #e5e7eb;">Item</th>
            <th style="padding:10px 12px;text-align:right;border-bottom:1px solid #e5e7eb;">Qty</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #e5e7eb;">Unit</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #e5e7eb;">Notes</th>
            <th style="padding:10px 12px;text-align:right;border-bottom:1px solid #e5e7eb;">Line total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${data.notes ? `<p style="margin:18px 0 0;"><strong>Order notes:</strong> ${escapeHtml(data.notes)}</p>` : ""}
      <p style="margin:18px 0 0;font-weight:600;">Please log in to StockIQ to approve/fulfill this order.</p>
    </div>
  `;
}
