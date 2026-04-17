"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { 
  Factory, 
  Search, 
  PackagePlus,
  AlertTriangle,
  History,
  CheckCircle2,
  PackageCheck,
  TrendingUp,
  RefreshCw,
  Upload
} from "lucide-react";
import { 
  loadRecipes,
  loadInventory,
  saveInventory,
  loadRequisitions,
  saveRequisitions,
  loadProductionHistory,
  saveProductionHistory,
  logMovement
} from "@/lib/storage";
import { normalizeUnit } from "@/lib/units";
import { FgImportModal } from "@/components/FgImportModal";


export default function FinishedGoods() {
  const [recipes, setRecipes] = useState<any[]>([]);
  const [inventoryData, setInventoryData] = useState<any[]>([]);
  const [requisitions, setRequisitions] = useState<any[]>([]);
  const [productionHistory, setProductionHistory] = useState<any[]>([]);
  
  const [searchQuery, setSearchQuery] = useState("");
  
  const [selectedFG, setSelectedFG] = useState<any>(null);
  const [produceBatches, setProduceBatches] = useState<number>(1);
  const [isAutoFulfillMode, setIsAutoFulfillMode] = useState<boolean>(false);
  const [isImportOpen, setIsImportOpen] = useState(false);

  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
       setIsLoading(true);
       try {
          const [rec, inv, req, hist] = await Promise.all([
             loadRecipes(),
             loadInventory(),
             loadRequisitions(),
             loadProductionHistory()
          ]);
          setRecipes(Array.isArray(rec) ? rec : []);
          setInventoryData(Array.isArray(inv) ? inv : []);
          setRequisitions(Array.isArray(req) ? req : []);
          setProductionHistory(Array.isArray(hist) ? hist : []);
       } catch (err) {
          console.error(err);
       } finally {
          setIsLoading(false);
       }
    }
    fetchData();
  }, []);

  if (isLoading) return <div className="p-12 flex justify-center text-neutral-400 animate-pulse">Loading Finished Goods...</div>;

  const finishedGoods = inventoryData.filter(i => i.itemType === "Finished Good" || i.itemType === "Preparation");

  // Compute overall backorders per FG mapped explicitly to Requisitions
  const reqBackorders = new Map();
  const requestedCounts = new Map();

  requisitions.forEach(req => {
     req.lineItems.forEach((li: any) => {
        // Track overall popularity
        requestedCounts.set(li.id, (requestedCounts.get(li.id) || 0) + li.requestedQty);

        // Track open backorders
        if (req.status === "Partial" || req.status === "Approved" || req.status === "Backordered") {
           const remaining = li.requestedQty - (li.fulfilledQty || 0);
           if (remaining > 0) {
              reqBackorders.set(li.id, (reqBackorders.get(li.id) || 0) + remaining);
           }
        }
     });
  });

  // Calculate top requested item
  let topRequestedId = "N/A";
  let maxReqs = 0;
  requestedCounts.forEach((val, id) => {
     if (val > maxReqs) {
       maxReqs = val;
       topRequestedId = id;
     }
  });
  const topRequestedName = finishedGoods.find(fg => fg.id === topRequestedId)?.name || "N/A";

  // Calculate highest backordered item
  let maxBackorderId = "N/A";
  let maxBackCount = 0;
  reqBackorders.forEach((val, id) => {
     if (val > maxBackCount) {
       maxBackCount = val;
       maxBackorderId = id;
     }
  });
  const topBackorderName = finishedGoods.find(fg => fg.id === maxBackorderId)?.name || "None";

  const totalSKUs = finishedGoods.length;
  
  const totalBackorders = Array.from(reqBackorders.values()).reduce((a: number, b: number) => a + b, 0);

  const producedToday = productionHistory.filter(ph => {
      const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return ph.date === today;
  }).length;

  const filteredFGs = finishedGoods.filter(fg => {
    if (searchQuery) {
      if (!fg.name.toLowerCase().includes(searchQuery.toLowerCase()) && !fg.id.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
    }
    return true;
  });

  // Calculate constraints
  const getProductionConstraints = (fg: any, batches: number) => {
     const recipe = recipes.find(r => r.outputItemId?.toString() === fg.id.toString());
     if (!recipe || !recipe.ingredients) return { valid: true, shortages: [], maxBatches: -1, yield: 0, ingredientsCheck: [] };
     
     let valid = true;
     const shortages: any[] = [];
     let maxBatches = Infinity;

     const ingredientsCheck = recipe.ingredients.map((ing: any) => {
        const rawItem = inventoryData.find((i: any) => i.id.toString() === ing.inventoryId.toString());
        const inStock = rawItem ? rawItem.inStock : 0;
        
        let requiredTotal = 0;
        let short = false;
        let possibleCount = 0;
        let conversionError = "";
        
        try {
           const normalizedQty = normalizeUnit(ing.qty, ing.unit, rawItem ? rawItem.unit : ing.unit);
           requiredTotal = normalizedQty * batches;
           short = requiredTotal > inStock;
           if (short) valid = false;
           
           possibleCount = inStock > 0 ? Math.floor(inStock / normalizedQty) : 0;
           if (possibleCount < maxBatches) maxBatches = possibleCount;
        } catch (e: any) {
           valid = false;
           conversionError = e.message;
           maxBatches = 0;
        }

        if (short || conversionError) {
           shortages.push({
             name: ing.name || (rawItem ? rawItem.name : "Unknown"),
             required: requiredTotal,
             available: inStock,
             unit: rawItem ? rawItem.unit : ing.unit,
             error: conversionError
           });
        }
        
        return {
           name: ing.name || (rawItem ? rawItem.name : "Unknown"),
           requiredTotal,
           inStock,
           unit: rawItem ? rawItem.unit : ing.unit,
           isShort: short || !!conversionError,
           error: conversionError
        };
     });

     return {
        valid,
        shortages,
        maxBatches: maxBatches === Infinity ? 0 : maxBatches,
        yield: recipe.yieldQty * batches,
        unit: recipe.yieldUnit,
        ingredientsCheck
     };
  };

  const activeConstraints = selectedFG ? getProductionConstraints(selectedFG, produceBatches) : null;

  const executeProduction = async (fg: any, targetBatches: number, autoFulfill: boolean) => {
     const rule = getProductionConstraints(fg, targetBatches);
     const recipe = recipes.find(r => r.outputItemId?.toString() === fg.id.toString());
     if (!recipe || !rule) return;

     // 1. Deduct Inventory
     const _inv = [...inventoryData];
     recipe.ingredients.forEach((ing: any) => {
         const matchIndex = _inv.findIndex((i: any) => i.id.toString() === ing.inventoryId.toString());
         if (matchIndex !== -1) {
            try {
              const normalizedQty = normalizeUnit(ing.qty, ing.unit, _inv[matchIndex].unit);
              _inv[matchIndex].inStock -= (normalizedQty * targetBatches);
              
              // Prevent negative stock due to tiny floats
              if (_inv[matchIndex].inStock < 0) _inv[matchIndex].inStock = 0;
            } catch (e) {
              console.error("Failed to deduct inventory safely:", e);
            }
         }
     });
     
     // 2. Increment Finished Good Stock (Inside core _inv array)
     const yieldAmount = recipe.yieldQty * targetBatches;
     const fgIndex = _inv.findIndex((f: any) => f.id.toString() === fg.id.toString());
     
     if (fgIndex !== -1) {
        _inv[fgIndex].inStock += yieldAmount;
        _inv[fgIndex].lastProduced = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
     }

     // 3. Log History
     const newLog = {
        id: `PRD-${1000 + productionHistory.length}`,
        fgId: fg.id,
        fgName: fg.name,
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        batches: targetBatches,
        yield: yieldAmount,
        status: "Completed"
     };

     const _hist = [newLog, ...productionHistory];
     const histRes = await saveProductionHistory(_hist);
     if (!histRes?.success) {
        alert(`Database Error (Save Production log): ${histRes?.error?.message}`);
        return;
     }
     setProductionHistory(_hist);

     let alertMsg = `Successfully produced ${targetBatches} batches of ${fg.name} yielding ${yieldAmount} ${recipe.yieldUnit}!`;

     // 4. Auto Fulfill if Requested
     if (autoFulfill && fgIndex !== -1) {
        const _reqs = [...requisitions];
        let fulfilledTotal = 0;

        _reqs.forEach((r, rIdx) => {
           if (r.status === "Approved" || r.status === "Partial" || r.status === "Backordered") {
              let allLineItemsDone = true;

              const updatedLines = r.lineItems.map((li: any) => {
                 if (li.id.toString() === fg.id.toString()) {
                    const remainingGap = li.requestedQty - (li.fulfilledQty || 0);
                    if (remainingGap > 0) {
                       const hqStock = _inv[fgIndex].inStock;
                       if (hqStock >= remainingGap) {
                          _inv[fgIndex].inStock -= remainingGap;
                          fulfilledTotal += remainingGap;
                          return { ...li, fulfilledQty: li.requestedQty };
                       } else if (hqStock > 0) {
                          _inv[fgIndex].inStock = 0;
                          fulfilledTotal += hqStock;
                          allLineItemsDone = false;
                          return { ...li, fulfilledQty: (li.fulfilledQty || 0) + hqStock };
                       }
                    }
                 }
                 // Check if ANY item in req is still incomplete
                 if ((li.requestedQty - (li.fulfilledQty || 0)) > 0) {
                    allLineItemsDone = false;
                 }
                 return li;
              });

              _reqs[rIdx].lineItems = updatedLines;
              
              if (allLineItemsDone) {
                 _reqs[rIdx].status = "Fulfilled";
              } else {
                 _reqs[rIdx].status = "Partial";
              }
           }
        });

        const reqRes = await saveRequisitions(_reqs);
        if (!reqRes?.success) {
           alert(`Database Error (Save Requisitions): ${reqRes?.error?.message}`);
           return;
        }
        setRequisitions(_reqs);
        alertMsg += ` Auto-fulfilled ${fulfilledTotal} ${recipe.yieldUnit} directly to lingering Requisitions.`;
     }

     const invRes = await saveInventory(_inv);
     if (!invRes?.success) {
        alert(`Database Error (Save Inventory): ${invRes?.error?.message}`);
        return;
     }
     setInventoryData(_inv);

     // ── Log movements (fire-and-forget, non-fatal) ─────────────────────────────
     // Runs after saveInventory so failures never block primary operation.
     (async () => {
       // a) cogs_out: one row per ingredient consumed
       //    item_id  = inventory_items.id (row PK, TEXT)
       //    locationId = the inventory row's locationId (HQ where production runs)
       for (const ing of recipe.ingredients) {
         const rawItem = inventoryData.find((i: any) => i.id.toString() === ing.inventoryId.toString());
         if (!rawItem) continue;

         let normalizedQty = 0;
         try {
           normalizedQty = normalizeUnit(ing.qty, ing.unit, rawItem.unit) * targetBatches;
         } catch {
           normalizedQty = ing.qty * targetBatches;
         }
         if (normalizedQty <= 0) continue;

         await logMovement({
           locationId:    rawItem.locationId ?? 'LOC-HQ',
           itemId:        String(rawItem.id),
           movementType:  'cogs_out',
           quantity:      normalizedQty,
           unitCost:      rawItem.cost ?? null,
           referenceType: 'production',
           referenceId:   newLog.id,
           notes:         `Production run: ${targetBatches}x ${fg.name} — consumed ${normalizedQty} ${rawItem.unit} ${rawItem.name}`,
         });
       }

       // b) production_in: one row for finished good yield
       //    Tracks what was gained so movement ledger stays balanced.
       const fgItem = inventoryData.find((f: any) => f.id.toString() === fg.id.toString());
       if (fgItem && yieldAmount > 0) {
         await logMovement({
           locationId:    fgItem.locationId ?? 'LOC-HQ',
           itemId:        String(fgItem.id),
           movementType:  'production_in',
           quantity:      yieldAmount,
           unitCost:      fgItem.cost ?? null,
           referenceType: 'production',
           referenceId:   newLog.id,
           notes:         `Production output: ${targetBatches} batches of ${fg.name}`,
         });
       }
     })();
     // ─────────────────────────────────────────────────────────────
     
     setSelectedFG(null);
     setProduceBatches(1);
     setIsAutoFulfillMode(false);
     
     alert(alertMsg);
  };

  const openAutoFulfillModule = (e: any, fg: any) => {
     e.stopPropagation();
     const demand = reqBackorders.get(fg.id) || 0;
     const recipe = recipes.find(r => r.outputItemId?.toString() === fg.id.toString());
     
     if (demand <= 0 || !recipe) {
       alert("No open backorders found for this item, or Recipe is missing.");
       return;
     }

     // Calculate minimum batches required mathematically to meet backorder demand completely
     const theoreticalBatchesRequired = Math.ceil(demand / recipe.yieldQty);
     
     setSelectedFG(fg);
     setProduceBatches(theoreticalBatchesRequired);
     setIsAutoFulfillMode(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">HQ Finished Goods</h2>
          <p className="text-neutral-500">Track central kitchen outputs, batch processes, and execute auto-fulfillment mappings.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsImportOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 shadow-sm transition-colors"
          >
            <Upload className="h-4 w-4" /> Import CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { label: "Total FG SKUs", value: totalSKUs.toString(), color: "text-neutral-900" },
          { label: "Top Requested Item", value: topRequestedName, color: "text-brand-600" },
          { label: "Highest Backorder Item", value: topBackorderName, color: "text-warning-600" },
          { label: "Total Backorder Volume", value: totalBackorders.toString(), color: "text-danger-600" }
        ].map((stat, i) => (
          <Card key={i} className="shadow-sm border-neutral-200">
            <CardContent className="p-4 flex flex-col gap-1 text-center sm:text-left">
              <span className="text-xs text-neutral-500 font-medium">{stat.label}</span>
              <span className={`text-xl font-bold ${stat.color} truncate`}>{stat.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="shadow-sm border-neutral-200 overflow-hidden">
        <CardHeader className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:items-center justify-between pb-4 border-b border-neutral-100 bg-white">
          <div className="relative w-full sm:w-[500px]">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-neutral-400" />
            </div>
            <input 
              type="text" 
              placeholder="Search Finished Goods..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-4 py-1.5 border border-neutral-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 w-full bg-neutral-50 hover:bg-white transition-colors"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider">
              <TableRow>
                <TableHead className="px-6 py-3">Finished Good / SKU</TableHead>
                <TableHead className="py-3">Current Stock</TableHead>
                <TableHead className="py-3">Available To Fulfill</TableHead>
                <TableHead className="py-3">Backorders</TableHead>
                <TableHead className="px-6 py-3 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredFGs.length > 0 ? filteredFGs.map((fg) => {
                 const backorders = reqBackorders.get(fg.id) || 0;
                 const available = Math.max(0, fg.inStock - backorders);

                 return (
                  <TableRow 
                    key={fg.id} 
                    className="cursor-pointer transition-colors hover:bg-neutral-50/50"
                  >
                    <TableCell className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Factory className="h-4 w-4 text-neutral-400" />
                        <div>
                          <p className="font-semibold text-brand-900">{fg.name}</p>
                          <p className="text-xs text-neutral-500">{fg.id} / linked to ({recipes.find((r: any) => r.outputItemId?.toString() === fg.id.toString())?.name || "No Recipe"})</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-4">
                      <span className="font-medium text-neutral-900">{fg.inStock} {fg.unit}</span>
                    </TableCell>
                    <TableCell className="py-4">
                      <span className={`font-bold ${available === 0 ? "text-neutral-400" : "text-success-600"}`}>
                        {available} {fg.unit}
                      </span>
                    </TableCell>
                    <TableCell className="py-4">
                      {backorders > 0 ? (
                         <Badge variant="danger" className="px-2 py-0.5 text-xs font-semibold bg-danger-50 text-danger-700">
                           {backorders} {fg.unit} Backordered
                         </Badge>
                      ) : (
                         <span className="text-neutral-400 text-sm">--</span>
                      )}
                    </TableCell>
                    <TableCell className="px-6 py-4 text-right flex items-center justify-end gap-2">
                       {backorders > 0 && (
                          <button 
                            onClick={(e) => openAutoFulfillModule(e, fg)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-warning-50 text-warning-700 hover:bg-warning-100 hover:text-warning-800 rounded-md text-xs font-semibold transition-colors border border-warning-200 shadow-sm"
                          >
                            <RefreshCw className="h-3.5 w-3.5" /> Auto-Fulfill
                          </button>
                       )}
                       <button 
                         onClick={(e) => {
                            e.stopPropagation();
                            setProduceBatches(1);
                            setSelectedFG(fg);
                            setIsAutoFulfillMode(false);
                         }}
                         className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-brand-50 text-brand-700 hover:bg-brand-100 hover:text-brand-800 rounded-md text-xs font-semibold transition-colors"
                       >
                         <PackagePlus className="h-3.5 w-3.5" /> Produce
                       </button>
                    </TableCell>
                  </TableRow>
                 )
              }) : (
                 <TableRow>
                   <TableCell colSpan={6} className="text-center py-10 text-neutral-500 text-sm">
                      No matching goods located.
                   </TableCell>
                 </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Production Drawer */}
      <Drawer
        isOpen={!!selectedFG}
        onClose={() => { setSelectedFG(null); setProduceBatches(1); setIsAutoFulfillMode(false); }}
        title={isAutoFulfillMode ? `Auto-Fulfill Backorder: ${selectedFG?.name}` : `Produce ${selectedFG?.name}`}
        description={isAutoFulfillMode ? `Algorithmically mapping raw constraints to clear location backorders natively.` : `Calculate required raw ingredients directly mapping to theoretical recipe rules.`}
        footer={
          <div className="w-full flex items-center justify-between">
            <div className="flex flex-col">
               <span className="text-sm font-medium text-neutral-500">
                  Projected Yield: <span className="text-brand-600 font-bold">{activeConstraints?.yield} {activeConstraints?.unit}</span>
               </span>
               {isAutoFulfillMode && (
                  <span className="text-xs font-medium text-danger-500 mt-1">
                    Open Backorders: {(reqBackorders.get(selectedFG?.id) || 0)} {activeConstraints?.unit}
                  </span>
               )}
            </div>
            
            <div className="flex items-center gap-3">
               <button 
                 className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors shadow-sm"
                 onClick={() => { setSelectedFG(null); setProduceBatches(1); setIsAutoFulfillMode(false); }}
               >
                 Cancel
               </button>
               {(!activeConstraints || activeConstraints.valid) ? (
                 <button 
                   className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors shadow-sm flex items-center gap-2 disabled:opacity-50 ${isAutoFulfillMode ? 'bg-warning-600 hover:bg-warning-700' : 'bg-brand-600 hover:bg-brand-700'}`}
                   onClick={() => executeProduction(selectedFG, produceBatches, isAutoFulfillMode)}
                   disabled={!activeConstraints}
                 >
                   {isAutoFulfillMode ? <RefreshCw className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                   {isAutoFulfillMode ? "Fulfill Mapped Backorders" : "Finalize Production"}
                 </button>
               ) : (
                 <button 
                   className="px-4 py-2 text-sm font-medium bg-neutral-800 text-white rounded-lg hover:bg-neutral-900 transition-colors shadow-sm flex items-center gap-2 disabled:opacity-50"
                   onClick={() => executeProduction(selectedFG, activeConstraints.maxBatches, isAutoFulfillMode)}
                   disabled={activeConstraints.maxBatches <= 0}
                 >
                   <PackageCheck className="h-4 w-4" /> Produce Max Bounds ({activeConstraints.maxBatches})
                 </button>
               )}
            </div>
          </div>
        }
      >
        <div className="space-y-6">
           <div className="flex flex-col sm:flex-row sm:items-start gap-4">
               {isAutoFulfillMode && activeConstraints && !activeConstraints.valid && activeConstraints.maxBatches > 0 && (
                  <div className="w-full flex items-start gap-3 bg-brand-50 text-brand-800 p-4 rounded-lg border border-brand-200">
                     <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-brand-600" />
                     <div className="flex flex-col gap-1">
                        <p className="font-semibold text-sm">Optimal Supply Constrained</p>
                        <p className="text-xs text-brand-700 max-w-lg leading-relaxed">
                          Your physical raw inventory restricts you from completing this entire backorder sequence. You require <span className="font-bold underline">{produceBatches} batches</span> to satisfy demand, but are restricted to a maximum threshold of <span className="font-bold underline">{activeConstraints.maxBatches} batches</span>. Execute the <b>Produce Max</b> constraint to partially fulfill stores.
                        </p>
                     </div>
                  </div>
               )}
           </div>
           
           <div className="flex items-center gap-4 bg-neutral-50 border border-neutral-200 rounded-lg p-4">
             <div className="flex-1">
               <h4 className="text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-2">Production Threshold Batches</h4>
               <div className="flex items-center gap-2">
                 <button 
                   className="w-8 h-8 rounded bg-white border border-neutral-300 text-neutral-600 font-bold hover:bg-neutral-100 transition-colors focus:outline-none"
                   onClick={() => setProduceBatches(Math.max(1, produceBatches - 1))}
                 >-</button>
                 <span className="text-xl font-bold w-12 text-center text-neutral-900">{produceBatches}</span>
                 <button 
                   className="w-8 h-8 rounded bg-white border border-neutral-300 text-neutral-600 font-bold hover:bg-neutral-100 transition-colors focus:outline-none"
                   onClick={() => setProduceBatches(produceBatches + 1)}
                 >+</button>
               </div>
             </div>
             
             {activeConstraints && !activeConstraints.valid && (
                <div className="flex items-start gap-2 bg-danger-50 text-danger-800 p-3 rounded-lg border border-danger-100 text-sm font-medium w-[240px]">
                   <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                   <div>
                     <p>Insufficient Raw Yields</p>
                     <p className="text-xs opacity-90 mt-0.5 font-normal">Physical stock limits block this configuration entirely.</p>
                   </div>
                </div>
             )}
           </div>

           <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden mt-6">
              <Table>
                <TableHeader className="bg-neutral-50/50 text-[11px] uppercase text-neutral-500 tracking-wider">
                  <TableRow>
                    <TableHead>Raw Ingredient</TableHead>
                    <TableHead>Required Gap</TableHead>
                    <TableHead>Active HQ Supply</TableHead>
                    <TableHead className="text-right">Block Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeConstraints?.ingredientsCheck.map((ing: any, idx: number) => (
                    <TableRow key={`ing-${idx}`} className={`hover:bg-neutral-50/50 ${ing.isShort ? 'bg-danger-50/30' : ''}`}>
                      <TableCell>
                        <div className="font-medium text-sm text-neutral-900">{ing.name}</div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm font-bold text-neutral-800">{ing.requiredTotal} {ing.unit}</span>
                      </TableCell>
                      <TableCell>
                         <span className={`text-sm font-semibold ${ing.isShort ? "text-danger-600" : "text-neutral-600"}`}>
                           {ing.inStock} {ing.unit}
                         </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {ing.error ? (
                           <Badge variant="danger" className="text-xs px-2 py-0.5 border-none bg-danger-100 text-danger-800" title={ing.error}>Unit Conflict</Badge>
                        ) : ing.isShort ? (
                           <Badge variant="danger" className="text-xs px-2 py-0.5 border-none">Shortage (-{(ing.requiredTotal - ing.inStock).toFixed(2)})</Badge>
                        ) : (
                           <Badge variant="success" className="text-xs px-2 py-0.5 border-none bg-success-100 text-success-800">Available Limit</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
           </div>
        </div>
      </Drawer>

      {/* ── CSV Import Modal ─────────────────────────────────────────────── */}
      <FgImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        existingNames={finishedGoods.map((fg: any) => fg.name)}
        onSuccess={() => window.location.reload()}
      />

    </div>
  );
}
