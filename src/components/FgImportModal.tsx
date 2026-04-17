"use client";

/**
 * FgImportModal
 * Bulk CSV import for HQ Finished Goods (hq_sale_items).
 *
 * Flow:
 *   1. Upload CSV → parse → validate row-by-row
 *   2. Show preview table (valid / invalid / duplicate counts)
 *   3. Click "Import" → insert-only (skip duplicates, never update)
 *   4. Show results summary
 *
 * Duplicate match: case-insensitive name normalisation against existingNames.
 * ID format: `SKU-${timestamp+index}` — matches the pattern already used in
 * handleSave() in hq-sale-items/page.tsx.
 *
 * Accepted MarketMan-style CSV columns (flexible header matching):
 *   Sale name / Item name / Name                  → name (REQUIRED)
 *   Category / Item category                      → category
 *   Price / Sale price / Unit price               → manualPrice (numeric)
 *   Unit / Base unit / UOM                        → baseUnit
 *   Description / Notes                           → description
 *   SKU / Item code / Code                        → id override (optional)
 *
 * All other columns are silently ignored.
 */

import { useRef, useState } from "react";
import { X, Upload, CheckCircle2, AlertTriangle, SkipForward, Loader2, Download } from "lucide-react";
import { upsertSaleItem } from "@/lib/storage";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParsedRow {
  rowNum:    number;
  raw:       Record<string, string>; // original CSV fields
  name:      string;
  category:  string | null;
  price:     number | null;          // → manualPrice
  baseUnit:  string;
  description: string | null;
  skuOverride: string | null;        // from SKU/Code column if present

  // validation
  errors:    string[];
  isDuplicate: boolean;
  isValid:   boolean;
}

interface ImportResult {
  inserted: number;
  skipped:  number;
  failed:   string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns the column index that matches any of the accepted aliases (case-insensitive). */
function colIdx(headers: string[], aliases: string[]): number {
  const lc = headers.map(h => h.trim().toLowerCase());
  for (const alias of aliases) {
    const i = lc.indexOf(alias.toLowerCase());
    if (i !== -1) return i;
  }
  return -1;
}

function norm(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/);
  const result: string[][] = [];
  for (const line of lines) {
    // naive RFC 4180 — handles quoted commas + double-quotes inside quotes
    const cols: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === "," && !inQ) {
        cols.push(cur); cur = "";
      } else {
        cur += ch;
      }
    }
    cols.push(cur);
    result.push(cols.map(c => c.trim()));
  }
  const nonEmpty = result.filter(r => r.some(c => c !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  return { headers: nonEmpty[0], rows: nonEmpty.slice(1) };
}

function generateSku(idx: number) {
  return `SKU-${Date.now().toString(36).toUpperCase()}${idx.toString().padStart(3, "0")}`;
}

const TEMPLATE_CSV =
  "Sale name,Category,Price,Unit,Description,SKU\n" +
  "Sourdough Loaf,Breads,4.50,ea,Classic sourdough,SKU-BRD001\n" +
  "Garlic Sauce,Sauces,2.00,bottle,,\n";

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  isOpen:        boolean;
  onClose:       () => void;
  existingNames: string[];   // normalised names of items already in DB
  onSuccess:     () => void; // called after a successful import to reload data
}

export function FgImportModal({ isOpen, onClose, existingNames, onSuccess }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [rows,    setRows]    = useState<ParsedRow[]>([]);
  const [phase,   setPhase]   = useState<"idle" | "preview" | "done">("idle");
  const [result,  setResult]  = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);

  if (!isOpen) return null;

  // ── Reset ────────────────────────────────────────────────────────────────
  const reset = () => {
    setRows([]); setPhase("idle"); setResult(null); setLoading(false); setParseErr(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleClose = () => { reset(); onClose(); };

  // ── Template download ────────────────────────────────────────────────────
  const downloadTemplate = () => {
    const blob = new Blob([TEMPLATE_CSV], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "fg_import_template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Parse ────────────────────────────────────────────────────────────────
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    reset();

    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target?.result as string;
      const { headers, rows: rawRows } = parseCSV(text);

      if (headers.length === 0 || rawRows.length === 0) {
        setParseErr("File appears empty or has no data rows."); return;
      }

      // map headers
      const iName  = colIdx(headers, ["sale name", "item name", "name", "product name", "item"]);
      const iCat   = colIdx(headers, ["category", "item category", "group"]);
      const iPrice = colIdx(headers, ["price", "sale price", "unit price", "selling price"]);
      const iUnit  = colIdx(headers, ["unit", "base unit", "uom", "unit of measure"]);
      const iDesc  = colIdx(headers, ["description", "notes", "note", "details"]);
      const iSku   = colIdx(headers, ["sku", "item code", "code", "product code", "barcode"]);

      if (iName === -1) {
        setParseErr(
          `Could not find a "Sale name" or "Name" column. ` +
          `Headers found: ${headers.join(", ")}`
        ); return;
      }

      const existingSet = new Set(existingNames.map(norm));

      const parsed: ParsedRow[] = rawRows.map((cols, idx) => {
        const get = (i: number) => (i === -1 || i >= cols.length ? "" : cols[i].trim());

        const name        = get(iName);
        const catRaw      = get(iCat);
        const priceRaw    = get(iPrice);
        const unitRaw     = get(iUnit);
        const descRaw     = get(iDesc);
        const skuRaw      = get(iSku);

        const errors: string[] = [];
        if (!name) errors.push("Name is required.");

        let price: number | null = null;
        if (priceRaw !== "") {
          const p = parseFloat(priceRaw.replace(/[$,]/g, ""));
          if (isNaN(p)) errors.push(`Price "${priceRaw}" is not a valid number.`);
          else price = p;
        }

        const isDuplicate = name ? existingSet.has(norm(name)) : false;

        return {
          rowNum: idx + 2,
          raw: Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? ""])),
          name,
          category:    catRaw  || null,
          price,
          baseUnit:    unitRaw || "ea",
          description: descRaw || null,
          skuOverride: skuRaw  || null,
          errors,
          isDuplicate,
          isValid: errors.length === 0 && !isDuplicate,
        };
      }).filter(r => r.name !== "");   // drop blank rows

      setRows(parsed);
      setPhase("preview");
    };
    reader.readAsText(file);
  };

  // ── Import ────────────────────────────────────────────────────────────────
  const runImport = async () => {
    setLoading(true);
    const toInsert = rows.filter(r => r.isValid);
    let inserted = 0;
    const skipped = rows.filter(r => r.isDuplicate).length;
    const failed: string[] = [];

    for (const [i, row] of toInsert.entries()) {
      const id = row.skuOverride || generateSku(i);
      const res = await upsertSaleItem({
        id,
        name:                 row.name,
        category:             row.category,
        description:          row.description,
        baseUnit:             row.baseUnit,
        manualPrice:          row.price,
        sourceCommissary:     "Commissary HQ",
        isActive:             true,
        isRequisitionable:    true,
        instock:              0,
        parLevel:             0,
        makingCost:           0,
        suggestedPrice:       0,
        effectivePrice:       0,
        sourceRecipeId:       null,
        sourceRecipeYieldQty: 1,
        stockStatus:          "out_of_stock",
        makingCostUpdatedAt:  null,
        createdAt:            null,
        updatedAt:            null,
      });
      if (res.success) inserted++;
      else failed.push(`Row ${row.rowNum} (${row.name}): ${res.error?.message ?? "DB error"}`);
    }

    setResult({ inserted, skipped, failed });
    setPhase("done");
    setLoading(false);
    if (inserted > 0) onSuccess();
  };

  // ── Derived counts ────────────────────────────────────────────────────────
  const validCount     = rows.filter(r => r.isValid).length;
  const invalidCount   = rows.filter(r => r.errors.length > 0 && !r.isDuplicate).length;
  const dupCount       = rows.filter(r => r.isDuplicate).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={handleClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-4xl max-h-[90vh] flex flex-col bg-white rounded-2xl shadow-2xl overflow-hidden">

        {/* ── Header ─────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100 bg-gradient-to-r from-brand-600 to-brand-800">
          <div>
            <h2 className="text-white font-bold text-lg">Import Finished Goods</h2>
            <p className="text-brand-200 text-xs mt-0.5">
              Bulk CSV import — insert-only, duplicates are skipped
            </p>
          </div>
          <button onClick={handleClose} className="text-white/70 hover:text-white transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">

          {/* PHASE: idle */}
          {phase === "idle" && (
            <div className="space-y-5">
              {/* Instructions */}
              <div className="bg-brand-50 border border-brand-100 rounded-xl p-4 text-sm text-brand-800 space-y-2">
                <p className="font-semibold">Accepted CSV columns (flexible matching):</p>
                <ul className="list-disc list-inside space-y-0.5 text-brand-700 text-xs">
                  <li><strong>Sale name / Name</strong> — required</li>
                  <li><strong>Category</strong> — optional</li>
                  <li><strong>Price</strong> — optional, numeric</li>
                  <li><strong>Unit</strong> — optional (defaults to "ea")</li>
                  <li><strong>Description</strong> — optional</li>
                  <li><strong>SKU / Item code</strong> — optional, used as item ID</li>
                </ul>
              </div>

              {/* Template + Upload */}
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={downloadTemplate}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors"
                >
                  <Download className="h-4 w-4" /> Download Template
                </button>
                <label className="flex-1 flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-brand-300 rounded-xl text-sm font-semibold text-brand-700 hover:bg-brand-50 cursor-pointer transition-colors">
                  <Upload className="h-4 w-4" />
                  Click to upload CSV file
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={handleFile}
                  />
                </label>
              </div>

              {parseErr && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  {parseErr}
                </div>
              )}
            </div>
          )}

          {/* PHASE: preview */}
          {phase === "preview" && (
            <div className="space-y-4">
              {/* Summary chips */}
              <div className="flex flex-wrap gap-3">
                <Chip color="green"  label={`${validCount} ready to import`}   icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
                <Chip color="yellow" label={`${dupCount} duplicates (skipped)`} icon={<SkipForward className="h-3.5 w-3.5" />} />
                <Chip color="red"    label={`${invalidCount} invalid rows`}     icon={<AlertTriangle className="h-3.5 w-3.5" />} />
              </div>

              {/* Column map info */}
              <p className="text-xs text-neutral-500 italic">
                {rows.length} data rows parsed from CSV. Duplicate matching is case-insensitive on name.
              </p>

              {/* Table */}
              <div className="border border-neutral-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto max-h-[380px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-neutral-50 border-b border-neutral-100 sticky top-0 z-10">
                      <tr>
                        {["#", "Name", "Category", "Price", "Unit", "Status"].map(h => (
                          <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-50">
                      {rows.map((r, i) => (
                        <tr key={i} className={`transition-colors ${r.isDuplicate ? "bg-yellow-50/60" : r.errors.length > 0 ? "bg-red-50/60" : "hover:bg-neutral-50/50"}`}>
                          <td className="px-3 py-2 text-neutral-400 text-xs font-mono">{r.rowNum}</td>
                          <td className="px-3 py-2 font-medium text-neutral-900 max-w-[180px] truncate">{r.name || <span className="italic text-neutral-400">—</span>}</td>
                          <td className="px-3 py-2 text-neutral-600 text-xs">{r.category ?? <span className="text-neutral-300">—</span>}</td>
                          <td className="px-3 py-2 text-neutral-600 tabular-nums text-xs">{r.price != null ? `$${r.price.toFixed(2)}` : <span className="text-neutral-300">—</span>}</td>
                          <td className="px-3 py-2 text-neutral-500 text-xs">{r.baseUnit}</td>
                          <td className="px-3 py-2">
                            {r.isDuplicate ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 border border-yellow-200">
                                <SkipForward className="h-2.5 w-2.5" /> Duplicate
                              </span>
                            ) : r.errors.length > 0 ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200" title={r.errors.join("; ")}>
                                <AlertTriangle className="h-2.5 w-2.5" /> Invalid
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200">
                                <CheckCircle2 className="h-2.5 w-2.5" /> Ready
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Per-row error list */}
              {rows.some(r => r.errors.length > 0) && (
                <div className="rounded-xl bg-red-50 border border-red-100 p-4 space-y-1">
                  <p className="text-xs font-semibold text-red-700 uppercase tracking-wider mb-2">Validation errors</p>
                  {rows.filter(r => r.errors.length > 0 && !r.isDuplicate).map(r => (
                    <p key={r.rowNum} className="text-xs text-red-600">
                      <span className="font-mono font-semibold">Row {r.rowNum}:</span> {r.errors.join(" · ")}
                    </p>
                  ))}
                </div>
              )}

              {/* Upload another */}
              <button
                onClick={reset}
                className="text-xs text-brand-600 hover:underline"
              >
                ← Upload a different file
              </button>
            </div>
          )}

          {/* PHASE: done */}
          {phase === "done" && result && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-3">
                <Chip color="green"  label={`${result.inserted} items imported`}  icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
                <Chip color="yellow" label={`${result.skipped} duplicates skipped`} icon={<SkipForward className="h-3.5 w-3.5" />} />
                {result.failed.length > 0 && (
                  <Chip color="red"  label={`${result.failed.length} failed`}      icon={<AlertTriangle className="h-3.5 w-3.5" />} />
                )}
              </div>

              {result.failed.length > 0 && (
                <div className="rounded-xl bg-red-50 border border-red-100 p-4 space-y-1">
                  <p className="text-xs font-semibold text-red-700 uppercase tracking-wider mb-2">DB errors</p>
                  {result.failed.map((f, i) => (
                    <p key={i} className="text-xs text-red-600">{f}</p>
                  ))}
                </div>
              )}

              {result.inserted > 0 && (
                <p className="text-sm text-neutral-600">
                  The catalog has been updated. You can close this window.
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────── */}
        <div className="px-6 py-4 border-t border-neutral-100 flex items-center justify-end gap-3 bg-neutral-50">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors"
          >
            {phase === "done" ? "Close" : "Cancel"}
          </button>

          {phase === "preview" && validCount > 0 && (
            <button
              onClick={runImport}
              disabled={loading}
              className="flex items-center gap-2 px-5 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm disabled:opacity-50"
            >
              {loading
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</>
                : <><Upload className="h-4 w-4" /> Import {validCount} Items</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Mini chip ────────────────────────────────────────────────────────────────
function Chip({
  color, label, icon,
}: {
  color: "green" | "yellow" | "red";
  label: string;
  icon: React.ReactNode;
}) {
  const styles = {
    green:  "bg-green-50  text-green-700  border-green-200",
    yellow: "bg-yellow-50 text-yellow-700 border-yellow-200",
    red:    "bg-red-50    text-red-700    border-red-200",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border ${styles[color]}`}>
      {icon} {label}
    </span>
  );
}
