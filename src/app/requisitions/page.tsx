"use client";

import React, { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { 
  Inbox, 
  Search, 
  CheckCircle2, 
  XSquare,
  PackageCheck,
  MapPin,
  Clock,
  Sparkles,
  CircleDollarSign,
  Printer,
  ChevronDown,
  ChevronRight,
  ClipboardList
} from "lucide-react";
import { 
  loadRequisitions, 
  saveRequisitions, 
  loadFinishedGoods,
  saveFinishedGoods
} from "@/lib/storage";

const locationsData = ["Downtown", "Uptown", "Westside", "North Hills", "South Point"];

export default function Requisitions() {
  const [requisitions, setRequisitions] = useState<any[]>([]);
  const [finishedGoods, setFinishedGoods] = useState<any[]>([]);
  
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterLocation, setFilterLocation] = useState("All");

  const [selectedReq, setSelectedReq] = useState<any>(null);
  const [selectedReqIds, setSelectedReqIds] = useState<string[]>([]);
  
  const [activeTab, setActiveTab] = useState<"overview" | "hq-production">("overview");
  const [productionDate, setProductionDate] = useState<string>(new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  const [expandedRows, setExpandedRows] = useState<string[]>([]);

  useEffect(() => {
    setRequisitions(loadRequisitions());
    setFinishedGoods(loadFinishedGoods());
  }, []);

  // Compute values
  const getReqValue = (req: any) => {
    return req.lineItems.reduce((sum: number, li: any) => {
      const fg = finishedGoods.find(f => f.id === li.id);
      return sum + ((li.fulfilledQty || 0) * (fg?.valuePerUnit || 0));
    }, 0);
  };

  const getReqRequestedValue = (req: any) => {
    return req.lineItems.reduce((sum: number, li: any) => {
      const fg = finishedGoods.find(f => f.id === li.id);
      return sum + ((li.requestedQty || 0) * (fg?.valuePerUnit || 0));
    }, 0);
  };

  // Compute metrics
  const pendingCount = requisitions.filter(r => r.status === "Draft" || r.status === "Submitted").length;
  const backorderCount = requisitions.filter(r => r.status === "Partial" || r.status === "Backordered").length;
  
  let locValues = new Map();
  let totalValueSupplied = 0;

  requisitions.forEach(r => {
    if (r.status === "Fulfilled" || r.status === "Partial") {
       const val = getReqValue(r);
       locValues.set(r.location, (locValues.get(r.location) || 0) + val);
       totalValueSupplied += val;
    }
  });

  let topLocation = "N/A";
  let maxVal = 0;
  locValues.forEach((v, k) => {
    if (v > maxVal) { maxVal = v; topLocation = k; }
  });

  const filteredReqs = requisitions.filter(r => {
    if (filterStatus !== "All" && r.status !== filterStatus) return false;
    if (filterLocation !== "All" && r.location !== filterLocation) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!r.id.toLowerCase().includes(q) && !r.location.toLowerCase().includes(q) && !r.requestedBy.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });

  // Mock Request Generator
  const createMockRequest = () => {
    if (finishedGoods.length === 0) return;
    const loc = locationsData[Math.floor(Math.random() * locationsData.length)];
    const names = ["Alex R.", "Sarah J.", "Mike T.", "David W.", "Jessica K."];
    const user = names[Math.floor(Math.random() * names.length)];
    
    // Pick 1-3 random items
    const numItems = Math.floor(Math.random() * 3) + 1;
    const items = [];
    const usedIds = new Set();
    
    for(let i = 0; i < numItems; i++) {
       const candidate = finishedGoods[Math.floor(Math.random() * finishedGoods.length)];
       if(!candidate || usedIds.has(candidate.id)) continue;
       usedIds.add(candidate.id);
       
       items.push({
         id: candidate.id,
         name: candidate.name,
         unit: candidate.unit,
         requestedQty: Math.floor(Math.random() * 15) + 5,
         fulfilledQty: 0,
         currentStock: candidate.currentStock
       });
    }

    if (items.length === 0) return;

    const newReq = {
      id: `REQ-${2000 + requisitions.length + 1}`,
      location: loc,
      requestedBy: user,
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      status: "Submitted",
      items: items.length,
      notes: "Auto-generated mock request for HQ Finished Goods.",
      lineItems: items
    };

    const newArr = [newReq, ...requisitions];
    setRequisitions(newArr);
    saveRequisitions(newArr);
  };

  const handleUpdateReqStatus = (reqId: string, newStatus: string) => {
    const newArr = requisitions.map(r => {
      if (r.id === reqId) {
        return { ...r, status: newStatus };
      }
      return r;
    });
    setRequisitions(newArr);
    saveRequisitions(newArr);
    
    if (selectedReq && selectedReq.id === reqId) {
      setSelectedReq({ ...selectedReq, status: newStatus });
    }
  };

  const handleToggleSelect = (reqId: string) => {
    if (selectedReqIds.includes(reqId)) {
      setSelectedReqIds(selectedReqIds.filter(id => id !== reqId));
    } else {
      setSelectedReqIds([...selectedReqIds, reqId]);
    }
  };

  const handleFulfillSelected = (forceIds?: string[]) => {
    const targets = forceIds || selectedReqIds;
    if (targets.length === 0) return;
    
    const selectedList = requisitions.filter(r => targets.includes(r.id));
    if (selectedList.some(r => r.status !== "Approved" && r.status !== "Partial" && r.status !== "Backordered")) {
      alert("Only 'Approved', 'Partial', or 'Backordered' requests can be fulfilled.");
      return;
    }

    const _fgStock = [...finishedGoods];
    const _reqs = [...requisitions];

    let fullSuccess = true;
    let partialCount = 0;

    selectedList.forEach(req => {
       const reqIndex = _reqs.findIndex(r => r.id === req.id);
       if (reqIndex === -1) return;
       
       let allItemsFulfilled = true;
       
       const updatedLineItems = req.lineItems.map((li: any) => {
          const fgIndex = _fgStock.findIndex(f => f.id === li.id);
          if (fgIndex === -1) {
            allItemsFulfilled = false;
            return li;
          }

          const remainingDemand = li.requestedQty - (li.fulfilledQty || 0);
          if (remainingDemand <= 0) return li; // Already fulfilled

          const availableStock = _fgStock[fgIndex].currentStock;
          
          if (availableStock >= remainingDemand) {
             _fgStock[fgIndex].currentStock -= remainingDemand;
             return { ...li, fulfilledQty: (li.fulfilledQty || 0) + remainingDemand };
          } else if (availableStock > 0) {
             _fgStock[fgIndex].currentStock = 0; 
             allItemsFulfilled = false;
             fullSuccess = false;
             return { ...li, fulfilledQty: (li.fulfilledQty || 0) + availableStock };
          } else {
             allItemsFulfilled = false;
             fullSuccess = false;
             return li;
          }
       });

       _reqs[reqIndex].lineItems = updatedLineItems;
       
       if (allItemsFulfilled) {
         _reqs[reqIndex].status = "Fulfilled";
       } else {
         _reqs[reqIndex].status = "Partial";
         partialCount++;
       }
    });

    setFinishedGoods(_fgStock);
    saveFinishedGoods(_fgStock);

    setRequisitions(_reqs);
    saveRequisitions(_reqs);
    
    setSelectedReqIds([]);

    if (selectedReq) {
      const updatedMatch = _reqs.find(r => r.id === selectedReq.id);
      if (updatedMatch) setSelectedReq(updatedMatch);
    }
    
    if (fullSuccess) {
      alert(`Successfully fulfilled selected requisitions!`);
    } else {
      alert(`${partialCount} requisition(s) could only be partially fulfilled and are in backorder.`);
    }
  };

  const hqProductionDemand = () => {
    const relevantReqs = requisitions.filter(r => 
      r.date === productionDate && 
      (r.status === "Approved" || r.status === "Submitted" || r.status === "Draft" || r.status === "Partial" || r.status === "Backordered")
    );

    const agg: Record<string, { totalQty: number, unit: string, locations: { loc: string, qty: number }[] }> = {};
    
    relevantReqs.forEach(req => {
      req.lineItems.forEach((li: any) => {
         const remainingQty = li.requestedQty - (li.fulfilledQty || 0);
         if (remainingQty > 0) {
            if (!agg[li.name]) {
               agg[li.name] = { totalQty: 0, unit: li.unit, locations: [] };
            }
            agg[li.name].totalQty += remainingQty;
            
            const existingLoc = agg[li.name].locations.find(l => l.loc === req.location);
            if (existingLoc) {
               existingLoc.qty += remainingQty;
            } else {
               agg[li.name].locations.push({ loc: req.location, qty: remainingQty });
            }
         }
      });
    });

    return agg;
  };

  const productionData = hqProductionDemand();
  const productionEntries = Object.entries(productionData);
  const toggleExpand = (itemName: string) => {
    setExpandedRows(prev => prev.includes(itemName) ? prev.filter(i => i !== itemName) : [...prev, itemName]);
  };


  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 print:hidden">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Store Requisitions</h2>
          <p className="text-neutral-500">Manage store demands and route them against HQ central kitchen Finished Goods.</p>
        </div>
        <div className="flex bg-neutral-100 p-1 rounded-lg border border-neutral-200 shadow-inner">
           <button 
             onClick={() => setActiveTab('overview')}
             className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${activeTab === 'overview' ? 'bg-white text-brand-700 shadow-sm' : 'text-neutral-600 hover:text-neutral-900'}`}
           >
             Store Requisitions
           </button>
           <button 
             onClick={() => setActiveTab('hq-production')}
             className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${activeTab === 'hq-production' ? 'bg-white text-brand-700 shadow-sm' : 'text-neutral-600 hover:text-neutral-900'}`}
           >
             <ClipboardList className="h-4 w-4" />
             HQ Production
           </button>
        </div>
      </div>

     {activeTab === "overview" ? (
      <>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 print:hidden">
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <button 
            onClick={createMockRequest}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-neutral-100 border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-200 shadow-sm w-full sm:w-auto transition-colors"
          >
            <Sparkles className="h-4 w-4 text-brand-500" />
            + Mock Store Req
          </button>
          <button 
            onClick={() => handleFulfillSelected()}
            disabled={selectedReqIds.length === 0}
            className={`flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg shadow-sm w-full sm:w-auto transition-colors ${selectedReqIds.length > 0 ? "bg-brand-600 text-white hover:bg-brand-700" : "bg-neutral-200 text-neutral-400 cursor-not-allowed"}`}
          >
            <PackageCheck className="h-4 w-4" />
            Fulfill ({selectedReqIds.length}) Requests
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { label: "Pending Workflow", value: pendingCount.toString(), color: "text-warning-600" },
          { label: "Open Backorders", value: backorderCount.toString(), color: "text-danger-600" },
          { label: "Top Consuming Location", value: topLocation, color: "text-brand-600" },
          { label: "Total Value Supplied", value: `$${totalValueSupplied.toFixed(2)}`, color: "text-success-600" }
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
              placeholder="Search Req ID, location, or requester..." 
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
               <option value="Submitted">Submitted</option>
               <option value="Approved">Approved</option>
               <option value="Partial">Partial</option>
               <option value="Backordered">Backordered</option>
               <option value="Fulfilled">Fulfilled</option>
               <option value="Rejected">Rejected</option>
            </select>
            <select 
               className="px-3 py-1.5 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg outline-none focus:ring-1 focus:ring-brand-500 shadow-sm transition-colors"
               value={filterLocation}
               onChange={(e) => setFilterLocation(e.target.value)}
            >
               <option value="All">All Locations</option>
               {locationsData.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider">
              <TableRow>
                <TableHead className="w-[40px] px-6 py-3">
                  <input 
                    type="checkbox" 
                    className="rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                     onChange={(e) => {
                       if (e.target.checked) {
                         const approvedReqs = filteredReqs.filter(r => r.status === "Approved" || r.status === "Partial" || r.status === "Backordered").map(r => r.id);
                         const combined = Array.from(new Set([...selectedReqIds, ...approvedReqs]));
                         setSelectedReqIds(combined);
                       } else {
                         setSelectedReqIds([]);
                       }
                    }}
                  />
                </TableHead>
                <TableHead className="py-3">Request ID</TableHead>
                <TableHead className="py-3">Location</TableHead>
                <TableHead className="py-3">Requested By</TableHead>
                <TableHead className="py-3">Date</TableHead>
                <TableHead className="py-3">Items</TableHead>
                <TableHead className="py-3">Value Supplied</TableHead>
                <TableHead className="py-3">Status</TableHead>
                <TableHead className="px-6 py-3 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredReqs.length > 0 ? filteredReqs.map((req) => (
                  <TableRow 
                  key={req.id} 
                  className={`cursor-pointer transition-colors hover:bg-neutral-50/50 ${selectedReqIds.includes(req.id) ? 'bg-brand-50/30' : ''}`}
                  onClick={(e) => {
                     if ((e.target as HTMLElement).closest('input[type="checkbox"]')) return;
                     setSelectedReq(req);
                  }}
                >
                  <TableCell className="px-6">
                    <input 
                      type="checkbox"
                      checked={selectedReqIds.includes(req.id)}
                      onChange={() => handleToggleSelect(req.id)}
                      disabled={req.status !== "Approved" && req.status !== "Partial" && req.status !== "Backordered"}
                      className="rounded border-neutral-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                    />
                  </TableCell>
                  <TableCell className="py-4 font-semibold text-brand-900">
                    <div className="flex items-center gap-2 group-hover:text-brand-600 transition-colors">
                      <Inbox className="h-4 w-4 text-neutral-400" />
                      {req.id}
                    </div>
                  </TableCell>
                  <TableCell className="py-4 font-medium text-neutral-900 text-sm">
                    <div className="flex items-center gap-1.5">
                       <MapPin className="h-3.5 w-3.5 text-neutral-400" />
                       {req.location}
                    </div>
                  </TableCell>
                  <TableCell className="py-4 text-sm text-neutral-600">{req.requestedBy}</TableCell>
                  <TableCell className="py-4 text-sm text-neutral-500 flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-neutral-400" /> {req.date}
                  </TableCell>
                  <TableCell className="py-4 text-sm font-medium text-neutral-700">{req.items}</TableCell>
                  <TableCell className="py-4 text-sm font-semibold text-success-600">
                    ${getReqValue(req).toFixed(2)}
                  </TableCell>
                  <TableCell className="py-4">
                    <Badge 
                      variant={req.status === "Approved" ? "default" : req.status === "Fulfilled" ? "success" : req.status === "Rejected" ? "danger" : "warning"}
                      className={req.status === "Draft" || req.status === "Submitted" ? "bg-warning-50 text-warning-700" : req.status === "Partial" || req.status === "Backordered" ? "bg-danger-50 text-danger-700" : ""}
                    >
                      {req.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-6 py-4 text-right">
                     <span className="text-brand-600 hover:text-brand-700 text-sm font-medium transition-colors">Review</span>
                  </TableCell>
                </TableRow>
              )) : (
                 <TableRow>
                   <TableCell colSpan={9} className="text-center py-10 text-neutral-500 text-sm">
                      No matching requests located.
                   </TableCell>
                 </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Review Requisition Drawer */}
      <Drawer
        isOpen={!!selectedReq}
        onClose={() => setSelectedReq(null)}
        title={`Requisition ${selectedReq?.id}`}
        description={`Submitted by ${selectedReq?.requestedBy} from ${selectedReq?.location} on ${selectedReq?.date}`}
        footer={
          <div className="w-full flex flex-col gap-2">
            <div className="flex items-center justify-between w-full border-t border-neutral-200 pt-4 mt-2">
               <div className="flex flex-col">
                  <span className="text-xs font-semibold uppercase text-neutral-500 tracking-wider">Value Supplied</span>
                  <span className="text-xl font-bold text-success-600 flex items-center gap-1">
                     <CircleDollarSign className="h-5 w-5" />
                     {selectedReq ? getReqValue(selectedReq).toFixed(2) : "0.00"} 
                     <span className="text-sm font-medium text-neutral-400">/ ${selectedReq ? getReqRequestedValue(selectedReq).toFixed(2) : "0.00"}</span>
                  </span>
               </div>
               
               <div className="flex items-center gap-3">
                 {(selectedReq?.status === "Submitted" || selectedReq?.status === "Draft") && (
                   <>
                     <button 
                       className="px-4 py-2 text-sm font-medium bg-white border border-danger-200 text-danger-700 rounded-lg hover:bg-danger-50 transition-colors shadow-sm flex items-center gap-2"
                       onClick={() => handleUpdateReqStatus(selectedReq.id, "Rejected")}
                     >
                       <XSquare className="h-4 w-4" /> Reject
                     </button>
                     <button 
                       className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm flex items-center gap-2"
                       onClick={() => handleUpdateReqStatus(selectedReq.id, "Approved")}
                     >
                       <CheckCircle2 className="h-4 w-4" /> Approve
                     </button>
                   </>
                 )}
                 {(selectedReq?.status === "Approved" || selectedReq?.status === "Partial" || selectedReq?.status === "Backordered") && (
                    <button 
                       className="px-4 py-2 text-sm font-medium bg-success-600 text-white rounded-lg hover:bg-success-700 transition-colors shadow-sm flex items-center gap-2"
                       onClick={() => {
                           handleFulfillSelected([selectedReq.id]);
                       }}
                     >
                       <PackageCheck className="h-4 w-4" /> Fulfill Ready Stock
                    </button>
                 )}
                 {selectedReq?.status === "Fulfilled" && (
                   <span className="px-4 py-2 text-sm font-medium text-success-700 flex items-center gap-2">
                     <CheckCircle2 className="h-4 w-4" /> Completed
                   </span>
                 )}
               </div>
            </div>
          </div>
        }
      >
        <div className="space-y-6">
           <div className="bg-brand-50 border border-brand-100 rounded-lg p-4">
             <h4 className="text-xs font-semibold text-brand-800 uppercase tracking-wider mb-1">Notes / Reason</h4>
             <p className="text-sm text-neutral-700">{selectedReq?.notes || "No notes provided."}</p>
           </div>

           <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden mt-6">
              <Table>
                <TableHeader className="bg-neutral-50/50 text-[11px] uppercase text-neutral-500 tracking-wider">
                  <TableRow>
                    <TableHead>Finished Good</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead>Fulfilled</TableHead>
                    <TableHead>Demand Gap</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedReq?.lineItems?.map((item: any, idx: number) => {
                     const fg = finishedGoods.find(f => f.id === item.id);
                     const isComplete = item.fulfilledQty >= item.requestedQty;
                     const gap = item.requestedQty - (item.fulfilledQty || 0);
                     const unitValue = fg?.valuePerUnit || 0;
                     const itemSuppliedValue = (item.fulfilledQty || 0) * unitValue;
                     
                     return (
                        <TableRow key={`reqitem-${idx}`} className="hover:bg-neutral-50/50">
                          <TableCell>
                            <div className="font-medium text-sm text-neutral-900">{item.name}</div>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs font-medium text-neutral-800">{item.requestedQty} {item.unit}</span>
                          </TableCell>
                          <TableCell>
                             <Badge variant="neutral" className={`text-xs border-none font-bold px-2 py-1 ${isComplete ? "bg-success-100 text-success-800" : "bg-brand-100 text-brand-800"}`}>
                               {item.fulfilledQty || 0} {item.unit}
                             </Badge>
                          </TableCell>
                          <TableCell>
                             {gap > 0 ? (
                               <span className="text-xs font-bold text-danger-600">{gap} {item.unit} backorder</span>
                             ) : (
                               <span className="text-xs font-bold text-neutral-400">0</span>
                             )}
                          </TableCell>
                          <TableCell className="text-right font-medium text-success-700 text-sm">
                             ${itemSuppliedValue.toFixed(2)}
                          </TableCell>
                        </TableRow>
                     )
                  })}
                </TableBody>
              </Table>
           </div>
        </div>
      </Drawer>
      </>
     ) : (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-neutral-100 pb-4 print:border-none print:pb-0">
          <div>
            <h3 className="text-xl font-bold tracking-tight text-neutral-900 print:text-2xl">HQ Production Summary</h3>
            <p className="text-neutral-500 text-sm print:hidden">Centralized preparation queue for selected date.</p>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-2 w-full sm:w-auto mt-4 sm:mt-0 print:hidden">
             <input 
               type="date"
               value={new Date(productionDate).toISOString().split('T')[0]} // Quick conversion natively
               onChange={(e) => {
                 const [y, m, d] = e.target.value.split('-');
                 // Native translation loosely back to requested text formatting
                 const dDate = new Date(Number(y), Number(m)-1, Number(d));
                 setProductionDate(dDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
               }}
               className="px-3 py-1.5 text-sm font-medium border border-neutral-200 text-neutral-700 bg-white rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
             />
             <button 
               onClick={() => window.print()}
               className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-neutral-900 text-white rounded-lg shadow-sm hover:bg-neutral-800 transition-colors w-full sm:w-auto justify-center"
             >
               <Printer className="h-4 w-4" />
               Print Kitchen Sheet
             </button>
          </div>
        </div>
        
        <div className="print:block">
           <div className="hidden print:block text-sm text-neutral-500 mb-4 pb-2 border-b border-neutral-200">
             Date: {productionDate}
           </div>

           {productionEntries.length === 0 ? (
              <div className="text-center py-16 bg-neutral-50 border border-neutral-200 border-dashed rounded-xl">
                 <PackageCheck className="h-12 w-12 text-neutral-300 mx-auto mb-3" />
                 <h3 className="text-lg font-bold text-neutral-900">No Production Required</h3>
                 <p className="text-neutral-500 text-sm mt-1 max-w-sm mx-auto">There are no open requisitions pending fulfillment for {productionDate}.</p>
              </div>
           ) : (
             <div className="overflow-x-auto rounded-xl border border-neutral-200 print:border-none shadow-sm print:shadow-none">
                 <Table className="bg-white print:bg-transparent">
                   <TableHeader className="bg-neutral-50/80 text-xs text-neutral-500 uppercase tracking-wider print:bg-transparent">
                     <TableRow>
                       <TableHead className="w-[40px] px-4 print:px-0">#</TableHead>
                       <TableHead className="py-3 px-4 print:px-0">Item Name</TableHead>
                       <TableHead className="py-3 px-4 print:px-0">Total Quantity</TableHead>
                     </TableRow>
                   </TableHeader>
                   <TableBody>
                     {productionEntries.map(([itemName, data], idx) => {
                       const isExpanded = expandedRows.includes(itemName);
                       return (
                         <React.Fragment key={idx}>
                           <TableRow 
                             className="hover:bg-brand-50/30 cursor-pointer print:hover:bg-transparent"
                             onClick={() => toggleExpand(itemName)}
                           >
                             <TableCell className="px-4 py-3 print:px-0">
                               <div className="print:hidden">
                                 {isExpanded ? <ChevronDown className="h-4 w-4 text-brand-600" /> : <ChevronRight className="h-4 w-4 text-neutral-400" />}
                               </div>
                               <div className="hidden print:block text-neutral-500 font-medium">#{idx+1}</div>
                             </TableCell>
                             <TableCell className="py-3 px-4 print:px-0">
                               <span className="font-bold text-neutral-900 text-base">{itemName}</span>
                             </TableCell>
                             <TableCell className="py-3 px-4 print:px-0">
                               <span className="font-bold text-brand-700 text-base bg-brand-50 print:bg-transparent px-2 py-1 rounded-md">
                                 {data.totalQty} {data.unit}
                               </span>
                             </TableCell>
                           </TableRow>
                           {/* Location Breakdown Map */}
                           {(isExpanded || true) && ( 
                             // NOTE: `true` forced for print. For print, you generally want it expanded.
                             <TableRow className={`bg-neutral-50/50 print:table-row print:bg-transparent ${isExpanded ? 'table-row' : 'hidden print:table-row'}`}>
                               <TableCell colSpan={3} className="px-10 py-3 print:px-4">
                                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 py-2">
                                    {data.locations.map((loc, lIdx) => (
                                      <div key={lIdx} className="flex justify-between items-center text-sm py-1 border-b border-neutral-200 border-dashed last:border-0 print:border-neutral-300">
                                        <span className="text-neutral-600 font-medium">{loc.loc}</span>
                                        <span className="text-neutral-900 font-bold bg-white print:bg-transparent border border-neutral-200 print:border-none px-2 rounded-md shadow-sm print:shadow-none">
                                          {loc.qty} {data.unit}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                               </TableCell>
                             </TableRow>
                           )}
                         </React.Fragment>
                       )
                     })}
                   </TableBody>
                 </Table>
             </div>
           )}
        </div>
      </div>
     )}
    </div>
  );
}
