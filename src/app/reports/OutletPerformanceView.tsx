"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Drawer } from "@/components/ui/drawer";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin } from "@/lib/roles";
import { supabase } from "@/lib/supabase";
import { getFulfillmentProfitReport, getInventoryMovementReport } from "@/lib/reports";
import { loadSuppliers } from "@/lib/storage";
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Cell 
} from "recharts";
import { 
  TrendingUp, TrendingDown, DollarSign, AlertCircle, Filter, Loader2, ChevronDown, 
  Award, BarChart3, ShoppingBag, Activity, ShieldAlert
} from "lucide-react";

interface OutletPerformanceViewProps {
  dateFrom: string;
  dateTo: string;
  locationId: string;
  locations: any[];
}

export default function OutletPerformanceView({
  dateFrom,
  dateTo,
  locationId,
  locations,
}: OutletPerformanceViewProps) {
  const { user } = useAuth();
  const isHQ = isHqAdmin(user);
  
  // States
  const [selectedSupplier, setSelectedSupplier] = useState<string>("");
  const [metric, setMetric] = useState<string>("Sales");
  const [showZeroOutlets, setShowZeroOutlets] = useState<boolean>(false);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Data states
  const [profitRows, setProfitRows] = useState<any[]>([]);
  const [movementRows, setMovementRows] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);

  // Drilldown state
  const [selectedOutlet, setSelectedOutlet] = useState<any | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);

  // Load all necessary data
  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const filters = {
          locationId: isHQ ? (locationId || null) : user?.locationId,
          dateFrom,
          dateTo
        };

        // 1. Fetch Profit Report
        const { data: profitData, error: profitErr } = await getFulfillmentProfitReport(filters);
        if (profitErr) throw new Error(profitErr);
        setProfitRows(profitData?.rows || []);

        // 2. Fetch Movements Ledger
        const { data: movementData, error: movementErr } = await getInventoryMovementReport({
          ...filters,
          bucket: null
        });
        if (movementErr) throw new Error(movementErr);
        setMovementRows(movementData?.rows || []);

        // 3. Fetch Purchase Orders (orders table)
        let poQuery = supabase.from("orders").select("*");
        if (!isHQ && user?.locationId) {
          poQuery = poQuery.eq("location_id", user.locationId);
        } else if (locationId) {
          poQuery = poQuery.eq("location_id", locationId);
        }
        if (dateFrom) poQuery = poQuery.gte("date", dateFrom);
        if (dateTo) poQuery = poQuery.lte("date", dateTo);
        const { data: poData, error: poErr } = await poQuery;
        if (poErr) throw new Error(poErr.message);
        setOrders(poData || []);

        // 4. Fetch Suppliers
        const loadedSuppliers = await loadSuppliers();
        setSuppliers(loadedSuppliers || []);
      } catch (err: any) {
        console.error("[OutletPerformanceView] error loading report data:", err);
        setError(err.message || "Failed to load report data.");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [dateFrom, dateTo, locationId, isHQ, user]);

  // Helpers
  const formatCurrency = (val: number) => `$${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const formatPercent = (val: number) => `${val.toFixed(1)}%`;

  // Filter outlet list based on scope
  const scopedLocations = useMemo(() => {
    if (!isHQ && user?.locationId) {
      return locations.filter(l => l.id === user.locationId);
    }
    if (locationId) {
      return locations.filter(l => l.id === locationId);
    }
    return locations.filter(l => l.id !== "LOC-HQ"); // Exclude HQ itself
  }, [locations, locationId, isHQ, user]);

  // Main Aggregated Data computations
  const aggregatedData = useMemo(() => {
    return scopedLocations.map(loc => {
      // 1. Profit rows for this location
      const locProfitRows = profitRows.filter(r => r.location_id === loc.id);
      const sales = locProfitRows.reduce((sum, r) => sum + (r.revenue || 0), 0);
      const cogs = locProfitRows.reduce((sum, r) => sum + (r.cogs || 0), 0);
      const profit = locProfitRows.reduce((sum, r) => sum + (r.profit || 0), 0);
      const margin = sales > 0 ? (profit / sales) * 100 : 0;

      // 2. Orders for this location
      const locOrders = orders.filter(o => 
        (o.location_id === loc.id || o.locationId === loc.id) &&
        o.status !== "Draft" && o.status !== "Draft (Auto)" &&
        (!selectedSupplier || o.suppliername === selectedSupplier || o.supplierName === selectedSupplier)
      );
      const supplierSpend = locOrders.reduce((sum, o) => sum + (o.total || 0), 0);

      // Top Supplier computation for this location
      const spendBySupplier: Record<string, number> = {};
      locOrders.forEach(o => {
        const sName = o.suppliername || o.supplierName || "Unknown";
        spendBySupplier[sName] = (spendBySupplier[sName] || 0) + (o.total || 0);
      });
      let topSupplierName = "—";
      let topSupplierMax = 0;
      Object.entries(spendBySupplier).forEach(([name, spend]) => {
        if (spend > topSupplierMax) {
          topSupplierMax = spend;
          topSupplierName = name;
        }
      });

      // 3. Variance from movement rows
      const locMovementRows = movementRows.filter(r => 
        r.location_id === loc.id && 
        (r.report_bucket === "variance_gain" || r.report_bucket === "variance_loss")
      );
      const variance = locMovementRows.reduce((sum, r) => sum + (r.signed_cost || 0), 0);

      // 4. Gather top purchased items (drilldown helper)
      const itemSpend: Record<string, { name: string; cost: number; qty: number; unit: string }> = {};
      locOrders.forEach(o => {
        const lineItems = o.lineitems || o.lineItems || [];
        lineItems.forEach((li: any) => {
          const name = li.name || li.itemName || "Unknown Item";
          const cost = (li.actualPrice || li.expectedPrice || li.cost || 0) * (li.qty || 0);
          const current = itemSpend[name] || { name, cost: 0, qty: 0, unit: li.unit || "" };
          itemSpend[name] = {
            name,
            cost: current.cost + cost,
            qty: current.qty + (li.qty || 0),
            unit: li.unit || current.unit
          };
        });
      });
      const topItems = Object.values(itemSpend)
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 10);

      return {
        id: loc.id,
        name: loc.name,
        sales,
        cogs,
        profit,
        margin,
        supplierSpend,
        topSupplier: topSupplierName,
        variance,
        topItems,
        spendBySupplier
      };
    });
  }, [scopedLocations, profitRows, movementRows, orders, selectedSupplier]);

  // Compute Total metrics across all outlets
  const kpis = useMemo(() => {
    const totalSales = aggregatedData.reduce((sum, d) => sum + d.sales, 0);
    const totalCogs = aggregatedData.reduce((sum, d) => sum + d.cogs, 0);
    const grossProfit = totalSales - totalCogs;
    const grossMargin = totalSales > 0 ? (grossProfit / totalSales) * 100 : 0;
    const totalSupplierSpend = aggregatedData.reduce((sum, d) => sum + d.supplierSpend, 0);

    // Sort by sales to find top/lowest
    const sortedBySales = [...aggregatedData].sort((a, b) => b.sales - a.sales);
    const topOutlet = sortedBySales[0]?.name || "—";
    const lowestOutlet = sortedBySales[sortedBySales.length - 1]?.name || "—";

    // Overall top supplier spend
    const overallSupplierSpend: Record<string, number> = {};
    orders.forEach(o => {
      if (o.status !== "Draft" && o.status !== "Draft (Auto)") {
        const name = o.suppliername || o.supplierName || "Unknown";
        overallSupplierSpend[name] = (overallSupplierSpend[name] || 0) + (o.total || 0);
      }
    });
    let highestSpendSupplier = "—";
    let highestSpendMax = 0;
    Object.entries(overallSupplierSpend).forEach(([name, spend]) => {
      if (spend > highestSpendMax) {
        highestSpendMax = spend;
        highestSpendSupplier = name;
      }
    });

    return {
      totalSales,
      totalCogs,
      grossProfit,
      grossMargin,
      totalSupplierSpend,
      topOutlet,
      lowestOutlet,
      highestSpendSupplier
    };
  }, [aggregatedData, orders]);

  // Sorted Outlet Performance list
  const sortedOutletPerformance = useMemo(() => {
    return [...aggregatedData].sort((a: any, b: any) => {
      if (metric === "Sales") return b.sales - a.sales;
      if (metric === "COGS") return b.cogs - a.cogs;
      if (metric === "Gross Profit") return b.profit - a.profit;
      if (metric === "Gross Margin %") return b.margin - a.margin;
      if (metric === "Supplier Spend") return b.supplierSpend - a.supplierSpend;
      if (metric === "Inventory Variance") return Math.abs(b.variance) - Math.abs(a.variance);
      return 0;
    });
  }, [aggregatedData, metric]);

  // Outlet chart data
  const outletChartData = useMemo(() => {
    return sortedOutletPerformance.map(d => {
      let val = d.sales;
      if (metric === "COGS") val = d.cogs;
      if (metric === "Gross Profit") val = d.profit;
      if (metric === "Gross Margin %") val = d.margin;
      if (metric === "Supplier Spend") val = d.supplierSpend;
      if (metric === "Inventory Variance") val = d.variance;
      
      return {
        name: d.name,
        value: val
      };
    });
  }, [sortedOutletPerformance, metric]);

  // Exclude zero-value and limit to top 10 for chart
  const filteredOutletChartData = useMemo(() => {
    let data = outletChartData;
    if (!showZeroOutlets) {
      data = data.filter(d => d.value !== 0);
    }
    return data.slice(0, 10);
  }, [outletChartData, showZeroOutlets]);

  // Supplier spend chart data
  const supplierSpendChartData = useMemo(() => {
    const spendBySupplier: Record<string, number> = {};
    orders.forEach(o => {
      if (
        o.status !== "Draft" && 
        o.status !== "Draft (Auto)" && 
        (!locationId || o.location_id === locationId || o.locationId === locationId) &&
        (!selectedSupplier || o.suppliername === selectedSupplier || o.supplierName === selectedSupplier)
      ) {
        const name = o.suppliername || o.supplierName || "Unknown";
        spendBySupplier[name] = (spendBySupplier[name] || 0) + (o.total || 0);
      }
    });
    return Object.entries(spendBySupplier)
      .map(([name, spend]) => ({ name, spend }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 10);
  }, [orders, locationId, selectedSupplier]);

  // Handle drilldown click
  const handleOutletClick = (outlet: any) => {
    setSelectedOutlet(outlet);
    setIsDrawerOpen(true);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-neutral-500">
        <Loader2 className="h-8 w-8 animate-spin text-brand-600 mb-3" />
        <span className="text-sm font-medium">Aggregating outlet metrics...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm flex items-start gap-2">
        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
        <span>{error}</span>
      </div>
    );
  }

  // Check empty state
  const isDataEmpty = aggregatedData.length === 0 || (kpis.totalSales === 0 && kpis.totalSupplierSpend === 0);
  if (isDataEmpty) {
    return (
      <div className="py-16 text-center text-neutral-400 text-sm bg-white border border-neutral-200 rounded-xl shadow-sm">
        <BarChart3 className="h-10 w-10 mx-auto mb-3 opacity-30 text-neutral-500" />
        No reporting data found for this period.
      </div>
    );
  }

  // Dynamic Chart Height based on elements
  const dynamicChartHeight = Math.min(360, Math.max(160, filteredOutletChartData.length * 36));

  return (
    <div className="space-y-4">
      
      {/* ── Sub-Filters Card */}
      <Card className="shadow-sm">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-end gap-4">
            
            {/* Supplier Filter */}
            <div className="space-y-1 min-w-[200px]">
              <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider flex items-center gap-1">
                <Filter className="h-3 w-3" /> Supplier Spend Filter
              </label>
              <div className="relative">
                <select
                  value={selectedSupplier}
                  onChange={e => setSelectedSupplier(e.target.value)}
                  className="w-full appearance-none pl-3 pr-8 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                >
                  <option value="">All Suppliers</option>
                  {suppliers.map(s => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-400 pointer-events-none" />
              </div>
            </div>

            {/* Metric Selector */}
            <div className="space-y-1 min-w-[200px]">
              <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider flex items-center gap-1">
                <Activity className="h-3 w-3" /> Rank By Metric
              </label>
              <div className="relative">
                <select
                  value={metric}
                  onChange={e => setMetric(e.target.value)}
                  className="w-full appearance-none pl-3 pr-8 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-400"
                >
                  <option value="Sales">Sales</option>
                  <option value="COGS">COGS</option>
                  <option value="Gross Profit">Gross Profit</option>
                  <option value="Gross Margin %">Gross Margin %</option>
                  <option value="Supplier Spend">Supplier Spend</option>
                  <option value="Inventory Variance">Inventory Variance</option>
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-400 pointer-events-none" />
              </div>
            </div>

          </div>
        </CardContent>
      </Card>

      {/* ── KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        
        <Card className="rounded-xl border-neutral-200/60 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="h-5 w-5 text-emerald-600" />
            <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Total Sales</span>
          </div>
          <p className="text-2xl font-bold text-neutral-900 tabular-nums">{formatCurrency(kpis.totalSales)}</p>
          <p className="text-xs text-neutral-400 mt-0.5">Across all selected outlets</p>
        </Card>

        <Card className="rounded-xl border-neutral-200/60 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown className="h-5 w-5 text-orange-500" />
            <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Total COGS</span>
          </div>
          <p className="text-2xl font-bold text-neutral-900 tabular-nums">{formatCurrency(kpis.totalCogs)}</p>
          <p className="text-xs text-neutral-400 mt-0.5">Recipe making costs</p>
        </Card>

        <Card className="rounded-xl border-neutral-200/60 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-5 w-5 text-indigo-600" />
            <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Gross Margin</span>
          </div>
          <p className="text-2xl font-bold text-neutral-900 tabular-nums">{formatPercent(kpis.grossMargin)}</p>
          <p className="text-xs text-neutral-400 mt-0.5">Gross profit: {formatCurrency(kpis.grossProfit)}</p>
        </Card>

        <Card className="rounded-xl border-neutral-200/60 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <ShoppingBag className="h-5 w-5 text-teal-600" />
            <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">PO Supplier Spend</span>
          </div>
          <p className="text-2xl font-bold text-neutral-900 tabular-nums">{formatCurrency(kpis.totalSupplierSpend)}</p>
          <p className="text-xs text-neutral-400 mt-0.5">Top supplier: {kpis.highestSpendSupplier}</p>
        </Card>

      </div>

      {/* ── Sub KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        
        <div className="rounded-xl border border-neutral-200/60 bg-white p-3 flex items-center gap-3 shadow-xs">
          <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700 shrink-0">
            <Award className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Top Performing Outlet</p>
            <h4 className="font-bold text-neutral-800 text-sm truncate mt-0.5">{kpis.topOutlet}</h4>
          </div>
        </div>

        <div className="rounded-xl border border-neutral-200/60 bg-white p-3 flex items-center gap-3 shadow-xs">
          <div className="rounded-lg bg-orange-50 p-2 text-orange-700 shrink-0">
            <TrendingDown className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Lowest Performing Outlet</p>
            <h4 className="font-bold text-neutral-800 text-sm truncate mt-0.5">{kpis.lowestOutlet}</h4>
          </div>
        </div>

        <div className="rounded-xl border border-neutral-200/60 bg-white p-3 flex items-center gap-3 shadow-xs">
          <div className="rounded-lg bg-teal-50 p-2 text-teal-700 shrink-0">
            <ShoppingBag className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Top PO Supplier</p>
            <h4 className="font-bold text-neutral-800 text-sm truncate mt-0.5">{kpis.highestSpendSupplier}</h4>
          </div>
        </div>

      </div>

      {/* ── Charts Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        
        {/* Horizontal Bar Chart for Outlet Ranking */}
        <Card className="shadow-sm flex flex-col justify-between">
          <CardHeader className="py-3 px-4 border-b border-neutral-100 bg-neutral-50/50 flex flex-row items-center justify-between gap-4">
            <CardTitle className="text-sm font-bold text-neutral-700 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-brand-600" />
              Outlet Ranking by {metric} (Top 10)
            </CardTitle>
            
            {/* Show Zero Value Checkbox */}
            <div className="flex items-center gap-2">
              <input
                id="show-zero-outlets"
                type="checkbox"
                checked={showZeroOutlets}
                onChange={e => setShowZeroOutlets(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-neutral-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
              />
              <label htmlFor="show-zero-outlets" className="text-[11px] text-neutral-500 font-semibold cursor-pointer select-none">
                Show zero-value
              </label>
            </div>
          </CardHeader>
          
          <CardContent className="p-4 flex-1 flex flex-col justify-center">
            {filteredOutletChartData.length > 0 ? (
              <div className="w-full">
                <ResponsiveContainer width="100%" height={dynamicChartHeight}>
                  <BarChart data={filteredOutletChartData} layout="vertical" margin={{ top: 5, right: 10, left: 40, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
                    <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: '#737373', fontSize: 10 }} />
                    <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{ fill: '#737373', fontSize: 10 }} />
                    <RechartsTooltip 
                      formatter={(value: any) => metric === "Gross Margin %" ? `${Number(value).toFixed(1)}%` : formatCurrency(Number(value))}
                      contentStyle={{ borderRadius: '8px', border: '1px solid #e5e5e5' }}
                    />
                    <Bar dataKey="value" fill="#6366f1" radius={[0, 4, 4, 0]} cursor="pointer">
                      {filteredOutletChartData.map((entry, index) => {
                        const matchingOutlet = sortedOutletPerformance.find(o => o.name === entry.name);
                        return (
                          <Cell 
                            key={`cell-${index}`} 
                            fill={index === 0 ? '#4f46e5' : '#6366f1'} 
                            onClick={() => matchingOutlet && handleOutletClick(matchingOutlet)}
                          />
                        );
                      })}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="py-12 px-4 text-center text-neutral-400 text-xs flex flex-col items-center justify-center min-h-[180px]">
                <BarChart3 className="h-6 w-6 text-neutral-300 mb-2 opacity-55" />
                <p className="font-semibold text-neutral-500">No outlet performance data found for this metric and period.</p>
                <p className="text-[10px] text-neutral-400 mt-0.5">Toggle "Show zero-value" or pick another ranking metric.</p>
              </div>
            )}
            <p className="text-[9px] text-neutral-400 mt-2 text-center">Tip: Click on a bar to drill down into the outlet's detailed breakdown.</p>
          </CardContent>
        </Card>

        {/* Supplier Spend Graph */}
        <Card className="shadow-sm flex flex-col justify-between">
          <CardHeader className="py-3 px-4 border-b border-neutral-100 bg-neutral-50/50">
            <CardTitle className="text-sm font-bold text-neutral-700 flex items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-teal-600" />
              Supplier Spend Graph (Top 10)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 flex-1 flex flex-col justify-center">
            {/* Active Supplier Chip */}
            {selectedSupplier && (
              <div className="mb-3">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-50 text-teal-700 border border-teal-200">
                  Supplier: {selectedSupplier}
                  <button 
                    onClick={() => setSelectedSupplier("")}
                    className="hover:text-teal-900 font-bold ml-1 text-xs leading-none"
                    title="Clear filter"
                  >
                    ×
                  </button>
                </span>
              </div>
            )}
            
            {supplierSpendChartData.length > 0 ? (
              <div className="w-full h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={supplierSpendChartData} margin={{ top: 10, right: 10, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#737373', fontSize: 9 }} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: '#737373', fontSize: 9 }} />
                    <RechartsTooltip 
                      formatter={(value: any) => formatCurrency(Number(value))}
                      contentStyle={{ borderRadius: '8px', border: '1px solid #e5e5e5' }}
                    />
                    <Bar dataKey="spend" fill="#14b8a6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="py-12 px-6 text-center text-neutral-400 text-xs flex flex-col items-center justify-center min-h-[180px]">
                <ShoppingBag className="h-6 w-6 text-neutral-300 mb-2 opacity-55" />
                <p className="font-semibold text-neutral-500">No purchase order supplier spend found for this supplier/date range.</p>
                <p className="text-[10px] text-neutral-400 mt-0.5">Try All Suppliers or a wider date range.</p>
              </div>
            )}
          </CardContent>
        </Card>

      </div>

      {/* ── Detailed Performance Table */}
      <Card className="shadow-sm">
        <CardHeader className="py-2.5 px-4 border-b border-neutral-100 bg-neutral-50/50">
          <CardTitle className="text-sm font-bold text-neutral-700">Detailed Outlet Performance Table</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader className="bg-neutral-50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-12 text-center text-[9px] font-bold uppercase tracking-wider py-2 px-3">Rank</TableHead>
                <TableHead className="text-[9px] font-bold uppercase tracking-wider py-2 px-3">Location</TableHead>
                <TableHead className="text-right text-[9px] font-bold uppercase tracking-wider py-2 px-3">Total Sales</TableHead>
                <TableHead className="text-right text-[9px] font-bold uppercase tracking-wider py-2 px-3">COGS</TableHead>
                <TableHead className="text-right text-[9px] font-bold uppercase tracking-wider py-2 px-3">Gross Profit</TableHead>
                <TableHead className="text-right text-[9px] font-bold uppercase tracking-wider py-2 px-3">Gross Margin %</TableHead>
                <TableHead className="text-right text-[9px] font-bold uppercase tracking-wider py-2 px-3">Supplier Spend</TableHead>
                <TableHead className="text-right text-[9px] font-bold uppercase tracking-wider py-2 px-3">Inventory Variance</TableHead>
                <TableHead className="text-[9px] font-bold uppercase tracking-wider py-2 px-3">Top Supplier</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedOutletPerformance.map((row, index) => {
                const rank = index + 1;
                const isVarianceNegative = row.variance < 0;

                return (
                  <TableRow 
                    key={row.id} 
                    className="cursor-pointer hover:bg-neutral-50/70 border-b border-neutral-100"
                    onClick={() => handleOutletClick(row)}
                  >
                    <TableCell className="text-center font-bold text-neutral-400 text-xs py-2.5 px-3">{rank}</TableCell>
                    <TableCell className="font-semibold text-neutral-900 py-2.5 px-3">{row.name}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium text-neutral-800 py-2.5 px-3">{formatCurrency(row.sales)}</TableCell>
                    <TableCell className="text-right tabular-nums text-neutral-600 py-2.5 px-3">{formatCurrency(row.cogs)}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold text-emerald-700 py-2.5 px-3">{formatCurrency(row.profit)}</TableCell>
                    <TableCell className="text-right tabular-nums py-2.5 px-3">
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                        row.margin >= 20 
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200" 
                          : "bg-amber-50 text-amber-700 border-amber-200"
                      }`}>
                        {formatPercent(row.margin)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-teal-700 font-medium py-2.5 px-3">{formatCurrency(row.supplierSpend)}</TableCell>
                    <TableCell className={`text-right tabular-nums font-medium py-2.5 px-3 ${isVarianceNegative ? 'text-red-600' : row.variance > 0 ? 'text-emerald-600' : 'text-neutral-500'}`}>
                      {row.variance > 0 ? '+' : ''}{formatCurrency(row.variance)}
                    </TableCell>
                    <TableCell className="text-neutral-600 text-xs truncate max-w-[150px] py-2.5 px-3" title={row.topSupplier}>{row.topSupplier}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── Drilldown Drawer */}
      <Drawer
        isOpen={isDrawerOpen}
        onClose={() => {
          setIsDrawerOpen(false);
          setSelectedOutlet(null);
        }}
        title={`${selectedOutlet?.name || "Outlet"} Performance Breakdown`}
        description="Detailed margin, supplier spend, top cost item list, and inventory variance stats."
      >
        {selectedOutlet && (
          <div className="space-y-6">
            
            {/* Margin Summary */}
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-neutral-400 uppercase tracking-wider">Gross Margin Summary</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-white border border-neutral-100 rounded-lg">
                  <span className="text-[10px] text-neutral-400 uppercase font-semibold block">Sales / Revenue</span>
                  <span className="text-lg font-bold text-neutral-800">{formatCurrency(selectedOutlet.sales)}</span>
                </div>
                <div className="p-3 bg-white border border-neutral-100 rounded-lg">
                  <span className="text-[10px] text-neutral-400 uppercase font-semibold block">Cost of Goods Sold (COGS)</span>
                  <span className="text-lg font-bold text-neutral-800">{formatCurrency(selectedOutlet.cogs)}</span>
                </div>
                <div className="p-3 bg-white border border-neutral-100 rounded-lg">
                  <span className="text-[10px] text-neutral-400 uppercase font-semibold block">Gross Profit</span>
                  <span className="text-lg font-bold text-emerald-700">{formatCurrency(selectedOutlet.profit)}</span>
                </div>
                <div className="p-3 bg-white border border-neutral-100 rounded-lg">
                  <span className="text-[10px] text-neutral-400 uppercase font-semibold block">Gross Margin %</span>
                  <span className="text-lg font-bold text-brand-700">{formatPercent(selectedOutlet.margin)}</span>
                </div>
              </div>
            </div>

            {/* Inventory Variance Section */}
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-neutral-400 uppercase tracking-wider">Inventory Variance</h3>
              <div className={`p-4 rounded-lg border flex items-center gap-3 ${
                selectedOutlet.variance < 0 
                  ? 'bg-red-50/50 border-red-100 text-red-700' 
                  : selectedOutlet.variance > 0 
                  ? 'bg-emerald-50/50 border-emerald-100 text-emerald-700' 
                  : 'bg-neutral-50 border-neutral-100 text-neutral-600'
              }`}>
                <ShieldAlert className="h-5 w-5 shrink-0" />
                <div>
                  <span className="text-[10px] uppercase font-semibold block opacity-85">Net Variance Value</span>
                  <span className="text-base font-bold tabular-nums">
                    {selectedOutlet.variance > 0 ? '+' : ''}{formatCurrency(selectedOutlet.variance)}
                  </span>
                </div>
              </div>
            </div>

            {/* Supplier Spend Breakdown for Outlet */}
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-neutral-400 uppercase tracking-wider">Supplier Spend Breakdown</h3>
              {Object.keys(selectedOutlet.spendBySupplier).length > 0 ? (
                <div className="bg-white border border-neutral-100 rounded-lg divide-y divide-neutral-100 overflow-hidden">
                  {Object.entries(selectedOutlet.spendBySupplier)
                    .sort((a: any, b: any) => b[1] - a[1])
                    .map(([name, spend]) => (
                      <div key={name} className="flex justify-between items-center px-3.5 py-2.5 hover:bg-neutral-50/30">
                        <span className="text-sm font-medium text-neutral-700">{name}</span>
                        <span className="text-sm font-semibold text-neutral-900 tabular-nums">{formatCurrency(spend as number)}</span>
                      </div>
                    ))}
                </div>
              ) : (
                <div className="p-4 text-center text-xs text-neutral-400 bg-white border border-neutral-100 rounded-lg">No supplier purchase orders logged.</div>
              )}
            </div>

            {/* Top 10 Items by Cost/Usage */}
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-neutral-400 uppercase tracking-wider">Top 10 Items by Purchase Cost</h3>
              {selectedOutlet.topItems.length > 0 ? (
                <div className="bg-white border border-neutral-100 rounded-lg divide-y divide-neutral-100 overflow-hidden">
                  {selectedOutlet.topItems.map((item: any, idx: number) => (
                    <div key={item.name} className="flex justify-between items-center px-3.5 py-2.5 hover:bg-neutral-50/30">
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-neutral-400 font-bold w-4">{idx + 1}</span>
                          <span className="text-sm font-semibold text-neutral-800 truncate block">{item.name}</span>
                        </div>
                        <span className="text-[10px] text-neutral-400 ml-5 block">Qty: {item.qty} {item.unit}</span>
                      </div>
                      <span className="text-sm font-bold text-neutral-900 tabular-nums shrink-0">{formatCurrency(item.cost)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 text-center text-xs text-neutral-400 bg-white border border-neutral-100 rounded-lg">No items purchased in this period.</div>
              )}
            </div>

          </div>
        )}
      </Drawer>

    </div>
  );
}
