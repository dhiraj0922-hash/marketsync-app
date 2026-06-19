"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Drawer } from "@/components/ui/drawer";
import { Calendar, CheckCircle2, Clock, Smartphone, Play, Save, Send, ShieldCheck, FileEdit, Calculator, ArrowRight, X, Search, SlidersHorizontal } from "lucide-react";
import { loadCounts, saveCounts, loadInventory, loadLocations, loadSuppliers, updateInventoryItemScoped } from "@/lib/storage";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin, resolveLocationId, isHqFulfillment } from "@/lib/roles";

import { isActiveLocation } from "@/lib/locationRegistry";

// countTypes is static — no need to load from DB
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
  // Live locations from DB — replaces the old hardcoded array
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  // Supplier id → name map for snapshot enrichment
  const [supplierIdToName, setSupplierIdToName] = useState<Map<number, string>>(new Map());
  
  // Drawer States
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeCount, setActiveCount] = useState<any>(null); // null = creating new

  // Form States
  const [countName, setCountName] = useState("");
  const [countType, setCountType] = useState("Weekly");
  // Default to "" until live locations load, then set to first location or user's location
  const [countLocation, setCountLocation] = useState("");
  const [countItems, setCountItems] = useState<any[]>([]);
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<1|2>(1);

  // ── Filter & Sort state (Step 2 count table) ─────────────────────────────
  const [cfSearch,   setCfSearch]   = useState("");
  const [cfCategory, setCfCategory] = useState("All");
  const [cfSupplier, setCfSupplier] = useState("All");
  const [cfStorage,  setCfStorage]  = useState("All");
  const [cfStatus,   setCfStatus]   = useState("All"); // All | Counted | Uncounted | Short | Over
  const [cfSort,     setCfSort]     = useState("alpha"); // alpha | var-high | var-low | low-stock | cost-high | updated

  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const [loadedCounts, loadedInv, loadedLocs, loadedSuppliers] = await Promise.all([
          loadCounts(queryLocationId),
          loadInventory(),
          loadLocations(),
          loadSuppliers(),
        ]);
        setCounts(loadedCounts);
        setInventoryData(loadedInv);

        // Build supplier id → name lookup map
        const supMap = new Map<number, string>();
        if (Array.isArray(loadedSuppliers)) {
          loadedSuppliers.forEach((s: any) => {
            if (s.id != null && s.name) supMap.set(Number(s.id), String(s.name));
          });
        }
        setSupplierIdToName(supMap);

        // Filter to active locations only (case-insensitive status check)
        const activeLocs: { id: string; name: string }[] = Array.isArray(loadedLocs)
          ? loadedLocs
              .filter((l: any) => isActiveLocation(l))
              .map((l: any) => ({ id: l.id, name: l.name }))
          : [];
        setLocations(activeLocs);

        // Set the default location for new count sessions:
        //   - location_manager: pre-select their assigned location name
        //   - hq_admin: pre-select first live location, or empty if none exist
        if (!isHqAdmin(user) && user?.locationId) {
          const myLoc = activeLocs.find((l) => l.id === user.locationId);
          setCountLocation(myLoc?.name ?? user.locationId);
        } else {
          setCountLocation(activeLocs[0]?.name ?? "");
        }
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived filter option lists (MUST be before any early return) ────────
  const cfCategories = useMemo(() => ["All", ...Array.from(new Set(countItems.map(i => String(i.category ?? "Uncategorized")))).sort((a,b) => a.localeCompare(b))], [countItems]);
  const cfSuppliers  = useMemo(() => ["All", ...Array.from(new Set(countItems.map(i => String(i.supplierName ?? "Unknown")))).sort((a,b) => a.localeCompare(b))], [countItems]);
  const cfStorages   = useMemo(() => ["All", ...Array.from(new Set(countItems.map(i => String(i.storageArea  ?? "General")))).sort((a,b) => a.localeCompare(b))], [countItems]);

  // ── Filtered + sorted view (MUST be before any early return) ─────────────
  const filteredCountItems = useMemo(() => {
    let rows = [...countItems];
    const q = cfSearch.trim().toLowerCase();
    if (q) rows = rows.filter(i => String(i.name ?? "").toLowerCase().includes(q));
    if (cfCategory !== "All") rows = rows.filter(i => String(i.category     ?? "Uncategorized") === cfCategory);
    if (cfSupplier !== "All") rows = rows.filter(i => String(i.supplierName ?? "Unknown")       === cfSupplier);
    if (cfStorage  !== "All") rows = rows.filter(i => String(i.storageArea  ?? "General")        === cfStorage);
    if (cfStatus === "Counted")   rows = rows.filter(i => (i.physicalQty ?? "") !== "");
    if (cfStatus === "Uncounted") rows = rows.filter(i => (i.physicalQty ?? "") === "");
    if (cfStatus === "Short")     rows = rows.filter(i => (i.physicalQty ?? "") !== "" && Number(i.variance ?? 0) < 0);
    if (cfStatus === "Over")      rows = rows.filter(i => (i.physicalQty ?? "") !== "" && Number(i.variance ?? 0) > 0);
    if (cfSort === "alpha")     rows.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
    if (cfSort === "var-high")  rows.sort((a, b) => Math.abs(Number(b.varianceValue ?? 0)) - Math.abs(Number(a.varianceValue ?? 0)));
    if (cfSort === "var-low")   rows.sort((a, b) => Math.abs(Number(a.varianceValue ?? 0)) - Math.abs(Number(b.varianceValue ?? 0)));
    if (cfSort === "low-stock") rows.sort((a, b) => (Number(a.theoreticalQty ?? 0) - Number(a.parLevel ?? 0)) - (Number(b.theoreticalQty ?? 0) - Number(b.parLevel ?? 0)));
    if (cfSort === "cost-high") rows.sort((a, b) => Number(b.cost ?? 0) - Number(a.cost ?? 0));
    return rows;
  }, [countItems, cfSearch, cfCategory, cfSupplier, cfStorage, cfStatus, cfSort]);

  const activeFilterCount = [cfSearch, cfCategory !== "All" ? cfCategory : "", cfSupplier !== "All" ? cfSupplier : "", cfStorage !== "All" ? cfStorage : "", cfStatus !== "All" ? cfStatus : ""].filter(Boolean).length;
  const clearAllFilters = () => { setCfSearch(""); setCfCategory("All"); setCfSupplier("All"); setCfStorage("All"); setCfStatus("All"); setCfSort("alpha"); };

  if (isLoading) return <div className="animate-pulse flex p-12 text-neutral-400 justify-center">Loading Active Counts...</div>;

  const totalVarianceMTD = counts
    .filter(c => c.status === "Approved")
    .reduce((sum, c) => sum + (c.totalVarianceValue || 0), 0);

  const pendingCounts = counts.filter(c => c.status === "Submitted" || c.status === "Draft").length;

  const openNewCountDrawer = () => {
    setActiveCount(null);
    setCountName(`Count Session ${new Date().toLocaleDateString()}`);
    setCountType("Weekly");
    // Default: for location_manager keep their location; for HQ use first live location
    if (!isHqAdmin(user) && user?.locationId) {
      const myLoc = locations.find((l) => l.id === user.locationId);
      setCountLocation(myLoc?.name ?? user.locationId);
    } else {
      setCountLocation(locations[0]?.name ?? "");
    }
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
    // Re-enrich items loaded from DB — legacy snapshots lack category/supplierName/storageArea/parLevel.
    // Safe-default every field so filteredCountItems memo never calls .toLowerCase() on undefined.
    const enriched = (count.items || []).map((item: any) => ({
      ...item,
      name:         String(item.name         ?? ""),
      unit:         String(item.unit         ?? "ea"),
      cost:         Number(item.cost         ?? 0),
      category:     String(item.category     ?? "Uncategorized"),
      supplierName: String(item.supplierName ?? "Unknown"),
      storageArea:  String(item.storageArea  ?? "General"),
      parLevel:     Number(item.parLevel     ?? 0),
      theoreticalQty: Number(item.theoreticalQty ?? 0),
      physicalQty:  item.physicalQty ?? "",
      variance:     Number(item.variance     ?? 0),
      varianceValue:Number(item.varianceValue?? 0),
    }));
    setCountItems(enriched);
    setCfSearch(""); setCfCategory("All"); setCfSupplier("All");
    setCfStorage("All"); setCfStatus("All"); setCfSort("alpha");
    setStep(2);
    setDrawerOpen(true);
  };

  const beginCounting = () => {
    if (countItems.length === 0) {
      const scopedInv = writeLocationId
        ? inventoryData.filter((inv: any) => inv.locationId === writeLocationId)
        : inventoryData;
      const liveSnapshot = scopedInv.map((inv: any) => {
        // Resolve real supplier name: map lookup → purchaseOptions name → fallback
        const resolvedSupplier =
          (inv.supplierId != null && supplierIdToName.get(Number(inv.supplierId)))
          || String(inv.preferredSupplierName ?? "")
          || (inv.supplierId ? `Supplier #${inv.supplierId}` : "")  // only as last resort
          || "Unknown Supplier";
        return {
          id: inv.id,
          name: String(inv.name ?? ""),
          unit: String(inv.unit ?? "ea"),
          cost: Number(inv.cost ?? 0),
          category:     String(inv.category  ?? "Uncategorized"),
          supplierName: resolvedSupplier,
          storageArea:  String(inv.itemType  ?? "General"),
          parLevel:     Number(inv.parLevel  ?? 0),
          theoreticalQty: Number(inv.inStock ?? 0),
          physicalQty: "",
          variance: 0,
          varianceValue: 0,
        };
      });
      setCountItems(liveSnapshot);
    }
    setCfSearch(""); setCfCategory("All"); setCfSupplier("All");
    setCfStorage("All"); setCfStatus("All"); setCfSort("alpha");
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
      const updateErrors: string[] = [];
      for (const countedItem of countItems) {
         if (countedItem.physicalQty !== "" && countedItem.physicalQty !== undefined) {
           const invIdx = newInventory.findIndex(inv => inv.id === countedItem.id);
           if (invIdx > -1) {
             const updatedRow = { ...newInventory[invIdx], inStock: parseFloat(countedItem.physicalQty as string) };
             const invRes = await updateInventoryItemScoped(updatedRow, updatedRow.locationId);
             if (!invRes.success) {
               updateErrors.push(`${updatedRow.name}: ${invRes.error?.message ?? 'update failed'}`);
             } else {
               newInventory[invIdx] = updatedRow;
             }
           }
         }
      }
      if (updateErrors.length > 0) {
         alert(`Database Error (Inventory Update): ${updateErrors.join("\n")}`);
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
                    !isHqFulfillment(user) && (
                      <button 
                        className="px-4 py-2 text-sm font-medium bg-success-600 text-white rounded-lg hover:bg-success-700 transition-colors shadow-sm flex items-center gap-2"
                        onClick={() => saveCountSession("Approved")}
                        title="Overrides master inventory values with counted amounts."
                      >
                        <ShieldCheck className="h-4 w-4" /> Approve & Update Inventory
                      </button>
                    )
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
                     {isHqAdmin(user) ? (
                       // HQ admin: full dropdown of all active live locations
                       <select
                         className="w-full bg-white border border-neutral-200 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                         value={countLocation}
                         onChange={(e) => setCountLocation(e.target.value)}
                       >
                         {locations.length === 0 && (
                           <option value="">No locations found…</option>
                         )}
                         {locations.map(l => (
                           <option key={l.id} value={l.name}>{l.name}</option>
                         ))}
                       </select>
                     ) : (
                       // Location manager: locked to their assigned location
                       <div className="w-full bg-neutral-50 border border-neutral-200 rounded-lg py-2 px-3 text-sm text-neutral-700 font-medium flex items-center gap-2">
                         <span className="h-2 w-2 rounded-full bg-brand-500 shrink-0" />
                         {countLocation || user?.locationId || "—"}
                         <input type="hidden" value={countLocation} />
                       </div>
                     )}
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
             <div className="space-y-0">

               {/* ──────────────────────────────── Sticky Filter Bar ─────────────────────────────────────────────────────────── */}
               <div className="sticky top-0 z-20 bg-white border-b border-neutral-200 pb-3 pt-1 mb-3 space-y-2 shadow-sm">

                 {/* Row 1: search + sort */}
                 <div className="flex gap-2">
                   <div className="relative flex-1">
                     <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-400 pointer-events-none" />
                     <input
                       type="text"
                       placeholder="Search items..."
                       value={cfSearch}
                       onChange={e => setCfSearch(e.target.value)}
                       className="w-full pl-8 pr-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 bg-neutral-50"
                     />
                     {cfSearch && (
                       <button onClick={() => setCfSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600">
                         <X className="h-3.5 w-3.5" />
                       </button>
                     )}
                   </div>
                   <select
                     value={cfSort}
                     onChange={e => setCfSort(e.target.value)}
                     className="px-3 py-2 text-xs font-semibold border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500 text-neutral-700"
                   >
                     <option value="alpha">A → Z</option>
                     <option value="var-high">Highest Variance</option>
                     <option value="var-low">Lowest Variance</option>
                     <option value="low-stock">Low Stock First</option>
                     <option value="cost-high">Highest Cost</option>
                   </select>
                 </div>

                 {/* Row 2: dropdown filters */}
                 <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                   <select value={cfCategory} onChange={e => setCfCategory(e.target.value)}
                     className="px-2 py-1.5 text-xs border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500 text-neutral-700">
                     {cfCategories.map(c => <option key={c} value={c}>{c === "All" ? "All Categories" : c}</option>)}
                   </select>
                   <select value={cfSupplier} onChange={e => setCfSupplier(e.target.value)}
                     className="px-2 py-1.5 text-xs border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500 text-neutral-700">
                     {cfSuppliers.map(s => <option key={s} value={s}>{s === "All" ? "All Suppliers" : s}</option>)}
                   </select>
                   <select value={cfStorage} onChange={e => setCfStorage(e.target.value)}
                     className="px-2 py-1.5 text-xs border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500 text-neutral-700">
                     {cfStorages.map(s => <option key={s} value={s}>{s === "All" ? "All Storage Areas" : s}</option>)}
                   </select>
                   <select value={cfStatus} onChange={e => setCfStatus(e.target.value)}
                     className="px-2 py-1.5 text-xs border border-neutral-200 rounded-lg bg-neutral-50 focus:outline-none focus:ring-1 focus:ring-brand-500 text-neutral-700">
                     {["All","Counted","Uncounted","Short","Over"].map(s => <option key={s} value={s}>{s === "All" ? "All Statuses" : s}</option>)}
                   </select>
                 </div>

                 {/* Active filter badges + summary */}
                 <div className="flex items-center justify-between flex-wrap gap-2 pt-0.5">
                   <div className="flex items-center gap-1.5 flex-wrap">
                     <span className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wide flex items-center gap-1">
                       <SlidersHorizontal className="h-3 w-3" />
                       {filteredCountItems.length} of {countItems.length}
                     </span>
                     {cfSearch && (
                       <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-brand-100 text-brand-700 border border-brand-200">
                         "{cfSearch}" <button onClick={() => setCfSearch("")}><X className="h-2.5 w-2.5" /></button>
                       </span>
                     )}
                     {cfCategory !== "All" && (
                       <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-100 text-violet-700 border border-violet-200">
                         {cfCategory} <button onClick={() => setCfCategory("All")}><X className="h-2.5 w-2.5" /></button>
                       </span>
                     )}
                     {cfSupplier !== "All" && (
                       <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                         {cfSupplier} <button onClick={() => setCfSupplier("All")}><X className="h-2.5 w-2.5" /></button>
                       </span>
                     )}
                     {cfStorage !== "All" && (
                       <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-200">
                         {cfStorage} <button onClick={() => setCfStorage("All")}><X className="h-2.5 w-2.5" /></button>
                       </span>
                     )}
                     {cfStatus !== "All" && (
                       <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-neutral-200 text-neutral-700 border border-neutral-300">
                         {cfStatus} <button onClick={() => setCfStatus("All")}><X className="h-2.5 w-2.5" /></button>
                       </span>
                     )}
                   </div>
                   <div className="flex items-center gap-3">
                     {activeFilterCount > 0 && (
                       <button onClick={clearAllFilters} className="text-[10px] font-semibold text-danger-600 hover:text-danger-800 transition-colors">
                         Clear all
                       </button>
                     )}
                     <div className="text-xs text-neutral-500 bg-neutral-100 px-2.5 py-1 rounded-lg border border-neutral-200 font-medium whitespace-nowrap">
                       Variance: <span className={currentTotalVariance < 0 ? 'text-danger-600 font-bold' : currentTotalVariance > 0 ? 'text-success-600 font-bold' : 'text-neutral-700'}>{currentTotalVariance > 0 ? "+" : ""}${currentTotalVariance.toFixed(2)}</span>
                     </div>
                   </div>
                 </div>
               </div>

               {/* ──────────────────────────────── Count Table ────────────────────────────────────────────────────────── */}
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
                        {filteredCountItems.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center py-8 text-sm text-neutral-400 italic">
                              No items match the current filters.
                            </TableCell>
                          </TableRow>
                        )}
                        {filteredCountItems.map((item) => {
                          const cost         = Number(item.cost         ?? 0);
                          const variance     = Number(item.variance     ?? 0);
                          const varianceValue= Number(item.varianceValue?? 0);
                          const parLevel     = Number(item.parLevel     ?? 0);
                          const theoreticalQty = Number(item.theoreticalQty ?? 0);
                          const isShort = variance < 0;
                          const isOver  = variance > 0;
                          const hasInput = (item.physicalQty ?? "") !== "";
                          return (
                            <TableRow key={item.id} className="hover:bg-neutral-50 border-b border-neutral-100 last:border-0">
                               <TableCell className="py-3 px-4">
                                  <div className="font-semibold text-neutral-900 text-sm">{item.name}</div>
                                  <div className="text-[10px] text-neutral-500 flex items-center gap-1.5 mt-0.5">
                                    <span>${cost.toFixed(2)}/{item.unit}</span>
                                    {item.category && item.category !== "Uncategorized" && (
                                      <span className="px-1 py-0.5 bg-neutral-100 rounded">{item.category}</span>
                                    )}
                                    {item.storageArea && item.storageArea !== "General" && (
                                      <span className="px-1 py-0.5 bg-amber-50 text-amber-700 rounded">{item.storageArea}</span>
                                    )}
                                  </div>
                               </TableCell>
                               <TableCell className="py-3 px-4 text-center">
                                  <span className="text-sm font-medium text-neutral-500">{theoreticalQty}</span>
                                  {parLevel > 0 && theoreticalQty < parLevel && (
                                    <div className="text-[9px] text-warning-600 font-semibold">Below par</div>
                                  )}
                               </TableCell>
                               <TableCell className="py-3 px-4">
                                  <input
                                    type="number" min="0" step="0.1"
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
                                        {variance > 0 ? "+" : ""}{variance} {item.unit}
                                      </span>
                                      <span className={`text-[10px] ${isShort ? 'text-danger-500' : isOver ? 'text-success-500' : 'text-neutral-400'}`}>
                                        {varianceValue > 0 ? "+" : ""}${varianceValue.toFixed(2)}
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
