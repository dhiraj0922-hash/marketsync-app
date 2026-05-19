"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin, resolveLocationId } from "@/lib/roles";
import { useActiveLocation } from "@/components/LocationContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { Search, Plus, Upload, MoreHorizontal, ShoppingCart, History, Save, Trash2, ArrowDown, ArrowUp, AlertTriangle, X, Download, Loader2, Link2, ChevronDown, ChevronRight, GitMerge } from "lucide-react";
import { loadInventory, saveInventory, loadInventoryActivity, saveInventoryActivity, loadOrders, saveOrders, loadCategories, addCategory, loadSuppliers, saveSuppliers, resolveSupplier, loadImportBatches, saveImportBatches, insertInventoryItem, resolveHqItemId, resolveSharedItemId, logMovement, deleteInventoryItem, deleteSaleItemByNameOrId, insertPurchaseOptions, loadPurchaseOptions, savePurchaseOptions, deletePurchaseOption, updateInventoryRowItemId } from "@/lib/storage";
import { normalizeInventoryName } from "@/lib/inventoryIdentity";

export default function Inventory() {
  const router = useRouter();
  const { user } = useAuth();   // role + locationId from user_profiles
  const { activeLocation } = useActiveLocation(); // HQ admin location picker
  const [inventoryData, setInventoryData] = useState<any[]>([]);
  const [activityData, setActivityData] = useState<Record<string, any[]>>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [suppliersData, setSuppliersData] = useState<any[]>([]);

  // Filtering States
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterCategory, setFilterCategory] = useState("All");
  const [filterSupplier, setFilterSupplier] = useState("All");
  const [sortKey, setSortKey] = useState<string>("category");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  // UI-level pagination — does NOT change the Supabase query or loadInventory
  const ITEMS_PER_PAGE = 50;
  const [currentPage, setCurrentPage] = useState(1);

  // Edit Drawer States
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any>(null);

  // Adjustment Form States
  const [adjType, setAdjType] = useState<"Add" | "Remove" | "Waste">("Add");
  const [adjQty, setAdjQty] = useState("");
  const [adjUnit, setAdjUnit] = useState("");
  const [adjNotes, setAdjNotes] = useState("");

  const [newParLevel, setNewParLevel] = useState("");
  const [parNotes, setParNotes] = useState("");
  const [userRole, setUserRole] = useState<"HQ" | "Location">("HQ");

  // Unit Mapping Config States
  const [editBaseUnit, setEditBaseUnit] = useState("");
  const [editPurchaseUnits, setEditPurchaseUnits] = useState<any[]>([]);
  const [editPurchaseCost, setEditPurchaseCost] = useState("");

  // Add Item Drawer States
  const [isAddDrawerOpen, setIsAddDrawerOpen] = useState(false);
  const [newItem, setNewItem] = useState({
    name: "", category: "Produce", itemType: "Raw", unit: "kg",
    supplier: "Fresh Farms Produce", inStock: "", parLevel: "", cost: "",
    purchaseUnits: [{ name: "Case", conversion: '1', isPrimary: true }] as any[],
    // Phase 2: Structured packaging fields (all optional, all default null/empty)
    purchaseUom: "",   // e.g. 'case', 'bag'
    packQty: "",   // inner units per purchase_uom
    innerUnitType: "",   // e.g. 'can', 'bottle'
    innerUnitSize: "",   // qty per inner unit
    innerUnitUom: "",   // unit for innerUnitSize
    baseUomNew: "",   // preferred costing unit (backfills baseunit if blank)
    allowedRecipeUoms: "",   // comma-separated, parsed on save
  });

  // Import Drawer States
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImportDrawerOpen, setIsImportDrawerOpen] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [importPreview, setImportPreview] = useState<any[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [overwriteExisting, setOverwriteExisting] = useState(false);

  // History & Batch States
  const [importBatches, setImportBatches] = useState<any[]>([]);
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);

  // ── Supplier Import State ────────────────────────────────────────────────────
  const supplierFileInputRef = useRef<HTMLInputElement>(null);
  const [isSupplierImportDrawerOpen, setIsSupplierImportDrawerOpen] = useState(false);
  const [supplierImportPreview, setSupplierImportPreview] = useState<any[]>([]);  // matched rows
  const [supplierImportUnmatched, setSupplierImportUnmatched] = useState<any[]>([]); // unmatched rows
  const [supplierImportErrors, setSupplierImportErrors] = useState<string[]>([]);
  const [isCommittingSuppliers, setIsCommittingSuppliers] = useState(false);
  const [supplierImportSummary, setSupplierImportSummary] = useState<any>(null);

  // Bulk Output States
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([]);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  // Action menu state — tracks which row's ⋯ menu is open
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // Edit Item Drawer States
  const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  // Edit packaging fields (separate string state for controlled inputs)
  const [editPurchaseUom, setEditPurchaseUom] = useState("");
  const [editPackQty, setEditPackQty] = useState("");
  const [editInnerUnitType, setEditInnerUnitType] = useState("");
  const [editInnerUnitSize, setEditInnerUnitSize] = useState("");
  const [editInnerUnitUom, setEditInnerUnitUom] = useState("");
  const [editBaseUomNew, setEditBaseUomNew] = useState("");
  const [editAllowedUoms, setEditAllowedUoms] = useState("");

  // Edit drawer: purchase_options state
  const [editPurchaseOptions, setEditPurchaseOptions] = useState<any[]>([]);
  const [isLoadingPurchOpts, setIsLoadingPurchOpts] = useState(false);
  const [isSavingPurchOpt, setIsSavingPurchOpt] = useState<string | null>(null);
  const [addingPurchOpt, setAddingPurchOpt] = useState(false);
  const [newPurchOpt, setNewPurchOpt] = useState<any>({
    supplierName: '', supplierProductName: '', purchaseUom: 'ea',
    packQty: '', packUom: '', unitPrice: '', isPreferred: false,
  });

  const [isLoading, setIsLoading] = useState(true);

  // ── Identity inspection state (HQ only, additive) ─────────────────────────
  // sharedLinkedDrawerItem: the inventory row whose shared-product drawer is open.
  // showDuplicatePanel: toggle for the collapsible duplicate detection panel.
  // mergeConfirm: pending merge operation waiting for user confirmation.
  type MergeTarget = {
    sourceRowId:    string;  // the row whose item_id will be reassigned
    sourceRowName:  string;
    sourceItemId:   string;  // current (old) item_id
    canonicalItemId: string; // new item_id to assign
    canonicalName:  string;
    locationId:     string;
  };
  const [sharedLinkedDrawerItem, setSharedLinkedDrawerItem] = useState<any>(null);
  const [showDuplicatePanel, setShowDuplicatePanel] = useState(false);
  const [mergeConfirm, setMergeConfirm] = useState<MergeTarget | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const [inv, act, cats, batches, sups, allPurchOpts] = await Promise.all([
          loadInventory(),
          loadInventoryActivity(),
          loadCategories('inventory'),
          loadImportBatches(),
          loadSuppliers(),
          loadPurchaseOptions()   // bulk-load all rows up-front for startup merge
        ]);
        // Scope to current user's location
        const userLocationId: string = resolveLocationId(user);

        // ── CLOVE diagnostic: raw DB rows ─────────────────────────────────────
        const rawCloveRows = inv.filter((i: any) => i.name?.toLowerCase().includes('clove'));
        const hqAdmin = isHqAdmin(user);
        console.log(
          `[LoadDiag] Raw DB rows for 'clove': ${rawCloveRows.length} / ${inv.length} total` +
          ` | isHqAdmin=${hqAdmin} | resolvedLocationId="${userLocationId}"`,
          rawCloveRows.map((i: any) => ({
            name: i.name, locationId: i.locationId, itemType: i.itemType, baseUnit: i.baseUnit, inStock: i.inStock, parLevel: i.parLevel
          }))
        );

        const scopedInv = hqAdmin
          ? inv
          : inv.filter((item: any) => item.locationId === userLocationId);

        // Build inventoryItemId → purchase_option[] map, then merge preferred/lowest
        // supplier name + price into every inventory row as transient client-side fields.
        // These are the same fields that syncInventoryRowSupplier / handleEditSave maintain
        // during the session. Without this merge, every page reload wiped them.
        const purchOptsByItem = new Map<string, any[]>();
        (allPurchOpts as any[]).forEach((opt: any) => {
          const key = String(opt.inventoryItemId ?? '');
          if (!purchOptsByItem.has(key)) purchOptsByItem.set(key, []);
          purchOptsByItem.get(key)!.push(opt);
        });

        const mergedInv = scopedInv.map((item: any) => {
          const opts     = purchOptsByItem.get(String(item.id)) ?? [];
          const preferred = opts.find((r: any) => r.isPreferred);
          const lowest   = opts.length > 0
            ? [...opts].sort((a: any, b: any) => a.unitPrice - b.unitPrice)[0]
            : null;
          const chosen   = preferred ?? lowest ?? null;
          return chosen
            ? { ...item, preferredSupplierName: chosen.supplierName, preferredCost: chosen.unitPrice }
            : item;
        });

        const scopedCloveRows = mergedInv.filter((i: any) => i.name?.toLowerCase().includes('clove'));
        console.log(
          `[LoadDiag] mergedInv: ${mergedInv.length} rows (clove: ${scopedCloveRows.length})` +
          ` | scope="${hqAdmin ? "ALL (HQ admin)" : `location=${userLocationId}`}"`,
          scopedCloveRows.map((i: any) => ({ name: i.name, locationId: i.locationId, preferredSupplierName: i.preferredSupplierName, preferredCost: i.preferredCost }))
        );

        setInventoryData(mergedInv);
        setActivityData(act);
        setCategories(cats);
        setImportBatches(batches);
        setSuppliersData(sups);

        if (typeof window !== "undefined") {
          const saved = localStorage.getItem("inventory_filters");
          if (saved) {
            try {
              const p = JSON.parse(saved);
              if (p.searchQuery !== undefined) setSearchQuery(p.searchQuery);
              // Only restore filterStatus if it's a valid recognised value.
              // A stale 'Healthy'/'Critical'/'Low' filter hides rows that don't
              // match the status purely because parLevel=0 is treated as Healthy.
              if (p.filterStatus !== undefined) setFilterStatus(p.filterStatus);
              // Only restore filterCategory/filterSupplier if the value still
              // exists in the freshly loaded data. A stale category value (e.g.
              // "Dry Goods" was not previously in the list) silently hides every
              // item in that category because there's no UI feedback that the
              // filter is active-but-unknown.
              if (p.filterCategory !== undefined && p.filterCategory !== "All") {
                const catExists = (cats as string[]).some(
                  (c: string) => c.toLowerCase() === p.filterCategory.toLowerCase()
                );
                setFilterCategory(catExists ? p.filterCategory : "All");
              } else if (p.filterCategory !== undefined) {
                setFilterCategory(p.filterCategory);
              }
              if (p.filterSupplier !== undefined) setFilterSupplier(p.filterSupplier);
            } catch (e) { }
          }
        }
      } catch (e) {
        console.error(e);
      } finally {
        setIsLoading(false);
      }
    }
    // Guard: user=undefined means auth is still initialising — don't fetch yet.
    // user=null means auth resolved but no session; user=object means logged in.
    // Running with user=undefined/null causes resolveLocationId() to return "",
    // which matches inventory rows with blank location_id and shows ghost data.
    if (user === undefined) return;
    fetchData();
  }, [user]);  // re-run when auth resolves so location scoping is correct

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("inventory_filters", JSON.stringify({
        searchQuery, filterStatus, filterCategory, filterSupplier
      }));
    }
  }, [searchQuery, filterStatus, filterCategory, filterSupplier]);

  // Reset to page 1 whenever filter/search/sort changes so the user always
  // sees the first page of results after narrowing the set.
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, filterStatus, filterCategory, filterSupplier, sortKey, sortDirection]);

  const getSupplierName = (id: any) => {
    const s = suppliersData.find(s => s.id === id);
    return s ? s.name : "Unknown Vendor";
  };

  const normalizedCategoriesMap = new Map();
  const normalizedSuppliersMap = new Map();
  inventoryData.forEach(item => {
    if (item.category && item.category.trim() !== '') {
      const normCat = item.category.trim().toLowerCase();
      if (!normalizedCategoriesMap.has(normCat)) {
        normalizedCategoriesMap.set(normCat, item.category.trim());
      }
    }
    if (item.supplierId) {
      const suppObj = suppliersData.find(s => s.id === item.supplierId);
      if (suppObj) {
        const normSupp = suppObj.name.trim().toLowerCase();
        if (!normalizedSuppliersMap.has(normSupp)) {
          normalizedSuppliersMap.set(normSupp, suppObj.name.trim());
        }
      }
    }
  });

  const uniqueCategories = Array.from(normalizedCategoriesMap.values()).sort();
  const uniqueSuppliers = Array.from(normalizedSuppliersMap.values()).sort();

  console.log(`[Diagnostic] Extracted ${uniqueCategories.length} categories from Inventory.`);
  console.log(`[Diagnostic] Extracted ${uniqueSuppliers.length} suppliers from Inventory.`);

  const filteredInventory = inventoryData.filter(item => {
    // Divide-by-zero guard: when parLevel = 0, stockRatio = NaN which makes
    // ALL status checks false, causing 'Healthy' to be assigned but the item
    // may not match a saved filterStatus. Clamp to a safe ratio.
    const safeParLevel = item.parLevel > 0 ? item.parLevel : null;
    const stockRatio = safeParLevel !== null ? (item.inStock / safeParLevel) : (item.inStock > 0 ? 1 : 0);
    const isCritical = stockRatio < 0.3;
    const isLowStock = stockRatio >= 0.3 && stockRatio <= 0.7;
    const dynamicStatus = isCritical ? "Critical" : isLowStock ? "Low" : "Healthy";

    // ── CLOVE debug logging (temporary, for diagnosis) ───────────────────
    const isClove = item.name?.toLowerCase().includes('clove');
    if (isClove) {
      console.log(
        `[FilterDiag] "${item.name}" | locationId="${item.locationId}"` +
        ` | inStock=${item.inStock} parLevel=${item.parLevel}` +
        ` | stockRatio=${stockRatio.toFixed(3)} status="${dynamicStatus}"` +
        ` | category="${item.category}" | filterCategory="${filterCategory}"` +
        ` | filterStatus="${filterStatus}"`
      );
    }

    if (filterStatus !== "All" && dynamicStatus !== filterStatus) {
      if (isClove) console.log(`  \u2192 DROPPED by filterStatus: item=${dynamicStatus} filter=${filterStatus}`);
      return false;
    }
    if (filterCategory !== "All" && item.category !== filterCategory) {
      if (isClove) console.log(`  \u2192 DROPPED by filterCategory: item="${item.category}" filter="${filterCategory}"`);
      return false;
    }
    if (filterSupplier !== "All") {
      const displayedSupplier = item.preferredSupplierName ?? getSupplierName(item.supplierId);
      if (displayedSupplier !== filterSupplier) return false;
    }

    if (searchQuery) {
      const qs = searchQuery.toLowerCase();
      const suppName = item.preferredSupplierName ?? getSupplierName(item.supplierId);
      if (!item.name?.toLowerCase().includes(qs) &&
        !item.category?.toLowerCase().includes(qs) &&
        !suppName.toLowerCase().includes(qs) &&
        !item.unit?.toLowerCase().includes(qs)) {
        if (isClove) console.log(`  \u2192 DROPPED by searchQuery: "${searchQuery}"`);
        return false;
      }
    }
    if (isClove) console.log(`  \u2192 PASSED all filters \u2713`);
    return true;
  }).sort((a, b) => {
    let valA = a[sortKey] || "";
    let valB = b[sortKey] || "";

    // Remap if sorting by supplier
    if (sortKey === 'supplier') {
      valA = a.preferredSupplierName ?? getSupplierName(a.supplierId) ?? '';
      valB = b.preferredSupplierName ?? getSupplierName(b.supplierId) ?? '';
    }

    if (typeof valA === "string") valA = valA.toLowerCase();
    if (typeof valB === "string") valB = valB.toLowerCase();
    if (valA < valB) return sortDirection === "asc" ? -1 : 1;
    if (valA > valB) return sortDirection === "asc" ? 1 : -1;
    return 0;
  });

  // ── UI pagination slice ────────────────────────────────────────────────────
  // filteredInventory retains the full filtered+sorted array for checkbox
  // "select all" and count displays; only the rendered rows are paged.
  const totalPages = Math.max(1, Math.ceil(filteredInventory.length / ITEMS_PER_PAGE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStart = (safeCurrentPage - 1) * ITEMS_PER_PAGE; // 0-based index
  const pageEnd   = Math.min(pageStart + ITEMS_PER_PAGE, filteredInventory.length);
  const pagedInventory = filteredInventory.slice(pageStart, pageEnd);
  // Display labels (1-based)
  const displayStart = filteredInventory.length === 0 ? 0 : pageStart + 1;
  const displayEnd   = pageEnd;

  const clearFilters = () => {
    setSearchQuery("");
    setFilterStatus("All");
    setFilterCategory("All");
    setFilterSupplier("All");
  };

  const handleQuickReorder = async (item: any, e: React.MouseEvent) => {
    e.stopPropagation();
    const currentOrders = await loadOrders();
    const qtyNeeded = Math.max(1, item.parLevel - item.inStock);

    const newDraft = {
      id: `PO-${1000 + currentOrders.length + 1}`,
      supplierId: item.supplierId,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      deliveryDate: "Pending",
      items: 1,
      lineItems: [{
        ...item,
        qty: qtyNeeded,
        expectedPrice: item.cost
      }],
      total: qtyNeeded * item.cost,
      status: "Draft",
      location: "Downtown",
      notes: "Auto-generated from Quick Reorder",
      createdBy: "System",
      receivedBy: null,
      receivedAt: null
    };

    const newMatrix = [newDraft, ...currentOrders];
    await saveOrders(newMatrix);
    alert(`Successfully staged a Draft PO for ${qtyNeeded} ${item.unit} of ${item.name}! Redirecting to Orders...`);
    router.push("/orders");
  };

  // ── Open Edit Drawer ──────────────────────────────────────────────────────
  const openEditDrawer = (item: any) => {
    setEditItem(JSON.parse(JSON.stringify(item))); // deep copy so edits don't mutate list
    setEditBaseUnit(item.baseUnit || item.unit || "");
    setEditPurchaseUnits(item.purchaseUnits ? JSON.parse(JSON.stringify(item.purchaseUnits)) : []);
    setEditPurchaseCost(
      item.purchaseCost !== undefined && item.purchaseCost !== null
        ? String(item.purchaseCost)
        : item.cost !== undefined ? String(item.cost) : ""
    );
    // Packaging fields — coerce null → ""
    setEditPurchaseUom(item.purchaseUom ?? "");
    setEditPackQty(item.packQty != null ? String(item.packQty) : "");
    setEditInnerUnitType(item.innerUnitType ?? "");
    setEditInnerUnitSize(item.innerUnitSize != null ? String(item.innerUnitSize) : "");
    setEditInnerUnitUom(item.innerUnitUom ?? "");
    setEditBaseUomNew(item.baseUomNew ?? "");
    setEditAllowedUoms(
      Array.isArray(item.allowedRecipeUoms) ? item.allowedRecipeUoms.join(", ") : ""
    );
    setOpenMenuId(null);
    setIsEditDrawerOpen(true);
    setAddingPurchOpt(false);
    setNewPurchOpt({ supplierName: '', supplierProductName: '', purchaseUom: 'ea', packQty: '', packUom: '', unitPrice: '', isPreferred: false });
    // Load purchase_options for this item fresh from DB
    setIsLoadingPurchOpts(true);
    loadPurchaseOptions(String(item.id))
      .then((rows: any[]) => setEditPurchaseOptions(rows))
      .catch(() => setEditPurchaseOptions([]))
      .finally(() => setIsLoadingPurchOpts(false));
  };

  // ── Save Edit ─────────────────────────────────────────────────────────────
  const handleEditSave = async () => {
    if (!editItem) return;
    if (!editItem.name?.trim()) { alert("Item name is required."); return; }
    if (isSavingEdit) return;
    setIsSavingEdit(true);
    console.log("[EditItem] save start  id=", editItem.id);

    try {
      let pUnits = editItem.purchaseUnits
        ? JSON.parse(JSON.stringify(editItem.purchaseUnits))
        : editPurchaseUnits;
      pUnits = pUnits
        .map((u: any) => ({ ...u, conversion: parseFloat(u.conversion) }))
        .filter((u: any) => u.name?.trim());
      if (pUnits.length > 0 && !pUnits.some((u: any) => u.isPrimary)) pUnits[0].isPrimary = true;

      const primaryUnit = pUnits.find((u: any) => u.isPrimary) || pUnits[0];
      const hasValidPrim = primaryUnit && primaryUnit.name && primaryUnit.conversion > 0;

      const parsedCost = parseFloat(editPurchaseCost);
      const baseCost = hasValidPrim && !isNaN(parsedCost)
        ? parsedCost / primaryUnit.conversion
        : (!isNaN(parsedCost) ? parsedCost : editItem.cost);
      const purchCost = hasValidPrim && !isNaN(parsedCost) ? parsedCost : null;

      // Compute preferred supplier summary from purchase_options state.
      // This MUST be included in `updated` so that setInventoryData(newInventory)
      // does not discard the patch applied by syncInventoryRowSupplier / makePreferred.
      const _prefRow = editPurchaseOptions.find((r: any) => r.isPreferred);
      const _lowRow = editPurchaseOptions.length > 0
        ? [...editPurchaseOptions].sort((a: any, b: any) => a.unitPrice - b.unitPrice)[0]
        : null;
      const _chosen = _prefRow ?? _lowRow ?? null;

      const updated = {
        ...editItem,
        baseUnit: editBaseUnit || editItem.unit || "",
        unit: editBaseUnit || editItem.unit || "",
        purchaseUnits: pUnits,
        cost: baseCost,
        purchaseCost: purchCost,
        updatedAt: Date.now(),
        // Packaging fields
        purchaseUom: editPurchaseUom.trim() || null,
        packQty: editPackQty !== "" ? Number(editPackQty) : null,
        innerUnitType: editInnerUnitType.trim() || null,
        innerUnitSize: editInnerUnitSize !== "" ? Number(editInnerUnitSize) : null,
        innerUnitUom: editInnerUnitUom.trim() || null,
        // base_uom: only backfill baseunit when currently blank
        baseUomNew: editBaseUomNew.trim() || null,
        allowedRecipeUoms: editAllowedUoms.trim()
          ? editAllowedUoms.split(",").map(s => s.trim()).filter(Boolean)
          : null,
        // Preserve purchase_options-derived supplier summary so the inventory list
        // does not revert to legacy supplierId / suppliersData after Save Changes.
        preferredSupplierName: _chosen?.supplierName ?? null,
        preferredCost: _chosen?.unitPrice ?? null,
      };

      const newInventory = inventoryData.map(i => i.id === updated.id ? updated : i);

      // Diagnostic: confirm preferred supplier fields are present before and after save
      const _beforeRow = inventoryData.find((i: any) => i.id === updated.id);
      console.log('[handleEditSave] BEFORE setInventoryData', {
        id: updated.id,
        preferredSupplierName_before: _beforeRow?.preferredSupplierName,
        preferredCost_before: _beforeRow?.preferredCost,
        preferredSupplierName_on_updated: updated.preferredSupplierName,
        preferredCost_on_updated: updated.preferredCost,
        editPurchaseOptions: editPurchaseOptions.map((r: any) => ({
          supplierName: r.supplierName, isPreferred: r.isPreferred, unitPrice: r.unitPrice,
        })),
      });

      console.log("[EditItem] request start  id=", updated.id);
      const res = await saveInventory(newInventory);
      if (!res?.success) {
        const msg = `Save failed: ${res?.error?.message ?? JSON.stringify(res?.error)}`;
        console.log("[EditItem] request error", msg);
        alert(msg);
        return;
      }
      console.log("[EditItem] request success");
      setInventoryData(newInventory);

      // Diagnostic: confirm the row in newInventory after setInventoryData
      const _afterRow = newInventory.find((i: any) => i.id === updated.id);
      console.log('[handleEditSave] AFTER setInventoryData', {
        id: updated.id,
        preferredSupplierName_after: _afterRow?.preferredSupplierName,
        preferredCost_after: _afterRow?.preferredCost,
      });

      setIsEditDrawerOpen(false);
    } catch (err: any) {
      console.log("[EditItem] caught error", err?.message);
      alert(err?.message ?? "Unexpected error saving item.");
    } finally {
      setIsSavingEdit(false);
    }
  };

  // Purchase Options CRUD helpers (used inside edit drawer)
  const updatePurchOptField = (id: string, field: string, value: any) =>
    setEditPurchaseOptions((prev: any[]) =>
      prev.map((r: any) => r.id === id ? { ...r, [field]: value } : r)
    );

  const savePurchOpt = async (row: any) => {
    setIsSavingPurchOpt(row.id);
    try {
      const res = await savePurchaseOptions([row]);
      if (!res.success) alert(`Save failed: ${(res as any).error?.message ?? 'Unknown'}`);
    } finally {
      setIsSavingPurchOpt(null);
    }
  };

  const syncInventoryRowSupplier = (rows: any[]) => {
    if (!editItem) {
      console.log('[syncInventoryRowSupplier] SKIPPED — editItem is null');
      return;
    }
    const preferred = rows.find((r: any) => r.isPreferred);
    const lowest = rows.length > 0
      ? [...rows].sort((a: any, b: any) => a.unitPrice - b.unitPrice)[0]
      : null;
    const chosen = preferred ?? lowest ?? null;
    console.log('[syncInventoryRowSupplier]', {
      editItemId: editItem.id,
      chosenSupplierName: chosen?.supplierName ?? null,
      chosenUnitPrice: chosen?.unitPrice ?? null,
      preferredFound: !!preferred,
      totalRows: rows.length,
    });
    setInventoryData((prev: any[]) =>
      prev.map((inv: any) => {
        if (String(inv.id) === String(editItem.id)) {
          const patched = {
            ...inv,
            preferredSupplierName: chosen?.supplierName ?? null,
            preferredCost: chosen?.unitPrice ?? null,
          };
          console.log('[syncInventoryRowSupplier] patched row', {
            id: patched.id, name: patched.name,
            preferredSupplierName: patched.preferredSupplierName,
            preferredCost: patched.preferredCost,
          });
          return patched;
        }
        return inv;
      })
    );
  };

  const deletePurchOpt = async (id: string) => {
    if (!confirm('Remove this supplier row?')) return;
    const deletedRow = editPurchaseOptions.find((r: any) => r.id === id);
    const res = await deletePurchaseOption(id);
    if (res.success) {
      const remaining = editPurchaseOptions.filter((r: any) => r.id !== id);
      setEditPurchaseOptions(remaining);
      syncInventoryRowSupplier(remaining);
      // If the deleted row was preferred, sync cost to new preferred or lowest
      if (deletedRow?.isPreferred) {
        const newPreferred = remaining.find((r: any) => r.isPreferred);
        const lowest = remaining.length > 0
          ? [...remaining].sort((a: any, b: any) => a.unitPrice - b.unitPrice)[0]
          : null;
        const fallbackPrice = newPreferred?.unitPrice ?? lowest?.unitPrice ?? null;
        setEditPurchaseCost(fallbackPrice !== null ? String(fallbackPrice) : '');
      }
    } else {
      alert(`Delete failed: ${(res as any).error?.message ?? 'Unknown'}`);
    }
  };

  const makePreferred = async (id: string) => {
    const updated = editPurchaseOptions.map((r: any) => ({ ...r, isPreferred: r.id === id }));
    setEditPurchaseOptions(updated);
    syncInventoryRowSupplier(updated);
    // Immediately sync cost to the newly preferred row's price
    const newPreferred = updated.find((r: any) => r.id === id);
    if (newPreferred) setEditPurchaseCost(String(newPreferred.unitPrice));
    const res = await savePurchaseOptions(updated);
    if (!res.success) alert(`Could not update preferred: ${(res as any).error?.message ?? ''}`);
  };

  const commitNewPurchOpt = async () => {
    if (!editItem) return;
    if (!newPurchOpt.supplierName.trim()) { alert('Supplier name is required.'); return; }
    const res = await insertPurchaseOptions([{
      ...newPurchOpt,
      inventoryItemId: String(editItem.id),
      packQty: newPurchOpt.packQty !== '' ? Number(newPurchOpt.packQty) : null,
      unitPrice: newPurchOpt.unitPrice !== '' ? Number(newPurchOpt.unitPrice) : 0,
    }]);
    if (!res.success) { alert(`Insert failed: ${(res as any).error?.message ?? ''}`); return; }
    const rows = await loadPurchaseOptions(String(editItem.id));
    setEditPurchaseOptions(rows);
    syncInventoryRowSupplier(rows);
    // If new row is preferred, sync cost immediately
    const preferredRow = rows.find((r: any) => r.isPreferred);
    const lowestRow = rows.length > 0 ? [...rows].sort((a: any, b: any) => a.unitPrice - b.unitPrice)[0] : null;
    const syncPrice = preferredRow?.unitPrice ?? lowestRow?.unitPrice ?? null;
    if (syncPrice !== null) setEditPurchaseCost(String(syncPrice));
    setAddingPurchOpt(false);
    setNewPurchOpt({ supplierName: '', supplierProductName: '', purchaseUom: 'ea', packQty: '', packUom: '', unitPrice: '', isPreferred: false });
  };

  // ── Delete Item ───────────────────────────────────────────────────────────
  //
  // DEFAULT = DELETE BOTH tables.
  // 1. Hard-DELETE from inventory_items by row UUID (the only reliable delete).
  // 2. Hard-DELETE from hq_sale_items (try same UUID first, name-match fallback)
  //    to catch cross-table duplicates where the same item exists in both.
  // 3. Re-fetch from DB after both deletes — no local-only filter — so the
  //    item cannot reappear on the next load.
  //
  const handleDeleteItem = async (item: any) => {
    if (!confirm(
      `Delete "${item.name}" from Inventory AND Finished Goods?\n\nThis removes the item from both inventory_items and hq_sale_items. Cannot be undone.`
    )) return;
    setOpenMenuId(null);

    // 1. Delete from inventory_items
    const invRes = await deleteInventoryItem(String(item.id));
    if (!invRes.success) {
      alert(`Delete failed (inventory_items): ${invRes.error?.message ?? "Unknown error"}`);
      return;
    }

    // 2. Delete from hq_sale_items (id first, then name-match fallback)
    const fgRes = await deleteSaleItemByNameOrId(String(item.id), item.name);
    if (!fgRes.success) {
      alert(
        `inventory_items deleted but hq_sale_items delete failed: ${fgRes.error?.message ?? "Unknown error"}\n` +
        `Please manually remove the Finished Good entry named "${item.name}".`
      );
      // Still re-fetch so inventory side is accurate
    }

    // 3. Re-fetch from DB — authoritative state, not a local filter
    const freshInv = await loadInventory();
    const userLocationId = resolveLocationId(user);
    const scopedInv = isHqAdmin(user)
      ? freshInv
      : freshInv.filter((i: any) => i.locationId === userLocationId);
    setInventoryData(scopedInv);
  };

  const openItemDrawer = (item: any) => {
    /** Safely convert a nullable number to a string input value. */
    const numToInput = (v: number | null | undefined) => (v == null ? "" : String(v));

    setSelectedItem(item);
    setAdjType("Add");
    setAdjQty("");
    if (item.purchaseUnits && item.purchaseUnits.length > 0) {
      const pUnit = item.purchaseUnits.find((u: any) => u.isPrimary) || item.purchaseUnits[0];
      setAdjUnit(pUnit.name);
    } else {
      setAdjUnit(item.baseUnit || item.unit);
    }
    setAdjNotes("");
    // parLevel can be null for legacy items — guard before calling toString()
    setNewParLevel(numToInput(item.parLevel));
    setParNotes("");
    setEditBaseUnit(item.baseUnit || item.unit || "");
    setEditPurchaseUnits(item.purchaseUnits ? JSON.parse(JSON.stringify(item.purchaseUnits)) : []);
    // purchaseCost and cost can both be null — use numToInput throughout
    setEditPurchaseCost(
      item.purchaseCost != null ? numToInput(item.purchaseCost)
        : item.cost     != null ? numToInput(item.cost)
        : ""
    );
    setIsDrawerOpen(true);
  };

  const saveAdjustment = async () => {
    if (!selectedItem || !adjQty) return;
    const numericQty = parseFloat(adjQty);
    if (isNaN(numericQty) || numericQty <= 0) return;

    let conversion = 1;
    if (selectedItem.purchaseUnits) {
      const mappedUnit = selectedItem.purchaseUnits.find((u: any) => u.name === adjUnit);
      if (mappedUnit) conversion = mappedUnit.conversion;
    }

    let variance = 0;
    const normalizedInput = numericQty * conversion;

    if (adjType === "Add") variance = normalizedInput;
    if (adjType === "Remove" || adjType === "Waste") variance = -normalizedInput;

    let updatedItem = { ...selectedItem, inStock: selectedItem.inStock + variance, updatedAt: Date.now() };
    const newInventory = inventoryData.map(i => i.id === selectedItem.id ? updatedItem : i);

    const logEntry = {
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      type: adjType,
      qty: `${numericQty} ${adjUnit}`,
      baseTransacted: variance,
      notes: adjNotes,
      user: userRole
    };

    const currentHistoryList = activityData[selectedItem.id] || [];
    const newActivityData = {
      ...activityData,
      [selectedItem.id]: [logEntry, ...currentHistoryList]
    };

    const res = await saveInventory(newInventory);
    if (!res.success) {
      alert(`Save Failed: ${res.error?.message || "Database rejected the adjustment."}`);
      return;
    }
    setInventoryData(newInventory);
    setActivityData(newActivityData);
    await saveInventoryActivity(newActivityData);
    setSelectedItem(updatedItem);

    // ── Log movement (fire-and-forget, non-fatal) ──────────────────────────────
    // Use the canonical item_id (shared identity) if set, else fall back to row id.
    const movItemId = selectedItem.itemId ?? selectedItem.id;
    const movLocId = selectedItem.locationId ?? resolveLocationId(user);
    const movType = (adjType === 'Add') ? 'adjustment_in' : 'adjustment_out';
    const absQty = Math.abs(normalizedInput);
    logMovement({
      locationId: movLocId,
      itemId: String(movItemId),
      movementType: movType,
      quantity: absQty,
      unitCost: selectedItem.cost ?? null,
      referenceType: 'manual',
      notes: adjNotes ? `${adjType}: ${adjNotes}` : adjType,
    });
    // ─────────────────────────────────────────────────────────────────────────

    setAdjQty("");
    setAdjNotes("");
  };

  const saveUnitInfo = async () => {
    if (!selectedItem) return;
    if (!editBaseUnit) return alert("Base unit is required.");
    if (editPurchaseUnits.some(u => !u.name || !u.conversion || isNaN(parseFloat(u.conversion)))) return alert("All purchase units must have a valid name and conversion multiplier.");

    let pUnits = [...editPurchaseUnits];
    pUnits.forEach(u => u.conversion = parseFloat(u.conversion));

    if (pUnits.length > 0 && !pUnits.some(u => u.isPrimary)) {
      pUnits[0].isPrimary = true;
    }

    const primaryUnit = pUnits.find(u => u.isPrimary) || pUnits[0];
    const hasValidPrimary = primaryUnit && primaryUnit.name && primaryUnit.conversion > 0;

    let parsedInput = parseFloat(editPurchaseCost);
    let baseCost = parsedInput;
    let purchaseCost = parsedInput;

    if (hasValidPrimary && !isNaN(parsedInput)) {
      purchaseCost = parsedInput;
      baseCost = purchaseCost / primaryUnit.conversion;
      primaryUnit.cost = purchaseCost;
    }

    let updatedItem = {
      ...selectedItem,
      baseUnit: editBaseUnit,
      unit: editBaseUnit,
      purchaseUnits: pUnits,
      cost: !isNaN(baseCost) ? baseCost : selectedItem.cost,
      purchaseCost: !isNaN(purchaseCost) ? purchaseCost : selectedItem.purchaseCost,
      updatedAt: Date.now()
    };
    const newInventory = inventoryData.map(i => i.id === selectedItem.id ? updatedItem : i);

    const res = await saveInventory(newInventory);
    if (!res.success) {
      alert(`Save Failed: ${res.error?.message || "Database rejected unit update."}`);
      return;
    }
    setInventoryData(newInventory);
    setSelectedItem(updatedItem);

    if (pUnits.length > 0) {
      const primary = pUnits.find((u: any) => u.isPrimary) || pUnits[0];
      setAdjUnit(primary.name);
    } else {
      setAdjUnit(editBaseUnit);
    }
    alert("Unit map schema updated effectively.");
  };

  const saveParLevel = async () => {
    if (!selectedItem || !newParLevel) return;
    const numPar = parseFloat(newParLevel);
    if (isNaN(numPar) || numPar <= 0 || numPar === selectedItem.parLevel) return;

    let updatedItem = { ...selectedItem, parLevel: numPar, updatedAt: Date.now() };
    const newInventory = inventoryData.map(i => i.id === selectedItem.id ? updatedItem : i);

    const logEntry = {
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      type: 'Par Update',
      qty: numPar - selectedItem.parLevel,
      notes: `Target Shift: ${selectedItem.parLevel} -> ${numPar}${parNotes ? ' | ' + parNotes : ''}`,
      user: userRole
    };

    const currentHistoryList = activityData[selectedItem.id] || [];
    const newActivityData = {
      ...activityData,
      [selectedItem.id]: [logEntry, ...currentHistoryList]
    };

    const res = await saveInventory(newInventory);
    if (!res.success) {
      alert(`Save Failed: ${res.error?.message || "Database rejected supplier match."}`);
      return;
    }
    setInventoryData(newInventory);
    setActivityData(newActivityData);
    await saveInventoryActivity(newActivityData);
    setSelectedItem(updatedItem);
    setParNotes("");
  };

  const handleAddNewItem = async () => {
    if (!newItem.name || !newItem.inStock || !newItem.parLevel || !newItem.cost) {
      alert("Please fill in all required fields.");
      return;
    }

    // ── Resolve location_id for this new item ──────────────────────────────
    //
    // HQ admins MUST have picked a specific location from the header dropdown.
    // If they are still in "All Locations (HQ View)" mode, block creation and
    // show a friendly message — a null location_id would violate NOT NULL.
    //
    // Location managers: always use their profile's fixed locationId.
    let locationId: string;

    if (isHqAdmin(user)) {
      if (!activeLocation) {
        alert(
          "Please select a specific location before creating an inventory item.\n\n" +
          "Use the location dropdown in the top header (currently showing \"All Locations (HQ View)\").\n" +
          "Select the location where this item will be stocked, then try again."
        );
        return;
      }
      locationId = activeLocation.id;
    } else {
      locationId = resolveLocationId(user);
    }

    // Debug logging — confirms exact values sent to DB
    console.log(
      "[AddItem] role=", user?.role,
      "| user.locationId=", user?.locationId,
      "| activeLocation=", activeLocation,
      "| → resolved location_id =", locationId,
      "| isHqAdmin=", isHqAdmin(user)
    );

    if (!locationId) {
      alert("Your profile has no location assigned. Cannot add item.");
      return;
    }

    let suppText = newItem.supplier.trim();
    let suppIdCode = null;
    if (suppText) {
      try {
        suppIdCode = await resolveSupplier(suppText);
      } catch (e: any) {
        alert(e.message ?? `Supplier "${suppText}" not found in HQ master. Ask HQ to create it first.`);
        return;
      }
    }

    let pUnits = [...newItem.purchaseUnits];
    pUnits.forEach((u: any) => u.conversion = parseFloat(u.conversion));
    if (pUnits.length > 0 && !pUnits.some((u: any) => u.isPrimary)) {
      pUnits[0].isPrimary = true;
    }

    pUnits = pUnits.filter((u: any) => u.name.trim() !== "");

    const primaryUnit = pUnits.find(u => u.isPrimary) || pUnits[0];
    const hasValidPrimary = primaryUnit && primaryUnit.name && primaryUnit.conversion > 0;

    let parsedInput = parseFloat(newItem.cost as string);
    let baseCost = parsedInput;
    let purchaseCost = parsedInput;

    if (hasValidPrimary) {
      purchaseCost = parsedInput;
      baseCost = purchaseCost / primaryUnit.conversion;
      primaryUnit.cost = purchaseCost;
    }

    const finalItem = {
      ...newItem,
      baseUnit: newItem.unit,
      purchaseUnits: pUnits,
      purchaseCost: purchaseCost,
      supplierId: suppIdCode,
      inStock: parseFloat(newItem.inStock as string),
      parLevel: parseFloat(newItem.parLevel as string),
      cost: baseCost,
      priceTrend: "steady",
      priceIncrease: false,
      updatedAt: Date.now(),
      // Phase 2: structured packaging fields — pass nulls when left blank so the
      // DB columns stay NULL and costing falls back to legacy for this item.
      purchaseUom: newItem.purchaseUom.trim() || null,
      packQty: newItem.packQty !== "" ? Number(newItem.packQty) : null,
      innerUnitType: newItem.innerUnitType.trim() || null,
      innerUnitSize: newItem.innerUnitSize !== "" ? Number(newItem.innerUnitSize) : null,
      innerUnitUom: newItem.innerUnitUom.trim() || null,
      baseUomNew: newItem.baseUomNew.trim() || null,
      // allowedRecipeUoms: comma-separated in the UI → split into TEXT[] for the DB
      allowedRecipeUoms: newItem.allowedRecipeUoms.trim()
        ? newItem.allowedRecipeUoms.split(',').map(s => s.trim()).filter(Boolean)
        : null,
    };

    const res = await insertInventoryItem(finalItem, locationId);
    if (!res.success) {
      alert(`Add Item Failed: ${res.error?.message || "Database rejected insertion."}`);
      return;
    }

    // Use the returned UUID as the canonical id for local state
    const localItem = { ...finalItem, id: res.id };
    setInventoryData([localItem, ...inventoryData]);
    setNewItem({
      name: "", category: "Produce", itemType: "Raw", unit: "kg",
      supplier: "", inStock: "", parLevel: "", cost: "",
      purchaseUnits: [{ name: "", conversion: '1', isPrimary: true }],
      purchaseUom: "", packQty: "", innerUnitType: "",
      innerUnitSize: "", innerUnitUom: "", baseUomNew: "", allowedRecipeUoms: "",
    });
    setIsAddDrawerOpen(false);
  };

  const handleCSVUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);

      if (lines.length < 2) {
        setImportErrors(["Uploaded file does not contain valid data rows."]);
        setImportPreview([]);
        return;
      }

      const dataRows = lines.slice(1);
      const parsedData = [];
      const errors = [];

      // ── UOM → baseUnit derivation ────────────────────────────────────────────
      // Maps the raw UOM from the CSV column to the canonical DB baseunit value.
      // This runs at parse time so every preview row already carries baseUnit.
      const deriveBaseUnit = (rawUom: string): string => {
        const u = rawUom.trim().toLowerCase();
        if (['kg', 'kgs', 'kilogram', 'kilograms',
          'g', 'gm', 'gms', 'gram', 'grams',
          'lb', 'lbs', 'pound', 'pounds'].includes(u)) return 'kg';
        if (['l', 'ltr', 'litre', 'litres', 'liter', 'liters',
          'ml', 'millilitre', 'milliliter'].includes(u)) return 'L';
        return 'ea';  // default: each/piece/unit
      };

      for (const [idx, row] of dataRows.entries()) {
        const cols = row.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        if (cols.length < 7) {
          errors.push(`Row ${idx + 2} is missing required standard columns.`);
          continue;
        }

        const rawUom = cols[2] || '';
        const baseUnit = deriveBaseUnit(rawUom);

        const payload = {
          name: cols[0],
          category: cols[1],
          unit: rawUom || 'ea',
          baseUnit,                        // ← derived from UOM, never blank
          itemType: 'Ingredient',      // ← default for all food imports
          supplierText: cols[3],
          inStock: parseFloat(cols[4]) || 0,
          parLevel: parseFloat(cols[5]) || 0,
          cost: parseFloat(cols[6]) || 0,
          priceTrend: "steady",
          priceIncrease: false
        };

        console.log(
          `[Import Parse] Row ${idx + 2}: name="${payload.name}"` +
          ` | sourceUOM="${rawUom}" → baseUnit="${baseUnit}" | itemType="${payload.itemType}"`
        );

        const isDuplicate = inventoryData.some(i => i.name.toLowerCase() === payload.name.toLowerCase());
        parsedData.push({ payload, isDuplicate });
      }

      setImportPreview(parsedData);
      setImportErrors(errors);
    };
    reader.readAsText(file);
  };

  const commitImport = async () => {
    setIsCommitting(true);
    setImportErrors([]);

    try {
      const validItemsInput = importPreview.filter(p => !p.isDuplicate || (p.isDuplicate && overwriteExisting));
      if (validItemsInput.length === 0) {
        setImportErrors(["No valid items tracked. Import cancelled."]);
        setIsCommitting(false);
        return;
      }

      console.log("[Commit Import] Phase A: Pre-flight Validation");
      const currentCategoriesLower = categories.map(c => c.toLowerCase());
      const newlyCreatedCategories: string[] = [];
      const finalCategoriesList = [...categories];

      const currentSuppliersLower = suppliersData.map(s => s.name.toLowerCase());
      const newlyCreatedSuppliers: any[] = [];
      const finalSuppliersList = [...suppliersData];

      const currentInventoryMap = new Map(inventoryData.map(i => [i.name.toLowerCase(), i]));
      const timestamp = Date.now();

      const newItems: any[] = [];
      const updatedItems: any[] = [];
      const rollbackData: Record<number, any> = {};
      const newlyCreatedIds: string[] = [];  // UUID PKs for rollback
      let skipped = 0;

      const phaseAErrors: string[] = [];

      for (const [idx, p] of importPreview.entries()) {
        if (!p.payload.name || p.payload.name.trim() === "") {
          phaseAErrors.push(`Row ${idx + 1}: Missing required field 'Item Name'.`);
        }
        if (isNaN(parseFloat(p.payload.inStock)) || isNaN(parseFloat(p.payload.cost))) {
          phaseAErrors.push(`Row ${idx + 1} [${p.payload.name}]: Pricing/Stock bounds are invalid. Numeric limits required.`);
        }

        let cat = (p.payload.category || 'General').trim();
        const catLower = cat.toLowerCase();

        const existingIdx = currentCategoriesLower.indexOf(catLower);
        if (existingIdx !== -1) {
          cat = categories[existingIdx];
        } else {
          if (!newlyCreatedCategories.includes(cat)) {
            newlyCreatedCategories.push(cat);
            finalCategoriesList.push(cat);
            currentCategoriesLower.push(catLower);
          }
        }

        let suppText = p.payload.supplierText ? p.payload.supplierText.trim() : "";
        let suppIdVal = null;
        try {
          suppIdVal = suppText ? await resolveSupplier(suppText) : null;
        } catch (e: any) {
          phaseAErrors.push(`Row ${idx + 1} [${p.payload.name}]: Failed resolving supplier '${suppText}'. ${e.message}`);
        }

        const matchingItem = currentInventoryMap.get(p.payload.name.toLowerCase());

        if (matchingItem) {
          if (!overwriteExisting) {
            skipped++;
            continue;
          }
          rollbackData[matchingItem.id] = { ...matchingItem };

          // Explicit itemType / baseUnit resolution for UPDATE path:
          // p.payload spreads an itemType of 'Ingredient' and a derived baseUnit.
          // We preserve the existing values if they are already set (non-blank);
          // only backfill from the import row when the DB row had blanks.
          const resolvedItemType = matchingItem.itemType || p.payload.itemType || 'Ingredient';
          const resolvedBaseUnit = matchingItem.baseUnit || p.payload.baseUnit || p.payload.unit || 'ea';

          console.log(
            `[Import Update] "${p.payload.name}"` +
            ` itemType: "${matchingItem.itemType}" → "${resolvedItemType}"` +
            ` | baseUnit: "${matchingItem.baseUnit}" → "${resolvedBaseUnit}"` +
            ` | sourceUOM: "${p.payload.unit}"`
          );

          updatedItems.push({
            ...matchingItem,
            ...p.payload,
            itemType: resolvedItemType,   // explicitly overrides spread
            baseUnit: resolvedBaseUnit,   // explicitly overrides spread
            category: cat,
            supplierId: suppIdVal,
            updatedAt: timestamp
          });
        } else {
          // Determine location for this import (HQ admin → LOC-HQ, else current user location)
          const importLocationId: string = resolveLocationId(user);
          const newRowId = crypto.randomUUID(); // always unique per location row

          // Reuse shared item_id if same product name exists on the other side of HQ/store boundary
          let resolvedItemId: string;
          if (p.payload.name) {
            const existingId = await resolveSharedItemId(p.payload.name, importLocationId);
            resolvedItemId = existingId ?? crypto.randomUUID();
          } else {
            resolvedItemId = crypto.randomUUID();
          }

          newlyCreatedIds.push(newRowId);

          // Explicit itemType / baseUnit for INSERT path:
          // payload already carries both (set in handleCSVUpload parse step), but
          // we set them explicitly here too so the object is self-documenting and
          // safe even if parse step changes.
          const newItemType = p.payload.itemType || 'Ingredient';
          const newBaseUnit = p.payload.baseUnit || p.payload.unit || 'ea';

          console.log(
            `[Import Insert] "${p.payload.name}"` +
            ` itemType="${newItemType}" | baseUnit="${newBaseUnit}"` +
            ` | sourceUOM="${p.payload.unit}" | locationId="${importLocationId}"`
          );

          newItems.push({
            ...p.payload,
            itemType: newItemType,       // explicit — never blank
            baseUnit: newBaseUnit,       // explicit — never blank
            category: cat,
            supplierId: suppIdVal,
            id: newRowId,
            item_id: resolvedItemId,
            itemId: resolvedItemId,
            location_id: importLocationId,
            locationId: importLocationId,
            updatedAt: timestamp
          });
        }

      }

      if (phaseAErrors.length > 0) {
        console.warn("[Commit Import] Phase A Validation Failed. Committing halt.");
        setImportErrors(phaseAErrors);
        setIsCommitting(false);
        return;
      }

      if (newItems.length === 0 && updatedItems.length === 0) {
        setImportErrors(["No valid items tracked after duplicate check isolation."]);
        setIsCommitting(false);
        return;
      }

      console.log("[Commit Import] Phase B: Database Schema Commits");
      let unifiedInventory = [...inventoryData];
      for (const u of updatedItems) {
        const ix = unifiedInventory.findIndex(i => i.id === u.id);
        if (ix > -1) unifiedInventory[ix] = u;
      }
      unifiedInventory = [...newItems, ...unifiedInventory];

      const res = await saveInventory(unifiedInventory);
      if (!res.success) {
        setImportErrors([`Database Rejected Bulk Upsert: ${res.error?.message || JSON.stringify(res.error)}`]);
        setIsCommitting(false);
        return;
      }
      // Re-fetch from DB instead of stamping local state from unifiedInventory.
      // This guarantees the UI reflects actual DB state after the commit —
      // prevents ghost-data where a reset DB still shows old rows in the component.
      const hqAdmin = isHqAdmin(user);
      const freshInv = await loadInventory();
      const scopedAfterImport = hqAdmin
        ? freshInv
        : freshInv.filter((i: any) => i.locationId === resolveLocationId(user));
      setInventoryData(scopedAfterImport);
      console.log(`[commitImport] Re-fetched ${freshInv.length} rows from DB after commit (scoped: ${scopedAfterImport.length})`);

      if (newlyCreatedCategories.length > 0) {
        setCategories(finalCategoriesList);
        // Persist newly discovered categories to DB
        await Promise.all(
          newlyCreatedCategories.map((cat: string) => addCategory(cat, 'inventory'))
        );
      }

      const newBatch = {
        batchId: `IMP-${timestamp}`,
        timestamp,
        fileName: fileInputRef.current?.files?.[0]?.name || "Unknown Array",
        totalRowsProcessed: importPreview.length,
        metrics: { new: newItems.length, updated: updatedItems.length, skipped },
        newlyCreatedIds,
        rollbackData,
        status: "Active"
      };

      const newBatchesList = [newBatch, ...importBatches];
      const batchRes = await saveImportBatches(newBatchesList);
      if (!batchRes?.success) {
        setImportErrors([`Failed to append history ledger: ${batchRes?.error?.message}`]);
        // Do not fail the entire commit if history fails, just alert the user because inventory was already saved.
      } else {
        setImportBatches(newBatchesList);
      }

      // \u2500\u2500 Post-import summary ───────────────────────────────────────────────────
      const defaultedItemType = newItems.filter((i: any) => i.itemType === 'Ingredient').length
        + updatedItems.filter((i: any) => i.itemType === 'Ingredient' && !currentInventoryMap.get(i.name?.toLowerCase())?.itemType).length;
      const defaultedBaseUnit = newItems.filter((i: any) => !importPreview.find((p: any) => p.payload.name === i.name && p.payload.baseUnit && p.payload.unit !== p.payload.baseUnit)).length;

      console.log(
        `[Import Summary]\n` +
        `  Inserted:               ${newItems.length}\n` +
        `  Updated:                ${updatedItems.length}\n` +
        `  Skipped (no-overwrite): ${skipped}\n` +
        `  Defaulted itemType:     ${defaultedItemType} (→ 'Ingredient')\n` +
        `  Auto-created categories: ${newlyCreatedCategories.length}`
      );

      // Log per-item final payload for traceability
      console.groupCollapsed('[Import] Final payloads written to DB');
      for (const item of [...newItems, ...updatedItems]) {
        console.log(
          `  ${item.name} | itemType="${item.itemType}" | baseUnit="${item.baseUnit}" | unit="${item.unit}" | locationId="${item.locationId ?? item.location_id}"`
        );
      }
      console.groupEnd();

      alert(
        `Import committed!\n\n` +
        `  Inserted:  ${newItems.length}\n` +
        `  Updated:   ${updatedItems.length}\n` +
        `  Skipped:   ${skipped}\n` +
        `  Categories auto-created: ${newlyCreatedCategories.length}\n\n` +
        `All items defaulted to itemType="Ingredient" if not set.\n` +
        `(See browser console for per-row baseUnit mapping.)`
      );

      setImportPreview([]);
      setImportErrors([]);
      setIsImportDrawerOpen(false);
    } catch (err: any) {
      console.error("[Commit Import] FATAL EXECUTION CRASH:", err);
      setImportErrors([`Fatal Workflow Engine Error: ${err.message || 'Check Console for Trace'}`]);
    } finally {
      setIsCommitting(false);
    }
  };

  // ── Supplier CSV Import ────────────────────────────────────────────────────
  //
  // Expected CSV columns (order-independent — detected by header name):
  //   supplier_name | supplier | vendor
  //   supplier_product_name | product_name | product | description
  //   item_name | item | name | inventory_name
  //   purchase_uom | uom | unit
  //   pack_qty | pack_quantity | qty_per_pack
  //   pack_uom | inner_uom | inner_unit
  //   unit_price | price | cost
  //   is_preferred | preferred
  //
  // Normalization rules applied to item_name before matching:
  //   1. toLowerCase()
  //   2. trim()
  //   3. collapse multiple spaces → single space
  //   4. remove trailing qualifiers: units/sizes like "1 kg", "10kg", "55lbs"
  //     (keeps the semantic product name only)
  //
  const handleSupplierCSVUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSupplierImportSummary(null);

    const reader = new FileReader();
    reader.onload = async (event) => {
      const text = event.target?.result as string;
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length < 2) {
        setSupplierImportErrors(['Uploaded file has no data rows.']);
        return;
      }

      // ── Parse CSV header (comma or semicolon delimited) ─────────────────────
      const delimiter = lines[0].includes(';') ? ';' : ',';
      const parseRow = (row: string) =>
        row.split(delimiter).map(c => c.trim().replace(/^"|"$/g, '').trim());

      const headers = parseRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));

      const colIdx = (candidates: string[]): number => {
        for (const c of candidates) {
          const i = headers.indexOf(c);
          if (i !== -1) return i;
        }
        return -1;
      };

      const COL = {
        supplierName: colIdx(['supplier_name', 'supplier', 'vendor', 'supplier_company']),
        supplierProductName: colIdx(['supplier_product_name', 'product_name', 'product', 'description', 'supplier_description']),
        itemName: colIdx(['item_name', 'item', 'name', 'inventory_name', 'ingredient', 'ingredient_name']),
        purchaseUom: colIdx(['purchase_uom', 'uom', 'unit', 'buy_unit', 'order_unit']),
        packQty: colIdx(['pack_qty', 'pack_quantity', 'qty_per_pack', 'pack_size', 'quantity_per_pack']),
        packUom: colIdx(['pack_uom', 'inner_uom', 'inner_unit', 'unit_of_inner']),
        unitPrice: colIdx(['unit_price', 'price', 'cost', 'purchase_price', 'supplier_price']),
        isPreferred: colIdx(['is_preferred', 'preferred', 'default_supplier']),
      };

      // Require at minimum: supplier_name, item_name, unit_price
      const missing: string[] = [];
      if (COL.supplierName < 0) missing.push('supplier_name (or: supplier / vendor)');
      if (COL.itemName < 0) missing.push('item_name (or: item / name / inventory_name)');
      if (COL.unitPrice < 0) missing.push('unit_price (or: price / cost)');
      if (missing.length > 0) {
        setSupplierImportErrors([
          `Required columns not found in CSV header.`,
          `Missing: ${missing.join(', ')}`,
          `Detected headers: ${headers.join(', ')}`,
        ]);
        setSupplierImportPreview([]);
        setSupplierImportUnmatched([]);
        return;
      }

      // ── Build normalized name → inventory_items.id lookup map ──────────────
      // Load fresh from DB so we always match against actual persisted rows.
      const allItems = await loadInventory();
      console.log(`[SupplierImport] Loaded ${allItems.length} inventory_items for matching`);

      // Normalization: lowercase → trim → collapse spaces → strip trailing size tokens
      // (e.g. "Cloves 1 KG" → "cloves", "Beef Chuck 55LBS" → "beef chuck")
      const normalizeItemName = (raw: string): string => {
        let s = raw.toLowerCase().trim();
        s = s.replace(/\s+/g, ' ');                          // collapse spaces
        s = s.replace(/\s+\d+(\.\d+)?\s*(kg|g|lb|lbs|l|ml|oz|ea|pcs|pk|pack|bag|case|box)$/i, ''); // strip trailing size
        s = s.replace(/\s+\d+(\.\d+)?(kg|g|lb|lbs|l|ml|oz)$/i, ''); // no-space variant: "cloves1kg"
        return s.trim();
      };

      // Primary map: normalizedName → id
      const nameToId = new Map<string, string>();
      // Secondary map: normalizedName → original row (for debug)
      const nameToRow = new Map<string, any>();
      for (const item of allItems) {
        const norm = normalizeItemName(item.name || '');
        if (norm && !nameToId.has(norm)) {
          nameToId.set(norm, String(item.id));
          nameToRow.set(norm, item);
        }
      }
      console.log(`[SupplierImport] Name lookup map: ${nameToId.size} entries`);

      // ── Parse data rows ─────────────────────────────────────────────────────
      const matched: any[] = [];
      const unmatched: any[] = [];
      const parseErrors: string[] = [];

      for (const [idx, line] of lines.slice(1).entries()) {
        const cols = parseRow(line);
        const rowNum = idx + 2;

        const rawSupplierName = COL.supplierName >= 0 ? (cols[COL.supplierName] ?? '').trim() : '';
        const rawItemName = COL.itemName >= 0 ? (cols[COL.itemName] ?? '').trim() : '';
        const rawPrice = COL.unitPrice >= 0 ? (cols[COL.unitPrice] ?? '').trim() : '0';

        if (!rawItemName) {
          parseErrors.push(`Row ${rowNum}: empty item name — skipped.`);
          continue;
        }
        if (!rawSupplierName) {
          parseErrors.push(`Row ${rowNum}: empty supplier name for "${rawItemName}" — skipped.`);
          continue;
        }

        const normItemName = normalizeItemName(rawItemName);
        const inventoryItemId = nameToId.get(normItemName) ?? null;

        const row = {
          rowNum,
          rawItemName,
          normItemName,
          inventoryItemId,
          supplierName: rawSupplierName,
          supplierProductName: COL.supplierProductName >= 0 ? (cols[COL.supplierProductName] ?? '').trim() || null : null,
          purchaseUom: COL.purchaseUom >= 0 ? (cols[COL.purchaseUom] ?? '').trim() || 'ea' : 'ea',
          packQty: COL.packQty >= 0 ? (parseFloat(cols[COL.packQty] ?? '') || null) : null,
          packUom: COL.packUom >= 0 ? (cols[COL.packUom] ?? '').trim() || null : null,
          unitPrice: parseFloat(rawPrice) || 0,
          isPreferred: COL.isPreferred >= 0
            ? ['true', '1', 'yes', 'y'].includes((cols[COL.isPreferred] ?? '').trim().toLowerCase())
            : false,
        };

        console.log(
          `[SupplierImport] Row ${rowNum}: "${rawItemName}" → norm="${normItemName}"` +
          ` | matched=${inventoryItemId ? `YES (${inventoryItemId})` : 'NO'}` +
          ` | supplier="${rawSupplierName}" | price=${row.unitPrice}`
        );

        if (inventoryItemId) {
          matched.push(row);
        } else {
          unmatched.push(row);
        }
      }

      setSupplierImportPreview(matched);
      setSupplierImportUnmatched(unmatched);
      setSupplierImportErrors(parseErrors);
      setSupplierImportSummary(null); // clear previous run summary

      console.log(
        `[SupplierImport] Parse complete: ${matched.length} matched, ${unmatched.length} unmatched, ${parseErrors.length} parse errors`
      );
    };
    reader.readAsText(file);
  };

  const commitSupplierImport = async () => {
    if (supplierImportPreview.length === 0) return;
    setIsCommittingSuppliers(true);
    setSupplierImportErrors([]);
    try {
      const rows = supplierImportPreview.map(r => ({
        inventoryItemId: r.inventoryItemId,
        supplierName: r.supplierName,
        supplierProductName: r.supplierProductName ?? null,
        purchaseUom: r.purchaseUom || 'ea',
        packQty: r.packQty,
        packUom: r.packUom,
        unitPrice: r.unitPrice,
        isPreferred: r.isPreferred,
      }));

      const res = await insertPurchaseOptions(rows);
      if (!res.success) {
        setSupplierImportErrors([`DB insert failed: ${(res as any).error?.message ?? 'Unknown error'}`]);
        return;
      }

      const summary = {
        total: supplierImportPreview.length + supplierImportUnmatched.length,
        matched: supplierImportPreview.length,
        inserted: supplierImportPreview.length,
        unmatched: supplierImportUnmatched.length,
      };
      setSupplierImportSummary(summary);
      setSupplierImportPreview([]);
      console.log('[SupplierImport] Committed:', summary);
    } catch (err: any) {
      setSupplierImportErrors([`Fatal error: ${err.message}`]);
    } finally {
      setIsCommittingSuppliers(false);
    }
  };

  const revertBatch = async (batchId: string) => {
    const batchIdx = importBatches.findIndex(b => b.batchId === batchId);
    const batch = importBatches[batchIdx];
    if (!batch || batch.status === "Reverted") return;

    const updatedIds = Object.keys(batch.rollbackData).map(Number);
    const allIds = [...batch.newlyCreatedIds, ...updatedIds];

    for (const id of allIds) {
      const liveItem = inventoryData.find(i => i.id === id);
      if (liveItem && (liveItem as any).updatedAt > batch.timestamp) {
        alert("Conflict Detected! System lock engaged. Items inside this bulk process were modified natively afterwards.");
        return;
      }
    }

    let safeInventory = inventoryData.filter(i => !batch.newlyCreatedIds.includes(i.id));
    for (const rId of updatedIds) {
      const previousState = batch.rollbackData[rId];
      const ix = safeInventory.findIndex(i => i.id === rId);
      if (ix > -1) safeInventory[ix] = previousState;
    }

    const res = await saveInventory(safeInventory);
    if (!res.success) {
      alert(`Rollback Failed: ${res.error?.message || "Database rejected state sequence revert."}`);
      return;
    }
    setInventoryData(safeInventory);

    const mBatches = [...importBatches];
    mBatches[batchIdx].status = "Reverted";
    const resBatches = await saveImportBatches(mBatches);
    if (!resBatches?.success) {
      alert(`Batch Status Revert Failed: ${resBatches?.error?.message}`);
      return;
    }
    setImportBatches(mBatches);
    alert(`Rollback Complete: Native array sequence ${batch.batchId} systematically purged and reverted.`);
  };

  const downloadTemplate = () => {
    const csvContent = "data:text/csv;charset=utf-8,Item Name,Category,Unit,Preferred Supplier,Current Stock,Par Level,Cost Per Unit\nSourdough Loaf,Pantry,loaf,Fresh Farms Produce,12,30,4.50\nGarlic Powder,Pantry,kg,National Distributing,4,10,12.00";
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "inventory_import_template.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ── Identity maps — O(n) builds, recomputed only on inventoryData change ───
  //
  // rowsByItemId:         item_id → all rows sharing that shared product identity
  // linkedCountByItemId:  item_id → count of linked rows (used for badge rendering)
  // duplicateGroups:      candidate accidental duplicates (same normalizedName,
  //                       different item_id values). Each group has ≥ 2 item_ids.
  //
  const rowsByItemId = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const row of inventoryData) {
      const key = row.itemId ?? "";
      if (!key) continue;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(row);
    }
    return m;
  }, [inventoryData]);

  const linkedCountByItemId = useMemo(() => {
    const m = new Map<string, number>();
    rowsByItemId.forEach((rows, itemId) => m.set(itemId, rows.length));
    return m;
  }, [rowsByItemId]);

  const duplicateGroups = useMemo(() => {
    // Group item_ids by their normalized product name
    const normToGroups = new Map<string, { itemId: string; rows: any[] }[]>();
    rowsByItemId.forEach((rows, itemId) => {
      // Use the first row's name as representative; they should all match
      const normName = normalizeInventoryName(rows[0]?.name ?? "");
      if (!normName) return;
      if (!normToGroups.has(normName)) normToGroups.set(normName, []);
      normToGroups.get(normName)!.push({ itemId, rows });
    });

    // Keep only groups where ≥ 2 distinct item_ids share the same normalized name
    const groups: {
      normalizedName: string;
      candidates: { itemId: string; rows: any[] }[];
    }[] = [];

    normToGroups.forEach((candidates, normalizedName) => {
      if (candidates.length > 1) {
        groups.push({ normalizedName, candidates });
      }
    });

    return groups;
  }, [rowsByItemId]);

  // ── Merge handler ─────────────────────────────────────────────────────────
  //
  // Reassigns item_id on a single row (the "duplicate") to the canonical item_id.
  // Does NOT rename, delete, or touch recipes/movements/requisitions.
  //
  const handleMerge = async () => {
    if (!mergeConfirm) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const res = await updateInventoryRowItemId(
        mergeConfirm.sourceRowId,
        mergeConfirm.canonicalItemId
      );
      if (!res.success) {
        setMergeError(res.error?.message ?? "Merge failed — database rejected the update.");
        return;
      }
      // Optimistically patch local state so memos recompute immediately
      setInventoryData(prev =>
        prev.map(row =>
          String(row.id) === mergeConfirm.sourceRowId
            ? { ...row, itemId: mergeConfirm.canonicalItemId, item_id: mergeConfirm.canonicalItemId }
            : row
        )
      );
      setMergeConfirm(null);
    } catch (err: any) {
      setMergeError(err?.message ?? "Unexpected error during merge.");
    } finally {
      setIsMerging(false);
    }
  };

  if (isLoading) return <div className="animate-pulse flex items-center justify-center p-12 text-neutral-400">Loading Inventory Module...</div>;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Inventory Items</h2>
          <p className="text-neutral-500 text-xs sm:text-sm mt-0.5">Manage your ingredient list and maintain optimal par levels.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <button
            onClick={() => setIsHistoryDrawerOpen(true)}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs sm:text-sm font-medium bg-neutral-100 border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-200 shadow-sm"
          >
            <History className="h-3.5 w-3.5" />
            <span className="hidden xs:inline sm:inline">History</span>
          </button>
          <button
            onClick={() => {
              setImportPreview([]);
              setImportErrors([]);
              setIsImportDrawerOpen(true);
            }}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs sm:text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 shadow-sm"
          >
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Import Inventory</span>
            <span className="sm:hidden">Import Inv</span>
          </button>
          <button
            onClick={() => {
              setSupplierImportPreview([]);
              setSupplierImportUnmatched([]);
              setSupplierImportErrors([]);
              setSupplierImportSummary(null);
              setIsSupplierImportDrawerOpen(true);
            }}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs sm:text-sm font-medium bg-violet-600 text-white rounded-lg hover:bg-violet-700 shadow-sm transition-colors"
          >
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Import Suppliers</span>
            <span className="sm:hidden">Import Sup</span>
          </button>
          <button
            onClick={() => setIsAddDrawerOpen(true)}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs sm:text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> Add Item
          </button>
        </div>
      </div>

      {/* ── HQ-only: Duplicate Detection Panel ──────────────────────────────── */}
      {isHqAdmin(user) && duplicateGroups.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-amber-800 hover:bg-amber-100 transition-colors"
            onClick={() => setShowDuplicatePanel(p => !p)}
          >
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Potential Duplicate Products
              <span className="ml-1 text-[10px] font-bold bg-amber-200 text-amber-800 px-2 py-0.5 rounded-full">
                {duplicateGroups.length}
              </span>
            </span>
            {showDuplicatePanel
              ? <ChevronDown className="h-4 w-4 text-amber-500" />
              : <ChevronRight className="h-4 w-4 text-amber-500" />
            }
          </button>

          {showDuplicatePanel && (
            <div className="px-4 pb-4 space-y-3">
              <p className="text-xs text-amber-700">
                These product names normalize to the same canonical form but have different shared identities (item_id).
                This may indicate accidental duplicate entries. Review and merge the identity if appropriate.
              </p>
              {duplicateGroups.map((group) => (
                <div key={group.normalizedName} className="bg-white rounded-lg border border-amber-200 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-amber-800 uppercase tracking-wide">Canonical form:</span>
                    <span className="font-mono text-xs bg-amber-100 text-amber-900 px-2 py-0.5 rounded">&quot;{group.normalizedName}&quot;</span>
                    <span className="text-[10px] text-amber-600">{group.candidates.length} distinct item_ids</span>
                  </div>
                  <div className="space-y-1.5">
                    {group.candidates.map((candidate, ci) => {
                      const repRow = candidate.rows[0];
                      const isCanonical = ci === 0; // first (oldest by sort) treated as canonical
                      return (
                        <div key={candidate.itemId} className={`flex flex-col sm:flex-row sm:items-center gap-2 p-2 rounded-lg text-xs ${
                          isCanonical ? 'bg-violet-50 border border-violet-200' : 'bg-neutral-50 border border-neutral-200'
                        }`}>
                          <div className="flex-1 min-w-0">
                            <span className="font-semibold text-neutral-800">{repRow?.name ?? "(no name)"}</span>
                            {isCanonical && <span className="ml-2 text-[10px] font-bold text-violet-600 bg-violet-100 px-1.5 py-0.5 rounded">CANONICAL</span>}
                            <div className="text-[10px] text-neutral-500 font-mono mt-0.5 truncate">
                              item_id: {candidate.itemId.slice(0, 18)}…
                            </div>
                            <div className="text-[10px] text-neutral-500 mt-0.5">
                              {candidate.rows.length} location{candidate.rows.length !== 1 ? 's' : ''}
                              {' · '}
                              Cost: ${(repRow?.cost ?? 0).toFixed(2)}/{repRow?.baseUnit ?? repRow?.unit ?? 'unit'}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => setSharedLinkedDrawerItem(repRow)}
                              className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-white border border-neutral-200 text-neutral-700 rounded-md hover:bg-neutral-50 transition-colors shadow-sm"
                            >
                              <Link2 className="h-3 w-3" /> View Linked
                            </button>
                            {!isCanonical && (
                              <button
                                onClick={() => setMergeConfirm({
                                  sourceRowId:     String(repRow.id),
                                  sourceRowName:   repRow.name ?? "",
                                  sourceItemId:    candidate.itemId,
                                  canonicalItemId: group.candidates[0].itemId,
                                  canonicalName:   group.candidates[0].rows[0]?.name ?? "",
                                  locationId:      repRow.locationId ?? "LOC-HQ",
                                })}
                                className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-violet-600 text-white rounded-md hover:bg-violet-700 transition-colors shadow-sm"
                              >
                                <GitMerge className="h-3 w-3" /> Merge
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Card className="shadow-sm border-neutral-200 overflow-hidden">
        <CardHeader className="flex flex-col space-y-2 sm:space-y-0 sm:flex-row sm:items-center justify-between py-3 sm:py-4 px-3 sm:px-4 border-b border-neutral-100 bg-white">
          <div className="relative w-full sm:w-[360px]">
            <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none">
              <Search className="h-3.5 w-3.5 text-neutral-400" />
            </div>
            <input
              type="text"
              placeholder="Search items…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 border border-neutral-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 w-full bg-neutral-50 hover:bg-white transition-colors"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <select
              className="px-2 py-1.5 text-xs sm:text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="All">All Statuses</option>
              <option value="Healthy">Healthy</option>
              <option value="Low">Low</option>
              <option value="Critical">Critical</option>
            </select>
            <select
              className="px-2 py-1.5 text-xs sm:text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm"
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
            >
              <option value="All">All Categories</option>
              {uniqueCategories.map(c => <option key={c as string} value={c as string}>{c as string}</option>)}
            </select>
            <select
              className="px-2 py-1.5 text-xs sm:text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm"
              value={filterSupplier}
              onChange={(e) => setFilterSupplier(e.target.value)}
            >
              <option value="All">All Suppliers</option>
              {uniqueSuppliers.map(s => <option key={s as string} value={s as string}>{s as string}</option>)}
            </select>

            {(searchQuery || filterStatus !== 'All' || filterCategory !== 'All' || filterSupplier !== 'All') && (
              <button
                onClick={clearFilters}
                className="text-xs font-semibold text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded-lg px-2 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {selectedItemIds.length > 0 && (
            <div className="bg-brand-50 border-b border-brand-100 p-3 px-6 flex justify-between items-center transition-all">
              <span className="text-sm font-semibold text-brand-800">{selectedItemIds.length} operational node{selectedItemIds.length !== 1 ? 's' : ''} targeted</span>
              <div className="flex gap-4 items-center">
                <button onClick={() => setSelectedItemIds([])} className="text-xs font-semibold text-brand-700 hover:text-brand-900 transition-colors">Clear Targets</button>
                <button
                  onClick={() => setIsDeleteModalOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-danger-600 text-white rounded hover:bg-danger-700 transition-colors shadow-sm"
                >
                  <Trash2 className="h-3 w-3" /> Execute Purge
                </button>
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
          <Table className="text-xs sm:text-sm">
            <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider border-b border-neutral-200">
              <TableRow>
                <TableHead className="w-[36px] pl-3 sm:pl-6 pr-1 py-2 sm:py-3">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 sm:h-4 sm:w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                    checked={filteredInventory.length > 0 && selectedItemIds.length === filteredInventory.length}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedItemIds(filteredInventory.map(i => i.id));
                      else setSelectedItemIds([]);
                    }}
                  />
                </TableHead>
                <TableHead className="px-2 sm:px-3 py-2 sm:py-3 font-semibold cursor-pointer select-none hover:text-brand-600 transition-colors" onClick={() => { setSortDirection(sortKey === 'name' && sortDirection === 'asc' ? 'desc' : 'asc'); setSortKey('name') }}>Item Name</TableHead>
                <TableHead className="px-2 sm:px-3 py-2 sm:py-3 font-semibold cursor-pointer select-none hover:text-brand-600 transition-colors hidden sm:table-cell" onClick={() => { setSortDirection(sortKey === 'category' && sortDirection === 'asc' ? 'desc' : 'asc'); setSortKey('category') }}>Category</TableHead>
                <TableHead className="py-2 sm:py-3 font-semibold text-neutral-500 hidden md:table-cell">Unit</TableHead>
                <TableHead className="py-2 sm:py-3 font-semibold cursor-pointer select-none hover:text-brand-600 transition-colors hidden lg:table-cell" onClick={() => { setSortDirection(sortKey === 'supplier' && sortDirection === 'asc' ? 'desc' : 'asc'); setSortKey('supplier') }}>Preferred Supplier</TableHead>
                <TableHead className="py-2 sm:py-3 font-semibold text-neutral-500">Stock &amp; Par</TableHead>
                <TableHead className="py-2 sm:py-3 font-semibold text-neutral-500 hidden sm:table-cell">Cost / Unit</TableHead>
                <TableHead className="py-2 sm:py-3 font-semibold text-neutral-500">Status</TableHead>
                <TableHead className="px-2 sm:px-4 py-2 sm:py-3 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredInventory.length > 0 ? pagedInventory.map((item) => {
                const stockRatio = item.inStock / item.parLevel;
                const isCritical = stockRatio < 0.3;
                const isLowStock = stockRatio >= 0.3 && stockRatio <= 0.7;

                return (
                  <TableRow
                    key={item.id}
                    className={`hover:bg-neutral-50/50 cursor-pointer transition-colors ${selectedItemIds.includes(item.id) ? 'bg-brand-50/30' : ''}`}
                    onClick={() => openItemDrawer(item)}
                  >
                    <TableCell className="pl-3 sm:pl-6 pr-1 py-2.5 sm:py-4">
                      <div onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-neutral-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                          checked={selectedItemIds.includes(item.id)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedItemIds([...selectedItemIds, item.id]);
                            else setSelectedItemIds(selectedItemIds.filter(id => id !== item.id));
                          }}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="px-2 sm:px-3 py-2.5 sm:py-4">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-neutral-900 text-xs sm:text-sm leading-tight">{item.name}</span>
                        {item.itemType === 'Preparation' && <Badge variant="warning" className="text-[9px] px-1 py-0 border-none bg-orange-100 text-orange-700">PREP</Badge>}
                        {item.itemType === 'Finished Good' && <Badge variant="success" className="text-[9px] px-1 py-0 border-none bg-emerald-100 text-emerald-700">FG</Badge>}
                        {/* HQ-only: Shared Product badge — shown when ≥ 2 rows share this item_id */}
                        {isHqAdmin(user) && item.itemId && (linkedCountByItemId.get(item.itemId) ?? 0) > 1 && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setSharedLinkedDrawerItem(item); }}
                            title={`Shared across ${linkedCountByItemId.get(item.itemId)} locations — click to inspect`}
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-violet-100 text-violet-700 border border-violet-200 hover:bg-violet-200 transition-colors cursor-pointer select-none"
                          >
                            <Link2 className="h-2.5 w-2.5" />
                            Shared &bull; {linkedCountByItemId.get(item.itemId)}
                          </button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="px-2 sm:px-3 py-2.5 sm:py-4 hidden sm:table-cell">
                      <span className="text-[10px] sm:text-xs font-semibold px-1.5 sm:px-2 py-0.5 sm:py-1 bg-neutral-100 text-neutral-600 border border-neutral-200 rounded-md whitespace-nowrap">{item.category}</span>
                    </TableCell>
                    <TableCell className="py-2.5 sm:py-4 hidden md:table-cell">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">{item.baseUnit || item.unit}</span>
                        {item.purchaseUnits && item.purchaseUnits.length > 0 && (
                          <span className="text-[10px] text-neutral-400">
                            Buy: {item.purchaseUnits.find((u: any) => u.isPrimary)?.name || item.purchaseUnits[0].name}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 sm:py-4 hidden lg:table-cell">
                      {(() => {
                        const displayName = item.preferredSupplierName ?? getSupplierName(item.supplierId);
                        console.log('[ListRow supplier]', { id: item.id, name: item.name, preferredSupplierName: item.preferredSupplierName, supplierId: item.supplierId, displayed: displayName });
                        return <span className="text-xs sm:text-sm font-medium text-neutral-700 truncate max-w-[120px] block">{displayName}</span>;
                      })()}
                    </TableCell>
                    <TableCell className="py-2.5 sm:py-4">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-baseline gap-0.5">
                          <span className={`text-xs sm:text-sm font-bold ${isCritical ? "text-danger-600" : isLowStock ? "text-warning-600" : "text-neutral-900"}`}>
                            {item.inStock}
                          </span>
                          <span className="text-[10px] text-neutral-500">/ {item.parLevel} {item.baseUnit || item.unit}</span>
                        </div>
                        {item.purchaseUnits && item.purchaseUnits.length > 0 && (() => {
                          const pUnit = item.purchaseUnits.find((u: any) => u.isPrimary) || item.purchaseUnits[0];
                          const pStock = (item.inStock / pUnit.conversion).toFixed(1);
                          return <span className="text-[10px] text-brand-600 font-semibold block">{pStock} {pUnit.name}s</span>
                        })()}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 sm:py-4 text-xs sm:text-sm text-neutral-700 hidden sm:table-cell">
                      ${(item.preferredCost ?? item.cost ?? 0).toFixed(2)}
                    </TableCell>
                    <TableCell className="py-2.5 sm:py-4">
                      {isCritical ? (
                        <Badge variant="danger" className="text-[10px]">Critical</Badge>
                      ) : isLowStock ? (
                        <Badge variant="warning" className="text-[10px]">Low</Badge>
                      ) : (
                        <Badge variant="success" className="text-[10px]">Healthy</Badge>
                      )}
                    </TableCell>
                    <TableCell className="px-2 sm:px-4 py-2.5 sm:py-4 text-right">
                      <div
                        className="flex items-center justify-end gap-1.5"
                        onClick={e => e.stopPropagation()}
                      >
                        {(isLowStock || isCritical) && (
                          <button
                            onClick={(e) => handleQuickReorder(item, e)}
                            className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 bg-brand-50 hover:bg-brand-100 text-brand-700 text-xs font-semibold rounded-md transition-colors shadow-sm border border-brand-200"
                          >
                            <ShoppingCart className="h-3 w-3" />
                            <span className="hidden md:inline">Quick Reorder</span>
                          </button>
                        )}
                        {/* Three-dot action menu */}
                        <div className="relative">
                          <button
                            className="p-1.5 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded-md transition-colors"
                            onClick={() => setOpenMenuId(openMenuId === item.id ? null : item.id)}
                            aria-label="Item actions"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                          {openMenuId === item.id && (
                            <>
                              {/* Backdrop to close on outside click */}
                              <div
                                className="fixed inset-0 z-10"
                                onClick={() => setOpenMenuId(null)}
                              />
                              <div className="absolute right-0 top-8 z-20 bg-white border border-neutral-200 rounded-xl shadow-xl py-1 min-w-[160px] animate-in fade-in slide-in-from-top-1 duration-100">
                                <button
                                  className="w-full text-left px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 flex items-center gap-2.5 transition-colors"
                                  onClick={() => openEditDrawer(item)}
                                >
                                  <Save className="h-3.5 w-3.5 text-brand-600" /> Edit Item
                                </button>
                                <button
                                  className="w-full text-left px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 flex items-center gap-2.5 transition-colors"
                                  onClick={() => { setOpenMenuId(null); openItemDrawer(item); }}
                                >
                                  <ArrowUp className="h-3.5 w-3.5 text-success-600" /> Adjust Stock
                                </button>
                                <div className="border-t border-neutral-100 my-1" />
                                <button
                                  className="w-full text-left px-4 py-2.5 text-sm font-medium text-danger-600 hover:bg-danger-50 flex items-center gap-2.5 transition-colors"
                                  onClick={() => handleDeleteItem(item)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" /> Delete Item
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              }) : (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10 text-neutral-500 text-sm">
                    No inventory items match your active filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>{/* /overflow-x-auto */}

          {/* ── Pagination controls ─────────────────────────────────────── */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-100 bg-white">
            <span className="text-xs text-neutral-500 select-none">
              {filteredInventory.length === 0
                ? "No items"
                : `Showing ${displayStart}–${displayEnd} of ${filteredInventory.length} items`}
            </span>
            <div className="flex items-center gap-2">
              <button
                id="inventory-pagination-prev"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={safeCurrentPage <= 1}
                className="px-3 py-1.5 text-xs font-semibold rounded-md border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ← Previous
              </button>
              <span className="text-xs text-neutral-500 select-none">
                Page {safeCurrentPage} of {totalPages}
              </span>
              <button
                id="inventory-pagination-next"
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={safeCurrentPage >= totalPages}
                className="px-3 py-1.5 text-xs font-semibold rounded-md border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next →
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Item Detail Drawer */}
      <Drawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        title={selectedItem?.name || "Item Details"}
        description={`${selectedItem?.category} • Cost: $${selectedItem?.cost?.toFixed(2)}/${selectedItem?.unit}`}
        footer={
          <button
            onClick={() => setIsDrawerOpen(false)}
            className="w-full py-2 bg-neutral-100 text-neutral-800 rounded-lg font-medium text-sm hover:bg-neutral-200 transition-colors"
          >
            Close Drawer
          </button>
        }
      >
        {selectedItem && (
          <div className="space-y-8">
            <div className="flex justify-center mb-2">
              <div className="inline-flex bg-neutral-100 border border-neutral-200 rounded-lg p-1">
                <button onClick={() => setUserRole("HQ")} className={`px-4 py-1.5 text-xs font-bold rounded-md transition-colors ${userRole === "HQ" ? 'bg-white shadow-sm text-brand-700' : 'text-neutral-500 hover:text-neutral-700'}`}>HQ View</button>
                <button onClick={() => setUserRole("Location")} className={`px-4 py-1.5 text-xs font-bold rounded-md transition-colors ${userRole === "Location" ? 'bg-white shadow-sm text-brand-700' : 'text-neutral-500 hover:text-neutral-700'}`}>Location View</button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Current Stock</p>
                <div className="mt-1 flex items-end gap-2">
                  <span className={`text-3xl font-bold ${selectedItem.inStock < selectedItem.parLevel ? 'text-danger-600' : 'text-neutral-900'}`}>{selectedItem.inStock}</span>
                  <span className="text-sm text-neutral-500 font-medium mb-1">/ {selectedItem.parLevel} {selectedItem.unit}</span>
                </div>
              </div>
              <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Total Value Held</p>
                <div className="mt-1">
                  <span className="text-3xl font-bold text-neutral-900">${(selectedItem.inStock * selectedItem.cost).toFixed(2)}</span>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-bold text-neutral-900 mb-3 uppercase tracking-wider flex items-center justify-between border-b border-neutral-100 pb-2">
                <span className="flex items-center gap-2"><ArrowUp className="h-4 w-4 text-brand-600" /> Stock Adjustment</span>
                <span className="text-[10px] text-neutral-400 font-medium uppercase">{userRole} access granted</span>
              </h3>
              <div className="bg-white border border-neutral-200 rounded-lg p-4 space-y-4 shadow-sm">
                <div className="flex gap-2">
                  <button onClick={() => setAdjType("Add")} className={`flex-1 py-1.5 border rounded flex items-center justify-center gap-1.5 text-xs font-semibold transition-all ${adjType === "Add" ? 'ring-2 ring-offset-1 text-success-700 bg-success-50 border-success-200 ring-success-500' : 'bg-white text-neutral-500 hover:bg-neutral-50'}`}><Plus className="h-3 w-3" /> Add</button>
                  <button onClick={() => setAdjType("Remove")} className={`flex-1 py-1.5 border rounded flex items-center justify-center gap-1.5 text-xs font-semibold transition-all ${adjType === "Remove" ? 'ring-2 ring-offset-1 text-warning-700 bg-warning-50 border-warning-200 ring-warning-500' : 'bg-white text-neutral-500 hover:bg-neutral-50'}`}><ArrowDown className="h-3 w-3" /> Remove</button>
                  <button onClick={() => setAdjType("Waste")} className={`flex-1 py-1.5 border rounded flex items-center justify-center gap-1.5 text-xs font-semibold transition-all ${adjType === "Waste" ? 'ring-2 ring-offset-1 text-danger-700 bg-danger-50 border-danger-200 ring-danger-500' : 'bg-white text-neutral-500 hover:bg-neutral-50'}`}><Trash2 className="h-3 w-3" /> Waste</button>
                </div>
                <div className="flex gap-3">
                  <div className="flex-1 space-y-1.5">
                    <label className="text-xs font-semibold text-neutral-900">Quantity</label>
                    <input type="number" min="0" step="0.1" value={adjQty} onChange={(e) => setAdjQty(e.target.value)} className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g., 2.5" />
                  </div>
                  <div className="flex-1 space-y-1.5">
                    <label className="text-xs font-semibold text-neutral-900">Unit Transacted</label>
                    <select value={adjUnit} onChange={(e) => setAdjUnit(e.target.value)} className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                      {selectedItem.purchaseUnits ? selectedItem.purchaseUnits.map((u: any) => (
                        <option key={u.name} value={u.name}>{u.name} (x{u.conversion} {selectedItem.baseUnit || selectedItem.unit})</option>
                      )) : (
                        <option value={selectedItem.baseUnit || selectedItem.unit}>{selectedItem.baseUnit || selectedItem.unit}</option>
                      )}
                    </select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-900">Notes / Reason</label>
                  <input type="text" value={adjNotes} onChange={(e) => setAdjNotes(e.target.value)} className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Optional details..." />
                </div>
                <button disabled={!adjQty || parseFloat(adjQty) <= 0} onClick={saveAdjustment} className="w-full py-2 bg-neutral-900 text-white rounded text-sm font-semibold hover:bg-neutral-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                  <Save className="h-4 w-4" /> Commit Adjustment
                </button>
              </div>
            </div>

            {userRole === "HQ" && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-bold text-neutral-900 mb-3 uppercase tracking-wider flex items-center justify-between border-b border-neutral-100 pb-2">
                    <span className="flex items-center gap-2"><Save className="h-4 w-4 text-brand-600" /> Multi-Unit Configuration</span>
                    <span className="text-[10px] text-brand-600 font-bold bg-brand-50 px-2 py-0.5 rounded uppercase">HQ Only</span>
                  </h3>
                  <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-4 space-y-4 shadow-sm">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-neutral-900">Base Unit (Calculations)</label>
                      <input type="text" value={editBaseUnit} onChange={(e) => setEditBaseUnit(e.target.value)} className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white" placeholder="e.g. kg, lb, L" />
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-neutral-900 flex justify-between">
                        Purchase Units (Ordering)
                        <button onClick={() => setEditPurchaseUnits([...editPurchaseUnits, { name: "", conversion: 1, isPrimary: editPurchaseUnits.length === 0 }])} className="text-brand-600 hover:text-brand-700 font-bold flex items-center gap-1"><Plus className="h-3 w-3" /> Add</button>
                      </label>
                      {editPurchaseUnits.length === 0 ? (
                        <div className="text-xs text-neutral-500 italic py-2">No purchase units mapped. System will fall back to base unit for POs.</div>
                      ) : editPurchaseUnits.map((pu, idx) => (
                        <div key={idx} className="flex gap-2 items-center bg-white p-2 rounded border border-neutral-200">
                          <input type="radio" name="primary_unit" checked={pu.isPrimary} onChange={() => {
                            const copy = [...editPurchaseUnits];
                            copy.forEach(u => u.isPrimary = false);
                            copy[idx].isPrimary = true;
                            setEditPurchaseUnits(copy);
                          }} className="w-4 h-4 text-brand-600" title="Set as Primary for Auto-PO" />
                          <input type="text" value={pu.name} onChange={(e) => {
                            const copy = [...editPurchaseUnits];
                            copy[idx].name = e.target.value;
                            setEditPurchaseUnits(copy);
                          }} className="flex-1 py-1.5 px-2 border border-neutral-200 rounded text-sm outline-none focus:border-brand-500" placeholder="Name (e.g. Case)" />
                          <span className="text-xs text-neutral-500">=</span>
                          <input type="number" min="0" step="0.01" value={pu.conversion} onChange={(e) => {
                            const copy = [...editPurchaseUnits];
                            copy[idx].conversion = e.target.value;
                            setEditPurchaseUnits(copy);
                          }} className="w-20 py-1.5 px-2 border border-neutral-200 rounded text-sm outline-none focus:border-brand-500" placeholder="Qty" />
                          <span className="text-xs text-neutral-500 truncate w-8">{editBaseUnit || 'base'}</span>
                          <button onClick={() => {
                            const copy = editPurchaseUnits.filter((_, i) => i !== idx);
                            if (pu.isPrimary && copy.length > 0) copy[0].isPrimary = true;
                            setEditPurchaseUnits(copy);
                          }} className="p-1.5 text-neutral-400 hover:text-danger-600 hover:bg-danger-50 rounded transition-colors"><Trash2 className="h-3 w-3" /></button>
                        </div>
                      ))}
                    </div>

                    <div className="space-y-1.5 focus-within:z-10 mt-2 border-t border-neutral-200 pt-3">
                      <label className="text-xs font-semibold text-neutral-900">
                        {editPurchaseUnits.some(u => u.isPrimary && parseFloat(u.conversion) > 0) ? `Purchase Cost (/ ${(editPurchaseUnits.find(u => u.isPrimary) || editPurchaseUnits[0]).name})` : 'Cost / Base Unit'}
                      </label>
                      <input type="number" step="0.1" value={editPurchaseCost} onChange={(e) => setEditPurchaseCost(e.target.value)} className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white" placeholder="$0.00" />
                      {editPurchaseUnits.some(u => u.isPrimary && parseFloat(u.conversion) > 0) && editPurchaseCost && !isNaN(parseFloat(editPurchaseCost)) && (
                        <p className="text-[10px] text-brand-600 font-medium mt-1">
                          Yields root base cost: ${(parseFloat(editPurchaseCost) / parseFloat((editPurchaseUnits.find(u => u.isPrimary) || editPurchaseUnits[0]).conversion)).toFixed(2)} / {editBaseUnit || 'base'}
                        </p>
                      )}
                    </div>

                    <button onClick={saveUnitInfo} className="w-full py-2 bg-neutral-900 text-white rounded text-sm font-semibold hover:bg-neutral-800 transition-colors flex items-center justify-center gap-2">
                      <Save className="h-4 w-4" /> Save Unit Configuration
                    </button>
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-neutral-900 mb-3 uppercase tracking-wider flex items-center justify-between border-b border-neutral-100 pb-2">
                    <span className="flex items-center gap-2"><Save className="h-4 w-4 text-brand-600" /> Par Level Adjustment</span>
                    <span className="text-[10px] text-brand-600 font-bold bg-brand-50 px-2 py-0.5 rounded uppercase">HQ Only</span>
                  </h3>
                  <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-4 space-y-4 shadow-sm">
                    <div className="flex gap-4 items-end">
                      <div className="space-y-1.5 flex-1">
                        <label className="text-xs font-semibold text-neutral-900">New Par Benchmark ({selectedItem.unit})</label>
                        <input type="number" min="0" step="0.1" value={newParLevel} onChange={(e) => setNewParLevel(e.target.value)} className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white" placeholder={selectedItem.parLevel.toString()} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-neutral-900">Adjustment Reasoning</label>
                      <input type="text" value={parNotes} onChange={(e) => setParNotes(e.target.value)} className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white" placeholder="e.g. Updating bounds for seasonal menu..." />
                    </div>
                    <button disabled={!newParLevel || parseFloat(newParLevel) === selectedItem.parLevel} onClick={saveParLevel} className="w-full py-2 bg-brand-600 text-white rounded text-sm font-semibold hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                      <Save className="h-4 w-4" /> Enforce Par Shift
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div>
              <h3 className="text-sm font-bold text-neutral-900 mb-3 uppercase tracking-wider flex items-center gap-2 border-b border-neutral-100 pb-2">
                <History className="h-4 w-4 text-brand-600" /> Recent Activity Log
              </h3>
              <div className="space-y-3">
                {(!activityData[selectedItem.id] || activityData[selectedItem.id].length === 0) ? (
                  <p className="text-xs text-neutral-500 italic">No historical adjustments logged for this item yet.</p>
                ) : (
                  activityData[selectedItem.id].map((log, idx) => (
                    <div key={idx} className="flex items-start justify-between bg-neutral-50 rounded-lg p-3 border border-neutral-100">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${log.type === 'Add' ? 'bg-success-100 text-success-700' : log.type === 'Remove' ? 'bg-warning-100 text-warning-700' : log.type === 'Par Update' ? 'bg-brand-100 text-brand-700' : 'bg-danger-100 text-danger-700'}`}>{log.type}</span>
                          <span className="text-sm font-bold text-neutral-900">{log.type === 'Par Update' ? `${log.qty} net shift` : log.baseTransacted ? `${log.baseTransacted > 0 ? '+' : ''}${log.baseTransacted} ${selectedItem.baseUnit || selectedItem.unit} (${log.qty})` : `${log.qty > 0 ? '+' : ''}${log.qty} ${selectedItem.unit}`}</span>
                        </div>
                        {log.notes && <p className="text-[11px] font-medium text-neutral-600 mt-1">{log.notes}</p>}
                        {log.user && <p className="text-[10px] text-neutral-400 uppercase tracking-wide mt-1">- Authenticated via {log.user}</p>}
                      </div>
                      <div className="text-right flex flex-col">
                        <span className="text-xs font-medium text-neutral-700">{log.date}</span>
                        <span className="text-[10px] text-neutral-400">{log.time}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </Drawer>

      {/* ── Edit Item Drawer ─────────────────────────────────────────────────── */}
      <Drawer
        isOpen={isEditDrawerOpen}
        onClose={() => setIsEditDrawerOpen(false)}
        title="Edit Item"
        description={editItem ? `Editing: ${editItem.name}` : ""}
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => setIsEditDrawerOpen(false)}
              className="px-4 py-2 flex-1 text-sm font-medium bg-neutral-100 text-neutral-700 border border-neutral-200 rounded-lg hover:bg-neutral-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleEditSave}
              disabled={isSavingEdit}
              className={`px-4 py-2 flex-1 text-sm font-medium rounded-lg transition-colors shadow-sm flex items-center justify-center gap-2 ${isSavingEdit ? "bg-neutral-400 cursor-not-allowed text-white" : "bg-brand-600 text-white hover:bg-brand-700"
                }`}
            >
              {isSavingEdit
                ? <><div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving...</>
                : <><Save className="h-4 w-4" /> Save Changes</>}
            </button>
          </div>
        }
      >
        {editItem && (
          <div className="space-y-4">
            {/* Name */}
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

            {/* Type + Category + Base Unit */}
            <div className="grid grid-cols-3 gap-3">
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
                <select
                  value={editItem.category}
                  onChange={e => setEditItem({ ...editItem, category: e.target.value })}
                  className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                >
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
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

            {/* Purchase Units */}
            <div className="space-y-2 border border-neutral-200 p-3 rounded-lg bg-neutral-50">
              <label className="text-xs font-semibold text-neutral-900 uppercase flex justify-between">
                Purchase Units (Ordering)
                <button
                  onClick={() => setEditItem({ ...editItem, purchaseUnits: [...(editItem.purchaseUnits || []), { name: "", conversion: 1, isPrimary: !(editItem.purchaseUnits?.length) }] })}
                  className="text-brand-600 hover:text-brand-700 font-bold flex items-center gap-1"
                >
                  <Plus className="h-3 w-3" /> Add
                </button>
              </label>
              {(!editItem.purchaseUnits || editItem.purchaseUnits.length === 0) ? (
                <div className="text-xs text-neutral-500 italic py-1">No purchase units — falls back to base unit.</div>
              ) : editItem.purchaseUnits.map((pu: any, idx: number) => (
                <div key={idx} className="flex gap-2 items-center bg-white p-2 rounded border border-neutral-200">
                  <input type="radio" name="edit_primary_unit" checked={pu.isPrimary} onChange={() => {
                    const copy = [...editItem.purchaseUnits];
                    copy.forEach((u: any) => u.isPrimary = false);
                    copy[idx].isPrimary = true;
                    setEditItem({ ...editItem, purchaseUnits: copy });
                  }} className="w-4 h-4 text-brand-600" />
                  <input type="text" value={pu.name} onChange={e => {
                    const copy = [...editItem.purchaseUnits];
                    copy[idx].name = e.target.value;
                    setEditItem({ ...editItem, purchaseUnits: copy });
                  }} className="flex-1 py-1.5 px-2 border border-neutral-200 rounded text-sm outline-none focus:border-brand-500" placeholder="e.g. Case" />
                  <span className="text-xs text-neutral-500">=</span>
                  <input type="number" min="0" step="0.01" value={pu.conversion} onChange={e => {
                    const copy = [...editItem.purchaseUnits];
                    copy[idx].conversion = e.target.value;
                    setEditItem({ ...editItem, purchaseUnits: copy });
                  }} className="w-20 py-1.5 px-2 border border-neutral-200 rounded text-sm outline-none focus:border-brand-500" placeholder="Qty" />
                  <span className="text-xs text-neutral-500 w-8 truncate">{editBaseUnit || "base"}</span>
                  <button onClick={() => {
                    const copy = editItem.purchaseUnits.filter((_: any, i: number) => i !== idx);
                    if (pu.isPrimary && copy.length > 0) copy[0].isPrimary = true;
                    setEditItem({ ...editItem, purchaseUnits: copy });
                  }} className="p-1.5 text-neutral-400 hover:text-danger-600 hover:bg-danger-50 rounded transition-colors">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>

            {/* Preferred Supplier — derived from purchase_options, NOT inventory_items */}
            {(() => {
              const preferred = editPurchaseOptions.find((p: any) => p.isPreferred);
              const lowestPrice = editPurchaseOptions.length > 0
                ? editPurchaseOptions.reduce((min: any, p: any) => p.unitPrice < min.unitPrice ? p : min)
                : null;
              return (
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Preferred Supplier</label>
                  <div className={`w-full p-2 border rounded text-sm flex items-center justify-between gap-2 ${preferred ? 'border-violet-300 bg-violet-50' : 'border-neutral-200 bg-neutral-50'
                    }`}>
                    <span className={preferred ? 'font-semibold text-violet-800' : 'text-neutral-400 italic'}>
                      {preferred ? preferred.supplierName : (editPurchaseOptions.length > 0 ? 'None set — click Make Preferred below' : 'No suppliers yet')}
                    </span>
                    {preferred && (
                      <span className="text-[10px] font-bold uppercase text-violet-600 bg-violet-100 border border-violet-300 px-1.5 py-0.5 rounded whitespace-nowrap">★ Preferred</span>
                    )}
                    {!preferred && lowestPrice && (
                      <span className="text-[10px] text-neutral-400">(lowest: {lowestPrice.supplierName})</span>
                    )}
                  </div>
                  {preferred?.supplierProductName && (
                    <p className="text-[11px] text-neutral-500">{preferred.supplierProductName} · {preferred.purchaseUom}{preferred.packQty ? ` · ${preferred.packQty}${preferred.packUom ? ' ' + preferred.packUom : ''}` : ''}</p>
                  )}
                </div>
              );
            })()}

            {/* Stock / Par / Cost */}
            <div className="grid grid-cols-3 gap-3">
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
                {(() => {
                  // Label derives from purchase_options for context.
                  // Value is always editPurchaseCost — kept in sync by makePreferred / deletePurchOpt / commitNewPurchOpt.
                  const preferred = editPurchaseOptions.find((p: any) => p.isPreferred);
                  const lowest = editPurchaseOptions.length > 0
                    ? [...editPurchaseOptions].sort((a: any, b: any) => a.unitPrice - b.unitPrice)[0]
                    : null;
                  const autoLabel = preferred
                    ? `Cost — from ${preferred.supplierName}`
                    : lowest
                      ? `Cost — lowest (${lowest.supplierName})`
                      : editItem.purchaseUnits?.some((u: any) => u.isPrimary && parseFloat(u.conversion) > 0)
                        ? `Cost / ${(editItem.purchaseUnits.find((u: any) => u.isPrimary) || editItem.purchaseUnits[0]).name}`
                        : 'Cost / Base Unit';
                  return (
                    <>
                      <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">{autoLabel}</label>
                      <input
                        type="number" step="0.01"
                        value={editPurchaseCost}
                        onChange={e => setEditPurchaseCost(e.target.value)}
                        className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        placeholder="$0.00"
                      />
                      {preferred && (
                        <p className="text-[10px] text-violet-500">Price from preferred supplier. Edit to override.</p>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Structured Packaging accordion */}
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
                  <p className="text-[10px] text-neutral-400">Overrides Base Unit for recipe costing. Backfills Base Unit only when Base Unit is blank.</p>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Allowed Recipe UOMs</label>
                  <input type="text" value={editAllowedUoms} onChange={e => setEditAllowedUoms(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="ml, l, fl oz (comma-separated)" />
                  <p className="text-[10px] text-neutral-400">Soft warning only — does not block recipe saving.</p>
                </div>
              </div>
            </details>

            {/* ── SUPPLIERS / PURCHASE OPTIONS ─────────────────────────────── */}
            {console.log("editPurchaseOptions:", editPurchaseOptions) as any}
            <div className="space-y-1 border border-neutral-200 rounded-lg overflow-hidden">

              {/* Section header */}
              <div className="flex items-center justify-between px-3 py-2 bg-neutral-50 border-b border-neutral-200">
                <span className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                  Suppliers ({editPurchaseOptions.length})
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
              {isLoadingPurchOpts && (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-neutral-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading suppliers…
                </div>
              )}

              {/* Empty */}
              {!isLoadingPurchOpts && editPurchaseOptions.length === 0 && (
                <p className="text-xs text-neutral-400 italic px-3 py-3">No suppliers yet. Click "+ Add Supplier" to add one.</p>
              )}

              {/* Rows — always rendered when data exists */}
              {editPurchaseOptions.map((row: any) => (
                <div
                  key={row.id}
                  className={`px-3 py-2.5 border-b border-neutral-100 last:border-b-0 ${row.isPreferred ? 'bg-violet-50' : 'bg-white'}`}
                >
                  {/* Row header: name + badges + actions */}
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      {row.isPreferred && (
                        <span className="text-[10px] font-bold uppercase text-violet-700 bg-violet-100 border border-violet-300 px-1.5 py-0.5 rounded whitespace-nowrap">★ Preferred</span>
                      )}
                      <span className="text-xs font-semibold text-neutral-800 truncate">{row.supplierName || '—'}</span>
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
                      <input
                        type="text"
                        value={row.supplierName}
                        onChange={e => updatePurchOptField(row.id, 'supplierName', e.target.value)}
                        className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-neutral-400 font-semibold uppercase block mb-0.5">Supplier Product Name</label>
                      <input
                        type="text"
                        value={row.supplierProductName ?? ''}
                        onChange={e => updatePurchOptField(row.id, 'supplierProductName', e.target.value || null)}
                        className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
                        placeholder="Optional"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-2">
                    <div>
                      <label className="text-[10px] text-neutral-400 font-semibold uppercase block mb-0.5">Purchase UOM</label>
                      <input
                        type="text"
                        value={row.purchaseUom}
                        onChange={e => updatePurchOptField(row.id, 'purchaseUom', e.target.value)}
                        className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-neutral-400 font-semibold uppercase block mb-0.5">Pack Qty</label>
                      <input
                        type="number" min="0" step="any"
                        value={row.packQty ?? ''}
                        onChange={e => updatePurchOptField(row.id, 'packQty', e.target.value !== '' ? Number(e.target.value) : null)}
                        className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-neutral-400 font-semibold uppercase block mb-0.5">Pack UOM</label>
                      <input
                        type="text"
                        value={row.packUom ?? ''}
                        onChange={e => updatePurchOptField(row.id, 'packUom', e.target.value || null)}
                        className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-neutral-400 font-semibold uppercase block mb-0.5">Unit Price ($)</label>
                      <input
                        type="number" min="0" step="0.01"
                        value={row.unitPrice}
                        onChange={e => updatePurchOptField(row.id, 'unitPrice', parseFloat(e.target.value) || 0)}
                        className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
                      />
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
                      <input
                        autoFocus
                        type="text"
                        value={newPurchOpt.supplierName}
                        onChange={e => setNewPurchOpt((p: any) => ({ ...p, supplierName: e.target.value }))}
                        className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-violet-400"
                        placeholder="Supplier Co."
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-neutral-500 font-semibold uppercase block mb-0.5">Supplier Product Name</label>
                      <input
                        type="text"
                        value={newPurchOpt.supplierProductName}
                        onChange={e => setNewPurchOpt((p: any) => ({ ...p, supplierProductName: e.target.value }))}
                        className="w-full px-2 py-1 border border-neutral-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-violet-400"
                        placeholder="Optional"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
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
            {/* ── end SUPPLIERS ─────────────────────────────────────────────── */}

          </div>
        )}
      </Drawer>

      {/* Add Item Drawer */}
      <Drawer
        isOpen={isAddDrawerOpen}
        onClose={() => setIsAddDrawerOpen(false)}
        title="Add Single Item"
        description="Manually insert a specific structural item into the inventory register."
        footer={
          <div className="flex items-center gap-3">
            <button onClick={() => setIsAddDrawerOpen(false)} className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors w-full">Cancel</button>
            <button onClick={handleAddNewItem} className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm w-full">Save Item</button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Item Name</label>
            <input type="text" value={newItem.name} onChange={e => setNewItem({ ...newItem, name: e.target.value })} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. Garlic Powder" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Node Taxonomy</label>
              <select value={newItem.itemType} onChange={e => setNewItem({ ...newItem, itemType: e.target.value })} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                <option value="Raw">Raw Asset</option>
                <option value="Preparation">Preparation Base</option>
                <option value="Finished Good">Finished Good</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Category</label>
              <select value={newItem.category} onChange={e => setNewItem({ ...newItem, category: e.target.value })} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Base Unit (Calculations)</label>
              <input type="text" value={newItem.unit} onChange={e => setNewItem({ ...newItem, unit: e.target.value })} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="kg, L, box..." />
            </div>
          </div>

          <div className="space-y-2 border border-neutral-200 p-3 rounded-lg bg-neutral-50 shadow-sm">
            <label className="text-xs font-semibold text-neutral-900 uppercase flex justify-between">
              Purchase Units (Ordering)
              <button onClick={() => setNewItem({ ...newItem, purchaseUnits: [...newItem.purchaseUnits, { name: "", conversion: 1, isPrimary: newItem.purchaseUnits.length === 0 }] })} className="text-brand-600 hover:text-brand-700 font-bold flex items-center gap-1"><Plus className="h-3 w-3" /> Add</button>
            </label>
            {newItem.purchaseUnits.length === 0 ? (
              <div className="text-xs text-neutral-500 italic py-2">No purchase units mapped. System will fall back to base unit for POs.</div>
            ) : newItem.purchaseUnits.map((pu, idx) => (
              <div key={idx} className="flex gap-2 items-center bg-white p-2 rounded border border-neutral-200">
                <input type="radio" name="new_primary_unit" checked={pu.isPrimary} onChange={() => {
                  const copy = [...newItem.purchaseUnits];
                  copy.forEach(u => u.isPrimary = false);
                  copy[idx].isPrimary = true;
                  setNewItem({ ...newItem, purchaseUnits: copy });
                }} className="w-4 h-4 text-brand-600" title="Set as Primary for Auto-PO" />
                <input type="text" value={pu.name} onChange={(e) => {
                  const copy = [...newItem.purchaseUnits];
                  copy[idx].name = e.target.value;
                  setNewItem({ ...newItem, purchaseUnits: copy });
                }} className="flex-1 py-1.5 px-2 border border-neutral-200 rounded text-sm outline-none focus:border-brand-500" placeholder="Name (e.g. Case)" />
                <span className="text-xs text-neutral-500">=</span>
                <input type="number" min="0" step="0.01" value={pu.conversion} onChange={(e) => {
                  const copy = [...newItem.purchaseUnits];
                  copy[idx].conversion = e.target.value;
                  setNewItem({ ...newItem, purchaseUnits: copy });
                }} className="w-20 py-1.5 px-2 border border-neutral-200 rounded text-sm outline-none focus:border-brand-500" placeholder="Qty" />
                <span className="text-xs text-neutral-500 truncate w-8">{newItem.unit || 'base'}</span>
                <button onClick={() => {
                  const copy = newItem.purchaseUnits.filter((_, i) => i !== idx);
                  if (pu.isPrimary && copy.length > 0) copy[0].isPrimary = true;
                  setNewItem({ ...newItem, purchaseUnits: copy });
                }} className="p-1.5 text-neutral-400 hover:text-danger-600 hover:bg-danger-50 rounded transition-colors"><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
          {/* ── Phase 2: Structured Packaging (Optional) ────────────────────── */}
          <details className="group border border-neutral-200 rounded-lg bg-neutral-50 shadow-sm">
            <summary className="flex items-center justify-between px-3 py-2.5 cursor-pointer select-none list-none">
              <span className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                Structured Packaging
              </span>
              <span className="text-[10px] text-neutral-400 font-medium group-open:hidden">Optional — for precise costing</span>
              <span className="text-[10px] text-brand-600 font-medium hidden group-open:inline">Hide</span>
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-3">
              <p className="text-[11px] text-neutral-500 leading-relaxed">
                Fill these fields to enable pack-based recipe costing. Leave blank to keep legacy behaviour.
              </p>

              {/* Row 1: Purchase UOM + Pack Qty */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Purchase UOM</label>
                  <select
                    value={newItem.purchaseUom}
                    onChange={e => setNewItem({ ...newItem, purchaseUom: e.target.value })}
                    className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                  >
                    <option value="">— not set —</option>
                    <option>case</option>
                    <option>bag</option>
                    <option>box</option>
                    <option>bottle</option>
                    <option>can</option>
                    <option>pack</option>
                    <option>ea</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Pack Qty</label>
                  <input
                    type="number" min="0" step="1"
                    value={newItem.packQty}
                    onChange={e => setNewItem({ ...newItem, packQty: e.target.value })}
                    className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                    placeholder="e.g. 12"
                  />
                  <p className="text-[10px] text-neutral-400">Inner units per purchase pack</p>
                </div>
              </div>

              {/* Row 2: Inner Unit Type + Inner Unit Size + Inner Unit UOM */}
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner Type</label>
                  <select
                    value={newItem.innerUnitType}
                    onChange={e => setNewItem({ ...newItem, innerUnitType: e.target.value })}
                    className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                  >
                    <option value="">— not set —</option>
                    <option>can</option>
                    <option>bottle</option>
                    <option>bag</option>
                    <option>ea</option>
                    <option>portion</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner Size</label>
                  <input
                    type="number" min="0" step="any"
                    value={newItem.innerUnitSize}
                    onChange={e => setNewItem({ ...newItem, innerUnitSize: e.target.value })}
                    className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                    placeholder="e.g. 330"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner UOM</label>
                  <select
                    value={newItem.innerUnitUom}
                    onChange={e => setNewItem({ ...newItem, innerUnitUom: e.target.value })}
                    className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                  >
                    <option value="">— not set —</option>
                    <option value="ml">ml</option>
                    <option value="l">l</option>
                    <option value="g">g</option>
                    <option value="kg">kg</option>
                    <option value="oz">oz</option>
                    <option value="lb">lb</option>
                    <option value="fl oz">fl oz</option>
                    <option value="ea">ea</option>
                  </select>
                </div>
              </div>

              {/* Row 3: Base UOM */}
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Base UOM (Costing)</label>
                <select
                  value={newItem.baseUomNew}
                  onChange={e => setNewItem({ ...newItem, baseUomNew: e.target.value })}
                  className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                >
                  <option value="">— same as Base Unit above —</option>
                  <option value="ml">ml</option>
                  <option value="l">l</option>
                  <option value="g">g</option>
                  <option value="kg">kg</option>
                  <option value="oz">oz</option>
                  <option value="lb">lb</option>
                  <option value="fl oz">fl oz</option>
                  <option value="ea">ea</option>
                </select>
                <p className="text-[10px] text-neutral-400">
                  Preferred unit for recipe costing. Overrides Base Unit above when set.
                  Backfills Base Unit only if Base Unit is currently blank.
                </p>
              </div>

              {/* Row 4: Allowed Recipe UOMs */}
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Allowed Recipe UOMs</label>
                <input
                  type="text"
                  value={newItem.allowedRecipeUoms}
                  onChange={e => setNewItem({ ...newItem, allowedRecipeUoms: e.target.value })}
                  className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                  placeholder="ml, l, fl oz  (comma-separated, optional)"
                />
                <p className="text-[10px] text-neutral-400">
                  If set, recipe builder shows a soft warning when a different unit is used. Does not block saving.
                </p>
              </div>

              {/* Live preview of pack cost computation */}
              {newItem.packQty && newItem.innerUnitSize && newItem.innerUnitUom && newItem.cost && (() => {
                try {
                  const totalQty = Number(newItem.packQty) * Number(newItem.innerUnitSize);
                  const cost = parseFloat(newItem.cost as string);
                  if (!isNaN(totalQty) && totalQty > 0 && !isNaN(cost) && cost > 0) {
                    const estimatedPerUnit = cost / totalQty;
                    return (
                      <div className="bg-brand-50 border border-brand-100 rounded-lg px-3 py-2 text-[11px] text-brand-700 font-medium">
                        Estimated: ${estimatedPerUnit.toFixed(4)} / {newItem.innerUnitUom || 'unit'} at recipe time
                      </div>
                    );
                  }
                } catch { return null; }
                return null;
              })()}
            </div>
          </details>

          {/* Supplier */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Preferred Supplier</label>
            <input list="supplier-options" type="text" value={newItem.supplier} onChange={e => setNewItem({ ...newItem, supplier: e.target.value })} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Select or type new supplier..." />
            <datalist id="supplier-options">
              {suppliersData.map(s => <option key={s.id} value={s.name} />)}
            </datalist>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Current Stock</label>
              <input type="number" step="1" value={newItem.inStock} onChange={e => setNewItem({ ...newItem, inStock: e.target.value })} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="0" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Par Level</label>
              <input type="number" step="1" value={newItem.parLevel} onChange={e => setNewItem({ ...newItem, parLevel: e.target.value })} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="0" />
            </div>
            {(() => {
              const pu = newItem.purchaseUnits.find((u: any) => u.isPrimary) || newItem.purchaseUnits[0];
              const hasValidPrimary = pu && pu.name && parseFloat(pu.conversion) > 0;

              return (
                <div className="space-y-1.5 focus-within:z-10">
                  <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">
                    {hasValidPrimary ? `Cost (per ${pu.name})` : 'Cost / Base Unit'}
                  </label>
                  <input type="number" step="0.1" value={newItem.cost} onChange={e => setNewItem({ ...newItem, cost: e.target.value })} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="$0.00" />
                  {hasValidPrimary && newItem.cost && !isNaN(parseFloat(newItem.cost)) && (
                    <p className="text-[10px] text-brand-600 font-medium mt-1">
                      Automatically yields core base cost: ${(parseFloat(newItem.cost) / parseFloat(pu.conversion)).toFixed(2)} / {newItem.unit || 'base'}
                    </p>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      </Drawer>

      {/* Import Drawer */}
      <Drawer
        isOpen={isImportDrawerOpen}
        onClose={() => setIsImportDrawerOpen(false)}
        title="Bulk Import Inventory"
        description="Upload a CSV file to rapidly ingest hundreds of item bounds simultaneously."
        footer={
          <div className="flex items-center gap-3">
            <button onClick={downloadTemplate} className="px-4 py-2 text-sm font-medium bg-neutral-100 text-neutral-700 border border-neutral-200 rounded-lg hover:bg-neutral-200 transition-colors w-full flex items-center justify-center gap-2"><Download className="h-4 w-4" /> Template.csv</button>
            <button onClick={commitImport} disabled={importPreview.length === 0 || isCommitting} className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm w-full disabled:opacity-50 flex items-center justify-center gap-2">
              {isCommitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isCommitting ? "Committing..." : "Commit Import"}
            </button>
          </div>
        }
      >
        <div className="space-y-6">
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-neutral-300 rounded-xl bg-neutral-50 p-8 text-center cursor-pointer hover:bg-neutral-100 hover:border-brand-400 transition-colors flex flex-col items-center justify-center gap-3"
          >
            <div className="p-3 bg-white border border-neutral-200 rounded-full shadow-sm text-neutral-600">
              <Upload className="h-6 w-6" />
            </div>
            <div>
              <p className="font-semibold text-neutral-900 text-sm">Click to select CSV File</p>
              <p className="text-xs text-neutral-500 mt-1">Columns must natively match the template.</p>
            </div>
            <input type="file" accept=".csv" className="hidden" ref={fileInputRef} onChange={handleCSVUpload} />
          </div>

          {importErrors.length > 0 && (
            <div className="bg-danger-50 border border-danger-200 rounded-lg p-4">
              <h4 className="text-sm font-bold text-danger-800 flex items-center gap-2 mb-2"><AlertTriangle className="h-4 w-4" /> Critical File Errors</h4>
              <ul className="list-disc list-inside text-xs text-danger-700 space-y-1">
                {importErrors.map((err, idx) => <li key={idx}>{err}</li>)}
              </ul>
            </div>
          )}

          {importPreview.length > 0 && (
            <div className="border border-neutral-200 rounded-lg overflow-hidden flex flex-col h-[280px]">
              <div className="bg-neutral-50 border-b border-neutral-200 p-3 flex justify-between items-center text-xs">
                <span className="font-semibold text-neutral-700 uppercase tracking-wider">Preview Buffer</span>
                <span className="font-medium text-brand-600">{importPreview.length} objects queued</span>
              </div>
              <div className="flex-1 overflow-y-auto">
                <Table>
                  <TableHeader className="bg-white sticky top-0 border-b border-neutral-100 shadow-sm z-10 text-[10px] uppercase text-neutral-500">
                    <TableRow>
                      <TableHead className="py-2">Item Struct</TableHead>
                      <TableHead className="py-2">Stock Bound</TableHead>
                      <TableHead className="py-2 text-right">Flags</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importPreview.map((row, idx) => (
                      <TableRow key={idx} className={row.isDuplicate ? "bg-warning-50" : "bg-white"}>
                        <TableCell className="py-2.5">
                          <div className="font-semibold text-xs text-neutral-900">{row.payload.name}</div>
                          <div className="text-[10px] text-neutral-500">{row.payload.category} • {row.payload.supplierText}</div>
                        </TableCell>
                        <TableCell className="py-2.5">
                          <div className="text-xs font-medium text-neutral-700">{row.payload.inStock} / {row.payload.parLevel} {row.payload.unit}</div>
                          <div className="text-[10px] text-brand-600 font-semibold">${row.payload.cost.toFixed(2)} cost</div>
                        </TableCell>
                        <TableCell className="py-2.5 text-right">
                          {row.isDuplicate ? (
                            overwriteExisting ? (
                              <Badge variant="warning" className="text-[9px] bg-warning-100 text-warning-800">Update Target</Badge>
                            ) : (
                              <Badge variant="warning" className="text-[9px]">Collision (Skip)</Badge>
                            )
                          ) : (
                            <Badge variant="success" className="text-[9px]">Valid</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      </Drawer>

      {/* Import History Drawer */}
      <Drawer
        isOpen={isHistoryDrawerOpen}
        onClose={() => setIsHistoryDrawerOpen(false)}
        title="Import History & Rollback"
        description="Review recent bulk operations. You can selectively roll back active batches if no subsequent modifications have occurred."
        footer={
          <button onClick={() => setIsHistoryDrawerOpen(false)} className="w-full py-2 bg-neutral-100 text-neutral-800 rounded-lg font-medium text-sm hover:bg-neutral-200 transition-colors">
            Close Subsystem
          </button>
        }
      >
        <div className="space-y-4">
          {importBatches.length === 0 ? (
            <div className="text-center py-12 text-neutral-500 text-sm bg-neutral-50 border border-neutral-200 rounded-xl">
              No past operations to map.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-end mb-2">
                <button
                  onClick={async () => {
                    if (confirm("Are you sure you want to clear all history? This will NOT revert the uploads, but simply wipe this log.")) {
                      const res = await saveImportBatches([]);
                      if (!res?.success) alert(`Failed to wipe: ${res?.error?.message}`);
                      else setImportBatches([]);
                    }
                  }}
                  className="text-xs font-semibold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-md transition-colors"
                >
                  Clear History Logs
                </button>
              </div>
              {importBatches.map((batch, idx) => (
                <div key={idx} className={`p-4 border rounded-xl space-y-3 ${batch.status === "Reverted" ? 'bg-neutral-50 border-neutral-200 opacity-75' : 'bg-white border-neutral-200 shadow-sm'}`}>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-neutral-900">{batch.fileName}</span>
                        <Badge variant={batch.status === "Reverted" ? "neutral" : "success"} className="text-[10px]">{batch.status}</Badge>
                      </div>
                      <p className="text-xs text-neutral-500 mt-0.5">{new Date(batch.timestamp).toLocaleString()}</p>
                    </div>
                    <p className="text-[10px] text-neutral-400 font-mono">{batch.batchId}</p>
                  </div>

                  <div className="grid grid-cols-3 gap-2 py-2 border-y border-neutral-100">
                    <div className="text-center">
                      <p className="text-xs text-neutral-500">New</p>
                      <p className="font-bold text-neutral-900 text-sm">{batch.metrics.new}</p>
                    </div>
                    <div className="text-center border-x border-neutral-100">
                      <p className="text-xs text-neutral-500">Updated</p>
                      <p className="font-bold text-neutral-900 text-sm">{batch.metrics.updated}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-neutral-500">Skipped</p>
                      <p className="font-bold text-neutral-900 text-sm">{batch.metrics.skipped}</p>
                    </div>
                  </div>

                  {batch.status !== "Reverted" && (
                    <button
                      onClick={() => revertBatch(batch.batchId)}
                      className="w-full py-1.5 flex items-center justify-center gap-1.5 text-xs font-semibold text-danger-700 bg-danger-50 hover:bg-danger-100 rounded-md transition-colors"
                    >
                      Undo Operation
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Drawer>

      {/* Delete Confirmation Subsystem */}
      <Drawer
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        title="Execute Bulk Purge"
        description="Permanently eradicate designated bounds from the active operational inventory."
        footer={
          <div className="flex items-center gap-3">
            <button onClick={() => setIsDeleteModalOpen(false)} className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors w-full">Abort Task</button>
            <button
              onClick={async () => {
                // Bulk delete: DELETE from both tables for every selected item
                const toDelete = inventoryData.filter((i: any) => selectedItemIds.includes(i.id));
                const errors: string[] = [];

                for (const item of toDelete) {
                  const invRes = await deleteInventoryItem(String(item.id));
                  if (!invRes.success) {
                    errors.push(`inventory: ${item.name} (${invRes.error?.message ?? "err"})`);
                    continue;
                  }
                  const fgRes = await deleteSaleItemByNameOrId(String(item.id), item.name);
                  if (!fgRes.success) {
                    errors.push(`hq_sale_items: ${item.name} (${fgRes.error?.message ?? "err"})`);
                  }
                }

                if (errors.length > 0) {
                  alert(`Some items failed:\n${errors.join("\n")}\nList will refresh.`);
                }

                const freshInv = await loadInventory();
                const userLocationId = resolveLocationId(user);
                const scopedInv = isHqAdmin(user)
                  ? freshInv
                  : freshInv.filter((i: any) => i.locationId === userLocationId);
                setInventoryData(scopedInv);
                setSelectedItemIds([]);
                setIsDeleteModalOpen(false);
              }}
              className="px-4 py-2 text-sm font-bold bg-danger-600 text-white rounded-lg hover:bg-danger-700 transition-colors shadow-sm w-full"
            >
              Purge {selectedItemIds.length} Object{selectedItemIds.length !== 1 ? 's' : ''}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          {(() => {
            const itemsWithHistory = selectedItemIds.filter(id => activityData[id] && activityData[id].length > 0);
            return itemsWithHistory.length > 0 ? (
              <div className="bg-warning-50 border border-warning-200 rounded-lg p-4 space-y-2">
                <h4 className="text-sm font-bold text-warning-800 flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> System Warning: Fragment Isolation</h4>
                <p className="text-xs text-warning-700 leading-relaxed font-medium">
                  <strong>{itemsWithHistory.length}</strong> of your targeted nodes are mapping persistent historical tracking structures. System overrides will terminate active structural binds, but physical reporting orphans will persist independently in cold storage matrices.
                </p>
              </div>
            ) : (
              <p className="text-sm text-neutral-600">The deletion pipeline is completely unchained. You are targeting {selectedItemIds.length} components. Proceed confidently?</p>
            )
          })()}
        </div>
      </Drawer>

      {/* ── Supplier Import Drawer ──────────────────────────────────────────── */}
      <Drawer
        isOpen={isSupplierImportDrawerOpen}
        onClose={() => setIsSupplierImportDrawerOpen(false)}
        title="Import Supplier Pricing"
        footer={
          supplierImportPreview.length > 0 ? (
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setIsSupplierImportDrawerOpen(false)}
                className="px-4 py-2 text-sm font-medium bg-neutral-100 text-neutral-700 rounded-lg hover:bg-neutral-200"
              >
                Cancel
              </button>
              <button
                onClick={commitSupplierImport}
                disabled={isCommittingSuppliers}
                className="px-4 py-2 text-sm font-bold bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isCommittingSuppliers && <Loader2 className="h-4 w-4 animate-spin" />}
                {isCommittingSuppliers
                  ? 'Inserting…'
                  : `Insert ${supplierImportPreview.length} Supplier Row${supplierImportPreview.length !== 1 ? 's' : ''}`}
              </button>
            </div>
          ) : null
        }
      >
        <div className="space-y-5 p-1">

          {/* Post-commit summary */}
          {supplierImportSummary && (
            <div className="rounded-lg bg-green-50 border border-green-200 p-4 space-y-1">
              <p className="text-sm font-bold text-green-800">✓ Import complete</p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-green-700 mt-1">
                <span>Total CSV rows</span>   <span className="font-semibold">{supplierImportSummary.total}</span>
                <span>Matched &amp; inserted</span> <span className="font-semibold">{supplierImportSummary.inserted}</span>
                <span>Unmatched (skipped)</span><span className="font-semibold">{supplierImportSummary.unmatched}</span>
              </div>
              {supplierImportSummary.unmatched > 0 && (
                <p className="text-xs text-amber-700 mt-2">
                  {supplierImportSummary.unmatched} rows could not be matched to an inventory item. Review the unmatched section below, fix item names in your CSV, and re-import.
                </p>
              )}
            </div>
          )}

          {/* ── Step 1: Upload ── */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-neutral-800">1. Upload supplier CSV</h3>
            <p className="text-xs text-neutral-500 leading-relaxed">
              Columns are detected by header name (case-insensitive, comma or semicolon delimited).
              Required: <code className="bg-neutral-100 px-1 rounded">supplier_name</code>,{' '}
              <code className="bg-neutral-100 px-1 rounded">item_name</code>,{' '}
              <code className="bg-neutral-100 px-1 rounded">unit_price</code>.<br />
              Optional: <code className="bg-neutral-100 px-1 rounded">supplier_product_name</code>,{' '}
              <code className="bg-neutral-100 px-1 rounded">purchase_uom</code>,{' '}
              <code className="bg-neutral-100 px-1 rounded">pack_qty</code>,{' '}
              <code className="bg-neutral-100 px-1 rounded">pack_uom</code>,{' '}
              <code className="bg-neutral-100 px-1 rounded">is_preferred</code>.
            </p>
            <label className="flex items-center gap-2 px-4 py-2 w-fit text-sm font-medium bg-violet-600 text-white rounded-lg cursor-pointer hover:bg-violet-700 transition-colors">
              <Upload className="h-4 w-4" />
              Choose CSV file
              <input
                ref={supplierFileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleSupplierCSVUpload}
                onClick={(e) => { (e.target as HTMLInputElement).value = ''; }}
              />
            </label>
          </div>

          {/* Parse errors */}
          {supplierImportErrors.length > 0 && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 space-y-1">
              <p className="text-xs font-semibold text-red-700">Parse errors</p>
              {supplierImportErrors.map((e, i) => (
                <p key={i} className="text-xs text-red-600">{e}</p>
              ))}
            </div>
          )}

          {/* ── Step 2: Matched preview ── */}
          {supplierImportPreview.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-neutral-800">
                2. Matched rows — ready to insert
                <span className="ml-2 text-xs font-normal text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
                  {supplierImportPreview.length} rows
                </span>
              </h3>
              <div className="overflow-x-auto rounded-lg border border-neutral-200 max-h-72">
                <table className="w-full text-xs">
                  <thead className="bg-neutral-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-neutral-600">CSV Item Name</th>
                      <th className="px-3 py-2 text-left font-semibold text-neutral-600">Matched Inventory Item</th>
                      <th className="px-3 py-2 text-left font-semibold text-neutral-600">Supplier</th>
                      <th className="px-3 py-2 text-left font-semibold text-neutral-600">UOM</th>
                      <th className="px-3 py-2 text-right font-semibold text-neutral-600">Unit Price</th>
                      <th className="px-3 py-2 text-center font-semibold text-neutral-600">Preferred</th>
                    </tr>
                  </thead>
                  <tbody>
                    {supplierImportPreview.map((r, i) => {
                      const invItem = inventoryData.find(x => String(x.id) === r.inventoryItemId);
                      return (
                        <tr key={i} className="border-t border-neutral-100 hover:bg-neutral-50">
                          <td className="px-3 py-2 text-neutral-500">{r.rawItemName}</td>
                          <td className="px-3 py-2 font-medium text-neutral-800">{invItem?.name ?? r.inventoryItemId}</td>
                          <td className="px-3 py-2 text-neutral-700">{r.supplierName}</td>
                          <td className="px-3 py-2 text-neutral-600">{r.purchaseUom}{r.packQty ? ` (${r.packQty}${r.packUom ? ' ' + r.packUom : ''})` : ''}</td>
                          <td className="px-3 py-2 text-right font-mono">${r.unitPrice.toFixed(2)}</td>
                          <td className="px-3 py-2 text-center">{r.isPreferred ? '★' : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Step 3: Unmatched review ── */}
          {supplierImportUnmatched.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-amber-700 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Unmatched rows — will NOT be inserted
                <span className="text-xs font-normal bg-amber-50 border border-amber-200 text-amber-700 px-2 py-0.5 rounded-full">
                  {supplierImportUnmatched.length} rows
                </span>
              </h3>
              <p className="text-xs text-neutral-500">
                These rows could not be matched to any inventory item by name.
                Fix the <code className="bg-neutral-100 px-1 rounded">item_name</code> column in your CSV
                to match the canonical name in inventory_items, then re-upload.
              </p>
              <div className="overflow-x-auto rounded-lg border border-amber-200 max-h-56 bg-amber-50">
                <table className="w-full text-xs">
                  <thead className="bg-amber-100 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-amber-800">Row</th>
                      <th className="px-3 py-2 text-left font-semibold text-amber-800">CSV Item Name</th>
                      <th className="px-3 py-2 text-left font-semibold text-amber-800">Normalized Match Attempt</th>
                      <th className="px-3 py-2 text-left font-semibold text-amber-800">Supplier</th>
                      <th className="px-3 py-2 text-right font-semibold text-amber-800">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {supplierImportUnmatched.map((r, i) => (
                      <tr key={i} className="border-t border-amber-200">
                        <td className="px-3 py-2 text-amber-600">{r.rowNum}</td>
                        <td className="px-3 py-2 text-amber-800 font-medium">{r.rawItemName}</td>
                        <td className="px-3 py-2 font-mono text-amber-600">{r.normItemName}</td>
                        <td className="px-3 py-2 text-amber-700">{r.supplierName}</td>
                        <td className="px-3 py-2 text-right font-mono text-amber-700">${r.unitPrice.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Empty state */}
          {supplierImportPreview.length === 0 && supplierImportUnmatched.length === 0 && !supplierImportSummary && supplierImportErrors.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center space-y-2">
              <Upload className="h-10 w-10 text-neutral-300" />
              <p className="text-sm font-medium text-neutral-500">Upload a supplier CSV to begin</p>
              <p className="text-xs text-neutral-400">
                Each row maps a supplier price to an inventory item.<br />
                Item names are normalized before matching (size suffixes like &quot;1 KG&quot;, &quot;55LBS&quot; are stripped).
              </p>
            </div>
          )}
        </div>
      </Drawer>

      {/* ── HQ-only: Linked Locations Drawer ──────────────────────────────────
           Read-only inspector: all inventory_items rows that share the same
           item_id as the clicked row. No editing allowed here.
      ──────────────────────────────────────────────────────────────────────── */}
      {sharedLinkedDrawerItem && (() => {
        const targetItemId: string = sharedLinkedDrawerItem.itemId ?? "";
        const linkedRows: any[] = targetItemId ? (rowsByItemId.get(targetItemId) ?? []) : [];
        const hqRow = linkedRows.find(r => r.locationId === "LOC-HQ");
        return (
          <Drawer
            isOpen={!!sharedLinkedDrawerItem}
            onClose={() => setSharedLinkedDrawerItem(null)}
            title="Shared Product Identity"
            description={`item_id: ${targetItemId.slice(0, 24)}… · ${linkedRows.length} linked location row${linkedRows.length !== 1 ? "s" : ""}`}
          >
            {/* ── Identity summary header ── */}
            <div className="rounded-lg bg-violet-50 border border-violet-200 p-3 mb-4 space-y-1">
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-violet-600 shrink-0" />
                <span className="text-sm font-semibold text-violet-900">{sharedLinkedDrawerItem.name}</span>
                <span className="text-[10px] font-bold bg-violet-200 text-violet-800 px-2 py-0.5 rounded-full ml-auto">
                  {linkedRows.length} location{linkedRows.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="text-[10px] font-mono text-violet-700 break-all">
                Shared item_id: {targetItemId}
              </div>
            </div>

            {/* ── Linked rows table ── */}
            <div className="overflow-x-auto rounded-lg border border-neutral-200">
              <table className="w-full text-xs">
                <thead className="bg-neutral-50 border-b border-neutral-200">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-neutral-600">Location</th>
                    <th className="px-3 py-2 text-left font-semibold text-neutral-600">Name</th>
                    <th className="px-3 py-2 text-right font-semibold text-neutral-600">Stock</th>
                    <th className="px-3 py-2 text-right font-semibold text-neutral-600">Cost</th>
                    <th className="px-3 py-2 text-left font-semibold text-neutral-600 hidden sm:table-cell">Base UOM</th>
                    <th className="px-3 py-2 text-left font-semibold text-neutral-600 hidden md:table-cell">Purchase UOM</th>
                    <th className="px-3 py-2 text-left font-semibold text-neutral-600 hidden lg:table-cell">Supplier</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {linkedRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-neutral-400">
                        No rows found for this item_id.
                      </td>
                    </tr>
                  ) : linkedRows.map((row) => {
                    const isHq = row.locationId === "LOC-HQ";
                    const isCurrent = String(row.id) === String(sharedLinkedDrawerItem.id);
                    const primaryPurchUOM = Array.isArray(row.purchaseUnits) && row.purchaseUnits.length > 0
                      ? (row.purchaseUnits.find((u: any) => u.isPrimary) ?? row.purchaseUnits[0])?.name
                      : (row.purchaseUom ?? "—");
                    const supplierName = row.preferredSupplierName ?? getSupplierName(row.supplierId) ?? "—";
                    return (
                      <tr
                        key={row.id}
                        className={`transition-colors ${
                          isCurrent ? "bg-brand-50/60 font-medium" :
                          isHq      ? "bg-violet-50/40" : "hover:bg-neutral-50/50"
                        }`}
                      >
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-neutral-700">{row.locationId ?? "—"}</span>
                            {isHq     && <span className="text-[9px] font-bold bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded">HQ</span>}
                            {isCurrent && <span className="text-[9px] font-bold bg-brand-100 text-brand-700 px-1.5 py-0.5 rounded">THIS</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-neutral-800">{row.name}</td>
                        <td className="px-3 py-2.5 text-right font-mono">
                          {row.inStock ?? 0}
                          <span className="text-neutral-400 ml-0.5">{row.baseUnit ?? row.unit}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono">
                          ${(row.cost ?? 0).toFixed(2)}
                        </td>
                        <td className="px-3 py-2.5 text-neutral-600 hidden sm:table-cell">{row.baseUnit ?? row.unit ?? "—"}</td>
                        <td className="px-3 py-2.5 text-neutral-600 hidden md:table-cell">{primaryPurchUOM}</td>
                        <td className="px-3 py-2.5 text-neutral-600 hidden lg:table-cell truncate max-w-[120px]">{supplierName}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="text-[10px] text-neutral-400 mt-3">
              Read-only. To edit a row, close this drawer and use the ⋯ menu on the inventory table.
            </p>
          </Drawer>
        );
      })()}

      {/* ── HQ-only: Merge Confirm Modal ──────────────────────────────────────
           Shown when HQ clicks Merge on a duplicate candidate.
           Confirms the item_id reassignment before writing to DB.
      ──────────────────────────────────────────────────────────────────────── */}
      {mergeConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-200"
          onClick={() => { if (!isMerging) { setMergeConfirm(null); setMergeError(null); } }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl border border-neutral-200 max-w-md w-full mx-4 overflow-hidden animate-in slide-in-from-bottom-4 duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100">
              <div className="flex items-center gap-2">
                <GitMerge className="h-5 w-5 text-violet-600" />
                <h3 className="text-base font-bold text-neutral-900">Merge Product Identity</h3>
              </div>
              <button
                onClick={() => { setMergeConfirm(null); setMergeError(null); }}
                disabled={isMerging}
                className="text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 p-1.5 rounded-md transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal body */}
            <div className="px-5 py-4 space-y-4">

              {/* ── Safety warning ── */}
              <div className="flex gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-3">
                <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800 leading-relaxed">
                  <strong>This only changes the future shared identity for this inventory row.</strong>{" "}
                  It does <strong>not</strong> rewrite historical movements, recipes, or past reports.
                  Existing production logs, requisition history, and COGS data will continue to
                  reference the old <code className="bg-amber-100 px-0.5 rounded">item_id</code> unchanged.
                </p>
              </div>

              {/* ── Affected row detail card ── */}
              <div className="bg-neutral-50 rounded-lg border border-neutral-200 p-3 space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-neutral-500 font-medium">Affected row</span>
                  <span className="font-semibold text-neutral-800">{mergeConfirm.sourceRowName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500 font-medium">Row id</span>
                  <span className="font-mono text-[10px] text-neutral-500 break-all max-w-[200px] text-right">{mergeConfirm.sourceRowId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500 font-medium">Location</span>
                  <span className="font-mono text-neutral-700">{mergeConfirm.locationId}</span>
                </div>
                <div className="border-t border-neutral-200 pt-1.5 space-y-1">
                  <div className="flex justify-between text-danger-600">
                    <span className="font-medium">Old item_id</span>
                    <span className="font-mono text-[10px] break-all max-w-[200px] text-right">{mergeConfirm.sourceItemId}</span>
                  </div>
                  <div className="flex justify-between text-violet-700">
                    <span className="font-medium">New item_id</span>
                    <span className="font-mono text-[10px] break-all max-w-[200px] text-right">{mergeConfirm.canonicalItemId}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-500 font-medium">Merging into</span>
                    <span className="font-semibold text-violet-900">{mergeConfirm.canonicalName}</span>
                  </div>
                </div>
              </div>

              {/* ── No-historical-change disclaimer ── */}
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 space-y-1">
                <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wide">What will NOT be changed</p>
                <ul className="text-[11px] text-neutral-500 space-y-0.5 list-none">
                  {[
                    "inventory_movements — historical production & fulfillment logs",
                    "recipes.ingredients — ingredient inventoryId references",
                    "requisition_items — past requisition line items",
                    "COGS & financial reports — already-computed totals",
                    "The row's name, stock level, cost, or any other field",
                  ].map((line) => (
                    <li key={line} className="flex items-start gap-1.5">
                      <span className="text-neutral-300 mt-0.5">✕</span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {mergeError && (
                <div className="bg-danger-50 border border-danger-200 rounded-lg px-3 py-2 text-xs text-danger-700">
                  {mergeError}
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-neutral-100 bg-neutral-50">
              <button
                onClick={() => { setMergeConfirm(null); setMergeError(null); }}
                disabled={isMerging}
                className="px-4 py-2 text-sm font-semibold text-neutral-700 bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleMerge}
                disabled={isMerging}
                className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-60 transition-colors shadow-sm"
              >
                {isMerging ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Merging…</>
                ) : (
                  <><GitMerge className="h-4 w-4" /> Confirm Merge</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
