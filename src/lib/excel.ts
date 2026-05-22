/**
 * src/lib/excel.ts
 * Client-side Excel import/export for Outlet Inventory (v2).
 * Uses SheetJS (xlsx).
 */
import * as XLSX from "xlsx";

// ── Column sets ───────────────────────────────────────────────────────────────

/** All columns in the outlet export file */
export const OUTLET_EXPORT_COLUMNS = [
  "Source Type",
  "Inventory item",
  "Category",
  "UOM",
  "Type",
  "Supplier",
  "Purchase Options",
  "Product Code",
  "Scan Barcode",
  "Price",
  "Tax rate",
  "Ordering enabled",
  // outlet-editable
  "Min On Hand",
  "Par level",
  "Current Stock",
  "Physical Count",
  "Local Supplier",
  "Local Price",
  "Local Enabled",
  "Local Notes",
] as const;

export const OUTLET_TEMPLATE_COLUMNS = OUTLET_EXPORT_COLUMNS;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface OutletExcelRow {
  "Source Type"?:       string;
  "Inventory item"?:    string;
  "Category"?:          string;
  "UOM"?:               string;
  "Type"?:              string;
  "Supplier"?:          string;
  "Purchase Options"?:  string;
  "Product Code"?:      string;
  "Scan Barcode"?:      string;
  "Price"?:             number | string;
  "Tax rate"?:          number | string;
  "Ordering enabled"?:  boolean | string;
  "Min On Hand"?:       number | string;
  "Par level"?:         number | string;
  "Current Stock"?:     number | string;
  "Physical Count"?:    number | string;
  "Local Supplier"?:    string;
  "Local Price"?:       number | string;
  "Local Enabled"?:     boolean | string;
  "Local Notes"?:       string;
  "Location Code"?:     string;
  [key: string]: unknown;
}

export interface ValidationResult {
  totalRows:       number;
  matchedItems:    number;
  unmatchedItems:  string[];
  rowsToUpsert:    number;
  duplicateRows:   string[];
  errors:          string[];
  warnings:        string[];
  valid:           boolean;
}

// ── Export ────────────────────────────────────────────────────────────────────
export function exportToExcel(rows: Record<string, unknown>[], filename: string): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  const headers = Object.keys(rows[0] ?? {});
  ws["!cols"] = headers.map((h) => ({
    wch: Math.max(h.length, ...rows.map((r) => String(r[h] ?? "").length)) + 2,
  }));
  XLSX.utils.book_append_sheet(wb, ws, "Outlet Inventory");
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

export function downloadOutletTemplate(): void {
  const headers = OUTLET_TEMPLATE_COLUMNS as unknown as string[];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, headers.map(() => "")]);
  ws["!cols"] = headers.map((h) => ({ wch: h.length + 4 }));
  XLSX.utils.book_append_sheet(wb, ws, "Outlet Inventory");
  XLSX.writeFile(wb, "outlet_inventory_template.xlsx");
}

// ── Parse ─────────────────────────────────────────────────────────────────────
export async function parseExcelFile(file: File): Promise<OutletExcelRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json<OutletExcelRow>(ws, { defval: "", blankrows: false }));
      } catch (err: any) {
        reject(new Error(`Failed to parse file: ${err?.message ?? String(err)}`));
      }
    };
    reader.onerror = () => reject(new Error("FileReader error"));
    reader.readAsArrayBuffer(file);
  });
}

// ── Validate ──────────────────────────────────────────────────────────────────
export function validateOutletRows(
  rows: OutletExcelRow[],
  catalogItems: any[],   // OutletCatalogItem[]
  locationId: string,
  allLocationIds: string[]
): ValidationResult {
  const result: ValidationResult = {
    totalRows: rows.length, matchedItems: 0, unmatchedItems: [],
    rowsToUpsert: 0, duplicateRows: [], errors: [], warnings: [], valid: false,
  };
  if (rows.length === 0) { result.errors.push("File contains no data rows."); return result; }

  const nameToItemId = new Map<string, string>();
  catalogItems.forEach((i) => nameToItemId.set((i.name ?? "").trim().toLowerCase(), i.itemId));

  const seen = new Set<string>();
  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
    const name = String(row["Inventory item"] ?? "").trim();
    if (!name) { result.errors.push(`Row ${rowNum}: "Inventory item" is blank.`); return; }

    const rowLoc = String(row["Location Code"] ?? "").trim();
    const resolvedLoc = rowLoc || locationId;
    if (rowLoc && !allLocationIds.includes(rowLoc)) {
      result.warnings.push(`Row ${rowNum}: Location "${rowLoc}" unknown — using "${locationId}".`);
    }

    const matchedId = nameToItemId.get(name.toLowerCase());
    if (!matchedId) { result.unmatchedItems.push(name); result.warnings.push(`Row ${rowNum}: "${name}" not in outlet catalog.`); return; }

    const key = `${matchedId}|${resolvedLoc}`;
    if (seen.has(key)) { result.duplicateRows.push(`Row ${rowNum}: "${name}" @ ${resolvedLoc}`); return; }
    seen.add(key);
    result.matchedItems++;
    result.rowsToUpsert++;
  });

  result.valid = result.errors.length === 0 && result.rowsToUpsert > 0;
  return result;
}

// ── Map row → DB record ───────────────────────────────────────────────────────
export function mapExcelRowToOutletRecord(
  row: OutletExcelRow,
  catalogItems: any[],
  fallbackLocationId: string
): {
  item_id: string; location_id: string;
  current_stock: number; physical_count: number | null;
  min_on_hand: number; par_level: number;
  local_enabled: boolean; local_notes: string | null;
  local_supplier: string | null; local_price: number | null;
} | null {
  const name = String(row["Inventory item"] ?? "").trim();
  const loc  = String(row["Location Code"] ?? "").trim() || fallbackLocationId;
  const item = catalogItems.find((i) => (i.name ?? "").trim().toLowerCase() === name.toLowerCase());
  if (!item) return null;

  const n = (v: unknown, def = 0) => { const x = parseFloat(String(v ?? "")); return isNaN(x) ? def : x; };
  const b = (v: unknown, def = true) => {
    if (v === true  || String(v).toLowerCase() === "true"  || String(v) === "1") return true;
    if (v === false || String(v).toLowerCase() === "false" || String(v) === "0") return false;
    return def;
  };

  return {
    item_id:        item.itemId,
    location_id:    loc,
    current_stock:  n(row["Current Stock"]),
    physical_count: row["Physical Count"] !== "" && row["Physical Count"] != null ? n(row["Physical Count"]) : null,
    min_on_hand:    n(row["Min On Hand"]),
    par_level:      n(row["Par level"]),
    local_enabled:  b(row["Local Enabled"]),
    local_notes:    String(row["Local Notes"] ?? "").trim() || null,
    local_supplier: String(row["Local Supplier"] ?? "").trim() || null,
    local_price:    row["Local Price"] !== "" && row["Local Price"] != null ? n(row["Local Price"]) : null,
  };
}
