"use client";

import React, { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { 
  CheckCircle2, 
  XSquare,
  ClipboardList,
  ShoppingCart,
  AlertTriangle,
  Play
} from "lucide-react";
import { 
  loadProductionPlans, 
  saveProductionPlans, 
  loadOrders,
  saveOrders,
  loadSuppliers
} from "@/lib/storage";
import { runAutomationEngine } from "@/lib/automation";

export default function Approvals() {
  const [productionPlans, setProductionPlans] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  
  const [activeTab, setActiveTab] = useState<"production" | "orders">("production");

  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        runAutomationEngine();
        
        const [plans, ords, sups] = await Promise.all([
          loadProductionPlans(),
          loadOrders(),
          loadSuppliers()
        ]);
        
        setProductionPlans(plans);
        setOrders(ords);
        setSuppliers(sups);
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, []);

  if (isLoading) return <div className="p-12 flex justify-center text-neutral-400 animate-pulse">Loading Workflows...</div>;

  const pendingPlans = productionPlans.filter(p => p.status === "Draft (Auto)" || p.status === "Pending Approval");
  const pendingOrders = orders.filter(o => o.status === "Draft (Auto)" || o.status === "Pending Approval" || (o.status === "Draft" && o.createdBy === "Auto Engine"));

  const handleApprovePlan = async (id: string) => {
    const arr = [...productionPlans];
    const item = arr.find(p => p.id === id);
    if (item) item.status = "Approved";
    const res = await saveProductionPlans(arr);
    if (!res?.success) { alert(`DB Error (Approve Plan): ${res?.error}`); return; }
    setProductionPlans(arr);
  };

  const handleRejectPlan = async (id: string) => {
    const arr = [...productionPlans];
    const item = arr.find(p => p.id === id);
    if (item) item.status = "Rejected";
    const res = await saveProductionPlans(arr);
    if (!res?.success) { alert(`DB Error (Reject Plan): ${res?.error}`); return; }
    setProductionPlans(arr);
  };
  
  const handleStartProduction = async (id: string) => {
    const arr = [...productionPlans];
    const item = arr.find(p => p.id === id);
    if (item) {
       item.status = "In Production";
       const res = await saveProductionPlans(arr);
       if (!res?.success) { alert(`DB Error (Start Prod): ${res?.error}`); return; }
       setProductionPlans(arr);
    }
  };

  const handleApproveOrder = async (id: string) => {
    const arr = [...orders];
    const item = arr.find(o => o.id === id);
    if (item) item.status = "Approved";
    const res = await saveOrders(arr);
    if (!res?.success) { alert(`DB Error (Approve PO): ${res?.error}`); return; }
    setOrders(arr);
  };

  const handleRejectOrder = async (id: string) => {
    const arr = [...orders];
    const item = arr.find(o => o.id === id);
    if (item) item.status = "Rejected";
    const res = await saveOrders(arr);
    if (!res?.success) { alert(`DB Error (Reject PO): ${res?.error}`); return; }
    setOrders(arr);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">HQ Approval Queue</h2>
          <p className="text-neutral-500">Review and orchestrate auto-generated production logic and raw material purchases.</p>
        </div>
        <div className="flex bg-neutral-100 p-1 rounded-lg border border-neutral-200 shadow-inner">
           <button 
             onClick={() => setActiveTab('production')}
             className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${activeTab === 'production' ? 'bg-white text-brand-700 shadow-sm' : 'text-neutral-600 hover:text-neutral-900'}`}
           >
             <ClipboardList className="h-4 w-4" />
             Production Plans 
             {pendingPlans.length > 0 && <span className="ml-1 bg-brand-100 text-brand-700 px-1.5 py-0.5 rounded-full text-xs font-bold">{pendingPlans.length}</span>}
           </button>
           <button 
             onClick={() => setActiveTab('orders')}
             className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${activeTab === 'orders' ? 'bg-white text-brand-700 shadow-sm' : 'text-neutral-600 hover:text-neutral-900'}`}
           >
             <ShoppingCart className="h-4 w-4" />
             Purchase Orders
             {pendingOrders.length > 0 && <span className="ml-1 bg-brand-100 text-brand-700 px-1.5 py-0.5 rounded-full text-xs font-bold">{pendingOrders.length}</span>}
           </button>
        </div>
      </div>

      <Card className="shadow-sm border-neutral-200 overflow-hidden">
        <CardContent className="p-0">
          {activeTab === "production" && (
             <Table>
               <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider">
                 <TableRow>
                   <TableHead className="py-3 px-6">Plan ID</TableHead>
                   <TableHead className="py-3">Finished Good</TableHead>
                   <TableHead className="py-3">Shortage</TableHead>
                   <TableHead className="py-3">Suggested Production</TableHead>
                   <TableHead className="py-3">Status</TableHead>
                   <TableHead className="py-3 text-right px-6">HQ Actions</TableHead>
                 </TableRow>
               </TableHeader>
               <TableBody>
                 {pendingPlans.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12 text-neutral-500">
                         No auto-generated production plans pending approval.
                      </TableCell>
                    </TableRow>
                 ) : (
                   pendingPlans.map(plan => (
                     <TableRow key={plan.id} className="hover:bg-neutral-50/50">
                       <TableCell className="px-6 font-medium text-sm text-neutral-900">{plan.id}</TableCell>
                       <TableCell className="font-bold text-neutral-900">{plan.fgName}</TableCell>
                       <TableCell>
                          <span className="text-sm font-bold text-danger-600 border border-danger-200 bg-danger-50 px-2 py-1 rounded-md">
                            {plan.shortageQty} {plan.unit}
                          </span>
                       </TableCell>
                       <TableCell>
                          <span className="text-sm font-bold text-brand-700 bg-brand-50 px-2 py-1 rounded-md">
                            {plan.suggestedProductionQty} {plan.unit}
                          </span>
                       </TableCell>
                       <TableCell>
                          <Badge variant="neutral" className="bg-warning-100 text-warning-800 border-none font-bold">
                            {plan.status}
                          </Badge>
                       </TableCell>
                       <TableCell className="text-right px-6">
                          <div className="flex justify-end gap-2">
                             <button onClick={() => handleApprovePlan(plan.id)} className="p-1.5 text-success-600 hover:bg-success-50 hover:text-success-700 rounded-md transition-colors" title="Approve">
                                <CheckCircle2 className="h-5 w-5" />
                             </button>
                             <button onClick={() => handleStartProduction(plan.id)} className="p-1.5 text-brand-600 hover:bg-brand-50 hover:text-brand-700 rounded-md transition-colors" title="Start Production immediately">
                                <Play className="h-5 w-5" />
                             </button>
                             <button onClick={() => handleRejectPlan(plan.id)} className="p-1.5 text-danger-600 hover:bg-danger-50 hover:text-danger-700 rounded-md transition-colors" title="Reject">
                                <XSquare className="h-5 w-5" />
                             </button>
                          </div>
                       </TableCell>
                     </TableRow>
                   ))
                 )}
               </TableBody>
             </Table>
          )}

          {activeTab === "orders" && (
             <Table>
               <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider">
                 <TableRow>
                   <TableHead className="py-3 px-6">PO ID</TableHead>
                   <TableHead className="py-3">Supplier</TableHead>
                   <TableHead className="py-3">Items Mapped</TableHead>
                   <TableHead className="py-3">Est. Total</TableHead>
                   <TableHead className="py-3">Status</TableHead>
                   <TableHead className="py-3 text-right px-6">HQ Actions</TableHead>
                 </TableRow>
               </TableHeader>
               <TableBody>
                 {pendingOrders.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12 text-neutral-500">
                         No auto-generated purchase orders pending approval.
                      </TableCell>
                    </TableRow>
                 ) : (
                   pendingOrders.map(order => {
                     const supplier = suppliers.find(s => s.id === order.supplierId);
                     return (
                       <TableRow key={order.id} className="hover:bg-neutral-50/50">
                         <TableCell className="px-6 font-medium text-sm text-neutral-900">{order.id}</TableCell>
                         <TableCell>
                            <div className="font-bold text-neutral-900">{supplier?.name || "Unknown"}</div>
                            <div className="text-xs text-neutral-500">{order.notes}</div>
                         </TableCell>
                         <TableCell>
                            <span className="text-sm font-bold text-neutral-700 bg-neutral-100 px-2 py-1 rounded-md">
                              {order.items} Items
                            </span>
                         </TableCell>
                         <TableCell className="font-bold text-success-700">
                            ${order.total.toFixed(2)}
                         </TableCell>
                         <TableCell>
                            <Badge variant="neutral" className="bg-warning-100 text-warning-800 border-none font-bold">
                              {order.status}
                            </Badge>
                         </TableCell>
                         <TableCell className="text-right px-6">
                            <div className="flex justify-end gap-2">
                               <button onClick={() => handleApproveOrder(order.id)} className="p-1.5 text-success-600 hover:bg-success-50 hover:text-success-700 rounded-md transition-colors" title="Approve PO">
                                  <CheckCircle2 className="h-5 w-5" />
                               </button>
                               <button onClick={() => handleRejectOrder(order.id)} className="p-1.5 text-danger-600 hover:bg-danger-50 hover:text-danger-700 rounded-md transition-colors" title="Reject PO">
                                  <XSquare className="h-5 w-5" />
                               </button>
                            </div>
                         </TableCell>
                       </TableRow>
                     )
                   })
                 )}
               </TableBody>
             </Table>
          )}

        </CardContent>
      </Card>

      {/* Already Approved Display Matrix */}
      <h3 className="text-lg font-bold tracking-tight mt-12 mb-4 text-neutral-800 border-b border-neutral-200 pb-2">Recently Orchestrated</h3>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
         <Card className="shadow-sm border-neutral-200">
           <CardHeader className="bg-neutral-50/50 pb-3 border-b border-neutral-100">
              <CardTitle className="text-sm font-bold text-neutral-700 flex items-center gap-2">
                 <ClipboardList className="h-4 w-4 text-neutral-500" /> Active Production
              </CardTitle>
           </CardHeader>
           <CardContent className="p-0">
             <div className="divide-y divide-neutral-100">
                {productionPlans.filter(p => p.status === "Approved" || p.status === "In Production").slice(0, 5).map(plan => (
                   <div key={plan.id} className="p-3 flex justify-between items-center text-sm">
                      <div>
                         <span className="font-bold text-neutral-900">{plan.fgName}</span> 
                         <span className="text-neutral-500 ml-2">({plan.id})</span>
                      </div>
                      <Badge variant="neutral" className={plan.status === "In Production" ? "bg-brand-100 text-brand-800 border-none" : "bg-success-100 text-success-800 border-none"}>
                         {plan.status}
                      </Badge>
                   </div>
                ))}
             </div>
           </CardContent>
         </Card>

         <Card className="shadow-sm border-neutral-200">
           <CardHeader className="bg-neutral-50/50 pb-3 border-b border-neutral-100">
              <CardTitle className="text-sm font-bold text-neutral-700 flex items-center gap-2">
                 <ShoppingCart className="h-4 w-4 text-neutral-500" /> Active Auto-POs
              </CardTitle>
           </CardHeader>
           <CardContent className="p-0">
             <div className="divide-y divide-neutral-100">
                {orders.filter(o => o.createdBy === "Auto Engine" && (o.status === "Approved" || o.status === "Sent")).slice(0, 5).map(order => (
                   <div key={order.id} className="p-3 flex justify-between items-center text-sm">
                      <div>
                         <span className="font-bold text-neutral-900">{order.id}</span> 
                         <span className="text-neutral-500 ml-2">- ${order.total.toFixed(2)}</span>
                      </div>
                      <Badge variant="neutral" className="bg-success-100 text-success-800 border-none">
                         {order.status}
                      </Badge>
                   </div>
                ))}
             </div>
           </CardContent>
         </Card>
      </div>
    </div>
  );
}
