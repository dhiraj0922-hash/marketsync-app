"use client";

/**
 * InventoryEditDrawer
 * -------------------
 * A fully self-contained Edit-Item drawer that can be mounted in ANY page
 * (inventory list, recipe map, finished-goods, etc.) without lifting state.
 *
 * Props:
 *   item     — the inventory row to edit (null = drawer closed)
 *   onClose  — called when the drawer should close (no save)
 *   onSaved  — called with the updated inventory row after a successful save
 *              The caller should patch its local inventory[] state so costs
 *              recompute immediately without a DB round-trip.
 *
 * Internally replicates the full Edit Item flow from inventory/page.tsx:
 *   • name / type / category / base unit
 *   • purchase units (ordering) with primary radio
 *   • cost / base unit (seeded from preferred purchase_option)
 *   • preferred supplier summary (read-only display, derived from purchase_options)
 *   • structured packaging accordion (optional)
 *   • full suppliers / purchase_options CRUD:
 *       - inline edit of all fields per row
 *       - make preferred → updates cost immediately
 *       - delete row
 *       - add new supplier row
 */

import { useState, useEffect, useRef } from "react";
import { Drawer } from "@/components/ui/drawer";
import {
  saveInventory,
  loadPurchaseOptions,
  savePurchaseOptions,
  insertPurchaseOptions,
  deletePurchaseOption,
  loadSuppliers,
} from "@/lib/storage";
import { Plus, Save, Trash2, Loader2 } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface InventoryEditDrawerProps {
  /** Inventory item to edit. Pass null to close the drawer. */
  item: any | null;
  /** Called when the drawer closes without saving. */
  onClose: () => void;
  /**
   * Called after a successful save with the fully updated inventory row.
   * The caller should do:
   *   setInventory(prev => prev.map(i => i.id === updated.id ? updated : i))
   * so calculateCost() picks up new pricing on the next render.
   */
  onSaved: (updatedItem: any) => void;
  /** Optional list of category strings for the category <select>. */
  categories?: string[];
}

// ─── SupplierCombobox ─────────────────────────────────────────────────────────
// Searchable combobox for picking an existing supplier name or typing a new one.
// - suggestions: deduplicated alphabetical list (from suppliers master + purchase_options)
// - value / onChange: controlled by parent
// - Normalization: name.trim().replace(/\s+/g, ' ') on selection
// - Free-text fallback: any typed value that doesn't match a suggestion is accepted as-is

interface SupplierComboboxProps {
  value: string;
  suggestions: string[];
  onChange: (name: string) => void;
}

function SupplierCombobox({ value, suggestions, onChange }: SupplierComboboxProps) {
  const [query,   setQuery]   = useState(value);
  const [open,    setOpen]    = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep internal query in sync when parent resets the form
  useEffect(() => { setQuery(value); }, [value]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        // Commit whatever is typed as free-text when the user clicks away
        const normalized = query.trim().replace(/\s+/g, ' ');
        if (normalized !== value) onChange(normalized);
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, query, value, onChange]);

  const normalize = (s: string) => s.trim().replace(/\s+/g, ' ');

  const filtered = suggestions.filter(s =>
    s.toLowerCase().includes(query.toLowerCase())
  );

  const select = (name: string) => {
    const n = normalize(name);
    setQuery(n);
    onChange(n);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered.length > 0 && filtered[0].toLowerCase() === query.toLowerCase()) {
        select(filtered[0]);
      } else {
        // Free-text confirmation
        select(query);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          type="text"
          value={query}
          placeholder="Supplier Co."
          onFocus={() => setOpen(true)}
          onChange={e => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="w-full px-2 py-1 border border-violet-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-violet-500 bg-white"
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(''); onChange(''); setOpen(true); }}
            className="text-neutral-400 hover:text-neutral-700 shrink-0 text-[10px] font-bold leading-none px-1"
            tabIndex={-1}
            title="Clear"
          >✕</button>
        )}
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-0.5 z-[80] bg-white border border-violet-200 rounded shadow-lg max-h-44 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-neutral-400 italic">
              No match — press Enter to use "{query}"
            </div>
          ) : (
            filtered.map(name => (
              <button
                key={name}
                type="button"
                onMouseDown={e => { e.preventDefault(); select(name); }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-violet-50 ${
                  normalize(name) === normalize(query) ? 'bg-violet-50 font-semibold text-violet-800' : 'text-neutral-800'
                }`}
              >
                {name}
              </button>
            ))
          )}
          {/* Always show a "use exactly what I typed" option when query doesn't exactly match */}
          {query.trim() && !filtered.some(s => normalize(s) === normalize(query)) && (
            <button
              type="button"
              onMouseDown={e => { e.preventDefault(); select(query); }}
              className="w-full text-left px-3 py-1.5 text-[11px] text-violet-600 font-semibold border-t border-violet-100 hover:bg-violet-50"
            >
              + Add "{normalize(query)}"
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function InventoryEditDrawer({
  item,
  onClose,
  onSaved,
  categories = [],
}: InventoryEditDrawerProps) {
  // ── Local edit state ─────────────────────────────────────────────────────
  const [editItem,       setEditItem]       = useState<any>(null);
  const [editBaseUnit,   setEditBaseUnit]   = useState("");
  const [editPurchaseCost, setEditPurchaseCost] = useState("");

  // Structured packaging fields
  const [editPurchaseUom,    setEditPurchaseUom]    = useState("");
  const [editPackQty,        setEditPackQty]        = useState("");
  const [editInnerUnitType,  setEditInnerUnitType]  = useState("");
  const [editInnerUnitSize,  setEditInnerUnitSize]  = useState("");
  const [editInnerUnitUom,   setEditInnerUnitUom]   = useState("");
  const [editBaseUomNew,     setEditBaseUomNew]     = useState("");
  const [editAllowedUoms,    setEditAllowedUoms]    = useState("");

  // Purchase options (suppliers)
  const [purchaseOptions,    setPurchaseOptions]    = useState<any[]>([]);
  const [isLoadingOpts,      setIsLoadingOpts]      = useState(false);
  const [isSavingPurchOpt,   setIsSavingPurchOpt]   = useState<string | null>(null);
  const [addingPurchOpt,     setAddingPurchOpt]     = useState(false);
  const [newPurchOpt,        setNewPurchOpt]        = useState<any>({
    supplierName: "", supplierProductName: "",
    purchaseUom: "ea", packQty: "", packUom: "",
    unitPrice: "", isPreferred: false,
  });

  // Supplier name suggestions (for the combobox)
  const [supplierSuggestions, setSupplierSuggestions] = useState<string[]>([]);

  // Save state
  const [isSaving, setIsSaving] = useState(false);

  // ── Seed state whenever a new item is passed ─────────────────────────────
  // Load supplier suggestions once when the drawer first opens
  useEffect(() => {
    loadSuppliers()
      .then((suppliers: any[]) => {
        setSupplierSuggestions(prev => {
          const fromMaster = suppliers.map((s: any) => (s.name ?? '').trim()).filter(Boolean);
          const merged = Array.from(new Set([...fromMaster, ...prev])).sort((a, b) => a.localeCompare(b));
          return merged;
        });
      })
      .catch(() => { /* non-fatal — free-text still works */ });
  }, []); // once on mount

  useEffect(() => {
    if (!item) {
      setEditItem(null);
      return;
    }
    const copy = JSON.parse(JSON.stringify(item));
    setEditItem(copy);
    setEditBaseUnit(item.baseUnit || item.unit || "");
    setEditPurchaseCost(
      item.purchaseCost != null ? String(item.purchaseCost)
        : item.cost     != null ? String(item.cost)
        : ""
    );
    setEditPurchaseUom(item.purchaseUom ?? "");
    setEditPackQty(item.packQty != null ? String(item.packQty) : "");
    setEditInnerUnitType(item.innerUnitType ?? "");
    setEditInnerUnitSize(item.innerUnitSize != null ? String(item.innerUnitSize) : "");
    setEditInnerUnitUom(item.innerUnitUom ?? "");
    setEditBaseUomNew(item.baseUomNew ?? "");
    setEditAllowedUoms(
      Array.isArray(item.allowedRecipeUoms) ? item.allowedRecipeUoms.join(", ") : ""
    );
    setAddingPurchOpt(false);
    setNewPurchOpt({
      supplierName: "", supplierProductName: "",
      purchaseUom: "ea", packQty: "", packUom: "",
      unitPrice: "", isPreferred: false,
    });

    // Load purchase_options fresh from DB
    console.log('[InventoryEditDrawer] opening item — id:', item.id, '| typeof id:', typeof item.id);
    setIsLoadingOpts(true);
    loadPurchaseOptions(String(item.id))
      .then((rows: any[]) => {
        console.log('[InventoryEditDrawer] loadPurchaseOptions returned', rows.length, 'rows for id:', String(item.id), rows);
        setPurchaseOptions(rows);
        // Also add any supplier names from purchase_options to suggestions
        const fromOpts = rows.map((r: any) => (r.supplierName ?? '').trim()).filter(Boolean);
        if (fromOpts.length > 0) {
          setSupplierSuggestions(prev => {
            const merged = Array.from(new Set([...prev, ...fromOpts])).sort((a, b) => a.localeCompare(b));
            return merged;
          });
        }
        // Seed cost from preferred ?? lowest if available
        const preferred = rows.find((r: any) => r.isPreferred);
        const lowest    = rows.length > 0
          ? [...rows].sort((a: any, b: any) => a.unitPrice - b.unitPrice)[0]
          : null;
        const chosen    = preferred ?? lowest ?? null;
        if (chosen) setEditPurchaseCost(String(chosen.unitPrice));
      })
      .catch((err: any) => {
        console.error('[InventoryEditDrawer] loadPurchaseOptions THREW:', err);
        alert(`[Bug 1] Failed to load suppliers: ${err?.message ?? String(err)}`);
        setPurchaseOptions([]);
      })
      .finally(() => setIsLoadingOpts(false));
  }, [item?.id]); // re-run only when the selected item changes

  // ── Purchase option helpers ────────────────────────────────────────────
  const updatePurchOptField = (id: string, field: string, value: any) =>
    setPurchaseOptions((prev: any[]) =>
      prev.map((r: any) => r.id === id ? { ...r, [field]: value } : r)
    );

  const savePurchOpt = async (row: any) => {
    setIsSavingPurchOpt(row.id);
    try {
      const res = await savePurchaseOptions([row]);
      if (!res.success) alert(`Save failed: ${(res as any).error?.message ?? "Unknown"}`);
    } finally {
      setIsSavingPurchOpt(null);
    }
  };

  const makePreferred = async (id: string) => {
    const updated = purchaseOptions.map((r: any) => ({ ...r, isPreferred: r.id === id }));
    setPurchaseOptions(updated);
    const chosen = updated.find((r: any) => r.id === id);
    if (chosen) setEditPurchaseCost(String(chosen.unitPrice));
    const res = await savePurchaseOptions(updated);
    if (!res.success) alert(`Could not update preferred: ${(res as any).error?.message ?? ""}`);
  };

  const deletePurchOpt = async (id: string) => {
    if (!confirm("Remove this supplier row?")) return;
    const deletedRow = purchaseOptions.find((r: any) => r.id === id);
    const res = await deletePurchaseOption(id);
    if (res.success) {
      const remaining = purchaseOptions.filter((r: any) => r.id !== id);
      setPurchaseOptions(remaining);
      if (deletedRow?.isPreferred) {
        const newPref = remaining.find((r: any) => r.isPreferred);
        const lowest  = remaining.length > 0
          ? [...remaining].sort((a: any, b: any) => a.unitPrice - b.unitPrice)[0]
          : null;
        const fallback = newPref?.unitPrice ?? lowest?.unitPrice ?? null;
        setEditPurchaseCost(fallback !== null ? String(fallback) : "");
      }
    } else {
      alert(`Delete failed: ${(res as any).error?.message ?? "Unknown"}`);
    }
  };

  const commitNewPurchOpt = async () => {
    if (!editItem) return;
    if (!newPurchOpt.supplierName.trim()) { alert("Supplier name is required."); return; }

    const payload = {
      ...newPurchOpt,
      inventoryItemId: String(editItem.id),
      packQty:   newPurchOpt.packQty   !== "" ? Number(newPurchOpt.packQty)   : null,
      unitPrice: newPurchOpt.unitPrice !== "" ? Number(newPurchOpt.unitPrice) : 0,
    };
    console.log('[InventoryEditDrawer] commitNewPurchOpt — insert payload:', payload);

    try {
      const res = await insertPurchaseOptions([payload]);
      console.log('[InventoryEditDrawer] insertPurchaseOptions result:', res);
      if (!res.success) {
        const msg = (res as any).error?.message ?? JSON.stringify((res as any).error);
        console.error('[InventoryEditDrawer] insert FAILED:', msg);
        alert(`[Bug 2] Insert failed: ${msg}`);
        return;
      }

      // Re-fetch to pick up DB-generated id + any server-side defaults
      const rows = await loadPurchaseOptions(String(editItem.id));
      console.log('[InventoryEditDrawer] post-insert re-fetch:', rows.length, 'rows:', rows);
      if (rows.length === 0) {
        // Re-fetch returned empty — expose this so we can diagnose further
        console.warn('[InventoryEditDrawer] re-fetch returned 0 rows after successful insert — possible type mismatch on inventory_item_id');
        alert(`[Bug 2] Insert succeeded but re-fetch returned 0 rows. Check console for details.`);
      }
      setPurchaseOptions(rows);
      const preferred = rows.find((r: any) => r.isPreferred);
      const lowest    = rows.length > 0 ? [...rows].sort((a: any, b: any) => a.unitPrice - b.unitPrice)[0] : null;
      const syncPrice = preferred?.unitPrice ?? lowest?.unitPrice ?? null;
      if (syncPrice !== null) setEditPurchaseCost(String(syncPrice));
      setAddingPurchOpt(false);
      setNewPurchOpt({
        supplierName: "", supplierProductName: "", purchaseUom: "ea",
        packQty: "", packUom: "", unitPrice: "", isPreferred: false,
      });
    } catch (err: any) {
      console.error('[InventoryEditDrawer] commitNewPurchOpt threw:', err);
      alert(`[Bug 2] Unexpected error: ${err?.message ?? String(err)}`);
    }
  };

  // ── Save handler ────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!editItem) return;
    if (!editItem.name?.trim()) { alert("Item name is required."); return; }
    if (isSaving) return;
    setIsSaving(true);
    try {
      // Resolve purchase units
      let pUnits = editItem.purchaseUnits
        ? JSON.parse(JSON.stringify(editItem.purchaseUnits))
        : [];
      pUnits = pUnits
        .map((u: any) => ({ ...u, conversion: parseFloat(u.conversion) }))
        .filter((u: any) => u.name?.trim());
      if (pUnits.length > 0 && !pUnits.some((u: any) => u.isPrimary)) pUnits[0].isPrimary = true;

      const primaryUnit    = pUnits.find((u: any) => u.isPrimary) || pUnits[0];
      const hasValidPrim   = primaryUnit && primaryUnit.name && primaryUnit.conversion > 0;
      const parsedCost     = parseFloat(editPurchaseCost);
      const baseCost       = hasValidPrim && !isNaN(parsedCost)
        ? parsedCost / primaryUnit.conversion
        : (!isNaN(parsedCost) ? parsedCost : editItem.cost);
      const purchCost      = hasValidPrim && !isNaN(parsedCost) ? parsedCost : null;

      // Preferred supplier summary
      const _prefRow = purchaseOptions.find((r: any) => r.isPreferred);
      const _lowRow  = purchaseOptions.length > 0
        ? [...purchaseOptions].sort((a: any, b: any) => a.unitPrice - b.unitPrice)[0]
        : null;
      const _chosen  = _prefRow ?? _lowRow ?? null;

      const updated = {
        ...editItem,
        baseUnit:      editBaseUnit || editItem.unit || "",
        unit:          editBaseUnit || editItem.unit || "",
        purchaseUnits: pUnits,
        cost:          baseCost,
        purchaseCost:  purchCost,
        updatedAt:     Date.now(),
        // Packaging
        purchaseUom:       editPurchaseUom.trim()  || null,
        packQty:           editPackQty !== ""       ? Number(editPackQty)       : null,
        innerUnitType:     editInnerUnitType.trim() || null,
        innerUnitSize:     editInnerUnitSize !== "" ? Number(editInnerUnitSize) : null,
        innerUnitUom:      editInnerUnitUom.trim()  || null,
        baseUomNew:        editBaseUomNew.trim()    || null,
        allowedRecipeUoms: editAllowedUoms.trim()
          ? editAllowedUoms.split(",").map((s: string) => s.trim()).filter(Boolean)
          : null,
        // Preferred supplier summary (keep in sync with purchase_options)
        preferredSupplierName: _chosen?.supplierName ?? null,
        preferredCost:         _chosen?.unitPrice    ?? null,
      };

      // We don't have the full inventoryData array here, so we pass a single-item array.
      // saveInventory does an upsert so only the provided row's fields are updated.
      const res = await saveInventory([updated]);
      if (!res?.success) {
        alert(`Save failed: ${res?.error?.message ?? JSON.stringify(res?.error)}`);
        return;
      }

      onSaved(updated);
      onClose();
    } catch (err: any) {
      alert(err?.message ?? "Unexpected error saving item.");
    } finally {
      setIsSaving(false);
    }
  };

  // ── Derived display values ─────────────────────────────────────────────
  const preferredOpt  = purchaseOptions.find((p: any) => p.isPreferred);
  const lowestOpt     = purchaseOptions.length > 0
    ? purchaseOptions.reduce((min: any, p: any) => p.unitPrice < min.unitPrice ? p : min)
    : null;
  const primaryUnit   = editItem?.purchaseUnits?.find((u: any) => u.isPrimary)
    || editItem?.purchaseUnits?.[0];
  const hasPrimary    = primaryUnit && primaryUnit.name && parseFloat(primaryUnit.conversion) > 0;
  const costLabel     = preferredOpt
    ? `Cost — from ${preferredOpt.supplierName}`
    : lowestOpt
      ? `Cost — lowest (${lowestOpt.supplierName})`
      : hasPrimary
        ? `Cost / ${primaryUnit.name}`
        : "Cost / Base Unit";

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <Drawer
      isOpen={!!item}
      onClose={onClose}
      title="Edit Item"
      description={editItem ? `Editing: ${editItem.name}` : ""}
      footer={
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 flex-1 text-sm font-medium bg-neutral-100 text-neutral-700 border border-neutral-200 rounded-lg hover:bg-neutral-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className={`px-4 py-2 flex-1 text-sm font-medium rounded-lg transition-colors shadow-sm flex items-center justify-center gap-2 ${
              isSaving
                ? "bg-neutral-400 cursor-not-allowed text-white"
                : "bg-brand-600 text-white hover:bg-brand-700"
            }`}
          >
            {isSaving
              ? <><div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving...</>
              : <><Save className="h-4 w-4" /> Save Changes</>}
          </button>
        </div>
      }
    >
      {editItem && (
        <div className="space-y-4">

          {/* ── Name ──────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Item Name *</label>
            <input
              type="text"
              value={editItem.name}
              onChange={e => setEditItem({ ...editItem, name: e.target.value })}
              className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="e.g. Garlic Powder"
            />
          </div>

          {/* ── Type / Category / Base Unit ───────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Type</label>
              <select
                value={editItem.itemType || "Raw"}
                onChange={e => setEditItem({ ...editItem, itemType: e.target.value })}
                className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
              >
                <option value="Raw">Raw Asset</option>
                <option value="Preparation">Preparation</option>
                <option value="Finished Good">Finished Good</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Category</label>
              {categories.length > 0 ? (
                <select
                  value={editItem.category}
                  onChange={e => setEditItem({ ...editItem, category: e.target.value })}
                  className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                >
                  {categories.map((c: string) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  value={editItem.category || ""}
                  onChange={e => setEditItem({ ...editItem, category: e.target.value })}
                  className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                  placeholder="e.g. Produce"
                />
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Base Unit</label>
              <input
                type="text"
                value={editBaseUnit}
                onChange={e => setEditBaseUnit(e.target.value)}
                className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                placeholder="kg, L, ea…"
              />
            </div>
          </div>

          {/* ── Purchase Units ────────────────────────────────────────── */}
          <div className="space-y-2 border border-neutral-200 p-3 rounded-lg bg-neutral-50">
            <label className="text-xs font-semibold text-neutral-900 uppercase flex justify-between">
              Purchase Units (Ordering)
              <button
                onClick={() =>
                  setEditItem({
                    ...editItem,
                    purchaseUnits: [
                      ...(editItem.purchaseUnits || []),
                      { name: "", conversion: 1, isPrimary: !(editItem.purchaseUnits?.length) },
                    ],
                  })
                }
                className="text-brand-600 hover:text-brand-700 font-bold flex items-center gap-1"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </label>
            {(!editItem.purchaseUnits || editItem.purchaseUnits.length === 0) ? (
              <div className="text-xs text-neutral-500 italic py-1">No purchase units — falls back to base unit.</div>
            ) : editItem.purchaseUnits.map((pu: any, idx: number) => (
              <div key={idx} className="flex gap-2 items-center bg-white p-2 rounded border border-neutral-200">
                <input
                  type="radio" name="edit_primary_unit_ied" checked={pu.isPrimary}
                  onChange={() => {
                    const copy = [...editItem.purchaseUnits];
                    copy.forEach((u: any) => u.isPrimary = false);
                    copy[idx].isPrimary = true;
                    setEditItem({ ...editItem, purchaseUnits: copy });
                  }}
                  className="w-4 h-4 text-brand-600"
                />
                <input
                  type="text" value={pu.name}
                  onChange={e => {
                    const copy = [...editItem.purchaseUnits];
                    copy[idx].name = e.target.value;
                    setEditItem({ ...editItem, purchaseUnits: copy });
                  }}
                  className="flex-1 py-1.5 px-2 border border-neutral-200 rounded text-sm outline-none focus:border-brand-500"
                  placeholder="e.g. Case"
                />
                <span className="text-xs text-neutral-500">=</span>
                <input
                  type="number" min="0" step="0.01" value={pu.conversion}
                  onChange={e => {
                    const copy = [...editItem.purchaseUnits];
                    copy[idx].conversion = e.target.value;
                    setEditItem({ ...editItem, purchaseUnits: copy });
                  }}
                  className="w-20 py-1.5 px-2 border border-neutral-200 rounded text-sm outline-none focus:border-brand-500"
                  placeholder="Qty"
                />
                <span className="text-xs text-neutral-500 w-8 truncate">{editBaseUnit || "base"}</span>
                <button
                  onClick={() => {
                    const copy = editItem.purchaseUnits.filter((_: any, i: number) => i !== idx);
                    if (pu.isPrimary && copy.length > 0) copy[0].isPrimary = true;
                    setEditItem({ ...editItem, purchaseUnits: copy });
                  }}
                  className="p-1.5 text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          {/* ── Preferred Supplier (derived display) ─────────────────── */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Preferred Supplier</label>
            <div className={`w-full p-2 border rounded text-sm flex items-center justify-between gap-2 ${
              preferredOpt ? "border-violet-300 bg-violet-50" : "border-neutral-200 bg-neutral-50"
            }`}>
              <span className={preferredOpt ? "font-semibold text-violet-800" : "text-neutral-400 italic"}>
                {preferredOpt
                  ? preferredOpt.supplierName
                  : purchaseOptions.length > 0
                    ? "None set — click Make Preferred below"
                    : "No suppliers yet"}
              </span>
              {preferredOpt && (
                <span className="text-[10px] font-bold uppercase text-violet-600 bg-violet-100 border border-violet-300 px-1.5 py-0.5 rounded whitespace-nowrap">★ Preferred</span>
              )}
              {!preferredOpt && lowestOpt && (
                <span className="text-[10px] text-neutral-400">(lowest: {lowestOpt.supplierName})</span>
              )}
            </div>
            {preferredOpt?.supplierProductName && (
              <p className="text-[11px] text-neutral-500">
                {preferredOpt.supplierProductName} · {preferredOpt.purchaseUom}
                {preferredOpt.packQty ? ` · ${preferredOpt.packQty}${preferredOpt.packUom ? " " + preferredOpt.packUom : ""}` : ""}
              </p>
            )}
          </div>

          {/* ── Stock / Par / Cost ────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Current Stock</label>
              <input
                type="number" step="any"
                value={editItem.inStock}
                onChange={e => setEditItem({ ...editItem, inStock: e.target.value })}
                className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Par Level</label>
              <input
                type="number" step="any"
                value={editItem.parLevel}
                onChange={e => setEditItem({ ...editItem, parLevel: e.target.value })}
                className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">{costLabel}</label>
              <input
                type="number" step="0.01"
                value={editPurchaseCost}
                onChange={e => setEditPurchaseCost(e.target.value)}
                className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                placeholder="$0.00"
              />
              {preferredOpt && (
                <p className="text-[10px] text-violet-500">Price from preferred supplier. Edit to override.</p>
              )}
            </div>
          </div>

          {/* ── Structured Packaging (accordion) ─────────────────────── */}
          <details className="group border border-neutral-200 rounded-lg bg-neutral-50 shadow-sm">
            <summary className="flex items-center justify-between px-3 py-2.5 cursor-pointer select-none list-none">
              <span className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">Structured Packaging</span>
              <span className="text-[10px] text-neutral-400 font-medium group-open:hidden">Optional — pack-based costing</span>
              <span className="text-[10px] text-brand-600 font-medium hidden group-open:inline">Hide</span>
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Purchase UOM</label>
                  <select value={editPurchaseUom} onChange={e => setEditPurchaseUom(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                    <option value="">— not set —</option>
                    <option>case</option><option>bag</option><option>box</option>
                    <option>bottle</option><option>can</option><option>pack</option><option>ea</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Pack Qty</label>
                  <input type="number" min="0" step="1" value={editPackQty} onChange={e => setEditPackQty(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. 12" />
                  <p className="text-[10px] text-neutral-400">Inner units per pack</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner Type</label>
                  <select value={editInnerUnitType} onChange={e => setEditInnerUnitType(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                    <option value="">— not set —</option>
                    <option>can</option><option>bottle</option><option>bag</option><option>ea</option><option>portion</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner Size</label>
                  <input type="number" min="0" step="any" value={editInnerUnitSize} onChange={e => setEditInnerUnitSize(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. 330" />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner UOM</label>
                  <select value={editInnerUnitUom} onChange={e => setEditInnerUnitUom(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                    <option value="">— not set —</option>
                    <option value="ml">ml</option><option value="l">l</option>
                    <option value="g">g</option><option value="kg">kg</option>
                    <option value="oz">oz</option><option value="lb">lb</option>
                    <option value="fl oz">fl oz</option><option value="ea">ea</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Base UOM (Costing)</label>
                <select value={editBaseUomNew} onChange={e => setEditBaseUomNew(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                  <option value="">— same as Base Unit above —</option>
                  <option value="ml">ml</option><option value="l">l</option>
                  <option value="g">g</option><option value="kg">kg</option>
                  <option value="oz">oz</option><option value="lb">lb</option>
                  <option value="fl oz">fl oz</option><option value="ea">ea</option>
                </select>
                <p className="text-[10px] text-neutral-400">Overrides Base Unit for recipe costing.</p>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Allowed Recipe UOMs</label>
                <input type="text" value={editAllowedUoms} onChange={e => setEditAllowedUoms(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="ml, l, fl oz (comma-separated)" />
                <p className="text-[10px] text-neutral-400">Soft warning only — does not block recipe saving.</p>
              </div>
            </div>
          </details>

          {/* ── Suppliers / Purchase Options ─────────────────────────── */}
          <div className="space-y-1 border border-neutral-200 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-neutral-50 border-b border-neutral-200">
              <span className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                Suppliers ({purchaseOptions.length})
              </span>
              <button
                type="button"
                onClick={() => setAddingPurchOpt(true)}
                className="flex items-center gap-1 text-xs font-semibold text-violet-600 hover:text-violet-800"
              >
                <Plus className="h-3 w-3" /> Add Supplier
              </button>
            </div>

            {/* Loading */}
            {isLoadingOpts && (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-neutral-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading suppliers…
              </div>
            )}

            {/* Empty */}
            {!isLoadingOpts && purchaseOptions.length === 0 && (
              <p className="text-xs text-neutral-400 italic px-3 py-3">No suppliers yet. Click "+ Add Supplier" to add one.</p>
            )}

            {/* Supplier rows */}
            {purchaseOptions.map((row: any) => (
              <div
                key={row.id}
                className={`px-3 py-2.5 border-b border-neutral-100 last:border-b-0 ${row.isPreferred ? "bg-violet-50" : "bg-white"}`}
              >
                {/* Row header */}
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    {row.isPreferred && (
                      <span className="text-[10px] font-bold uppercase text-violet-700 bg-violet-100 border border-violet-300 px-1.5 py-0.5 rounded whitespace-nowrap">★ Preferred</span>
                    )}
                    <span className="text-xs font-semibold text-neutral-800 truncate">{row.supplierName || "—"}</span>
                    {row.supplierProductName && (
                      <span className="text-xs text-neutral-400 truncate">({row.supplierProductName})</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {!row.isPreferred && (
                      <button
                        type="button"
                        onClick={() => makePreferred(row.id)}
                        className="text-[10px] px-2 py-0.5 rounded border border-violet-200 text-violet-600 hover:bg-violet-50 whitespace-nowrap"
                      >
                        Make Preferred
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => savePurchOpt(row)}
                      disabled={isSavingPurchOpt === row.id}
                      title="Save changes to this row"
                      className="p-1 text-brand-600 hover:bg-brand-50 rounded disabled:opacity-40"
                    >
                      {isSavingPurchOpt === row.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Save className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePurchOpt(row.id)}
                      title="Delete this supplier row"
                      className="p-1 text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Editable fields */}
                <div className="grid grid-cols-2 gap-2 mb-1.5">
                  <div>
                    <label className="text-[10px] text-neutral-400 font-semibold uppercase block mb-0.5">Supplier Name</label>
                    <input type="text" value={row.supplierName} onChange={e => updatePurchOptField(row.id, "supplierName", e.target.value)} className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400" />
                  </div>
                  <div>
                    <label className="text-[10px] text-neutral-400 font-semibold uppercase block mb-0.5">Product Name</label>
                    <input type="text" value={row.supplierProductName ?? ""} onChange={e => updatePurchOptField(row.id, "supplierProductName", e.target.value || null)} className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400" placeholder="Optional" />
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div>
                    <label className="text-[10px] text-neutral-400 font-semibold uppercase block mb-0.5">Purchase UOM</label>
                    <input type="text" value={row.purchaseUom} onChange={e => updatePurchOptField(row.id, "purchaseUom", e.target.value)} className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400" />
                  </div>
                  <div>
                    <label className="text-[10px] text-neutral-400 font-semibold uppercase block mb-0.5">Pack Qty</label>
                    <input type="number" min="0" step="any" value={row.packQty ?? ""} onChange={e => updatePurchOptField(row.id, "packQty", e.target.value !== "" ? Number(e.target.value) : null)} className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400" />
                  </div>
                  <div>
                    <label className="text-[10px] text-neutral-400 font-semibold uppercase block mb-0.5">Pack UOM</label>
                    <input type="text" value={row.packUom ?? ""} onChange={e => updatePurchOptField(row.id, "packUom", e.target.value || null)} className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400" />
                  </div>
                  <div>
                    <label className="text-[10px] text-neutral-400 font-semibold uppercase block mb-0.5">Unit Price ($)</label>
                    <input type="number" min="0" step="0.01" value={row.unitPrice} onChange={e => updatePurchOptField(row.id, "unitPrice", parseFloat(e.target.value) || 0)} className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400" />
                  </div>
                </div>
              </div>
            ))}

            {/* Add new supplier inline form */}
            {addingPurchOpt && (
              <div className="px-3 py-3 space-y-2 bg-violet-50 border-t border-violet-200">
                <p className="text-xs font-semibold text-violet-700">New Supplier Row</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-neutral-500 font-semibold uppercase block mb-0.5">Supplier Name *</label>
                    <SupplierCombobox
                      value={newPurchOpt.supplierName}
                      suggestions={supplierSuggestions}
                      onChange={name => setNewPurchOpt((p: any) => ({ ...p, supplierName: name }))}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-neutral-500 font-semibold uppercase block mb-0.5">Product Name</label>
                    <input type="text" value={newPurchOpt.supplierProductName} onChange={e => setNewPurchOpt((p: any) => ({ ...p, supplierProductName: e.target.value }))} className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-violet-400" placeholder="Optional" />
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div>
                    <label className="text-[10px] text-neutral-500 font-semibold uppercase block mb-0.5">Purchase UOM</label>
                    <input type="text" value={newPurchOpt.purchaseUom} onChange={e => setNewPurchOpt((p: any) => ({ ...p, purchaseUom: e.target.value }))} className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-violet-400" placeholder="case" />
                  </div>
                  <div>
                    <label className="text-[10px] text-neutral-500 font-semibold uppercase block mb-0.5">Pack Qty</label>
                    <input type="number" min="0" step="any" value={newPurchOpt.packQty} onChange={e => setNewPurchOpt((p: any) => ({ ...p, packQty: e.target.value }))} className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-violet-400" placeholder="12" />
                  </div>
                  <div>
                    <label className="text-[10px] text-neutral-500 font-semibold uppercase block mb-0.5">Pack UOM</label>
                    <input type="text" value={newPurchOpt.packUom} onChange={e => setNewPurchOpt((p: any) => ({ ...p, packUom: e.target.value }))} className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-violet-400" placeholder="ea" />
                  </div>
                  <div>
                    <label className="text-[10px] text-neutral-500 font-semibold uppercase block mb-0.5">Unit Price ($)</label>
                    <input type="number" min="0" step="0.01" value={newPurchOpt.unitPrice} onChange={e => setNewPurchOpt((p: any) => ({ ...p, unitPrice: e.target.value }))} className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-violet-400" placeholder="0.00" />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-neutral-600 cursor-pointer">
                    <input type="checkbox" checked={newPurchOpt.isPreferred} onChange={e => setNewPurchOpt((p: any) => ({ ...p, isPreferred: e.target.checked }))} className="rounded" />
                    Set as preferred
                  </label>
                  <div className="flex-1" />
                  <button type="button" onClick={() => setAddingPurchOpt(false)} className="px-3 py-1 text-xs font-medium bg-neutral-100 text-neutral-600 rounded hover:bg-neutral-200">Cancel</button>
                  <button type="button" onClick={commitNewPurchOpt} className="px-3 py-1 text-xs font-bold bg-violet-600 text-white rounded hover:bg-violet-700">Add Row</button>
                </div>
              </div>
            )}
          </div>
          {/* ── end Suppliers ─────────────────────────────────────────── */}

        </div>
      )}
    </Drawer>
  );
}
