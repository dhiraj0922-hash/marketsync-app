"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin } from "@/lib/roles";
import {
  loadLocations,
  loadSaleItems,
  loadInventory,
  SaleItem,
} from "@/lib/storage";
import {
  loadMenuCostings,
  loadMenuCostingById,
  saveMenuCosting,
  updateMenuCosting,
  deleteMenuCosting,
  duplicateMenuCosting,
  MenuCosting,
  MenuCostingComponent,
} from "@/lib/menuCostingStorage";
import { computeIngredientLineCost, computeBaseUnitCostFromPack } from "@/lib/units";
import {
  Plus,
  Edit2,
  Trash2,
  Copy,
  X,
  Search,
  Sparkles,
  TrendingUp,
  Coins,
  Eye,
  AlertTriangle,
  CheckCircle2,
  Info,
  DollarSign,
  Layers,
  ArrowRight,
  RefreshCw,
  FolderOpen,
} from "lucide-react";

const MENU_CATEGORIES = ["Mains", "Appetizers", "Beverages", "Desserts", "Sides", "Catering", "Combos"];
const COMPONENT_TYPES = [
  { value: "main", label: "Main Item" },
  { value: "packaging", label: "Packaging" },
  { value: "garnish", label: "Garnish" },
  { value: "finishing", label: "Finishing" },
  { value: "other", label: "Other" },
];

export default function MenuCostingPage() {
  const { user } = useAuth();
  const hq = isHqAdmin(user);

  // ── Locations & Filtering ───────────────
  const [locations, setLocations] = useState<any[]>([]);
  const [selectedLoc, setSelectedLoc] = useState("");
  const activeLoc = hq ? selectedLoc : (user?.locationId ?? "");

  // ── State Variables ─────────────────────
  const [costings, setCostings] = useState<MenuCosting[]>([]);
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);
  const [localInventory, setLocalInventory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");

  // ── Drawer State ────────────────────────
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<"create" | "edit" | "view">("create");
  const [editingId, setEditingId] = useState<string | null>(null);

  // ── Form State ──────────────────────────
  const [formName, setFormName] = useState("");
  const [formCategory, setFormCategory] = useState("Mains");
  const [formSellingPrice, setFormSellingPrice] = useState<number>(0);
  const [formTargetFoodCost, setFormTargetFoodCost] = useState<number>(30);
  const [formStatus, setFormStatus] = useState<"draft" | "active">("draft");
  const [formNotes, setFormNotes] = useState("");
  const [formComponents, setFormComponents] = useState<Omit<MenuCostingComponent, "id" | "costingId" | "createdAt">[]>([]);

  // Autocomplete search states inside component rows
  const [rowSearchTerm, setRowSearchTerm] = useState<Record<number, string>>({});
  const [rowShowSuggestions, setRowShowSuggestions] = useState<Record<number, boolean>>({});

  // ── Load Global/Static Metadata ──────────
  useEffect(() => {
    (async () => {
      try {
        if (hq) {
          const locs = await loadLocations();
          const sellable = locs.filter(
            (l: any) =>
              l.id !== "LOC-HQ" &&
              !(l.name ?? "").toLowerCase().includes("head office") &&
              !(l.name ?? "").toLowerCase().includes("central kitchen")
          );
          setLocations(sellable);
          if (sellable.length && !selectedLoc) {
            setSelectedLoc(sellable[0].id);
          }
        } else if (user?.locationId) {
          setSelectedLoc(user.locationId);
        }
      } catch (err) {
        console.error("Error loading locations:", err);
      }
    })();
  }, [hq, user]);

  // ── Load Main Data ──────────────────────
  const loadData = useCallback(async () => {
    if (!activeLoc) return;
    setLoading(true);
    try {
      const [costingList, fgs, loadedInv] = await Promise.all([
        loadMenuCostings(activeLoc),
        loadSaleItems(),
        loadInventory(activeLoc),
      ]);
      setCostings(costingList);
      setSaleItems(fgs.filter((item) => item.isActive));
      setLocalInventory(loadedInv);
    } catch (err) {
      console.error("Error loading data:", err);
    } finally {
      setLoading(false);
    }
  }, [activeLoc]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Map Inventory Items with Overrides ────
  const inventoryItemsMerged = useMemo(() => {
    return localInventory.map((item) => {
      return {
        ...item,
        itemId: item.itemId || item.id,
        name: item.name,
        category: item.category || "General",
        uom: item.baseUnit || item.unit || "ea",
        effectivePrice: item.cost || 0,
      };
    });
  }, [localInventory]);

  // ── Autocomplete Filtering Options ────────
  const getItemSuggestions = useCallback((sourceType: "finished_good" | "inventory_item", searchStr: string) => {
    const query = (searchStr ?? "").toLowerCase().trim();
    if (sourceType === "finished_good") {
      return saleItems
        .filter((item) => !query || item.name.toLowerCase().includes(query) || item.id.toLowerCase().includes(query))
        .slice(0, 10);
    } else {
      return inventoryItemsMerged
        .filter((item) => !query || item.name.toLowerCase().includes(query) || item.itemId.toLowerCase().includes(query))
        .slice(0, 10);
    }
  }, [saleItems, inventoryItemsMerged]);

  // ── Calculate Line Cost ───────────────────
  const calculateComponentCost = useCallback((
    sourceType: "finished_good" | "inventory_item",
    itemId: string,
    qty: number,
    recipeUnit: string
  ) => {
    if (!itemId || qty <= 0 || !recipeUnit) {
      return { lineCost: 0, unitCost: 0, error: null };
    }

    if (sourceType === "finished_good") {
      const fg = saleItems.find((s) => s.id === itemId);
      if (!fg) return { lineCost: 0, unitCost: 0, error: "Item not found" };

      // Build target object for computeIngredientLineCost
      const invItemObj = {
        ...fg,
        name: fg.name,
        cost: fg.effectivePrice,
        baseUnit: fg.baseUnit,
        unit: fg.baseUnit,
      };

      const result = computeIngredientLineCost(qty, recipeUnit, invItemObj);
      if (result.ok) {
        return { lineCost: result.cost, unitCost: result.costPerBaseUnit, error: null };
      } else {
        return { lineCost: 0, unitCost: 0, error: result.error };
      }
    } else {
      const inv = inventoryItemsMerged.find((i) => i.itemId === itemId);
      if (!inv) return { lineCost: 0, unitCost: 0, error: "Item not found" };

      const invItemObj = {
        ...inv,
        name: inv.name,
        cost: inv.effectivePrice,
        baseUnit: inv.uom,
        unit: inv.uom,
      };

      const result = computeIngredientLineCost(qty, recipeUnit, invItemObj);
      if (result.ok) {
        return { lineCost: result.cost, unitCost: result.costPerBaseUnit, error: null };
      } else {
        return { lineCost: 0, unitCost: 0, error: result.error };
      }
    }
  }, [saleItems, inventoryItemsMerged]);

  // ── Unified Costing Totals with Validation ──
  const getCostingTotalsWithValidation = useCallback((
    components: Omit<MenuCostingComponent, "id" | "costingId" | "createdAt">[],
    sellingPrice: number
  ) => {
    let total_finished_good_cost = 0;
    let total_inventory_cost = 0;
    let total_packaging_cost = 0;
    let hasConversionError = false;

    components.forEach((comp) => {
      const { lineCost, error } = calculateComponentCost(
        comp.sourceType,
        comp.sourceItemId,
        comp.qtyUsed,
        comp.unit || ""
      );

      if (error) {
        hasConversionError = true;
      }

      const effectiveLineCost = error ? 0 : (lineCost || comp.lineCost || 0);

      if (comp.sourceType === "finished_good") {
        total_finished_good_cost += effectiveLineCost;
      } else {
        if (comp.componentType === "packaging") {
          total_packaging_cost += effectiveLineCost;
        } else {
          total_inventory_cost += effectiveLineCost;
        }
      }
    });

    const total_recipe_cost = total_finished_good_cost + total_inventory_cost + total_packaging_cost;
    const food_cost_percent = sellingPrice > 0 ? (total_recipe_cost / sellingPrice) * 100 : 0;
    const gross_profit = sellingPrice - total_recipe_cost;
    const gross_margin_percent = sellingPrice > 0 ? (gross_profit / sellingPrice) * 100 : 0;

    const isIncomplete =
      sellingPrice <= 0 ||
      components.length === 0 ||
      total_recipe_cost <= 0 ||
      hasConversionError;

    return {
      total_finished_good_cost,
      total_inventory_cost,
      total_packaging_cost,
      total_recipe_cost,
      selling_price: sellingPrice,
      food_cost_percent,
      gross_profit,
      gross_margin_percent,
      suggested_price_25: total_recipe_cost / 0.25,
      suggested_price_30: total_recipe_cost / 0.30,
      suggested_price_35: total_recipe_cost / 0.35,
      hasConversionError,
      isIncomplete,
    };
  }, [calculateComponentCost]);

  // ── Cost Summary Calculations ─────────────
  const totals = useMemo(() => {
    return getCostingTotalsWithValidation(formComponents, formSellingPrice);
  }, [formComponents, formSellingPrice, getCostingTotalsWithValidation]);

  // ── Component Row Handlers ────────────────
  const addComponentRow = () => {
    setFormComponents((prev) => [
      ...prev,
      {
        sourceType: "inventory_item",
        sourceItemId: "",
        itemNameSnapshot: "",
        componentType: "main",
        qtyUsed: 0,
        unit: "",
        unitCostSnapshot: 0,
        lineCost: 0,
        sortOrder: prev.length,
      },
    ]);
  };

  const removeComponentRow = (index: number) => {
    setFormComponents((prev) => prev.filter((_, i) => i !== index));
    setRowSearchTerm((prev) => {
      const n = { ...prev };
      delete n[index];
      return n;
    });
  };

  const updateComponentRow = (index: number, fields: Partial<typeof formComponents[0]>) => {
    setFormComponents((prev) => {
      const list = [...prev];
      const updated = { ...list[index], ...fields };

      // Trigger line cost recalculation if item, qty, or unit changes
      if ("sourceItemId" in fields || "qtyUsed" in fields || "unit" in fields || "sourceType" in fields) {
        const { lineCost, unitCost } = calculateComponentCost(
          updated.sourceType,
          updated.sourceItemId,
          updated.qtyUsed,
          updated.unit || ""
        );
        updated.lineCost = lineCost;
        updated.unitCostSnapshot = unitCost;
      }

      list[index] = updated;
      return list;
    });
  };

  // ── Save/Update Handler ───────────────────
  const handleSave = async () => {
    if (!formName.trim()) {
      alert("Please enter a menu item name.");
      return;
    }

    if (formSellingPrice < 0) {
      alert("Selling price cannot be negative.");
      return;
    }

    // Validation checks on component rows
    for (let i = 0; i < formComponents.length; i++) {
      const comp = formComponents[i];
      if (!comp.sourceItemId) {
        alert(`Component row #${i + 1} does not have a selected item.`);
        return;
      }
      if (comp.qtyUsed <= 0) {
        alert(`Component row #${i + 1} has invalid quantity (${comp.qtyUsed}).`);
        return;
      }
      if (!comp.unit) {
        alert(`Component row #${i + 1} has no unit specified.`);
        return;
      }
      if (!isFinite(comp.lineCost)) {
        alert(`Component row #${i + 1} has non-finite cost calculation.`);
        return;
      }
      // Block saving if there is an active unit conversion error
      const { error: conversionError } = calculateComponentCost(
        comp.sourceType,
        comp.sourceItemId,
        comp.qtyUsed,
        comp.unit
      );
      if (conversionError) {
        alert(`Component row #${i + 1} ("${comp.itemNameSnapshot || 'Item'}") has a unit conversion error: ${conversionError}`);
        return;
      }
    }

    const costingPayload = {
      locationId: activeLoc,
      itemName: formName,
      category: formCategory,
      sellingPrice: formSellingPrice,
      targetFoodCostPercent: formTargetFoodCost,
      status: formStatus,
      notes: formNotes,
    };

    let res;
    if (drawerMode === "edit" && editingId) {
      res = await updateMenuCosting(editingId, costingPayload, formComponents);
    } else {
      res = await saveMenuCosting(costingPayload, formComponents);
    }

    if (res.success) {
      setDrawerOpen(false);
      loadData();
    } else {
      alert(`Error saving costing: ${res.error}`);
    }
  };

  // ── View/Edit Costing Sheet ────────────────
  const openCostingDrawer = async (mode: "create" | "edit" | "view", id?: string) => {
    setDrawerMode(mode);
    setEditingId(id || null);

    if (mode === "create") {
      setFormName("");
      setFormCategory("Mains");
      setFormSellingPrice(0);
      setFormTargetFoodCost(30);
      setFormStatus("draft");
      setFormNotes("");
      setFormComponents([]);
      setRowSearchTerm({});
      setRowShowSuggestions({});
      setDrawerOpen(true);
    } else if (id) {
      setLoading(true);
      const detail = await loadMenuCostingById(id);
      setLoading(false);
      if (detail) {
        // Scope protection
        if (!hq && detail.locationId !== activeLoc) {
          alert("Unauthorized access: This costing sheet belongs to another location.");
          return;
        }

        setFormName(detail.itemName);
        setFormCategory(detail.category || "Mains");
        setFormSellingPrice(detail.sellingPrice);
        setFormTargetFoodCost(detail.targetFoodCostPercent);
        setFormStatus(detail.status);
        setFormNotes(detail.notes || "");
        setFormComponents(detail.components || []);

        const searchMap: Record<number, string> = {};
        (detail.components || []).forEach((c, index) => {
          searchMap[index] = c.itemNameSnapshot || "";
        });
        setRowSearchTerm(searchMap);
        setRowShowSuggestions({});
        setDrawerOpen(true);
      }
    }
  };

  // ── Duplicate Costing Sheet ────────────────
  const handleDuplicate = async (id: string, name: string) => {
    const detail = await loadMenuCostingById(id);
    if (!detail) {
      alert("Original costing sheet not found.");
      return;
    }
    // Scope protection
    if (!hq && detail.locationId !== activeLoc) {
      alert("Unauthorized access: This costing sheet belongs to another location.");
      return;
    }

    const dupName = prompt("Enter name for duplicated Menu Costing sheet:", `${name} (Copy)`);
    if (!dupName || !dupName.trim()) return;

    const res = await duplicateMenuCosting(id, dupName.trim());
    if (res.success) {
      loadData();
    } else {
      alert(`Duplicate failed: ${res.error}`);
    }
  };

  // ── Delete Costing Sheet ───────────────────
  const handleDelete = async (id: string) => {
    const detail = await loadMenuCostingById(id);
    if (!detail) {
      alert("Costing sheet not found.");
      return;
    }
    // Scope protection
    if (!hq && detail.locationId !== activeLoc) {
      alert("Unauthorized access: This costing sheet belongs to another location.");
      return;
    }

    if (!confirm("Are you sure you want to delete this Menu Costing sheet? This action cannot be undone.")) return;
    const res = await deleteMenuCosting(id);
    if (res.success) {
      loadData();
    } else {
      alert(`Delete failed: ${res.error}`);
    }
  };

  // ── Toggle Status ──────────────────────────
  const toggleStatus = async (item: MenuCosting) => {
    const nextStatus = item.status === "active" ? "draft" : "active";
    setLoading(true);
    const detail = await loadMenuCostingById(item.id);
    if (detail) {
      // Scope protection
      if (!hq && detail.locationId !== activeLoc) {
        alert("Unauthorized access: This costing sheet belongs to another location.");
        setLoading(false);
        return;
      }

      const res = await updateMenuCosting(
        item.id,
        { ...detail, status: nextStatus },
        detail.components || []
      );
      if (res.success) {
        loadData();
      } else {
        alert(`Status update failed: ${res.error}`);
        setLoading(false);
      }
    } else {
      setLoading(false);
    }
  };

  // ── Filter Costings ────────────────────────
  const filteredCostings = useMemo(() => {
    return costings.filter((c) => {
      const matchSearch =
        !searchQuery ||
        c.itemName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.category?.toLowerCase().includes(searchQuery.toLowerCase());
      const matchCat = categoryFilter === "All" || c.category === categoryFilter;
      return matchSearch && matchCat;
    });
  }, [costings, searchQuery, categoryFilter]);

  // ── UI Helper Badges ───────────────────────
  const getFoodCostBadge = (foodCostPct: number, isIncomplete: boolean) => {
    if (isIncomplete) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-neutral-100 text-neutral-600">
          Incomplete
        </span>
      );
    }
    if (foodCostPct <= 30) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
          Good ({foodCostPct.toFixed(1)}%)
        </span>
      );
    }
    if (foodCostPct <= 35) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
          Watch ({foodCostPct.toFixed(1)}%)
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200 animate-pulse">
        High Cost ({foodCostPct.toFixed(1)}%)
      </span>
    );
  };

  const getStatusBadge = (status: "draft" | "active") => {
    if (status === "active") {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800">
          Active
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-neutral-100 text-neutral-800">
        Draft
      </span>
    );
  };

  return (
    <div className="flex-1 min-w-0 bg-neutral-50 min-h-screen">
      {/* ── Header Area ──────────────────────── */}
      <div className="bg-white border-b border-neutral-200 px-6 py-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 tracking-tight flex items-center gap-2">
              <Sparkles className="h-6 w-6 text-brand-600" />
              Menu Costing & Outlet Recipes
            </h1>
            <p className="text-sm text-neutral-500 mt-1">
              Analyze margins and track food cost percentages by mixing Finished Goods and local items.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Location selector for HQ admin */}
            {hq && (
              <div className="flex items-center gap-2 bg-neutral-50 border border-neutral-200 rounded-lg px-3 py-1.5 shadow-sm">
                <span className="text-xs font-bold text-neutral-500 uppercase tracking-wide">Location:</span>
                <select
                  value={selectedLoc}
                  onChange={(e) => setSelectedLoc(e.target.value)}
                  className="bg-transparent border-0 text-sm font-semibold text-neutral-800 focus:outline-none cursor-pointer"
                >
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <button
              onClick={() => openCostingDrawer("create")}
              className="inline-flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white font-semibold px-4 py-2 rounded-lg text-sm shadow-sm transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Costing Sheet
            </button>
          </div>
        </div>
      </div>

      {/* ── Main Dashboard ───────────────────── */}
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Filters and Search */}
        <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-2.5 h-4.5 w-4.5 text-neutral-400" />
            <input
              type="text"
              placeholder="Search menu items..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-neutral-200 rounded-lg text-sm bg-neutral-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 transition-all"
            />
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Category:</span>
            <div className="flex flex-wrap gap-1">
              {["All", ...MENU_CATEGORIES].map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-all border ${
                    categoryFilter === cat
                      ? "bg-brand-50 border-brand-200 text-brand-700 font-bold"
                      : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Costings Table */}
        <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden shadow-sm">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <RefreshCw className="h-8 w-8 text-brand-600 animate-spin" />
              <p className="text-sm font-semibold text-neutral-500">Loading recipe sheets...</p>
            </div>
          ) : filteredCostings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <FolderOpen className="h-12 w-12 text-neutral-300" />
              <h3 className="text-base font-semibold text-neutral-700 mt-4">No recipe sheets found</h3>
              <p className="text-xs text-neutral-400 mt-1 max-w-sm">
                Get started by creating a new menu costing sheet or adjusting your filters.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-neutral-50 border-b border-neutral-200 text-xs font-bold text-neutral-600 uppercase tracking-wider">
                    <th className="px-6 py-4">Menu Item</th>
                    <th className="px-4 py-4">Category</th>
                    <th className="px-4 py-4 text-right">Selling Price</th>
                    <th className="px-4 py-4 text-right">Total Cost</th>
                    <th className="px-4 py-4 text-center">Food Cost %</th>
                    <th className="px-4 py-4 text-right">Gross Profit</th>
                    <th className="px-4 py-4 text-right">Margin %</th>
                    <th className="px-4 py-4 text-center">Status</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200">
                  {filteredCostings.map((item) => {
                    // Quick totals for row using the unified cost engine
                    const rowTotals = getCostingTotalsWithValidation(item.components || [], item.sellingPrice);

                    return (
                      <tr key={item.id} className="hover:bg-neutral-50/50 transition-colors text-sm text-neutral-700">
                        <td className="px-6 py-4 font-semibold text-neutral-900">{item.itemName}</td>
                        <td className="px-4 py-4 text-neutral-500">{item.category || "—"}</td>
                        <td className="px-4 py-4 text-right font-mono font-semibold">
                          {item.sellingPrice > 0 ? `$${item.sellingPrice.toFixed(2)}` : "—"}
                        </td>
                        <td className="px-4 py-4 text-right font-mono text-neutral-600">
                          {!rowTotals.isIncomplete ? `$${rowTotals.total_recipe_cost.toFixed(2)}` : "—"}
                        </td>
                        <td className="px-4 py-4 text-center">{getFoodCostBadge(rowTotals.food_cost_percent, rowTotals.isIncomplete)}</td>
                        <td
                          className={`px-4 py-4 text-right font-mono ${
                            !rowTotals.isIncomplete && rowTotals.gross_profit < 0 ? "text-rose-600 font-bold" : "text-neutral-700"
                          }`}
                        >
                          {!rowTotals.isIncomplete ? `$${rowTotals.gross_profit.toFixed(2)}` : "—"}
                        </td>
                        <td
                          className={`px-4 py-4 text-right font-mono ${
                            !rowTotals.isIncomplete && rowTotals.gross_margin_percent < 0 ? "text-rose-600 font-bold" : "text-neutral-500"
                          }`}
                        >
                          {!rowTotals.isIncomplete ? `${rowTotals.gross_margin_percent.toFixed(1)}%` : "—"}
                        </td>
                        <td className="px-4 py-4 text-center">
                          <button
                            onClick={() => toggleStatus(item)}
                            title="Toggle Status (Active/Draft)"
                            className="hover:scale-105 transition-transform"
                          >
                            {getStatusBadge(item.status)}
                          </button>
                        </td>
                        <td className="px-6 py-4 text-right space-x-1.5 whitespace-nowrap">
                          <button
                            onClick={() => openCostingDrawer("view", item.id)}
                            className="p-1 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded transition-colors"
                            title="View recipe details"
                          >
                            <Eye className="h-4.5 w-4.5" />
                          </button>
                          <button
                            onClick={() => openCostingDrawer("edit", item.id)}
                            className="p-1 text-neutral-400 hover:text-brand-600 hover:bg-brand-50 rounded transition-colors"
                            title="Edit recipe"
                          >
                            <Edit2 className="h-4.5 w-4.5" />
                          </button>
                          <button
                            onClick={() => handleDuplicate(item.id, item.itemName)}
                            className="p-1 text-neutral-400 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-colors"
                            title="Duplicate costing sheet"
                          >
                            <Copy className="h-4.5 w-4.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(item.id)}
                            className="p-1 text-neutral-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors"
                            title="Delete costing sheet"
                          >
                            <Trash2 className="h-4.5 w-4.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── CREATE / EDIT / VIEW DRAWER ──────── */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop */}
          <div className="fixed inset-0 bg-black/40 transition-opacity" onClick={() => setDrawerOpen(false)} />

          {/* Panel Container */}
          <div className="relative w-full max-w-4xl bg-white h-full shadow-2xl flex flex-col z-10 transition-transform duration-300">
            {/* Header */}
            <div className="bg-neutral-900 text-white px-6 py-5 flex items-center justify-between">
              <div>
                <span className="text-[10px] uppercase font-bold tracking-widest text-brand-400 bg-brand-900/40 px-2 py-0.5 rounded border border-brand-800">
                  {drawerMode === "view" ? "View Mode" : drawerMode === "edit" ? "Edit Recipe" : "Create Recipe"}
                </span>
                <h2 className="text-xl font-bold mt-1 text-white">
                  {drawerMode === "create" ? "New Menu Costing Sheet" : formName || "Recipe Details"}
                </h2>
              </div>
              <button
                onClick={() => setDrawerOpen(false)}
                className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Row 1: Basic Details */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5 bg-neutral-50 p-5 rounded-xl border border-neutral-200">
                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wide mb-1.5">
                    Menu Item Name
                  </label>
                  <input
                    type="text"
                    disabled={drawerMode === "view"}
                    placeholder="e.g. Garlic Naan Basket"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-100 disabled:text-neutral-600"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wide mb-1.5">
                    Category
                  </label>
                  <select
                    disabled={drawerMode === "view"}
                    value={formCategory}
                    onChange={(e) => setFormCategory(e.target.value)}
                    className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-100 disabled:text-neutral-600"
                  >
                    {MENU_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wide mb-1.5">
                    Status
                  </label>
                  <select
                    disabled={drawerMode === "view"}
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value as "draft" | "active")}
                    className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-100 disabled:text-neutral-600"
                  >
                    <option value="draft">Draft</option>
                    <option value="active">Active</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wide mb-1.5">
                    Selling Price ($)
                  </label>
                  <div className="relative">
                    <DollarSign className="absolute left-2.5 top-2.5 h-4 w-4 text-neutral-400" />
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      disabled={drawerMode === "view"}
                      value={formSellingPrice || ""}
                      onChange={(e) => setFormSellingPrice(parseFloat(e.target.value) || 0)}
                      className="w-full pl-8 pr-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-100 disabled:text-neutral-600"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wide mb-1.5">
                    Target Food Cost %
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    disabled={drawerMode === "view"}
                    value={formTargetFoodCost || ""}
                    onChange={(e) => setFormTargetFoodCost(parseFloat(e.target.value) || 0)}
                    className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-100 disabled:text-neutral-600"
                  />
                </div>

                <div className="md:col-span-3">
                  <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wide mb-1.5">
                    Internal Notes / Prep Instructions
                  </label>
                  <textarea
                    disabled={drawerMode === "view"}
                    rows={2}
                    placeholder="Enter any recipe notes, plating hints, or special instructions..."
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-100 disabled:text-neutral-600 resize-none"
                  />
                </div>
              </div>

              {/* Costing Summary Dashboard inside Drawer */}
              <div className="bg-neutral-900 text-white rounded-xl p-5 shadow-inner grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="border-r border-neutral-800 pr-4">
                  <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wide">Total Recipe Cost</span>
                  <div className="text-xl font-bold font-mono mt-1 text-brand-400">
                    ${totals.total_recipe_cost.toFixed(2)}
                  </div>
                  <span className="text-[9px] text-neutral-500">Sum of all parts</span>
                </div>

                <div className="border-r border-neutral-800 px-4">
                  <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wide">Food Cost %</span>
                  <div
                    className={`text-xl font-bold font-mono mt-1 ${
                      totals.selling_price > 0 && totals.food_cost_percent <= formTargetFoodCost
                        ? "text-emerald-400"
                        : totals.selling_price > 0
                        ? "text-rose-400"
                        : "text-neutral-400"
                    }`}
                  >
                    {totals.selling_price > 0 ? `${totals.food_cost_percent.toFixed(1)}%` : "—"}
                  </div>
                  <span className="text-[9px] text-neutral-500">Target: {formTargetFoodCost}%</span>
                </div>

                <div className="border-r border-neutral-800 px-4">
                  <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wide">Gross Margin %</span>
                  <div
                    className={`text-xl font-bold font-mono mt-1 ${
                      totals.gross_margin_percent >= 100 - formTargetFoodCost ? "text-emerald-400" : "text-neutral-400"
                    }`}
                  >
                    {totals.selling_price > 0 ? `${totals.gross_margin_percent.toFixed(1)}%` : "—"}
                  </div>
                  <span className="text-[9px] text-neutral-500">
                    Profit: ${totals.selling_price > 0 ? totals.gross_profit.toFixed(2) : "0.00"}
                  </span>
                </div>

                <div className="pl-4">
                  <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wide">Suggested Price</span>
                  <div className="text-sm font-semibold mt-1 space-y-0.5 font-mono text-neutral-300">
                    <div>25% FC: ${totals.suggested_price_25.toFixed(2)}</div>
                    <div>30% FC: ${totals.suggested_price_30.toFixed(2)}</div>
                    <div>35% FC: ${totals.suggested_price_35.toFixed(2)}</div>
                  </div>
                </div>
              </div>

              {/* Row 2: Recipe Components Header */}
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-neutral-200 pb-2">
                  <h3 className="text-sm font-bold text-neutral-800 flex items-center gap-2">
                    <Layers className="h-4.5 w-4.5 text-neutral-500" />
                    Ingredients & Components
                  </h3>
                  {drawerMode !== "view" && (
                    <button
                      onClick={addComponentRow}
                      className="inline-flex items-center gap-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 font-bold px-3 py-1 rounded-lg text-xs transition-colors border border-neutral-300"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add Ingredient / Pack
                    </button>
                  )}
                </div>

                {formComponents.length === 0 ? (
                  <div className="text-center py-12 border-2 border-dashed border-neutral-200 rounded-xl">
                    <Coins className="h-10 w-10 text-neutral-300 mx-auto" />
                    <p className="text-xs font-semibold text-neutral-500 mt-2">No ingredients added yet.</p>
                    {drawerMode !== "view" && (
                      <button
                        onClick={addComponentRow}
                        className="text-xs font-bold text-brand-600 hover:text-brand-700 mt-1 inline-flex items-center gap-1"
                      >
                        Click here to add your first row <ArrowRight className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {formComponents.map((comp, idx) => {
                      const suggestions = getItemSuggestions(comp.sourceType, rowSearchTerm[idx] || "");
                      const { lineCost, unitCost, error: conversionError } = calculateComponentCost(
                        comp.sourceType,
                        comp.sourceItemId,
                        comp.qtyUsed,
                        comp.unit || ""
                      );

                      // Get base unit dynamically
                      let baseUnit = "—";
                      let baseUnitCostVal = 0;
                      if (comp.sourceItemId) {
                        if (comp.sourceType === "finished_good") {
                          const fg = saleItems.find((s) => s.id === comp.sourceItemId);
                          if (fg) {
                            baseUnit = fg.baseUnit || "ea";
                            baseUnitCostVal = fg.effectivePrice || 0;
                          }
                        } else {
                          const inv = inventoryItemsMerged.find((i) => i.itemId === comp.sourceItemId);
                          if (inv) {
                            baseUnit = inv.uom || "ea";
                            const structuredCost = computeBaseUnitCostFromPack(inv);
                            baseUnitCostVal = structuredCost !== null ? structuredCost : (inv.effectivePrice || 0);
                          }
                        }
                      }

                      const displayLineCost = conversionError ? 0 : (lineCost || comp.lineCost || 0);

                      return (
                        <div
                          key={idx}
                          className="bg-white border border-neutral-200 rounded-lg p-4 shadow-sm flex flex-col gap-3 relative hover:border-neutral-300 transition-colors"
                        >
                          {/* Top controls: Source, Name Lookup, Type */}
                          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                            <div className="md:col-span-3">
                              <label className="block text-[10px] font-bold text-neutral-400 uppercase tracking-wide mb-1">
                                Source
                              </label>
                              <select
                                disabled={drawerMode === "view"}
                                value={comp.sourceType}
                                onChange={(e) => {
                                  updateComponentRow(idx, {
                                    sourceType: e.target.value as "finished_good" | "inventory_item",
                                    sourceItemId: "",
                                    itemNameSnapshot: "",
                                    unit: "",
                                    qtyUsed: 0,
                                    unitCostSnapshot: 0,
                                    lineCost: 0,
                                  });
                                  setRowSearchTerm((prev) => ({ ...prev, [idx]: "" }));
                                }}
                                className="w-full border border-neutral-200 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-100 disabled:text-neutral-600"
                              >
                                <option value="finished_good">HQ Finished Good</option>
                                <option value="inventory_item">Location Inventory Item</option>
                              </select>
                            </div>

                            {/* Searchable Autocomplete Input */}
                            <div className="md:col-span-5 relative">
                              <label className="block text-[10px] font-bold text-neutral-400 uppercase tracking-wide mb-1">
                                Search Item Name
                              </label>
                              <div className="relative">
                                <input
                                  type="text"
                                  disabled={drawerMode === "view"}
                                  placeholder={
                                    comp.sourceType === "finished_good" ? "Type to search finished goods..." : "Type to search inventory..."
                                  }
                                  value={rowSearchTerm[idx] || ""}
                                  onChange={(e) => {
                                    setRowSearchTerm((prev) => ({ ...prev, [idx]: e.target.value }));
                                    setRowShowSuggestions((prev) => ({ ...prev, [idx]: true }));
                                  }}
                                  onFocus={() => {
                                    if (drawerMode !== "view") {
                                      setRowShowSuggestions((prev) => ({ ...prev, [idx]: true }));
                                    }
                                  }}
                                  className="w-full border border-neutral-200 rounded px-2.5 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-100 disabled:text-neutral-600"
                                />
                                {comp.sourceItemId && (
                                  <span className="absolute right-2.5 top-1 text-[9px] font-mono text-neutral-400">
                                    ID: {comp.sourceItemId}
                                  </span>
                                )}
                              </div>

                              {/* Autocomplete Popup */}
                              {rowShowSuggestions[idx] && suggestions.length > 0 && (
                                <div className="absolute left-0 right-0 top-12 mt-1 bg-white border border-neutral-200 rounded-md shadow-lg z-20 max-h-48 overflow-y-auto divide-y divide-neutral-100">
                                  {suggestions.map((option: any) => {
                                    const optId = option.id || option.itemId;
                                    return (
                                      <button
                                        key={optId}
                                        type="button"
                                        onClick={() => {
                                          updateComponentRow(idx, {
                                            sourceItemId: optId,
                                            itemNameSnapshot: option.name,
                                            unit: option.baseUnit || option.uom,
                                            unitCostSnapshot: option.effectivePrice || 0,
                                          });
                                          setRowSearchTerm((prev) => ({ ...prev, [idx]: option.name }));
                                          setRowShowSuggestions((prev) => ({ ...prev, [idx]: false }));
                                        }}
                                        className="w-full text-left px-3 py-1.5 hover:bg-neutral-50 text-xs transition-colors flex justify-between items-center"
                                      >
                                        <span className="font-semibold text-neutral-800">{option.name}</span>
                                        <span className="text-[10px] text-neutral-400 font-mono">
                                          ${(option.effectivePrice || 0).toFixed(2)} / {option.baseUnit || option.uom}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>

                            <div className="md:col-span-3">
                              <label className="block text-[10px] font-bold text-neutral-400 uppercase tracking-wide mb-1">
                                Component Type
                              </label>
                              <select
                                disabled={drawerMode === "view"}
                                value={comp.componentType}
                                onChange={(e) =>
                                  updateComponentRow(idx, {
                                    componentType: e.target.value as typeof comp.componentType,
                                  })
                                }
                                className="w-full border border-neutral-200 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-100 disabled:text-neutral-600"
                              >
                                {COMPONENT_TYPES.map((t) => (
                                  <option key={t.value} value={t.value}>
                                    {t.label}
                                  </option>
                                ))}
                              </select>
                            </div>

                            {/* Delete Action button for row */}
                            {drawerMode !== "view" && (
                              <div className="md:col-span-1 flex items-end justify-center">
                                <button
                                  type="button"
                                  onClick={() => removeComponentRow(idx)}
                                  className="p-1 hover:bg-rose-50 text-neutral-400 hover:text-rose-600 rounded transition-colors"
                                  title="Delete ingredient row"
                                >
                                  <Trash2 className="h-4.5 w-4.5" />
                                </button>
                              </div>
                            )}
                          </div>

                          {/* Bottom controls: Base Unit, Base Unit Cost, Usage Unit, Qty, Line Cost */}
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 bg-neutral-50/70 p-2.5 rounded border border-neutral-150 text-xs">
                            <div>
                              <span className="block text-[9px] font-bold text-neutral-400 uppercase tracking-wide mb-0.5">
                                Base Unit
                              </span>
                              <div className="font-mono py-0.5 text-neutral-600 font-semibold">
                                {baseUnit}
                              </div>
                            </div>

                            <div>
                              <span className="block text-[9px] font-bold text-neutral-400 uppercase tracking-wide mb-0.5">
                                Base Unit Cost
                              </span>
                              <div className="font-mono py-0.5 text-neutral-600 font-semibold">
                                {baseUnitCostVal > 0 ? `$${baseUnitCostVal.toFixed(4)}` : "—"}
                              </div>
                            </div>

                            <div>
                              <span className="block text-[9px] font-bold text-neutral-400 uppercase tracking-wide mb-0.5">
                                Usage Unit
                              </span>
                              <input
                                type="text"
                                disabled={drawerMode === "view"}
                                placeholder="g, kg, L, oz, pc"
                                value={comp.unit || ""}
                                onChange={(e) => updateComponentRow(idx, { unit: e.target.value })}
                                className="w-full border border-neutral-200 rounded px-2 py-0.5 bg-white focus:outline-none disabled:bg-neutral-100 font-mono text-[11px]"
                              />
                            </div>

                            <div>
                              <span className="block text-[9px] font-bold text-neutral-400 uppercase tracking-wide mb-0.5">
                                Qty Used
                              </span>
                              <input
                                type="number"
                                min={0}
                                step="any"
                                disabled={drawerMode === "view"}
                                value={comp.qtyUsed || ""}
                                onChange={(e) => updateComponentRow(idx, { qtyUsed: parseFloat(e.target.value) || 0 })}
                                className="w-full border border-neutral-200 rounded px-2 py-0.5 bg-white focus:outline-none disabled:bg-neutral-100 font-mono text-[11px]"
                              />
                            </div>

                            <div>
                              <span className="block text-[9px] font-bold text-neutral-400 uppercase tracking-wide mb-0.5">
                                Line Cost
                              </span>
                              <div className="font-mono py-0.5 font-semibold text-neutral-900">
                                {displayLineCost > 0 ? `$${displayLineCost.toFixed(2)}` : "$0.00"}
                              </div>
                            </div>
                          </div>

                          {/* Conversion Error Message Block */}
                          {conversionError && (
                            <div className="flex items-center gap-1.5 text-[10px] text-rose-600 bg-rose-50 border border-rose-100 rounded px-2 py-1">
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                              <span>{conversionError}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="bg-neutral-50 border-t border-neutral-200 px-6 py-4 flex items-center justify-between shadow-lg">
              <div className="flex items-center gap-2">
                <Info className="h-4.5 w-4.5 text-neutral-400" />
                <span className="text-xs text-neutral-500">
                  {drawerMode === "view"
                    ? "Read-only preview. Close to go back."
                    : "Make sure all recipe conversions are valid before saving."}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setDrawerOpen(false)}
                  className="px-4 py-2 border border-neutral-300 rounded-lg text-sm font-semibold text-neutral-700 bg-white hover:bg-neutral-100 transition-colors"
                >
                  Close
                </button>
                {drawerMode !== "view" && (
                  <button
                    onClick={handleSave}
                    className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-lg text-sm shadow-sm transition-colors"
                  >
                    Save Costing
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
