"use client";

/**
 * AIRecipeImport.tsx
 *
 * AI Recipe Import — Full UI Component
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-contained drawer that drives the full import flow:
 *
 *   upload → extracting → review → done
 *
 * Props:
 *   isOpen          — whether the drawer is open
 *   onClose         — called when user cancels or dismisses
 *   inventory       — current inventory items (for ingredient matching)
 *   onConfirm       — called with confirmed ingredients + recipe header info
 *                     after user completes review
 *
 * The component produces ingredients in the format expected by the
 * existing recipe builder (openBuilder / saveRecipeData).
 * It does NOT auto-save to the database — the caller controls that.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import {
  Upload, Camera, X, ChevronRight, AlertCircle, CheckCircle2,
  RotateCcw, Loader2, Sparkles, Eye, Trash2, Plus, Info,
  FileText, ShieldAlert, Zap, Search
} from "lucide-react";
import {
  type ReviewRow,
  type AiExtractionResult,
  type ImportSummary,
  buildReviewRows,
  reviewRowsToIngredients,
  computeImportSummary,
} from "@/lib/aiRecipeImport";
// Note: no storage import needed — requestId generated inline with Date.now()

// ─── Types ─────────────────────────────────────────────────────────────────

type Step = "upload" | "extracting" | "review" | "done";

interface RecipeHeader {
  name: string;
  category: string;
  yieldQty: number;
  yieldUnit: string;
  notes: string;
}

interface AIRecipeImportProps {
  isOpen: boolean;
  onClose: () => void;
  inventory: any[];
  onConfirm: (header: RecipeHeader, ingredients: any[]) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<ReviewRow["status"], string> = {
  matched:          "bg-success-100 text-success-800 border-success-200",
  low_confidence:   "bg-warning-50 text-warning-700 border-warning-200",
  needs_ingredient: "bg-danger-50 text-danger-700 border-danger-200",
  needs_unit:       "bg-orange-50 text-orange-700 border-orange-200",
  missing_qty:      "bg-danger-50 text-danger-700 border-danger-200",
  warning:          "bg-warning-50 text-warning-800 border-warning-200",
};

const STATUS_LABELS: Record<ReviewRow["status"], string> = {
  matched:          "Matched",
  low_confidence:   "Low Confidence",
  needs_ingredient: "Select Item",
  needs_unit:       "Select Unit",
  missing_qty:      "Enter Qty",
  warning:          "Warning",
};

const CANONICAL_UNITS = [
  { code: "g",     label: "Grams (g)" },
  { code: "kg",    label: "Kilograms (kg)" },
  { code: "mg",    label: "Milligrams (mg)" },
  { code: "oz",    label: "Ounces (oz)" },
  { code: "lb",    label: "Pounds (lb)" },
  { code: "ml",    label: "Milliliters (ml)" },
  { code: "l",     label: "Liters (l)" },
  { code: "tsp",   label: "Teaspoon (tsp)" },
  { code: "tbsp",  label: "Tablespoon (tbsp)" },
  { code: "cup",   label: "Cup" },
  { code: "fl oz",  label: "Fl. Oz." },
  { code: "pcs",   label: "Pieces (pcs)" },
  { code: "each",  label: "Each" },
  { code: "pack",  label: "Pack" },
  { code: "bunch", label: "Bunch" },
  { code: "can",   label: "Can / Tin" },
  { code: "bottle",label: "Bottle" },
  { code: "bag",   label: "Bag" },
  { code: "box",   label: "Box" },
  { code: "clove", label: "Clove" },
  { code: "sprig", label: "Sprig" },
  { code: "slice", label: "Slice" },
  { code: "knob",  label: "Knob" },
];

const CATEGORIES = ["Mains", "Prep", "Sauces", "Starters", "Desserts", "Base", "Other"];

// ─── Upload Zone ─────────────────────────────────────────────────────────────

function UploadZone({
  onFileReady,
}: {
  onFileReady: (file: File, preview: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const processFile = (file: File) => {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Please upload an image file (JPEG, PNG, WebP, HEIC).");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError("Image too large. Maximum size is 4MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      onFileReady(file, e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, []);

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`
          relative rounded-2xl border-2 border-dashed cursor-pointer transition-all p-10
          flex flex-col items-center justify-center gap-4 text-center
          ${isDragOver
            ? "border-brand-500 bg-brand-50 scale-[1.01]"
            : "border-neutral-300 bg-neutral-50 hover:border-brand-400 hover:bg-brand-50/50"}
        `}
      >
        <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-brand-500 to-violet-500 flex items-center justify-center shadow-lg">
          <Sparkles className="h-8 w-8 text-white" />
        </div>
        <div>
          <p className="text-lg font-bold text-neutral-900">Drop recipe image here</p>
          <p className="text-sm text-neutral-500 mt-1">
            Works with printed recipes, handwritten notes, prep sheets, and supplier documents
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white text-sm font-semibold rounded-xl hover:bg-brand-700 transition-colors shadow-sm"
          >
            <Upload className="h-4 w-4" />
            Upload File
          </button>
          <label
            htmlFor="ai-camera-capture"
            className="flex items-center gap-2 px-5 py-2.5 bg-white border border-neutral-300 text-neutral-700 text-sm font-semibold rounded-xl hover:bg-neutral-50 transition-colors shadow-sm cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          >
            <Camera className="h-4 w-4" />
            Take Photo
            <input
              id="ai-camera-capture"
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) processFile(f); }}
            />
          </label>
        </div>
        <p className="text-xs text-neutral-400">JPEG, PNG, WebP, HEIC — max 4MB</p>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) processFile(f); }}
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-danger-50 border border-danger-200 rounded-lg px-3 py-2 text-sm text-danger-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Info strip */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-start gap-3">
        <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
        <div className="text-xs text-blue-700 space-y-1">
          <p className="font-semibold">AI-powered extraction — always reviewed before saving</p>
          <p>The AI will detect recipe name, yield, ingredients, quantities, and units. You review and correct everything before it's added to your recipe.</p>
        </div>
      </div>
    </div>
  );
}

// ─── Summary Cards ────────────────────────────────────────────────────────────

function SummaryCards({ summary }: { summary: ImportSummary }) {
  const cards = [
    { label: "Extracted", value: summary.total, color: "text-neutral-800", bg: "bg-neutral-50 border-neutral-200" },
    { label: "Matched", value: summary.matched, color: "text-success-700", bg: "bg-success-50 border-success-200" },
    { label: "Needs Review", value: summary.needsReview, color: "text-warning-700", bg: "bg-warning-50 border-warning-200" },
    { label: "Unknown Items", value: summary.unknownIngredients, color: "text-danger-700", bg: "bg-danger-50 border-danger-200" },
    { label: "Unknown Units", value: summary.unknownUnits, color: "text-orange-700", bg: "bg-orange-50 border-orange-200" },
  ];

  return (
    <div className="grid grid-cols-5 gap-2">
      {cards.map((c) => (
        <div key={c.label} className={`rounded-xl border p-3 text-center ${c.bg}`}>
          <p className={`text-2xl font-bold ${c.color}`}>{c.value}</p>
          <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mt-0.5">{c.label}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Review Row Card (mobile-friendly expanded view) ─────────────────────────

function ReviewRowCard({
  row,
  inventory,
  onChange,
  onRemove,
}: {
  row: ReviewRow;
  inventory: any[];
  onChange: (updates: Partial<ReviewRow>) => void;
  onRemove: () => void;
}) {
  const [invSearch, setInvSearch] = useState("");

  const filteredInv = inventory.filter((i) =>
    !invSearch || i.name?.toLowerCase().includes(invSearch.toLowerCase())
  ).slice(0, 20);

  const statusClass = STATUS_COLORS[row.status];
  const needsReview = row.status !== "matched";

  return (
    <div className={`rounded-xl border bg-white shadow-sm ${needsReview ? "border-warning-200" : "border-neutral-200"}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-100">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-neutral-400 w-5">{row.lineNumber}.</span>
          <span className="text-sm font-bold text-neutral-900">{row.ingredientRaw}</span>
          {row.prepNote && (
            <span className="text-xs text-neutral-400 italic">({row.prepNote})</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${statusClass}`}>
            {STATUS_LABELS[row.status]}
          </span>
          <button
            onClick={onRemove}
            className="text-neutral-300 hover:text-danger-500 transition-colors p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Inventory item */}
        <div className="col-span-1 sm:col-span-2 lg:col-span-1">
          <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1.5">
            Inventory Item
          </label>
          {/* Search-filtered select */}
          <div className="relative">
            <div className="flex items-center gap-1 px-2 py-1.5 border border-neutral-200 rounded-lg bg-neutral-50 mb-1">
              <Search className="h-3.5 w-3.5 text-neutral-400 shrink-0" />
              <input
                type="text"
                placeholder="Filter items…"
                value={invSearch}
                onChange={(e) => setInvSearch(e.target.value)}
                className="flex-1 bg-transparent text-xs outline-none placeholder-neutral-400"
              />
            </div>
            <select
              value={row.resolvedInventoryId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                const item = inventory.find((i) => String(i.id) === id);
                onChange({
                  resolvedInventoryId: id,
                  resolvedUnit: id ? (item?.baseUnit || item?.unit || row.resolvedUnit) : row.resolvedUnit,
                  status: id
                    ? (row.canonicalUnit ? "matched" : "needs_unit")
                    : "needs_ingredient",
                  userResolved: true,
                });
              }}
              className={`w-full px-2 py-2 text-sm border rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 ${
                !row.resolvedInventoryId ? "border-danger-300" : "border-neutral-200"
              }`}
              size={4}
            >
              <option value="">— None / Skip —</option>
              {filteredInv.map((item: any) => (
                <option key={item.id} value={String(item.id)}>
                  {item.name} ({item.unit || item.baseUnit})
                </option>
              ))}
            </select>
          </div>
          {/* Suggestions chips */}
          {row.suggestions.length > 0 && !row.resolvedInventoryId && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              <span className="text-[10px] text-neutral-400 self-center">Suggestions:</span>
              {row.suggestions.slice(0, 3).map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    const item = inventory.find((i) => String(i.id) === s.id);
                    onChange({
                      resolvedInventoryId: s.id,
                      resolvedUnit: item?.baseUnit || item?.unit || row.resolvedUnit,
                      status: row.canonicalUnit ? "matched" : "needs_unit",
                      userResolved: true,
                    });
                  }}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-brand-100 text-brand-700 hover:bg-brand-200 transition-colors font-medium"
                >
                  {s.name} ({Math.round(s.score * 100)}%)
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Qty + Unit */}
        <div>
          <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1.5">
            Quantity
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              step="any"
              value={row.resolvedQty ?? ""}
              onChange={(e) => onChange({ resolvedQty: parseFloat(e.target.value) || null, userResolved: true })}
              placeholder={row.qtyRaw || "e.g. 250"}
              className={`flex-1 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 ${
                row.resolvedQty == null ? "border-danger-300 bg-danger-50" : "border-neutral-200"
              }`}
            />
            <select
              value={row.resolvedUnit ?? ""}
              onChange={(e) => onChange({ resolvedUnit: e.target.value || null, userResolved: true })}
              className={`w-28 px-2 py-2 text-sm border rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 ${
                !row.resolvedUnit ? "border-orange-300" : "border-neutral-200"
              }`}
            >
              <option value="">— unit —</option>
              {CANONICAL_UNITS.map((u) => (
                <option key={u.code} value={u.code}>{u.label}</option>
              ))}
            </select>
          </div>
          {row.unitWarning && (
            <p className="text-[10px] text-orange-600 mt-1 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {row.unitRaw} — needs mapping
            </p>
          )}
        </div>

        {/* Prep note + AI info */}
        <div>
          <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1.5">
            Prep Note
          </label>
          <input
            type="text"
            value={row.resolvedPrepNote}
            onChange={(e) => onChange({ resolvedPrepNote: e.target.value, userResolved: true })}
            placeholder="e.g. sliced, chopped…"
            className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[10px] text-neutral-400">
              AI raw: <span className="font-mono">{row.qtyRaw} {row.unitRaw}</span>
            </span>
            <span className={`text-[10px] font-semibold ${
              row.aiConfidence >= 0.85 ? "text-success-600"
              : row.aiConfidence >= 0.6 ? "text-warning-600"
              : "text-danger-600"
            }`}>
              {Math.round(row.aiConfidence * 100)}% confidence
            </span>
          </div>
        </div>
      </div>

      {/* Warning banners */}
      {row.warnings.map((w, i) => (
        <div key={i} className="mx-4 mb-4 flex items-start gap-2 bg-warning-50 border border-warning-200 rounded-lg px-3 py-2">
          <AlertCircle className="h-3.5 w-3.5 text-warning-600 shrink-0 mt-0.5" />
          <p className="text-[11px] text-warning-700">{w}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function AIRecipeImport({ isOpen, onClose, inventory, onConfirm }: AIRecipeImportProps) {
  const [step, setStep] = useState<Step>("upload");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<AiExtractionResult | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState("");

  // Recipe header (editable)
  const [header, setHeader] = useState<RecipeHeader>({
    name: "", category: "Mains", yieldQty: 1, yieldUnit: "kg", notes: "",
  });

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setStep("upload");
      setImageFile(null);
      setImagePreview(null);
      setExtraction(null);
      setRows([]);
      setError(null);
      setRequestId(`AIR-${Date.now()}`);
      setHeader({ name: "", category: "Mains", yieldQty: 1, yieldUnit: "kg", notes: "" });
    }
  }, [isOpen]);

  const handleFileReady = (file: File, preview: string) => {
    setImageFile(file);
    setImagePreview(preview);
  };

  const runExtraction = useCallback(async () => {
    if (!imageFile) return;
    setStep("extracting");
    setError(null);

    try {
      const userId = (() => {
        try { return JSON.parse(atob(localStorage.getItem("sb-session") || "") || "")?.user?.id; } catch { return null; }
      })();

      const form = new FormData();
      form.append("image", imageFile);
      form.append("requestId", requestId);
      if (userId) form.append("userId", userId);

      const res = await fetch("/api/ai-import/extract", { method: "POST", body: form });
      const json = await res.json();

      if (!json.success) {
        setError(json.error || "Extraction failed. Please try again.");
        setStep("upload");
        return;
      }

      const result: AiExtractionResult = json.data;
      setExtraction(result);

      // Pre-fill header from extraction
      setHeader({
        name: result.recipe_name || "",
        category: "Mains",
        yieldQty: (() => {
          const m = result.servings_or_yield?.match(/[\d.]+/);
          return m ? parseFloat(m[0]) : 1;
        })(),
        yieldUnit: (() => {
          const m = result.servings_or_yield?.match(/[a-zA-Z]+/);
          return m ? m[0] : "portions";
        })(),
        notes: result.notes || "",
      });

      // Build review rows with ingredient matching
      const reviewRows = buildReviewRows(result, inventory);
      setRows(reviewRows);
      setStep("review");

    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
      setStep("upload");
    }
  }, [imageFile, requestId, inventory]);

  const updateRow = (index: number, updates: Partial<ReviewRow>) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...updates };
      // Recompute status after user edit
      const r = next[index];
      if (!r.resolvedInventoryId) next[index].status = "needs_ingredient";
      else if (!r.resolvedUnit) next[index].status = "needs_unit";
      else if (r.resolvedQty == null) next[index].status = "missing_qty";
      else next[index].status = "matched";
      return next;
    });
  };

  const removeRow = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const addBlankRow = () => {
    setRows((prev) => [
      ...prev,
      {
        lineNumber: (prev[prev.length - 1]?.lineNumber ?? 0) + 1,
        ingredientRaw: "Manual Entry",
        qtyRaw: "", qtyNumeric: null,
        unitRaw: "", prepNote: "",
        aiConfidence: 1,
        canonicalUnit: null, unitAmbiguous: false, unitWarning: null,
        matchedInventoryId: null, matchedInventoryName: null,
        matchScore: 0, suggestions: [],
        status: "needs_ingredient",
        warnings: ["Manually added — please select inventory item and unit."],
        resolvedInventoryId: null, resolvedUnit: null,
        resolvedQty: null, resolvedPrepNote: "",
        userResolved: false,
      },
    ]);
  };

  const handleConfirm = () => {
    if (!header.name.trim()) {
      setError("Recipe name is required before confirming.");
      return;
    }
    const ingredients = reviewRowsToIngredients(rows, inventory);
    if (ingredients.length === 0) {
      setError("No rows have a matched inventory item. Please assign items before confirming.");
      return;
    }
    onConfirm(header, ingredients);
    setStep("done");
  };

  const summary = computeImportSummary(rows);

  /**
   * allConfirmableRows: rows that reviewRowsToIngredients() will actually include.
   * Condition: resolvedInventoryId != null (same filter as reviewRowsToIngredients).
   * qty and unit are coerced to safe defaults (1 / pcs) in reviewRowsToIngredients
   * so we do NOT require them here — that would silently disable the button while
   * the confirm handler would succeed.
   *
   * allReadyRows (perfect rows): all three fields set — used for the count display
   * text only, not for the disabled state.
   */
  const allConfirmableRows = rows.filter((r) => r.resolvedInventoryId != null);
  const hasUnresolved = rows.some((r) => !r.resolvedInventoryId);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="relative h-full w-full max-w-4xl bg-white shadow-2xl flex flex-col overflow-hidden">

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 bg-gradient-to-r from-brand-600 to-violet-600 text-white shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-white/20 flex items-center justify-center">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-bold text-lg leading-tight">AI Recipe Import</h2>
              <p className="text-white/70 text-xs">
                {step === "upload" && "Upload or photograph your recipe"}
                {step === "extracting" && "Analysing image…"}
                {step === "review" && `Review ${rows.length} extracted ingredients`}
                {step === "done" && "Import complete"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Step indicator */}
            <div className="hidden sm:flex items-center gap-1 text-xs text-white/70">
              {(["upload", "extracting", "review"] as Step[]).map((s, i) => (
                <span key={s} className="flex items-center gap-1">
                  <span className={`h-5 w-5 rounded-full flex items-center justify-center font-bold text-[10px] ${
                    step === s ? "bg-white text-brand-700"
                    : (["extracting","review","done"].indexOf(step) > ["upload","extracting","review"].indexOf(s))
                      ? "bg-white/40 text-white" : "bg-white/20 text-white/50"
                  }`}>{i + 1}</span>
                  {i < 2 && <ChevronRight className="h-3 w-3 text-white/40" />}
                </span>
              ))}
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/20 transition-colors">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* ── Body ───────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── UPLOAD STEP ──────────────────────────────────────────── */}
          {step === "upload" && (
            <div className="p-6 space-y-6">
              {imagePreview ? (
                <div className="space-y-4">
                  {/* Preview */}
                  <div className="relative rounded-2xl overflow-hidden border border-neutral-200 bg-neutral-100 max-h-64">
                    <img src={imagePreview} alt="Recipe preview" className="w-full h-full object-contain max-h-64" />
                    <button
                      onClick={() => { setImageFile(null); setImagePreview(null); }}
                      className="absolute top-3 right-3 p-1.5 bg-white/90 rounded-full shadow-md hover:bg-white transition"
                    >
                      <X className="h-4 w-4 text-neutral-700" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 bg-brand-50 border border-brand-200 rounded-xl px-4 py-3">
                    <Eye className="h-5 w-5 text-brand-500 shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-brand-900">Ready to extract</p>
                      <p className="text-xs text-brand-600">
                        {imageFile?.name} ({(imageFile!.size / 1024).toFixed(0)} KB)
                      </p>
                    </div>
                    <button
                      onClick={() => { setImageFile(null); setImagePreview(null); }}
                      className="text-xs text-brand-600 underline underline-offset-2 hover:text-brand-800"
                    >
                      Change
                    </button>
                  </div>
                  {error && (
                    <div className="flex items-center gap-2 bg-danger-50 border border-danger-200 rounded-lg px-3 py-2 text-sm text-danger-700">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      {error}
                    </div>
                  )}
                </div>
              ) : (
                <UploadZone onFileReady={handleFileReady} />
              )}
            </div>
          )}

          {/* ── EXTRACTING STEP ──────────────────────────────────────── */}
          {step === "extracting" && (
            <div className="flex flex-col items-center justify-center py-24 gap-6 px-6">
              <div className="relative h-20 w-20">
                <div className="absolute inset-0 rounded-full bg-gradient-to-br from-brand-400 to-violet-500 animate-pulse opacity-30" />
                <div className="h-20 w-20 rounded-full bg-gradient-to-br from-brand-500 to-violet-600 flex items-center justify-center">
                  <Sparkles className="h-10 w-10 text-white animate-spin" style={{ animationDuration: "3s" }} />
                </div>
              </div>
              <div className="text-center space-y-2">
                <p className="text-xl font-bold text-neutral-900">Analysing recipe image…</p>
                <p className="text-sm text-neutral-500 max-w-sm">
                  The AI is reading ingredient lines, quantities, and units from your image.
                  This usually takes 5–15 seconds.
                </p>
              </div>
              {imagePreview && (
                <img src={imagePreview} alt="Uploaded recipe" className="rounded-xl border border-neutral-200 max-h-32 object-contain opacity-60" />
              )}
            </div>
          )}

          {/* ── REVIEW STEP ──────────────────────────────────────────── */}
          {step === "review" && (
            <div className="p-6 space-y-6">
              {/* Summary cards */}
              <SummaryCards summary={summary} />

              {/* Image + header side-by-side */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Image preview */}
                {imagePreview && (
                  <div className="rounded-xl border border-neutral-200 overflow-hidden bg-neutral-50">
                    <img src={imagePreview} alt="Uploaded recipe" className="w-full h-48 object-contain" />
                  </div>
                )}

                {/* Recipe header editor */}
                <div className={`${imagePreview ? "lg:col-span-2" : "lg:col-span-3"} space-y-3`}>
                  <div>
                    <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">Recipe Name</label>
                    <input
                      type="text"
                      value={header.name}
                      onChange={(e) => setHeader((h) => ({ ...h, name: e.target.value }))}
                      placeholder="Recipe name…"
                      className="w-full px-3 py-2 text-sm font-semibold border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">Category</label>
                      <select
                        value={header.category}
                        onChange={(e) => setHeader((h) => ({ ...h, category: e.target.value }))}
                        className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                      >
                        {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">Yield Qty</label>
                      <input
                        type="number" min={0} step="any"
                        value={header.yieldQty}
                        onChange={(e) => setHeader((h) => ({ ...h, yieldQty: parseFloat(e.target.value) || 1 }))}
                        className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">Yield Unit</label>
                      <input
                        type="text"
                        value={header.yieldUnit}
                        onChange={(e) => setHeader((h) => ({ ...h, yieldUnit: e.target.value }))}
                        placeholder="portions, kg, L…"
                        className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider block mb-1">Recipe Notes</label>
                    <textarea
                      rows={2}
                      value={header.notes}
                      onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none"
                    />
                  </div>
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="flex items-center gap-2 bg-danger-50 border border-danger-200 rounded-lg px-3 py-2 text-sm text-danger-700">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {error}
                </div>
              )}

              {/* Unresolved warnings banner */}
              {hasUnresolved && (
                <div className="flex items-start gap-3 bg-warning-50 border border-warning-200 rounded-xl px-4 py-3">
                  <ShieldAlert className="h-5 w-5 text-warning-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-warning-800">Some rows need attention</p>
                    <p className="text-xs text-warning-600 mt-0.5">
                      {summary.unknownIngredients} item{summary.unknownIngredients !== 1 ? "s" : ""} have no inventory match.
                      Rows without a matched item will be excluded from the final recipe.
                      Assign them below or remove them.
                    </p>
                  </div>
                </div>
              )}

              {/* Review rows */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-neutral-900">
                    Ingredient Review
                    <span className="ml-2 text-sm text-neutral-400 font-normal">({rows.length} lines)</span>
                  </h3>
                  <button
                    onClick={addBlankRow}
                    className="flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:text-brand-900 px-3 py-1.5 border border-brand-200 rounded-lg hover:bg-brand-50 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Row
                  </button>
                </div>

                {rows.map((row, idx) => (
                  <ReviewRowCard
                    key={`${row.lineNumber}-${idx}`}
                    row={row}
                    inventory={inventory}
                    onChange={(updates) => updateRow(idx, updates)}
                    onRemove={() => removeRow(idx)}
                  />
                ))}

                {rows.length === 0 && (
                  <div className="text-center py-10 text-neutral-400 text-sm border border-dashed border-neutral-200 rounded-xl">
                    No rows — add one manually or re-run extraction.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── DONE STEP ────────────────────────────────────────────── */}
          {step === "done" && (
            <div className="flex flex-col items-center justify-center py-24 gap-6 px-6">
              <div className="h-20 w-20 rounded-full bg-success-100 flex items-center justify-center">
                <CheckCircle2 className="h-10 w-10 text-success-600" />
              </div>
              <div className="text-center space-y-2">
                <p className="text-xl font-bold text-neutral-900">Import Complete!</p>
                <p className="text-sm text-neutral-500 max-w-sm">
                  {allConfirmableRows.length} ingredient{allConfirmableRows.length !== 1 ? "s" : ""} have been added to the recipe builder.
                  Review and save your recipe.
                </p>
              </div>
              <button
                onClick={onClose}
                className="px-6 py-3 bg-brand-600 text-white font-semibold rounded-xl hover:bg-brand-700 transition-colors"
              >
                Go to Recipe Builder
              </button>
            </div>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        {step !== "done" && (
          <div className="shrink-0 border-t border-neutral-200 bg-white px-6 py-4 flex items-center justify-between gap-4">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors"
            >
              Cancel
            </button>

            <div className="flex items-center gap-3">
              {/* Re-run button — on review step */}
              {step === "review" && (
                <button
                  onClick={() => { setStep("upload"); }}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors"
                >
                  <RotateCcw className="h-4 w-4" />
                  Re-upload
                </button>
              )}

              {/* Primary action */}
              {step === "upload" && (
                <button
                  onClick={runExtraction}
                  disabled={!imageFile}
                  className="flex items-center gap-2 px-6 py-2.5 text-sm font-semibold bg-gradient-to-r from-brand-600 to-violet-600 text-white rounded-xl shadow-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Zap className="h-4 w-4" />
                  Extract with AI
                </button>
              )}

              {step === "extracting" && (
                <button disabled className="flex items-center gap-2 px-6 py-2.5 text-sm font-semibold bg-brand-400 text-white rounded-xl cursor-not-allowed opacity-70">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Extracting…
                </button>
              )}

              {step === "review" && (
                <button
                  onClick={handleConfirm}
                  disabled={allConfirmableRows.length === 0}
                  className="flex items-center gap-2 px-6 py-2.5 text-sm font-semibold bg-gradient-to-r from-success-600 to-success-700 text-white rounded-xl shadow-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Confirm &amp; Add to Recipe ({allConfirmableRows.length} item{allConfirmableRows.length !== 1 ? "s" : ""})
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
