"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { 
  Plus, 
  Search, 
  Mail, 
  Phone, 
  MoreHorizontal, 
  Filter,
  FileText,
  TrendingDown,
  TrendingUp,
  MapPin,
  Clock,
  CheckCircle2,
  AlertCircle,
  ShoppingCart,
  Edit2,
  Save,
  X,
  Warehouse,
  AlertTriangle
} from "lucide-react";
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip, 
  ResponsiveContainer 
} from "recharts";

import { useRouter } from "next/navigation";
import { loadSuppliers, saveSuppliers, loadInventory, loadOrders, saveOrders, resolveSupplier } from "@/lib/storage";

const mockPriceHistory = [
  { month: 'May', price: 4.50 },
  { month: 'Jun', price: 4.60 },
  { month: 'Jul', price: 4.45 },
  { month: 'Aug', price: 4.75 },
  { month: 'Sep', price: 5.10 },
  { month: 'Oct', price: 5.25 },
];

export default function Suppliers() {
  const router = useRouter();
  const [selectedSupplier, setSelectedSupplier] = useState<any>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<any>({});
  
  const [suppliersData, setSuppliersData] = useState<any[]>([]);
  const [inventoryData, setInventoryData] = useState<any[]>([]);
  const [ordersData, setOrdersData] = useState<any[]>([]);
  
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCategory, setFilterCategory] = useState("All");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterLinkedSKUs, setFilterLinkedSKUs] = useState("All");
  const [filterHasPOs, setFilterHasPOs] = useState("All");
  const [filterFulfillment, setFilterFulfillment] = useState("All");

  const uniqueCategories = Array.from(new Set(
    suppliersData
      .map(s => s.category?.trim())
      .filter(c => c && c !== "")
  )).map(c => {
     // Ensure normalized casing deduplication while preserving display format
     return c;
  }).filter((v, i, a) => a.findIndex(t => t.toLowerCase() === v.toLowerCase()) === i).sort();

  const [isAddDrawerOpen, setIsAddDrawerOpen] = useState(false);
  const [newSupplier, setNewSupplier] = useState({
    name: "",
    category: "General",
    contact: "",
    email: "",
    phone: "",
    leadTime: "",
    minOrder: "",
    paymentTerms: "",
    notes: "",
    fulfillmentModel: "unclassified" as 'hq_fulfillment_centre' | 'local_vendor' | 'unclassified',
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving]   = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    async function fetchData() {
       setIsLoading(true);
       try {
         const [ldSup, ldInv, ldOrd] = await Promise.all([
            loadSuppliers(),
            loadInventory(),
            loadOrders()
         ]);
         setSuppliersData(Array.isArray(ldSup) ? ldSup : []);
         setInventoryData(Array.isArray(ldInv) ? ldInv : []);
         setOrdersData(Array.isArray(ldOrd) ? ldOrd : []);
       } catch (err) {
         console.error(err);
       } finally {
         setIsLoading(false);
       }
    }
    fetchData();
  }, []);

  if (isLoading) return <div className="p-12 flex justify-center text-neutral-400 animate-pulse">Loading Suppliers...</div>;

  const handleSaveSupplier = async () => {
    console.log("[Suppliers] save click");

    if (!newSupplier.name.trim()) {
      console.log("[Suppliers] validation failed — name is empty");
      alert("Supplier name is required.");
      return;
    }

    if (isSaving) return; // prevent duplicate concurrent saves
    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    console.log("[Suppliers] submit start  name=", newSupplier.name.trim());

    try {
      const testName = newSupplier.name.trim().replace(/\s+/g, ' ');

      // Duplicate check against the already-loaded list — do NOT use resolveSupplier
      // here. resolveSupplier is read-only and throws for any new name, which
      // silently killed this function before saveSuppliers was ever reached.
      const duplicate = suppliersData.find(
        (s: any) =>
          s.name.trim().replace(/\s+/g, ' ').toLowerCase() === testName.toLowerCase() &&
          s.status !== "Auto-created"
      );
      if (duplicate) {
        console.log("[Suppliers] validation failed — duplicate name", testName);
        alert("An active supplier with this name already exists.");
        return;
      }

      // Generate a fresh numeric ID that won't collide with existing rows.
      const newId = Date.now(); // millisecond timestamp — unique per session

      const finalItem = {
        id:               newId,
        name:             testName,
        category:         newSupplier.category  || "General",
        contact:          newSupplier.contact   || "-",
        phone:            newSupplier.phone     || "-",
        email:            newSupplier.email     || "-",
        location:         "Manual Entry",
        minOrder:         newSupplier.minOrder     || "-",
        paymentTerms:     newSupplier.paymentTerms || "-",
        leadTime:         newSupplier.leadTime     || "-",
        status:           "Active",
        notes:            newSupplier.notes || "",
        fulfillmentModel: newSupplier.fulfillmentModel || 'unclassified',
        normalizedName:   testName.toLowerCase(),
        nameAliases:      [],
      };

      console.log("[Suppliers] request start", finalItem);

      const res = await saveSuppliers([...suppliersData, finalItem]);

      if (!res?.success) {
        const msg = `Database Error: ${res?.error?.message ?? JSON.stringify(res?.error)}`;
        console.log("[Suppliers] request error", msg);
        setSaveError(msg);
        alert(msg);
        return;
      }

      console.log("[Suppliers] request success  id=", newId);
      setSuppliersData(prev => [...prev, finalItem]);
      setSaveSuccess(true);
      setNewSupplier({ name: "", category: "General", contact: "", email: "", phone: "", leadTime: "", minOrder: "", paymentTerms: "", notes: "", fulfillmentModel: "unclassified" });
      setIsAddDrawerOpen(false);
    } catch (err: any) {
      const msg = err?.message ?? "Unexpected error saving supplier.";
      console.log("[Suppliers] request error (caught)", msg);
      setSaveError(msg);
      alert(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateSupplier = async () => {
     if (!editForm.name) return;
     
     const newArr = suppliersData.map(s => {
        if (s.id === selectedSupplier.id) {
           return { ...s, ...editForm, name: editForm.name.trim().replace(/\s+/g, ' ') };
        }
        return s;
     });
     
     const res = await saveSuppliers(newArr);
     if (!res?.success) {
        alert(`Database Error (Update Supplier): ${res?.error?.message}`);
        return;
     }
     setSuppliersData(newArr);
     setIsEditing(false);
     
     const updatedSelection = newArr.find(s => s.id === selectedSupplier.id);
     setSelectedSupplier(updatedSelection);
  };

  const handleQuickReorder = async () => {
     if (!selectedSupplier) return;
     
     const supplierItems = inventoryData.filter(i => i.supplierId === selectedSupplier.id);
     const lowStockItems = supplierItems.filter(i => i.inStock < i.parLevel);
     
     if (lowStockItems.length === 0) {
        alert("No low-stock items found for this supplier.");
        return;
     }

     const lineItems = lowStockItems.map(i => ({
        ...i,
        qty: i.parLevel - i.inStock,
        expectedPrice: i.cost
     }));

     const total = lineItems.reduce((sum, i) => sum + (i.expectedPrice * i.qty), 0);
     const newOrderId = `PO-${1050 + ordersData.length}`;

     const draftPO = {
        id: newOrderId,
        supplierId: selectedSupplier.id,
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        deliveryDate: "Pending",
        items: lineItems.length,
        lineItems: lineItems,
        total: total,
        status: "Draft",
        location: "HQ (System)",
        notes: `Quick Reorder generated for ${selectedSupplier.name}`,
        createdBy: "System",
        receivedBy: null,
        receivedAt: null
     };

     const updatedOrders = [draftPO, ...ordersData];
     await saveOrders(updatedOrders);
     setOrdersData(updatedOrders);

     // Route explicitly with the preload target parameter
     router.push(`/orders?openDraft=${newOrderId}`);
  };

  const filteredSuppliers = suppliersData.filter(s => {
    if (filterCategory !== "All" && s.category !== filterCategory) return false;
    
    if (filterStatus === "Auto-created" && s.status !== "Auto-created") return false;
    if (filterStatus === "Active" && s.status !== "Active") return false;

    // Fulfillment model filter
    if (filterFulfillment !== "All" && s.fulfillmentModel !== filterFulfillment) return false;

    const linkedSKUCount = inventoryData.filter(i => i.supplierId === s.id).length;
    if (filterLinkedSKUs === "Yes" && linkedSKUCount === 0) return false;
    if (filterLinkedSKUs === "No" && linkedSKUCount > 0) return false;

    const linkedPOCount = ordersData.filter(o => o.supplierId === s.id).length;
    if (filterHasPOs === "Yes" && linkedPOCount === 0) return false;
    if (filterHasPOs === "No" && linkedPOCount > 0) return false;

    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const hasMatch = (s.name && s.name.toLowerCase().includes(q)) ||
       (s.category && s.category.toLowerCase().includes(q)) ||
       (s.contact && s.contact.toLowerCase().includes(q)) ||
       (s.email && s.email.toLowerCase().includes(q));
       
    if (!hasMatch) {
       // Search against linked items explicitly
       const hasItemMatch = inventoryData.some(i => i.supplierId === s.id && i.name?.toLowerCase().includes(q));
       if (!hasItemMatch) return false;
    }

    return true;
  });

  const enrichedSuppliers = filteredSuppliers.map(s => {
    // 1. Fetch supplier's historical delivered/sent purchase orders
    const suppOrders = ordersData.filter(o => o.supplierId === s.id && o.status !== "Draft");
    // Sort historically (most recent first)
    const sortedOrders = [...suppOrders].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    // Spend Tracking Computations
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth();
    const currentYear = currentDate.getFullYear();
    
    const monthlyOrders = sortedOrders.filter(o => {
       const d = new Date(o.date);
       return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    });

    const monthlySpend = monthlyOrders.reduce((sum, o) => sum + o.total, 0);
    const totalPOCount = sortedOrders.length;
    const lastOrderDate = sortedOrders.length > 0 ? sortedOrders[0].date : "Never";
    const avgOrderValue = totalPOCount > 0 ? (sortedOrders.reduce((sum, o) => sum + o.total, 0) / totalPOCount) : 0;

    // At Risk / Status Computations
    let dynamicStatus = "Healthy";
    let statusReason = "Active and ordering cleanly.";
    let priceVariancePct = 0;
    
    // Check Frequency
    const daysSinceLastOrder = sortedOrders.length > 0 
       ? Math.floor((currentDate.getTime() - new Date(sortedOrders[0].date).getTime()) / (1000 * 3600 * 24))
       : Infinity;

    // Variance
    if (sortedOrders.length >= 2) {
       const latestPO = sortedOrders[0];
       const recentPOs = sortedOrders.slice(1, Math.min(6, sortedOrders.length)); // up to 5 previous
       
       const avgLatestItemCost = latestPO.items > 0 ? (latestPO.total / latestPO.items) : 0;
       const avgRecentItemCost = recentPOs.reduce((sum, o) => sum + (o.items > 0 ? o.total/o.items : 0), 0) / recentPOs.length;
       
       if (avgRecentItemCost > 0) {
          priceVariancePct = ((avgLatestItemCost - avgRecentItemCost) / avgRecentItemCost) * 100;
       }
    }

    if (daysSinceLastOrder > 45) {
       dynamicStatus = "At Risk";
       statusReason = `Low Frequency: No orders in ${daysSinceLastOrder} days.`;
    } else if (priceVariancePct > 10) {
       dynamicStatus = "At Risk";
       statusReason = `High Variance: Prices rose +${priceVariancePct.toFixed(1)}% vs recent avg.`;
    } else if (daysSinceLastOrder >= 30 && daysSinceLastOrder <= 45) {
       dynamicStatus = "Warning";
       statusReason = `Low Frequency: No orders in ${daysSinceLastOrder} days.`;
    } else if (priceVariancePct >= 5 && priceVariancePct <= 10) {
       dynamicStatus = "Warning";
       statusReason = `Variance Warning: Prices rose +${priceVariancePct.toFixed(1)}% vs recent avg.`;
    }

    return {
       ...s,
       monthlySpend,
       totalPOCount,
       lastOrderDate,
       avgOrderValue,
       dynamicStatus,
       statusReason,
       priceVariancePct
    };
  }).sort((a, b) => b.monthlySpend - a.monthlySpend); // Rank by Monthly Spend

  const getRatingBadge = (rating: string) => {
    switch (rating) {
      case "Top Tier": return <Badge variant="success">{rating}</Badge>;
      case "Standard": return <Badge variant="neutral">{rating}</Badge>;
      case "At Risk": return <Badge variant="danger">{rating}</Badge>;
      default: return <Badge variant="default">{rating}</Badge>;
    }
  };

  // Compute active linked data for drawer natively
  const activeLinkedItems = selectedSupplier ? inventoryData.filter(i => {
     return i.supplierId === selectedSupplier.id;
  }) : [];

  const activeLinkedOrders = selectedSupplier ? ordersData.filter(o => {
     return o.supplierId === selectedSupplier.id;
  }) : [];

  const totalLinkedItems = activeLinkedItems.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Procurement & Vendors</h2>
          <p className="text-neutral-500 text-sm mt-1">Manage vendor performance, pricing metrics, and ordering efficiency.</p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button 
            onClick={() => setIsAddDrawerOpen(true)}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm transition-colors w-full sm:w-auto"
          >
            <Plus className="h-4 w-4" />
            Add Vendor
          </button>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
        { label: "Active Suppliers", value: suppliersData.filter(s => s.status !== "Auto-created").length.toString(), sub: "Managed Accounts" },
          { label: "Auto-Created Flags", value: suppliersData.filter(s => s.status === "Auto-created").length.toString(), sub: "Require verification", alert: true },
          { label: "HQ Fulfillment Centre", value: suppliersData.filter(s => s.fulfillmentModel === "hq_fulfillment_centre").length.toString(), sub: "Approved HQ suppliers" },
          { label: "Unclassified Suppliers", value: suppliersData.filter(s => s.fulfillmentModel === "unclassified").length.toString(), sub: "Pending review", alert: suppliersData.filter(s => s.fulfillmentModel === "unclassified").length > 0 },
          { label: "Total MTD Spend", value: `$${enrichedSuppliers.reduce((sum, s) => sum + s.monthlySpend, 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`, sub: "Across all vendors" },
          { label: "At Risk Vendors", value: enrichedSuppliers.filter(s => s.dynamicStatus === "At Risk").length.toString(), sub: "Require review", alert: true }
        ].map((stat, i) => (
          <Card key={i} className="shadow-sm border-neutral-200">
            <CardContent className="p-4 flex flex-col gap-1 text-center sm:text-left">
              <span className="text-xs text-neutral-500 font-medium">{stat.label}</span>
              <span className={`text-2xl font-bold ${stat.alert && stat.value !== "0" ? 'text-danger-600' : 'text-neutral-900'}`}>{stat.value}</span>
              <span className="text-xs text-neutral-400 mt-1">{stat.sub}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Table */}
      <Card className="shadow-sm border-neutral-200">
        <CardHeader className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:items-center justify-between pb-4 border-b border-neutral-100">
          <div className="relative w-full sm:w-96">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-neutral-400" />
            </div>
            <input 
              type="text" 
              placeholder="Search vendor name, contact, or email..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-4 py-1.5 border border-neutral-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 w-full bg-neutral-50 hover:bg-white transition-colors"
            />
          </div>
          <div className="flex gap-2 relative overflow-x-auto pb-1 max-w-full">
             <select 
               className="px-3 py-1.5 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm transition-colors"
               value={filterCategory}
               onChange={(e) => setFilterCategory(e.target.value)}
             >
                <option value="All">All Categories</option>
                {uniqueCategories.map(cat => (
                   <option key={cat} value={cat}>{cat}</option>
                ))}
             </select>
             <select 
               className="px-3 py-1.5 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm transition-colors"
               value={filterStatus}
               onChange={(e) => setFilterStatus(e.target.value)}
             >
                <option value="All">All Statuses</option>
                <option value="Active">Active / Managed</option>
                <option value="Auto-created">Auto-created</option>
             </select>
             <select 
               className="px-3 py-1.5 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm transition-colors"
               value={filterLinkedSKUs}
               onChange={(e) => setFilterLinkedSKUs(e.target.value)}
             >
                <option value="All">Linked SKUs: Any</option>
                <option value="Yes">Has Linked SKUs</option>
                <option value="No">No Linked SKUs</option>
             </select>
             <select 
               className="px-3 py-1.5 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm transition-colors"
               value={filterHasPOs}
               onChange={(e) => setFilterHasPOs(e.target.value)}
             >
                <option value="All">Purchase Orders: Any</option>
                <option value="Yes">Has Past POs</option>
                <option value="No">No Past POs</option>
             </select>
             {/* Fulfillment model filter */}
             <select
               className="px-3 py-1.5 text-sm font-medium bg-white border border-blue-200 text-blue-700 rounded-lg outline-none focus:ring-1 focus:ring-blue-400 shadow-sm transition-colors"
               value={filterFulfillment}
               onChange={(e) => setFilterFulfillment(e.target.value)}
             >
               <option value="All">Fulfillment: All</option>
               <option value="hq_fulfillment_centre">HQ Fulfillment Centre</option>
               <option value="local_vendor">Local Vendor</option>
               <option value="unclassified">Unclassified</option>
             </select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/50 text-xs uppercase tracking-wider">
              <TableRow>
                <TableHead className="font-semibold px-6 py-3">Vendor</TableHead>
                <TableHead className="font-semibold py-3">Fulfillment Model</TableHead>
                <TableHead className="font-semibold py-3">Intelligence</TableHead>
                <TableHead className="font-semibold py-3">Procurement Terms</TableHead>
                <TableHead className="font-semibold py-3">Contact</TableHead>
                <TableHead className="text-right font-semibold px-6 py-3">Quick Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {enrichedSuppliers.map((supplier) => {
                
                // Live count computation!
                const dynamicItemCount = inventoryData.filter(i => i.supplierId === supplier.id).length;
                
                return (
                 <TableRow 
                   key={supplier.id} 
                   className="hover:bg-neutral-50/80 cursor-pointer group"
                   onClick={() => {
                      setSelectedSupplier(supplier);
                      setIsEditing(false);
                      setEditForm(supplier);
                   }}
                 >
                   <TableCell className="px-6 py-4">
                     <div className="flex flex-col">
                       <div className="flex items-center gap-2">
                          <span className="font-semibold text-neutral-900 group-hover:text-brand-600 transition-colors">{supplier.name}</span>
                          {supplier.status === "Auto-created" && (
                             <Badge variant="warning" className="text-[10px] uppercase px-1.5 py-0 h-4">Auto-created</Badge>
                          )}
                       </div>
                       <span className="text-xs text-neutral-500 mt-0.5">{supplier.category} • {dynamicItemCount} items linked</span>
                     </div>
                   </TableCell>
                   {/* Fulfillment Model badge */}
                   <TableCell className="py-4">
                     {supplier.fulfillmentModel === 'hq_fulfillment_centre' ? (
                       <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-700">
                         <Warehouse className="h-3 w-3" /> HQ Fulfilment Centre
                       </span>
                     ) : supplier.fulfillmentModel === 'local_vendor' ? (
                       <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-full bg-neutral-100 border border-neutral-200 text-neutral-600">
                         Local Vendor
                       </span>
                     ) : (
                       <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700">
                         <AlertTriangle className="h-3 w-3" /> Unclassified
                       </span>
                     )}
                   </TableCell>
                   <TableCell className="py-4">
                     <div className="flex flex-col gap-2">
                       <div className="flex items-center justify-between max-w-[160px]">
                         <span className="text-xs text-neutral-500">Spend (MTD)</span>
                         <span className="text-sm font-medium text-neutral-900">${supplier.monthlySpend.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                       </div>
                       <div className="flex items-center justify-between max-w-[160px]">
                         <span className="text-xs text-neutral-500">Recent PO</span>
                         <span className="text-sm font-medium text-neutral-900">{supplier.lastOrderDate}</span>
                       </div>
                       {supplier.dynamicStatus !== "Healthy" && (
                          <div className="flex items-center justify-between max-w-[160px] mt-1">
                            <span className="text-xs text-neutral-500">Risk Eval</span>
                            <Badge variant={supplier.dynamicStatus === "At Risk" ? 'danger' : 'warning'} className="text-[10px] px-1.5 py-0 h-4">{supplier.dynamicStatus}</Badge>
                          </div>
                       )}
                     </div>
                   </TableCell>
                   <TableCell className="py-4">
                     <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                       <span className="text-neutral-500">Lead Time:</span>
                       <span className="font-medium text-neutral-900">{supplier.leadTime}</span>
                       <span className="text-neutral-500">Min Order:</span>
                       <span className="font-medium text-neutral-900">{supplier.minOrder}</span>
                       <span className="text-neutral-500">Terms:</span>
                       <span className="font-medium text-neutral-900">{supplier.paymentTerms}</span>
                     </div>
                   </TableCell>
                   <TableCell className="py-4">
                     <div className="flex flex-col gap-1.5 text-xs">
                       <div className="flex items-center gap-2 text-neutral-600 font-medium whitespace-nowrap">
                         {supplier.contact}
                       </div>
                       <div className="flex items-center gap-2 text-neutral-500">
                         <Mail className="h-3.5 w-3.5" /> {supplier.email}
                       </div>
                       <div className="flex items-center gap-2 text-neutral-500">
                         <Phone className="h-3.5 w-3.5" /> {supplier.phone}
                       </div>
                     </div>
                   </TableCell>
                   <TableCell className="px-6 py-4 text-right">
                     <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                       <button 
                         className="p-1.5 text-neutral-400 hover:text-brand-600 hover:bg-brand-50 rounded-md transition-colors border border-transparent"
                         title="Edit Supplier"
                         onClick={(e) => { 
                            e.stopPropagation(); 
                            setSelectedSupplier(supplier);
                            setEditForm(supplier);
                            setIsEditing(true); 
                         }}
                       >
                         <Edit2 className="h-4 w-4" />
                       </button>
                       <button 
                         className="p-1.5 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded-md transition-colors"
                         onClick={(e) => { e.stopPropagation(); }}
                       >
                         <MoreHorizontal className="h-4 w-4" />
                       </button>
                     </div>
                   </TableCell>
                 </TableRow>
                )
              })}
              {enrichedSuppliers.length === 0 && (
                 <TableRow>
                   <TableCell colSpan={6} className="text-center py-10 text-neutral-500 text-sm">
                      No matching vendors found.
                   </TableCell>
                 </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Detail & Edit Drawer */}
      <Drawer
        isOpen={!!selectedSupplier}
        onClose={() => { setSelectedSupplier(null); setIsEditing(false); }}
        title={isEditing ? `Edit ${selectedSupplier?.name}` : selectedSupplier?.name || "Vendor Details"}
        description={isEditing ? "Update global supplier bounds referencing this ID." : `${selectedSupplier?.category} • ${selectedSupplier?.status} Account`}
        footer={
          <>
            {isEditing ? (
               <div className="flex w-full items-center gap-3">
                  <button 
                     className="px-4 py-2 flex-1 text-sm font-medium bg-neutral-100 text-neutral-700 rounded-lg hover:bg-neutral-200 transition-colors"
                     onClick={() => setIsEditing(false)}
                  >
                     Cancel
                  </button>
                  <button 
                     className="px-4 py-2 flex-1 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm flex items-center justify-center gap-2"
                     onClick={handleUpdateSupplier}
                  >
                     <Save className="h-4 w-4" /> Save Changes
                  </button>
               </div>
            ) : (
               <div className="flex w-full items-center gap-3">
                 <button 
                    className="px-4 py-2 flex-1 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors flex items-center justify-center gap-2"
                    onClick={() => { setIsEditing(true); setEditForm(selectedSupplier); }}
                 >
                   <Edit2 className="h-4 w-4" /> Edit Vendor Info
                 </button>
                 <button 
                    className="px-4 py-2 flex-1 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm flex items-center justify-center gap-2"
                    onClick={handleQuickReorder}
                 >
                   <ShoppingCart className="h-4 w-4" /> Quick Reorder
                 </button>
               </div>
            )}
          </>
        }
      >
        {selectedSupplier && !isEditing && (
          <div className="space-y-8">
            <div className="grid grid-cols-2 gap-4">
              <Card className="shadow-none border-neutral-200">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center gap-2 text-neutral-900 font-medium">
                    <MapPin className="h-4 w-4 text-neutral-400" /> Procurement Details
                  </div>
                  <div className="grid grid-cols-2 gap-y-2 text-sm">
                    <span className="text-neutral-500">Lead Time</span>
                    <span className="font-medium text-right">{selectedSupplier.leadTime}</span>
                    <span className="text-neutral-500">Min Order</span>
                    <span className="font-medium text-right">{selectedSupplier.minOrder}</span>
                    <span className="text-neutral-500">Terms</span>
                    <span className="font-medium text-right">{selectedSupplier.paymentTerms}</span>
                  </div>
                </CardContent>
              </Card>
              <Card className="shadow-none border-neutral-200 bg-brand-50/30">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between text-neutral-900 font-medium">
                    <span>Performance Eval</span>
                    <Badge variant={selectedSupplier.dynamicStatus === "At Risk" ? 'danger' : selectedSupplier.dynamicStatus === "Warning" ? 'warning' : 'success'} className="text-[10px] px-2 py-0.5">{selectedSupplier.dynamicStatus || selectedSupplier.status}</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-y-2 text-sm">
                    <span className="text-neutral-500">Orders Total</span>
                    <span className="font-medium text-right">{selectedSupplier.totalPOCount || 0}</span>
                    <span className="text-neutral-500">Avg Value</span>
                    <span className="font-medium text-right">${(selectedSupplier.avgOrderValue || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                    <span className="text-neutral-500">Spend (MTD)</span>
                    <span className={`font-medium text-right ${(selectedSupplier.monthlySpend || 0) > 0 ? "text-brand-700" : ""}`}>${(selectedSupplier.monthlySpend || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                  </div>
                  {selectedSupplier.statusReason && selectedSupplier.dynamicStatus !== "Healthy" && (
                     <div className="text-xs text-danger-600 bg-white/50 p-2 rounded border border-danger-100 italic mt-2">
                        {selectedSupplier.statusReason}
                     </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Fulfillment Status Card */}
            <Card className="shadow-none border-neutral-200">
               <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                     <div className={`p-2 rounded-lg ${selectedSupplier.fulfillmentModel === 'hq_fulfillment_centre' ? 'bg-blue-50 text-blue-600' : 'bg-neutral-50 text-neutral-500'}`}>
                        <Warehouse className="h-5 w-5" />
                     </div>
                     <div>
                        <p className="text-sm font-semibold text-neutral-900">Fulfillment Model</p>
                        <p className="text-xs text-neutral-500">
                           {selectedSupplier.fulfillmentModel === 'hq_fulfillment_centre' ? 'HQ Fulfillment Centre' : 
                            selectedSupplier.fulfillmentModel === 'local_vendor' ? 'Local Vendor' : 'Unclassified'}
                        </p>
                     </div>
                  </div>
                  <Badge variant={selectedSupplier.fulfillmentModel === 'hq_fulfillment_centre' ? 'default' : 'neutral'}>
                     {selectedSupplier.fulfillmentModel?.toUpperCase().replace('_', ' ')}
                  </Badge>
               </CardContent>
            </Card>

            <Card className="shadow-none border-neutral-200">
               <CardContent className="p-4 space-y-3">
                 <div className="flex items-center gap-2 text-neutral-900 font-medium border-b border-neutral-100 pb-2">
                   Contact Information
                 </div>
                 <div className="grid grid-cols-2 gap-y-3 text-sm">
                   <div className="flex flex-col gap-1">
                      <span className="text-xs text-neutral-500">Contact Person</span>
                      <span className="font-medium text-neutral-900">{selectedSupplier.contact}</span>
                   </div>
                   <div className="flex flex-col gap-1">
                      <span className="text-xs text-neutral-500">Email Address</span>
                      <span className="font-medium text-neutral-900 flex items-center gap-1"><Mail className="h-3 w-3" /> {selectedSupplier.email}</span>
                   </div>
                   <div className="flex flex-col gap-1">
                      <span className="text-xs text-neutral-500">Phone Number</span>
                      <span className="font-medium text-neutral-900 flex items-center gap-1"><Phone className="h-3 w-3" /> {selectedSupplier.phone}</span>
                   </div>
                   <div className="flex flex-col gap-1">
                      <span className="text-xs text-neutral-500">Source Profile</span>
                      <span className="font-medium text-neutral-900">{selectedSupplier.location || "System Generated"}</span>
                   </div>
                 </div>
               </CardContent>
            </Card>

            {selectedSupplier.notes && (
               <div className="space-y-3">
                 <h3 className="text-sm font-semibold text-neutral-900">Internal Notes</h3>
                 <div className="bg-neutral-50 p-3 rounded-lg border border-neutral-200 text-sm text-neutral-700">
                    {selectedSupplier.notes}
                 </div>
               </div>
            )}

            {/* Top Items Supplied Section */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-neutral-900 flex justify-between">
                Linked Inventory SKUs
                <span className="text-neutral-500 font-medium">{totalLinkedItems} item(s)</span>
              </h3>
              <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden">
                <Table>
                  <TableHeader className="bg-neutral-50/50 text-xs">
                    <TableRow>
                      <TableHead>Item Name</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Unit Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activeLinkedItems.slice(0, 5).map(item => (
                       <TableRow key={item.id}>
                         <TableCell className="font-medium text-sm text-neutral-900">{item.name}</TableCell>
                         <TableCell>
                            <Badge variant="neutral" className="text-[10px]">{item.category}</Badge>
                         </TableCell>
                         <TableCell className="text-right font-medium text-sm text-brand-700">${item.cost}/{item.unit}</TableCell>
                       </TableRow>
                    ))}
                    {activeLinkedItems.length === 0 && (
                       <TableRow>
                         <TableCell colSpan={3} className="text-center text-xs text-neutral-500 py-6">No inventory inputs currently map to this supplier.</TableCell>
                       </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            {/* Order History */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-neutral-900 flex justify-between">
                Recent Purchase Orders
              </h3>
              <div className="space-y-2">
                {activeLinkedOrders.slice(0, 5).map((ord) => (
                  <div key={ord.id} className="flex items-center justify-between p-3 bg-white border border-neutral-200 rounded-lg hover:border-brand-300 transition-colors">
                    <div className="flex gap-3">
                      <div className="h-10 w-10 bg-brand-50 border border-brand-100 rounded flex items-center justify-center text-brand-600">
                        <FileText className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-neutral-900">{ord.id}</p>
                        <p className="text-xs text-neutral-500">{ord.date} • {ord.items} Items</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-neutral-900">${ord.total.toFixed(2)}</p>
                      <Badge variant={ord.status === 'Delivered' ? 'success' : 'warning'} className="mt-1 text-[10px] px-1.5 py-0 h-4">{ord.status}</Badge>
                    </div>
                  </div>
                ))}
                {activeLinkedOrders.length === 0 && (
                   <p className="text-xs text-neutral-500 text-center py-4 bg-white border border-neutral-200 rounded-lg">No orders traced historically for this vendor.</p>
                )}
              </div>
            </div>

          </div>
        )}
        
        {isEditing && (
          <div className="space-y-5 mt-4">
             <div className="space-y-1.5">
               <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Supplier Name *</label>
               <input type="text" value={editForm.name} onChange={e => setEditForm({...editForm, name: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. Acme Farms" />
             </div>
             <div className="grid grid-cols-2 gap-4">
               <div className="space-y-1.5">
                 <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Status</label>
                 <select value={editForm.status} onChange={e => setEditForm({...editForm, status: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500">
                    <option value="Active">Active</option>
                    <option value="Auto-created">Auto-created</option>
                 </select>
               </div>
               <div className="space-y-1.5">
                 <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Category</label>
                 <input type="text" value={editForm.category} onChange={e => setEditForm({...editForm, category: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Produce, Meat, etc." />
               </div>
             </div>
             {/* Fulfillment Model */}
             <div className="space-y-1.5 pt-1">
               <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Fulfillment Model</label>
               <select
                 value={editForm.fulfillmentModel ?? 'unclassified'}
                 onChange={e => setEditForm({...editForm, fulfillmentModel: e.target.value})}
                 className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
               >
                 <option value="hq_fulfillment_centre">HQ Fulfillment Centre — HQ receives, holds, and ships their products to locations</option>
                 <option value="local_vendor">Local Vendor — Locations purchase directly; HQ is not involved</option>
                 <option value="unclassified">Unclassified — Not yet reviewed; treated as blocked from HQ fulfillment</option>
               </select>
               <p className="text-[11px] text-neutral-400">
                 This setting does not automatically convert any catalog items. Each item must be individually reviewed and mapped.
               </p>
             </div>
             <div className="grid grid-cols-2 gap-4">
               <div className="space-y-1.5">
                 <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Lead Time</label>
                 <input type="text" value={editForm.leadTime} onChange={e => setEditForm({...editForm, leadTime: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. Next Day" />
               </div>
               <div className="space-y-1.5">
                 <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Terms</label>
                 <input type="text" value={editForm.paymentTerms} onChange={e => setEditForm({...editForm, paymentTerms: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. Net 30" />
               </div>
             </div>
             <div className="space-y-3 pt-3 border-t border-neutral-100">
               <h4 className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Contact Information</h4>
               <div className="space-y-1.5">
                 <input type="text" value={editForm.contact} onChange={e => setEditForm({...editForm, contact: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Contact Name" />
               </div>
               <div className="space-y-1.5">
                 <input type="email" value={editForm.email} onChange={e => setEditForm({...editForm, email: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Email Address" />
               </div>
               <div className="space-y-1.5">
                 <input type="text" value={editForm.phone} onChange={e => setEditForm({...editForm, phone: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Phone Number" />
               </div>
               <div className="space-y-1.5 pt-2">
                 <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Internal Notes</label>
                 <textarea value={editForm.notes} onChange={e => setEditForm({...editForm, notes: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 min-h-[80px]" placeholder="Account numbers, special delivery instructions, etc." />
               </div>
             </div>
          </div>
        )}
      </Drawer>

      {/* Add Vendor Drawer */}
      <Drawer
        isOpen={isAddDrawerOpen}
        onClose={() => setIsAddDrawerOpen(false)}
        title="Add New Vendor"
        description="Register a new supplier to start issuing purchase orders and tracking intake."
        footer={
           <div className="flex gap-3 items-center w-full flex-col">
             {saveError && (
               <div className="w-full text-xs text-danger-600 bg-danger-50 border border-danger-100 rounded-lg px-3 py-2">{saveError}</div>
             )}
             <div className="flex gap-3 w-full">
               <button onClick={() => { setIsAddDrawerOpen(false); setSaveError(null); }} className="px-4 py-2 flex-1 text-sm font-medium bg-neutral-100 text-neutral-700 border border-neutral-200 rounded-lg hover:bg-neutral-200 transition-colors">
                 Cancel
               </button>
               <button
                 onClick={handleSaveSupplier}
                 disabled={isSaving}
                 className={`px-4 py-2 flex-1 text-sm font-medium rounded-lg transition-colors shadow-sm flex items-center justify-center gap-2 ${
                   isSaving ? "bg-neutral-400 cursor-not-allowed text-white" : "bg-brand-600 text-white hover:bg-brand-700"
                 }`}
               >
                 {isSaving
                   ? <><div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving...</>
                   : "Save Vendor"}
               </button>
             </div>
           </div>
        }
      >
         <div className="space-y-5">
           <div className="space-y-1.5">
             <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Supplier Name *</label>
             <input type="text" value={newSupplier.name} onChange={e => setNewSupplier({...newSupplier, name: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. Acme Farms" />
           </div>
           <div className="grid grid-cols-2 gap-4">
             <div className="space-y-1.5">
               <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Category</label>
               <input type="text" value={newSupplier.category} onChange={e => setNewSupplier({...newSupplier, category: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Produce, Meat, etc." />
             </div>
             <div className="space-y-1.5">
               <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Lead Time</label>
               <input type="text" value={newSupplier.leadTime} onChange={e => setNewSupplier({...newSupplier, leadTime: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. Next Day" />
             </div>
           </div>
           <div className="grid grid-cols-2 gap-4">
             <div className="space-y-1.5">
               <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Min Order</label>
               <input type="text" value={newSupplier.minOrder} onChange={e => setNewSupplier({...newSupplier, minOrder: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. $150" />
             </div>
             <div className="space-y-1.5">
               <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Terms</label>
               <input type="text" value={newSupplier.paymentTerms} onChange={e => setNewSupplier({...newSupplier, paymentTerms: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="e.g. Net 30" />
             </div>
           </div>
           <div className="space-y-3 pt-3 border-t border-neutral-100">
             <h4 className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Contact Information</h4>
             <div className="space-y-1.5">
               <input type="text" value={newSupplier.contact} onChange={e => setNewSupplier({...newSupplier, contact: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Contact Name" />
             </div>
             <div className="space-y-1.5">
               <input type="email" value={newSupplier.email} onChange={e => setNewSupplier({...newSupplier, email: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Email Address" />
             </div>
             <div className="space-y-1.5">
               <input type="text" value={newSupplier.phone} onChange={e => setNewSupplier({...newSupplier, phone: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500" placeholder="Phone Number" />
             </div>
             <div className="space-y-1.5 pt-2">
                <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Internal Notes</label>
                <textarea value={newSupplier.notes} onChange={e => setNewSupplier({...newSupplier, notes: e.target.value})} className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 min-h-[80px]" placeholder="Account numbers, special delivery instructions, etc." />
              </div>
              {/* Fulfillment Model for new supplier */}
              <div className="space-y-1.5 pt-3 border-t border-neutral-100">
                <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Fulfillment Model</label>
                <select
                  value={newSupplier.fulfillmentModel}
                  onChange={e => setNewSupplier({...newSupplier, fulfillmentModel: e.target.value as any})}
                  className="w-full p-2 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="unclassified">Unclassified — Not yet reviewed (default; safe)</option>
                  <option value="hq_fulfillment_centre">HQ Fulfillment Centre — HQ receives and distributes</option>
                  <option value="local_vendor">Local Vendor — Locations purchase directly</option>
                </select>
                <p className="text-[11px] text-neutral-400">
                  You can update this later. Unclassified suppliers are blocked from HQ fulfillment until reviewed.
                </p>
              </div>
           </div>
         </div>
      </Drawer>
    </div>
  );
}
