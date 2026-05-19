"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { 
  TrendingDown, 
  TrendingUp, 
  DollarSign, 
  AlertCircle, 
  FileText,
  Clock,
  ArrowRight,
  ClipboardCheck,
  Trash2,
  PackageX,
  Plus,
  ShoppingCart,
  Box
} from "lucide-react";
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip, 
  ResponsiveContainer,
  LineChart,
  Line
} from "recharts";
import { findInventoryItem } from "@/lib/utils";

// Mock Data
const usageData = [
  { name: 'Mon', actual: 4000, theoretical: 3800 },
  { name: 'Tue', actual: 3000, theoretical: 2900 },
  { name: 'Wed', actual: 2000, theoretical: 2200 },
  { name: 'Thu', actual: 2780, theoretical: 2700 },
  { name: 'Fri', actual: 5890, theoretical: 5200 },
  { name: 'Sat', actual: 7390, theoretical: 6800 },
  { name: 'Sun', actual: 6490, theoretical: 6100 },
];

import { loadInventory, loadOrders, saveOrders, loadCounts, loadSuppliers, loadRequisitions, loadFinishedGoods, loadRecipes, loadProductionPlans, loadLocations } from "@/lib/storage";
import { runAutomationEngine } from "@/lib/automation";
import { CheckSquare } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import HQLocationReview from "@/components/HQLocationReview";

export default function Dashboard() {
  const router = useRouter();
  const { user } = useAuth();
  const isHQAdmin = user?.role === "hq_admin";

  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [counts, setCounts] = useState<any[]>([]);
  const [suppliersData, setSuppliersData] = useState<any[]>([]);
  const [requisitions, setRequisitions] = useState<any[]>([]);
  const [finishedGoods, setFinishedGoods] = useState<any[]>([]);
  const [recipes, setRecipes] = useState<any[]>([]);
  const [productionPlans, setProductionPlans] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [isBulkGenDrawerOpen, setIsBulkGenDrawerOpen] = useState(false);
  const [bulkDrafts, setBulkDrafts] = useState<Record<string, any[]>>({});
  const [dynamicUsageData, setDynamicUsageData] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    runAutomationEngine();
    
    async function fetchData() {
       setIsLoading(true);
       try {
          const [loadedInventory, loadedOrders, loadedCounts, loadedSuppliers, loadedRequisitions, loadedSettingsFGs, loadedRecipes, loadedPlans, loadedLocations] = await Promise.all([
             loadInventory(),
             loadOrders(),
             loadCounts(),
             loadSuppliers(),
             loadRequisitions(),
             loadFinishedGoods(),
             loadRecipes(),
             loadProductionPlans(),
             loadLocations(),
          ]);
          
          setInventoryItems(loadedInventory);
          setOrders(loadedOrders);
          setCounts(loadedCounts);
          setSuppliersData(loadedSuppliers);
          setRequisitions(loadedRequisitions);
          setFinishedGoods(loadedSettingsFGs);
          setRecipes(loadedRecipes);
          setProductionPlans(loadedPlans);
          // Exclude HQ itself from location picker — HQ reviews store locations
          setLocations((loadedLocations as any[]).filter((l: any) => l.id !== "LOC-HQ"));
          
          // Check clean-slate architecture boundary
          const liveStockTotal = loadedInventory.reduce((acc: number, item: any) => acc + ((item.inStock || 0) * (item.cost || 0)), 0);
          if (liveStockTotal === 0 && loadedOrders.length === 0) {
            setDynamicUsageData([
              { name: 'Mon', actual: 0, theoretical: 0 },
              { name: 'Tue', actual: 0, theoretical: 0 },
              { name: 'Wed', actual: 0, theoretical: 0 },
              { name: 'Thu', actual: 0, theoretical: 0 },
              { name: 'Fri', actual: 0, theoretical: 0 },
              { name: 'Sat', actual: 0, theoretical: 0 },
              { name: 'Sun', actual: 0, theoretical: 0 },
            ]);
          } else {
            setDynamicUsageData(usageData);
          }
       } catch (err) {
          console.error(err);
       } finally {
          setIsLoading(false);
       }
    }
    
    fetchData();
  }, []);

  if (isLoading) {
     return <div className="animate-pulse flex items-center justify-center p-12 text-sm text-neutral-400">Loading Dashboard Context...</div>;
  }

  const lowStockItems = inventoryItems.filter(item => item.inStock < item.parLevel);
  const recentOrdersRender = orders.slice(0, 4);
  const totalInventoryValue = inventoryItems.reduce((acc, item) => acc + ((item.inStock || 0) * (item.cost || 0)), 0);
  const isCleanSlate = totalInventoryValue === 0 && orders.length === 0;

  const handleAddToPO = (item: any) => {
    const suggestedReq = item.parLevel - item.inStock;
    const qty = suggestedReq > 0 ? suggestedReq : 1;
    
    // Find if supplier already has a Draft PO
    const existingDraftIdx = orders.findIndex(o => o.status === "Draft" && o.supplier === item.supplier);
    
    let newOrders = [...orders];
    
    if (existingDraftIdx > -1) {
       // Append to existing draft
       const currentDraft = newOrders[existingDraftIdx];
       // Check if item already exists in line items
       const exists = currentDraft.lineItems?.find((li: any) => li.id === item.id);
       if (!exists) {
         currentDraft.lineItems = [...(currentDraft.lineItems || []), { ...item, qty, expectedPrice: item.cost }];
         currentDraft.items = currentDraft.lineItems.length;
         currentDraft.total += (item.cost * qty);
       }
    } else {
       // Create new draft natively
       const newOrder = {
        id: `PO-${1050 + orders.length}`,
        supplier: item.supplier || "System Vendor",
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        deliveryDate: "Pending",
        items: 1,
        lineItems: [{ ...item, qty, expectedPrice: item.cost }],
        total: item.cost * qty,
        status: "Draft",
        location: "HQ (System)",
        notes: "Auto-generated from Low Stock Alerts for " + item.name,
        createdBy: "Auto-System",
        receivedBy: null,
        receivedAt: null
      };
      newOrders = [newOrder, ...newOrders];
    }
    
    saveOrders(newOrders);
    router.push('/orders'); // Immediately kick them softly to the orders manager
  };

  const handleOpenBulkGenerate = () => {
    const groupings: Record<string, any[]> = {};
    lowStockItems.forEach(item => {
      const supplier = item.supplier || "System Vendor";
      if (!groupings[supplier]) groupings[supplier] = [];
      const suggestedReq = item.parLevel - item.inStock;
      const qty = suggestedReq > 0 ? suggestedReq : 1;
      groupings[supplier].push({ ...item, qty, expectedPrice: item.cost });
    });
    setBulkDrafts(groupings);
    setIsBulkGenDrawerOpen(true);
  };

  const updateBulkDraftQty = (supplier: string, itemId: number, newQty: number) => {
    setBulkDrafts(prev => {
      const updated = { ...prev };
      updated[supplier] = updated[supplier].map(i => i.id === itemId ? { ...i, qty: newQty } : i);
      return updated;
    });
  };

  const confirmBulkGenerate = () => {
    let newOrders = [...orders];
    
    Object.entries(bulkDrafts).forEach(([supplier, items]) => {
      // Filter out zero quantities
      const validItems = items.filter(i => i.qty > 0);
      if (validItems.length === 0) return;
      
      const existingDraftIdx = newOrders.findIndex(o => o.status === "Draft" && o.supplier === supplier);
      if (existingDraftIdx > -1) {
         // Append to existing
         const currentDraft = newOrders[existingDraftIdx];
         validItems.forEach(item => {
           const exists = currentDraft.lineItems?.find((li: any) => li.id === item.id);
           if (!exists) {
             currentDraft.lineItems = [...(currentDraft.lineItems || []), item];
           } else {
             exists.qty = item.qty; // Overwrite
           }
         });
         currentDraft.items = currentDraft.lineItems.length;
         currentDraft.total = currentDraft.lineItems.reduce((sum: number, i: any) => sum + (i.expectedPrice * i.qty), 0);
      } else {
         // Create New
         const supplierTotal = validItems.reduce((sum, item) => sum + (item.expectedPrice * item.qty), 0);
         const newOrder = {
          id: `PO-${1050 + newOrders.length}`,
          supplier: supplier,
          date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          deliveryDate: "Pending",
          items: validItems.length,
          lineItems: validItems,
          total: supplierTotal,
          status: "Draft",
          location: "HQ (System)",
          notes: "Auto-generated from Low Stock Alerts",
          createdBy: "Auto-System",
          receivedBy: null,
          receivedAt: null
        };
        newOrders = [newOrder, ...newOrders];
      }
    });

    saveOrders(newOrders);
    setIsBulkGenDrawerOpen(false);
    router.push('/orders');
  };

  const generateSmartSuggestions = () => {
    const suggestions: any[] = [];
    
    // 1. Auto PO Suggestions (Low Stock + No Open PO)
    const lowStockRawItems = inventoryItems.filter(item => item.inStock < item.parLevel);
    const itemsWithoutPO = lowStockRawItems.filter(item => {
      return !orders.some(o => o.status !== "Delivered" && o.lineItems?.some((li:any) => li.id === item.id));
    });

    if (itemsWithoutPO.length > 0) {
      suggestions.push({
        id: 'auto-po',
        type: 'Procurement',
        title: `You should reorder ${itemsWithoutPO.length} item${itemsWithoutPO.length > 1 ? 's' : ''}`,
        desc: `Several raw ingredients have dropped below par levels with no open purchase orders. Generating a draft PO will automatically map these items to their optimal verified suppliers based on historical tracking.`,
        actionText: 'Generate Drafts',
        onClick: () => handleOpenBulkGenerate(),
        icon: <ShoppingCart className="h-4 w-4" />
      });
    }

    // 2. Production Suggestions (HQ)
    const pendingRequisitions = requisitions.filter(r => r.status === "Submitted" || r.status === "Approved" || r.status === "Partial");
    const backorders: Record<string, number> = {};
    pendingRequisitions.forEach(req => {
       req.lineItems.forEach((li: any) => {
          const shortage = li.requestedQty - (li.fulfilledQty || 0);
          if (shortage > 0) {
             backorders[li.id] = (backorders[li.id] || 0) + shortage;
          }
       });
    });

    Object.entries(backorders).forEach(([fgId, backorderedQty]) => {
       const fg = finishedGoods.find(f => f.id === fgId);
       if (!fg) return;
       
       if (fg.currentStock < backorderedQty) {
          const productionNeeded = backorderedQty - fg.currentStock;
          const recipe = recipes.find(r => r.id === fg.recipeId);
          
          let maxProducible = Infinity;
          if (recipe) {
             recipe.ingredients.forEach((ing: any) => {
                const rawItem = findInventoryItem(inventoryItems, ing.inventoryId);
                if (rawItem) {
                   const batchesPossible = rawItem.inStock / ing.qty; 
                   const possibleYield = batchesPossible * recipe.yieldQty;
                   if (possibleYield < maxProducible) maxProducible = possibleYield;
                } else {
                   maxProducible = 0;
                }
             });
          }
          
          let maxInt = Math.floor(maxProducible);
          if (maxProducible === Infinity) maxInt = 0;
          
          const rawInsufficient = maxInt < productionNeeded;
          
          suggestions.push({
             id: `prod-${fgId}`, 
             type: 'Production',
             title: `Production Action: ${fg.name}`,
             desc: rawInsufficient 
                ? `Backordered: ${backorderedQty} ${fg.unit} | Current Stock: ${fg.currentStock} ${fg.unit}. You need to produce ${productionNeeded} ${fg.unit}, but raw materials limit max production to ${maxInt} ${fg.unit}. Order raw goods to cover the gap.`
                : `Backordered: ${backorderedQty} ${fg.unit} | Current Stock: ${fg.currentStock} ${fg.unit}. Produce a fresh batch of ${productionNeeded} ${fg.unit} to fulfill immediate location deficits natively.`,
             actionText: rawInsufficient ? 'Review Shortage' : 'Produce Batch',
             onClick: () => router.push('/finished-goods'),
             icon: <ClipboardCheck className="h-4 w-4" />
          });
       }
    });

    return suggestions;
  };

  const generateSystemAlerts = () => {
     const alerts: any[] = [];
     
     // 1. High Variance Logic
     const totalActual = usageData.reduce((sum, d) => sum + d.actual, 0);
     const totalTheo = usageData.reduce((sum, d) => sum + d.theoretical, 0);
     const formattedDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

     if (totalTheo > 0) {
        const varPct = ((totalActual - totalTheo) / totalTheo) * 100;
        if (varPct > 10) {
           alerts.push({ id: 'var-1', type: 'High Variance Critical', title: 'Global Usage Variance Critical', desc: `Actual usage is +${varPct.toFixed(1)}% above theoretical constraints globally.`, severity: 'Critical', group: 'inventory', date: `Detected Today (${formattedDate})` });
        } else if (varPct > 5) {
           alerts.push({ id: 'var-2', type: 'High Variance Warning', title: 'Estimated Usage Variance Warning', desc: `Actual usage is +${varPct.toFixed(1)}% above theoretical bounds.`, severity: 'Warning', group: 'inventory', date: `Detected Today (${formattedDate})` });
        }
     }

     // 2. Low Stock Risk (stock < par && no open PO)
     inventoryItems.forEach(item => {
        if (item.inStock < item.parLevel) {
           const hasOpenPO = orders.some(o => o.status !== "Delivered" && o.lineItems?.some((li:any) => li.id === item.id));
           if (!hasOpenPO) {
              alerts.push({ id: `stock-${item.id}`, type: 'Stock Risk', title: `Urgent Reorder: ${item.name}`, desc: `Stock is below par (${item.inStock}/${item.parLevel}) with 0 open orders natively tracking this item.`, severity: 'Critical', group: 'stock', actionLink: '/inventory', date: `Detected Today (${formattedDate})` });
           }
        }
     });

     // 3. Price Increase Alerts
     const deliveredOrders = orders.filter(o => o.status === "Delivered" || o.status === "Sent").sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime());
     
     const itemPriceHistory: Record<string, any[]> = {};
     [...deliveredOrders].reverse().forEach(o => { 
        o.lineItems?.forEach((li: any) => {
           const price = li.actualPrice || li.expectedPrice || li.cost;
           const key = `${o.supplierId}-${li.id}`;
           if (!itemPriceHistory[key]) itemPriceHistory[key] = [];
           itemPriceHistory[key].unshift({price, date: o.date, name: li.name, po: o.id, supplierId: o.supplierId}); 
        });
     });

     Object.keys(itemPriceHistory).forEach(key => {
        const hist = itemPriceHistory[key];
        if (hist.length >= 2) {
           const latest = hist[0];
           const prev = hist[1];
           if (prev.price > 0 && latest.price > prev.price) {
              const jump = ((latest.price - prev.price) / prev.price) * 100;
              if (jump > 10) {
                 alerts.push({ id: `price-${key}`, type: 'Price Surge', title: `Critical Price Jump: ${latest.name}`, desc: `Item cost jumped +${jump.toFixed(1)}% on ${latest.po} globally.`, severity: 'Critical', group: 'price', oldPrice: prev.price, newPrice: latest.price, poId: latest.po, supplierId: latest.supplierId, date: `Triggered by ${latest.po} (${latest.date})` });
              } else if (jump > 5) {
                 alerts.push({ id: `price-${key}`, type: 'Price Increase', title: `Price Increase Warning: ${latest.name}`, desc: `Item cost consistently rose +${jump.toFixed(1)}% on ${latest.po}.`, severity: 'Warning', group: 'price', oldPrice: prev.price, newPrice: latest.price, poId: latest.po, supplierId: latest.supplierId, date: `Triggered by ${latest.po} (${latest.date})` });
              }
           }
        }
     });

     // 4. Supplier Risk Alerts (Live tracking)
     const currentDate = new Date();
     suppliersData.forEach(s => {
       const suppOrders = orders.filter(o => o.supplierId === s.id && o.status !== "Draft");
       const sortedOrders = [...suppOrders].sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime());
       
       let priceVariancePct = 0;
       const daysSinceLastOrder = sortedOrders.length > 0 ? Math.floor((currentDate.getTime() - new Date(sortedOrders[0].date).getTime()) / (1000 * 3600 * 24)) : Infinity;
       
       if (sortedOrders.length >= 2) {
         const latestPO = sortedOrders[0];
         const recentPOs = sortedOrders.slice(1, Math.min(6, sortedOrders.length));
         const avgLatestItemCost = latestPO.items > 0 ? (latestPO.total / latestPO.items) : 0;
         const avgRecentItemCost = recentPOs.reduce((sum, o) => sum + (o.items > 0 ? o.total/o.items : 0), 0) / recentPOs.length;
         if (avgRecentItemCost > 0) {
            priceVariancePct = ((avgLatestItemCost - avgRecentItemCost) / avgRecentItemCost) * 100;
         }
       }
       
       if (s.status !== 'Auto-created') {
         if (daysSinceLastOrder > 45 || priceVariancePct > 10) {
            alerts.push({ id: `supp-${s.id}`, type: 'Supplier Risk', title: `Vendor At Risk: ${s.name}`, desc: daysSinceLastOrder > 45 ? `No active orders placed natively in ${daysSinceLastOrder} days.` : `Vendor aggregated cost variance surged (+${priceVariancePct.toFixed(1)}%).`, severity: 'Critical', group: 'supplier', actionLink: '/suppliers', supplierId: s.id, date: `Detected Today (${formattedDate})` });
         } else if ((daysSinceLastOrder >= 30 && daysSinceLastOrder <= 45) || (priceVariancePct >= 5 && priceVariancePct <= 10)) {
            alerts.push({ id: `supp-${s.id}`, type: 'Supplier Warning', title: `Vendor Warning: ${s.name}`, desc: daysSinceLastOrder >= 30 ? `Latency boundary crossed (${daysSinceLastOrder} days latency).` : `Rising historical cost thresholds (+${priceVariancePct.toFixed(1)}%).`, severity: 'Warning', group: 'supplier', actionLink: '/suppliers', supplierId: s.id, date: `Detected Today (${formattedDate})` });
         }
       }
     });

     return alerts.sort((a, b) => {
        if (a.severity === 'Critical' && b.severity !== 'Critical') return -1;
        if (a.severity !== 'Critical' && b.severity === 'Critical') return 1;
        return 0; // Maintain insertion if same severity
     });
  };

  const dashboardAlerts = generateSystemAlerts();
  const smartSuggestions = generateSmartSuggestions();

  return (
    <div className="space-y-8">
      {/* Smart Action Center (Phase 8) */}
      {smartSuggestions.length > 0 && (
        <div className="bg-brand-50 border border-brand-200 rounded-xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
             <div className="p-1.5 bg-brand-600 text-white rounded-md">
                <Box className="h-4 w-4" />
             </div>
             <h3 className="text-lg font-bold text-brand-900">Smart Action Center</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {smartSuggestions.map(suggestion => (
              <div key={suggestion.id} className="bg-white rounded-lg border border-brand-100 p-4 shadow-sm flex flex-col justify-between">
                 <div>
                    <div className="flex items-center gap-2 mb-2">
                       <span className="text-[10px] uppercase tracking-wider font-bold text-brand-500 bg-brand-50 px-2 py-0.5 rounded-full">{suggestion.type}</span>
                    </div>
                    <h4 className="text-sm font-semibold text-neutral-900 mb-1">{suggestion.title}</h4>
                    <p className="text-xs text-neutral-500 leading-relaxed mb-4">{suggestion.desc}</p>
                 </div>
                 <button 
                   onClick={suggestion.onClick}
                   className="w-full bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold py-2 rounded-md transition-colors"
                 >
                   {suggestion.actionText}
                 </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* HQ Approvals Widget */}
      {(productionPlans.filter(p => p.status.includes("Draft") || p.status.includes("Pending")).length > 0 || orders.filter(o => o.status === "Draft (Auto)" || o.status === "Pending Approval").length > 0) && (
        <Card className="shadow-sm border-brand-200 bg-brand-50/50">
          <CardContent className="p-4 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
             <div className="flex items-start gap-4">
               <div className="p-2 bg-brand-600 text-white rounded-lg shadow-sm">
                  <CheckSquare className="h-6 w-6" />
               </div>
               <div>
                 <h3 className="text-lg font-bold text-neutral-900 tracking-tight">HQ Approvals Required</h3>
                 <p className="text-sm text-neutral-500">
                    You have <strong className="text-brand-700">{productionPlans.filter(p => p.status.includes("Draft") || p.status.includes("Pending")).length + orders.filter(o => o.status === "Draft (Auto)" || o.status === "Pending Approval").length} items</strong> generated by the automation engine awaiting your authorization.
                 </p>
                 <div className="mt-2 flex flex-wrap gap-2">
                    { [
                        ...productionPlans.filter(p => p.status.includes("Draft") || p.status.includes("Pending")).map(p => ({ title: `Production: ${p.fgName}`, id: p.id })),
                        ...orders.filter(o => o.status === "Draft (Auto)" || o.status === "Pending Approval").map(o => ({ title: `Auto-PO ${o.id}`, id: o.id }))
                      ].slice(0, 3).map(item => (
                       <Badge key={item.id} variant="neutral" className="bg-white border-brand-200 text-brand-700 text-xs">
                         {item.title}
                       </Badge>
                    ))}
                    { (productionPlans.filter(p => p.status.includes("Draft") || p.status.includes("Pending")).length + orders.filter(o => o.status === "Draft (Auto)" || o.status === "Pending Approval").length) > 3 && (
                       <span className="text-xs text-neutral-400 font-medium self-centerml-1">and more...</span>
                    )}
                 </div>
               </div>
             </div>
             <button 
               onClick={() => router.push('/approvals')}
               className="whitespace-nowrap px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white font-medium rounded-lg shadow-sm transition-colors text-sm w-full sm:w-auto text-center"
             >
               View All Approvals
             </button>
          </CardContent>
        </Card>
      )}

      {/* HQ Cross-Location Review — HQ admin only */}
      {isHQAdmin && (
        <Card className="shadow-sm border-indigo-100 bg-indigo-50/30">
          <CardHeader className="border-b border-indigo-100 pb-4">
            <CardTitle className="text-base text-neutral-800">Cross-Location Review</CardTitle>
          </CardHeader>
          <CardContent className="p-5">
            <HQLocationReview locations={locations} />
          </CardContent>
        </Card>
      )}

      {/* Exec Metrics Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="border-l-4 border-l-brand-500 shadow-sm">
          <CardContent className="p-5">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-sm font-medium text-neutral-500">Total Inventory Value</p>
                <p className="text-2xl font-bold text-neutral-900">${totalInventoryValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
              </div>
              <div className="p-2 bg-brand-50 text-brand-600 rounded-md">
                <DollarSign className="h-5 w-5" />
              </div>
            </div>
            <div className="mt-4 flex items-center text-sm">
              {isCleanSlate ? (
                 <span className="text-neutral-400 font-medium">Opening Balance</span>
              ) : (
                <>
                  <span className="text-success-600 flex items-center font-medium">
                    <TrendingUp className="h-4 w-4 mr-1" />
                    +2.4%
                  </span>
                  <span className="text-neutral-400 ml-2">from last month</span>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-danger-500 shadow-sm">
          <CardContent className="p-5">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-sm font-medium text-neutral-500">Logged Variance</p>
                <p className={`text-2xl font-bold ${counts.reduce((s,c) => s+(c.totalVarianceValue||0),0) < 0 ? 'text-danger-600' : 'text-neutral-900'}`}>
                  ${Math.abs(counts.reduce((sum,c) => sum + (c.totalVarianceValue || 0), 0)).toFixed(2)}
                </p>
              </div>
              <div className="p-2 bg-danger-50 text-danger-600 rounded-md">
                <Trash2 className="h-5 w-5" />
              </div>
            </div>
            <div className="mt-4 flex items-center text-sm">
              <span className="text-neutral-500 font-medium tracking-tight">
                Net value impact from recent logs.
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardContent className="p-5">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-sm font-medium text-neutral-500">Active Counts</p>
                <div className="flex items-end gap-2">
                  <p className="text-2xl font-bold text-neutral-900">{counts.filter(c => c.status !== 'Approved').length}</p>
                </div>
              </div>
              <div className="p-2 bg-neutral-100 text-neutral-600 rounded-md">
                <ClipboardCheck className="h-5 w-5" />
              </div>
            </div>
            <div className="mt-4 w-full bg-neutral-100 rounded-full h-2 mb-1 overflow-hidden">
               {counts.length > 0 && <div className="bg-success-500 h-2 rounded-full" style={{ width: `${(counts.filter(c => c.status === 'Approved').length / counts.length) * 100}%` }}></div>}
            </div>
            <p className="text-xs text-neutral-500">{counts.filter(c => c.status === 'Submitted').length} sessions pending review</p>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardContent className="p-5">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <p className="text-sm font-medium text-neutral-500">CoGS (7 Days)</p>
                <p className="text-2xl font-bold text-neutral-900">{isCleanSlate ? "0.0%" : "28.4%"}</p>
              </div>
              <div className="p-2 bg-warning-50 text-warning-600 rounded-md">
                <TrendingDown className="h-5 w-5" />
              </div>
            </div>
            <div className="mt-4 flex items-center text-sm">
              {isCleanSlate ? (
                <span className="text-neutral-400 font-medium">Insufficient Operational Data</span>
              ) : (
                <>
                  <span className="text-success-600 flex items-center font-medium">
                    <TrendingDown className="h-4 w-4 mr-1" />
                    -0.5%
                  </span>
                  <span className="text-neutral-400 ml-2">vs theoretical (28.9%)</span>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Chart */}
        <Card className="col-span-1 lg:col-span-2 shadow-sm">
          <CardHeader className="border-b border-neutral-100 pb-4">
            <CardTitle className="text-lg">Theoretical vs Actual Usage</CardTitle>
            <CardDescription>Value of inventory consumed across all locations over the last 7 days</CardDescription>
          </CardHeader>
          <CardContent className="pt-6 h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dynamicUsageData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E5E5" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#737373', fontSize: 12}} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: '#737373', fontSize: 12}} dx={-10} tickFormatter={(value) => `$${value}`} />
                <RechartsTooltip 
                  contentStyle={{ borderRadius: '8px', border: '1px solid #E5E5E5', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Line type="monotone" dataKey="actual" stroke="#171717" strokeWidth={2} dot={{r: 4}} activeDot={{r: 6}} name="Actual Usage" />
                <Line type="monotone" dataKey="theoretical" stroke="#3b82f6" strokeWidth={2} strokeDasharray="5 5" dot={false} activeDot={{r: 6}} name="Theoretical" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Alerts & Widgets */}
        <div className="space-y-6">
          <Card className="shadow-sm border-neutral-200">
            <CardHeader className="border-b border-neutral-100 pb-4 flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                 <AlertCircle className="h-4 w-4 text-neutral-500" />
                 Central Alert Engine
              </CardTitle>
              {dashboardAlerts.length > 0 && <Badge variant="danger" className="rounded-md px-2 py-0.5">{dashboardAlerts.length} Active</Badge>}
            </CardHeader>
            <CardContent className="p-0 overflow-hidden max-h-[500px] overflow-y-auto">
              {dashboardAlerts.length === 0 ? (
                 <div className="p-6 text-center text-sm text-neutral-500">System architecture tracks purely optimal thresholds currently.</div>
              ) : (
                <div className="divide-y divide-neutral-100">
                  {dashboardAlerts.map(alert => (
                    <div key={alert.id} className="p-4 flex gap-3 hover:bg-neutral-50 transition-colors">
                      <div className={`mt-0.5 p-1.5 rounded-md shrink-0 h-fit ${alert.severity === 'Critical' ? 'bg-danger-50 text-danger-600' : 'bg-warning-50 text-warning-600'}`}>
                        {alert.group === 'supplier' ? <ShoppingCart className="h-4 w-4" /> : 
                         alert.group === 'stock' ? <PackageX className="h-4 w-4" /> :
                         alert.group === 'price' ? <DollarSign className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start w-full">
                           <h4 className="text-sm font-semibold text-neutral-900 truncate pr-2">{alert.title}</h4>
                           <span className={`text-[10px] uppercase font-bold tracking-wider shrink-0 ${alert.severity === 'Critical' ? 'text-danger-600' : 'text-warning-600'}`}>{alert.severity}</span>
                        </div>
                        <p className="text-xs text-neutral-500 mt-0.5 leading-relaxed">{alert.desc}</p>
                        
                        {(alert.oldPrice !== undefined && alert.newPrice !== undefined) && (
                           <div className="flex items-center gap-2 mt-2 bg-white border border-neutral-200 rounded p-1.5 w-fit shadow-sm">
                              <span className="text-[10px] text-neutral-500 font-medium line-through">${alert.oldPrice.toFixed(2)}</span>
                              <ArrowRight className="h-3 w-3 text-neutral-400" />
                              <span className="text-xs text-danger-600 font-bold">${alert.newPrice.toFixed(2)}</span>
                           </div>
                        )}
                        
                        <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
                           <span className="text-[10px] text-neutral-400 font-medium flex items-center gap-1">
                              <Clock className="h-3 w-3" /> {alert.date}
                           </span>
                           <div className="flex items-center gap-2">
                              {alert.poId && (
                                 <button 
                                   onClick={() => router.push(`/orders?openDraft=${alert.poId}`)} 
                                   className="px-2 py-1 text-[10px] font-medium bg-white border border-neutral-200 text-neutral-700 rounded hover:bg-neutral-100 transition-colors shadow-sm"
                                 >
                                    View PO
                                 </button>
                              )}
                              {alert.supplierId && (
                                 <button 
                                   onClick={() => router.push(`/suppliers?id=${alert.supplierId}`)} 
                                   className="px-2 py-1 text-[10px] font-medium bg-white border border-neutral-200 text-neutral-700 rounded hover:bg-neutral-100 transition-colors shadow-sm"
                                 >
                                    View Vendor
                                 </button>
                              )}
                              {(!alert.poId && !alert.supplierId && alert.actionLink) && (
                                 <button 
                                   onClick={() => router.push(alert.actionLink)} 
                                   className="px-2 py-1 text-[10px] font-medium bg-white border border-neutral-200 text-neutral-700 rounded hover:bg-neutral-100 transition-colors shadow-sm"
                                 >
                                    Resolve
                                 </button>
                              )}
                           </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="border-b border-neutral-100 pb-4 flex flex-row items-center justify-between">
              <CardTitle className="text-base">Recent Purchase Orders</CardTitle>
              <button className="text-brand-600 hover:text-brand-700 text-sm font-medium">View All</button>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-neutral-100">
                {recentOrdersRender.length > 0 ? recentOrdersRender.map((order) => (
                  <div key={order.id} onClick={() => router.push('/orders')} className="p-4 flex items-center justify-between hover:bg-neutral-50 transition-colors cursor-pointer">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-neutral-100 rounded-md shrink-0">
                        <FileText className="h-4 w-4 text-neutral-600" />
                      </div>
                      <div>
                        <h4 className="text-sm font-semibold text-neutral-900">{order.supplier}</h4>
                        <div className="flex items-center text-xs text-neutral-500 mt-0.5 gap-2">
                          <span>{order.id}</span>
                          <span>•</span>
                          <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{order.date}</span>
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-neutral-900">${order.total.toFixed(2)}</p>
                      <Badge variant={order.status === 'Delivered' ? 'success' : order.status === 'Sent' ? 'default' : 'warning'} className="text-[10px] mt-1 px-1.5 py-0 h-4">
                        {order.status}
                      </Badge>
                    </div>
                  </div>
                )) : (
                  <div className="p-4 text-sm text-neutral-500 text-center">No recent orders synced.</div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Low Stock Table */}
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between border-b border-neutral-100 pb-4">
          <div>
            <CardTitle className="text-base">Low Stock Action Center</CardTitle>
            <CardDescription className="mt-1">Items below par requiring immediate reorder.</CardDescription>
          </div>
          <button 
            onClick={handleOpenBulkGenerate}
            disabled={lowStockItems.length === 0}
            className="flex items-center gap-2 px-3 py-1.5 bg-brand-600 text-white text-sm font-medium rounded-md hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            Auto-Generate POs
            <ArrowRight className="h-4 w-4" />
          </button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/50">
              <TableRow>
                <TableHead className="font-medium text-neutral-700">Item Name</TableHead>
                <TableHead className="font-medium text-neutral-700">Status</TableHead>
                <TableHead className="font-medium text-neutral-700">Current Stock</TableHead>
                <TableHead className="font-medium text-neutral-700">Par Level</TableHead>
                <TableHead className="font-medium text-neutral-700">Suggested Reorder</TableHead>
                <TableHead className="text-right font-medium text-neutral-700">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lowStockItems.length > 0 ? (
                lowStockItems.map((item) => {
                  const stockRatio = item.inStock / item.parLevel;
                  const isCritical = stockRatio < 0.3;
                  const suggestedReorder = item.parLevel - item.inStock;
                  
                  return (
                    <TableRow key={item.id} className="hover:bg-neutral-50/50 transition-colors">
                      <TableCell className="font-medium text-neutral-900">{item.name}</TableCell>
                      <TableCell>
                        <Badge variant={item.inStock === 0 ? 'danger' : isCritical ? 'danger' : 'warning'} className="px-2">
                          {item.inStock === 0 ? "Out of Stock" : isCritical ? "Critical" : "Low"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-neutral-500 font-medium">{item.inStock} {item.unit}</TableCell>
                      <TableCell className="text-neutral-500">{item.parLevel} {item.unit}</TableCell>
                      <TableCell className="font-medium text-warning-600">{suggestedReorder} {item.unit}</TableCell>
                      <TableCell className="text-right">
                        <button 
                          onClick={() => handleAddToPO(item)}
                          className="px-3 py-1 bg-white border border-neutral-200 text-neutral-700 text-sm font-medium rounded-md hover:bg-brand-50 hover:text-brand-700 hover:border-brand-200 transition-colors shadow-sm inline-flex items-center gap-1.5"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add to PO
                        </button>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-6 text-sm text-neutral-500">
                    All inventory items are fully stocked above par.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Bulk Generate Preview Drawer */}
      <Drawer
        isOpen={isBulkGenDrawerOpen}
        onClose={() => setIsBulkGenDrawerOpen(false)}
        title="Auto-Generate Draft POs"
        description="Review and adjust quantities before creating supplier drafts."
        footer={
          <div className="w-full flex items-center justify-between">
            <button 
              className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors"
              onClick={() => setIsBulkGenDrawerOpen(false)}
            >
              Cancel
            </button>
            <button 
              className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm flex items-center gap-2"
              onClick={confirmBulkGenerate}
            >
              <ShoppingCart className="h-4 w-4" />
              Confirm & Create Drafts
            </button>
          </div>
        }
      >
        <div className="space-y-6">
          {Object.entries(bulkDrafts).length > 0 ? (
            Object.entries(bulkDrafts).map(([supplier, items]) => {
              const supplierTotal = items.reduce((sum, i) => sum + (i.expectedPrice * i.qty), 0);
              return (
                <div key={supplier} className="border border-neutral-200 rounded-lg overflow-hidden bg-white shadow-sm">
                  <div className="bg-neutral-50/80 p-3 border-b border-neutral-200 flex justify-between items-center">
                    <h3 className="font-semibold text-brand-900 text-sm">{supplier}</h3>
                    <div className="text-sm font-medium text-neutral-600">
                      {items.length} Item{items.length !== 1 ? 's' : ''} • ${supplierTotal.toFixed(2)}
                    </div>
                  </div>
                  <Table>
                    <TableHeader className="bg-white text-[10px] text-neutral-500 uppercase tracking-wider">
                      <TableRow>
                        <TableHead className="py-2">Item</TableHead>
                        <TableHead className="py-2">Gap</TableHead>
                        <TableHead className="py-2 w-[100px]">Draft Qty</TableHead>
                        <TableHead className="py-2 text-right">Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item) => (
                        <TableRow key={item.id} className="hover:bg-neutral-50/50">
                          <TableCell className="py-2">
                             <div className="font-medium text-xs text-neutral-900">{item.name}</div>
                             <div className="text-[10px] text-neutral-500">{item.unit}</div>
                          </TableCell>
                          <TableCell className="py-2 text-xs text-warning-600 font-medium">
                            {item.parLevel - item.inStock > 0 ? item.parLevel - item.inStock : 0}
                          </TableCell>
                          <TableCell className="py-2">
                            <input 
                              type="number" 
                              min="0"
                              className="w-[70px] border border-neutral-300 rounded p-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
                              value={item.qty}
                              onChange={(e) => updateBulkDraftQty(supplier, item.id, parseInt(e.target.value) || 0)}
                            />
                          </TableCell>
                          <TableCell className="py-2 text-right text-xs font-medium text-neutral-700">
                            ${(item.expectedPrice * item.qty).toFixed(2)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              );
            })
          ) : (
             <div className="text-center py-10 text-neutral-500 text-sm">
               No low stock items available to generate.
             </div>
          )}
        </div>
      </Drawer>
    </div>
  );
}
