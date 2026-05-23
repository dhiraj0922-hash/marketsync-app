export type SupplierOrderEmailLine = {
  name?: string | null;
  qty?: number | string | null;
  unit?: string | null;
  purchaseUom?: string | null;
  expectedPrice?: number | string | null;
  cost?: number | string | null;
};

export type SupplierOrderEmailData = {
  poNumber: string;
  supplierName: string;
  locationName: string;
  deliveryDate?: string | null;
  notes?: string | null;
  contactName?: string | null;
  replyTo?: string | null;
  lineItems: SupplierOrderEmailLine[];
};

function money(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return `$${num.toFixed(2)}`;
}

function qty(value: unknown): string {
  const num = Number(value);
  if (Number.isFinite(num)) return String(num);
  return value == null ? "" : String(value);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function buildSupplierOrderSubject(order: SupplierOrderEmailData): string {
  return `Purchase Order ${order.poNumber} from ${order.locationName || "StockIQ"}`;
}

export function buildSupplierOrderText(order: SupplierOrderEmailData): string {
  const lines = order.lineItems.map((item) => {
    const quantity = qty(item.qty);
    const unit = item.purchaseUom || item.unit || "";
    const unitCost = item.expectedPrice ?? item.cost;
    const total = Number(item.qty) * Number(unitCost);
    return [
      `- ${item.name ?? "Item"}`,
      quantity ? `  Qty: ${quantity} ${unit}`.trimEnd() : "",
      unitCost != null ? `  Unit cost: ${money(unitCost)}` : "",
      Number.isFinite(total) ? `  Line total: ${money(total)}` : "",
    ].filter(Boolean).join("\n");
  });

  return [
    `Purchase Order: ${order.poNumber}`,
    `Supplier: ${order.supplierName}`,
    `Location: ${order.locationName}`,
    order.deliveryDate ? `Requested delivery date: ${order.deliveryDate}` : "",
    "",
    "Items:",
    lines.join("\n\n"),
    "",
    order.notes ? `Notes: ${order.notes}` : "",
    order.contactName || order.replyTo
      ? `Contact: ${[order.contactName, order.replyTo].filter(Boolean).join(" · ")}`
      : "",
  ].filter((line) => line !== "").join("\n");
}

export function buildSupplierOrderHtml(order: SupplierOrderEmailData): string {
  const rows = order.lineItems.map((item) => {
    const quantity = qty(item.qty);
    const unit = item.purchaseUom || item.unit || "";
    const unitCost = item.expectedPrice ?? item.cost;
    const lineTotal = Number(item.qty) * Number(unitCost);

    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(item.name || "Item")}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${escapeHtml(quantity)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(unit)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${escapeHtml(unitCost != null ? money(unitCost) : "")}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${escapeHtml(Number.isFinite(lineTotal) ? money(lineTotal) : "")}</td>
      </tr>`;
  }).join("");

  return `
    <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;">
      <h1 style="font-size:20px;margin:0 0 12px;">Purchase Order ${escapeHtml(order.poNumber)}</h1>
      <p style="margin:0 0 16px;">Hello ${escapeHtml(order.supplierName)},</p>
      <p style="margin:0 0 20px;">Please process the following order for ${escapeHtml(order.locationName)}.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin:0 0 18px;">
        <tbody>
          <tr><td style="padding:4px 0;color:#6b7280;">PO Number</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(order.poNumber)}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Location</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(order.locationName)}</td></tr>
          ${order.deliveryDate ? `<tr><td style="padding:4px 0;color:#6b7280;">Requested delivery</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(order.deliveryDate)}</td></tr>` : ""}
        </tbody>
      </table>
      <table style="border-collapse:collapse;width:100%;font-size:13px;border:1px solid #e5e7eb;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #e5e7eb;">Item</th>
            <th style="padding:10px 12px;text-align:right;border-bottom:1px solid #e5e7eb;">Qty</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #e5e7eb;">Unit</th>
            <th style="padding:10px 12px;text-align:right;border-bottom:1px solid #e5e7eb;">Unit cost</th>
            <th style="padding:10px 12px;text-align:right;border-bottom:1px solid #e5e7eb;">Line total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${order.notes ? `<p style="margin:18px 0 0;"><strong>Notes:</strong> ${escapeHtml(order.notes)}</p>` : ""}
      ${order.contactName || order.replyTo ? `<p style="margin:18px 0 0;color:#4b5563;">Reply to ${escapeHtml([order.contactName, order.replyTo].filter(Boolean).join(" · "))}</p>` : ""}
    </div>`;
}
