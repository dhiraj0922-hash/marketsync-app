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
  Boxes,
  CalendarDays,
  CircleGauge,
  Layers3,
  Sparkles,
} from "lucide-react";
import { 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip, 
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
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

function DashboardMetricCard({
  label,
  value,
  helper,
  icon: Icon,
  tone = "brand",
  trend,
}: {
  label: string;
  value: React.ReactNode;
  helper: React.ReactNode;
  icon: React.ElementType;
  tone?: "brand" | "danger" | "success" | "warning" | "neutral";
  trend?: React.ReactNode;
}) {
  const toneMap = {
    brand: "bg-blue-500 text-white shadow-blue-500/25",
    danger: "bg-red-500 text-white shadow-red-500/25",
    success: "bg-emerald-500 text-white shadow-emerald-500/25",
    warning: "bg-violet-500 text-white shadow-violet-500/25",
    neutral: "bg-amber-500 text-white shadow-amber-500/25",
  };

  return (
    <Card className="rounded-xl border-white/10 bg-[#151515] shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">{label}</p>
            <div className="mt-3 text-2xl font-semibold tracking-tight text-white">{value}</div>
          </div>
          <div className={`rounded-lg p-2.5 shadow-lg ${toneMap[tone]}`}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-4 flex min-h-5 items-center justify-between gap-2 text-xs text-zinc-500">
          <span className="truncate">{helper}</span>
          {trend && <span className="shrink-0 font-semibold">{trend}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

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
  const varianceTotal = counts.reduce((sum, c) => sum + (c.totalVarianceValue || 0), 0);
  const activeCounts = counts.filter(c => c.status !== 'Approved').length;
  const approvedCounts = counts.filter(c => c.status === 'Approved').length;
  const pendingCounts = counts.filter(c => c.status === 'Submitted').length;
  const inventoryCategoryData = Object.entries(
    inventoryItems.reduce((acc: Record<string, number>, item: any) => {
      const category = item.category || "Uncategorised";
      acc[category] = (acc[category] || 0) + ((item.inStock || 0) * (item.cost || 0));
      return acc;
    }, {})
  )
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const topCategoryTotal = inventoryCategoryData.reduce((sum, item) => sum + item.value, 0) || 1;
  const topLowStock = lowStockItems.slice(0, 5);
  const categoryColors = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#a855f7"];
  const alertPreview = dashboardAlerts.slice(0, 4);
  const approvalCount = productionPlans.filter(p => p.status.includes("Draft") || p.status.includes("Pending")).length + orders.filter(o => o.status === "Draft (Auto)" || o.status === "Pending Approval").length;

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
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-500">Dashboard</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">StockIQ Overview</h1>
          <p className="mt-1 text-sm text-zinc-500">Real-time inventory health, purchasing activity, and variance signals.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-[#141414] px-3 py-2 text-xs font-medium text-zinc-300">
            <CalendarDays className="h-3.5 w-3.5 text-zinc-500" />
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          </span>
          <button
            onClick={handleOpenBulkGenerate}
            disabled={lowStockItems.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white shadow-lg shadow-blue-600/20 transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Generate Drafts
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        <DashboardMetricCard
          label="Inventory Value"
          value={`$${totalInventoryValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}
          helper={isCleanSlate ? "Opening balance" : "Across active inventory"}
          icon={DollarSign}
          tone="brand"
          trend={!isCleanSlate && <span className="inline-flex items-center gap-1 text-emerald-400"><TrendingUp className="h-3.5 w-3.5" />+2.4%</span>}
        />
        <DashboardMetricCard
          label="Logged Variance"
          value={<span className={varianceTotal < 0 ? 'text-red-400' : 'text-white'}>${Math.abs(varianceTotal).toFixed(2)}</span>}
          helper="Net value impact from counts"
          icon={Trash2}
          tone="danger"
        />
        <DashboardMetricCard
          label="Active Counts"
          value={activeCounts}
          helper={`${pendingCounts} sessions pending review`}
          icon={ClipboardCheck}
          tone="neutral"
          trend={counts.length > 0 && <span className="text-emerald-400">{Math.round((approvedCounts / counts.length) * 100)}% approved</span>}
        />
        <DashboardMetricCard
          label="CoGS (7 Days)"
          value={isCleanSlate ? "0.0%" : "28.4%"}
          helper={isCleanSlate ? "Insufficient operational data" : "vs theoretical 28.9%"}
          icon={CircleGauge}
          tone="warning"
          trend={!isCleanSlate && <span className="inline-flex items-center gap-1 text-red-400"><TrendingDown className="h-3.5 w-3.5" />-0.5%</span>}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-12">
        <Card className="rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.32)] md:col-span-8">
          <CardHeader className="border-b border-white/5 pb-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base text-white">Inventory Usage Trend</CardTitle>
                <CardDescription className="mt-1 text-zinc-500">Theoretical vs actual consumption over the last 7 days</CardDescription>
              </div>
              <div className="hidden items-center gap-3 text-xs text-zinc-500 sm:flex">
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-blue-500" />Actual</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" />Theoretical</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-6 h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dynamicUsageData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#262626" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#71717a', fontSize: 12}} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: '#71717a', fontSize: 12}} dx={-10} tickFormatter={(value) => `$${value}`} />
                <RechartsTooltip 
                  contentStyle={{ borderRadius: '10px', border: '1px solid #27272a', background: '#111', color: '#fafafa', boxShadow: '0 18px 50px rgb(0 0 0 / 0.35)' }}
                />
                <Line type="monotone" dataKey="actual" stroke="#3b82f6" strokeWidth={2.5} dot={{r: 3, fill: "#3b82f6"}} activeDot={{r: 6}} name="Actual Usage" />
                <Line type="monotone" dataKey="theoretical" stroke="#22c55e" strokeWidth={2.5} strokeDasharray="5 5" dot={false} activeDot={{r: 6}} name="Theoretical" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.32)] md:col-span-4">
          <CardHeader className="border-b border-white/5 pb-4">
            <CardTitle className="flex items-center gap-2 text-base text-white">
                 <Layers3 className="h-4 w-4 text-violet-400" />
                 Inventory Categories
              </CardTitle>
            </CardHeader>
          <CardContent className="p-5">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={inventoryCategoryData} dataKey="value" innerRadius={58} outerRadius={88} paddingAngle={3}>
                    {inventoryCategoryData.map((category, idx) => (
                      <Cell key={category.name} fill={categoryColors[idx % categoryColors.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip contentStyle={{ borderRadius: '10px', border: '1px solid #27272a', background: '#111', color: '#fafafa' }} formatter={(value) => `$${Number(value ?? 0).toLocaleString()}`} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {inventoryCategoryData.map((category, idx) => (
                <div key={category.name} className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-400">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: categoryColors[idx % categoryColors.length] }} />
                  <span className="truncate">{category.name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {smartSuggestions.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_220px]">
          <div className="rounded-xl border border-blue-500/20 bg-[#101827] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="rounded-lg bg-blue-600 p-2 text-white">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-white">Smart Action Center</h3>
                  <p className="mt-1 truncate text-xs text-blue-100/65">{smartSuggestions[0]?.title}</p>
                </div>
              </div>
              <button onClick={smartSuggestions[0]?.onClick} className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500">
                {smartSuggestions[0]?.actionText}
              </button>
            </div>
          </div>
          <button onClick={() => router.push('/approvals')} className="rounded-xl border border-white/10 bg-[#151515] p-4 text-left shadow-[0_18px_50px_rgba(0,0,0,0.24)] transition-colors hover:bg-[#1b1b1b]">
            <div className="flex items-center justify-between">
              <div className="rounded-lg bg-violet-500 p-2 text-white">
                <CheckSquare className="h-4 w-4" />
              </div>
              <span className="text-xs font-semibold text-violet-300">{approvalCount} pending</span>
            </div>
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-12">
        <Card className="rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.32)] md:col-span-4">
          <CardHeader className="flex flex-row items-center justify-between border-b border-white/5 pb-4">
            <CardTitle className="flex items-center gap-2 text-base text-white">
              <AlertCircle className="h-4 w-4 text-red-400" />
              Stock Alerts
            </CardTitle>
            <Badge variant="danger" className="rounded-md bg-red-500/15 px-2 py-0.5 text-red-300">{dashboardAlerts.length} Alert</Badge>
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            {alertPreview.map(alert => (
              <div key={alert.id} className="rounded-lg border border-white/10 bg-[#181818] p-3">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 rounded-md p-2 ${alert.severity === 'Critical' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'}`}>
                    {alert.group === 'supplier' ? <ShoppingCart className="h-4 w-4" /> : alert.group === 'stock' ? <PackageX className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="truncate text-xs font-semibold text-white">{alert.title}</h4>
                      <span className={`text-[10px] font-bold uppercase ${alert.severity === 'Critical' ? 'text-red-400' : 'text-amber-400'}`}>{alert.severity}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-zinc-500">{alert.desc}</p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-[10px] text-zinc-600">{alert.date}</span>
                      {alert.actionLink && (
                        <button onClick={() => router.push(alert.actionLink)} className="rounded-md border border-white/10 px-2 py-1 text-[10px] font-semibold text-zinc-300 hover:bg-white/5">Resolve</button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.32)] md:col-span-8">
          <CardHeader className="flex flex-row items-center justify-between border-b border-white/5 pb-4">
            <CardTitle className="text-base text-white">Recent Transactions</CardTitle>
            <button onClick={() => router.push('/orders')} className="text-xs font-semibold text-zinc-300 hover:text-white">View All</button>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader className="bg-[#151515]">
                <TableRow className="border-white/5">
                  <TableHead className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">PO</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Supplier</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Date</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Status</TableHead>
                  <TableHead className="text-right text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentOrdersRender.length > 0 ? recentOrdersRender.map(order => (
                  <TableRow key={order.id} onClick={() => router.push('/orders')} className="cursor-pointer border-white/5 hover:bg-white/[0.03]">
                    <TableCell className="font-mono text-xs text-zinc-400">{order.id}</TableCell>
                    <TableCell className="font-medium text-white">{order.supplier}</TableCell>
                    <TableCell className="text-zinc-500">{order.date}</TableCell>
                    <TableCell>
                      <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${order.status === 'Delivered' ? 'bg-emerald-500/15 text-emerald-300' : order.status === 'Sent' ? 'bg-blue-500/15 text-blue-300' : 'bg-amber-500/15 text-amber-300'}`}>
                        {order.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-semibold text-white">${order.total.toFixed(2)}</TableCell>
                  </TableRow>
                )) : (
                  <TableRow className="border-white/5">
                    <TableCell colSpan={5} className="py-8 text-center text-sm text-zinc-500">No recent orders synced.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.32)]">
        <CardHeader className="flex flex-col gap-3 border-b border-white/5 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base text-white">
              <Boxes className="h-4 w-4 text-amber-400" />
              Low Stock Action Center
            </CardTitle>
            <CardDescription className="mt-1 text-zinc-500">Items below par requiring immediate reorder.</CardDescription>
          </div>
          <button 
            onClick={handleOpenBulkGenerate}
            disabled={lowStockItems.length === 0}
            className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Auto-Generate POs
            <ArrowRight className="h-4 w-4" />
          </button>
        </CardHeader>
        <CardContent className="p-0">
          {topLowStock.length > 0 && (
            <div className="grid grid-cols-1 gap-3 border-b border-white/5 bg-[#0d0d0d] p-4 md:grid-cols-5">
              {topLowStock.map(item => {
                const stockRatio = item.parLevel > 0 ? Math.max(0, Math.min(100, (item.inStock / item.parLevel) * 100)) : 0;
                return (
                  <div key={item.id} className="rounded-lg border border-white/10 bg-[#181818] p-3">
                    <p className="truncate text-xs font-semibold text-white">{item.name}</p>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div className={stockRatio < 30 ? "h-full rounded-full bg-rose-500" : "h-full rounded-full bg-amber-500"} style={{ width: `${stockRatio}%` }} />
                    </div>
                    <p className="mt-2 text-[10px] font-medium text-zinc-500">{item.inStock} / {item.parLevel} {item.unit}</p>
                  </div>
                );
              })}
            </div>
          )}
          <Table>
            <TableHeader className="bg-[#151515]">
              <TableRow className="border-white/5">
                <TableHead className="font-semibold text-zinc-500">Item Name</TableHead>
                <TableHead className="font-semibold text-zinc-500">Status</TableHead>
                <TableHead className="font-semibold text-zinc-500">Current Stock</TableHead>
                <TableHead className="font-semibold text-zinc-500">Par Level</TableHead>
                <TableHead className="font-semibold text-zinc-500">Suggested Reorder</TableHead>
                <TableHead className="text-right font-semibold text-zinc-500">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lowStockItems.length > 0 ? (
                lowStockItems.map((item) => {
                  const stockRatio = item.inStock / item.parLevel;
                  const isCritical = stockRatio < 0.3;
                  const suggestedReorder = item.parLevel - item.inStock;
                  
                  return (
                    <TableRow key={item.id} className="border-white/5 transition-colors hover:bg-white/[0.03]">
                      <TableCell className="font-semibold text-white">{item.name}</TableCell>
                      <TableCell>
                        <Badge variant={item.inStock === 0 ? 'danger' : isCritical ? 'danger' : 'warning'} className="px-2">
                          {item.inStock === 0 ? "Out of Stock" : isCritical ? "Critical" : "Low"}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium text-zinc-500">{item.inStock} {item.unit}</TableCell>
                      <TableCell className="text-zinc-500">{item.parLevel} {item.unit}</TableCell>
                      <TableCell className="font-semibold text-amber-400">{suggestedReorder} {item.unit}</TableCell>
                      <TableCell className="text-right">
                        <button 
                          onClick={() => handleAddToPO(item)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-sm font-semibold text-zinc-200 transition-colors hover:bg-blue-600 hover:text-white"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add to PO
                        </button>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow className="border-white/5">
                  <TableCell colSpan={6} className="text-center py-6 text-sm text-zinc-500">
                    All inventory items are fully stocked above par.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {isHQAdmin && (
        <Card className="rounded-xl border-white/10 bg-[#111111] shadow-[0_18px_50px_rgba(0,0,0,0.32)]">
          <CardHeader className="border-b border-white/5 pb-4">
            <CardTitle className="text-base text-white">Cross-Location Review</CardTitle>
          </CardHeader>
          <CardContent className="p-5 text-zinc-900">
            <HQLocationReview locations={locations} />
          </CardContent>
        </Card>
      )}

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
    </div>
  );
}
