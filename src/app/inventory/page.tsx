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
import { Search, Plus, Upload, MoreHorizontal, ShoppingCart, History, Save, Trash2, ArrowDown, ArrowUp, AlertTriangle, X, Download, Loader2, Link2, ChevronDown, ChevronRight, GitMerge, MapPin, Copy } from "lucide-react";
import { loadInventory, saveInventory, loadInventoryActivity, saveInventoryActivity, loadOrders, saveOrders, loadCategories, addCategory, loadSuppliers, saveSuppliers, resolveSupplier, loadImportBatches, saveImportBatches, insertInventoryItem, resolveHqItemId, resolveSharedItemId, logMovement, deleteInventoryItem, deleteSaleItemByNameOrId, insertPurchaseOptions, loadPurchaseOptions, savePurchaseOptions, deletePurchaseOption, updateInventoryRowItemId, allocateInventoryToLocations, loadLocations, copyInventoryItemsToLocations, type CopyInventoryItemsToLocationsResult, deriveLockedBaseUnit, getAllowedBaseUnits, resolveStorageBaseUnit, getFamilyAllowedInnerUnits, calcBaseQtyPerPurchaseUnit, inferMeasurementFamily, setInventoryStockToTarget, loadRecipes, loadProductionMovements } from "@/lib/storage";
import { convertQuantity } from "@/lib/units";
import { supabase } from "@/lib/supabase";

import { normalizeInventoryName } from "@/lib/inventoryIdentity";
import { SupplierCombobox } from "@/components/InventoryEditDrawer";

const LONDON_TEMPLATE_LOCATION_ID = "LOC-1091";

const normalizeDuplicateAuditText = (value: any) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/["'`]/g, "")
    .replace(/\b(oz|ounces?)\b/g, "ounce")
    .replace(/\b(lb|lbs|pounds?)\b/g, "pound")
    .replace(/\b(kg|kilograms?)\b/g, "kilogram")
    .replace(/\b(gr|g|grams?)\b/g, "gram")
    .replace(/\b(ea|each|pieces?)\b/g, "each")
    .replace(/\b(l|lt|litres?|liters?)\b/g, "liter")
    .replace(/\b(ml|millilitres?|milliliters?)\b/g, "milliliter")
    .replace(/\b(import|imported|vendor|supplier|copy|duplicate|dupe)\b/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeDuplicateAuditUnit = (value: any) => {
  const normalized = normalizeDuplicateAuditText(value);
  const aliases: Record<string, string> = {
    oz: "ounce",
    ounce: "ounce",
    ounces: "ounce",
    lb: "pound",
    lbs: "pound",
    pound: "pound",
    kg: "kilogram",
    kilogram: "kilogram",
    kilograms: "kilogram",
    gr: "gram",
    g: "gram",
    gram: "gram",
    grams: "gram",
    ea: "each",
    each: "each",
    piece: "each",
    pieces: "each",
    l: "liter",
    lt: "liter",
    litre: "liter",
    litres: "liter",
    liter: "liter",
    liters: "liter",
    ml: "milliliter",
    millilitre: "milliliter",
    millilitres: "milliliter",
    milliliter: "milliliter",
    milliliters: "milliliter",
  };
  return aliases[normalized] ?? normalized;
};

const getDuplicateAuditShortId = (value: any) => {
  const text = String(value ?? "");
  return text ? `#${text.slice(0, 6)}` : "—";
};

const similarDuplicateAuditNames = (a: string, b: string) => {
  if (!a || !b || a === b) return false;
  const aTokens = new Set(a.split(" ").filter(token => token.length > 2));
  const bTokens = new Set(b.split(" ").filter(token => token.length > 2));
  if (aTokens.size === 0 || bTokens.size === 0) return false;
  let intersection = 0;
  aTokens.forEach(token => { if (bTokens.has(token)) intersection += 1; });
  const score = intersection / Math.max(aTokens.size, bTokens.size);
  return score >= 0.75 || a.includes(b) || b.includes(a);
};

const duplicateAuditCsvEscape = (value: any) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const normalizeInventoryDisplayKey = (value: any) =>
  String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const getInventoryDisplayKey = (item: any) => {
  const itemId = String(item?.itemId ?? item?.item_id ?? "").trim();
  if (itemId && itemId !== String(item?.id ?? "")) return `item:${itemId}`;
  return [
    "fallback",
    normalizeInventoryDisplayKey(item?.name),
    normalizeInventoryDisplayKey(item?.baseUnit ?? item?.baseunit ?? item?.unit),
    normalizeInventoryDisplayKey(item?.supplierId ?? item?.supplierid ?? ""),
    normalizeInventoryDisplayKey(item?.cost ?? ""),
  ].join("|");
};

const isValidInventoryCopyTargetLocation = (loc: any) => {
  const id = String(loc?.id ?? "").trim();
  const name = String(loc?.name ?? "").trim();
  const status = String(loc?.status ?? "").trim().toLowerCase();
  const inactive = ["inactive", "disabled", "archived", "closed"].includes(status);
  return Boolean(
    id &&
    name &&
    id !== "LOC-HQ" &&
    id !== "LOC-NULL" &&
    id !== LONDON_TEMPLATE_LOCATION_ID &&
    name.toLowerCase() !== "null" &&
    !inactive
  );
};

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
  const [stockCorrectionQty, setStockCorrectionQty] = useState("");
  const [stockCorrectionUnit, setStockCorrectionUnit] = useState("");
  const [stockCorrectionReason, setStockCorrectionReason] = useState("");
  const [stockCorrectionConfirm, setStockCorrectionConfirm] = useState("");
  const [isApplyingStockCorrection, setIsApplyingStockCorrection] = useState(false);

  const [newParLevel, setNewParLevel] = useState("");
  const [parNotes, setParNotes] = useState("");
  const [userRole, setUserRole] = useState<"HQ" | "Location">("HQ");

  // Unit Mapping Config States
  const [editBaseUnit, setEditBaseUnit] = useState("");
  const [editPurchaseUnits, setEditPurchaseUnits] = useState<any[]>([]);
  const [editPurchaseCost, setEditPurchaseCost] = useState("");

  // Add Item Drawer States
  const [isAddDrawerOpen, setIsAddDrawerOpen] = useState(false);
  // ── Add drawer: Measurement Family + Structured Packaging ───────────────────────
  const [newItemName, setNewItemName]         = useState("");
  const [newItemType, setNewItemType]         = useState("Raw");
  const [newItemCategory, setNewItemCategory] = useState("Produce");
  const [newMeasFamily, setNewMeasFamily]     = useState(""); // 'weight'|'volume'|'count'|'labour'|'preparation'|'finished_good'
  // Structured packaging
  const [newPurchUnitLabel, setNewPurchUnitLabel] = useState("Case");
  const [newInnerPackCount, setNewInnerPackCount] = useState("");
  const [newInnerUnitLabel, setNewInnerUnitLabel] = useState("");
  const [newInnerQty, setNewInnerQty]             = useState("");
  const [newInnerMeasUnit, setNewInnerMeasUnit]   = useState("");
  // Supplier & Cost
  const [newSupplier, setNewSupplier]   = useState("");
  const [newCostInput, setNewCostInput] = useState(""); // cost per purchase unit
  // Stock
  const [newInStock, setNewInStock]   = useState("");
  const [addItemParLevel, setAddItemParLevel] = useState("");
  const [newMinOnHand, setNewMinOnHand] = useState("");
  const [newStockCountUnit, setNewStockCountUnit] = useState("base"); // 'base'|'purchase'
  // Legacy newItem kept for CSV import / old code paths that still reference it
  const [newItem, setNewItem] = useState({
    name: "", category: "Produce", itemType: "Raw", unit: "kg",
    supplier: "", inStock: "", parLevel: "", cost: "",
    purchaseUnits: [{ name: "Case", conversion: '1', isPrimary: true }] as any[],
    purchaseUom: "", packQty: "", innerUnitType: "",
    innerUnitSize: "", innerUnitUom: "", baseUomNew: "", allowedRecipeUoms: "",
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

  // ── HQ Correction state ──────────────────────────────────────────────────────
  type CorrectionModal = {
    log: any;        // the original log entry
    logIdx: number;  // index in activityData[selectedItem.id]
    mode: 'edit' | 'void';
  };
  const [correctionModal, setCorrectionModal] = useState<CorrectionModal | null>(null);
  const [corrReason, setCorrReason]   = useState('');
  const [corrNewQty, setCorrNewQty]   = useState('');
  const [isCorrSaving, setIsCorrSaving] = useState(false);

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
  // ── Edit drawer: Measurement Family + Structured Packaging ──────────────────
  const [editMeasFamily, setEditMeasFamily]     = useState("");
  const [editPurchUnitLabel, setEditPurchUnitLabel] = useState("Case");
  const [editInnerPackCount, setEditInnerPackCount] = useState("");
  const [editInnerUnitLabel, setEditInnerUnitLabel] = useState("");
  const [editInnerQty, setEditInnerQty]             = useState("");
  const [editInnerMeasUnit, setEditInnerMeasUnit]   = useState("");
  const [editCostInput, setEditCostInput]           = useState(""); // cost per purchase unit
  const [editMinOnHand, setEditMinOnHand]           = useState("");
  const [editStockCountUnit, setEditStockCountUnit] = useState("base"); // 'base'|'purchase'
  // Legacy field aliases (kept for the purchase-options supplier section below)
  const [editPurchaseUom, setEditPurchaseUom] = useState("");
  const [editPackQty, setEditPackQty] = useState("");
  const [editInnerUnitType, setEditInnerUnitType] = useState("");
  const [editInnerUnitSize, setEditInnerUnitSize] = useState("");
  const [editInnerUnitUom, setEditInnerUnitUom] = useState("");
  const [editBaseUomNew, setEditBaseUomNew] = useState("");
  const [editAllowedUoms, setEditAllowedUoms] = useState("");
  // ── Selectable base unit (Phase 2 — editable by HQ/admin) ────────────────
  const [editUserBaseUnit, setEditUserBaseUnit] = useState("");     // user-chosen base unit for edit drawer
  const [newUserBaseUnit, setNewUserBaseUnit]   = useState("");     // user-chosen base unit for add drawer
  // Conversion modal: shown when user changes base unit on an existing item
  const [baseUnitConvertModal, setBaseUnitConvertModal] = useState<{
    oldUnit: string; newUnit: string;
    oldStock: number; newStock: number;
    oldPar: number;   newPar: number;
    oldCostPerBase: number; newCostPerBase: number;
    oldPackConversion: number | null; newPackConversion: number | null;
  } | null>(null);

  // Edit drawer: purchase_options state
  const [editPurchaseOptions, setEditPurchaseOptions] = useState<any[]>([]);
  const [isLoadingPurchOpts, setIsLoadingPurchOpts] = useState(false);
  const [isSavingPurchOpt, setIsSavingPurchOpt] = useState<string | null>(null);
  const [addingPurchOpt, setAddingPurchOpt] = useState(false);
  const [newPurchOpt, setNewPurchOpt] = useState<any>({
    supplierId: null, supplierName: '', supplierProductName: '', purchaseUom: 'ea',
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

  // ── Phase 3A: Allocation state (HQ only) ───────────────────────────────
  const [allLocations, setAllLocations]           = useState<any[]>([]);   // from loadLocations()
  const [allocationItem, setAllocationItem]         = useState<any | null>(null); // source HQ row
  const [allocationLocations, setAllocationLocations] = useState<string[]>([]);  // selected locationIds
  const [allocationLoading, setAllocationLoading]   = useState(false);
  const [allocationResult, setAllocationResult]     = useState<string | null>(null); // success/error msg
  const [copySupplier, setCopySupplier]             = useState(true);
  const [copyCost, setCopyCost]                     = useState(true);
  const [startingPar, setStartingPar]               = useState<number>(0);

  // ── London template inventory copy (HQ only) ─────────────────────────────
  const [copyInventoryOpen, setCopyInventoryOpen] = useState(false);
  const [copyInventoryTargets, setCopyInventoryTargets] = useState<string[]>([]);
  const [copyInventoryPar, setCopyInventoryPar] = useState(true);
  const [copyInventorySetup, setCopyInventorySetup] = useState(true);
  const [copyInventoryPurchaseOptions, setCopyInventoryPurchaseOptions] = useState(true);
  const [copyInventoryStock, setCopyInventoryStock] = useState(false);
  const [copyInventoryUpdateExisting, setCopyInventoryUpdateExisting] = useState(false);
  const [copyInventoryLoading, setCopyInventoryLoading] = useState(false);
  const [copyInventoryResult, setCopyInventoryResult] = useState<CopyInventoryItemsToLocationsResult | null>(null);
  const [isDuplicateAuditOpen, setIsDuplicateAuditOpen] = useState(false);
  const [duplicateAuditSearch, setDuplicateAuditSearch] = useState("");
  const [duplicateAuditFilter, setDuplicateAuditFilter] = useState("all");
  const [expandedDuplicateAuditGroups, setExpandedDuplicateAuditGroups] = useState<Record<string, boolean>>({});
  const [purchaseOptionsData, setPurchaseOptionsData] = useState<any[]>([]);
  const [recipesData, setRecipesData] = useState<any[]>([]);
  const [ordersData, setOrdersData] = useState<any[]>([]);
  const [productionMovementsData, setProductionMovementsData] = useState<any[]>([]);
  const [movementAuditRows, setMovementAuditRows] = useState<any[]>([]);

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const [inv, act, cats, batches, sups, allPurchOpts, locs, recipes, orders, prodMovements, movementRowsResult] = await Promise.all([
          loadInventory(),
          loadInventoryActivity(),
          loadCategories('inventory'),
          loadImportBatches(),
          loadSuppliers(),
          loadPurchaseOptions(),   // bulk-load all rows up-front for startup merge
          loadLocations(),         // needed for allocation location picker
          loadRecipes(),
          loadOrders(),
          loadProductionMovements(),
          supabase
            .from('inventory_movements')
            .select('item_id, movement_type, reference_type, reference_id')
            .range(0, 49999),
        ]);
        setAllLocations(locs);
        setPurchaseOptionsData(Array.isArray(allPurchOpts) ? allPurchOpts : []);
        setRecipesData(Array.isArray(recipes) ? recipes : []);
        setOrdersData(Array.isArray(orders) ? orders : []);
        setProductionMovementsData(Array.isArray(prodMovements) ? prodMovements : []);
        setMovementAuditRows(Array.isArray((movementRowsResult as any)?.data) ? (movementRowsResult as any).data : []);
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

        // ── Dev diagnostic: shared identity audit ─────────────────────────────
        // Logs the first 5 rows' id vs itemId to reveal whether item_id is populated
        // in the DB, and shows which item_ids have multiple linked rows.
        if (process.env.NODE_ENV === 'development') {
          console.group('[InventoryIdentityDiag] Loaded inventory rows');
          console.log('Sample rows (first 5):',
            mergedInv.slice(0, 5).map((r: any) => ({
              name:     r.name,
              id:       r.id,
              itemId:   r.itemId,
              selfAssigned: String(r.itemId) === String(r.id),
            }))
          );
          const tempMap = new Map<string, number>();
          mergedInv.forEach((r: any) => {
            const k = r.itemId ?? '';
            if (k && String(k) !== String(r.id)) tempMap.set(k, (tempMap.get(k) ?? 0) + 1);
          });
          const sharedGroups = Array.from(tempMap.entries()).filter(([, n]) => n > 1);
          console.log(`Rows with genuine shared itemId (itemId !== id): ${sharedGroups.length} groups`);
          if (sharedGroups.length > 0) console.table(sharedGroups.map(([k, n]) => ({ itemId: k.slice(0, 20) + '…', count: n })));
          else console.warn('No shared identity groups found — item_id may be NULL or self-assigned for all rows. Badge will not appear until the DB is backfilled.');
          console.groupEnd();
        }
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

  const effectiveInventoryLocationId = isHqAdmin(user)
    ? activeLocation?.id ?? null
    : resolveLocationId(user);
  const isAllLocationsInventoryView = isHqAdmin(user) && !effectiveInventoryLocationId;

  const displayInventory = useMemo(() => {
    if (!isAllLocationsInventoryView && effectiveInventoryLocationId) {
      return inventoryData.filter((item: any) => item.locationId === effectiveInventoryLocationId);
    }

    const groups = new Map<string, any[]>();
    for (const item of inventoryData) {
      const key = getInventoryDisplayKey(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }

    const groupedRows = Array.from(groups.entries()).map(([displayKey, groupRows]) => {
      const representative =
        groupRows.find((row: any) => row.locationId === LONDON_TEMPLATE_LOCATION_ID) ??
        groupRows.find((row: any) => row.locationId !== "LOC-HQ") ??
        groupRows[0];
      const locationIds = Array.from(new Set(groupRows.map((row: any) => row.locationId).filter(Boolean)));
      return {
        ...representative,
        displayKey,
        sharedLocationCount: locationIds.length,
        sharedLocationIds: locationIds,
      };
    });

    const seen = new Set<string>();
    const duplicateDisplayKeys = new Set<string>();
    for (const row of groupedRows) {
      if (seen.has(row.displayKey)) duplicateDisplayKeys.add(row.displayKey);
      seen.add(row.displayKey);
    }
    if (process.env.NODE_ENV === "development" && duplicateDisplayKeys.size > 0) {
      console.warn("[Inventory] Duplicate display keys before rendering", Array.from(duplicateDisplayKeys));
    }

    return groupedRows;
  }, [activeLocation?.id, effectiveInventoryLocationId, inventoryData, isAllLocationsInventoryView]);

  const duplicateAudit = useMemo(() => {
    const purchaseOptionsByItem = new Map<string, any[]>();
    for (const option of purchaseOptionsData) {
      const key = String(option?.inventoryItemId ?? "");
      if (!key) continue;
      if (!purchaseOptionsByItem.has(key)) purchaseOptionsByItem.set(key, []);
      purchaseOptionsByItem.get(key)!.push(option);
    }

    const aliasesForItem = (item: any) => [
      String(item.id ?? ""),
      String(item.itemId ?? item.item_id ?? ""),
    ].filter(Boolean);

    const recipeUsageCount = (item: any) => {
      const aliases = new Set(aliasesForItem(item));
      return recipesData.reduce((count, recipe: any) => {
        const used = (recipe.ingredients ?? []).some((ing: any) => aliases.has(String(ing.inventoryId ?? "")));
        return count + (used ? 1 : 0);
      }, 0);
    };

    const fgRecipeUsageCount = (item: any) => {
      const aliases = new Set(aliasesForItem(item));
      return recipesData.reduce((count, recipe: any) => {
        const outputIds = [recipe.outputItemId, recipe.output_item_id, recipe.fgId, recipe.fgid].map((id: any) => String(id ?? ""));
        return count + (outputIds.some(id => aliases.has(id)) ? 1 : 0);
      }, 0);
    };

    const movementCount = (item: any) => {
      const aliases = new Set(aliasesForItem(item));
      return movementAuditRows.filter((row: any) => aliases.has(String(row.item_id ?? ""))).length;
    };

    const productionUsageCount = (item: any) => {
      const aliases = new Set(aliasesForItem(item));
      return productionMovementsData.filter((row: any) => aliases.has(String(row.item_id ?? ""))).length;
    };

    const poUsageCount = (item: any) => {
      const aliases = new Set(aliasesForItem(item));
      return ordersData.reduce((count, order: any) => {
        const used = (order.lineItems ?? []).some((line: any) => aliases.has(String(line.id ?? line.itemId ?? "")));
        return count + (used ? 1 : 0);
      }, 0);
    };

    const enrichedItems = inventoryData.map((item: any) => {
      const options = purchaseOptionsByItem.get(String(item.id)) ?? [];
      const preferred = options.find((option: any) => option.isPreferred) ?? options[0] ?? null;
      const supplier = preferred?.supplierName ?? item.preferredSupplierName ?? getSupplierName(item.supplierId);
      const purchaseUnitLabel = preferred?.purchaseUom ?? item.purchaseUom ?? item.purchaseUnits?.find((u: any) => u.isPrimary)?.name ?? item.purchaseUnits?.[0]?.name ?? "";
      const baseQtyPerPurchaseUnit = Number(item.packQty ?? item.purchaseUnits?.find((u: any) => u.isPrimary)?.conversion ?? item.purchaseUnits?.[0]?.conversion ?? preferred?.packQty ?? 1);
      const purchaseCost = Number(preferred?.unitPrice ?? item.purchaseCost ?? item.preferredCost ?? item.cost ?? 0);
      const costPerBaseUnit = baseQtyPerPurchaseUnit > 0 ? purchaseCost / baseQtyPerPurchaseUnit : Number(item.cost ?? 0);
      const measurementFamily = item.measurementFamily ?? item.measurement_family ?? inferMeasurementFamily(item.baseUnit ?? item.unit);
      const hasBaseUnit = Boolean(item.baseUnit ?? item.baseunit ?? item.unit);
      const hasStructuredPackaging = Boolean(
        item.packQty ||
        item.purchaseUom ||
        item.purchaseUnits?.length ||
        item.innerUnitSize ||
        item.innerUnitUom ||
        preferred?.packQty ||
        preferred?.purchaseUom
      );
      const unitSetupStatus = !hasBaseUnit || !measurementFamily
        ? "Needs Unit Setup"
        : baseQtyPerPurchaseUnit <= 0 || !Number.isFinite(baseQtyPerPurchaseUnit)
          ? "Unit Conflict"
          : hasStructuredPackaging
            ? "Unit Ready"
            : "Needs Unit Setup";
      const usage = {
        recipeUsageCount: recipeUsageCount(item),
        finishedGoodsRecipeUsageCount: fgRecipeUsageCount(item),
        purchaseOptionCount: options.length,
        movementLedgerCount: movementCount(item),
        productionUsageCount: productionUsageCount(item),
        poUsageCount: poUsageCount(item),
      };
      return {
        ...item,
        audit: {
          normalizedName: normalizeDuplicateAuditText(item.name),
          supplier,
          normalizedSupplier: normalizeDuplicateAuditText(supplier),
          normalizedCategory: normalizeDuplicateAuditText(item.category),
          normalizedBaseUnit: normalizeDuplicateAuditUnit(item.baseUnit ?? item.baseunit ?? item.unit),
          purchaseUnitLabel,
          normalizedPurchaseUnit: normalizeDuplicateAuditUnit(purchaseUnitLabel),
          measurementFamily,
          purchaseCost,
          baseQtyPerPurchaseUnit,
          costPerBaseUnit,
          unitSetupStatus,
          hasCompleteUnitSetup: unitSetupStatus === "Unit Ready",
          usage,
          isActive: item.isActive ?? item.active ?? item.enabled ?? true,
          createdAt: item.createdAt ?? item.created_at ?? "",
          updatedAt: item.updatedAt ?? item.updated_at ?? "",
        },
      };
    });

    const makeGroup = (type: "exact" | "unit variation" | "possible", key: string, items: any[]) => {
      const scoreDetails = (row: any) => {
        const usage = row.audit.usage;
        return {
          recipeUsage: usage.recipeUsageCount > 0,
          finishedGoodsOrProductionUsage: usage.finishedGoodsRecipeUsageCount > 0 || usage.productionUsageCount > 0,
          movementHistory: usage.movementLedgerCount > 0,
          hasStock: Number(row.inStock ?? 0) > 0,
          purchaseOptions: usage.purchaseOptionCount > 0,
          completeUnitSetup: row.audit.hasCompleteUnitSetup,
          validCostPerBaseUnit: Number(row.audit.costPerBaseUnit ?? 0) > 0,
          active: row.audit.isActive,
          updatedAt: row.audit.updatedAt ? new Date(row.audit.updatedAt).getTime() : 0,
          createdAt: row.audit.createdAt ? new Date(row.audit.createdAt).getTime() : 0,
        };
      };
      const sorted = [...items].sort((a: any, b: any) => {
        const aScore = scoreDetails(a);
        const bScore = scoreDetails(b);
        const priority = [
          "recipeUsage",
          "finishedGoodsOrProductionUsage",
          "movementHistory",
          "hasStock",
          "purchaseOptions",
          "completeUnitSetup",
          "validCostPerBaseUnit",
          "active",
        ] as const;
        for (const key of priority) {
          if (aScore[key] !== bScore[key]) return Number(bScore[key]) - Number(aScore[key]);
        }
        if (aScore.updatedAt !== bScore.updatedAt) return bScore.updatedAt - aScore.updatedAt;
        return bScore.createdAt - aScore.createdAt;
      });
      const master = sorted[0];
      const masterDetails = master ? scoreDetails(master) : null;
      const reasonParts = masterDetails ? [
        masterDetails.recipeUsage ? "recipe usage" : "",
        masterDetails.finishedGoodsOrProductionUsage ? "finished goods or production usage" : "",
        masterDetails.movementHistory ? "movement history" : "",
        masterDetails.hasStock ? "current stock" : "",
        masterDetails.purchaseOptions ? "purchase options" : "",
        masterDetails.completeUnitSetup ? "complete unit setup" : "",
        masterDetails.validCostPerBaseUnit ? "valid cost per base unit" : "",
        masterDetails.active ? "active status" : "",
      ].filter(Boolean) : [];
      const groupReason = type === "exact"
        ? "Same normalized name, supplier, base unit, purchase unit, and category."
        : type === "unit variation"
          ? "Same normalized name, supplier, and category, but unit setup differs."
          : "Similar normalized names with same supplier/category and similar cost.";
      const hasRecipeUsage = sorted.some((item: any) => item.audit.usage.recipeUsageCount > 0);
      const hasMovementOrProduction = sorted.some((item: any) => item.audit.usage.movementLedgerCount > 0 || item.audit.usage.productionUsageCount > 0 || item.audit.usage.finishedGoodsRecipeUsageCount > 0);
      const hasUnitConflict = sorted.some((item: any) => item.audit.unitSetupStatus === "Unit Conflict");
      const safetyStatus = type === "exact" && !hasRecipeUsage && !hasMovementOrProduction && !hasUnitConflict
        ? "likely safe later"
        : type === "possible" || hasUnitConflict
          ? "do not auto-merge"
          : "manual review needed";
      return {
        id: `${type}:${key}`,
        groupKey: key,
        duplicateType: type,
        itemCount: items.length,
        supplier: sorted[0]?.audit?.supplier ?? "",
        category: sorted[0]?.category ?? "",
        groupReason,
        recommendedMasterId: master?.id ?? "",
        recommendedMasterReason: reasonParts.length
          ? `Recommended master because it has ${reasonParts.join(", ")}.`
          : "Recommended master by latest available row metadata.",
        items: sorted,
        safetyStatus,
        safeToMergeLater: safetyStatus === "likely safe later",
      };
    };

    const exactBuckets = new Map<string, any[]>();
    const unitBuckets = new Map<string, any[]>();
    for (const item of enrichedItems) {
      const exactKey = [
        item.audit.normalizedName,
        item.audit.normalizedSupplier,
        item.audit.normalizedBaseUnit,
        item.audit.normalizedPurchaseUnit,
        item.audit.normalizedCategory,
      ].join("|");
      const unitKey = [
        item.audit.normalizedName,
        item.audit.normalizedSupplier,
        item.audit.normalizedCategory,
      ].join("|");
      if (!exactBuckets.has(exactKey)) exactBuckets.set(exactKey, []);
      if (!unitBuckets.has(unitKey)) unitBuckets.set(unitKey, []);
      exactBuckets.get(exactKey)!.push(item);
      unitBuckets.get(unitKey)!.push(item);
    }

    const exactGroups = Array.from(exactBuckets.entries())
      .filter(([, items]) => items.length > 1)
      .map(([key, items]) => makeGroup("exact", key, items));

    const unitVariationGroups = Array.from(unitBuckets.entries())
      .filter(([, items]) => {
        if (items.length <= 1) return false;
        const unitCombos = new Set(items.map((item: any) => `${item.audit.normalizedBaseUnit}|${item.audit.normalizedPurchaseUnit}`));
        return unitCombos.size > 1;
      })
      .map(([key, items]) => makeGroup("unit variation", key, items));

    const possibleGroups: any[] = [];
    const possibleSeen = new Set<string>();
    const possibleBuckets = new Map<string, any[]>();
    for (const item of enrichedItems) {
      const key = `${item.audit.normalizedSupplier}|${item.audit.normalizedCategory}`;
      if (!possibleBuckets.has(key)) possibleBuckets.set(key, []);
      possibleBuckets.get(key)!.push(item);
    }
    for (const [bucketKey, items] of possibleBuckets.entries()) {
      for (let i = 0; i < items.length; i++) {
        const matches = [items[i]];
        for (let j = i + 1; j < items.length; j++) {
          const similarName = similarDuplicateAuditNames(items[i].audit.normalizedName, items[j].audit.normalizedName);
          const similarCost = Math.abs(Number(items[i].audit.costPerBaseUnit ?? 0) - Number(items[j].audit.costPerBaseUnit ?? 0)) <= Math.max(0.01, Number(items[i].audit.costPerBaseUnit ?? 0) * 0.1);
          if (similarName && similarCost) matches.push(items[j]);
        }
        if (matches.length > 1) {
          const ids = matches.map((item: any) => String(item.id)).sort().join("|");
          if (!possibleSeen.has(ids)) {
            possibleSeen.add(ids);
            possibleGroups.push(makeGroup("possible", `${bucketKey}|possible|${matches[0].audit.normalizedName}`, matches));
          }
        }
      }
    }

    const groups = [...exactGroups, ...unitVariationGroups, ...possibleGroups];
    const duplicateItemIds = new Set(groups.flatMap(group => group.items.map((item: any) => String(item.id))));
    const summary = {
      totalInventoryItems: inventoryData.length,
      duplicateGroupsFound: groups.length,
      exactDuplicateGroups: exactGroups.length,
      unitVariationGroups: unitVariationGroups.length,
      possibleDuplicateGroups: possibleGroups.length,
      itemsInsideDuplicateGroups: duplicateItemIds.size,
      itemsSafeToMergeLater: groups.filter(group => group.safeToMergeLater).reduce((sum, group) => sum + Math.max(0, group.itemCount - 1), 0),
      itemsNeedingManualReview: groups.filter(group => !group.safeToMergeLater).reduce((sum, group) => sum + group.itemCount, 0),
    };

    return { groups, summary };
  }, [inventoryData, movementAuditRows, ordersData, productionMovementsData, purchaseOptionsData, recipesData, suppliersData]);

  useEffect(() => {
    if (!isDuplicateAuditOpen || process.env.NODE_ENV !== "development") return;
    console.table(duplicateAudit.groups.map((group: any) => ({
      type: group.duplicateType,
      groupKey: group.groupKey,
      count: group.itemCount,
      safetyStatus: group.safetyStatus,
      recommendedMasterId: group.recommendedMasterId,
      recommendedMasterReason: group.recommendedMasterReason,
      itemIds: group.items.map((item: any) => item.id).join(", "),
      itemNames: group.items.map((item: any) => item.name).join(" | "),
    })));
  }, [duplicateAudit, isDuplicateAuditOpen]);

  const filteredDuplicateAuditGroups = useMemo(() => {
    const query = normalizeDuplicateAuditText(duplicateAuditSearch);
    return duplicateAudit.groups.filter((group: any) => {
      const passesFilter =
        duplicateAuditFilter === "all" ||
        (duplicateAuditFilter === "exact" && group.duplicateType === "exact") ||
        (duplicateAuditFilter === "unit" && group.duplicateType === "unit variation") ||
        (duplicateAuditFilter === "possible" && group.duplicateType === "possible") ||
        (duplicateAuditFilter === "recipe" && group.items.some((item: any) => item.audit.usage.recipeUsageCount > 0)) ||
        (duplicateAuditFilter === "stock" && group.items.some((item: any) => Number(item.inStock ?? 0) > 0)) ||
        (duplicateAuditFilter === "unit-setup" && group.items.some((item: any) => item.audit.unitSetupStatus !== "Unit Ready")) ||
        (duplicateAuditFilter === "manual-review" && group.safetyStatus !== "likely safe later");
      if (!passesFilter) return false;
      if (!query) return true;
      return group.groupKey.includes(query) ||
      normalizeDuplicateAuditText(group.supplier).includes(query) ||
      normalizeDuplicateAuditText(group.category).includes(query) ||
      group.items.some((item: any) =>
        normalizeDuplicateAuditText(item.name).includes(query) ||
        normalizeDuplicateAuditText(item.audit.supplier).includes(query) ||
        normalizeDuplicateAuditText(item.category).includes(query) ||
        String(item.id).toLowerCase().includes(query) ||
        String(item.itemId ?? "").toLowerCase().includes(query)
      );
    });
  }, [duplicateAudit.groups, duplicateAuditFilter, duplicateAuditSearch]);

  const exportDuplicateAuditCsv = () => {
    const headers = [
      "duplicate_type", "group_key", "group_reason", "safety_status", "recommended_master_id", "recommended_master_reason", "item_count", "item_id", "item_name",
      "supplier", "category", "base_unit", "measurement_family", "purchase_unit_label",
      "purchase_cost", "base_qty_per_purchase_unit", "cost_per_base_unit", "current_stock", "par_level",
      "active", "unit_setup_status", "created_at", "updated_at", "recipe_usage_count", "finished_goods_recipe_usage_count",
      "purchase_option_count", "movement_ledger_count", "production_usage_count", "po_usage_count",
    ];
    const rows = filteredDuplicateAuditGroups.flatMap((group: any) =>
      group.items.map((item: any) => [
        group.duplicateType,
        group.groupKey,
        group.groupReason,
        group.safetyStatus,
        group.recommendedMasterId,
        group.recommendedMasterReason,
        group.itemCount,
        item.id,
        item.name,
        item.audit.supplier,
        item.category,
        item.baseUnit ?? item.unit,
        item.audit.measurementFamily,
        item.audit.purchaseUnitLabel,
        item.audit.purchaseCost,
        item.audit.baseQtyPerPurchaseUnit,
        item.audit.costPerBaseUnit,
        item.inStock,
        item.parLevel,
        item.audit.isActive,
        item.audit.unitSetupStatus,
        item.audit.createdAt,
        item.audit.updatedAt,
        item.audit.usage.recipeUsageCount,
        item.audit.usage.finishedGoodsRecipeUsageCount,
        item.audit.usage.purchaseOptionCount,
        item.audit.usage.movementLedgerCount,
        item.audit.usage.productionUsageCount,
        item.audit.usage.poUsageCount,
      ])
    );
    const csv = [headers, ...rows].map(row => row.map(duplicateAuditCsvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `inventory-duplicate-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const filteredInventory = displayInventory.filter(item => {
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

  if (process.env.NODE_ENV === "development") {
    const renderKeys = filteredInventory.map((item: any) => item.displayKey ?? getInventoryDisplayKey(item));
    const duplicateRenderKeys = renderKeys.filter((key, idx) => renderKeys.indexOf(key) !== idx);
    if (duplicateRenderKeys.length > 0) {
      console.warn("[Inventory] Render list contains duplicate display keys", Array.from(new Set(duplicateRenderKeys)));
    }
  }

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

  const activeSkuCount = displayInventory.length;
  // ── Inventory Value — use item.cost (per-base-unit cost) ──────────────────
  // IMPORTANT: Do NOT use preferredCost here.
  //   preferredCost = purchase_options.unit_price = PACK/CASE price.
  //   e.g. a case of 24 units at $9.60/unit has unitPrice = $230.40.
  //   Multiplying inStock (in base units) by the pack price inflates value by the
  //   pack conversion factor (10x–40x depending on pack size).
  //   item.cost is always the per-base-unit cost (set via handleEditSave → baseCost).
  const inventoryValue = displayInventory.reduce((sum: number, item: any) => {
    const stock = Number(item.inStock);
    const cost  = Number(item.cost);   // base-unit cost — always correct denominator
    if (!Number.isFinite(stock) || stock < 0) return sum;
    if (!Number.isFinite(cost)  || cost  < 0) return sum;
    return sum + stock * cost;
  }, 0);
  // Debug: surface the top contributors so bad data is immediately visible
  if (process.env.NODE_ENV !== 'production') {
    const top5 = [...displayInventory]
      .map((i: any) => ({
        name: i.name, loc: i.locationId,
        inStock: Number(i.inStock) || 0,
        cost: Number(i.cost) || 0,
        preferredCost: i.preferredCost ?? null,
        lineValue: (Number(i.inStock) || 0) * (Number(i.cost) || 0),
      }))
      .sort((a: any, b: any) => b.lineValue - a.lineValue)
      .slice(0, 5);
    console.group('[InventoryValueAudit]');
    console.log(`Total: $${inventoryValue.toFixed(2)} across ${displayInventory.length} displayed rows`);
    console.log('Top 5 highest value rows (cost = base unit cost):');
    console.table(top5);
    console.groupEnd();
  }
  const lowStockCount = displayInventory.filter(item => {
    const par = Number(item.parLevel) || 0;
    if (par <= 0) return false;
    const ratio = (Number(item.inStock) || 0) / par;
    return ratio >= 0.3 && ratio <= 0.7;
  }).length;
  const criticalStockCount = displayInventory.filter(item => {
    const par = Number(item.parLevel) || 0;
    if (par <= 0) return false;
    return ((Number(item.inStock) || 0) / par) < 0.3;
  }).length;

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
    // ── New: Measurement family (auto-infer if not yet set) ──────────────────
    const family = item.measurementFamily ?? inferMeasurementFamily(item.baseUnit || item.unit);
    setEditMeasFamily(family);
    // ── User-chosen base unit (reads baseUomNew first, falls back to family default) ──
    setEditUserBaseUnit(
      family
        ? resolveStorageBaseUnit(family, item.baseUomNew || item.baseUnit)
        : (item.baseUomNew || item.baseUnit || item.unit || '')
    );
    // ── New: Structured packaging (map from legacy fields if present) ─────────
    setEditPurchUnitLabel(item.purchaseUom ?? "Case");
    // packQty = inner pack count (how many inner units per purchase unit)
    setEditInnerPackCount(item.packQty != null ? String(item.packQty) : "");
    setEditInnerUnitLabel(item.innerUnitType ?? "");
    setEditInnerQty(item.innerUnitSize != null ? String(item.innerUnitSize) : "");
    setEditInnerMeasUnit(item.innerUnitUom ?? "");
    // Cost: prefer purchaseCost (price per purchase unit); fall back to item.cost
    setEditCostInput(
      item.purchaseCost != null ? String(item.purchaseCost) : (item.cost != null ? String(item.cost) : "")
    );
    setEditMinOnHand(item.minOnHand != null ? String(item.minOnHand) : "");
    setEditStockCountUnit("base");
    // ── Legacy field aliases (for the existing purchase-options section) ──────
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

  // ── Base Unit Change Handler (Edit drawer) ────────────────────────────────
  // Called when the user selects a different base unit from the dropdown.
  // If the item already has stock/cost data, shows a confirmation modal with
  // a before/after conversion preview. Cross-family conversions are blocked.
  const handleBaseUnitChange = (newUnit: string) => {
    const oldUnit = editUserBaseUnit;
    if (!oldUnit || oldUnit === newUnit) {
      setEditUserBaseUnit(newUnit);
      return;
    }

    // Check dimensional compatibility
    const testConv = convertQuantity(1, oldUnit, newUnit);
    if (!testConv.ok) {
      alert(`Cannot convert "${oldUnit}" → "${newUnit}": incompatible measurement families.\n\nPlease choose a base unit within the same family.`);
      return;
    }

    const factor       = testConv.qty!;  // 1 oldUnit expressed in newUnit
    const oldStock     = Number(editItem?.inStock   ?? 0);
    const oldPar       = Number(editItem?.parLevel  ?? 0);
    const oldCostBase  = Number(editItem?.cost      ?? 0); // cost per OLD base unit

    // Recompute pack conversion with new base unit
    const ipc  = parseFloat(editInnerPackCount);
    const iqty = parseFloat(editInnerQty);
    const oldPackConv = (editMeasFamily && !isNaN(ipc) && !isNaN(iqty) && editInnerMeasUnit)
      ? calcBaseQtyPerPurchaseUnit(editMeasFamily, ipc, iqty, editInnerMeasUnit, oldUnit)
      : null;
    const newPackConv = (editMeasFamily && !isNaN(ipc) && !isNaN(iqty) && editInnerMeasUnit)
      ? calcBaseQtyPerPurchaseUnit(editMeasFamily, ipc, iqty, editInnerMeasUnit, newUnit)
      : null;

    const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

    setBaseUnitConvertModal({
      oldUnit, newUnit,
      oldStock,                        newStock:       round6(oldStock    * factor),
      oldPar,                          newPar:         round6(oldPar      * factor),
      oldCostPerBase: oldCostBase,     newCostPerBase: round6(oldCostBase > 0 ? oldCostBase / factor : 0),
      oldPackConversion: oldPackConv,  newPackConversion: newPackConv,
    });
  };

  // ── Base Unit Change Handler (Add drawer) ─────────────────────────────────
  const handleNewBaseUnitChange = (newUnit: string) => {
    setNewUserBaseUnit(newUnit);
  };

  // ── Save Edit ─────────────────────────────────────────────────────────────

  const handleEditSave = async () => {
    if (!editItem) return;
    if (!editItem.name?.trim()) { alert("Item name is required."); return; }
    if (isSavingEdit) return;
    setIsSavingEdit(true);
    console.log("[EditItem] save start  id=", editItem.id);

    try {
      // ── New: compute base qty from structured packaging ──────────────────────
      const ipc   = parseFloat(editInnerPackCount);
      const iqty  = parseFloat(editInnerQty);
      // Pass editUserBaseUnit as the explicit base unit so calcBaseQtyPerPurchaseUnit
      // uses L (not ml) when the user has selected L as the base unit.
      const baseQtyPerPurchUnit = (editMeasFamily && !isNaN(ipc) && !isNaN(iqty) && editInnerMeasUnit)
        ? calcBaseQtyPerPurchaseUnit(editMeasFamily, ipc, iqty, editInnerMeasUnit, editUserBaseUnit)
        : null;

      // ── Effective base unit: user-selected, then family default, then legacy ──
      const lockedBase = editUserBaseUnit ||
        (editMeasFamily ? deriveLockedBaseUnit(editMeasFamily) : '') ||
        editBaseUnit || editItem.unit || '';

      // ── Cost computation ──────────────────────────────────────────────────────
      const parsedPurchaseCost = parseFloat(editCostInput || editPurchaseCost);
      let baseCost: number = editItem.cost;
      let purchCost: number | null = null;
      if (!isNaN(parsedPurchaseCost)) {
        purchCost = parsedPurchaseCost;
        if (baseQtyPerPurchUnit && baseQtyPerPurchUnit > 0) {
          baseCost = parsedPurchaseCost / baseQtyPerPurchUnit;
        } else {
          // Legacy: fall back to purchaseUnits conversion
          let pUnitsForCost = editItem.purchaseUnits
            ? JSON.parse(JSON.stringify(editItem.purchaseUnits))
            : editPurchaseUnits;
          pUnitsForCost = pUnitsForCost
            .map((u: any) => ({ ...u, conversion: parseFloat(u.conversion) }))
            .filter((u: any) => u.name?.trim());
          const primUnit = pUnitsForCost.find((u: any) => u.isPrimary) || pUnitsForCost[0];
          if (primUnit && primUnit.conversion > 0) {
            baseCost = parsedPurchaseCost / primUnit.conversion;
          } else {
            baseCost = parsedPurchaseCost;
          }
        }
      }

      // ── Build purchaseUnits array from structured fields (backward-compat) ────
      let pUnits: any[] = [];
      if (editMeasFamily && baseQtyPerPurchUnit && baseQtyPerPurchUnit > 0) {
        pUnits = [{
          name: editPurchUnitLabel || "Case",
          conversion: baseQtyPerPurchUnit,
          isPrimary: true,
        }];
      } else {
        pUnits = editItem.purchaseUnits
          ? JSON.parse(JSON.stringify(editItem.purchaseUnits))
          : editPurchaseUnits;
        pUnits = pUnits
          .map((u: any) => ({ ...u, conversion: parseFloat(u.conversion) }))
          .filter((u: any) => u.name?.trim());
        if (pUnits.length > 0 && !pUnits.some((u: any) => u.isPrimary)) pUnits[0].isPrimary = true;
      }

      // Compute preferred supplier summary from purchase_options state.
      const _prefRow = editPurchaseOptions.find((r: any) => r.isPreferred);
      const _lowRow = editPurchaseOptions.length > 0
        ? [...editPurchaseOptions].sort((a: any, b: any) => a.unitPrice - b.unitPrice)[0]
        : null;
      const _chosen = _prefRow ?? _lowRow ?? null;

      const updated = {
        ...editItem,
        baseUnit: lockedBase,
        unit: lockedBase,
        purchaseUnits: pUnits,
        cost: baseCost,
        purchaseCost: purchCost,
        updatedAt: Date.now(),
        // ── New structured packaging fields ──────────────────────────────────
        measurementFamily: editMeasFamily || null,
        purchaseUom: editPurchUnitLabel.trim() || editPurchaseUom.trim() || null,
        packQty: !isNaN(ipc) && ipc > 0 ? ipc : (editPackQty !== "" ? Number(editPackQty) : null),
        innerUnitType: editInnerUnitLabel.trim() || editInnerUnitType.trim() || null,
        innerUnitSize: !isNaN(iqty) && iqty > 0 ? iqty : (editInnerUnitSize !== "" ? Number(editInnerUnitSize) : null),
        innerUnitUom: editInnerMeasUnit.trim() || editInnerUnitUom.trim() || null,
        baseUomNew: lockedBase || editBaseUomNew.trim() || null,
        allowedRecipeUoms: editAllowedUoms.trim()
          ? editAllowedUoms.split(",").map(s => s.trim()).filter(Boolean)
          : null,
        // Preserve purchase_options-derived supplier summary
        preferredSupplierName: _chosen?.supplierName ?? null,
        preferredCost: _chosen?.unitPrice ?? null,
      };

      const newInventory = inventoryData.map(i => i.id === updated.id ? updated : i);

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
    setNewPurchOpt({ supplierId: null, supplierName: '', supplierProductName: '', purchaseUom: 'ea', packQty: '', packUom: '', unitPrice: '', isPreferred: false });
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
    setStockCorrectionQty("");
    setStockCorrectionUnit(item.baseUnit || item.unit);
    setStockCorrectionReason("");
    setStockCorrectionConfirm("");
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

  // ── Safe stock accessor ──────────────────────────────────────────────────
  // ALWAYS use this instead of selectedItem.inStock directly in arithmetic.
  // Root cause of the NaN bug: inStock can be stored as a string expression
  // like "318-288" if a save failed midway. Number() of a non-numeric string
  // returns NaN, and NaN propagates through all arithmetic silently.
  const safeStock = (item: any): number => {
    const v = Number(item?.inStock ?? 0);
    return Number.isFinite(v) ? v : 0;
  };

  const isStockCorrupted = (item: any): boolean => {
    const v = Number(item?.inStock ?? 0);
    return !Number.isFinite(v);
  };

  const getStockCorrectionUnitOptions = (item: any) => {
    const baseUnit = item?.baseUnit || item?.unit || "base";
    const options: { name: string; conversion: number; isBase: boolean }[] = [
      { name: baseUnit, conversion: 1, isBase: true },
    ];
    const purchaseUnits = Array.isArray(item?.purchaseUnits) ? item.purchaseUnits : [];
    for (const unit of purchaseUnits) {
      const conversion = Number(unit?.conversion);
      const name = String(unit?.name ?? "").trim();
      if (!name || !Number.isFinite(conversion) || conversion <= 0) continue;
      if (options.some(option => option.name === name)) continue;
      options.push({ name, conversion, isBase: false });
    }
    return options;
  };

  const getStockCorrectionPreview = (item: any) => {
    const enteredQty = Number(stockCorrectionQty);
    const unitOptions = getStockCorrectionUnitOptions(item);
    const unitOption =
      unitOptions.find(option => option.name === stockCorrectionUnit) ??
      unitOptions[0];
    // safeStock: always numeric
    const currentBaseQty = safeStock(item);
    const corrupted = isStockCorrupted(item);
    // targetBaseQty = entered qty × unit conversion (e.g. 1 Case × 18 lb/Case = 18 lb)
    const targetBaseQty =
      Number.isFinite(enteredQty) && enteredQty >= 0
        ? enteredQty * Number(unitOption?.conversion ?? 1)
        : null;
    const delta = targetBaseQty === null ? null : targetBaseQty - currentBaseQty;
    const par = Number(item?.parLevel ?? 0);
    const isHuge =
      delta !== null &&
      (Math.abs(delta) > 10000 || (par > 0 && Math.abs(delta) > par * 10));
    return {
      unitOption,
      enteredQty: Number.isFinite(enteredQty) ? enteredQty : null,
      currentBaseQty,
      targetBaseQty,
      delta,
      isHuge,
      corrupted,
    };
  };

  const applyStockCorrection = async () => {
    if (!selectedItem) return;
    const preview = getStockCorrectionPreview(selectedItem);
    if (preview.targetBaseQty === null || !Number.isFinite(preview.targetBaseQty) || preview.targetBaseQty < 0) {
      alert("Enter a valid stock quantity (0 or greater).");
      return;
    }
    if (!stockCorrectionReason.trim()) {
      alert("Reason / notes are required for stock correction.");
      return;
    }
    if (preview.isHuge && stockCorrectionConfirm.trim() !== "CONFIRM") {
      alert("Large correction detected. Type CONFIRM to apply this correction.");
      return;
    }

    setIsApplyingStockCorrection(true);
    try {
      const baseUnit = selectedItem.baseUnit || selectedItem.unit;
      const res = await setInventoryStockToTarget({
        itemId: String(selectedItem.id),
        targetBaseQty: preview.targetBaseQty,
        reason: stockCorrectionReason.trim(),
        locationId: selectedItem.locationId ?? resolveLocationId(user),
        movementItemId: selectedItem.itemId ?? selectedItem.id,
        unit: baseUnit,
        unitCost: selectedItem.cost ?? null,
      });
      if (!res.success) throw new Error(res.error?.message ?? "Stock correction failed.");

      const updatedItem = {
        ...selectedItem,
        inStock: preview.targetBaseQty,   // always a clean number
        updatedAt: Date.now(),
      };
      setSelectedItem(updatedItem);
      setInventoryData(prev => prev.map((item: any) => item.id === selectedItem.id ? updatedItem : item));

      const now = new Date();
      const unitDisplay = preview.unitOption?.name ?? baseUnit;
      const activityEntry = {
        id: `stock-correction-${Date.now()}`,
        date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        type: 'Stock Count Correction',
        qty: `${preview.delta && preview.delta > 0 ? '+' : ''}${(preview.delta ?? 0).toFixed(4)} ${baseUnit}`,
        baseTransacted: preview.delta ?? 0,
        previousStock: preview.currentBaseQty,
        targetStock: preview.targetBaseQty,
        notes: [
          `From: ${preview.currentBaseQty} ${baseUnit}`,
          `To: ${preview.targetBaseQty} ${baseUnit}`,
          `Entered: ${preview.enteredQty ?? '?'} ${unitDisplay}`,
          `Adjustment: ${(preview.delta ?? 0).toFixed(4)} ${baseUnit}`,
          `Reason: ${stockCorrectionReason.trim()}`,
        ].join(' | '),
        user: user?.email ?? 'HQ',
      };
      const existing = activityData[selectedItem.id] || [];
      const newActivityData = { ...activityData, [selectedItem.id]: [activityEntry, ...existing] };
      setActivityData(newActivityData);
      await saveInventoryActivity(newActivityData);

      setStockCorrectionQty("");
      setStockCorrectionReason("");
      setStockCorrectionConfirm("");
      alert(`Stock set to ${preview.targetBaseQty} ${baseUnit}. ✓`);
    } catch (err: any) {
      alert(`Stock correction failed: ${err?.message ?? String(err)}`);
    } finally {
      setIsApplyingStockCorrection(false);
    }
  };

  const saveAdjustment = async () => {
    if (!selectedItem || !adjQty) return;
    const numericQty = parseFloat(adjQty);
    if (isNaN(numericQty) || numericQty <= 0) return;

    // Guard: block movements on corrupted stock
    if (isStockCorrupted(selectedItem)) {
      alert('Stock value is corrupted (non-numeric). Use "Set Final Stock Count" to overwrite it with a clean value before adding or removing stock.');
      return;
    }

    // Resolve conversion factor from ALL unit options (base + purchase units)
    const unitOptions = getStockCorrectionUnitOptions(selectedItem);
    const matchedOption = unitOptions.find(u => u.name === adjUnit);
    const conversion = matchedOption ? matchedOption.conversion : 1;

    const normalizedInput = numericQty * conversion;
    let variance = 0;
    if (adjType === "Add") variance = normalizedInput;
    if (adjType === "Remove" || adjType === "Waste") variance = -normalizedInput;

    // safeStock ensures we never add to a string / NaN
    const currentStock = safeStock(selectedItem);
    const newStock = currentStock + variance;

    let updatedItem = { ...selectedItem, inStock: newStock, updatedAt: Date.now() };
    const newInventory = inventoryData.map(i => i.id === selectedItem.id ? updatedItem : i);

    const baseUnit = selectedItem.baseUnit || selectedItem.unit;
    const adjLabel = adjType === 'Add' ? 'Received Stock' : adjType === 'Waste' ? 'Waste / Spoilage' : 'Stock Removed';
    const logEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      type: adjType,
      qty: `${adjType !== 'Add' ? '-' : '+'}${normalizedInput.toFixed(4)} ${baseUnit}`,
      baseTransacted: variance,
      notes: adjNotes
        ? `${adjLabel}: ${numericQty} ${adjUnit || baseUnit} → ${normalizedInput.toFixed(4)} ${baseUnit}. ${adjNotes}`
        : `${adjLabel}: ${numericQty} ${adjUnit || baseUnit} → ${normalizedInput.toFixed(4)} ${baseUnit}`,
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

  // ── Commit Correction (Edit mode) ──────────────────────────────────────────
  // Creates a delta correction movement without rewriting history.
  const commitCorrection = async () => {
    if (!correctionModal || !selectedItem) return;
    if (!corrReason) { alert('Reason is required.'); return; }
    const { log, logIdx } = correctionModal;

    const origNumStr = String(log.qty ?? '0').replace(/[^0-9.\-]/g, '');
    const origNum = parseFloat(origNumStr) || 0;
    const newNum  = parseFloat(corrNewQty);
    if (isNaN(newNum)) { alert('Enter a valid new quantity.'); return; }
    const delta = newNum - origNum;
    if (delta === 0) { alert('New quantity is the same as original — no correction needed.'); return; }

    setIsCorrSaving(true);
    try {
      const movItemId = selectedItem.itemId ?? selectedItem.id;
      const movLocId  = selectedItem.locationId ?? resolveLocationId(user);
      await logMovement({
        locationId:    movLocId,
        itemId:        String(movItemId),
        movementType:  delta > 0 ? 'correction_in' : 'correction_out',
        quantity:      Math.abs(delta),
        unitCost:      selectedItem.cost ?? null,
        referenceType: 'correction',
        notes:         `Correction of entry #${log.id ?? logIdx}: ${corrReason}. Original ${origNum}, corrected to ${newNum}.`,
      });

      const updatedItem = { ...selectedItem, inStock: selectedItem.inStock + delta, updatedAt: Date.now() };
      const newInventory = inventoryData.map((i: any) => i.id === selectedItem.id ? updatedItem : i);
      const res = await saveInventory([updatedItem]);
      if (!res.success) throw new Error(res.error?.message ?? 'Save failed');
      setInventoryData(newInventory);
      setSelectedItem(updatedItem);

      const now = new Date();
      const corrEntry = {
        id: `corr-${Date.now()}`,
        date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        type: delta > 0 ? 'Add' : 'Remove',
        qty: `${delta > 0 ? '+' : ''}${delta} ${selectedItem.unit}`,
        notes: `Correction — ${corrReason}. Original entry: ${log.qty}.`,
        user: user?.email ?? 'HQ',
        isCorrectionOf: log.id ?? logIdx,
      };
      const existing = activityData[selectedItem.id] || [];
      const patchedExisting = existing.map((e: any, i: number) =>
        (e.id !== undefined ? e.id === log.id : i === logIdx) ? { ...e, corrected: true } : e
      );
      const newActivityData = { ...activityData, [selectedItem.id]: [corrEntry, ...patchedExisting] };
      setActivityData(newActivityData);
      await saveInventoryActivity(newActivityData);
      setCorrectionModal(null); setCorrReason(''); setCorrNewQty('');
    } catch (err: any) {
      alert(`Correction failed: ${err?.message ?? String(err)}`);
    } finally {
      setIsCorrSaving(false);
    }
  };

  // ── Commit Void (Reverse mode) ─────────────────────────────────────────────
  // Creates an equal-opposite movement and marks the original as voided.
  const commitVoid = async () => {
    if (!correctionModal || !selectedItem) return;
    if (!corrReason) { alert('Reason is required.'); return; }
    const { log, logIdx } = correctionModal;

    if (!Number.isFinite(Number(log.baseTransacted))) {
      alert("This old movement cannot be safely voided. Use Set Stock to Correct Count instead.");
      return;
    }
    const signedOriginal = Number(log.baseTransacted);
    const reversal = -signedOriginal;

    setIsCorrSaving(true);
    try {
      const movItemId = selectedItem.itemId ?? selectedItem.id;
      const movLocId  = selectedItem.locationId ?? resolveLocationId(user);
      await logMovement({
        locationId:    movLocId,
        itemId:        String(movItemId),
        movementType:  reversal > 0 ? 'correction_in' : 'correction_out',
        quantity:      Math.abs(reversal),
        unitCost:      selectedItem.cost ?? null,
        referenceType: 'void',
        notes:         `Void of entry #${log.id ?? logIdx}: ${corrReason}.`,
      });

      const updatedItem = { ...selectedItem, inStock: selectedItem.inStock + reversal, updatedAt: Date.now() };
      const newInventory = inventoryData.map((i: any) => i.id === selectedItem.id ? updatedItem : i);
      const res = await saveInventory([updatedItem]);
      if (!res.success) throw new Error(res.error?.message ?? 'Save failed');
      setInventoryData(newInventory);
      setSelectedItem(updatedItem);

      const now = new Date();
      const voidEntry = {
        id: `void-${Date.now()}`,
        date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        type: reversal > 0 ? 'Add' : 'Remove',
        qty: `${reversal > 0 ? '+' : ''}${reversal} ${selectedItem.unit}`,
        notes: `Void — ${corrReason}. Reversed entry: ${log.qty}.`,
        user: user?.email ?? 'HQ',
        isVoidOf: log.id ?? logIdx,
      };
      const existing = activityData[selectedItem.id] || [];
      const patchedExisting = existing.map((e: any, i: number) =>
        (e.id !== undefined ? e.id === log.id : i === logIdx) ? { ...e, voided: true } : e
      );
      const newActivityData = { ...activityData, [selectedItem.id]: [voidEntry, ...patchedExisting] };
      setActivityData(newActivityData);
      await saveInventoryActivity(newActivityData);
      setCorrectionModal(null); setCorrReason(''); setCorrNewQty('');
    } catch (err: any) {
      alert(`Void failed: ${err?.message ?? String(err)}`);
    } finally {
      setIsCorrSaving(false);
    }
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
    // ── Validate required fields ───────────────────────────────────────────────
    if (!newItemName.trim()) { alert("Item Name is required."); return; }
    if (!newMeasFamily)      { alert("Please select a Measurement Family before saving."); return; }
    if (!newInStock)         { alert("Current Stock is required."); return; }
    if (!addItemParLevel)        { alert("Par Level is required."); return; }

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

    // ── Resolve supplier ───────────────────────────────────────────────────────
    let suppText = newSupplier.trim() || newItem.supplier.trim();
    let suppIdCode = null;
    if (suppText) {
      try {
        suppIdCode = await resolveSupplier(suppText);
      } catch (e: any) {
        alert(e.message ?? `Supplier "${suppText}" not found in HQ master. Ask HQ to create it first.`);
        return;
      }
    }

    // ── Structured packaging → base qty ───────────────────────────────────────
    const ipc  = parseFloat(newInnerPackCount);
    const iqty = parseFloat(newInnerQty);
    // Pass newUserBaseUnit so the user's chosen base (e.g. 'l') is used, not the family default ('ml')
    const baseQtyPerPurchUnit = (newMeasFamily && !isNaN(ipc) && !isNaN(iqty) && newInnerMeasUnit)
      ? calcBaseQtyPerPurchaseUnit(newMeasFamily, ipc, iqty, newInnerMeasUnit, newUserBaseUnit)
      : null;

    // ── Validate unit compatibility ────────────────────────────────────────────
    if (newInnerMeasUnit && newMeasFamily && baseQtyPerPurchUnit === null) {
      alert("Unit conversion missing or incompatible. Cost cannot be trusted.\n\nPlease check that the Inner Measurement Unit is compatible with the selected Measurement Family.");
      return;
    }

    // ── Effective base unit: user-selected, then family default ───────────────
    const lockedBase = resolveStorageBaseUnit(newMeasFamily, newUserBaseUnit);

    // ── Cost computation ──────────────────────────────────────────────────────
    const parsedPurchaseCost = parseFloat(newCostInput || newItem.cost as string);
    let baseCost = isNaN(parsedPurchaseCost) ? 0 : parsedPurchaseCost;
    let purchaseCost = isNaN(parsedPurchaseCost) ? 0 : parsedPurchaseCost;
    if (!isNaN(parsedPurchaseCost) && baseQtyPerPurchUnit && baseQtyPerPurchUnit > 0) {
      baseCost = parsedPurchaseCost / baseQtyPerPurchUnit;
    }

    // ── Build purchaseUnits array for backward-compat ─────────────────────────
    let pUnits: any[] = [];
    if (baseQtyPerPurchUnit && baseQtyPerPurchUnit > 0) {
      pUnits = [{
        name: newPurchUnitLabel || "Case",
        conversion: baseQtyPerPurchUnit,
        isPrimary: true,
      }];
    }

    const finalItem = {
      name: newItemName.trim(),
      category: newItemCategory,
      itemType: newItemType,
      unit: lockedBase,
      baseUnit: lockedBase,
      measurementFamily: newMeasFamily,
      purchaseUnits: pUnits,
      purchaseCost: purchaseCost,
      supplierId: suppIdCode,
      inStock: parseFloat(newInStock) || 0,
      parLevel: parseFloat(addItemParLevel) || 0,
      cost: baseCost,
      priceTrend: "steady",
      priceIncrease: false,
      updatedAt: Date.now(),
      // Structured packaging
      purchaseUom: newPurchUnitLabel.trim() || null,
      packQty: !isNaN(ipc) && ipc > 0 ? ipc : null,
      innerUnitType: newInnerUnitLabel.trim() || null,
      innerUnitSize: !isNaN(iqty) && iqty > 0 ? iqty : null,
      innerUnitUom: newInnerMeasUnit.trim() || null,
      baseUomNew: lockedBase || null,
      allowedRecipeUoms: getFamilyAllowedInnerUnits(newMeasFamily),
    };

    const res = await insertInventoryItem(finalItem, locationId);
    if (!res.success) {
      alert(`Add Item Failed: ${res.error?.message || "Database rejected insertion."}`);
      return;
    }

    // Use the returned UUID as the canonical id for local state
    const localItem = { ...finalItem, id: res.id };
    setInventoryData([localItem, ...inventoryData]);

    // Reset new-item form state
    setNewItemName(""); setNewItemType("Raw"); setNewItemCategory("Produce");
    setNewMeasFamily(""); setNewPurchUnitLabel("Case");
    setNewInnerPackCount(""); setNewInnerUnitLabel("");
    setNewInnerQty(""); setNewInnerMeasUnit("");
    setNewUserBaseUnit("");
    setNewSupplier(""); setNewCostInput("");
    setNewInStock(""); setAddItemParLevel(""); setNewMinOnHand("");
    setNewStockCountUnit("base");
    // Also reset legacy newItem
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
      // Skip rows with no itemId or self-assigned itemId (itemId === id).
      // A self-assigned row means item_id was NULL in the DB and the mapper
      // fell back to the row's own id — that row has no real shared identity
      // and must not be grouped with anything.
      if (!key || String(key) === String(row.id)) continue;
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

  const selectedCopyInventoryItems = useMemo(
    () => inventoryData.filter((item: any) => selectedItemIds.map(String).includes(String(item.id))),
    [inventoryData, selectedItemIds]
  );

  const inventoryCopyTargetLocations = useMemo(
    () => allLocations.filter(isValidInventoryCopyTargetLocation),
    [allLocations]
  );

  const londonTemplateLocation = useMemo(
    () => allLocations.find((loc: any) => loc.id === LONDON_TEMPLATE_LOCATION_ID),
    [allLocations]
  );

  const hasNonLondonCopySelection = useMemo(
    () => selectedCopyInventoryItems.some((item: any) => item.locationId !== LONDON_TEMPLATE_LOCATION_ID),
    [selectedCopyInventoryItems]
  );

  const activeInventoryLocationId = isHqAdmin(user)
    ? activeLocation?.id ?? null
    : resolveLocationId(user);
  const isLondonTemplateLocationActive = activeInventoryLocationId === LONDON_TEMPLATE_LOCATION_ID;

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

  // ── Phase 3A: Allocation handler ─────────────────────────────────────────
  //
  // Calls allocateInventoryToLocations for each selected location.
  // Merges returned rows into local inventoryData so the shared badge
  // updates immediately without a full page reload.
  //
  const handleAllocate = async () => {
    if (!allocationItem || allocationLocations.length === 0) return;
    setAllocationLoading(true);
    setAllocationResult(null);
    try {
      const res = await allocateInventoryToLocations(
        allocationItem,
        allocationLocations,
        { copySupplier, copyCost, startingPar }
      );
      if (res.insertedRows && res.insertedRows.length > 0) {
        // Optimistically append to local state — shared badge recomputes via useMemo
        setInventoryData(prev => [...prev, ...res.insertedRows!]);
      }
      const successCount = res.insertedRows?.length ?? 0;
      const failCount    = res.errors?.length ?? 0;
      if (successCount > 0 && failCount === 0) {
        setAllocationResult(`✓ Allocated to ${successCount} location${successCount !== 1 ? "s" : ""} successfully.`);
        setAllocationLocations([]);
      } else if (successCount > 0 && failCount > 0) {
        const failedIds = res.errors!.map(e => e.locationId).join(", ");
        setAllocationResult(`Partial success: ${successCount} inserted, ${failCount} failed (${failedIds}). Check console for details.`);
      } else {
        const msg = res.errors?.[0]?.message ?? "All inserts failed.";
        setAllocationResult(`✗ ${msg}`);
      }
    } catch (err: any) {
      setAllocationResult(`✗ Unexpected error: ${err?.message ?? "Unknown"}`);
    } finally {
      setAllocationLoading(false);
    }
  };

  const openCopyInventoryModal = () => {
    if (!isLondonTemplateLocationActive) {
      alert("Switch to London / LOC-1091 template location to copy setup.");
      return;
    }
    if (selectedCopyInventoryItems.length === 0) {
      alert("Select inventory items first.");
      return;
    }
    if (inventoryCopyTargetLocations.length === 0) {
      alert("No valid active target locations are available.");
      return;
    }

    setCopyInventoryTargets(inventoryCopyTargetLocations.map((loc: any) => loc.id));
    setCopyInventoryPar(true);
    setCopyInventorySetup(true);
    setCopyInventoryPurchaseOptions(true);
    setCopyInventoryStock(false);
    setCopyInventoryUpdateExisting(false);
    setCopyInventoryResult(null);
    setCopyInventoryOpen(true);
  };

  const handleCopyInventoryToLocations = async () => {
    if (!isLondonTemplateLocationActive) {
      alert("Switch to London / LOC-1091 template location to copy setup.");
      return;
    }
    const validTargetIds = new Set(inventoryCopyTargetLocations.map((loc: any) => loc.id));
    const targetIds = copyInventoryTargets.filter((id) => validTargetIds.has(id));
    if (selectedCopyInventoryItems.length === 0) {
      alert("Select inventory items first.");
      return;
    }
    if (targetIds.length === 0) {
      alert("Select at least one target location.");
      return;
    }

    setCopyInventoryLoading(true);
    setCopyInventoryResult(null);
    try {
      const result = await copyInventoryItemsToLocations({
        sourceLocationId: LONDON_TEMPLATE_LOCATION_ID,
        sourceRowIds: selectedCopyInventoryItems.map((item: any) => String(item.id)),
        targetLocationIds: targetIds,
        copyParLevels: copyInventoryPar,
        copySupplierCostSettings: copyInventorySetup,
        copyPurchaseOptions: copyInventoryPurchaseOptions,
        copyStock: copyInventoryStock,
        updateExistingSetupFields: copyInventoryUpdateExisting,
      });

      setCopyInventoryResult(result);
      if (result.insertedRows.length > 0 || result.updatedRows.length > 0) {
        setInventoryData((prev: any[]) => {
          const updatedById = new Map(result.updatedRows.map((row: any) => [String(row.id), row]));
          const patched = prev.map((row: any) => updatedById.get(String(row.id)) ?? row);
          const existingIds = new Set(patched.map((row: any) => String(row.id)));
          const newRows = result.insertedRows.filter((row: any) => !existingIds.has(String(row.id)));
          return [...newRows, ...patched];
        });
      }
    } finally {
      setCopyInventoryLoading(false);
    }
  };

  if (isLoading) return (
    <div className="-m-6 flex min-h-[calc(100vh-4rem)] items-center justify-center bg-[#070707] p-12 text-zinc-500">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
      Loading Inventory Module...
    </div>
  );


  // ── Pre-compute correction modal values (Turbopack-safe, outside JSX) ──────
  const _corrOrigNum = correctionModal
    ? parseFloat(String(correctionModal.log.qty ?? '0').replace(/[^0-9.\-]/g, '')) || 0
    : 0;
  const _corrDelta = correctionModal && corrNewQty && !isNaN(parseFloat(corrNewQty))
    ? parseFloat(corrNewQty) - _corrOrigNum
    : null;
  const _voidReversal = correctionModal
    ? (Number.isFinite(Number(correctionModal.log.baseTransacted)) ? -Number(correctionModal.log.baseTransacted) : 0)
    : 0;
  const _voidCanSafelyReverse = correctionModal?.mode === 'void'
    ? Number.isFinite(Number(correctionModal.log.baseTransacted))
    : true;
  const _voidExpectedStock = selectedItem && correctionModal?.mode === 'void'
    ? Number(selectedItem.inStock ?? 0) + _voidReversal
    : null;

  return (

    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-[#070707] p-6 text-zinc-100">
      <style>{`
        body .flex.bg-neutral-50.text-neutral-900.min-h-screen {
          background: #070707 !important;
          color: #e4e4e7 !important;
        }
        body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] {
          background: #111111 !important;
          border-color: #262626 !important;
        }
        body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] a,
        body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] button {
          color: #a1a1aa !important;
        }
        body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] a[class*="bg-brand-50"],
        body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] a:hover {
          background: #2563eb !important;
          color: #ffffff !important;
        }
        body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] svg {
          color: currentColor !important;
        }
        body header[class*="bg-white"][class*="border-b"] {
          background: #111111 !important;
          border-color: #262626 !important;
          box-shadow: none !important;
        }
        body header[class*="bg-white"] h1,
        body header[class*="bg-white"] button,
        body header[class*="bg-white"] span {
          color: #e4e4e7 !important;
        }
        body header[class*="bg-white"] input,
        body header[class*="bg-white"] [role="button"] {
          background: #171717 !important;
          border-color: #262626 !important;
          color: #e4e4e7 !important;
        }
      `}</style>
      <div className="mx-auto max-w-[1408px] space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-500">Inventory</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Inventory Items</h2>
          <p className="mt-1 text-sm text-zinc-500">Manage your ingredient list and maintain optimal par levels.</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <button
            onClick={() => setIsHistoryDrawerOpen(true)}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-[#151515] px-3 py-2 text-xs font-medium text-zinc-300 shadow-sm transition-colors hover:bg-[#1f1f1f] sm:text-sm"
          >
            <History className="h-3.5 w-3.5" />
            <span className="hidden xs:inline sm:inline">History</span>
          </button>
          <button
            onClick={() => setIsDuplicateAuditOpen(true)}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-200 shadow-sm transition-colors hover:bg-amber-500/15 sm:text-sm"
          >
            <GitMerge className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Duplicate Audit</span>
            <span className="sm:hidden">Audit</span>
          </button>
          <button
            onClick={() => {
              setImportPreview([]);
              setImportErrors([]);
              setIsImportDrawerOpen(true);
            }}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-[#151515] px-3 py-2 text-xs font-medium text-zinc-300 shadow-sm transition-colors hover:bg-[#1f1f1f] sm:text-sm"
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
            className="flex items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white shadow-lg shadow-violet-600/20 transition-colors hover:bg-violet-500 sm:text-sm"
          >
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Import Suppliers</span>
            <span className="sm:hidden">Import Sup</span>
          </button>
          <button
            onClick={() => setIsAddDrawerOpen(true)}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white shadow-lg shadow-blue-600/20 transition-colors hover:bg-blue-500 sm:text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add Item
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Active SKUs", value: activeSkuCount.toLocaleString(), helper: `${filteredInventory.length.toLocaleString()} match filters`, icon: <ShoppingCart className="h-5 w-5" />, tone: "blue" },
          { label: "Inventory Value", value: `$${inventoryValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, helper: "Stock × preferred cost", icon: <Download className="h-5 w-5" />, tone: "emerald" },
          { label: "Low Stock", value: lowStockCount.toLocaleString(), helper: "30-70% of par level", icon: <AlertTriangle className="h-5 w-5" />, tone: "amber" },
          { label: "Critical", value: criticalStockCount.toLocaleString(), helper: "Below 30% of par level", icon: <AlertTriangle className="h-5 w-5" />, tone: "red" },
        ].map(metric => (
          <Card key={metric.label} className="rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
            <CardContent className="flex items-start justify-between p-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{metric.label}</p>
                <p className="mt-3 text-2xl font-semibold tracking-tight text-white">{metric.value}</p>
                <p className="mt-1 text-xs text-zinc-600">{metric.helper}</p>
              </div>
              <div className={`rounded-lg p-2 ${
                metric.tone === "emerald" ? "bg-emerald-500/15 text-emerald-300" :
                metric.tone === "amber" ? "bg-amber-500/15 text-amber-300" :
                metric.tone === "red" ? "bg-red-500/15 text-red-300" :
                "bg-blue-500/15 text-blue-300"
              }`}>
                {metric.icon}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── HQ-only: Duplicate Detection Panel ──────────────────────────────── */}
      {isHqAdmin(user) && duplicateGroups.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-amber-500/20 bg-amber-500/10">
          <button
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-500/10"
            onClick={() => setShowDuplicatePanel(p => !p)}
          >
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-300" />
              Potential Duplicate Products
              <span className="ml-1 rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-bold text-amber-100">
                {duplicateGroups.length}
              </span>
            </span>
            {showDuplicatePanel
              ? <ChevronDown className="h-4 w-4 text-amber-300" />
              : <ChevronRight className="h-4 w-4 text-amber-300" />
            }
          </button>

          {showDuplicatePanel && (
            <div className="px-4 pb-4 space-y-3">
              <p className="text-xs text-amber-200/80">
                These product names normalize to the same canonical form but have different shared identities (item_id).
                This may indicate accidental duplicate entries. Review and merge the identity if appropriate.
              </p>
              {duplicateGroups.map((group) => (
                <div key={group.normalizedName} className="space-y-2 rounded-lg border border-amber-500/20 bg-[#111111] p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wide text-amber-200">Canonical form:</span>
                    <span className="rounded bg-amber-400/10 px-2 py-0.5 font-mono text-xs text-amber-100">&quot;{group.normalizedName}&quot;</span>
                    <span className="text-[10px] text-amber-300/80">{group.candidates.length} distinct item_ids</span>
                  </div>
                  <div className="space-y-1.5">
                    {group.candidates.map((candidate, ci) => {
                      const repRow = candidate.rows[0];
                      const isCanonical = ci === 0; // first (oldest by sort) treated as canonical
                      return (
                        <div key={candidate.itemId} className={`flex flex-col sm:flex-row sm:items-center gap-2 p-2 rounded-lg text-xs ${
                          isCanonical ? 'border border-violet-500/30 bg-violet-500/10' : 'border border-white/10 bg-[#171717]'
                        }`}>
                          <div className="flex-1 min-w-0">
                            <span className="font-semibold text-zinc-100">{repRow?.name ?? "(no name)"}</span>
                            {isCanonical && <span className="ml-2 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-bold text-violet-200">CANONICAL</span>}
                            <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">
                              item_id: {candidate.itemId.slice(0, 18)}…
                            </div>
                            <div className="mt-0.5 text-[10px] text-zinc-500">
                              {candidate.rows.length} location{candidate.rows.length !== 1 ? 's' : ''}
                              {' · '}
                              Cost: ${(repRow?.cost ?? 0).toFixed(2)}/{repRow?.baseUnit ?? repRow?.unit ?? 'unit'}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => setSharedLinkedDrawerItem(repRow)}
                              className="flex items-center gap-1 rounded-md border border-white/10 bg-[#202020] px-2 py-1 text-[10px] font-semibold text-zinc-200 shadow-sm transition-colors hover:bg-[#2a2a2a]"
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
                                className="flex items-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[10px] font-semibold text-white shadow-sm transition-colors hover:bg-violet-500"
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

      <Card className="overflow-hidden rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.32)]">
        <CardHeader className="flex flex-col justify-between gap-3 border-b border-white/10 bg-[#111111] px-4 py-4 sm:flex-row sm:items-center">
          <div className="relative w-full sm:w-[360px]">
            <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none">
              <Search className="h-3.5 w-3.5 text-zinc-500" />
            </div>
            <input
              type="text"
              placeholder="Search items…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-[#171717] py-2 pl-8 pr-3 text-sm text-zinc-100 transition-colors placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <select
              className="rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-xs font-medium text-zinc-200 shadow-sm outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="All">All Statuses</option>
              <option value="Healthy">Healthy</option>
              <option value="Low">Low</option>
              <option value="Critical">Critical</option>
            </select>
            <select
              className="rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-xs font-medium text-zinc-200 shadow-sm outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm"
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
            >
              <option value="All">All Categories</option>
              {uniqueCategories.map(c => <option key={c as string} value={c as string}>{c as string}</option>)}
            </select>
            <select
              className="rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-xs font-medium text-zinc-200 shadow-sm outline-none focus:ring-1 focus:ring-blue-500 sm:text-sm"
              value={filterSupplier}
              onChange={(e) => setFilterSupplier(e.target.value)}
            >
              <option value="All">All Suppliers</option>
              {uniqueSuppliers.map(s => <option key={s as string} value={s as string}>{s as string}</option>)}
            </select>

            {(searchQuery || filterStatus !== 'All' || filterCategory !== 'All' || filterSupplier !== 'All') && (
              <button
                onClick={clearFilters}
                className="rounded-lg px-2 text-xs font-semibold text-blue-300 transition-colors hover:bg-blue-500/10 hover:text-blue-200"
              >
                Clear
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {selectedItemIds.length > 0 && (
            <div className="flex items-center justify-between border-b border-blue-500/20 bg-blue-500/10 p-3 px-6 transition-all">
              <span className="text-sm font-semibold text-blue-100">{selectedItemIds.length} operational node{selectedItemIds.length !== 1 ? 's' : ''} targeted</span>
              <div className="flex gap-4 items-center">
                <button onClick={() => setSelectedItemIds([])} className="text-xs font-semibold text-blue-200 transition-colors hover:text-white">Clear Targets</button>
                {isLondonTemplateLocationActive ? (
                  <button
                    onClick={openCopyInventoryModal}
                    title="Push selected London template inventory setup to other locations"
                    className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-blue-500"
                  >
                    <Copy className="h-3 w-3" /> Copy London Setup to Locations
                  </button>
                ) : isHqAdmin(user) ? (
                  <span className="rounded border border-blue-500/20 bg-black/20 px-3 py-1.5 text-xs font-semibold text-blue-200/80">
                    Switch to London / LOC-1091 template location to copy setup.
                  </span>
                ) : null}
                <button
                  onClick={() => setIsDeleteModalOpen(true)}
                  className="flex items-center gap-1.5 rounded bg-red-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-red-500"
                >
                  <Trash2 className="h-3 w-3" /> Execute Purge
                </button>
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
          <Table className="text-xs sm:text-sm">
            <TableHeader className="border-b border-white/10 bg-[#161616] text-xs uppercase tracking-[0.16em] text-zinc-500">
              <TableRow>
                <TableHead className="w-[36px] pl-3 sm:pl-6 pr-1 py-2 sm:py-3">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 cursor-pointer rounded border-white/20 bg-[#171717] text-blue-600 focus:ring-blue-500 sm:h-4 sm:w-4"
                    checked={filteredInventory.length > 0 && selectedItemIds.length === filteredInventory.length}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedItemIds(filteredInventory.map(i => i.id));
                      else setSelectedItemIds([]);
                    }}
                  />
                </TableHead>
                <TableHead className="px-2 py-2 font-semibold transition-colors hover:text-blue-300 sm:px-3 sm:py-3 cursor-pointer select-none" onClick={() => { setSortDirection(sortKey === 'name' && sortDirection === 'asc' ? 'desc' : 'asc'); setSortKey('name') }}>Item Name</TableHead>
                <TableHead className="hidden px-2 py-2 font-semibold transition-colors hover:text-blue-300 sm:table-cell sm:px-3 sm:py-3 cursor-pointer select-none" onClick={() => { setSortDirection(sortKey === 'category' && sortDirection === 'asc' ? 'desc' : 'asc'); setSortKey('category') }}>Category</TableHead>
                <TableHead className="hidden py-2 font-semibold text-zinc-500 sm:py-3 md:table-cell">Unit</TableHead>
                <TableHead className="hidden py-2 font-semibold transition-colors hover:text-blue-300 sm:py-3 lg:table-cell cursor-pointer select-none" onClick={() => { setSortDirection(sortKey === 'supplier' && sortDirection === 'asc' ? 'desc' : 'asc'); setSortKey('supplier') }}>Preferred Supplier</TableHead>
                <TableHead className="py-2 font-semibold text-zinc-500 sm:py-3">Stock &amp; Par</TableHead>
                <TableHead className="hidden py-2 font-semibold text-zinc-500 sm:table-cell sm:py-3">Cost / Unit</TableHead>
                <TableHead className="py-2 font-semibold text-zinc-500 sm:py-3">Status</TableHead>
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
                    className={`cursor-pointer border-b border-white/5 transition-colors hover:bg-[#171717] ${selectedItemIds.includes(item.id) ? 'bg-blue-500/10' : 'bg-[#111111]'}`}
                    onClick={() => openItemDrawer(item)}
                  >
                    <TableCell className="pl-3 sm:pl-6 pr-1 py-2.5 sm:py-4">
                      <div onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 cursor-pointer rounded border-white/20 bg-[#171717] text-blue-600 focus:ring-blue-500"
                          checked={selectedItemIds.includes(item.id)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedItemIds([...selectedItemIds, item.id]);
                            else setSelectedItemIds(selectedItemIds.filter(id => id !== item.id));
                          }}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="px-2 sm:px-3 py-2.5 sm:py-4">
                      <div className="flex flex-col gap-0.5">
                        {/* Name + type badges on same line */}
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-semibold leading-tight text-zinc-100 sm:text-sm">{item.name}</span>
                          {item.itemType === 'Preparation' && <Badge variant="warning" className="border-none bg-orange-500/15 px-1 py-0 text-[9px] text-orange-300">PREP</Badge>}
                          {item.itemType === 'Finished Good' && <Badge variant="success" className="border-none bg-emerald-500/15 px-1 py-0 text-[9px] text-emerald-300">FG</Badge>}
                        </div>
                        {/* HQ-only: Shared Product badge — shown when ≥ 2 rows share this item_id */}
                        {isHqAdmin(user) && item.itemId && ((item.sharedLocationCount ?? linkedCountByItemId.get(item.itemId) ?? 0) > 1) && (() => {
                          const count = item.sharedLocationCount ?? linkedCountByItemId.get(item.itemId)!;
                          return (
                            <button
                              onClick={(e) => { e.stopPropagation(); setSharedLinkedDrawerItem(item); }}
                              title={`Shared across ${count} location rows — click to inspect all`}
                              className="inline-flex cursor-pointer select-none items-center gap-1 self-start rounded-full border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-bold text-violet-200 transition-colors hover:bg-violet-500/20"
                            >
                              <Link2 className="h-2.5 w-2.5 shrink-0" />
                              Shared &bull; {count} location{count !== 1 ? "s" : ""}
                            </button>
                          );
                        })()}
                      </div>
                    </TableCell>
                    <TableCell className="px-2 sm:px-3 py-2.5 sm:py-4 hidden sm:table-cell">
                      <span className="whitespace-nowrap rounded-md border border-white/10 bg-[#1a1a1a] px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400 sm:px-2 sm:py-1 sm:text-xs">{item.category}</span>
                    </TableCell>
                    <TableCell className="py-2.5 sm:py-4 hidden md:table-cell">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{item.baseUnit || item.unit}</span>
                        {item.purchaseUnits && item.purchaseUnits.length > 0 && (
                          <span className="text-[10px] text-zinc-600">
                            Buy: {item.purchaseUnits.find((u: any) => u.isPrimary)?.name || item.purchaseUnits[0].name}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 sm:py-4 hidden lg:table-cell">
                      {(() => {
                        const displayName = item.preferredSupplierName ?? getSupplierName(item.supplierId);
                        console.log('[ListRow supplier]', { id: item.id, name: item.name, preferredSupplierName: item.preferredSupplierName, supplierId: item.supplierId, displayed: displayName });
                        return <span className="block max-w-[120px] truncate text-xs font-medium text-zinc-300 sm:text-sm">{displayName}</span>;
                      })()}
                    </TableCell>
                    <TableCell className="py-2.5 sm:py-4">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-baseline gap-0.5">
                          <span className={`text-xs font-bold sm:text-sm ${isCritical ? "text-red-400" : isLowStock ? "text-amber-300" : "text-zinc-100"}`}>
                            {item.inStock}
                          </span>
                          <span className="text-[10px] text-zinc-600">/ {item.parLevel} {item.baseUnit || item.unit}</span>
                        </div>
                        {item.purchaseUnits && item.purchaseUnits.length > 0 && (() => {
                          const pUnit = item.purchaseUnits.find((u: any) => u.isPrimary) || item.purchaseUnits[0];
                          const pStock = (item.inStock / pUnit.conversion).toFixed(1);
                          return <span className="block text-[10px] font-semibold text-blue-300">{pStock} {pUnit.name}s</span>
                        })()}
                      </div>
                    </TableCell>
                    <TableCell className="hidden py-2.5 text-xs text-zinc-300 sm:table-cell sm:py-4 sm:text-sm">
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
                            className="hidden items-center gap-1.5 rounded-md border border-blue-500/20 bg-blue-500/10 px-2.5 py-1.5 text-xs font-semibold text-blue-200 shadow-sm transition-colors hover:bg-blue-500/20 sm:flex"
                          >
                            <ShoppingCart className="h-3 w-3" />
                            <span className="hidden md:inline">Quick Reorder</span>
                          </button>
                        )}
                        {/* Three-dot action menu */}
                        <div className="relative">
                          <button
                            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100"
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
                              <div className="absolute right-0 top-8 z-20 min-w-[200px] animate-in rounded-xl border border-white/10 bg-[#151515] py-1 shadow-2xl shadow-black/50 fade-in slide-in-from-top-1 duration-100">
                                <button
                                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium text-zinc-200 transition-colors hover:bg-white/10"
                                  onClick={() => openEditDrawer(item)}
                                >
                                  <Save className="h-3.5 w-3.5 text-blue-300" /> Edit Item
                                </button>
                                <button
                                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium text-zinc-200 transition-colors hover:bg-white/10"
                                  onClick={() => { setOpenMenuId(null); openItemDrawer(item); }}
                                >
                                  <ArrowUp className="h-3.5 w-3.5 text-emerald-300" /> Adjust Stock
                                </button>
                                {/* HQ-only: Allocate to Locations */}
                                {isHqAdmin(user) && (
                                  <button
                                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium text-violet-200 transition-colors hover:bg-violet-500/10"
                                    onClick={() => {
                                      setOpenMenuId(null);
                                      setAllocationItem(item);
                                      setAllocationLocations([]);
                                      setAllocationResult(null);
                                      setCopySupplier(true);
                                      setCopyCost(true);
                                      setStartingPar(0);
                                    }}
                                  >
                                    <MapPin className="h-3.5 w-3.5" /> Allocate to Locations
                                  </button>
                                )}
                                <div className="my-1 border-t border-white/10" />
                                <button
                                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium text-red-300 transition-colors hover:bg-red-500/10"
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
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-zinc-500">
                    No inventory items match your active filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>{/* /overflow-x-auto */}

          {/* ── Pagination controls ─────────────────────────────────────── */}
          <div className="flex items-center justify-between border-t border-white/10 bg-[#111111] px-4 py-3">
            <span className="select-none text-xs text-zinc-500">
              {filteredInventory.length === 0
                ? "No items"
                : `Showing ${displayStart}–${displayEnd} of ${filteredInventory.length} items`}
            </span>
            <div className="flex items-center gap-2">
              <button
                id="inventory-pagination-prev"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={safeCurrentPage <= 1}
                className="rounded-md border border-white/10 bg-[#171717] px-3 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:bg-[#202020] disabled:cursor-not-allowed disabled:opacity-40"
              >
                ← Previous
              </button>
              <span className="select-none text-xs text-zinc-500">
                Page {safeCurrentPage} of {totalPages}
              </span>
              <button
                id="inventory-pagination-next"
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={safeCurrentPage >= totalPages}
                className="rounded-md border border-white/10 bg-[#171717] px-3 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:bg-[#202020] disabled:cursor-not-allowed disabled:opacity-40"
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
                  {isStockCorrupted(selectedItem) ? (
                    <span className="text-base font-bold text-red-600">Invalid stock</span>
                  ) : (
                    <span className={`text-3xl font-bold ${safeStock(selectedItem) < Number(selectedItem.parLevel || 0) ? 'text-danger-600' : 'text-neutral-900'}`}>{safeStock(selectedItem)}</span>
                  )}
                  <span className="text-sm text-neutral-500 font-medium mb-1">/ {selectedItem.parLevel} {selectedItem.unit}</span>
                </div>
              </div>
              <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Total Value Held</p>
                <div className="mt-1">
                  {(() => {
                    const sv = safeStock(selectedItem);
                    const cv = Number(selectedItem.cost);
                    if (!Number.isFinite(sv) || !Number.isFinite(cv)) return <span className="text-3xl font-bold text-neutral-400">—</span>;
                    return <span className="text-3xl font-bold text-neutral-900">${(sv * cv).toFixed(2)}</span>;
                  })()}
                </div>
	              </div>
	            </div>

            {/* ─────────────────────────────────────────────────
                 SECTION 1: SET FINAL STOCK COUNT (PRIMARY)
            ──────────────────────────────────────────────── */}
            {(() => {
              const preview = getStockCorrectionPreview(selectedItem);
              const baseUnit = selectedItem.baseUnit || selectedItem.unit;
              const unitOptions = getStockCorrectionUnitOptions(selectedItem);
              const selectedUnitOpt = unitOptions.find(o => o.name === (stockCorrectionUnit || baseUnit)) ?? unitOptions[0];
              return (
                <div>
                  <h3 className="text-sm font-bold text-neutral-900 mb-1 uppercase tracking-wider flex items-center justify-between border-b border-neutral-100 pb-2">
                    <span className="flex items-center gap-2"><Save className="h-4 w-4 text-brand-600" /> Set Final Stock Count</span>
                    <span className="text-[10px] text-emerald-600 font-bold bg-emerald-50 px-2 py-0.5 rounded uppercase">Primary</span>
                  </h3>
                  <p className="text-[11px] text-neutral-500 mb-3">Use this for physical counts. This sets stock to exactly what you enter.</p>
                  {preview.corrupted && (
                    <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700 font-medium">
                      ⚠️ Invalid stock value detected. Use Set Final Stock to overwrite with a clean numeric value.
                    </div>
                  )}
                  <div className="bg-white border border-neutral-200 rounded-lg p-4 space-y-4 shadow-sm">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-neutral-900">Physical Count Quantity</label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={stockCorrectionQty}
                          onChange={(e) => { setStockCorrectionQty(e.target.value); setStockCorrectionConfirm(""); }}
                          className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                          placeholder="e.g. 1"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-neutral-900">Unit</label>
                        <select
                          value={stockCorrectionUnit || baseUnit}
                          onChange={(e) => { setStockCorrectionUnit(e.target.value); setStockCorrectionConfirm(""); }}
                          className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                        >
                          {unitOptions.map(option => (
                            <option key={option.name} value={option.name}>
                              {option.isBase ? option.name : `${option.name} = ${option.conversion} ${baseUnit}`}
                            </option>
                          ))}
                        </select>
                        {!selectedUnitOpt.isBase && (
                          <p className="text-[10px] text-brand-600 font-medium">
                            1 {selectedUnitOpt.name} = {selectedUnitOpt.conversion} {baseUnit}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-neutral-900">Reason / Notes <span className="text-red-500">*</span></label>
                      <input
                        type="text"
                        value={stockCorrectionReason}
                        onChange={(e) => setStockCorrectionReason(e.target.value)}
                        className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        placeholder="Required: reason for this count correction"
                      />
                    </div>
                    {/* Preview */}
                    <div className="rounded-lg border border-brand-100 bg-brand-50 p-3 text-xs text-neutral-700 space-y-1">
                      <div>Entered count: <strong>{preview.enteredQty ?? '—'} {selectedUnitOpt.name}</strong></div>
                      <div>Converted final stock: <strong className="text-emerald-700">{preview.targetBaseQty != null ? `${preview.targetBaseQty} ${baseUnit}` : '—'}</strong></div>
                      <div>Current stock: <strong>{preview.corrupted ? 'Invalid ⚠' : `${preview.currentBaseQty} ${baseUnit}`}</strong></div>
                      {preview.delta != null && (
                        <div>Adjustment system will post: <strong className={(preview.delta) < 0 ? 'text-red-700' : 'text-green-700'}>{preview.delta > 0 ? '+' : ''}{preview.delta.toFixed(4)} {baseUnit}</strong></div>
                      )}
                    </div>
                    {preview.isHuge && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 space-y-2">
                        <div className="font-bold">Large correction detected</div>
                        <p>Type CONFIRM to apply this exact stock correction.</p>
                        <input
                          value={stockCorrectionConfirm}
                          onChange={(e) => setStockCorrectionConfirm(e.target.value)}
                          className="w-full py-2 px-3 border border-amber-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
                          placeholder="CONFIRM"
                        />
                      </div>
                    )}
                    <button
                      disabled={isApplyingStockCorrection || preview.targetBaseQty === null || !stockCorrectionReason.trim() || (preview.isHuge && stockCorrectionConfirm.trim() !== "CONFIRM")}
                      onClick={applyStockCorrection}
                      className="w-full py-2.5 bg-brand-600 text-white rounded text-sm font-bold hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      <Save className="h-4 w-4" /> {isApplyingStockCorrection ? "Applying..." : "Set Final Stock"}
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* ────────────────────────────────────────────────
                 SECTION 2: RECEIVE / REMOVE / WASTE
            ──────────────────────────────────────────────── */}
	            <div>
	              <h3 className="text-sm font-bold text-neutral-900 mb-1 uppercase tracking-wider flex items-center justify-between border-b border-neutral-100 pb-2">
	                <span className="flex items-center gap-2"><ArrowUp className="h-4 w-4 text-brand-600" /> Receive / Remove / Waste Stock</span>
                <span className="text-[10px] text-neutral-400 font-medium uppercase">{userRole} access</span>
              </h3>
              <p className="text-[11px] text-neutral-500 mb-3">Use this only when adding or removing stock from the current balance.</p>
              {isStockCorrupted(selectedItem) && (
                <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700 font-medium">
                  ⚠️ Stock value is corrupted. Use “Set Final Stock Count” above to fix it before posting movements.
                </div>
              )}
              <div className="bg-white border border-neutral-200 rounded-lg p-4 space-y-4 shadow-sm">
                {(() => {
                  const baseUnit = selectedItem.baseUnit || selectedItem.unit;
                  const unitOptions = getStockCorrectionUnitOptions(selectedItem);
                  const selOpt = unitOptions.find(u => u.name === adjUnit) ?? unitOptions[0];
                  const numericQty = parseFloat(adjQty);
                  const previewBase = Number.isFinite(numericQty) && numericQty > 0 ? numericQty * selOpt.conversion : null;
                  const currentSafe = safeStock(selectedItem);
                  const previewFinal = previewBase != null ? (adjType === 'Add' ? currentSafe + previewBase : currentSafe - previewBase) : null;
                  return (<>
                    <div className="flex gap-2">
                      <button onClick={() => setAdjType("Add")} className={`flex-1 py-1.5 border rounded flex items-center justify-center gap-1.5 text-xs font-semibold transition-all ${adjType === "Add" ? 'ring-2 ring-offset-1 text-success-700 bg-success-50 border-success-200 ring-success-500' : 'bg-white text-neutral-500 hover:bg-neutral-50'}`}><Plus className="h-3 w-3" /> Receive</button>
                      <button onClick={() => setAdjType("Remove")} className={`flex-1 py-1.5 border rounded flex items-center justify-center gap-1.5 text-xs font-semibold transition-all ${adjType === "Remove" ? 'ring-2 ring-offset-1 text-warning-700 bg-warning-50 border-warning-200 ring-warning-500' : 'bg-white text-neutral-500 hover:bg-neutral-50'}`}><ArrowDown className="h-3 w-3" /> Remove</button>
                      <button onClick={() => setAdjType("Waste")} className={`flex-1 py-1.5 border rounded flex items-center justify-center gap-1.5 text-xs font-semibold transition-all ${adjType === "Waste" ? 'ring-2 ring-offset-1 text-danger-700 bg-danger-50 border-danger-200 ring-danger-500' : 'bg-white text-neutral-500 hover:bg-neutral-50'}`}><Trash2 className="h-3 w-3" /> Waste</button>
                    </div>
                    <div className="flex gap-3">
                      <div className="flex-1 space-y-1.5">
                        <label className="text-xs font-semibold text-neutral-900">Quantity</label>
                        <input type="number" min="0" step="0.1" value={adjQty} onChange={(e) => setAdjQty(e.target.value)} className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g., 1" />
                      </div>
                      <div className="flex-1 space-y-1.5">
                        <label className="text-xs font-semibold text-neutral-900">Unit</label>
                        <select value={adjUnit || baseUnit} onChange={(e) => setAdjUnit(e.target.value)} className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                          {unitOptions.map((u) => (
                            <option key={u.name} value={u.name}>
                              {u.isBase ? u.name : `${u.name} = ${u.conversion} ${baseUnit}`}
                            </option>
                          ))}
                        </select>
                        {!selOpt.isBase && <p className="text-[10px] text-brand-600 font-medium">1 {selOpt.name} = {selOpt.conversion} {baseUnit}</p>}
                      </div>
                    </div>
                    {previewBase != null && (
                      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-2.5 text-xs text-neutral-700 space-y-0.5">
                        <div>Entered: <strong>{numericQty} {selOpt.name}</strong> → <strong>{previewBase.toFixed(4)} {baseUnit}</strong></div>
                        <div>Current stock: <strong>{currentSafe} {baseUnit}</strong></div>
                        <div>New stock after {adjType.toLowerCase()}: <strong className={previewFinal != null && previewFinal < 0 ? 'text-red-600' : 'text-emerald-700'}>{previewFinal?.toFixed(4) ?? '—'} {baseUnit}</strong></div>
                        {previewFinal != null && previewFinal < 0 && <div className="text-red-600 font-semibold">⚠ Result would be negative. Check quantity.</div>}
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-neutral-900">Notes / Reason</label>
                      <input type="text" value={adjNotes} onChange={(e) => setAdjNotes(e.target.value)} className="w-full py-2 px-3 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Optional details..." />
                    </div>
                    <button disabled={!adjQty || parseFloat(adjQty) <= 0 || isStockCorrupted(selectedItem)} onClick={saveAdjustment} className="w-full py-2 bg-neutral-900 text-white rounded text-sm font-semibold hover:bg-neutral-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                      <Save className="h-4 w-4" /> Commit {adjType}
                    </button>
                  </>);
                })()}
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
	                  activityData[selectedItem.id].map((log: any, idx: number) => {
                      const canSafelyVoid = Number.isFinite(Number(log.baseTransacted)) && !log.corrected;
                      return (
	                    <div key={log.id ?? idx} className={`flex items-start justify-between rounded-lg p-3 border ${log.voided ? 'bg-red-50 border-red-100 opacity-60' : log.corrected ? 'bg-amber-50 border-amber-100 opacity-75' : 'bg-neutral-50 border-neutral-100'}`}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                            log.type === 'Add'        ? 'bg-success-100 text-success-700' :
                            log.type === 'Remove'     ? 'bg-warning-100 text-warning-700' :
                            log.type === 'Par Update' ? 'bg-brand-100 text-brand-700'    :
                                                        'bg-danger-100 text-danger-700'
                          }`}>{log.type}</span>
                          <span className="text-sm font-bold text-neutral-900">
                            {log.type === 'Par Update'
                              ? `${log.qty} net shift`
                              : log.baseTransacted
                                ? `${log.baseTransacted > 0 ? '+' : ''}${log.baseTransacted} ${selectedItem.baseUnit || selectedItem.unit} (${log.qty})`
                                : `${String(log.qty).startsWith('-') ? '' : (log.type === 'Add' ? '+' : '-')}${log.qty}`
                            }
                          </span>
                          {log.voided && (
                            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">⊘ Voided</span>
                          )}
                          {log.corrected && (
                            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">✎ Corrected</span>
                          )}
                          {log.isCorrectionOf !== undefined && (
                            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 border border-violet-200">Δ Correction</span>
                          )}
                          {log.isVoidOf !== undefined && (
                            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200">↺ Reversal</span>
                          )}
                        </div>
                        {log.notes && <p className="text-[11px] font-medium text-neutral-600 mt-1">{log.notes}</p>}
                        {log.user  && <p className="text-[10px] text-neutral-400 uppercase tracking-wide mt-1">- Authenticated via {log.user}</p>}
                      </div>
                      <div className="flex flex-col items-end gap-1 ml-3 shrink-0">
                        <span className="text-xs font-medium text-neutral-700">{log.date}</span>
                        <span className="text-[10px] text-neutral-400">{log.time}</span>
                        {/* HQ-only correction controls — hidden for already-voided/corrected entries */}
                        {isHqAdmin(user) && !log.voided && !log.isCorrectionOf && !log.isVoidOf && (
                          <div className="flex gap-1 mt-1">
                            {!log.corrected && (
                              <button
                                type="button"
                                onClick={() => {
                                  setCorrectionModal({ log, logIdx: idx, mode: 'edit' });
                                  setCorrReason('');
                                  setCorrNewQty(String(log.qty ?? '').replace(/[^0-9.\-]/g, ''));
                                }}
                                className="px-2 py-0.5 text-[10px] font-semibold rounded border border-violet-300 text-violet-700 hover:bg-violet-50 transition-colors"
                                title="Correct this entry"
                              >✎ Correct</button>
                            )}
	                            {!log.voided && (
	                              <button
	                                type="button"
	                                onClick={() => {
                                      if (!canSafelyVoid) return;
	                                  setCorrectionModal({ log, logIdx: idx, mode: 'void' });
	                                  setCorrReason('');
	                                  setCorrNewQty('');
	                                }}
	                                disabled={!canSafelyVoid}
	                                className="px-2 py-0.5 text-[10px] font-semibold rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
	                                title={canSafelyVoid ? "Void / reverse this exact base-unit entry" : "This old movement cannot be safely voided. Use Set Stock to Correct Count instead."}
	                              >⊘ Void</button>
	                            )}
                          </div>
                        )}
                      </div>
	                    </div>
                      );
                    })
	                )}
              </div>
            </div>
          </div>
        )}
      </Drawer>

      {/* ── HQ Correction / Void Modal ───────────────────────────────────────── */}
      {correctionModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-[2px]">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            {/* Header */}
            <div className={`px-6 py-4 ${correctionModal.mode === 'void' ? 'bg-red-600' : 'bg-violet-700'}`}>
              <h2 className="text-base font-bold text-white">
                {correctionModal.mode === 'void' ? '⊘ Void / Reverse Entry' : '✎ Correct Entry'}
              </h2>
              <p className="text-xs text-white/80 mt-0.5">
                {correctionModal.mode === 'void'
                  ? 'Creates an equal-opposite movement. Original record is preserved.'
                  : 'Creates a delta correction movement. Original record is preserved.'}
              </p>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Original entry info */}
              <div className="bg-neutral-50 border border-neutral-200 rounded-lg px-4 py-3">
                <p className="text-[10px] font-bold uppercase text-neutral-400 mb-1">Original Entry</p>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                    correctionModal.log.type === 'Add' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                  }`}>{correctionModal.log.type}</span>
                  <span className="text-sm font-semibold text-neutral-800">{correctionModal.log.qty}</span>
                  <span className="text-[10px] text-neutral-400">{correctionModal.log.date} {correctionModal.log.time}</span>
                </div>
                {correctionModal.log.notes && (
                  <p className="text-xs text-neutral-500 mt-1 italic">{correctionModal.log.notes}</p>
                )}
              </div>

              {/* Reason — mandatory */}
              <div>
                <label className="text-xs font-semibold text-neutral-700 block mb-1">
                  Reason <span className="text-red-500">*</span>
                </label>
                <select
                  value={corrReason}
                  onChange={e => setCorrReason(e.target.value)}
                  className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 bg-white"
                >
                  <option value="">— Select reason —</option>
                  <option value="Wrong entry">Wrong entry</option>
                  <option value="Duplicate entry">Duplicate entry</option>
                  <option value="Unit mistake">Unit mistake</option>
                  <option value="Count correction">Count correction</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              {/* New qty — only for edit/correct mode */}
              {correctionModal.mode === 'edit' && (
                <div>
                  <label className="text-xs font-semibold text-neutral-700 block mb-1">
                    Corrected Quantity <span className="text-neutral-400 font-normal">(numeric, same unit)</span>
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={corrNewQty}
                    onChange={e => setCorrNewQty(e.target.value)}
                    placeholder="e.g. 2000"
                    className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                  />
                  {_corrDelta !== null && _corrDelta !== 0 && (
                    <p className={`text-xs font-semibold mt-1 ${_corrDelta > 0 ? 'text-green-600' : 'text-red-600'}`}>
                      → Will create a <strong>{_corrDelta > 0 ? `+${_corrDelta}` : _corrDelta}</strong> correction movement
                    </p>
                  )}

                </div>
              )}

              {correctionModal.mode === 'void' && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                  {_voidCanSafelyReverse ? (
                    <div className="space-y-1 text-xs text-red-700">
                      <p>Original movement: <strong>{Number(correctionModal.log.baseTransacted) > 0 ? '+' : ''}{Number(correctionModal.log.baseTransacted)} {selectedItem?.baseUnit || selectedItem?.unit}</strong></p>
                      <p>Reversal movement: <strong>{_voidReversal > 0 ? `+${_voidReversal}` : _voidReversal} {selectedItem?.baseUnit || selectedItem?.unit}</strong></p>
                      <p>Expected stock after void: <strong>{_voidExpectedStock} {selectedItem?.baseUnit || selectedItem?.unit}</strong></p>
                    </div>
                  ) : (
                    <p className="text-xs text-red-700 font-semibold">
                      This old movement cannot be safely voided because it lacks a reliable base-unit quantity. Use Set Stock to Correct Count instead.
                    </p>
                  )}
                </div>
              )}

              {/* Disclaimer */}
              <p className="text-[10px] text-neutral-400 italic">
                ⚠ Original history is never deleted. This creates a new audit trail entry in inventory_movements.
              </p>
            </div>

            {/* Footer */}
            <div className="px-6 pb-5 flex gap-3">
              <button
                type="button"
                onClick={() => { setCorrectionModal(null); setCorrReason(''); setCorrNewQty(''); }}
                className="flex-1 px-4 py-2 text-sm font-medium bg-neutral-100 text-neutral-700 border border-neutral-200 rounded-lg hover:bg-neutral-200 transition-colors"
              >Cancel</button>
              <button
                type="button"
                disabled={isCorrSaving || !corrReason || (correctionModal.mode === 'void' && !_voidCanSafelyReverse)}
                onClick={correctionModal.mode === 'void' ? commitVoid : commitCorrection}
                className={`flex-1 px-4 py-2 text-sm font-bold rounded-lg text-white transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                  correctionModal.mode === 'void' ? 'bg-red-600 hover:bg-red-700' : 'bg-violet-700 hover:bg-violet-800'
                }`}
              >
                {isCorrSaving
                  ? <><div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
                  : correctionModal.mode === 'void' ? '⊘ Confirm Void' : '✎ Confirm Correction'
                }
              </button>
            </div>
          </div>
        </div>
      )}



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

            {/* Type + Category */}
            <div className="grid grid-cols-2 gap-3">
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
            </div>

            {/* ── Measurement Family ──────────────────────────────────────── */}
            <div className="space-y-2 border border-neutral-200 rounded-lg p-3 bg-neutral-50">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Measurement Family</label>
              <div className="flex flex-wrap gap-2">
                {(['weight', 'volume', 'count', 'labour', 'preparation', 'finished_good'] as const).map(fam => (
                  <button
                    key={fam}
                    type="button"
                    onClick={() => {
                      setEditMeasFamily(fam);
                      setEditInnerMeasUnit('');
                      // Suggest the family default base unit, but keep user's choice if still compatible
                      const allowed = getAllowedBaseUnits(fam);
                      if (!allowed.includes(editUserBaseUnit)) {
                        setEditUserBaseUnit(allowed[0] || '');
                      }
                    }}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                      editMeasFamily === fam
                        ? 'bg-brand-600 text-white border-brand-600 shadow-sm'
                        : 'bg-white text-neutral-600 border-neutral-200 hover:border-brand-400 hover:text-brand-600'
                    }`}
                  >
                    {fam === 'finished_good' ? 'Finished Good' : fam.charAt(0).toUpperCase() + fam.slice(1)}
                  </button>
                ))}
              </div>
              {!editMeasFamily && (
                <p className="text-[11px] text-amber-600">Auto-inferred from base unit. Select to override.</p>
              )}
              {/* ── Base Unit selector (replaces the old locked badge) ──────── */}
              {editMeasFamily && (
                <div className="pt-1 space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">
                    Base Unit <span className="text-neutral-400 font-normal normal-case">(stock, cost, and recipe calculations stored in this unit)</span>
                  </label>
                  <div className="flex gap-2 items-center">
                    <select
                      value={editUserBaseUnit}
                      onChange={e => handleBaseUnitChange(e.target.value)}
                      className="flex-1 p-2 border border-brand-300 rounded text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-brand-500 bg-brand-50 text-brand-800"
                    >
                      {getAllowedBaseUnits(editMeasFamily).map(u => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </select>
                    <span className="text-[10px] text-neutral-500 leading-tight max-w-[120px]">
                      Changing unit will convert existing stock, par &amp; cost.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* ── Structured Packaging ────────────────────────────────────── */}
            <div className="space-y-3 border border-neutral-200 rounded-lg p-3 bg-neutral-50">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider block">Structured Packaging</label>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Purchase Unit Label</label>
                  <select value={editPurchUnitLabel} onChange={e => setEditPurchUnitLabel(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                    {['Case', 'Bag', 'Box', 'Bottle', 'Can', 'Jug', 'Pack', 'Each', 'Barrel', 'Pail'].map(l => <option key={l}>{l}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner Pack Count</label>
                  <input type="number" min="0" step="1" value={editInnerPackCount} onChange={e => setEditInnerPackCount(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. 6" />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner Unit Label</label>
                  <select value={editInnerUnitLabel} onChange={e => setEditInnerUnitLabel(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                    <option value="">— not set —</option>
                    {['Bag', 'Can', 'Bottle', 'Jug', 'Pouch', 'Portion', 'Each'].map(l => <option key={l}>{l}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner Size</label>
                  <input type="number" min="0" step="any" value={editInnerQty} onChange={e => setEditInnerQty(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. 3" />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Measurement Unit</label>
                  <select
                    value={editInnerMeasUnit}
                    onChange={e => setEditInnerMeasUnit(e.target.value)}
                    className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                  >
                    <option value="">— select —</option>
                    {(editMeasFamily ? getFamilyAllowedInnerUnits(editMeasFamily) : ['g','kg','lb','oz','ml','l','fl oz','ea','hr','min']).map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Incompatibility warning */}
              {editInnerMeasUnit && editMeasFamily && (() => {
                const allowed = getFamilyAllowedInnerUnits(editMeasFamily);
                if (!allowed.includes(editInnerMeasUnit)) {
                  return (
                    <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-2.5">
                      <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-red-700 font-medium">
                        <strong>{editInnerMeasUnit}</strong> is not compatible with the <strong>{editMeasFamily}</strong> family.
                        Allowed: {getFamilyAllowedInnerUnits(editMeasFamily).join(', ')}.
                      </p>
                    </div>
                  );
                }
                return null;
              })()}

              {/* Live calculation preview */}
              {(() => {
                const ipc = parseFloat(editInnerPackCount);
                const iqty = parseFloat(editInnerQty);
                if (!editMeasFamily || isNaN(ipc) || isNaN(iqty) || !editInnerMeasUnit) return null;
                const effectiveBase = editUserBaseUnit || deriveLockedBaseUnit(editMeasFamily);
                const baseQty = calcBaseQtyPerPurchaseUnit(editMeasFamily, ipc, iqty, editInnerMeasUnit, effectiveBase);
                const allowed = getFamilyAllowedInnerUnits(editMeasFamily);
                if (baseQty === null || !allowed.includes(editInnerMeasUnit)) return null;
                const innerLabel = editInnerUnitLabel || editInnerMeasUnit;
                const totalInner = ipc * iqty;
                return (
                  <div className="bg-brand-50 border border-brand-200 rounded-lg px-3 py-2.5 space-y-1">
                    <p className="text-[11px] font-bold text-brand-800 tracking-wide uppercase">Auto Calculation</p>
                    <p className="text-[13px] font-semibold text-brand-900">
                      1 {editPurchUnitLabel} = {ipc} {innerLabel}{ipc !== 1 ? 's' : ''} × {iqty} {editInnerMeasUnit}
                      {editInnerMeasUnit !== effectiveBase ? (
                        <span> = {totalInner} {editInnerMeasUnit} = <strong>{baseQty.toFixed(2)} {effectiveBase}</strong></span>
                      ) : (
                        <span> = <strong>{baseQty.toFixed(2)} {effectiveBase}</strong></span>
                      )}
                    </p>
                    <p className="text-[10px] text-brand-600">Calculated Base Qty per Purchase Unit: <strong>{baseQty.toFixed(4)} {effectiveBase}</strong></p>
                  </div>
                );
              })()}

              {/* Cost per Purchase Unit + auto-derived per-base-unit */}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Cost per {editPurchUnitLabel || 'Purchase Unit'} ($)</label>
                  <input type="number" step="0.01" min="0" value={editCostInput} onChange={e => setEditCostInput(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="$0.00" />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Cost per Base Unit (auto)</label>
                  <div className="w-full p-2 border border-neutral-100 bg-white rounded text-sm text-neutral-500 font-mono">
                    {(() => {
                      const ipc = parseFloat(editInnerPackCount);
                      const iqty = parseFloat(editInnerQty);
                      const cost = parseFloat(editCostInput);
                      if (!editMeasFamily || isNaN(ipc) || isNaN(iqty) || !editInnerMeasUnit || isNaN(cost) || cost <= 0) return '—';
                      const effectiveBase = editUserBaseUnit || deriveLockedBaseUnit(editMeasFamily);
                      const baseQty = calcBaseQtyPerPurchaseUnit(editMeasFamily, ipc, iqty, editInnerMeasUnit, effectiveBase);
                      if (!baseQty || baseQty <= 0) return '—';
                      return `$${(cost / baseQty).toFixed(5)} / ${effectiveBase}`;
                    })()}
                  </div>
                </div>
              </div>
            </div>

            {/* Purchase Units (legacy — kept for backward compat with old items) */}

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
                      <SupplierCombobox
                        value={row.supplierName ?? ''}
                        supplierObjects={suppliersData
                          .filter((s: any) => s.id != null && s.name)
                          .map((s: any) => ({ id: Number(s.id), name: String(s.name) }))}
                        onChange={name => updatePurchOptField(row.id, 'supplierName', name)}
                        onSelect={(id, name) => {
                          updatePurchOptField(row.id, 'supplierName', name);
                          if (id !== null) updatePurchOptField(row.id, 'supplierId', id);
                        }}
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
                      <SupplierCombobox
                        value={newPurchOpt.supplierName}
                        supplierObjects={suppliersData
                          .filter((s: any) => s.id != null && s.name)
                          .map((s: any) => ({ id: Number(s.id), name: String(s.name) }))}
                        onChange={name => setNewPurchOpt((p: any) => ({ ...p, supplierName: name }))}
                        onSelect={(id, name) => setNewPurchOpt((p: any) => ({ ...p, supplierId: id, supplierName: name }))}
                      />
                      {newPurchOpt.supplierId && (
                        <p className="text-[9px] text-violet-500 mt-0.5">✓ Linked to master supplier</p>
                      )}
                      {newPurchOpt.supplierName && !newPurchOpt.supplierId && (
                        <p className="text-[9px] text-amber-500 mt-0.5">New supplier — not in master list</p>
                      )}
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
        title="Add Inventory Item"
        description="Define the item's measurement family, packaging structure, and cost."
        footer={
          <div className="flex items-center gap-3">
            <button onClick={() => setIsAddDrawerOpen(false)} className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors w-full">Cancel</button>
            <button onClick={handleAddNewItem} className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm w-full flex items-center justify-center gap-2"><Save className="h-4 w-4" /> Save Item</button>
          </div>
        }
      >
        <div className="space-y-5">

          {/* ── Section 1: Item Identity ──────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Item Name <span className="text-red-500">*</span></label>
              <input type="text" value={newItemName} onChange={e => setNewItemName(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. Whole Garlic Bag" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Item Type</label>
                <select value={newItemType} onChange={e => setNewItemType(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                  <option value="Raw">Raw Asset</option>
                  <option value="Preparation">Preparation Base</option>
                  <option value="Finished Good">Finished Good</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Category</label>
                <select value={newItemCategory} onChange={e => setNewItemCategory(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* ── Section 2: Measurement Family ─────────────────────────────────── */}
          <div className="space-y-2 border border-neutral-200 rounded-lg p-3 bg-neutral-50">
            <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Measurement Family <span className="text-red-500">*</span></label>
            <div className="flex flex-wrap gap-2">
              {(['weight', 'volume', 'count', 'labour', 'preparation', 'finished_good'] as const).map(fam => (
                <button
                  key={fam}
                  type="button"
                  onClick={() => {
                    setNewMeasFamily(fam);
                    setNewInnerMeasUnit('');
                    // Auto-set base unit to the family default when family changes
                    const allowed = getAllowedBaseUnits(fam);
                    if (!newUserBaseUnit || !allowed.includes(newUserBaseUnit)) {
                      setNewUserBaseUnit(allowed[0] || '');
                    }
                  }}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                    newMeasFamily === fam
                      ? 'bg-brand-600 text-white border-brand-600 shadow-sm'
                      : 'bg-white text-neutral-600 border-neutral-200 hover:border-brand-400 hover:text-brand-600'
                  }`}
                >
                  {fam === 'finished_good' ? 'Finished Good' : fam.charAt(0).toUpperCase() + fam.slice(1)}
                </button>
              ))}
            </div>
            {!newMeasFamily && (
              <p className="text-[11px] text-amber-600 font-medium">Select a family to enable base unit selection and unit-compatible packaging.</p>
            )}
            {/* ── Base Unit selector ─────────────────────────────────────────── */}
            {newMeasFamily && (
              <div className="pt-1 space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">
                  Base Unit <span className="text-neutral-400 font-normal normal-case">(stock, cost, and recipe calculations stored in this unit)</span>
                </label>
                <select
                  value={newUserBaseUnit || getAllowedBaseUnits(newMeasFamily)[0]}
                  onChange={e => handleNewBaseUnitChange(e.target.value)}
                  className="w-full p-2 border border-brand-300 rounded text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-brand-500 bg-brand-50 text-brand-800"
                >
                  {getAllowedBaseUnits(newMeasFamily).map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* ── Section 3: Structured Packaging ───────────────────────────────── */}
          <div className="space-y-3 border border-neutral-200 rounded-lg p-3 bg-neutral-50">
            <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider block">Structured Packaging</label>
            <p className="text-[11px] text-neutral-500">Define the purchase pack hierarchy. The system calculates base-unit qty automatically.</p>

            {/* Purchase Unit + Inner Pack Count */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Purchase Unit Label</label>
                <select value={newPurchUnitLabel} onChange={e => setNewPurchUnitLabel(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                  {['Case', 'Bag', 'Box', 'Bottle', 'Can', 'Jug', 'Pack', 'Each', 'Barrel', 'Pail'].map(l => <option key={l}>{l}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner Pack Count</label>
                <input type="number" min="0" step="1" value={newInnerPackCount} onChange={e => setNewInnerPackCount(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. 6" />
                <p className="text-[10px] text-neutral-400">Number of inner units per {newPurchUnitLabel || 'purchase unit'}</p>
              </div>
            </div>

            {/* Inner Unit Label + Inner Qty + Inner Measurement Unit */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner Unit Label</label>
                <select value={newInnerUnitLabel} onChange={e => setNewInnerUnitLabel(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                  <option value="">— not set —</option>
                  {['Bag', 'Can', 'Bottle', 'Jug', 'Pouch', 'Portion', 'Each'].map(l => <option key={l}>{l}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner Size</label>
                <input type="number" min="0" step="any" value={newInnerQty} onChange={e => setNewInnerQty(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. 3" />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Measurement Unit</label>
                <select
                  value={newInnerMeasUnit}
                  onChange={e => setNewInnerMeasUnit(e.target.value)}
                  className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                >
                  <option value="">— select —</option>
                  {(newMeasFamily ? getFamilyAllowedInnerUnits(newMeasFamily) : ['g','kg','lb','oz','ml','l','fl oz','ea','hr','min']).map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Incompatibility warning */}
            {newInnerMeasUnit && newMeasFamily && (() => {
              const allowed = getFamilyAllowedInnerUnits(newMeasFamily);
              if (!allowed.includes(newInnerMeasUnit)) {
                return (
                  <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-2.5">
                    <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <p className="text-[11px] text-red-700 font-medium">
                      <strong>{newInnerMeasUnit}</strong> is not compatible with the <strong>{newMeasFamily}</strong> family.
                      Allowed units: {getFamilyAllowedInnerUnits(newMeasFamily).join(', ')}.
                    </p>
                  </div>
                );
              }
              return null;
            })()}

            {/* Live calculation preview */}
            {(() => {
              const ipc = parseFloat(newInnerPackCount);
              const iqty = parseFloat(newInnerQty);
              if (!newMeasFamily || isNaN(ipc) || isNaN(iqty) || !newInnerMeasUnit) return null;
              const effectiveBase = newUserBaseUnit || deriveLockedBaseUnit(newMeasFamily);
              const baseQty = calcBaseQtyPerPurchaseUnit(newMeasFamily, ipc, iqty, newInnerMeasUnit, effectiveBase);
              const allowed = getFamilyAllowedInnerUnits(newMeasFamily);
              if (baseQty === null || !allowed.includes(newInnerMeasUnit)) return null;
              const innerLabel = newInnerUnitLabel || newInnerMeasUnit;
              const totalInner = ipc * iqty;
              return (
                <div className="bg-brand-50 border border-brand-200 rounded-lg px-3 py-2.5 space-y-1">
                  <p className="text-[11px] font-bold text-brand-800 tracking-wide uppercase">Auto Calculation</p>
                  <p className="text-[13px] font-semibold text-brand-900">
                    1 {newPurchUnitLabel} = {ipc} {innerLabel}{ipc !== 1 ? 's' : ''} × {iqty} {newInnerMeasUnit}
                    {newInnerMeasUnit !== effectiveBase ? (
                      <span> = {totalInner} {newInnerMeasUnit} = <strong>{baseQty.toFixed(2)} {effectiveBase}</strong></span>
                    ) : (
                      <span> = <strong>{baseQty.toFixed(2)} {effectiveBase}</strong></span>
                    )}
                  </p>
                  <p className="text-[10px] text-brand-600">Calculated Base Qty per Purchase Unit: <strong>{baseQty.toFixed(4)} {effectiveBase}</strong></p>
                </div>
              );
            })()}
          </div>

          {/* ── Section 4: Supplier & Cost ────────────────────────────────────── */}
          <div className="space-y-3 border border-neutral-200 rounded-lg p-3 bg-neutral-50">
            <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider block">Supplier &amp; Cost</label>
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Preferred Supplier</label>
              <input list="new-supplier-options" type="text" value={newSupplier} onChange={e => setNewSupplier(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Select or type supplier name..." />
              <datalist id="new-supplier-options">
                {suppliersData.map((s: any) => <option key={s.id} value={s.name} />)}
              </datalist>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Cost per {newPurchUnitLabel || 'Purchase Unit'} ($)</label>
                <input type="number" step="0.01" min="0" value={newCostInput} onChange={e => setNewCostInput(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="$0.00" />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Cost per Base Unit (auto)</label>
                <div className="w-full p-2 border border-neutral-100 bg-white rounded text-sm text-neutral-500 font-mono">
                  {(() => {
                    const ipc = parseFloat(newInnerPackCount);
                    const iqty = parseFloat(newInnerQty);
                    const cost = parseFloat(newCostInput);
                    if (!newMeasFamily || isNaN(ipc) || isNaN(iqty) || !newInnerMeasUnit || isNaN(cost) || cost <= 0) return '—';
                    const effectiveBase = newUserBaseUnit || deriveLockedBaseUnit(newMeasFamily);
                    const baseQty = calcBaseQtyPerPurchaseUnit(newMeasFamily, ipc, iqty, newInnerMeasUnit, effectiveBase);
                    if (!baseQty || baseQty <= 0) return '—';
                    return `$${(cost / baseQty).toFixed(5)} / ${effectiveBase}`;
                  })()}
                </div>
              </div>
            </div>
          </div>

          {/* ── Section 5: Stock ──────────────────────────────────────────────── */}
          <div className="space-y-3 border border-neutral-200 rounded-lg p-3 bg-neutral-50">
            <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider block">Stock Levels</label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Current Stock <span className="text-red-500">*</span></label>
                <input type="number" step="any" value={newInStock} onChange={e => setNewInStock(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="0" />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Par Level <span className="text-red-500">*</span></label>
                <input type="number" step="any" value={addItemParLevel} onChange={e => setAddItemParLevel(e.target.value)} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="0" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Stock Count Unit:</label>
              <div className="flex rounded-md overflow-hidden border border-neutral-200">
                {['base', 'purchase'].map(u => (
                  <button key={u} type="button" onClick={() => setNewStockCountUnit(u)}
                    className={`px-3 py-1 text-[11px] font-semibold transition-colors ${newStockCountUnit === u ? 'bg-brand-600 text-white' : 'bg-white text-neutral-600 hover:bg-neutral-50'}`}>
                    {u === 'base' ? `Base (${newMeasFamily ? (newUserBaseUnit || deriveLockedBaseUnit(newMeasFamily)) : '—'})` : `Purchase (${newPurchUnitLabel || 'Unit'})`}
                  </button>
                ))}
              </div>
            </div>
          </div>

        </div>
      </Drawer>


      {/* ── Base Unit Conversion Confirmation Modal ──────────────────────────── */}
      {baseUnitConvertModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl border border-neutral-200 w-full max-w-md mx-4 overflow-hidden">
            {/* Header */}
            <div className="px-5 py-4 border-b border-neutral-100 flex items-start gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-neutral-900">Change Base Unit?</h3>
                <p className="text-xs text-neutral-500 mt-0.5">
                  Switching from <strong>{baseUnitConvertModal.oldUnit}</strong> to <strong>{baseUnitConvertModal.newUnit}</strong> will convert stock, par level, and cost per base unit.
                  Purchase case price is never changed.
                </p>
              </div>
            </div>
            {/* Conversion table */}
            <div className="px-5 py-4">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-neutral-400 uppercase tracking-wider text-[10px]">
                    <th className="text-left py-1 font-semibold">Field</th>
                    <th className="text-right py-1 font-semibold text-red-500">Before ({baseUnitConvertModal.oldUnit})</th>
                    <th className="text-right py-1 font-semibold text-emerald-600">After ({baseUnitConvertModal.newUnit})</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  <tr>
                    <td className="py-1.5 text-neutral-600 font-medium">Stock</td>
                    <td className="py-1.5 text-right tabular-nums text-neutral-500">{baseUnitConvertModal.oldStock} {baseUnitConvertModal.oldUnit}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-emerald-700">{baseUnitConvertModal.newStock} {baseUnitConvertModal.newUnit}</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 text-neutral-600 font-medium">Par Level</td>
                    <td className="py-1.5 text-right tabular-nums text-neutral-500">{baseUnitConvertModal.oldPar} {baseUnitConvertModal.oldUnit}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-emerald-700">{baseUnitConvertModal.newPar} {baseUnitConvertModal.newUnit}</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 text-neutral-600 font-medium">Cost / Base Unit</td>
                    <td className="py-1.5 text-right tabular-nums text-neutral-500">${baseUnitConvertModal.oldCostPerBase.toFixed(6)}/{baseUnitConvertModal.oldUnit}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-emerald-700">${baseUnitConvertModal.newCostPerBase.toFixed(6)}/{baseUnitConvertModal.newUnit}</td>
                  </tr>
                  {(baseUnitConvertModal.oldPackConversion != null || baseUnitConvertModal.newPackConversion != null) && (
                    <tr>
                      <td className="py-1.5 text-neutral-600 font-medium">Pack Conversion</td>
                      <td className="py-1.5 text-right tabular-nums text-neutral-500">
                        {baseUnitConvertModal.oldPackConversion != null ? `${baseUnitConvertModal.oldPackConversion.toFixed(4)} ${baseUnitConvertModal.oldUnit}/pack` : '—'}
                      </td>
                      <td className="py-1.5 text-right tabular-nums font-semibold text-emerald-700">
                        {baseUnitConvertModal.newPackConversion != null ? `${baseUnitConvertModal.newPackConversion.toFixed(4)} ${baseUnitConvertModal.newUnit}/pack` : '—'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p className="text-[10px] text-neutral-400 mt-3 italic">
                ⚠ Purchase case cost is not changed — only the per-base-unit cost is recalculated.
                If pack conversions look wrong, manually re-enter the Inner Size after saving.
              </p>
            </div>
            {/* Actions */}
            <div className="px-5 py-3 border-t border-neutral-100 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setBaseUnitConvertModal(null)}
                className="px-4 py-2 text-sm font-medium bg-neutral-100 text-neutral-700 rounded-lg hover:bg-neutral-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const modal = baseUnitConvertModal;
                  setEditItem((prev: any) => ({
                    ...prev,
                    inStock:  modal.newStock,
                    parLevel: modal.newPar,
                    cost:     modal.newCostPerBase,
                  }));
                  setEditUserBaseUnit(modal.newUnit);
                  setBaseUnitConvertModal(null);
                }}
                className="px-4 py-2 text-sm font-bold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm"
              >
                Confirm Conversion
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* Duplicate Audit Drawer */}
      <Drawer
        isOpen={isDuplicateAuditOpen}
        onClose={() => setIsDuplicateAuditOpen(false)}
        title="Duplicate Inventory Audit"
        description="Read-only duplicate analysis across inventory_items. No merge, archive, delete, or database cleanup actions are performed here."
        footer={
          <button onClick={() => setIsDuplicateAuditOpen(false)} className="w-full py-2 bg-neutral-100 text-neutral-800 rounded-lg font-medium text-sm hover:bg-neutral-200 transition-colors">
            Close Audit
          </button>
        }
      >
        <div className="space-y-5">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="text-sm font-bold text-amber-900">Audit only</p>
                <p className="mt-1 text-xs leading-relaxed text-amber-800">
                  This report explains why repeated names can appear in recipe or inventory search. It recommends a likely master row for later review, but it does not write to Supabase.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ["Total inventory items", duplicateAudit.summary.totalInventoryItems],
              ["Duplicate groups found", duplicateAudit.summary.duplicateGroupsFound],
              ["Exact duplicate groups", duplicateAudit.summary.exactDuplicateGroups],
              ["Unit variation groups", duplicateAudit.summary.unitVariationGroups],
              ["Possible duplicate groups", duplicateAudit.summary.possibleDuplicateGroups],
              ["Items inside groups", duplicateAudit.summary.itemsInsideDuplicateGroups],
              ["Safe to merge later", duplicateAudit.summary.itemsSafeToMergeLater],
              ["Manual review items", duplicateAudit.summary.itemsNeedingManualReview],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-400">{label}</p>
                <p className="mt-2 text-2xl font-bold text-neutral-950">{Number(value).toLocaleString()}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                value={duplicateAuditSearch}
                onChange={e => setDuplicateAuditSearch(e.target.value)}
                placeholder="Search duplicate audit by item name, id, or group key..."
                className="w-full rounded-lg border border-neutral-200 bg-white py-2 pl-9 pr-3 text-sm text-neutral-900 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
              />
            </div>
            <button
              type="button"
              onClick={exportDuplicateAuditCsv}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-950 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-neutral-800"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              ["all", "All"],
              ["exact", "Exact duplicates"],
              ["unit", "Unit variations"],
              ["possible", "Possible duplicates"],
              ["recipe", "Has recipe usage"],
              ["stock", "Has stock"],
              ["unit-setup", "Needs unit setup"],
              ["manual-review", "Manual review needed"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setDuplicateAuditFilter(value)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  duplicateAuditFilter === value
                    ? "border-neutral-950 bg-neutral-950 text-white"
                    : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {filteredDuplicateAuditGroups.length === 0 ? (
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 py-12 text-center text-sm text-neutral-500">
              No duplicate groups found for the current search.
            </div>
          ) : (
            <div className="space-y-4">
              {filteredDuplicateAuditGroups.map((group: any) => (
                <div key={group.id} className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
                  <button
                    type="button"
                    onClick={() => setExpandedDuplicateAuditGroups(prev => ({ ...prev, [group.id]: !prev[group.id] }))}
                    className="w-full border-b border-neutral-100 bg-neutral-50 px-4 py-3 text-left transition-colors hover:bg-neutral-100"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {expandedDuplicateAuditGroups[group.id] ? <ChevronDown className="h-4 w-4 text-neutral-500" /> : <ChevronRight className="h-4 w-4 text-neutral-500" />}
                          <Badge
                            variant={group.duplicateType === "exact" ? "warning" : group.duplicateType === "unit variation" ? "neutral" : "default"}
                            className="capitalize"
                          >
                            {group.duplicateType}
                          </Badge>
                          <span className="text-xs font-semibold text-neutral-500">{group.itemCount} items</span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            group.safetyStatus === "likely safe later"
                              ? "bg-emerald-100 text-emerald-700"
                              : group.safetyStatus === "do not auto-merge"
                                ? "bg-red-100 text-red-700"
                                : "bg-amber-100 text-amber-700"
                          }`}>
                            {group.safetyStatus}
                          </span>
                        </div>
                        <p className="mt-2 text-sm font-semibold text-neutral-950">{group.items[0]?.name || group.groupKey}</p>
                        <p className="mt-1 text-xs text-neutral-500">{group.groupReason}</p>
                        <p className="mt-1 break-all font-mono text-[11px] text-neutral-400">{group.groupKey}</p>
                      </div>
                      <div className="grid gap-2 text-xs sm:grid-cols-3 lg:min-w-[460px]">
                        <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
                          <p className="font-semibold text-neutral-900">Supplier</p>
                          <p className="mt-0.5 truncate text-neutral-500">{group.supplier || "—"}</p>
                        </div>
                        <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
                          <p className="font-semibold text-neutral-900">Category</p>
                          <p className="mt-0.5 truncate text-neutral-500">{group.category || "—"}</p>
                        </div>
                        <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
                          <p className="font-semibold text-neutral-900">Master</p>
                          <p className="mt-0.5 font-mono text-neutral-500">{getDuplicateAuditShortId(group.recommendedMasterId)}</p>
                        </div>
                      </div>
                    </div>
                  </button>

                  {expandedDuplicateAuditGroups[group.id] && (
                    <>
                      <div className="border-b border-neutral-100 bg-white px-4 py-3 text-xs text-neutral-600">
                        <p><span className="font-semibold text-neutral-950">Recommended master:</span> <span className="font-mono">{group.recommendedMasterId || "None"}</span></p>
                        <p className="mt-1"><span className="font-semibold text-neutral-950">Reason:</span> {group.recommendedMasterReason}</p>
                      </div>

                  <div className="overflow-x-auto">
                    <table className="min-w-[1500px] w-full text-left text-xs">
                      <thead className="bg-white text-[10px] uppercase tracking-[0.14em] text-neutral-400">
                        <tr className="border-b border-neutral-100">
                          <th className="px-3 py-2 font-semibold">Item</th>
                          <th className="px-3 py-2 font-semibold">Supplier</th>
                          <th className="px-3 py-2 font-semibold">Category</th>
                          <th className="px-3 py-2 font-semibold">Base Unit</th>
                          <th className="px-3 py-2 font-semibold">Family</th>
                          <th className="px-3 py-2 font-semibold">Purchase Unit</th>
                          <th className="px-3 py-2 text-right font-semibold">Purchase Cost</th>
                          <th className="px-3 py-2 text-right font-semibold">Base Qty</th>
                          <th className="px-3 py-2 text-right font-semibold">Cost/Base</th>
                          <th className="px-3 py-2 text-right font-semibold">Stock</th>
                          <th className="px-3 py-2 text-right font-semibold">Par</th>
                          <th className="px-3 py-2 font-semibold">Status</th>
                          <th className="px-3 py-2 font-semibold">Unit Setup</th>
                          <th className="px-3 py-2 font-semibold">Usage</th>
                          <th className="px-3 py-2 font-semibold">Created / Updated</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                        {group.items.map((item: any) => {
                          const usage = item.audit.usage;
                          const isMaster = String(item.id) === String(group.recommendedMasterId);
                          return (
                            <tr key={`${group.groupKey}-${item.id}`} className={isMaster ? "bg-blue-50/60" : "bg-white"}>
                              <td className="px-3 py-3 align-top">
                                <p className="font-semibold text-neutral-950">{item.name || "Unnamed item"}</p>
                                <p className="mt-1 font-mono text-[10px] text-neutral-500">row: {getDuplicateAuditShortId(item.id)}</p>
                                <p className="font-mono text-[10px] text-neutral-400 break-all">full: {item.id}</p>
                                <p className="font-mono text-[10px] text-neutral-400">item_id: {item.itemId ?? item.item_id ?? "—"}</p>
                                {isMaster && <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-blue-700">Recommended master</p>}
                              </td>
                              <td className="px-3 py-3 align-top text-neutral-700">{item.audit.supplier || "—"}</td>
                              <td className="px-3 py-3 align-top text-neutral-700">{item.category || "—"}</td>
                              <td className="px-3 py-3 align-top font-mono text-neutral-700">{item.baseUnit ?? item.baseunit ?? item.unit ?? "—"}</td>
                              <td className="px-3 py-3 align-top text-neutral-700">{item.audit.measurementFamily || "—"}</td>
                              <td className="px-3 py-3 align-top text-neutral-700">{item.audit.purchaseUnitLabel || "—"}</td>
                              <td className="px-3 py-3 align-top text-right tabular-nums text-neutral-700">${Number(item.audit.purchaseCost || 0).toFixed(2)}</td>
                              <td className="px-3 py-3 align-top text-right tabular-nums text-neutral-700">{Number(item.audit.baseQtyPerPurchaseUnit || 0).toLocaleString()}</td>
                              <td className="px-3 py-3 align-top text-right tabular-nums text-neutral-700">${Number(item.audit.costPerBaseUnit || 0).toFixed(5)}</td>
                              <td className="px-3 py-3 align-top text-right tabular-nums text-neutral-700">{Number(item.inStock ?? 0).toLocaleString()}</td>
                              <td className="px-3 py-3 align-top text-right tabular-nums text-neutral-700">{Number(item.parLevel ?? 0).toLocaleString()}</td>
                              <td className="px-3 py-3 align-top">
                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${item.audit.isActive ? "bg-emerald-100 text-emerald-700" : "bg-neutral-200 text-neutral-600"}`}>
                                  {item.audit.isActive ? "Active" : "Disabled"}
                                </span>
                              </td>
                              <td className="px-3 py-3 align-top">
                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                  item.audit.unitSetupStatus === "Unit Ready"
                                    ? "bg-emerald-100 text-emerald-700"
                                    : item.audit.unitSetupStatus === "Unit Conflict"
                                      ? "bg-red-100 text-red-700"
                                      : "bg-amber-100 text-amber-700"
                                }`}>
                                  {item.audit.unitSetupStatus}
                                </span>
                              </td>
                              <td className="px-3 py-3 align-top text-neutral-600">
                                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                                  <span>Recipes: {usage.recipeUsageCount}</span>
                                  <span>FG: {usage.finishedGoodsRecipeUsageCount}</span>
                                  <span>POs: {usage.poUsageCount}</span>
                                  <span>Options: {usage.purchaseOptionCount}</span>
                                  <span>Ledger: {usage.movementLedgerCount}</span>
                                  <span>Prod: {usage.productionUsageCount}</span>
                                </div>
                              </td>
                              <td className="px-3 py-3 align-top text-neutral-500">
                                <p>{item.audit.createdAt ? new Date(item.audit.createdAt).toLocaleDateString() : "—"}</p>
                                <p>{item.audit.updatedAt ? new Date(item.audit.updatedAt).toLocaleDateString() : "—"}</p>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                    </>
                  )}
                </div>
              ))}
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

      {copyInventoryOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
          onClick={() => { if (!copyInventoryLoading) setCopyInventoryOpen(false); }}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#111111] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-4">
              <div>
                <h3 className="flex items-center gap-2 text-base font-bold text-zinc-100">
                  <Copy className="h-4 w-4 text-blue-300" />
                  Copy London Template Items to Locations
                </h3>
                <p className="mt-1 text-xs text-zinc-500">
                  Source template: <span className="font-semibold text-zinc-200">{londonTemplateLocation?.name ?? "London"} / {LONDON_TEMPLATE_LOCATION_ID}</span>
                  {" · "}
                  {selectedCopyInventoryItems.length} selected item{selectedCopyInventoryItems.length !== 1 ? "s" : ""}
                </p>
              </div>
              <button
                onClick={() => setCopyInventoryOpen(false)}
                disabled={copyInventoryLoading}
                className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100 disabled:opacity-50"
                aria-label="Close copy inventory modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
              {hasNonLondonCopySelection && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs font-medium text-amber-100">
                  This action is intended to copy from London / {LONDON_TEMPLATE_LOCATION_ID} template inventory. Some selected rows are from another location.
                </div>
              )}

              <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-xs font-medium text-blue-100">
                You are about to copy {selectedCopyInventoryItems.length} item{selectedCopyInventoryItems.length !== 1 ? "s" : ""} to {copyInventoryTargets.length} location{copyInventoryTargets.length !== 1 ? "s" : ""}.
              </div>

              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-sm font-bold text-zinc-100">Target Active Locations</h4>
                  <div className="flex items-center gap-3">
                    <button onClick={() => setCopyInventoryTargets(inventoryCopyTargetLocations.map((loc: any) => loc.id))} className="text-xs font-semibold text-blue-300 hover:text-blue-200">Select All</button>
                    <button onClick={() => setCopyInventoryTargets([])} className="text-xs font-semibold text-zinc-500 hover:text-zinc-200">Clear All</button>
                  </div>
                </div>
                <div className="grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                  {inventoryCopyTargetLocations.map((loc: any) => (
                    <label key={loc.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-[#171717] px-3 py-2.5 transition-colors hover:bg-[#1d1d1d]">
                      <input
                        type="checkbox"
                        checked={copyInventoryTargets.includes(loc.id)}
                        onChange={(e) => {
                          if (e.target.checked) setCopyInventoryTargets((prev) => [...prev, loc.id]);
                          else setCopyInventoryTargets((prev) => prev.filter((id) => id !== loc.id));
                        }}
                        className="h-4 w-4 rounded border-white/20 bg-[#111111] text-blue-600 focus:ring-blue-500"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-zinc-100">{loc.name}</span>
                        <span className="block truncate font-mono text-[10px] text-zinc-500">{loc.id}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <h4 className="text-sm font-bold text-zinc-100">Copy Options</h4>
                <div className="grid gap-2">
                  {[
                    { label: "Copy par levels", value: copyInventoryPar, set: setCopyInventoryPar, helper: "Copies source parlevel; otherwise target par starts at 0." },
                    { label: "Copy supplier/cost/order settings", value: copyInventorySetup, set: setCopyInventorySetup, helper: "Copies supplierid, cost, purchase cost, purchase units, and packaging fields." },
                    { label: "Copy purchase options", value: copyInventoryPurchaseOptions, set: setCopyInventoryPurchaseOptions, helper: "Copies supplier purchase rows to the new target inventory row IDs." },
                    { label: "Copy stock", value: copyInventoryStock, set: setCopyInventoryStock, helper: "Default is off. When off, target instock starts at 0." },
                    { label: "Update existing setup fields", value: copyInventoryUpdateExisting, set: setCopyInventoryUpdateExisting, helper: "Existing rows are skipped unless this is enabled. Stock is protected unless Copy stock is on." },
                  ].map((option) => (
                    <label key={option.label} className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-[#171717] px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={option.value}
                        onChange={(e) => option.set(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-white/20 bg-[#111111] text-blue-600 focus:ring-blue-500"
                      />
                      <span>
                        <span className="block text-sm font-semibold text-zinc-100">{option.label}</span>
                        <span className="block text-xs text-zinc-500">{option.helper}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              {copyInventoryResult && (
                <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
                  <h4 className="text-sm font-bold text-emerald-100">Copy Result</h4>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                    <div className="rounded-lg bg-black/30 px-3 py-2"><span className="block text-zinc-500">Created</span><span className="font-bold text-zinc-100">{copyInventoryResult.created}</span></div>
                    <div className="rounded-lg bg-black/30 px-3 py-2"><span className="block text-zinc-500">Updated</span><span className="font-bold text-zinc-100">{copyInventoryResult.updated}</span></div>
                    <div className="rounded-lg bg-black/30 px-3 py-2"><span className="block text-zinc-500">Skipped</span><span className="font-bold text-zinc-100">{copyInventoryResult.skipped}</span></div>
                    <div className="rounded-lg bg-black/30 px-3 py-2"><span className="block text-zinc-500">Options</span><span className="font-bold text-zinc-100">{copyInventoryResult.purchaseOptionsCopied}</span></div>
                    <div className="rounded-lg bg-black/30 px-3 py-2"><span className="block text-zinc-500">Failed</span><span className="font-bold text-zinc-100">{copyInventoryResult.failed}</span></div>
                  </div>
                  {copyInventoryResult.errors.length > 0 && (
                    <div className="mt-3 max-h-28 overflow-y-auto rounded-lg bg-black/30 px-3 py-2 text-xs text-red-200">
                      {copyInventoryResult.errors.map((error, idx) => <div key={`${error}-${idx}`}>{error}</div>)}
                    </div>
                  )}
                </section>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-[#151515] px-6 py-4">
              <p className="text-[10px] text-zinc-500">London and HQ are excluded as targets. New target rows use fresh row IDs.</p>
              <div className="flex items-center gap-2">
                <button onClick={() => setCopyInventoryOpen(false)} disabled={copyInventoryLoading} className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-zinc-200 transition-colors hover:bg-white/10 disabled:opacity-50">Close</button>
                <button onClick={handleCopyInventoryToLocations} disabled={copyInventoryLoading || copyInventoryTargets.length === 0} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-blue-500 disabled:opacity-50">
                  {copyInventoryLoading ? <><Loader2 className="h-4 w-4 animate-spin" /> Copying...</> : <><Copy className="h-4 w-4" /> Confirm Copy</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Phase 3A: Allocation Modal ───────────────────────────────────
           HQ-only. Opened via ⋯ → Allocate to Locations.
           Creates one new inventory row per selected store location,
           preserving the canonical item_id.
      ────────────────────────────────────────────────────────────────────────────── */}
      {allocationItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4 animate-in fade-in duration-200"
          onClick={() => { if (!allocationLoading) { setAllocationItem(null); setAllocationResult(null); } }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl border border-neutral-200 w-full max-w-2xl overflow-hidden animate-in slide-in-from-bottom-4 duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
              <div className="flex items-center gap-2">
                <MapPin className="h-5 w-5 text-violet-600" />
                <div>
                  <h3 className="text-base font-bold text-neutral-900">Allocate to Locations</h3>
                  <p className="text-xs text-neutral-500 mt-0.5">Creates a linked inventory row at each selected store.</p>
                </div>
              </div>
              <button
                onClick={() => { setAllocationItem(null); setAllocationResult(null); }}
                disabled={allocationLoading}
                className="text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 p-1.5 rounded-md transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body — two columns */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 divide-y sm:divide-y-0 sm:divide-x divide-neutral-100">

              {/* ── Left: HQ item info ── */}
              <div className="px-5 py-4 space-y-3">
                <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wide">Source Item (HQ)</p>
                <div className="bg-violet-50 rounded-lg border border-violet-200 p-3 space-y-1.5 text-xs">
                  <div className="text-sm font-bold text-violet-900">{allocationItem.name}</div>
                  <div className="flex justify-between text-neutral-600">
                    <span className="font-medium">Category</span>
                    <span>{allocationItem.category || "—"}</span>
                  </div>
                  <div className="flex justify-between text-neutral-600">
                    <span className="font-medium">Unit</span>
                    <span>{allocationItem.baseUnit || allocationItem.unit || "—"}</span>
                  </div>
                  <div className="flex justify-between text-neutral-600">
                    <span className="font-medium">Supplier</span>
                    <span className="truncate max-w-[120px] text-right">
                      {allocationItem.preferredSupplierName ?? getSupplierName(allocationItem.supplierId) ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between text-neutral-600">
                    <span className="font-medium">HQ Cost</span>
                    <span>${(allocationItem.cost ?? 0).toFixed(2)}/{allocationItem.baseUnit || "unit"}</span>
                  </div>
                  <div className="flex justify-between text-neutral-600">
                    <span className="font-medium">HQ Stock</span>
                    <span>{allocationItem.inStock ?? 0} {allocationItem.baseUnit || allocationItem.unit}</span>
                  </div>
                  <div className="flex justify-between text-neutral-600 border-t border-violet-200 pt-1.5 mt-1">
                    <span className="font-medium">Currently linked</span>
                    <span className="font-bold text-violet-800">
                      {(linkedCountByItemId.get(allocationItem.itemId) ?? 1)} location
                      {(linkedCountByItemId.get(allocationItem.itemId) ?? 1) !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>

                {/* ── Options ── */}
                <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wide pt-1">Copy Options</p>
                <div className="space-y-2">
                  {[
                    { label: "Copy supplier", value: copySupplier, set: setCopySupplier },
                    { label: "Copy cost",     value: copyCost,     set: setCopyCost     },
                  ].map(({ label, value, set }) => (
                    <label key={label} className="flex items-center gap-2 text-sm text-neutral-700 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={value}
                        onChange={(e) => set(e.target.checked)}
                        className="h-4 w-4 rounded border-neutral-300 text-violet-600 focus:ring-violet-500"
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-neutral-500">Starting par level</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={startingPar}
                      onChange={(e) => setStartingPar(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="w-24 px-2 py-1.5 border border-neutral-200 rounded-md text-sm text-right focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                    <span className="text-xs text-neutral-400">{allocationItem.baseUnit || allocationItem.unit}</span>
                  </div>
                  <p className="text-[10px] text-neutral-400">Starting stock is always 0 regardless.</p>
                </div>
              </div>

              {/* ── Right: Location selector ── */}
              <div className="px-5 py-4 space-y-3">
                <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wide">
                  Select Locations
                  {allocationLocations.length > 0 && (
                    <span className="ml-2 text-violet-600 font-bold">{allocationLocations.length} selected</span>
                  )}
                </p>

                {(() => {
                  const alreadyLinkedIds = new Set(
                    (rowsByItemId.get(allocationItem.itemId) ?? []).map((r: any) => r.locationId)
                  );
                  const eligible = allLocations.filter(
                    (loc: any) => loc.id !== "LOC-HQ" && !alreadyLinkedIds.has(loc.id)
                  );
                  const alreadyLinked = allLocations.filter(
                    (loc: any) => loc.id !== "LOC-HQ" && alreadyLinkedIds.has(loc.id)
                  );

                  return (
                    <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                      {eligible.length === 0 && alreadyLinked.length === 0 && (
                        <p className="text-sm text-neutral-400 text-center py-6">No store locations found.</p>
                      )}
                      {eligible.length === 0 && alreadyLinked.length > 0 && (
                        <p className="text-sm text-neutral-400 text-center py-4">All store locations already have this product.</p>
                      )}
                      {eligible.length > 0 && (
                        <>
                          {eligible.length > 1 && (
                            <button
                              onClick={() => {
                                const allIds = eligible.map((l: any) => l.id);
                                setAllocationLocations(prev =>
                                  prev.length === allIds.length ? [] : allIds
                                );
                              }}
                              className="text-xs font-semibold text-violet-600 hover:text-violet-800 transition-colors"
                            >
                              {allocationLocations.length === eligible.length ? "Deselect all" : "Select all"}
                            </button>
                          )}
                          {eligible.map((loc: any) => (
                            <label key={loc.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors select-none">
                              <input
                                type="checkbox"
                                checked={allocationLocations.includes(loc.id)}
                                onChange={(e) => {
                                  if (e.target.checked) setAllocationLocations(p => [...p, loc.id]);
                                  else setAllocationLocations(p => p.filter(id => id !== loc.id));
                                }}
                                className="h-4 w-4 rounded border-neutral-300 text-violet-600 focus:ring-violet-500 shrink-0"
                              />
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-neutral-800 truncate">{loc.name}</div>
                                <div className="text-[10px] text-neutral-400 font-mono">{loc.id}</div>
                              </div>
                            </label>
                          ))}
                        </>
                      )}
                      {alreadyLinked.length > 0 && (
                        <div className="pt-2 border-t border-neutral-100">
                          <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wide mb-1.5">Already allocated</p>
                          {alreadyLinked.map((loc: any) => (
                            <div key={loc.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-neutral-50 border border-neutral-100 opacity-60">
                              <Link2 className="h-3.5 w-3.5 text-violet-500 shrink-0" />
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-neutral-700 truncate">{loc.name}</div>
                                <div className="text-[10px] text-neutral-400 font-mono">{loc.id}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Result message */}
            {allocationResult && (
              <div className={`mx-6 mb-3 rounded-lg px-3 py-2 text-xs font-medium ${
                allocationResult.startsWith("✓")
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : allocationResult.startsWith("✗")
                  ? "bg-red-50 border border-red-200 text-red-700"
                  : "bg-amber-50 border border-amber-200 text-amber-800"
              }`}>
                {allocationResult}
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-neutral-100 bg-neutral-50">
              <p className="text-[10px] text-neutral-400">
                Starting stock = 0 always • item_id preserved from HQ row
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setAllocationItem(null); setAllocationResult(null); }}
                  disabled={allocationLoading}
                  className="px-4 py-2 text-sm font-semibold text-neutral-700 bg-white border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors"
                >
                  {allocationResult?.startsWith("✓") ? "Close" : "Cancel"}
                </button>
                <button
                  onClick={handleAllocate}
                  disabled={allocationLoading || allocationLocations.length === 0}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors shadow-sm"
                >
                  {allocationLoading
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Allocating…</>
                    : <><MapPin className="h-4 w-4" /> Allocate{allocationLocations.length > 0 ? ` to ${allocationLocations.length}` : ""}</>
                  }
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      </div>
    </div>
  );
}
