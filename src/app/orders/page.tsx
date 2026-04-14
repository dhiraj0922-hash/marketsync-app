"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { Modal } from "@/components/ui/modal";
import { 
  Plus, 
  Search, 
  FileText, 
  ArrowRight,
  Filter,
  Package,
  ShoppingCart,
  Send,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
  MapPin,
  Clock,
  CreditCard,
  FileEdit,
  AlertTriangle,
  Save,
  Trash,
  X
} from "lucide-react";
import { loadOrders, saveOrders, insertOrder, updateOrder, deleteOrder, generateOrderId, loadInventory, saveInventory, loadSuppliers, resolveSupplier, loadLocations } from "@/lib/storage";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/components/AuthProvider";

const HQ_LOCATION_ID = "LOC-HQ";

export default function Orders() {
  const { user } = useAuth();
  // queryLocationId: scopes the loadOrders query
  // Recomputed each render — safe as a render-time value (only used in useEffect deps)
  const queryLocationId: string | null =
    user?.role === "hq_admin" ? null : (user?.locationId ?? null);

  // NOTE: writeLocationId is intentionally NOT a render-time constant.
  // Computing it from user at render captures user=null before the profile loads,
  // causing saveOrder to write LOC-HQ instead of the user's real location.
  // It is now computed inside saveOrder at call time (see below).

  const [orders, setOrders] = useState<any[]>([]);
  const [inventoryData, setInventoryData] = useState<any[]>([]);
  const [suppliersData, setSuppliersData] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);  // live from DB — replaces hardcoded locationsData
  const [isLoading, setIsLoading] = useState(true);

  // Resolve a location_id to its display name (falls back to the id itself)
  const locationDisplayName = (locationId: string | null | undefined): string => {
    if (!locationId) return "";
    return locations.find(l => l.id === locationId)?.name ?? locationId;
  };

  // Monotonically-increasing counter — only the response matching the latest
  // request id is allowed to update state. Prevents stale responses from a slow
  // prior fetch overwriting the result of a faster newer one.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const thisRequestId = ++requestIdRef.current;
    const controller   = new AbortController();

    // Hard fetch timeout — never show "Loading Orders Module..." beyond this.
    const timeout = setTimeout(() => {
      controller.abort();
    }, 15_000);

    async function fetchAll() {
      setIsLoading(true);
      console.log("[Orders] load start  requestId=", thisRequestId, " queryLocationId=", queryLocationId);

      try {
        const [loadedOrders, loadedInv, loadedSup, loadedLocs] = await Promise.all([
          loadOrders(queryLocationId),
          loadInventory(),
          loadSuppliers(),
          loadLocations(),
        ]);

        // Discard if a newer request has already started
        if (thisRequestId !== requestIdRef.current) {
          console.log("[Orders] stale response ignored  requestId=", thisRequestId);
          return;
        }

        if (loadedOrders.length === 0) {
          console.log("[Orders] load empty  requestId=", thisRequestId);
        } else {
          console.log("[Orders] load success  count=", loadedOrders.length, " requestId=", thisRequestId);
        }

        setOrders(loadedOrders);
        setInventoryData(loadedInv);
        setSuppliersData(loadedSup);
        setLocations(loadedLocs);

        // Handle ?openDraft= deep-link
        if (typeof window !== "undefined") {
          const params  = new URLSearchParams(window.location.search);
          const draftId = params.get("openDraft");
          if (draftId) {
            const target = loadedOrders.find((o: any) => o.id === draftId);
            if (target) {
              const supp = loadedSup.find((s: any) => s.id === target.supplierId);
              setSelectedSupplier(supp || { id: target.supplierId, name: target.supplierId });
              setSelectedLocation(target.location);
              setNotes(target.notes || "");
              setDraftItems(target.lineItems || []);
              setEditorState({ isOpen: true, orderId: target.id, readOnly: false });
              window.history.replaceState({}, "", "/orders");
            }
          }
        }
      } catch (err: any) {
        if (thisRequestId !== requestIdRef.current) {
          console.log("[Orders] stale error ignored  requestId=", thisRequestId);
          return;
        }
        const isAbort = err?.name === "AbortError";
        console.log(
          "[Orders] load error",
          isAbort ? "(timeout/abort)" : "",
          " requestId=", thisRequestId,
          " message=", err?.message
        );
      } finally {
        console.log("[Orders] load finally  requestId=", thisRequestId, " isCurrent=", thisRequestId === requestIdRef.current);
        // Always clear loading — even on unmount (React ignores state on unmounted components)
        if (thisRequestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    }

    fetchAll();

    return () => {
      // Cancel in-flight request and timeout on cleanup
      clearTimeout(timeout);
      controller.abort();
    };
  }, [queryLocationId]); // re-fetch whenever role/location resolves after auth bootstrap

  
  // Editor / Draft State
  const [editorState, setEditorState] = useState<{ isOpen: boolean, orderId: string | null, readOnly: boolean }>({ isOpen: false, orderId: null, readOnly: false });
  const [selectedSupplier, setSelectedSupplier] = useState<any>(null);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [draftItems, setDraftItems] = useState<any[]>([]);
  const [notes, setNotes] = useState("");
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [orderSaveError, setOrderSaveError] = useState<string | null>(null);

  // Receive PO State
  const [receivingOrder, setReceivingOrder] = useState<any>(null);
  const [receivingItems, setReceivingItems] = useState<any[]>([]);
  const [successModalOrder, setSuccessModalOrder] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterSupplier, setFilterSupplier] = useState("All");
  const [filterLocation, setFilterLocation] = useState("All");
  const [filterDate, setFilterDate] = useState("All");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const savedFilters = localStorage.getItem("orders_filters");
      if (savedFilters) {
        try {
          const p = JSON.parse(savedFilters);
          if (p.searchQuery !== undefined) setSearchQuery(p.searchQuery);
          if (p.filterStatus !== undefined) setFilterStatus(p.filterStatus);
          if (p.filterSupplier !== undefined) setFilterSupplier(p.filterSupplier);
          if (p.filterLocation !== undefined) setFilterLocation(p.filterLocation);
          if (p.filterDate !== undefined) setFilterDate(p.filterDate);
        } catch (e) {}
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("orders_filters", JSON.stringify({
        searchQuery, filterStatus, filterSupplier, filterLocation, filterDate
      }));
    }
  }, [searchQuery, filterStatus, filterSupplier, filterLocation, filterDate]);

  const getSupplierName = (id: any) => {
    const s = suppliersData.find(s => s.id === id);
    return s ? s.name : "Unknown Vendor";
  };

  const filteredOrders = orders.filter(order => {
    if (filterStatus !== "All" && order.status !== filterStatus) return false;
    if (filterSupplier !== "All" && getSupplierName(order.supplierId) !== filterSupplier) return false;
    if (filterLocation !== "All" && order.location !== filterLocation) return false;
    
    if (filterDate !== "All") {
      const d = new Date(order.date);
      const now = new Date();
      const diffDays = Math.ceil(Math.abs(now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
      
      if (filterDate === "Today" && diffDays > 1) return false;
      if (filterDate === "This Week" && diffDays > 7) return false;
      if (filterDate === "This Month" && (now.getMonth() !== d.getMonth() || now.getFullYear() !== d.getFullYear())) return false;
      if (filterDate === "This Year" && now.getFullYear() !== d.getFullYear()) return false;
    }
    
    if (searchQuery) {
      const qs = searchQuery.toLowerCase();
      const suppName = getSupplierName(order.supplierId);
      if (!order.id?.toLowerCase().includes(qs) &&
          !suppName.toLowerCase().includes(qs) &&
          !order.location?.toLowerCase().includes(qs) &&
          !order.status?.toLowerCase().includes(qs)) {
        
        let hasItemMatch = false;
        if (order.lineItems && order.lineItems.length > 0) {
           hasItemMatch = order.lineItems.some((i: any) => i.name?.toLowerCase().includes(qs));
        } else {
           const supplierItems = inventoryData.filter(i => i.supplierId === order.supplierId);
           hasItemMatch = supplierItems.some((i: any) => i.name?.toLowerCase().includes(qs));
        }

        if (!hasItemMatch) return false;
      }
    }
    return true;
  });

  // Derived state (using filteredOrders!)
  const totalSpentMTD = filteredOrders.filter(o => o.status === "Delivered").reduce((sum, o) => sum + o.total, 0);
  const pendingOrders = filteredOrders.filter(o => o.status === "Draft" || o.status === "Sent").length;

  const normalizedSuppliersMap = new Map<string, string>();
  suppliersData.forEach(s => {
    if (s.name && s.name.trim() !== '') {
       normalizedSuppliersMap.set(s.name.trim().toLowerCase(), s.name.trim());
    }
  });
  inventoryData.forEach(item => {
    if (item.supplierId) {
       const suppObj = suppliersData.find(s => s.id === item.supplierId);
       if (suppObj) {
          normalizedSuppliersMap.set(suppObj.name.trim().toLowerCase(), suppObj.name.trim());
       }
    }
  });
  const uniqueSuppliers = Array.from(normalizedSuppliersMap.values()).sort();

  const handleAddItem = (item: any) => {
    if (editorState.readOnly) return;
    if (!draftItems.find(i => i.id === item.id)) {
      setDraftItems([...draftItems, { ...item, qty: item.parLevel - item.inStock > 0 ? item.parLevel - item.inStock : 1, expectedPrice: item.cost }]);
    }
  };

  const currentTotal = draftItems.reduce((sum, item) => sum + (item.expectedPrice * item.qty), 0);
  const receivingTotal = receivingItems.reduce((sum, item) => sum + (item.actualPrice * item.receivedQty), 0);

  const openCreatePO = () => {
    setSelectedSupplier(null);
    setOrderSaveError(null);
    // location_manager: lock to their canonical locationId.
    // Store the raw locationId (not the display name) — saveOrder reads it from
    // the user profile anyway, but selectedLocation drives the disabled check on
    // Send Order. If we called locationDisplayName() here while locations is still
    // loading it returns "" → Send is permanently disabled. Use locationId directly.
    setSelectedLocation(
      user?.role === "location_manager"
        ? (user.locationId ?? "")
        : ""
    );
    setDraftItems([]);
    setNotes("");
    setEditorState({ isOpen: true, orderId: null, readOnly: false });
  };

  const autoGeneratePOs = async () => {
    const lowStockItems = inventoryData.filter(i => i.inStock < i.parLevel);
    if (lowStockItems.length === 0) {
      alert("All inventory items are currently at or above their Par Levels. No orders needed!");
      return;
    }

    const invalidItems = lowStockItems.filter(i => !i.supplierId);
    if (invalidItems.length > 0) {
      const names = invalidItems.map(i => i.name).join(", ");
      alert(`Warning: The following low-stock items are missing a Preferred Supplier mapping: ${names}. Please assign them in Inventory before Auto-Generating!`);
      return;
    }

    const groupedBySupplier: Record<string, any[]> = {};
    lowStockItems.forEach(item => {
       const s = String(item.supplierId);
       if (!groupedBySupplier[s]) groupedBySupplier[s] = [];
       groupedBySupplier[s].push(item);
    });

    let newPOs: any[] = [];
    const _currentOrders = [...orders];

    Object.keys(groupedBySupplier).forEach((supplierName) => {
       const items = groupedBySupplier[supplierName];
       
       const lineItems = items.map(i => ({
          ...i,
          qty: i.parLevel - i.inStock,
          expectedPrice: i.cost
       }));

       const total = lineItems.reduce((sum, i) => sum + (i.expectedPrice * i.qty), 0);
       
       const { id, poNumber } = generateOrderId();  // UUID pk + human label — guaranteed unique

       const draftPO = {
         id,           // UUID — DB primary key, no collision possible
         poNumber,     // "PO-XXXXXXXX" — display label only
         supplierId: parseInt(supplierName, 10),
         date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
         deliveryDate: "Pending",
         items: lineItems.length,
         lineItems: lineItems,
         total: total,
         status: "Draft",
         location: "HQ",
         locationId: user?.role === "hq_admin" ? HQ_LOCATION_ID : (user?.locationId ?? HQ_LOCATION_ID),  // resolved fresh at call time
         notes: "Auto-generated from low stock metrics",
         createdBy: "System",
         receivedBy: null,
         receivedAt: null
       };
       newPOs.push(draftPO);
    });

    const finalMatrix = [...newPOs, ..._currentOrders];
    const res = await saveOrders(finalMatrix);
    if (!res?.success) {
       alert(`DB Order Save Error: ${res?.error}`);
       return;
    }
    setOrders(finalMatrix);
    alert(`Successfully generated ${newPOs.length} Draft POs from low-stock inventory!`);
  };

  const openEditPO = (order: any) => {
    const isReadOnly = order.status !== "Draft";
    
    // Simulate loading order details
    const supp = suppliersData.find(s => s.id === order.supplierId);
    setSelectedSupplier(supp || { id: order.supplierId, name: getSupplierName(order.supplierId) });
    setSelectedLocation(order.location);
    setNotes(order.notes || "");
    
    // Use saved line items if present, else fallback
    let lineItems = [];
    if (order.lineItems && order.lineItems.length > 0) {
      lineItems = order.lineItems;
    } else {
      lineItems = inventoryData.filter(i => i.supplierId === order.supplierId).map((i) => ({
        ...i,
        qty: Math.max(1, i.parLevel - i.inStock),
        expectedPrice: i.cost,
      })).slice(0, order.items);

      if (lineItems.length === 0) {
        lineItems.push({
          id: 999, name: "Generic Order Items", unit: "batch", qty: order.items, expectedPrice: (order.total / order.items), cost: (order.total / order.items), inStock: 0, parLevel: 0, lowStock: false, supplierId: order.supplierId, altSupplier: null, priceTrend: "steady", priceIncrease: false
        });
      }
    }

    setDraftItems(lineItems);
    setEditorState({ isOpen: true, orderId: order.id, readOnly: isReadOnly });
  };

  const deleteDraft = async () => {
    if (!editorState.orderId) return;
    const res = await deleteOrder(editorState.orderId);
    if (!res?.success) {
       alert(`Order Delete Error: ${res?.error}`);
       return;
    }
    setOrders(prev => prev.filter(o => o.id !== editorState.orderId));
    setEditorState({ isOpen: false, orderId: null, readOnly: false });
  };

  const saveOrder = async (status: "Draft" | "Sent") => {
    // Prevent double submission
    if (isSavingOrder) return;
    setOrderSaveError(null);

    // ── Resolve canonical location_id FRESH from user at call time ──────────────
    // DO NOT use a render-time constant. writeLocationId captured at render
    // picks up user=null (before profile loads) and silently writes LOC-HQ
    // instead of the user's real location_id, causing the RLS WITH CHECK to fail.
    if (!user) {
      alert("User session not loaded. Please wait a moment and try again.");
      return;
    }
    const canonicalLocationId: string =
      user.role === "hq_admin"
        ? HQ_LOCATION_ID
        : (user.locationId ?? null);    // null guard below will catch this

    if (user.role !== "hq_admin" && !canonicalLocationId) {
      alert("Your user profile does not have a location assigned. Contact HQ to assign your location before creating orders.");
      return;
    }

    let resolvedSupplierId: number | null = selectedSupplier.id || null;
    if (!resolvedSupplierId && selectedSupplier.name) {
      try {
        resolvedSupplierId = await resolveSupplier(selectedSupplier.name);
      } catch (e: any) {
        alert(e.message ?? `Supplier "${selectedSupplier.name}" not found in HQ master. Ask HQ to create it first.`);
        return;
      }
    }

    setIsSavingOrder(true);
    try {
      if (editorState.orderId) {
      // ── UPDATE existing order (single-row — RLS-safe) ───────────────────────
        const existing = orders.find(o => o.id === editorState.orderId);
        const patch = {
          ...existing,
          supplierId:  resolvedSupplierId,
          location:    selectedLocation || "HQ",
          locationId:  existing?.locationId || canonicalLocationId,
          items:       draftItems.length,
          lineItems:   draftItems,
          total:       currentTotal,
          notes:       notes,
          status:      status,
          date:        new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        };
        const res = await updateOrder(editorState.orderId, patch);
        if (!res.success) {
          setOrderSaveError(`Save error: ${res.error}`);
          return;
        }
        setOrders(prev => prev.map(o => o.id === editorState.orderId ? (res.order ?? patch) : o));
      } else {
        // ── INSERT new order ──────────────────────────────────────────────────
        const { id, poNumber } = generateOrderId(); // fresh UUID — no duplicate PK on retry
        const newOrder = {
          id,
          poNumber,
          supplierId:   resolvedSupplierId,
          date:         new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          deliveryDate: "Pending",
          items:        draftItems.length,
          lineItems:    draftItems,
          total:        currentTotal,
          status:       status,
          location:     selectedLocation || "HQ",
          locationId:   canonicalLocationId,
          notes:        notes,
          createdBy:    "Current User",
          receivedBy:   null,
          receivedAt:   null,
        };
        const res = await insertOrder(newOrder);
        if (!res.success) {
          setOrderSaveError(`Save error: ${res.error}`);
          return;
        }
        setOrders(prev => [res.order ?? newOrder, ...prev]);
      }

      setEditorState({ isOpen: false, orderId: null, readOnly: false });
    } finally {
      setIsSavingOrder(false);
    }
  };

  const openReceiveModal = (orderId: string) => {
    const targetOrder = orders.find(o => o.id === orderId);
    if(!targetOrder) return;

    let lineItems = [];
    if (targetOrder.lineItems && targetOrder.lineItems.length > 0) {
      lineItems = targetOrder.lineItems.map((i: any) => ({
        ...i,
        expectedQty: i.qty,
        receivedQty: 0,
        actualPrice: i.expectedPrice,
        isDamaged: false
      }));
    } else {
      // Fallback
      lineItems = inventoryData.filter(i => i.supplierId === targetOrder.supplierId).map((i) => ({
        ...i,
        expectedQty: Math.max(1, i.parLevel - i.inStock), 
        receivedQty: 0, 
        actualPrice: i.cost,
        isDamaged: false,
      })).slice(0, targetOrder.items);

      if (lineItems.length === 0) {
        lineItems.push({
          id: 999, name: "Generic Assorted Box", unit: "box", expectedQty: targetOrder.items, receivedQty: 0, actualPrice: (targetOrder.total / targetOrder.items), isDamaged: false, supplierId: targetOrder.supplierId, cost: (targetOrder.total / targetOrder.items), lowStock: false, inStock: 0, parLevel: 0, altSupplier: null, priceTrend: "steady", priceIncrease: false
        });
      }
    }

    lineItems.forEach((i: any) => i.receivedQty = i.expectedQty);

    setReceivingItems(lineItems);
    setReceivingOrder(targetOrder);
  };

  const confirmReceive = async () => {
    if (!receivingOrder) return;

    // ── 1. Update order status (single-row — RLS-safe) ───────────────────────
    const patch = {
      ...receivingOrder,
      status:       "Delivered",
      deliveryDate: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      receivedAt:   new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      receivedBy:   "Current User",
      total:        receivingTotal,
    };

    const res = await updateOrder(receivingOrder.id, patch);
    if (!res?.success) {
      alert(`Order Update Error: ${res?.error}`);
      return;
    }
    setOrders(prev => prev.map(o => o.id === receivingOrder.id ? (res.order ?? patch) : o));

    // ── 2. Post received stock directly to HQ inventory rows ─────────────────
    // Each PO line item carries itemId (shared identity) and id (row PK).
    // We update inventory_items directly via supabase scoped to LOC-HQ
    // so we never clobber other-location rows.
    const stockErrors: string[] = [];

    for (const recItem of receivingItems) {
      if (recItem.id === 999 || recItem.receivedQty <= 0) continue;

      const sharedItemId: string | undefined = recItem.itemId || recItem.item_id;

      if (sharedItemId) {
        // ── Preferred path: match by shared item_id + LOC-HQ ─────────────────
        const { data: hqRow, error: fetchErr } = await supabase
          .from("inventory_items")
          .select("id, instock")
          .eq("item_id", sharedItemId)
          .eq("location_id", HQ_LOCATION_ID)
          .maybeSingle();

        if (fetchErr) {
          stockErrors.push(`${recItem.name}: DB error (${fetchErr.message})`);
          continue;
        }

        if (hqRow) {
          const newStock = Number(hqRow.instock ?? 0) + recItem.receivedQty;
          const { error: updErr } = await supabase
            .from("inventory_items")
            .update({ instock: newStock, cost: recItem.actualPrice })
            .eq("id", hqRow.id);

          if (updErr) stockErrors.push(`${recItem.name}: update failed (${updErr.message})`);
          else console.log(`[PO Receive] ${recItem.name}: instock ${hqRow.instock} → ${newStock}`);
        } else {
          stockErrors.push(`${recItem.name}: no HQ row found for item_id=${sharedItemId}. Add this product to HQ inventory first.`);
        }
      } else {
        // ── Fallback: match by row id for legacy PO lines without itemId ──────
        const { data: invRow, error: fetchErr } = await supabase
          .from("inventory_items")
          .select("id, instock, location_id")
          .eq("id", String(recItem.id))
          .maybeSingle();

        if (fetchErr || !invRow) {
          stockErrors.push(`${recItem.name}: inventory row id=${recItem.id} not found.`);
          continue;
        }

        const newStock = Number(invRow.instock ?? 0) + recItem.receivedQty;
        const { error: updErr } = await supabase
          .from("inventory_items")
          .update({ instock: newStock, cost: recItem.actualPrice })
          .eq("id", invRow.id);

        if (updErr) stockErrors.push(`${recItem.name}: update failed (${updErr.message})`);
        else console.log(`[PO Receive] fallback id=${recItem.id}: instock → ${newStock}`);
      }
    }

    if (stockErrors.length > 0) {
      alert(`Order received, but some inventory lines failed to post:\n\n${stockErrors.join('\n')}`);
    }

    setSuccessModalOrder(receivingOrder.id);
    setReceivingOrder(null);
    setReceivingItems([]);
  };


  const handleSupplierChange = (name: string) => {
    const supp = suppliersData.find(s => s.name === name);
    setSelectedSupplier(supp || { name });
    setDraftItems([]); 
  };

  if (isLoading) return <div className="animate-pulse flex p-12 text-neutral-400 justify-center">Loading Orders Module...</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Purchase Orders</h2>
          <p className="text-neutral-500">Create, send, and track orders from your suppliers.</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <button 
            onClick={autoGeneratePOs}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-neutral-100 border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-200 shadow-sm w-full sm:w-auto transition-colors"
          >
            Auto-Generate POs
          </button>
          <button 
            onClick={openCreatePO}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm w-full sm:w-auto transition-colors"
          >
            <Plus className="h-4 w-4" />
            Create PO
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { label: "Pending or Draft", value: pendingOrders.toString(), color: "text-warning-600" },
          { label: "Sent to Supplier", value: filteredOrders.filter(o => o.status === "Sent").length.toString(), color: "text-brand-600" },
          { label: "Delivered Filtered", value: filteredOrders.filter(o => o.status === "Delivered").length.toString(), color: "text-success-600" },
          { label: "Total Spent (Delivered)", value: `$${totalSpentMTD.toLocaleString(undefined, {minimumFractionDigits: 2})}`, color: "text-neutral-900" }
        ].map((stat, i) => (
          <Card key={i} className="shadow-sm border-neutral-200">
            <CardContent className="p-4 flex flex-col gap-1 text-center sm:text-left">
              <span className="text-xs text-neutral-500 font-medium">{stat.label}</span>
              <span className={`text-2xl font-bold ${stat.color}`}>{stat.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="shadow-sm border-neutral-200 overflow-hidden">
        <CardHeader className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:items-center justify-between pb-4 border-b border-neutral-100 bg-white">
          <div className="relative w-full sm:w-[400px]">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-neutral-400" />
            </div>
            <input 
              type="text" 
              placeholder="Search PO number, supplier, or location..." 
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
               <option value="Draft">Draft</option>
               <option value="Sent">Sent</option>
               <option value="Delivered">Delivered</option>
            </select>
            <select 
               className="px-3 py-1.5 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm transition-colors"
               value={filterSupplier}
               onChange={(e) => setFilterSupplier(e.target.value)}
            >
               <option value="All">All Suppliers</option>
               {uniqueSuppliers.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select 
               className="px-3 py-1.5 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm transition-colors"
               value={filterLocation}
               onChange={(e) => setFilterLocation(e.target.value)}
            >
               <option value="All">All Locations</option>
               {locations.map((l: any) => <option key={l.id} value={l.name}>{l.name}</option>)}
            </select>

            <select 
               className="px-3 py-1.5 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm transition-colors"
               value={filterDate}
               onChange={(e) => setFilterDate(e.target.value)}
            >
               <option value="All">All Dates</option>
               <option value="Today">Today</option>
               <option value="This Week">This Week</option>
               <option value="This Month">This Month</option>
               <option value="This Year">This Year</option>
            </select>

            {(searchQuery || filterStatus !== 'All' || filterSupplier !== 'All' || filterLocation !== 'All' || filterDate !== 'All') && (
              <button 
                onClick={() => {
                  setSearchQuery('');
                  setFilterStatus('All');
                  setFilterSupplier('All');
                  setFilterLocation('All');
                  setFilterDate('All');
                }}
                className="text-xs font-semibold text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded-lg px-2 transition-colors ml-1"
              >
                Clear Filters
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider">
              <TableRow>
                <TableHead className="px-6 py-3">PO Number</TableHead>
                <TableHead className="py-3">Supplier</TableHead>
                <TableHead className="py-3">Location</TableHead>
                <TableHead className="py-3">Order Date</TableHead>
                <TableHead className="py-3">Delivery Date</TableHead>
                <TableHead className="py-3">Status</TableHead>
                <TableHead className="py-3">Total Amount</TableHead>
                <TableHead className="py-3">Received By</TableHead>
                <TableHead className="px-6 py-3 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredOrders.length > 0 ? filteredOrders.map((order) => (
                <TableRow 
                  key={order.id} 
                  className={`cursor-pointer transition-colors ${order.status === 'Draft' ? 'hover:bg-brand-50/50' : 'hover:bg-neutral-50/50'}`}
                  onClick={(e) => {
                    // Prevent row click if clicking action buttons
                    if ((e.target as HTMLElement).closest('button')) return;
                    openEditPO(order);
                  }}
                >
                  <TableCell className="px-6 py-4 font-semibold text-brand-900">
                    <div className="flex items-center gap-2 group-hover:text-brand-600 transition-colors">
                      <FileText className={`h-4 w-4 ${order.status === 'Draft' ? 'text-brand-400' : 'text-neutral-400'}`} />
                      {order.id}
                    </div>
                  </TableCell>
                  <TableCell className="py-4 font-medium text-neutral-900 text-sm">{getSupplierName(order.supplierId)}</TableCell>
                  <TableCell className="py-4 text-sm text-neutral-600">{order.location}</TableCell>
                  <TableCell className="py-4 text-sm text-neutral-500">{order.date}</TableCell>
                  <TableCell className="py-4 text-sm text-neutral-500">{order.deliveryDate || "-"}</TableCell>
                  <TableCell className="py-4">
                    <Badge 
                      variant={order.status === "Delivered" ? "success" : order.status === "Sent" ? "default" : "warning"}
                      className={order.status === "Draft" ? "bg-warning-50 text-warning-700" : ""}
                    >
                      {order.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-4 font-medium text-neutral-900 text-sm">${order.total.toFixed(2)}</TableCell>
                  <TableCell className="py-4">
                    {order.receivedBy ? (
                      <div className="flex flex-col">
                         <span className="text-sm font-medium text-neutral-900">{order.receivedBy}</span>
                         <span className="text-[10px] text-neutral-500">{order.receivedAt}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-neutral-400 italic">--</span>
                    )}
                  </TableCell>
                  <TableCell className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {order.status === "Sent" && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); openReceiveModal(order.id); }}
                          className="px-3 py-1.5 bg-success-50 hover:bg-success-100 text-success-700 text-xs font-semibold rounded-md transition-colors flex items-center gap-1 border border-success-200"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" /> Receive
                        </button>
                      )}
                      {order.status === "Draft" && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); openEditPO(order); }}
                          className="px-2.5 py-1.5 bg-white border border-neutral-200 hover:bg-neutral-50 text-neutral-700 text-xs font-semibold rounded-md transition-colors flex items-center gap-1"
                        >
                          <FileEdit className="h-3.5 w-3.5" /> Edit
                        </button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )) : (
                 <TableRow>
                   <TableCell colSpan={9} className="text-center py-10 text-neutral-500 text-sm">
                      No purchase orders match your active filters.
                   </TableCell>
                 </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Editor / Draft / Create PO Drawer */}
      <Drawer
        isOpen={editorState.isOpen}
        onClose={() => setEditorState({ isOpen: false, orderId: null, readOnly: false })}
        title={editorState.orderId ? (editorState.readOnly ? `Viewing PO ${editorState.orderId}` : `Editing Draft ${editorState.orderId}`) : "Create Purchase Order"}
        description={editorState.readOnly ? "This order has been sent and cannot be edited." : "Fill in the details below to complete your order."}
        footer={
          <div className="w-full flex items-center justify-between">
            <div className="flex items-center gap-3">
              {editorState.orderId && !editorState.readOnly ? (
                <button
                  className="px-4 py-2 text-sm font-medium bg-danger-50 text-danger-600 rounded-lg hover:bg-danger-100 transition-colors flex items-center gap-2 disabled:opacity-50"
                  onClick={deleteDraft}
                  disabled={isSavingOrder}
                >
                  <Trash className="h-4 w-4" />
                  Delete Draft
                </button>
              ) : <div />}
              {orderSaveError && (
                <span className="text-xs font-semibold text-danger-600 max-w-xs truncate">{orderSaveError}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors disabled:opacity-50"
                onClick={() => {
                  if (editorState.readOnly) {
                    setEditorState({ isOpen: false, orderId: null, readOnly: false });
                  } else {
                    saveOrder("Draft");
                  }
                }}
                disabled={isSavingOrder}
              >
                {editorState.readOnly ? "Close" : isSavingOrder ? "Saving…" : "Save as Draft"}
              </button>
              {!editorState.readOnly && (
                <button
                  className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={() => saveOrder("Sent")}
                  disabled={isSavingOrder || !selectedSupplier?.name || draftItems.length === 0 || !selectedLocation}
                >
                  {isSavingOrder
                    ? <span className="h-4 w-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    : <Send className="h-4 w-4" />}
                  {isSavingOrder ? "Sending…" : "Send Order"}
                </button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">1. Select Supplier</label>
              <select 
                className="w-full bg-white border border-neutral-200 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 disabled:bg-neutral-50 disabled:text-neutral-500"
                value={selectedSupplier?.name || ""}
                onChange={(e) => handleSupplierChange(e.target.value)}
                disabled={editorState.readOnly}
              >
                <option value="">-- Choose Supplier --</option>
                {uniqueSuppliers.map(s => <option key={`create-${s}`} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">2. Delivery Location</label>
              <div className="relative">
                <MapPin className="h-4 w-4 text-neutral-400 absolute left-3 top-1/2 transform -translate-y-1/2" />

                {/* location_manager: locked to their own assigned location */}
                {user?.role === "location_manager" ? (
                  <div className="w-full bg-neutral-50 border border-neutral-200 rounded-lg py-2 pl-9 pr-3 text-sm text-neutral-700 font-medium flex items-center justify-between">
                    <span>{selectedLocation || locationDisplayName(user.locationId) || "No location assigned"}</span>
                    <span className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider ml-2 shrink-0">Locked</span>
                  </div>
                ) : (
                  /* hq_admin: full live dropdown */
                  <select
                    className="w-full bg-white border border-neutral-200 rounded-lg py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 disabled:bg-neutral-50 disabled:text-neutral-500"
                    value={selectedLocation}
                    onChange={(e) => setSelectedLocation(e.target.value)}
                    disabled={editorState.readOnly}
                  >
                    <option value="">-- Select --</option>
                    {locations.map((l: any) => <option key={l.id} value={l.name}>{l.name}</option>)}
                    {selectedLocation && !locations.find((l: any) => l.name === selectedLocation) && (
                      <option value={selectedLocation}>{selectedLocation}</option>
                    )}
                  </select>
                )}

              </div>
            </div>
          </div>

          {selectedSupplier?.name && (
            <div className="mt-2 grid grid-cols-2 gap-4 p-3 bg-brand-50/50 border border-brand-100 rounded-lg text-sm text-neutral-700">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-brand-500" />
                <span className="font-semibold text-neutral-900">Lead Time:</span> {selectedSupplier.leadTime || "N/A"}
              </div>
              <div className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-brand-500" />
                <span className="font-semibold text-neutral-900">Terms:</span> {selectedSupplier.paymentTerms || "N/A"}
              </div>
            </div>
          )}

          {selectedSupplier?.name && selectedLocation && (
            <>
              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">
                    3. Inventory Items
                  </label>
                  {!editorState.readOnly && (
                    <button 
                      onClick={() => setIsCatalogOpen(true)}
                      className="text-brand-600 hover:text-brand-700 text-xs font-medium flex items-center gap-1 bg-white border border-neutral-200 px-2 py-1.5 rounded shadow-sm"
                    >
                      <Search className="h-3.5 w-3.5" /> Browse Catalog
                    </button>
                  )}
                </div>
                
                {!editorState.readOnly && inventoryData.filter(item => item.inStock < item.parLevel && item.supplierId === selectedSupplier.id).length > 0 && (
                  <div className="flex gap-2 pb-2 overflow-x-auto">
                    <div className="text-xs font-medium text-brand-700 bg-brand-50 border border-brand-200 px-2 py-1 rounded flex items-center whitespace-nowrap">
                      <Sparkles className="h-3 w-3 mr-1" /> Smart Picks
                    </div>
                    {inventoryData.filter(item => item.inStock < item.parLevel && item.supplierId === selectedSupplier.id).map(item => (
                      <button 
                        key={item.id} 
                        onClick={() => handleAddItem(item)}
                        className="text-xs font-medium text-neutral-700 bg-white border border-neutral-200 hover:border-brand-400 px-2 py-1 rounded shadow-sm flex items-center gap-1 whitespace-nowrap transition-colors"
                      >
                        <Plus className="h-3 w-3" /> {item.name}
                      </button>
                    ))}
                  </div>
                )}
                
                <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader className="bg-neutral-50/50 text-[11px] uppercase text-neutral-500 tracking-wider">
                      <TableRow>
                        <TableHead>Item Name</TableHead>
                        <TableHead>Stock / Par</TableHead>
                        <TableHead>Suggested</TableHead>
                        <TableHead className="w-[100px]">Qty</TableHead>
                        <TableHead className="w-[100px]">Est. Cost</TableHead>
                        <TableHead className="text-right">Line Total</TableHead>
                        {!editorState.readOnly && <TableHead className="w-[40px]"></TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {draftItems.map((item, idx) => (
                        <TableRow key={`draft-${item.id}`} className="hover:bg-neutral-50/50">
                          <TableCell>
                            <div className="font-medium text-sm text-neutral-900">{item.name}</div>
                            <div className="text-[10px] text-brand-600 font-semibold mt-0.5">
                              {item.unit} {item.baseEquivalent ? `(Yields ${item.baseEquivalent} ${item.baseUnit||'base'})` : ''}
                            </div>
                          </TableCell>
                          
                          <TableCell>
                             <div className="flex flex-col">
                                <span className={item.inStock < item.parLevel ? "text-xs font-semibold text-danger-600" : "text-xs font-semibold text-neutral-700"}>{item.inStock} {item.unit} </span>
                                <span className="text-[10px] text-neutral-500">Par: {item.parLevel}</span>
                             </div>
                          </TableCell>

                          <TableCell>
                            <Badge variant="neutral" className="text-xs bg-neutral-100">{item.parLevel - item.inStock > 0 ? item.parLevel - item.inStock : 0} {item.unit}</Badge>
                          </TableCell>

                          <TableCell>
                            {editorState.readOnly ? (
                               <span className="font-medium text-neutral-900">{item.qty}</span>
                            ) : (
                              <input 
                                type="number" 
                                min="1" 
                                value={item.qty} 
                                onChange={(e) => {
                                  const newItems = [...draftItems];
                                  newItems[idx].qty = parseInt(e.target.value) || 0;
                                  setDraftItems(newItems);
                                }}
                                className="w-16 border border-neutral-200 rounded p-1.5 text-sm text-center focus:ring-1 focus:ring-brand-500 outline-none"
                              />
                            )}
                          </TableCell>

                          <TableCell>
                            {editorState.readOnly ? (
                               <span className="font-medium text-neutral-900">${item.expectedPrice.toFixed(2)}</span>
                            ) : (
                               <div className="relative">
                                 <span className="absolute left-2 top-1.5 text-neutral-500 text-sm">$</span>
                                 <input 
                                    type="number" 
                                    step="0.01" 
                                    min="0.01"
                                    value={item.expectedPrice} 
                                    onChange={(e) => {
                                      const newItems = [...draftItems];
                                      newItems[idx].expectedPrice = parseFloat(e.target.value) || 0;
                                      setDraftItems(newItems);
                                    }}
                                    className="w-full border border-neutral-200 rounded py-1.5 pl-5 pr-1.5 text-sm focus:ring-1 focus:ring-brand-500 outline-none"
                                  />
                               </div>
                            )}
                            {item.cost && !editorState.readOnly && <div className="text-[9px] text-neutral-400 mt-0.5 text-right w-full">Last: ${item.cost?.toFixed(2)}</div>}
                          </TableCell>

                          <TableCell className="text-right font-semibold text-sm text-neutral-900">
                            ${(item.expectedPrice * item.qty).toFixed(2)}
                          </TableCell>

                          {!editorState.readOnly && (
                            <TableCell className="text-right pr-2">
                              <button 
                                onClick={() => setDraftItems(draftItems.filter(i => i.id !== item.id))}
                                className="p-1.5 text-neutral-400 hover:text-danger-600 hover:bg-danger-50 rounded transition-colors"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                      
                      {draftItems.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center py-8 text-sm text-neutral-500">
                            <div className="flex flex-col items-center justify-center gap-2">
                              <Package className="h-8 w-8 text-neutral-300" />
                              <p>No items added to this PO</p>
                              {!editorState.readOnly && <p className="text-xs text-neutral-400 max-w-sm">Use the Smart Picks above or Browse Catalog to explicitly add items to this supplier draft.</p>}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                  
                  {draftItems.length > 0 && (
                    <div className="bg-neutral-50 p-4 flex justify-between items-center border-t border-neutral-200">
                      <div className="text-sm text-neutral-500">
                         Total Line Items: <span className="font-semibold text-neutral-700">{draftItems.length}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium text-neutral-600">Grand Total</span>
                        <span className="text-xl font-bold text-neutral-900">${currentTotal.toFixed(2)}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Notes Section */}
              <div className="space-y-1.5 pt-2">
                <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider flex items-center gap-1">
                  <FileEdit className="h-3.5 w-3.5" /> 4. Order Notes / Delivery Instructions
                </label>
                <textarea 
                  className="w-full bg-white border border-neutral-200 rounded-lg p-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 min-h-[80px] disabled:bg-neutral-50 disabled:text-neutral-500"
                  placeholder="e.g. Please deliver to the back alley loading dock after 9:00 AM."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={editorState.readOnly}
                />
              </div>
            </>
          )}

        </div>
      </Drawer>

      {/* Receive PO Drawer */}
      <Drawer
        isOpen={!!receivingOrder}
        onClose={() => { setReceivingOrder(null); setReceivingItems([]); }}
        title={`Receive Order ${receivingOrder?.id}`}
        description={`Supplier: ${getSupplierName(receivingOrder?.supplierId)} • Ordered: ${receivingOrder?.date}`}
        footer={
          <>
            <button 
              className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors"
              onClick={() => { setReceivingOrder(null); setReceivingItems([]); }}
            >
              Cancel
            </button>
            <button 
              className="px-4 py-2 text-sm font-medium bg-success-600 text-white rounded-lg hover:bg-success-700 transition-colors shadow-sm flex items-center gap-2"
              onClick={confirmReceive}
            >
              <CheckCircle2 className="h-4 w-4" />
              Complete Receiving
            </button>
          </>
        }
      >
        {receivingOrder && (
          <div className="space-y-6">
             <div className="bg-neutral-50 p-4 rounded-lg flex justify-between items-center border border-neutral-200">
               <div className="text-sm">
                 <p className="text-neutral-500">Destination</p>
                 <p className="font-semibold text-neutral-900">{receivingOrder.location}</p>
               </div>
               <div className="text-sm text-right">
                 <p className="text-neutral-500">Total Items Expected</p>
                 <p className="font-semibold text-neutral-900">{receivingOrder.items} Line Items</p>
               </div>
             </div>

             <div className="border border-neutral-200 rounded-lg overflow-hidden bg-white shadow-sm">
                 <Table>
                    <TableHeader className="bg-neutral-50 text-[11px] uppercase text-neutral-500 tracking-wider">
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead className="w-[80px]">Ordered</TableHead>
                        <TableHead className="w-[100px]">Received</TableHead>
                        <TableHead className="w-[100px]">Unit Cost</TableHead>
                        <TableHead className="text-center w-[80px]">Damage</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                       {receivingItems.map((item, idx) => {
                         const isVariance = item.expectedQty !== item.receivedQty;
                         return (
                          <TableRow key={`rec-${item.id}`} className={isVariance ? "bg-warning-50/30" : "hover:bg-neutral-50/50"}>
                            <TableCell>
                              <div className="font-medium text-sm text-neutral-900">{item.name}</div>
                              <div className="text-[10px] text-neutral-500">{item.unit}</div>
                            </TableCell>
                            <TableCell className="font-semibold text-sm text-neutral-600">
                              {item.expectedQty}
                            </TableCell>
                            <TableCell>
                              <input 
                                type="number" 
                                min="0" 
                                value={item.receivedQty} 
                                onChange={(e) => {
                                  const newItems = [...receivingItems];
                                  newItems[idx].receivedQty = parseInt(e.target.value) || 0;
                                  setReceivingItems(newItems);
                                }}
                                className={`w-16 border rounded p-1.5 text-sm text-center focus:ring-1 outline-none ${isVariance ? 'border-warning-400 bg-warning-50 text-warning-700 font-bold focus:ring-warning-500' : 'border-neutral-200 focus:ring-brand-500'}`}
                              />
                            </TableCell>
                            <TableCell>
                              <div className="relative">
                                <span className="absolute left-2 top-1.5 text-neutral-500 text-sm">$</span>
                                <input 
                                  type="number" 
                                  step="0.01" 
                                  value={item.actualPrice} 
                                  onChange={(e) => {
                                    const newItems = [...receivingItems];
                                    newItems[idx].actualPrice = parseFloat(e.target.value) || 0;
                                    setReceivingItems(newItems);
                                  }}
                                  className="w-[80px] border border-neutral-200 rounded py-1.5 pl-5 pr-1.5 text-sm focus:ring-1 focus:ring-brand-500 outline-none"
                                />
                              </div>
                            </TableCell>
                            <TableCell className="text-center">
                              <button 
                                onClick={() => {
                                  const newItems = [...receivingItems];
                                  newItems[idx].isDamaged = !newItems[idx].isDamaged;
                                  setReceivingItems(newItems);
                                }}
                                className={`p-1.5 rounded-md transition-colors ${item.isDamaged ? 'bg-danger-100 text-danger-600 border border-danger-200' : 'text-neutral-400 hover:bg-neutral-100'}`}
                                title="Mark Damaged"
                              >
                                <AlertTriangle className="h-4 w-4" />
                              </button>
                            </TableCell>
                          </TableRow>
                       )})}
                    </TableBody>
                 </Table>
                 <div className="bg-neutral-50 p-4 border-t border-neutral-200">
                   <div className="flex justify-between items-center">
                     <span className="text-sm font-medium text-neutral-600">Actual AP Total</span>
                     <span className="text-xl font-bold text-neutral-900">${receivingTotal.toFixed(2)}</span>
                   </div>
                 </div>
             </div>
          </div>
        )}
      </Drawer>

      {/* Success Modal */}
      <Modal
        isOpen={!!successModalOrder}
        onClose={() => setSuccessModalOrder(null)}
        title=""
      >
        <div className="flex flex-col items-center justify-center text-center pb-2 pt-4">
          <div className="h-16 w-16 bg-success-50 rounded-full flex items-center justify-center mb-4 border-4 border-success-100">
             <CheckCircle2 className="h-8 w-8 text-success-600" />
          </div>
          <h3 className="text-xl font-bold text-neutral-900 mb-2">Order received successfully</h3>
          <p className="text-neutral-500 mb-8 max-w-sm">
            Inventory quantities, audit logs, and cost bases have been seamlessly updated for PO <strong>{successModalOrder}</strong>.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 w-full justify-center mt-2">
            <button 
              onClick={() => setSuccessModalOrder(null)}
              className="px-6 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 font-semibold shadow-sm transition-colors text-sm"
            >
              Back to Orders
            </button>
            <button 
              onClick={() => setSuccessModalOrder(null)}
              className="px-6 py-2.5 bg-white text-neutral-700 border border-neutral-200 rounded-lg hover:bg-neutral-50 font-medium transition-colors text-sm"
            >
              View Order Details
            </button>
          </div>
        </div>
      </Modal>

      {/* Catalog Search Modal */}
      {isCatalogOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm">
           <div className="bg-white rounded-xl shadow-xl border border-neutral-200 w-[500px] max-h-[80vh] flex flex-col overflow-hidden">
             <div className="flex justify-between items-center p-4 border-b border-neutral-100 bg-neutral-50/50">
               <div>
                 <h3 className="text-sm font-bold text-neutral-900">Inventory Catalog</h3>
                 <p className="text-xs text-neutral-500">Available items matching {selectedSupplier?.name}</p>
               </div>
               <button onClick={() => setIsCatalogOpen(false)} className="text-neutral-400 hover:text-neutral-700">
                 <X className="h-5 w-5" />
               </button>
             </div>
             <div className="flex-1 overflow-y-auto p-2">
                {inventoryData.filter(i => i.supplierId === selectedSupplier?.id).length === 0 ? (
                  <div className="p-8 text-center text-sm text-neutral-500">
                    No items found in your inventory mapped to this supplier.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {inventoryData.filter(i => i.supplierId === selectedSupplier?.id).map(item => (
                       <div key={`cat-${item.id}`} className="flex items-center justify-between p-3 hover:bg-brand-50 rounded-lg group transition-colors">
                         <div>
                            <div className="text-sm font-semibold text-neutral-900 group-hover:text-brand-700 transition-colors">{item.name}</div>
                            <div className="text-[10px] text-neutral-500">{item.category} • {item.inStock} {item.unit} in stock</div>
                         </div>
                         <button 
                           onClick={() => { handleAddItem(item); setIsCatalogOpen(false); }}
                           className="text-xs font-medium bg-white border border-neutral-200 px-3 py-1.5 rounded-md hover:bg-neutral-50 shadow-sm transition-all"
                         >
                           Add
                         </button>
                       </div>
                    ))}
                  </div>
                )}
             </div>
           </div>
        </div>
      )}
    </div>
  );
}
