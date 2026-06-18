"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin } from "@/lib/roles";
import {
  loadOutletCatalog, upsertOutletCatalogItem, deactivateOutletCatalogItem,
  activateOutletCatalogItem, loadSaleItems, bulkUpsertOutletCatalogItems,
  loadSuppliers, findOutletCatalogItemByNormalized,
  loadLocations, assignCatalogItemsToLocations,
  type OutletCatalogItem, type SaleItem, type AssignCatalogResult,
} from "@/lib/storage";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { isActiveLocation } from "@/lib/locationRegistry";
import {
  BookOpen, Plus, Search, Edit2, ToggleLeft, ToggleRight, Upload,
  Download, CheckCircle2, X, RefreshCw, AlertCircle, Package, Store, MapPin, Loader2,
} from "lucide-react";
import * as XLSX from "xlsx";

// ── Source badge ──────────────────────────────────────────────────────────────
function SrcBadge({ src }: { src: "hq_supplied" | "local_vendor" }) {
  return src === "hq_supplied"
    ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-50 text-violet-700 border border-violet-200">HQ Supplied</span>
    : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-50 text-teal-700 border border-teal-200">Local Vendor</span>;
}

const EMPTY_FORM: OutletCatalogItem = {
  itemId: "", name: "", category: "", uom: "", type: "Inventory item",
  sourceType: "local_vendor", hqSaleItemId: null,
  supplier: "", supplierId: null,
  purchaseOption: null, productCode: null, scanBarcode: null,
  price: 0, taxRate: 0, packQty: 1, orderingEnabled: true,
  isActive: true,
};

function LocationCatalogContent() {
  const { user } = useAuth();
  const hq = isHqAdmin(user);

  const [catalog, setCatalog] = useState<OutletCatalogItem[]>([]);
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [srcFilter, setSrcFilter] = useState<"all" | "hq_supplied" | "local_vendor">("all");
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Drawer (edit/create)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<OutletCatalogItem | null>(null);
  const [form, setForm] = useState<OutletCatalogItem>(EMPTY_FORM);
  const [formErr, setFormErr] = useState<string | null>(null);

  // Import
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ succeeded: number; failed: number; errors: string[] } | null>(null);

  // Assign to locations
  const [assignDrawerOpen, setAssignDrawerOpen] = useState(false);
  const [assignItem, setAssignItem] = useState<OutletCatalogItem | null>(null);
  const [assignSelectedLocs, setAssignSelectedLocs] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const [assignResult, setAssignResult] = useState<AssignCatalogResult | null>(null);

  // Bulk select
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkAssignResult, setBulkAssignResult] = useState<AssignCatalogResult | null>(null);

  // Active non-HQ locations
  const activeLocations = locations.filter(l => isActiveLocation(l) && l.type !== 'hq');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cat, si, supps, locs] = await Promise.all([
        loadOutletCatalog(true, user),
        loadSaleItems(),
        loadSuppliers(),
        loadLocations(),
      ]);
      setCatalog(Array.isArray(cat) ? cat : []);
      setSaleItems(Array.isArray(si) ? si : []);
      setSuppliers(Array.isArray(supps) ? supps : []);
      setLocations(Array.isArray(locs) ? locs : []);
    } finally { setLoading(false); }
  }, [user]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); } }, [toast]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return catalog.filter(i => {
      if (srcFilter !== "all" && i.sourceType !== srcFilter) return false;
      if (q && !i.name.toLowerCase().includes(q) && !(i.category ?? "").toLowerCase().includes(q) && !(i.supplier ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [catalog, search, srcFilter]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, itemId: `LOC-${Date.now().toString(36).toUpperCase()}` });
    setFormErr(null);
    setDrawerOpen(true);
  };

  const openEdit = (item: OutletCatalogItem) => {
    setEditing(item);
    setForm({
      itemId: item.itemId, name: item.name, category: item.category ?? "",
      uom: item.uom ?? "", type: item.type, sourceType: item.sourceType,
      hqSaleItemId: item.hqSaleItemId,
      supplier: item.supplier ?? "", supplierId: item.supplierId ?? null,
      purchaseOption: item.purchaseOption, productCode: item.productCode,
      scanBarcode: item.scanBarcode, price: item.price, taxRate: item.taxRate,
      packQty: item.packQty, orderingEnabled: item.orderingEnabled,
      isActive: item.isActive,
    });
    setFormErr(null);
    setDrawerOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setFormErr("Item name is required."); return; }
    if (!form.itemId.trim()) { setFormErr("Item ID is required."); return; }
    setSaving(true);
    const res = await upsertOutletCatalogItem(form);
    setSaving(false);
    if (!res.success) { setFormErr(res.error?.message ?? "Save failed."); return; }
    setDrawerOpen(false);
    setToast(`"${form.name}" saved to Location Catalog.`);
    await load();
  };

  const handleToggleActive = async (item: OutletCatalogItem) => {
    if (item.isActive) {
      if (!confirm(`Deactivate "${item.name}" from the Location Catalog? It will no longer appear in Add From Catalog for any location.`)) return;
      const res = await deactivateOutletCatalogItem(item.itemId);
      if (res.success) {
        setToast(`"${item.name}" deactivated.`);
      } else {
        alert(`Failed to deactivate: ${res.error?.message ?? "unknown error"}`);
      }
    } else {
      const res = await activateOutletCatalogItem(item.itemId);
      if (res.success) {
        setToast(`"${item.name}" activated.`);
      } else {
        alert(`Failed to activate: ${res.error?.message ?? "unknown error"}`);
      }
    }
    await load();
  };

  // ── Assign to all locations (single item from row button) ──────────────────
  const openAssignDrawer = (item: OutletCatalogItem) => {
    setAssignItem(item);
    setAssignSelectedLocs(new Set(activeLocations.map((l: any) => l.id)));
    setAssignResult(null);
    setAssignDrawerOpen(true);
  };

  const handleAssignToSelected = async () => {
    if (!assignItem || assignSelectedLocs.size === 0) return;
    setAssigning(true);
    setAssignResult(null);
    const res = await assignCatalogItemsToLocations(
      [assignItem.itemId],
      Array.from(assignSelectedLocs),
    );
    setAssigning(false);
    setAssignResult(res);
    if (res.created > 0) setToast(`"${assignItem.name}" added to ${res.created} location(s).`);
  };

  // ── Bulk assign selected catalog items → all active locations ─────────────
  const handleBulkAssignAll = async () => {
    if (bulkSelected.size === 0 || activeLocations.length === 0) return;
    setBulkAssigning(true);
    setBulkAssignResult(null);
    const res = await assignCatalogItemsToLocations(
      Array.from(bulkSelected),
      activeLocations.map((l: any) => l.id),
    );
    setBulkAssigning(false);
    setBulkAssignResult(res);
    if (res.created > 0) setToast(`${res.created} row(s) created across ${activeLocations.length} location(s).`);
  };

  // Seed HQ supplied item from hq_sale_items
  const seedFromHQ = (si: SaleItem) => {
    setForm(prev => ({
      ...prev,
      name: si.name,
      category: si.category ?? "",
      uom: si.baseUnit,
      sourceType: "hq_supplied",
      hqSaleItemId: si.id,
      price: si.effectivePrice,
      supplier: "Commissary HQ",
      supplierId: null,
    }));
  };

  // Excel export of full catalog
  const handleExport = () => {
    const rows = catalog.map(i => ({
      "Item ID": i.itemId, "Name": i.name, "Source Type": i.sourceType,
      "Category": i.category ?? "", "UOM": i.uom ?? "", "Type": i.type,
      "Supplier": i.supplier ?? "", "Price": i.price, "Tax Rate": i.taxRate,
      "Pack Qty": i.packQty, "Ordering Enabled": i.orderingEnabled,
      "HQ Sale Item ID": i.hqSaleItemId ?? "",
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = Object.keys(rows[0] ?? {}).map(h => ({ wch: Math.max(h.length, 12) }));
    XLSX.utils.book_append_sheet(wb, ws, "Location Catalog");
    XLSX.writeFile(wb, "location_catalog.xlsx");
  };

  // ── MarketMan / Excel import of local_vendor catalog items ─────────────────
  // Supports both native Location Catalog column names and MarketMan export aliases.
  // Before generating a new item_id, checks for an existing catalog row by
  // normalized name + supplier + uom to prevent duplicates on re-import.
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(data), { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rawRows: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });

      // ── MarketMan column aliases ──────────────────────────────────────────
      // Map MarketMan/alternate header names → canonical Location Catalog names.
      const ALIASES: Record<string, string> = {
        "Product":              "Name",
        "Item":                 "Name",
        "Item Name":            "Name",
        "Vendor":               "Supplier",
        "Vendor Product Name":  "Supplier Product Name",
        "Pack":                 "Pack Qty",
        "Pack Size":            "Pack Qty",
        "Ordering Unit":        "UOM",
        "Unit":                 "UOM",
        "Unit Price":           "Price",
        "Pack Price":           "Price",
      };

      // Normalize each row: remap aliased keys to canonical keys
      const rows = rawRows.map(raw => {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(raw)) {
          const canonical = ALIASES[k] ?? k;
          // Don't overwrite a canonical key that was already set directly
          if (!(canonical in out)) out[canonical] = v;
        }
        return out;
      });

      // ── Build supplier name → supplier.id lookup from global master ───────
      const normStr = (s: any) => String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
      const supplierNameToId = new Map<string, number>();
      for (const s of suppliers) {
        if (s.name) supplierNameToId.set(normStr(s.name), Number(s.id));
      }

      // ── Process each row ──────────────────────────────────────────────────
      const items: (Omit<OutletCatalogItem, "isActive"> & { isActive?: boolean })[] = [];

      for (const r of rows) {
        const nameRaw = String(r["Name"] ?? "").trim();
        if (!nameRaw) continue; // skip blank rows

        const supplierRaw = String(r["Supplier"] ?? "").trim() || null;
        const uomRaw      = String(r["UOM"] ?? "").trim() || null;

        // Resolve supplier_id from global master (null if not found — graceful degradation)
        const suppId = supplierRaw
          ? (supplierNameToId.get(normStr(supplierRaw)) ?? null)
          : null;

        // ── Duplicate-safe item_id resolution ─────────────────────────────
        // 1. If the file provides an Item ID, use it directly (upsert by item_id).
        // 2. Otherwise, check for an existing catalog row by name+supplier+uom.
        // 3. Only generate a new item_id if no existing row matches.
        let itemId = String(r["Item ID"] ?? "").trim();
        if (!itemId) {
          const existing = await findOutletCatalogItemByNormalized(nameRaw, supplierRaw, uomRaw);
          itemId = existing ?? `LOC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
        }

        items.push({
          itemId,
          name:           nameRaw,
          category:       String(r["Category"] ?? "").trim() || null,
          uom:            uomRaw,
          type:           String(r["Type"] ?? "Inventory item").trim() || "Inventory item",
          sourceType:     "local_vendor" as const,
          hqSaleItemId:   null,
          supplier:       supplierRaw,
          supplierId:     suppId,
          purchaseOption: null,
          productCode:    String(r["Product Code"] ?? "").trim() || null,
          scanBarcode:    String(r["Barcode"] ?? "").trim() || null,
          price:          parseFloat(String(r["Price"] ?? "0")) || 0,
          taxRate:        parseFloat(String(r["Tax Rate"] ?? "0")) || 0,
          packQty:        parseFloat(String(r["Pack Qty"] ?? "1")) || 1,
          orderingEnabled: String(r["Ordering Enabled"] ?? "true").toLowerCase() !== "false",
          isActive:       true,
        });
      }

      const result = await bulkUpsertOutletCatalogItems(items);
      setImportResult(result);
      if (result.succeeded > 0) {
        setToast(`Imported ${result.succeeded} catalog item${result.succeeded !== 1 ? "s" : ""}.`);
        await load();
      }
    } catch (err: any) {
      setImportResult({ succeeded: 0, failed: 1, errors: [err?.message ?? "Parse error"] });
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  };

  const fld = (k: keyof typeof form, label: string, type: string = "text", note?: string) => (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">{label}</label>
      <input
        type={type}
        value={String((form as any)[k] ?? "")}
        onChange={e => setForm(prev => ({ ...prev, [k]: type === "number" ? (parseFloat(e.target.value) || 0) : e.target.value }))}
        className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
      {note && <p className="text-[11px] text-neutral-400">{note}</p>}
    </div>
  );

  return (
    <div className="space-y-4 p-3 sm:p-5 lg:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-6 w-6 text-brand-600" /> Location Catalog
          </h2>
          <p className="text-neutral-500 text-sm mt-0.5">
            Global catalog of items available to all locations. Independent of HQ Inventory.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={handleExport} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50">
            <Download className="h-3.5 w-3.5" /> Export
          </button>
          <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 cursor-pointer">
            {importing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {importing ? "Importing…" : "Import Local Vendor Items"}
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImport} disabled={importing} />
          </label>
          <button onClick={openCreate} className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700">
            <Plus className="h-3.5 w-3.5" /> New Catalog Item
          </button>
        </div>
      </div>

      {/* Architecture notice */}
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-xs text-blue-800">
        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-blue-600" />
        <span>
          <strong>Location Catalog is independent of HQ Inventory.</strong> HQ Supplied items link to HQ Finished Goods via hq_sale_item_id.
          Local Vendor items have no connection to HQ Inventory. Changes here never affect <code>inventory_items</code>.
        </span>
      </div>

      {/* Toast */}
      {toast && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-2 text-sm text-green-800">
          <CheckCircle2 className="h-4 w-4 shrink-0" />{toast}
          <button onClick={() => setToast(null)} className="ml-auto"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* Import result */}
      {importResult && (
        <div className={`flex items-start gap-2 rounded-lg px-4 py-2.5 text-xs border ${importResult.failed > 0 ? "bg-amber-50 border-amber-200 text-amber-800" : "bg-green-50 border-green-200 text-green-800"}`}>
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Import result: {importResult.succeeded} succeeded, {importResult.failed} failed.</p>
            {importResult.errors.map((e, i) => <p key={i} className="text-red-600 mt-0.5">• {e}</p>)}
          </div>
          <button onClick={() => setImportResult(null)} className="ml-auto"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-wrap">
        <div className="relative w-full sm:w-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
          <input type="text" placeholder="Search catalog…" value={search} onChange={e => setSearch(e.target.value)}
            className="pl-9 pr-3 py-2.5 sm:py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white w-full sm:w-48" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {(["all", "hq_supplied", "local_vendor"] as const).map(f => (
            <button key={f} onClick={() => setSrcFilter(f)}
              className={`px-3 py-2 text-xs font-semibold rounded-lg border transition-colors min-h-[40px] ${srcFilter === f ? "bg-neutral-700 text-white border-neutral-700" : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}>
              {f === "all" ? "All" : f === "hq_supplied" ? "HQ Supplied" : "Local Vendor"}
            </button>
          ))}
        </div>
        <span className="text-xs text-neutral-400 sm:ml-auto">{filtered.length} items</span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: "Total Catalog Items", value: catalog.length, icon: <BookOpen className="h-4 w-4" />, color: "text-brand-600" },
          { label: "HQ Supplied", value: catalog.filter(i => i.sourceType === "hq_supplied").length, icon: <Package className="h-4 w-4" />, color: "text-violet-600" },
          { label: "Local Vendor", value: catalog.filter(i => i.sourceType === "local_vendor").length, icon: <Store className="h-4 w-4" />, color: "text-teal-600" },
        ].map((s, i) => (
          <div key={i} className="bg-white border border-neutral-200 rounded-xl p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-neutral-500 font-medium">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            </div>
            <span className={s.color}>{s.icon}</span>
          </div>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-16 text-neutral-400 animate-pulse text-sm">Loading catalog…</div>
      ) : (
        <div className="border border-neutral-200 rounded-xl overflow-hidden bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-neutral-500 bg-neutral-50 border-b border-neutral-200">
                <tr>
                  <th className="px-3 py-3 text-left font-semibold">
                    <input type="checkbox"
                      checked={filtered.length > 0 && filtered.every(i => bulkSelected.has(i.itemId))}
                      onChange={e => {
                        if (e.target.checked) setBulkSelected(new Set(filtered.map(i => i.itemId)));
                        else setBulkSelected(new Set());
                      }}
                      className="rounded border-neutral-300 text-brand-600"
                    />
                  </th>
                  <th className="px-4 py-3 text-left font-semibold">Item</th>
                  <th className="px-3 py-3 text-left font-semibold">Source</th>
                  <th className="px-3 py-3 text-left font-semibold">Category</th>
                  <th className="px-3 py-3 text-left font-semibold">UOM</th>
                  <th className="px-3 py-3 text-left font-semibold">Supplier</th>
                  <th className="px-3 py-3 text-right font-semibold">Price</th>
                  <th className="px-3 py-3 text-right font-semibold">Pack Qty</th>
                  <th className="px-3 py-3 text-center font-semibold">Ordering</th>
                  <th className="px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={9} className="py-12 text-center text-neutral-400 text-sm">
                    {search || srcFilter !== "all" ? "No items match your filters." : "No catalog items yet. Click New Catalog Item to add one."}
                  </td></tr>
                ) : filtered.map(item => (
                  <tr key={item.itemId} className={`hover:bg-neutral-50/30 transition-colors ${!item.isActive ? "opacity-60 bg-neutral-50/40" : ""}`}>
                    <td className="px-3 py-2.5">
                      <input type="checkbox"
                        checked={bulkSelected.has(item.itemId)}
                        onChange={e => {
                          setBulkSelected(prev => {
                            const n = new Set(prev);
                            if (e.target.checked) n.add(item.itemId); else n.delete(item.itemId);
                            return n;
                          });
                        }}
                        className="rounded border-neutral-300 text-brand-600"
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-neutral-900 text-xs">{item.name}</span>
                        {!item.isActive && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-neutral-200 text-neutral-600 border border-neutral-300">Inactive</span>
                        )}
                      </div>
                      <div className="text-[9px] text-neutral-400 font-mono">{item.itemId}</div>
                    </td>
                    <td className="px-3 py-2.5"><SrcBadge src={item.sourceType} /></td>
                    <td className="px-3 py-2.5 text-xs text-neutral-600">{item.category || "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-neutral-600">{item.uom || "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-neutral-500">{item.supplier || "—"}</td>
                    <td className="px-3 py-2.5 text-right text-xs tabular-nums text-neutral-700">{item.price > 0 ? `$${item.price.toFixed(2)}` : "—"}</td>
                    <td className="px-3 py-2.5 text-right text-xs text-neutral-600">{item.packQty}</td>
                    <td className="px-3 py-2.5 text-center">
                      {item.orderingEnabled
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 mx-auto" />
                        : <X className="h-3.5 w-3.5 text-neutral-300 mx-auto" />}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => openAssignDrawer(item)} className="p-1.5 rounded text-neutral-400 hover:text-brand-700 hover:bg-brand-50" title="Add to Locations">
                          <MapPin className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => openEdit(item)} className="p-1.5 rounded text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100" title="Edit">
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => handleToggleActive(item)} className="p-1.5 rounded text-neutral-400 hover:bg-neutral-100" title={item.isActive ? "Deactivate" : "Activate"}>
                          {item.isActive ? <ToggleRight className="h-4 w-4 text-green-500" /> : <ToggleLeft className="h-4 w-4 text-neutral-400" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bulk action toolbar */}
      {bulkSelected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-neutral-900 text-white rounded-xl px-5 py-3 shadow-2xl text-sm">
          <span className="font-semibold">{bulkSelected.size} item{bulkSelected.size !== 1 ? 's' : ''} selected</span>
          <button
            onClick={handleBulkAssignAll}
            disabled={bulkAssigning || activeLocations.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50"
          >
            {bulkAssigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
            Add Selected to All Locations
          </button>
          {bulkAssignResult && (
            <span className="text-xs text-neutral-300">
              ✓ {bulkAssignResult.created} created · {bulkAssignResult.skipped} skipped
              {bulkAssignResult.failed > 0 && <span className="text-red-400"> · {bulkAssignResult.failed} failed</span>}
            </span>
          )}
          <button onClick={() => { setBulkSelected(new Set()); setBulkAssignResult(null); }} className="ml-1 text-neutral-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Assign to Locations Drawer */}
      {assignDrawerOpen && assignItem && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex justify-end">
          <div className="bg-white w-full sm:max-w-md h-full overflow-y-auto shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
              <div>
                <h3 className="text-base font-bold text-neutral-900">Location Availability</h3>
                <p className="text-xs text-neutral-400 mt-0.5 font-mono truncate">{assignItem.name}</p>
              </div>
              <button onClick={() => { setAssignDrawerOpen(false); setAssignResult(null); }}>
                <X className="h-5 w-5 text-neutral-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <p className="text-xs text-neutral-500">
                Select locations to add <strong>{assignItem.name}</strong> to their Outlet Inventory.
                Existing rows are never overwritten.
              </p>

              {/* Select / Deselect all */}
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Active Locations ({activeLocations.length})</span>
                <div className="flex gap-2">
                  <button onClick={() => setAssignSelectedLocs(new Set(activeLocations.map((l: any) => l.id)))}
                    className="text-[10px] font-semibold text-brand-600 hover:underline">All</button>
                  <button onClick={() => setAssignSelectedLocs(new Set())}
                    className="text-[10px] font-semibold text-neutral-500 hover:underline">None</button>
                </div>
              </div>

              <div className="space-y-1.5">
                {activeLocations.map((loc: any) => (
                  <label key={loc.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-neutral-200 hover:bg-neutral-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={assignSelectedLocs.has(loc.id)}
                      onChange={e => {
                        setAssignSelectedLocs(prev => {
                          const n = new Set(prev);
                          if (e.target.checked) n.add(loc.id); else n.delete(loc.id);
                          return n;
                        });
                      }}
                      className="rounded border-neutral-300 text-brand-600"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-neutral-800 truncate">{loc.name}</p>
                      <p className="text-[10px] text-neutral-400 font-mono">{loc.id}</p>
                    </div>
                  </label>
                ))}
                {activeLocations.length === 0 && (
                  <p className="text-xs text-neutral-400 text-center py-4">No active non-HQ locations found.</p>
                )}
              </div>

              {/* Result */}
              {assignResult && (
                <div className={`rounded-lg px-4 py-3 text-xs border ${
                  assignResult.failed > 0 ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-green-50 border-green-200 text-green-800'
                }`}>
                  <p className="font-semibold mb-1">Result</p>
                  <p>✓ Created: <strong>{assignResult.created}</strong></p>
                  <p>↷ Skipped (already existed): <strong>{assignResult.skipped}</strong></p>
                  {assignResult.failed > 0 && <p className="text-red-600">✗ Failed: <strong>{assignResult.failed}</strong></p>}
                  {assignResult.errors.map((e, i) => <p key={i} className="text-red-600 mt-0.5 break-all">• {e}</p>)}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-neutral-100 space-y-2">
              <button
                onClick={handleAssignToSelected}
                disabled={assigning || assignSelectedLocs.size === 0}
                className="w-full py-2.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {assigning ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Assigning…</> : <><MapPin className="h-3.5 w-3.5" /> Add to {assignSelectedLocs.size} Location{assignSelectedLocs.size !== 1 ? 's' : ''}</>}
              </button>
              <button
                onClick={() => { setAssignDrawerOpen(false); setAssignResult(null); }}
                className="w-full py-2.5 text-xs font-semibold border border-neutral-200 rounded-lg hover:bg-neutral-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit / Create Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex justify-end">
          <div className="bg-white w-full sm:max-w-md h-full overflow-y-auto shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
              <div>
                <h3 className="text-base font-bold text-neutral-900">{editing ? `Edit: ${editing.name}` : "New Catalog Item"}</h3>
                <p className="text-xs text-neutral-400 mt-0.5">outlet_catalog_items — never touches inventory_items</p>
              </div>
              <button onClick={() => setDrawerOpen(false)}><X className="h-5 w-5 text-neutral-400" /></button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              {formErr && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />{formErr}
                </div>
              )}

              {/* Source type */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Source Type</label>
                <div className="flex gap-2">
                  {(["local_vendor", "hq_supplied"] as const).map(src => (
                    <button key={src} type="button"
                      onClick={() => setForm(prev => ({ ...prev, sourceType: src, hqSaleItemId: src === "local_vendor" ? null : prev.hqSaleItemId }))}
                      className={`flex-1 py-2 text-xs font-semibold rounded-lg border transition-colors ${form.sourceType === src ? (src === "hq_supplied" ? "bg-violet-600 text-white border-violet-600" : "bg-teal-600 text-white border-teal-600") : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}>
                      {src === "hq_supplied" ? "HQ Supplied" : "Local Vendor"}
                    </button>
                  ))}
                </div>
              </div>

              {/* If HQ supplied — seed from sale items */}
              {form.sourceType === "hq_supplied" && (
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Seed from HQ Finished Good</label>
                  <select
                     value={form.hqSaleItemId ?? ""}
                     onChange={e => {
                       const si = saleItems.find(s => s.id === e.target.value);
                       if (si) seedFromHQ(si);
                       else setForm(prev => ({ ...prev, hqSaleItemId: e.target.value || null }));
                     }}
                     className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500">
                     <option value="">Select HQ finished good…</option>
                     {saleItems.filter(s => s.isActive && s.isRequisitionable).map(s => (
                       <option key={s.id} value={s.id}>{s.name} ({s.baseUnit})</option>
                     ))}
                   </select>
                   <p className="text-[11px] text-neutral-400">Selecting auto-fills name, category, UOM, price from hq_sale_items. Does not create a live link.</p>
                </div>
              )}

              {fld("itemId", "Item ID", "text", editing ? "Cannot change ID after creation." : "Auto-generated. Change only if needed.")}
              {fld("name", "Item Name")}
              {fld("category", "Category")}
              {fld("uom", "UOM (Unit of Measure)")}

              <div className="space-y-1">
                <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Type</label>
                <select value={form.type}
                  onChange={e => setForm(prev => ({ ...prev, type: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500">
                  {["Inventory item", "Packaging", "Cleaning", "Paper goods", "Produce", "Dairy", "Other"].map(t => <option key={t}>{t}</option>)}
                </select>
              </div>

              {/* Supplier: dropdown from global master + free-text fallback */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">
                  Default Supplier
                </label>
                <select
                  value={form.supplierId != null ? String(form.supplierId) : "__free__"}
                  onChange={e => {
                    const val = e.target.value;
                    if (val === "__free__") {
                      setForm(prev => ({ ...prev, supplierId: null }));
                    } else {
                      const picked = suppliers.find((s: any) => String(s.id) === val);
                      setForm(prev => ({
                        ...prev,
                        supplierId: picked ? Number(picked.id) : null,
                        supplier: picked ? picked.name : prev.supplier,
                      }));
                    }
                  }}
                  className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="__free__">— Free text / not in master —</option>
                  {suppliers.map((s: any) => (
                    <option key={s.id} value={String(s.id)}>{s.name}</option>
                  ))}
                </select>
                {/* Free-text override — always saved as supplier text column */}
                <input
                  type="text"
                  value={form.supplier ?? ""}
                  onChange={e => setForm(prev => ({ ...prev, supplier: e.target.value }))}
                  placeholder="Supplier name (displayed on catalog)"
                  className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <p className="text-[11px] text-neutral-400">
                  Select from master to link supplier_id. The text name is always saved for display.
                </p>
              </div>
              {fld("price", "Default Price ($)", "number")}
              {fld("taxRate", "Tax Rate (%)", "number")}
              {fld("packQty", "Pack Qty", "number")}

              {/* Status toggles */}
              <div className="space-y-2 pt-2">
                <label className="flex items-center justify-between p-3 bg-neutral-50 border border-neutral-200 rounded-lg cursor-pointer hover:bg-neutral-100">
                  <div>
                    <p className="text-sm font-medium text-neutral-800">Catalog Item Active</p>
                    <p className="text-xs text-neutral-500">Enable this item globally in the catalog</p>
                  </div>
                  <div onClick={() => setForm(prev => ({ ...prev, isActive: !prev.isActive }))}
                    className={`relative w-10 h-5 rounded-full transition-colors ${form.isActive ? "bg-green-500" : "bg-neutral-300"}`}>
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${form.isActive ? "translate-x-5" : ""}`} />
                  </div>
                </label>

                <label className="flex items-center justify-between p-3 bg-neutral-50 border border-neutral-200 rounded-lg cursor-pointer hover:bg-neutral-100">
                  <div>
                    <p className="text-sm font-medium text-neutral-800">Ordering Enabled</p>
                    <p className="text-xs text-neutral-500">Allow locations to order this item</p>
                  </div>
                  <div onClick={() => setForm(prev => ({ ...prev, orderingEnabled: !prev.orderingEnabled }))}
                    className={`relative w-10 h-5 rounded-full transition-colors ${form.orderingEnabled ? "bg-green-500" : "bg-neutral-300"}`}>
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${form.orderingEnabled ? "translate-x-5" : ""}`} />
                  </div>
                </label>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-neutral-100 flex gap-3">
              <button onClick={() => setDrawerOpen(false)}
                className="flex-1 px-4 py-2.5 text-xs font-semibold border border-neutral-200 rounded-lg hover:bg-neutral-50">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving}
                className="flex-1 px-4 py-2.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center gap-2">
                {saving ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Saving…</> : <><CheckCircle2 className="h-3.5 w-3.5" /> Save Item</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function LocationCatalogPage() {
  return (
    <HQOnlyGuard>
      <LocationCatalogContent />
    </HQOnlyGuard>
  );
}
