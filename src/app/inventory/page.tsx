"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { Search, Plus, Upload, MoreHorizontal, ShoppingCart, History, Save, Trash2, ArrowDown, ArrowUp, AlertTriangle, X, Download, Loader2 } from "lucide-react";
import { loadInventory, saveInventory, loadInventoryActivity, saveInventoryActivity, loadOrders, saveOrders, loadCategories, loadSuppliers, saveSuppliers, resolveSupplier, saveCategories, loadImportBatches, saveImportBatches, insertInventoryItem, resolveHqItemId, resolveSharedItemId } from "@/lib/storage";

export default function Inventory() {
  const router = useRouter();
  const { user } = useAuth();   // role + locationId from user_profiles
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

  // Edit Drawer States
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any>(null);

  // Adjustment Form States
  const [adjType, setAdjType] = useState<"Add"|"Remove"|"Waste">("Add");
  const [adjQty, setAdjQty] = useState("");
  const [adjUnit, setAdjUnit] = useState("");
  const [adjNotes, setAdjNotes] = useState("");

  const [newParLevel, setNewParLevel] = useState("");
  const [parNotes, setParNotes] = useState("");
  const [userRole, setUserRole] = useState<"HQ"|"Location">("HQ");

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
    purchaseUom:       "",   // e.g. 'case', 'bag'
    packQty:           "",   // inner units per purchase_uom
    innerUnitType:     "",   // e.g. 'can', 'bottle'
    innerUnitSize:     "",   // qty per inner unit
    innerUnitUom:      "",   // unit for innerUnitSize
    baseUomNew:        "",   // preferred costing unit (backfills baseunit if blank)
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

  // Bulk Output States
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([]);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
       setIsLoading(true);
       try {
          const [inv, act, cats, batches, sups] = await Promise.all([
             loadInventory(),
             loadInventoryActivity(),
             loadCategories(),
             loadImportBatches(),
             loadSuppliers()
          ]);
          // Scope to current user's location — loadInventory() returns all rows across
          // all locations. Without filtering, HQ users would see store rows and vice-versa.
          const userLocationId: string =
            user?.role === "hq_admin" ? "LOC-HQ" : (user?.locationId ?? "");

          const scopedInv = userLocationId
            ? inv.filter((item: any) => item.locationId === userLocationId)
            : inv;

          setInventoryData(scopedInv);
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
                if (p.filterStatus !== undefined) setFilterStatus(p.filterStatus);
                if (p.filterCategory !== undefined) setFilterCategory(p.filterCategory);
                if (p.filterSupplier !== undefined) setFilterSupplier(p.filterSupplier);
              } catch (e) {}
            }
          }
       } catch (e) {
          console.error(e);
       } finally {
          setIsLoading(false);
       }
    }
    fetchData();
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("inventory_filters", JSON.stringify({
        searchQuery, filterStatus, filterCategory, filterSupplier
      }));
    }
  }, [searchQuery, filterStatus, filterCategory, filterSupplier]);

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
    const stockRatio = item.inStock / item.parLevel;
    const isCritical = stockRatio < 0.3;
    const isLowStock = stockRatio >= 0.3 && stockRatio <= 0.7;
    const dynamicStatus = isCritical ? "Critical" : isLowStock ? "Low" : "Healthy";

    if (filterStatus !== "All" && dynamicStatus !== filterStatus) return false;
    if (filterCategory !== "All" && item.category !== filterCategory) return false;
    if (filterSupplier !== "All" && getSupplierName(item.supplierId) !== filterSupplier) return false;

    if (searchQuery) {
      const qs = searchQuery.toLowerCase();
      const suppName = getSupplierName(item.supplierId);
      if (!item.name?.toLowerCase().includes(qs) &&
          !item.category?.toLowerCase().includes(qs) &&
          !suppName.toLowerCase().includes(qs) &&
          !item.unit?.toLowerCase().includes(qs)) {
        return false;
      }
    }
    return true;
  }).sort((a, b) => {
     let valA = a[sortKey] || "";
     let valB = b[sortKey] || "";

     // Remap if sorting by supplier
     if (sortKey === 'supplier') {
        valA = getSupplierName(a.supplierId);
        valB = getSupplierName(b.supplierId);
     }

     if (typeof valA === "string") valA = valA.toLowerCase();
     if (typeof valB === "string") valB = valB.toLowerCase();
     if (valA < valB) return sortDirection === "asc" ? -1 : 1;
     if (valA > valB) return sortDirection === "asc" ? 1 : -1;
     return 0;
  });

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

  const openItemDrawer = (item: any) => {
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
    setNewParLevel(item.parLevel.toString());
    setParNotes("");
    setEditBaseUnit(item.baseUnit || item.unit || "");
    setEditPurchaseUnits(item.purchaseUnits ? JSON.parse(JSON.stringify(item.purchaseUnits)) : []);
    setEditPurchaseCost(item.purchaseCost !== undefined ? item.purchaseCost.toString() : (item.cost !== undefined ? item.cost.toString() : ""));
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
    if(!newItem.name || !newItem.inStock || !newItem.parLevel || !newItem.cost) {
      alert("Please fill in all required fields.");
      return;
    }

    // Determine location_id.
    // HQ admins (role === 'hq_admin') always write to LOC-HQ.
    // Location managers write to their assigned location.
    // Fallback: if locationId is still empty after all checks, default to
    // LOC-HQ rather than blocking — HQ view is the primary use-case.
    const rawRole      = user?.role ?? "";
    const rawLocId     = user?.locationId ?? "";
    const isHqAdmin    = rawRole === "hq_admin" || rawRole.toLowerCase().includes("hq");
    const locationId: string = isHqAdmin
      ? "LOC-HQ"
      : (rawLocId || "LOC-HQ"); // fall through to LOC-HQ instead of blocking

    // Always log so the real values are visible in the console.
    console.log("[AddItem] role=", rawRole, " locationId=", rawLocId, " → resolved location_id=", locationId, " isHqAdmin=", isHqAdmin);

    // Only block if locationId is genuinely missing (should never happen after the fallback above)
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
      purchaseUom:       newItem.purchaseUom.trim()       || null,
      packQty:           newItem.packQty !== ""           ? Number(newItem.packQty)       : null,
      innerUnitType:     newItem.innerUnitType.trim()     || null,
      innerUnitSize:     newItem.innerUnitSize !== ""     ? Number(newItem.innerUnitSize) : null,
      innerUnitUom:      newItem.innerUnitUom.trim()      || null,
      baseUomNew:        newItem.baseUomNew.trim()        || null,
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

      for (const [idx, row] of dataRows.entries()) {
        const cols = row.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        if (cols.length < 7) {
          errors.push(`Row ${idx+2} is missing required standard columns.`);
          continue;
        }
        
        const payload = {
          name: cols[0],
          category: cols[1],
          unit: cols[2],
          supplierText: cols[3],
          inStock: parseFloat(cols[4]) || 0,
          parLevel: parseFloat(cols[5]) || 0,
          cost: parseFloat(cols[6]) || 0,
          priceTrend: "steady",
          priceIncrease: false
        };

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
             phaseAErrors.push(`Row ${idx+1}: Missing required field 'Item Name'.`);
          }
          if (isNaN(parseFloat(p.payload.inStock)) || isNaN(parseFloat(p.payload.cost))) {
             phaseAErrors.push(`Row ${idx+1} [${p.payload.name}]: Pricing/Stock bounds are invalid. Numeric limits required.`);
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
             phaseAErrors.push(`Row ${idx+1} [${p.payload.name}]: Failed resolving supplier '${suppText}'. ${e.message}`);
          }

          const matchingItem = currentInventoryMap.get(p.payload.name.toLowerCase());
          
          if (matchingItem) {
              if (!overwriteExisting) {
                  skipped++;
                  continue;
              }
              rollbackData[matchingItem.id] = { ...matchingItem };
              updatedItems.push({
                  ...matchingItem,
                  ...p.payload,
                  category: cat,
                  supplierId: suppIdVal,
                  updatedAt: timestamp
              });
          } else {
              // Determine location for this import (HQ admin → LOC-HQ, else current user location)
              const importLocationId: string =
                user?.role === "hq_admin" ? "LOC-HQ" : (user?.locationId ?? "LOC-HQ");
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
              newItems.push({
                  ...p.payload,
                  category:    cat,
                  supplierId:  suppIdVal,
                  id:          newRowId,
                  item_id:     resolvedItemId,
                  itemId:      resolvedItemId,
                  location_id: importLocationId,
                  locationId:  importLocationId,
                  updatedAt:   timestamp
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
      setInventoryData(unifiedInventory);

      if (newlyCreatedCategories.length > 0) {
         setCategories(finalCategoriesList);
         await saveCategories(finalCategoriesList);
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

      alert(`Successfully committed block!\n\nNew items: ${newItems.length}\nUpdated fields: ${updatedItems.length}\nSkipped: ${skipped}\nAuto-created ${newlyCreatedCategories.length} categories.`);

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

  const revertBatch = async (batchId: string) => {
    const batchIdx = importBatches.findIndex(b => b.batchId === batchId);
    const batch = importBatches[batchIdx];
    if(!batch || batch.status === "Reverted") return;

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

  if (isLoading) return <div className="animate-pulse flex items-center justify-center p-12 text-neutral-400">Loading Inventory Module...</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Inventory Items</h2>
          <p className="text-neutral-500 text-sm mt-1">Manage your ingredient list and maintain optimal par levels.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
          <button 
            onClick={() => setIsHistoryDrawerOpen(true)}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-neutral-100 border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-200 w-full sm:w-auto shadow-sm"
          >
            <History className="h-4 w-4" /> History
          </button>
          <button 
            onClick={() => {
              setImportPreview([]);
              setImportErrors([]);
              setIsImportDrawerOpen(true);
            }}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 w-full sm:w-auto shadow-sm"
          >
            <Upload className="h-4 w-4" /> Import
          </button>
          <button 
            onClick={() => setIsAddDrawerOpen(true)}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm w-full sm:w-auto transition-colors"
          >
            <Plus className="h-4 w-4" /> Add Item
          </button>
        </div>
      </div>

      <Card className="shadow-sm border-neutral-200">
        <CardHeader className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:items-center justify-between pb-4 border-b border-neutral-100 bg-white">
          <div className="relative w-full sm:w-[400px]">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-neutral-400" />
            </div>
            <input 
              type="text" 
              placeholder="Search items by name, category, or supplier..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-4 py-1.5 border border-neutral-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 w-full bg-neutral-50 hover:bg-white transition-colors"
            />
          </div>
          <div className="flex flex-wrap gap-2">
             <select 
               className="px-3 py-1.5 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm transition-colors"
               value={filterStatus}
               onChange={(e) => setFilterStatus(e.target.value)}
            >
               <option value="All">All Statuses</option>
               <option value="Healthy">Healthy</option>
               <option value="Low">Low</option>
               <option value="Critical">Critical</option>
            </select>
            <select 
               className="px-3 py-1.5 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm transition-colors"
               value={filterCategory}
               onChange={(e) => setFilterCategory(e.target.value)}
            >
               <option value="All">All Categories</option>
               {uniqueCategories.map(c => <option key={c as string} value={c as string}>{c as string}</option>)}
            </select>
            <select 
               className="px-3 py-1.5 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm transition-colors"
               value={filterSupplier}
               onChange={(e) => setFilterSupplier(e.target.value)}
            >
               <option value="All">All Suppliers</option>
               {uniqueSuppliers.map(s => <option key={s as string} value={s as string}>{s as string}</option>)}
            </select>

            {(searchQuery || filterStatus !== 'All' || filterCategory !== 'All' || filterSupplier !== 'All') && (
              <button 
                onClick={clearFilters}
                className="text-xs font-semibold text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded-lg px-2 transition-colors ml-1"
              >
                Clear Filters
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
          <Table>
            <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider border-b border-neutral-200">
              <TableRow>
                <TableHead className="w-[50px] pl-6 pr-2 py-3">
                  <input 
                    type="checkbox" 
                    className="h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                    checked={filteredInventory.length > 0 && selectedItemIds.length === filteredInventory.length}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedItemIds(filteredInventory.map(i => i.id));
                      else setSelectedItemIds([]);
                    }}
                  />
                </TableHead>
                <TableHead className="px-3 py-3 font-semibold cursor-pointer select-none hover:text-brand-600 transition-colors" onClick={() => { setSortDirection(sortKey === 'name' && sortDirection === 'asc' ? 'desc' : 'asc'); setSortKey('name') }}>Item Name</TableHead>
                <TableHead className="px-3 py-3 font-semibold cursor-pointer select-none hover:text-brand-600 transition-colors" onClick={() => { setSortDirection(sortKey === 'category' && sortDirection === 'asc' ? 'desc' : 'asc'); setSortKey('category') }}>Category</TableHead>
                <TableHead className="py-3 font-semibold text-neutral-500">Unit</TableHead>
                <TableHead className="py-3 font-semibold cursor-pointer select-none hover:text-brand-600 transition-colors" onClick={() => { setSortDirection(sortKey === 'supplier' && sortDirection === 'asc' ? 'desc' : 'asc'); setSortKey('supplier') }}>Preferred Supplier</TableHead>
                <TableHead className="py-3 font-semibold text-neutral-500">Stock & Par</TableHead>
                <TableHead className="py-3 font-semibold text-neutral-500">Cost / Unit</TableHead>
                <TableHead className="py-3 font-semibold text-neutral-500">Status</TableHead>
                <TableHead className="px-6 py-3 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredInventory.length > 0 ? filteredInventory.map((item) => {
                const stockRatio = item.inStock / item.parLevel;
                const isCritical = stockRatio < 0.3;
                const isLowStock = stockRatio >= 0.3 && stockRatio <= 0.7;

                return (
                  <TableRow 
                    key={item.id} 
                    className={`hover:bg-neutral-50/50 cursor-pointer transition-colors ${selectedItemIds.includes(item.id) ? 'bg-brand-50/30' : ''}`}
                    onClick={() => openItemDrawer(item)}
                  >
                    <TableCell className="pl-6 pr-2 py-4">
                      <div onClick={e => e.stopPropagation()}>
                        <input 
                          type="checkbox" 
                          className="h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                          checked={selectedItemIds.includes(item.id)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedItemIds([...selectedItemIds, item.id]);
                            else setSelectedItemIds(selectedItemIds.filter(id => id !== item.id));
                          }}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-4">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-neutral-900 group-hover:text-brand-600 transition-colors">{item.name}</span>
                        {item.itemType === 'Preparation' && <Badge variant="warning" className="text-[9px] px-1.5 py-0 border-none bg-orange-100 text-orange-700">PREP</Badge>}
                        {item.itemType === 'Finished Good' && <Badge variant="success" className="text-[9px] px-1.5 py-0 border-none bg-emerald-100 text-emerald-700">FG</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-4">
                      <span className="text-xs font-semibold px-2 py-1 bg-neutral-100 text-neutral-600 border border-neutral-200 rounded-md whitespace-nowrap">{item.category}</span>
                    </TableCell>
                    <TableCell className="py-4">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">{item.baseUnit || item.unit}</span>
                        {item.purchaseUnits && item.purchaseUnits.length > 0 && (
                          <span className="text-[10px] text-neutral-400">
                             Buy: {item.purchaseUnits.find((u: any) => u.isPrimary)?.name || item.purchaseUnits[0].name}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-4">
                      <span className="text-sm font-medium text-neutral-700">{getSupplierName(item.supplierId)}</span>
                    </TableCell>
                    <TableCell className="py-4">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-baseline gap-1">
                          <span className={`text-sm font-bold ${isCritical ? "text-danger-600" : isLowStock ? "text-warning-600" : "text-neutral-900"}`}>
                            {item.inStock}
                          </span>
                          <span className="text-xs text-neutral-500">/ {item.parLevel} {item.baseUnit || item.unit}</span>
                        </div>
                        {item.purchaseUnits && item.purchaseUnits.length > 0 && (() => {
                           const pUnit = item.purchaseUnits.find((u: any) => u.isPrimary) || item.purchaseUnits[0];
                           const pStock = (item.inStock / pUnit.conversion).toFixed(1);
                           return <span className="text-[10px] text-brand-600 font-semibold block">{pStock} {pUnit.name}s</span>
                        })()}
                      </div>
                    </TableCell>
                    <TableCell className="py-4 text-sm text-neutral-700">${item.cost.toFixed(2)}</TableCell>
                    <TableCell className="py-4">
                      {isCritical ? (
                        <Badge variant="danger" className="text-[10px]">Critical</Badge>
                      ) : isLowStock ? (
                        <Badge variant="warning" className="text-[10px]">Low</Badge>
                      ) : (
                        <Badge variant="success" className="text-[10px]">Healthy</Badge>
                      )}
                    </TableCell>
                    <TableCell className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {(isLowStock || isCritical) && (
                          <button 
                            onClick={(e) => handleQuickReorder(item, e)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-50 hover:bg-brand-100 text-brand-700 text-xs font-semibold rounded-md transition-colors shadow-sm border border-brand-200"
                          >
                            <ShoppingCart className="h-3 w-3" /> Quick Reorder
                          </button>
                        )}
                        <button className="p-1.5 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded-md transition-colors">
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
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
                               <span className="text-sm font-bold text-neutral-900">{log.type === 'Par Update' ? `${log.qty} net shift` : log.baseTransacted ? `${log.baseTransacted > 0 ? '+' : ''}${log.baseTransacted} ${selectedItem.baseUnit||selectedItem.unit} (${log.qty})` : `${log.qty > 0 ? '+' : ''}${log.qty} ${selectedItem.unit}`}</span>
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
             <input type="text" value={newItem.name} onChange={e => setNewItem({...newItem, name: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. Garlic Powder" />
           </div>
           <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
             <div className="space-y-1.5">
               <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Node Taxonomy</label>
               <select value={newItem.itemType} onChange={e => setNewItem({...newItem, itemType: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                 <option value="Raw">Raw Asset</option>
                 <option value="Preparation">Preparation Base</option>
                 <option value="Finished Good">Finished Good</option>
               </select>
             </div>
             <div className="space-y-1.5">
               <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Category</label>
               <select value={newItem.category} onChange={e => setNewItem({...newItem, category: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white">
                 {categories.map(c => <option key={c} value={c}>{c}</option>)}
               </select>
             </div>
             <div className="space-y-1.5">
               <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Base Unit (Calculations)</label>
               <input type="text" value={newItem.unit} onChange={e => setNewItem({...newItem, unit: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="kg, L, box..." />
             </div>
           </div>

           <div className="space-y-2 border border-neutral-200 p-3 rounded-lg bg-neutral-50 shadow-sm">
              <label className="text-xs font-semibold text-neutral-900 uppercase flex justify-between">
                 Purchase Units (Ordering)
                 <button onClick={() => setNewItem({...newItem, purchaseUnits: [...newItem.purchaseUnits, { name: "", conversion: 1, isPrimary: newItem.purchaseUnits.length === 0 }]})} className="text-brand-600 hover:text-brand-700 font-bold flex items-center gap-1"><Plus className="h-3 w-3" /> Add</button>
              </label>
              {newItem.purchaseUnits.length === 0 ? (
                 <div className="text-xs text-neutral-500 italic py-2">No purchase units mapped. System will fall back to base unit for POs.</div>
              ) : newItem.purchaseUnits.map((pu, idx) => (
                 <div key={idx} className="flex gap-2 items-center bg-white p-2 rounded border border-neutral-200">
                    <input type="radio" name="new_primary_unit" checked={pu.isPrimary} onChange={() => {
                       const copy = [...newItem.purchaseUnits];
                       copy.forEach(u => u.isPrimary = false);
                       copy[idx].isPrimary = true;
                       setNewItem({...newItem, purchaseUnits: copy});
                    }} className="w-4 h-4 text-brand-600" title="Set as Primary for Auto-PO" />
                    <input type="text" value={pu.name} onChange={(e) => {
                       const copy = [...newItem.purchaseUnits];
                       copy[idx].name = e.target.value;
                       setNewItem({...newItem, purchaseUnits: copy});
                    }} className="flex-1 py-1.5 px-2 border border-neutral-200 rounded text-sm outline-none focus:border-brand-500" placeholder="Name (e.g. Case)" />
                    <span className="text-xs text-neutral-500">=</span>
                    <input type="number" min="0" step="0.01" value={pu.conversion} onChange={(e) => {
                       const copy = [...newItem.purchaseUnits];
                       copy[idx].conversion = e.target.value;
                       setNewItem({...newItem, purchaseUnits: copy});
                    }} className="w-20 py-1.5 px-2 border border-neutral-200 rounded text-sm outline-none focus:border-brand-500" placeholder="Qty" />
                    <span className="text-xs text-neutral-500 truncate w-8">{newItem.unit || 'base'}</span>
                    <button onClick={() => {
                       const copy = newItem.purchaseUnits.filter((_, i) => i !== idx);
                       if (pu.isPrimary && copy.length > 0) copy[0].isPrimary = true;
                       setNewItem({...newItem, purchaseUnits: copy});
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
                     onChange={e => setNewItem({...newItem, purchaseUom: e.target.value})}
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
                     onChange={e => setNewItem({...newItem, packQty: e.target.value})}
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
                     onChange={e => setNewItem({...newItem, innerUnitType: e.target.value})}
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
                     onChange={e => setNewItem({...newItem, innerUnitSize: e.target.value})}
                     className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                     placeholder="e.g. 330"
                   />
                 </div>
                 <div className="space-y-1">
                   <label className="text-[11px] font-semibold text-neutral-600 uppercase tracking-wider">Inner UOM</label>
                   <select
                     value={newItem.innerUnitUom}
                     onChange={e => setNewItem({...newItem, innerUnitUom: e.target.value})}
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
                   onChange={e => setNewItem({...newItem, baseUomNew: e.target.value})}
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
                   onChange={e => setNewItem({...newItem, allowedRecipeUoms: e.target.value})}
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
               <input list="supplier-options" type="text" value={newItem.supplier} onChange={e => setNewItem({...newItem, supplier: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Select or type new supplier..." />
               <datalist id="supplier-options">
                 {suppliersData.map(s => <option key={s.id} value={s.name} />)}
               </datalist>
           </div>
           <div className="grid grid-cols-3 gap-4">
             <div className="space-y-1.5">
               <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Current Stock</label>
               <input type="number" step="1" value={newItem.inStock} onChange={e => setNewItem({...newItem, inStock: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="0" />
             </div>
             <div className="space-y-1.5">
               <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Par Level</label>
               <input type="number" step="1" value={newItem.parLevel} onChange={e => setNewItem({...newItem, parLevel: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="0" />
             </div>
             {(() => {
                const pu = newItem.purchaseUnits.find((u: any) => u.isPrimary) || newItem.purchaseUnits[0];
                const hasValidPrimary = pu && pu.name && parseFloat(pu.conversion) > 0;
                
                return (
                  <div className="space-y-1.5 focus-within:z-10">
                    <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">
                      {hasValidPrimary ? `Cost (per ${pu.name})` : 'Cost / Base Unit'}
                    </label>
                    <input type="number" step="0.1" value={newItem.cost} onChange={e => setNewItem({...newItem, cost: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="$0.00" />
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
                  let safeInventory = inventoryData.filter(i => !selectedItemIds.includes(i.id));
                  const res = await saveInventory(safeInventory);
                  if (!res.success) {
                     alert(`Delete Failed: ${res.error?.message || "Database rejected row destruction."}`);
                     return;
                  }
                  setInventoryData(safeInventory);
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
    </div>
  );
}
