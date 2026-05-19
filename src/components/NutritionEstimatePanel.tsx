"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import {
  NUTRITION_DISCLAIMER,
  derivePerYieldUnit,
  deriveTotalFromPerYieldUnit,
  normalizeMacroSet,
  type NutritionEstimate,
  type NutritionMacroSet,
} from "@/lib/aiNutrition";

const MACROS: Array<{
  key: keyof NutritionMacroSet;
  label: string;
  unit: string;
}> = [
  { key: "calories", label: "Calories", unit: "kcal" },
  { key: "protein_g", label: "Protein", unit: "g" },
  { key: "fat_g", label: "Fat", unit: "g" },
  { key: "carbs_g", label: "Carbs", unit: "g" },
  { key: "fibre_g", label: "Fibre", unit: "g" },
  { key: "sodium_mg", label: "Sodium", unit: "mg" },
];

const confidenceClasses = {
  high: "bg-emerald-50 text-emerald-700 border-emerald-200",
  medium: "bg-warning-50 text-warning-700 border-warning-200",
  low: "bg-danger-50 text-danger-700 border-danger-200",
};

function toDisplayNumber(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(1)) : 0;
}

interface NutritionEstimatePanelProps {
  estimate: NutritionEstimate;
  yieldQty: number;
  yieldUnit: string;
  isSaving?: boolean;
  onChange: (estimate: NutritionEstimate) => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function NutritionEstimatePanel({
  estimate,
  yieldQty,
  yieldUnit,
  isSaving = false,
  onChange,
  onDiscard,
  onSave,
}: NutritionEstimatePanelProps) {
  const [draft, setDraft] = useState<NutritionEstimate>(estimate);

  useEffect(() => {
    setDraft(estimate);
  }, [estimate]);

  const effectiveYieldQty = Number(yieldQty) > 0 ? Number(yieldQty) : 1;
  const effectiveYieldUnit = yieldUnit || draft.yield_unit || "unit";

  const updateDraft = (next: NutritionEstimate) => {
    setDraft(next);
    onChange(next);
  };

  const updateTotal = (key: keyof NutritionMacroSet, value: string) => {
    const total = normalizeMacroSet({ ...draft.total, [key]: Number(value) });
    updateDraft({
      ...draft,
      source: draft.source ?? "manual",
      total,
      per_yield_unit: derivePerYieldUnit(total, effectiveYieldQty),
      yield_qty: effectiveYieldQty,
      yield_unit: effectiveYieldUnit,
      disclaimer: draft.disclaimer || NUTRITION_DISCLAIMER,
    });
  };

  const updatePerYieldUnit = (key: keyof NutritionMacroSet, value: string) => {
    const perYieldUnit = normalizeMacroSet({ ...draft.per_yield_unit, [key]: Number(value) });
    updateDraft({
      ...draft,
      source: draft.source ?? "manual",
      total: deriveTotalFromPerYieldUnit(perYieldUnit, effectiveYieldQty),
      per_yield_unit: perYieldUnit,
      yield_qty: effectiveYieldQty,
      yield_unit: effectiveYieldUnit,
      disclaimer: draft.disclaimer || NUTRITION_DISCLAIMER,
    });
  };

  const disclaimer = draft.disclaimer || NUTRITION_DISCLAIMER;
  const confidenceClass = confidenceClasses[draft.confidence] ?? confidenceClasses.medium;

  const assumptions = useMemo(() => draft.assumptions?.filter(Boolean) ?? [], [draft.assumptions]);
  const warnings = useMemo(() => draft.warnings?.filter(Boolean) ?? [], [draft.warnings]);

  return (
    <div className="bg-white border border-warning-200 rounded-xl shadow-sm overflow-hidden">
      <div className="bg-warning-50 border-b border-warning-200 p-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-warning-600 mt-0.5 shrink-0" />
          <p className="text-sm font-semibold text-warning-800">{disclaimer}</p>
        </div>
        <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-1 rounded-full border ${confidenceClass}`}>
          {draft.confidence} confidence
        </span>
      </div>

      <div className="p-4 space-y-4">
        <div className="grid grid-cols-[1fr_120px_120px] gap-2 items-center text-[10px] uppercase tracking-wider font-bold text-neutral-500">
          <span>Macro</span>
          <span className="text-right">Total Recipe</span>
          <span className="text-right">Per {effectiveYieldUnit}</span>
        </div>

        <div className="space-y-2">
          {MACROS.map((macro) => (
            <div key={macro.key} className="grid grid-cols-[1fr_120px_120px] gap-2 items-center">
              <div>
                <p className="text-sm font-semibold text-neutral-900">{macro.label}</p>
                <p className="text-[10px] text-neutral-400 uppercase">{macro.unit}</p>
              </div>
              <input
                type="number"
                min="0"
                step="0.1"
                value={toDisplayNumber(draft.total?.[macro.key] ?? 0)}
                onChange={(e) => updateTotal(macro.key, e.target.value)}
                className="w-full p-2 border border-neutral-200 rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <input
                type="number"
                min="0"
                step="0.1"
                value={toDisplayNumber(draft.per_yield_unit?.[macro.key] ?? 0)}
                onChange={(e) => updatePerYieldUnit(macro.key, e.target.value)}
                className="w-full p-2 border border-neutral-200 rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          ))}
        </div>

        {(assumptions.length > 0 || warnings.length > 0) && (
          <div className="grid gap-3 pt-2 border-t border-neutral-100">
            {assumptions.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-neutral-500 mb-1">Assumptions</p>
                <ul className="space-y-1">
                  {assumptions.map((item, idx) => (
                    <li key={`${item}-${idx}`} className="text-xs text-neutral-600">- {item}</li>
                  ))}
                </ul>
              </div>
            )}
            {warnings.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-danger-500 mb-1">Warnings</p>
                <ul className="space-y-1">
                  {warnings.map((item, idx) => (
                    <li key={`${item}-${idx}`} className="text-xs text-danger-600">- {item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-neutral-100">
          <button
            type="button"
            onClick={onDiscard}
            disabled={isSaving}
            className="px-3 py-2 text-sm font-semibold bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <X className="h-3.5 w-3.5" />
            Discard
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={isSaving}
            className="px-3 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-60 inline-flex items-center gap-1.5"
          >
            {isSaving ? (
              <span className="h-3.5 w-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {isSaving ? "Saving…" : "Save Nutrition to Recipe"}
          </button>
        </div>
      </div>
    </div>
  );
}
