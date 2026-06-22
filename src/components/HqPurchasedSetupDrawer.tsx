"use client";

/**
 * HqPurchasedSetupDrawer
 * ──────────────────────
 * Promotes a single outlet_catalog_items row from local_vendor → hq_supplied
 * by linking it to an existing hq_sale_items row and activating that sale item.
 *
 * Safety guarantees:
 *   • No stock is created or changed.
 *   • No recipe is created or linked.
 *   • No requisition_items rows are modified.
 *   • All writes run inside a single atomic DB transaction via RPC
 *     (setup_hq_purchased_item). Either both tables update or neither does.
 *   • All historical requisitions referencing the catalog item remain untouched.
 */

import { useState, useEffect, useCallback } from "react";
import {
  X,
  Warehouse,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Search,
  ChevronDown,
  ShoppingBag,
  Info,
  Package,
} from "lucide-react";
import {
  type SaleItem,
  type OutletCatalogItem,
  loadOutletCatalogItemById,
  setupHqPurchasedItem,
} from "@/lib/storage";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  isOpen:      boolean;
  onClose:     () => void;
  /** The hq_sale_item that triggered this setup (pre-fills the form) */
  hqItem:      SaleItem | null;
  /** Full list of HQ Sale Items — lets admin pick a different one if needed */
  allHqItems:  SaleItem[];
  /** Full supplier master — for the supplier dropdown */
  suppliers:   any[];
  /** Called after the atomic RPC succeeds so the parent can refresh */
  onSuccess:   () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const UNIT_OPTIONS = ["pack", "ea", "kg", "g", "L", "ml", "pcs", "box", "bag", "bottle"];

// ─── Component ────────────────────────────────────────────────────────────────

export function HqPurchasedSetupDrawer({
  isOpen,
  onClose,
  hqItem,
  allHqItems,
  suppliers,
  onSuccess,
}: Props) {
  // ── HQ Sale Item selection ─────────────────────────────────────────────────
  const [selectedHqItemId, setSelectedHqItemId] = useState<string>("");
  const [hqItemSearch, setHqItemSearch]         = useState<string>("");
  const [showHqPicker, setShowHqPicker]         = useState<boolean>(false);

  // ── Catalog Item input ─────────────────────────────────────────────────────
  const [catalogItemId, setCatalogItemId]       = useState<string>("");
  const [catalogItem, setCatalogItem]           = useState<OutletCatalogItem | null>(null);
  const [catalogLoading, setCatalogLoading]     = useState<boolean>(false);
  const [catalogError, setCatalogError]         = useState<string | null>(null);

  // ── Editable form fields ───────────────────────────────────────────────────
  const [formName, setFormName]                 = useState<string>("");
  const [formSupplier, setFormSupplier]         = useState<string>("");
  const [formUnit, setFormUnit]                 = useState<string>("pack");
  const [formPackQty, setFormPackQty]           = useState<number>(1);
  const [formPrice, setFormPrice]               = useState<string>("");
  const [formActive, setFormActive]             = useState<boolean>(true);
  const [formRequisitionable, setFormRequisitionable] = useState<boolean>(true);

  // ── Validation + submit state ──────────────────────────────────────────────
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting]         = useState<boolean>(false);
  const [submitError, setSubmitError]           = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess]       = useState<boolean>(false);

  // ── Derived ────────────────────────────────────────────────────────────────
  const selectedHqItem = allHqItems.find(i => i.id === selectedHqItemId) ?? null;
  const hqFcSuppliers  = suppliers.filter((s: any) => s.fulfillmentModel === "hq_fulfillment_centre");

  // ── Reset on open/close ───────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    // Pre-fill from hqItem prop if provided
    const item = hqItem;
    setSelectedHqItemId(item?.id ?? "");
    setHqItemSearch(item?.name ?? "");
    setShowHqPicker(false);
    setCatalogItemId("");
    setCatalogItem(null);
    setCatalogError(null);
    setFormName(item?.name ?? "");
    setFormSupplier(item?.sourceCommissary ?? "");
    setFormUnit(item?.baseUnit ?? "pack");
    setFormPackQty(item?.packQty ?? 1);
    setFormPrice(item?.manualPrice != null && item.manualPrice > 0
      ? item.manualPrice.toFixed(2)
      : "");
    setFormActive(true);
    setFormRequisitionable(true);
    setValidationErrors([]);
    setSubmitError(null);
    setSubmitSuccess(false);
  }, [isOpen, hqItem]);

  // ── Sync form name/supplier when HQ item selection changes ────────────────
  useEffect(() => {
    if (!selectedHqItem) return;
    setFormName(selectedHqItem.name);
    setFormSupplier(selectedHqItem.sourceCommissary ?? "");
    setFormUnit(selectedHqItem.baseUnit ?? "pack");
    setFormPackQty(selectedHqItem.packQty ?? 1);
    if (selectedHqItem.manualPrice != null && selectedHqItem.manualPrice > 0) {
      setFormPrice(selectedHqItem.manualPrice.toFixed(2));
    }
  }, [selectedHqItem]);

  // ── Catalog item lookup ───────────────────────────────────────────────────
  const lookupCatalogItem = useCallback(async (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) { setCatalogItem(null); setCatalogError(null); return; }
    setCatalogLoading(true);
    setCatalogError(null);
    const row = await loadOutletCatalogItemById(trimmed);
    setCatalogLoading(false);
    if (!row) {
      setCatalogError(`No catalog item found with ID "${trimmed}".`);
      setCatalogItem(null);
    } else if (row.sourceType === "hq_supplied" && row.hqSaleItemId) {
      setCatalogError(`This catalog item is already linked to HQ Sale Item "${row.hqSaleItemId}". No change needed.`);
      setCatalogItem(row);
    } else {
      setCatalogItem(row);
    }
  }, []);

  // ── Validate (synchronous) ────────────────────────────────────────────────
  const validate = useCallback((): string[] => {
    const errs: string[] = [];
    if (!selectedHqItemId) errs.push("Select an HQ Sale Item to link to.");
    if (!catalogItem)      errs.push("Enter and verify a Catalog Item ID.");
    if (catalogItem?.sourceType === "hq_supplied" && catalogItem.hqSaleItemId)
      errs.push("This catalog item is already linked. No action required.");
    if (!formName.trim())  errs.push("Item name cannot be blank.");
    if (!formSupplier)     errs.push("Select a supplier.");
    if (!formUnit.trim())  errs.push("Select a stock unit.");
    if (formPackQty < 1 || !Number.isInteger(formPackQty))
      errs.push("Pack quantity must be a whole number ≥ 1.");
    const price = parseFloat(formPrice);
    if (isNaN(price) || price <= 0)
      errs.push("Price charged to locations must be a positive number.");
    return errs;
  }, [selectedHqItemId, catalogItem, formName, formSupplier, formUnit, formPackQty, formPrice]);

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    const errs = validate();
    setValidationErrors(errs);
    if (errs.length > 0 || !catalogItem || !selectedHqItemId) return;

    setIsSubmitting(true);
    setSubmitError(null);

    // Single atomic RPC — locking, validation, and both writes happen inside
    // one PostgreSQL transaction. No partial state is possible.
    const result = await setupHqPurchasedItem({
      hqSaleItem: {
        id:               selectedHqItemId,
        name:             formName.trim(),
        baseUnit:         formUnit.trim(),
        packQty:          formPackQty,
        manualPrice:      parseFloat(formPrice),
        sourceCommissary: formSupplier,
        isActive:         formActive,
        isRequisitionable: formRequisitionable,
      },
      catalogItemId: catalogItem.itemId,
    });

    setIsSubmitting(false);

    if (!result.success) {
      // The RPC rolled back entirely — no partial changes.
      setSubmitError(
        (result.error?.message ?? "Setup failed.") +
        " The transaction was rolled back — no changes were made."
      );
      return;
    }

    setSubmitSuccess(true);
    setTimeout(() => {
      onSuccess();
      onClose();
    }, 1800);
  };

  if (!isOpen) return null;

  // ── Filtered HQ item list ─────────────────────────────────────────────────
  const filteredHqItems = allHqItems.filter(i => {
    if (!hqItemSearch.trim()) return true;
    const q = hqItemSearch.toLowerCase();
    return i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q);
  });

  const price = parseFloat(formPrice);
  const canSubmit =
    !isSubmitting &&
    !submitSuccess &&
    validate().length === 0 &&
    !(catalogItem?.sourceType === "hq_supplied" && catalogItem.hqSaleItemId);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-200 bg-gradient-to-r from-blue-600 to-blue-700 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-white/20 p-2">
              <Warehouse className="h-5 w-5 text-white" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Set Up as HQ Purchased Item</h2>
              <p className="text-xs text-blue-100">
                Link a catalog item to an HQ Sale Item. Stock stays at zero until delivery.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-white/70 hover:bg-white/10 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Success state */}
        {submitSuccess && (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
            <div className="rounded-full bg-green-100 p-4">
              <CheckCircle2 className="h-10 w-10 text-green-600" />
            </div>
            <h3 className="text-lg font-bold text-neutral-900">Setup Complete</h3>
            <p className="text-center text-sm text-neutral-600">
              <strong>{catalogItem?.name}</strong> is now linked to{" "}
              <strong>{formName}</strong> and routed through HQ fulfillment.
              Refreshing data…
            </p>
          </div>
        )}

        {/* Form */}
        {!submitSuccess && (
          <div className="flex-1 overflow-y-auto">
            <div className="space-y-5 p-6">

              {/* ─── HQ Sale Item selector ─────────────────────────────── */}
              <section className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-700">
                  HQ Sale Item <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <div
                    className="flex cursor-pointer items-center justify-between rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm hover:border-blue-400 transition-colors"
                    onClick={() => setShowHqPicker(!showHqPicker)}
                  >
                    {selectedHqItem ? (
                      <div>
                        <span className="font-medium text-neutral-900">{selectedHqItem.name}</span>
                        <span className="ml-2 font-mono text-[11px] text-neutral-400">{selectedHqItem.id}</span>
                      </div>
                    ) : (
                      <span className="text-neutral-400">Search and select an HQ Sale Item…</span>
                    )}
                    <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" />
                  </div>
                  {showHqPicker && (
                    <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg border border-neutral-200 bg-white shadow-xl">
                      <div className="border-b border-neutral-100 p-2">
                        <div className="flex items-center gap-2 rounded-md bg-neutral-50 px-3 py-1.5">
                          <Search className="h-3.5 w-3.5 text-neutral-400" />
                          <input
                            autoFocus
                            className="flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
                            placeholder="Search by name or ID…"
                            value={hqItemSearch}
                            onChange={e => setHqItemSearch(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {filteredHqItems.length === 0 && (
                          <p className="px-4 py-3 text-xs text-neutral-400">No items match.</p>
                        )}
                        {filteredHqItems.map(item => (
                          <button
                            key={item.id}
                            onClick={() => {
                              setSelectedHqItemId(item.id);
                              setHqItemSearch(item.name);
                              setShowHqPicker(false);
                            }}
                            className={`flex w-full items-start gap-2 px-4 py-2.5 text-left text-sm hover:bg-blue-50 transition-colors ${
                              item.id === selectedHqItemId ? "bg-blue-50 font-medium" : ""
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-neutral-900 truncate">{item.name}</p>
                              <p className="text-[10px] text-neutral-400 font-mono">{item.id} · {item.baseUnit} · stock: {item.instock}</p>
                            </div>
                            {item.id === selectedHqItemId && (
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-blue-600" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {selectedHqItem && (
                  <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                    <span className="font-semibold">Current state:</span>{" "}
                    stock={selectedHqItem.instock} · active={selectedHqItem.isActive ? "yes" : "no"} ·
                    requisitionable={selectedHqItem.isRequisitionable ? "yes" : "no"} ·
                    commissary={selectedHqItem.sourceCommissary || "—"}
                  </div>
                )}
              </section>

              {/* ─── Catalog item to link ──────────────────────────────── */}
              <section className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-700">
                  Outlet Catalog Item ID to link <span className="text-red-500">*</span>
                </label>
                <p className="text-[11px] text-neutral-400">
                  Enter the exact <code className="font-mono bg-neutral-100 px-1 rounded">item_id</code> from
                  the outlet catalog (e.g. <code className="font-mono bg-neutral-100 px-1 rounded">LOC-MPSFEN1B-PWG</code>).
                </p>
                <div className="flex gap-2">
                  <input
                    className="flex-1 rounded-lg border border-neutral-200 px-3 py-2 font-mono text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors"
                    placeholder="LOC-XXXXXXXX"
                    value={catalogItemId}
                    onChange={e => {
                      setCatalogItemId(e.target.value);
                      setCatalogItem(null);
                      setCatalogError(null);
                    }}
                  />
                  <button
                    onClick={() => lookupCatalogItem(catalogItemId)}
                    disabled={catalogLoading || !catalogItemId.trim()}
                    className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 transition-colors"
                  >
                    {catalogLoading
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Search className="h-3.5 w-3.5" />}
                    Verify
                  </button>
                </div>
                {catalogError && (
                  <p className="flex items-center gap-1.5 text-xs text-red-600">
                    <AlertTriangle className="h-3 w-3 shrink-0" /> {catalogError}
                  </p>
                )}
                {catalogItem && !catalogError && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 space-y-0.5">
                    <p className="text-xs font-semibold text-emerald-800">
                      ✓ Found: {catalogItem.name}
                    </p>
                    <p className="text-[11px] text-emerald-700">
                      Current: <span className="font-mono">{catalogItem.sourceType}</span> ·
                      supplier: {catalogItem.supplier ?? "—"} ·
                      price: ${catalogItem.price.toFixed(2)} ·
                      hq_sale_item_id: {catalogItem.hqSaleItemId ?? "null"}
                    </p>
                    <p className="text-[11px] font-semibold text-emerald-800">
                      → Will become: <span className="font-mono">hq_supplied</span>, linked to {selectedHqItemId || "selected HQ item"}
                    </p>
                  </div>
                )}
              </section>

              {/* ─── Setup fields ──────────────────────────────────────── */}
              <section className="space-y-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-600 flex items-center gap-2">
                  <Package className="h-3.5 w-3.5" /> HQ Sale Item Settings
                </h3>

                {/* Supplier */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                    Supplier (HQ receives from) <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={formSupplier}
                    onChange={e => setFormSupplier(e.target.value)}
                    className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors"
                  >
                    <option value="">— select supplier —</option>
                    {hqFcSuppliers.map((s: any) => (
                      <option key={s.id} value={s.name}>{s.name}</option>
                    ))}
                    {/* Fallback: if no HQ FC suppliers loaded, show common names */}
                    {hqFcSuppliers.length === 0 && (
                      <>
                        <option value="Veggie Paradise">Veggie Paradise</option>
                        <option value="Momo Loco">Momo Loco</option>
                      </>
                    )}
                  </select>
                </div>

                {/* Item name */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                    HQ Item Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    value={formName}
                    onChange={e => setFormName(e.target.value)}
                    className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors"
                    placeholder="e.g. Pav Bun 12 pcs per pack"
                  />
                </div>

                {/* Unit + Pack qty */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                      Stock Unit <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={formUnit}
                      onChange={e => setFormUnit(e.target.value)}
                      className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors"
                    >
                      {UNIT_OPTIONS.map(u => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                      Pack Qty <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={formPackQty}
                      onChange={e => setFormPackQty(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors"
                    />
                    <p className="text-[10px] text-neutral-400">
                      Number of units HQ holds per pack (1 = sealed unit)
                    </p>
                  </div>
                </div>

                {/* Price */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                    Price charged to locations (per pack) <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400">$</span>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={formPrice}
                      onChange={e => setFormPrice(e.target.value)}
                      className="w-full rounded-lg border border-neutral-200 bg-white py-2 pl-7 pr-3 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 transition-colors"
                      placeholder="0.00"
                    />
                  </div>
                  {!isNaN(price) && price > 0 && (
                    <p className="text-[11px] text-neutral-500">
                      Cost per {formUnit}: ${price.toFixed(2)} ·
                      Pack qty: {formPackQty} ·
                      Pack value: ${(price * formPackQty).toFixed(2)}
                    </p>
                  )}
                </div>

                {/* Active / Requisitionable */}
                <div className="flex items-center gap-6 pt-1">
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
                    <div
                      onClick={() => setFormActive(!formActive)}
                      className={`relative h-5 w-9 rounded-full transition-colors ${
                        formActive ? "bg-blue-600" : "bg-neutral-300"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                          formActive ? "translate-x-4" : "translate-x-0.5"
                        }`}
                      />
                    </div>
                    Active
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
                    <div
                      onClick={() => setFormRequisitionable(!formRequisitionable)}
                      className={`relative h-5 w-9 rounded-full transition-colors ${
                        formRequisitionable ? "bg-blue-600" : "bg-neutral-300"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                          formRequisitionable ? "translate-x-4" : "translate-x-0.5"
                        }`}
                      />
                    </div>
                    Requisitionable
                  </label>
                </div>
              </section>

              {/* ─── Safety notice (always visible, non-dismissible) ────── */}
              <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Info className="h-4 w-4 shrink-0 text-amber-600" />
                  <p className="text-xs font-bold text-amber-800">What this action does:</p>
                </div>
                <ul className="space-y-1 pl-6 text-xs text-amber-800 list-disc">
                  <li>Activates the selected HQ Sale Item with the settings above.</li>
                  <li>
                    Changes the catalog item{" "}
                    <strong>{catalogItem?.name || "(pending)"}</strong> from{" "}
                    <code className="font-mono text-[10px] bg-amber-100 px-1 rounded">local_vendor</code> →{" "}
                    <code className="font-mono text-[10px] bg-amber-100 px-1 rounded">hq_supplied</code>.
                  </li>
                  <li>Links it so future requisitions carry <code className="font-mono text-[10px] bg-amber-100 px-1 rounded">finished_good_id</code>.</li>
                </ul>
                <div className="border-t border-amber-200 pt-2 space-y-1">
                  <p className="text-xs font-bold text-amber-800">What it does NOT do:</p>
                  <ul className="space-y-1 pl-6 text-xs text-amber-700 list-disc">
                    <li>Does <strong>not</strong> create or add stock — stock stays at zero.</li>
                    <li>Does <strong>not</strong> create a recipe.</li>
                    <li>Does <strong>not</strong> modify any old requisition lines or history.</li>
                    <li>Does <strong>not</strong> touch any other catalog items.</li>
                  </ul>
                </div>
                <p className="text-[11px] text-amber-600 italic">
                  Receive stock via the Deliveries / Stock-In module after setup is complete.
                </p>
              </section>

              {/* ─── Validation errors ─────────────────────────────────── */}
              {validationErrors.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 space-y-1">
                  {validationErrors.map((e, i) => (
                    <p key={i} className="flex items-center gap-1.5 text-xs text-red-700">
                      <AlertTriangle className="h-3 w-3 shrink-0" /> {e}
                    </p>
                  ))}
                </div>
              )}

              {/* ─── Submit error ──────────────────────────────────────── */}
              {submitError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                  <p className="flex items-start gap-1.5 text-xs text-red-700">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    {submitError}
                  </p>
                </div>
              )}

            </div>
          </div>
        )}

        {/* Footer */}
        {!submitSuccess && (
          <div className="border-t border-neutral-200 bg-white px-6 py-4">
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 rounded-lg border border-neutral-200 bg-white py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
                  canSubmit
                    ? "bg-blue-600 text-white hover:bg-blue-700 shadow-sm"
                    : "bg-neutral-200 text-neutral-400 cursor-not-allowed"
                }`}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Setting up…
                  </>
                ) : (
                  <>
                    <ShoppingBag className="h-4 w-4" />
                    Confirm Setup
                  </>
                )}
              </button>
            </div>
            <p className="mt-2 text-center text-[10px] text-neutral-400">
              One atomic database transaction. Either both tables update or neither does.
              Stock, recipes, and history are not affected.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
