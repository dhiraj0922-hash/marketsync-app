"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Drawer } from "@/components/ui/drawer";
import { Calendar, CheckCircle2, Clock, Smartphone, Play, Save, Send, ShieldCheck, FileEdit, Calculator, ArrowRight } from "lucide-react";
import { loadCounts, saveCounts, loadInventory, saveInventory } from "@/lib/storage";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin, resolveLocationId } from "@/lib/roles";

const locationsData = ["Downtown", "Uptown", "Westside", "HQ"];
const countTypes = ["Daily", "Weekly", "Monthly", "Spot Check"];

export default function Counts() {
  const { user } = useAuth();
  // writeLocationId: used when inserting rows — always a real DB location_id (NOT NULL).
  // resolveLocationId() returns "LOC-HQ" for hq_admin (even when location_id is null in DB).
  const writeLocationId: string = resolveLocationId(user);
  // queryLocationId: null for hq_admin (see all), scoped for location managers.
  const queryLocationId: string | null = isHqAdmin(user) ? null : (user?.locationId ?? null);

  const [counts, setCounts] = useState<any[]>([]);
  const [inventoryData, setInventoryData] = useState<any[]>([]);
  
  // Drawer States
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeCount, setActiveCount] = useState<any>(null); // null = creating new

  // Form States
  const [countName, setCountName] = useState("");
  const [countType, setCountType] = useState("Weekly");
  const [countLocation, setCountLocation] = useState("Downtown");
  const [countItems, setCountItems] = useState<any[]>([]);
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<1|2>(1);

  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const [loadedCounts, loadedInv] = await Promise.all([
          loadCounts(queryLocationId),
          loadInventory()
        ]);
        setCounts(loadedCounts);
        setInventoryData(loadedInv);
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, []);

  if (isLoading) return <div className="animate-pulse flex p-12 text-neutral-400 justify-center">Loading Active Counts...</div>;

  const totalVarianceMTD = counts
    .filter(c => c.status === "Approved")
    .reduce((sum, c) => sum + (c.totalVarianceValue || 0), 0);

  const pendingCounts = counts.filter(c => c.status === "Submitted" || c.status === "Draft").length;

  const openNewCountDrawer = () => {
    setActiveCount(null);
    setCountName(`Count Session ${new Date().toLocaleDateString()}`);
    setCountType("Weekly");
    setCountLocation("Downtown");
    setNotes("");
    setCountItems([]);
    setStep(1);
    setDrawerOpen(true);
  };

  const openDraftDrawer = (count: any) => {
    setActiveCount(count);
    setCountName(count.name);
    setCountType(count.type);
    setCountLocation(count.location);
    setNotes(count.notes || "");
    setCountItems(count.items || []);
    setStep(2);
    setDrawerOpen(true);
  };

  const beginCounting = () => {
    if (countItems.length === 0) {
      // Scope snapshot to this user's location so only relevant items are counted
      const scopedInv = writeLocationId
        ? inventoryData.filter((inv: any) => inv.locationId === writeLocationId)
        : inventoryData;
      const liveSnapshot = scopedInv.map((inv: any) => ({
        id: inv.id,
        name: inv.name,
        unit: inv.unit,
        cost: inv.cost,
        theoreticalQty: inv.inStock,
        physicalQty: "",
        variance: 0,
        varianceValue: 0
      }));
      setCountItems(liveSnapshot);
    }
    setStep(2);
  };

  const updatePhysicalQty = (id: number, value: string) => {
    const parsed = value === "" ? "" : parseFloat(value);
    setCountItems(prev => prev.map(item => {
      if (item.id === id) {
        const physical = parsed === "" ? 0 : (parsed as number);
        const variance = physical - item.theoreticalQty;
        return {
          ...item,
          physicalQty: value,
          variance,
          varianceValue: variance * item.cost
        };
      }
      return item;
    }));
  };

  const currentTotalVariance = countItems.reduce((sum, item) => sum + (item.varianceValue || 0), 0);

  const saveCountSession = async (status: "Draft" | "Submitted" | "Approved") => {
    let newCountsList = [...counts];
    const finalDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const updatedCountObj = {
      id: activeCount?.id || `CNT-${1000 + counts.length + 1}`,
      name: countName,
      type: countType,
      status: status,
      date: finalDate,
      location: countLocation,
      locationId: writeLocationId,   // required NOT NULL in counts table
      items: countItems,
      totalVarianceValue: currentTotalVariance,
      notes: notes
    };

    if (activeCount) {
      newCountsList = newCountsList.map(c => c.id === activeCount.id ? updatedCountObj : c);
    } else {
      newCountsList.unshift(updatedCountObj);
    }

    // IF APPROVED -> MUTATE THE MASTER INVENTORY!!
    if (status === "Approved") {
      let newInventory = [...inventoryData];
      countItems.forEach(countedItem => {
         if (countedItem.physicalQty !== "" && countedItem.physicalQty !== undefined) {
           const invIdx = newInventory.findIndex(inv => inv.id === countedItem.id);
           if (invIdx > -1) {
             newInventory[invIdx].inStock = parseFloat(countedItem.physicalQty as string);
           }
         }
      });
      const invRes = await saveInventory(newInventory);
      if (!invRes?.success) {
         alert(`Database Error (Inventory Update): ${invRes?.error?.message}`);
         return;
      }
      setInventoryData(newInventory);
    }

    const countsRes = await saveCounts(newCountsList);
    if (!countsRes?.success) {
       alert(`Database Error (Save Counts): ${countsRes?.error?.message}`);
       return;
    }
    setCounts(newCountsList);
    setDrawerOpen(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Physical Counts</h2>
          <p className="text-neutral-500">Track and manage daily, weekly, and monthly inventory counts.</p>
        </div>
        <button 
          onClick={openNewCountDrawer}
          className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm w-full sm:w-auto"
        >
          <Play className="h-4 w-4" />
          Start New Count
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-brand-50 border-brand-100 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2 text-brand-900">
              <Smartphone className="h-5 w-5 text-brand-600" />
              Mobile Counting
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-neutral-700 mb-4 font-medium">
              Staff can use their phones to enter physical counts directly into the system workflow.
            </p>
            <button className="text-brand-700 text-sm font-bold bg-white border border-brand-200 px-3 py-1.5 rounded hover:bg-brand-50 transition-colors shadow-sm">
              Copy Link
            </button>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
           <CardContent className="p-5 flex flex-col justify-center h-full">
            <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-1">Items Pending Review</h3>
            <div className="text-3xl font-bold text-warning-600">{pendingCounts}</div>
            <p className="text-xs text-neutral-400 mt-2">Active Drafts or Submitted sessions awaiting manager lock.</p>
           </CardContent>
        </Card>

        <Card className="shadow-sm border-l-4 border-l-brand-500">
           <CardContent className="p-5 flex flex-col justify-center h-full">
            <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-1">Approved Variance (MTD)</h3>
            <div className={`text-3xl font-bold ${totalVarianceMTD < 0 ? 'text-danger-600' : 'text-success-600'}`}>
              {totalVarianceMTD > 0 ? '+' : ''}${totalVarianceMTD.toFixed(2)}
            </div>
            <p className="text-xs text-neutral-400 mt-2">Sum of logged variance cost impact.</p>
           </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm border-neutral-200">
        <CardHeader className="border-b border-neutral-100 bg-white">
          <CardTitle className="text-base text-neutral-800">Recent & Scheduled Counts</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/80 text-xs uppercase text-neutral-500">
              <TableRow>
                <TableHead className="px-6">Session ID & Name</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right px-6">Logged Variance ($)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {counts.map((count) => {
                 let statusBadge = "neutral";
                 if (count.status === "Approved") statusBadge = "success";
                 if (count.status === "Submitted") statusBadge = "brand";
                 if (count.status === "Draft") statusBadge = "warning";

                 return (
                  <TableRow 
                    key={count.id} 
                    className="hover:bg-neutral-50/50 cursor-pointer transition-colors"
                    onClick={() => openDraftDrawer(count)}
                  >
                    <TableCell className="px-6 py-4">
                      <div className="font-semibold text-neutral-900 group-hover:text-brand-600 transition-colors flex items-center gap-2">
                         <Calculator className="h-4 w-4 text-neutral-400" />
                         {count.name}
                      </div>
                      <div className="text-xs text-neutral-500 mt-0.5">{count.id} • {count.type}</div>
                    </TableCell>
                    <TableCell className="text-sm font-medium text-neutral-700">{count.location}</TableCell>
                    <TableCell className="text-sm text-neutral-500 flex items-center gap-1.5 py-5">
                      <Calendar className="h-3.5 w-3.5" />
                      {count.date}
                    </TableCell>
                    <TableCell>
                       <Badge variant={statusBadge as any}>{count.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right px-6">
                      {count.status === "Draft" ? (
                        <span className="text-neutral-400 text-xs italic">In Progress</span>
                      ) : (
                        <span className={`font-semibold ${count.totalVarianceValue < 0 ? "text-danger-600" : count.totalVarianceValue > 0 ? "text-success-600" : "text-neutral-500"}`}>
                          {count.totalVarianceValue > 0 ? "+" : ""}${count.totalVarianceValue?.toFixed(2) || "0.00"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
              {counts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-6 text-sm text-neutral-500">
                    No active or historical counts found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Count Drawer Interface */}
      <Drawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={activeCount ? `${activeCount.name} (${activeCount.status})` : "Start New physical Count"}
        description={step === 1 ? "Configure the count parameters." : "Record physical quantities below."}
        footer={
          <div className="w-full flex items-center justify-between">
            <button 
              className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors"
              onClick={() => setDrawerOpen(false)}
            >
              Cancel
            </button>
            
            {step === 1 && (
               <button 
                className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm flex items-center gap-2"
                onClick={beginCounting}
               >
                 Go to Counter <ArrowRight className="h-4 w-4" />
               </button>
            )}

            {step === 2 && activeCount?.status !== "Approved" && (
               <div className="flex items-center gap-2">
                 <button 
                  className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors flex items-center gap-2"
                  onClick={() => saveCountSession("Draft")}
                 >
                   <Save className="h-4 w-4" /> Save Draft
                 </button>
                 
                 {activeCount?.status === "Submitted" ? (
                    <button 
                      className="px-4 py-2 text-sm font-medium bg-success-600 text-white rounded-lg hover:bg-success-700 transition-colors shadow-sm flex items-center gap-2"
                      onClick={() => saveCountSession("Approved")}
                      title="Overrides master inventory values with counted amounts."
                    >
                      <ShieldCheck className="h-4 w-4" /> Approve & Update Inventory
                    </button>
                 ) : (
                    <button 
                      className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm flex items-center gap-2"
                      onClick={() => saveCountSession("Submitted")}
                    >
                      <Send className="h-4 w-4" /> Submit for Review
                    </button>
                 )}
               </div>
            )}
          </div>
        }
      >
        <div className="space-y-6">
           {step === 1 ? (
             <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Count Session Name</label>
                  <input 
                    type="text" 
                    className="w-full bg-white border border-neutral-200 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                    value={countName}
                    onChange={(e) => setCountName(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Type</label>
                    <select 
                      className="w-full bg-white border border-neutral-200 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                      value={countType}
                      onChange={(e) => setCountType(e.target.value)}
                    >
                      {countTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider">Location</label>
                    <select 
                      className="w-full bg-white border border-neutral-200 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                      value={countLocation}
                      onChange={(e) => setCountLocation(e.target.value)}
                    >
                      {locationsData.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-900 uppercase tracking-wider flex items-center gap-1">
                    <FileEdit className="h-3.5 w-3.5" /> General Notes
                  </label>
                  <textarea 
                    className="w-full bg-white border border-neutral-200 rounded-lg p-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 min-h-[80px]"
                    placeholder="Any specific instructions for this count session..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>
             </div>
           ) : (
             <div className="space-y-4">
                <div className="flex justify-between items-end mb-2">
                  <div className="text-sm font-medium text-neutral-700">Displaying <span className="text-brand-600 font-bold">{countItems.length}</span> Items</div>
                  <div className="text-sm text-neutral-500 bg-neutral-100 px-3 py-1.5 rounded-lg border border-neutral-200 font-medium">
                     Running Variance: <span className={currentTotalVariance < 0 ? 'text-danger-600 font-bold' : currentTotalVariance > 0 ? 'text-success-600 font-bold' : 'text-neutral-900'}>{currentTotalVariance > 0 ? "+" : ""}${currentTotalVariance.toFixed(2)}</span>
                  </div>
                </div>

                <div className="border border-neutral-200 rounded-lg bg-white overflow-hidden shadow-sm">
                   <Table>
                      <TableHeader className="bg-neutral-50 border-b border-neutral-200 text-xs text-neutral-500 uppercase tracking-wider">
                         <TableRow>
                           <TableHead className="py-2">Item</TableHead>
                           <TableHead className="py-2 text-center">Expected</TableHead>
                           <TableHead className="py-2 w-[120px]">Physical Count</TableHead>
                           <TableHead className="py-2 text-right">Variance Ext.</TableHead>
                         </TableRow>
                      </TableHeader>
                      <TableBody>
                        {countItems.map((item) => {
                          const isShort = item.variance < 0;
                          const isOver = item.variance > 0;
                          const hasInput = item.physicalQty !== "";
                          
                          return (
                            <TableRow key={item.id} className="hover:bg-neutral-50 border-b border-neutral-100 last:border-0">
                               <TableCell className="py-3 px-4">
                                  <div className="font-semibold text-neutral-900 text-sm">{item.name}</div>
                                  <div className="text-[10px] text-neutral-500">${item.cost.toFixed(2)} / {item.unit}</div>
                               </TableCell>
                               <TableCell className="py-3 px-4 text-center">
                                  <span className="text-sm font-medium text-neutral-500">{item.theoreticalQty}</span>
                               </TableCell>
                               <TableCell className="py-3 px-4">
                                  <input 
                                    type="number"
                                    min="0"
                                    step="0.1"
                                    disabled={activeCount?.status === "Approved"}
                                    className={`w-full border rounded p-2 text-sm text-center font-semibold focus:outline-none focus:ring-2 ${hasInput && isShort ? 'border-danger-300 focus:ring-danger-500 bg-danger-50' : hasInput && isOver ? 'border-brand-300 focus:ring-brand-500 bg-brand-50' : 'border-neutral-300 focus:ring-neutral-500 bg-white'}`}
                                    placeholder="Qty..."
                                    value={item.physicalQty}
                                    onChange={(e) => updatePhysicalQty(item.id, e.target.value)}
                                  />
                               </TableCell>
                               <TableCell className="py-3 px-4 text-right">
                                  {hasInput ? (
                                    <div className="flex flex-col items-end">
                                      <span className={`text-sm font-bold ${isShort ? 'text-danger-600' : isOver ? 'text-success-600' : 'text-neutral-500'}`}>
                                        {item.variance > 0 ? "+" : ""}{item.variance} {item.unit}
                                      </span>
                                      <span className={`text-[10px] ${isShort ? 'text-danger-500' : isOver ? 'text-success-500' : 'text-neutral-400'}`}>
                                        {item.varianceValue > 0 ? "+" : ""}${item.varianceValue.toFixed(2)}
                                      </span>
                                    </div>
                                  ) : (
                                    <span className="text-xs text-neutral-400 italic">--</span>
                                  )}
                               </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                   </Table>
                </div>
             </div>
           )}
        </div>
      </Drawer>

    </div>
  );
}
