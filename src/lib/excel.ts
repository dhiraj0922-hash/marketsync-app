/**
 * src/lib/excel.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Client-side Excel import / export utilities for Outlet Level Inventory.
 * Uses SheetJS (xlsx) — no server required.
 *
 * Two column sets:
 *   OUTLET_COLUMNS — full export (HQ master fields + outlet-editable fields)
 *   OUTLET_IMPORT_COLUMNS — the editable subset recognised on import
 */

import * as XLSX from "xlsx";

// ── Column definitions ────────────────────────────────────────────────────────

/** All columns that appear in the exported outlet inventory Excel file. */
export const OUTLET_EXPORT_COLUMNS = [
  "Location Code",
  "Inventory item",
  "Category",
  "UOM",
  "Type",
  "Supplier",
  "Price",
  "Price By UOM",
  "Tax rate",
  "Ordering enabled",
  "Inner pack quantity",
  "Pack nickname",
  "Packs per case",
  "Min order quantity",
  "Assortment",
  // ── Outlet-editable ─────────────────────────────────────────────────────────
  "Min On Hand",
  "Par level",
  "Current Stock",
  "Physical Count",
  "Local Enabled",
  "Local Notes",
] as const;

/** Columns recognised and processed during bulk import.
 *  Read-only HQ columns present in the file are silently ignored. */
export const OUTLET_IMPORT_COLUMNS = [
  "Location Code",
  "Inventory item",   // used for matching only — not written
  "Min On Hand",
  "Par level",
  "Current Stock",
  "Physical Count",
  "Local Enabled",
  "Local Notes",
] as const;

/** Template column set — all outlet export columns with empty data row. */
export const OUTLET_TEMPLATE_COLUMNS = OUTLET_EXPORT_COLUMNS;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OutletExcelRow {
  "Location Code"?:       string;
  "Inventory item"?:      string;
  "Category"?:            string;
  "UOM"?:                 string;
  "Type"?:                string;
  "Supplier"?:            string;
  "Price"?:               number | string;
  "Price By UOM"?:        string;
  "Tax rate"?:            number | string;
  "Ordering enabled"?:    boolean | string;
  "Inner pack quantity"?: number | string;
  "Pack nickname"?:       string;
  "Packs per case"?:      number | string;
  "Min order quantity"?:  number | string;
  "Assortment"?:          string;
  "Min On Hand"?:         number | string;
  "Par level"?:           number | string;
  "Current Stock"?:       number | string;
  "Physical Count"?:      number | string;
  "Local Enabled"?:       boolean | string;
  "Local Notes"?:         string;
  [key: string]: unknown;
}

export interface ValidationResult {
  totalRows:          number;
  matchedItems:       number;
  unmatchedItems:     string[];
  rowsToUpsert:       number;
  duplicateRows:      string[];
  errors:             string[];
  warnings:           string[];
  valid:              boolean;
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Convert an array of row objects → XLSX file → browser download.
 * @param rows     Array of plain objects keyed by column name.
 * @param filename Suggested filename without extension (adds .xlsx).
 */
export function exportToExcel(rows: Record<string, unknown>[], filename: string): void {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  // Auto-size columns (approximate: max header or value length)
  const headers = Object.keys(rows[0] ?? {});
  ws["!cols"] = headers.map((h) => ({
    wch: Math.max(
      h.length,
      ...rows.map((r) => String(r[h] ?? "").length)
    ) + 2,
  }));

  XLSX.utils.book_append_sheet(wb, ws, "Outlet Inventory");
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

/**
 * Generate an empty template XLSX with correct column headers only.
 * Useful for "Download Template" button.
 */
export function downloadOutletTemplate(): void {
  const headers = OUTLET_TEMPLATE_COLUMNS as unknown as string[];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    headers,
    headers.map(() => ""), // one empty example row
  ]);
  ws["!cols"] = headers.map((h) => ({ wch: h.length + 4 }));
  XLSX.utils.book_append_sheet(wb, ws, "Outlet Inventory");
  XLSX.writeFile(wb, "outlet_inventory_template.xlsx");
}

// ── Parse ─────────────────────────────────────────────────────────────────────

/**
 * Parse an uploaded Excel or CSV file into an array of row objects.
 * Returns raw row data; call validateOutletRows() before upserting.
 */
export async function parseExcelFile(file: File): Promise<OutletExcelRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<OutletExcelRow>(ws, {
          defval: "",
          blankrows: false,
        });
        resolve(rows);
      } catch (err: any) {
        reject(new Error(`Failed to parse file: ${err?.message ?? String(err)}`));
      }
    };
    reader.onerror = () => reject(new Error("FileReader error"));
    reader.readAsArrayBuffer(file);
  });
}

// ── Validate ──────────────────────────────────────────────────────────────────

/**
 * Validate parsed outlet import rows against the loaded HQ master items.
 * Returns a summary; no DB writes happen here.
 *
 * @param rows        Rows from parseExcelFile()
 * @param hqItems     Array of HQ inventory items (from loadInventory('LOC-HQ'))
 * @param locationId  The resolved outlet location_id for this import session
 * @param allLocationIds  All known location ids (for cross-checking Location Code column)
 */
export function validateOutletRows(
  rows: OutletExcelRow[],
  hqItems: any[],
  locationId: string,
  allLocationIds: string[]
): ValidationResult {
  const result: ValidationResult = {
    totalRows:      rows.length,
    matchedItems:   0,
    unmatchedItems: [],
    rowsToUpsert:   0,
    duplicateRows:  [],
    errors:         [],
    warnings:       [],
    valid:          false,
  };

  if (rows.length === 0) {
    result.errors.push("File contains no data rows.");
    return result;
  }

  // Build name→itemId map from HQ items for name-based matching
  const nameToItemId = new Map<string, string>();
  const itemIdSet    = new Set<string>();
  hqItems.forEach((i) => {
    nameToItemId.set((i.name ?? "").trim().toLowerCase(), i.itemId ?? i.id);
    itemIdSet.add(i.itemId ?? i.id);
  });

  const seenKeys = new Set<string>(); // duplicate detection: "itemId|locationId"

  rows.forEach((row, rowIdx) => {
    const rowNum = rowIdx + 2; // 1-indexed, +1 for header
    const name   = String(row["Inventory item"] ?? "").trim();

    if (!name) {
      result.errors.push(`Row ${rowNum}: "Inventory item" is blank — skipped.`);
      return;
    }

    // Resolve which location this row targets
    const rowLocCode = String(row["Location Code"] ?? "").trim();
    const resolvedLoc = rowLocCode || locationId;
    if (rowLocCode && !allLocationIds.includes(rowLocCode)) {
      result.warnings.push(
        `Row ${rowNum}: Location Code "${rowLocCode}" not recognised — will use "${locationId}".`
      );
    }

    // Resolve item_id from name
    const matchedId = nameToItemId.get(name.toLowerCase());
    if (!matchedId) {
      result.unmatchedItems.push(name);
      result.warnings.push(`Row ${rowNum}: "${name}" has no matching HQ master item.`);
      return;
    }

    // Duplicate detection
    const key = `${matchedId}|${resolvedLoc}`;
    if (seenKeys.has(key)) {
      result.duplicateRows.push(`Row ${rowNum}: "${name}" @ ${resolvedLoc} (duplicate)`);
      return;
    }
    seenKeys.add(key);

    result.matchedItems++;
    result.rowsToUpsert++;
  });

  result.valid = result.errors.length === 0 && result.rowsToUpsert > 0;
  return result;
}

// ── Map row → DB object ───────────────────────────────────────────────────────

/**
 * Convert a validated Excel row into the shape expected by
 * upsertLocationInventoryRow() in storage.ts.
 *
 * Call only after validateOutletRows() confirms a row is matched.
 */
export function mapExcelRowToOutletRecord(
  row: OutletExcelRow,
  hqItems: any[],
  fallbackLocationId: string
): {
  item_id:        string;
  location_id:    string;
  current_stock:  number;
  physical_count: number | null;
  min_on_hand:    number;
  par_level:      number;
  local_enabled:  boolean;
  local_notes:    string | null;
} | null {
  const name    = String(row["Inventory item"] ?? "").trim();
  const locCode = String(row["Location Code"]  ?? "").trim() || fallbackLocationId;

  const hqItem = hqItems.find(
    (i) => (i.name ?? "").trim().toLowerCase() === name.toLowerCase()
  );
  if (!hqItem) return null;

  const toNum = (v: unknown, def = 0) => {
    const n = parseFloat(String(v ?? ""));
    return isNaN(n) ? def : n;
  };
  const toBool = (v: unknown, def = true) => {
    if (v === true || String(v).toLowerCase() === "true" || String(v) === "1") return true;
    if (v === false || String(v).toLowerCase() === "false" || String(v) === "0") return false;
    return def;
  };

  return {
    item_id:        hqItem.itemId ?? hqItem.id,
    location_id:    locCode,
    current_stock:  toNum(row["Current Stock"]),
    physical_count: row["Physical Count"] !== "" && row["Physical Count"] != null
                      ? toNum(row["Physical Count"])
                      : null,
    min_on_hand:    toNum(row["Min On Hand"]),
    par_level:      toNum(row["Par level"]),
    local_enabled:  toBool(row["Local Enabled"]),
    local_notes:    String(row["Local Notes"] ?? "").trim() || null,
  };
}
