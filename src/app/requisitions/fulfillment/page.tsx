"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/components/AuthProvider";
import { getFulfillmentSummary, saveFulfillmentAllocations, completeFulfillmentMovement, createDeliveryTicketFromRequisition } from "@/lib/storage";
import { isHqFulfillment, isHqMaster, isHqOps } from "@/lib/roles";
import { ChevronDown, ChevronRight, Search, Save, Check, RefreshCw, AlertTriangle, Play, Sparkles, Truck, PackageCheck } from "lucide-react";

export default function FulfillmentPage() {
  const { user } = useAuth();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Expanded items state
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});

  // Filter States
  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  // Track modified rows locally
  // key: line_id, value: { allocatedQty: number, backorderQty: number, fulfillmentNote: string, dirty: boolean }
  const [drafts, setDrafts] = useState<Record<string, { allocatedQty: number; backorderQty: number; fulfillmentNote: string; dirty: boolean }>>({});

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await getFulfillmentSummary();
      setData(result);
      
      // Initialize drafts
      const initialDrafts: typeof drafts = {};
      for (const group of result) {
        for (const item of group.items) {
          initialDrafts[item.id] = {
            allocatedQty: item.allocatedQty,
            backorderQty: item.backorderQty,
            fulfillmentNote: item.fulfillmentNote,
            dirty: false
          };
        }
      }
      setDrafts(initialDrafts);
    } catch (e) {
      console.error("Failed to load fulfillment summary:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  // Guard access
  const isAllowed = isHqMaster(user) || isHqOps(user) || isHqFulfillment(user);

  // Unique list of locations for filtering
  const locations = useMemo(() => {
    const locSet = new Set<string>();
    for (const group of data) {
      for (const item of group.items) {
        if (item.locationName) locSet.add(item.locationName);
      }
    }
    return Array.from(locSet).sort();
  }, [data]);

  // Filtered Grouped Items
  const filteredData = useMemo(() => {
    return data.map(group => {
      // Filter the items inside the group first
      const filteredItems = group.items.filter((item: any) => {
        const matchLocation = locationFilter === "all" || item.locationName === locationFilter;
        const matchStatus = statusFilter === "all" || item.requisitionStatus === statusFilter;
        return matchLocation && matchStatus;
      });

      // Compute filtered totals based on current drafts
      let totalReq = 0;
      let totalAlloc = 0;
      let totalBO = 0;

      for (const item of filteredItems) {
        const draft = drafts[item.id] || { allocatedQty: item.allocatedQty, backorderQty: item.backorderQty };
        totalReq += item.quantityRequested;
        totalAlloc += draft.allocatedQty;
        totalBO += draft.backorderQty;
      }

      return {
        ...group,
        items: filteredItems,
        totalRequested: totalReq,
        totalAllocated: totalAlloc,
        totalBackorder: totalBO
      };
    }).filter(group => {
      // Filter the main group by search query and ensure it has items
      const matchSearch = group.itemName.toLowerCase().includes(search.toLowerCase());
      return matchSearch && group.items.length > 0;
    });
  }, [data, search, locationFilter, statusFilter, drafts]);

  const toggleExpand = (itemName: string) => {
    setExpandedItems(prev => ({
      ...prev,
      [itemName]: !prev[itemName]
    }));
  };

  const handleFieldChange = (itemId: string, field: "allocatedQty" | "backorderQty" | "fulfillmentNote", val: any) => {
    setDrafts(prev => {
      const current = prev[itemId] || { allocatedQty: 0, backorderQty: 0, fulfillmentNote: "", dirty: false };
      const updated = { ...current, [field]: val, dirty: true };
      
      // Auto-calculate backorder if allocated quantity is edited
      if (field === "allocatedQty") {
        const item = findItemInOriginalData(itemId);
        if (item) {
          const reqQty = item.quantityRequested;
          updated.backorderQty = Math.max(0, reqQty - Number(val));
        }
      }
      
      return {
        ...prev,
        [itemId]: updated
      };
    });
  };

  const findItemInOriginalData = (itemId: string) => {
    for (const group of data) {
      const found = group.items.find((i: any) => i.id === itemId);
      if (found) return found;
    }
    return null;
  };

  // Helper for auto allocate full quantity on a group
  const handleAutoAllocateGroup = (groupName: string) => {
    const group = data.find(g => g.itemName === groupName);
    if (!group) return;

    setDrafts(prev => {
      const updated = { ...prev };
      for (const item of group.items) {
        updated[item.id] = {
          allocatedQty: item.quantityRequested,
          backorderQty: 0,
          fulfillmentNote: updated[item.id]?.fulfillmentNote || "",
          dirty: true
        };
      }
      return updated;
    });
  };

  // Helper to mark a row short
  const handleMarkShortRow = (itemId: string, shortAmount: number) => {
    const item = findItemInOriginalData(itemId);
    if (!item) return;

    setDrafts(prev => {
      const current = prev[itemId] || { allocatedQty: item.allocatedQty, backorderQty: item.backorderQty, fulfillmentNote: "" };
      const newAllocated = Math.max(0, item.quantityRequested - shortAmount);
      return {
        ...prev,
        [itemId]: {
          allocatedQty: newAllocated,
          backorderQty: shortAmount,
          fulfillmentNote: current.fulfillmentNote,
          dirty: true
        }
      };
    });
  };

  const handleSave = async () => {
    const modifiedList = Object.entries(drafts)
      .filter(([_, d]) => d.dirty)
      .map(([id, d]) => ({
        id,
        allocatedQty: Number(d.allocatedQty),
        backorderQty: Number(d.backorderQty),
        fulfillmentNote: d.fulfillmentNote,
        userId: user?.id || ""
      }));

    if (modifiedList.length === 0) {
      setToast("No changes to save.");
      return;
    }

    setSaving(true);
    try {
      const res = await saveFulfillmentAllocations(modifiedList);
      if (res.success) {
        setToast("Allocations saved successfully!");
        await loadData();
      } else {
        alert(`Failed to save: ${res.error?.message ?? "Unknown error"}`);
      }
    } catch (e) {
      console.error(e);
      alert("Error saving allocations.");
    } finally {
      setSaving(false);
    }
  };

  const [completingId, setCompletingId] = useState<string | null>(null);
  const [ticketingId, setTicketingId] = useState<string | null>(null);

  const handleCompleteFulfillment = async (requisitionId: string) => {
    const modifiedList = Object.entries(drafts)
      .filter(([_, d]) => d.dirty)
      .map(([id, d]) => ({
        id,
        allocatedQty: Number(d.allocatedQty),
        backorderQty: Number(d.backorderQty),
        fulfillmentNote: d.fulfillmentNote,
        userId: user?.id || ""
      }));

    setCompletingId(requisitionId);
    try {
      if (modifiedList.length > 0) {
        const saveRes = await saveFulfillmentAllocations(modifiedList);
        if (!saveRes.success) {
          alert(`Failed to auto-save allocations: ${saveRes.error?.message}`);
          setCompletingId(null);
          return;
        }
      }

      const res = await completeFulfillmentMovement(requisitionId);
      if (res.success) {
        setToast("Fulfillment completed & stock transferred successfully!");
        await loadData();
      } else {
        alert(`Fulfillment completion failed: ${res.error?.message ?? "Unknown error"}`);
      }
    } catch (e) {
      console.error(e);
      alert("Error completing fulfillment.");
    } finally {
      setCompletingId(null);
    }
  };

  const handleCreateDeliveryTicket = async (requisitionId: string) => {
    setTicketingId(requisitionId);
    try {
      const res = await createDeliveryTicketFromRequisition(requisitionId);
      if (res.success) {
        setToast(`Delivery Ticket ${res.data?.ticketNumber || ""} created successfully!`);
        await loadData();
      } else {
        alert(`Failed to create delivery ticket: ${res.error?.message ?? "Unknown error"}`);
      }
    } catch (e) {
      console.error(e);
      alert("Error creating delivery ticket.");
    } finally {
      setTicketingId(null);
    }
  };

  // Get visual status of an item group
  const getGroupStatus = (group: any) => {
    const { totalRequested, totalAllocated, totalBackorder } = group;
    
    if (totalAllocated >= totalRequested && totalBackorder === 0) {
      return { label: "Ready", variant: "success" };
    }
    if (totalAllocated + totalBackorder < totalRequested) {
      return { label: "Partially allocated", variant: "warning" };
    }
    if (totalBackorder > 0 && totalAllocated < totalRequested) {
      return { label: "Short", variant: "danger" };
    }
    return { label: "Completed", variant: "brand" };
  };

  if (!isAllowed) {
    return (
      <div className="p-6 text-center text-sm font-semibold text-red-500">
        Access Denied. You do not have permission to view this page.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Requisition Fulfillment</h2>
          <p className="text-neutral-500">Grouped operational view to allocate items to location requisitions.</p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button 
            onClick={loadData}
            disabled={loading}
            className="flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors shadow-sm"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button 
            onClick={handleSave}
            disabled={saving || loading}
            className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors shadow-sm w-full sm:w-auto"
          >
            {saving ? (
              <>Saving...</>
            ) : (
              <>
                <Save className="h-4 w-4" />
                Save Allocation
              </>
            )}
          </button>
        </div>
      </div>

      {toast && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg p-3 text-sm font-semibold flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
          <Check className="h-4 w-4 text-emerald-600" />
          {toast}
        </div>
      )}

      {/* Filter and Search Bar */}
      <Card className="shadow-sm border-neutral-200">
        <CardContent className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="relative min-w-[240px] flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search items by name..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 bg-neutral-50"
            />
          </div>
          
          <select
            value={locationFilter}
            onChange={e => setLocationFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-neutral-700 min-w-[160px]"
          >
            <option value="all">All Locations</option>
            {locations.map(loc => (
              <option key={loc} value={loc}>{loc}</option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-neutral-700 min-w-[160px]"
          >
            <option value="all">All Requisition Statuses</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="partial">Partial</option>
            <option value="backordered">Backordered</option>
          </select>
        </CardContent>
      </Card>

      {/* Main Grouped Items View */}
      {loading ? (
        <div className="text-center py-12 text-neutral-400">Loading fulfillment data...</div>
      ) : filteredData.length === 0 ? (
        <Card className="p-8 text-center border-dashed border-neutral-300">
          <AlertTriangle className="h-8 w-8 text-neutral-400 mx-auto mb-2" />
          <p className="text-sm font-semibold text-neutral-900">No Requisitions Awaiting Fulfillment</p>
          <p className="text-xs text-neutral-500 mt-1">There are no approved or submitted requisitions matching the filters.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredData.map(group => {
            const isExpanded = expandedItems[group.itemName] || false;
            const status = getGroupStatus(group);
            
            return (
              <Card key={group.itemName} className="overflow-hidden border-neutral-200 shadow-sm transition-all hover:shadow-md">
                <CardHeader className="bg-neutral-50/50 py-4 px-5 border-b border-neutral-100 flex flex-row items-center justify-between gap-4">
                  <div className="flex items-center gap-3 cursor-pointer" onClick={() => toggleExpand(group.itemName)}>
                    {isExpanded ? (
                      <ChevronDown className="h-5 w-5 text-neutral-500 shrink-0" />
                    ) : (
                      <ChevronRight className="h-5 w-5 text-neutral-500 shrink-0" />
                    )}
                    <div>
                      <CardTitle className="text-base text-neutral-950 font-bold">{group.itemName}</CardTitle>
                      <CardDescription className="text-xs mt-0.5">
                        {group.isFGMode ? (
                          <>
                            Pack Size: {group.packQty} {group.unit || "ea"} · Total Required: <span className="font-bold text-neutral-900">{group.totalRequested} pack{group.totalRequested !== 1 ? 's' : ''} ({group.totalRequested * group.packQty} {group.unit || "ea"})</span>
                          </>
                        ) : (
                          <>
                            Unit: {group.unit || "ea"} · Total Required: <span className="font-bold text-neutral-900">{group.totalRequested} {group.unit || "ea"}</span>
                          </>
                        )}
                      </CardDescription>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className="hidden sm:flex gap-4 text-xs font-semibold text-neutral-600 bg-white border border-neutral-200 rounded-lg px-3 py-1.5 shadow-sm">
                      {group.isFGMode ? (
                        <>
                          <div>Allocated: <span className="text-brand-600">{group.totalAllocated} pack{group.totalAllocated !== 1 ? 's' : ''} ({group.totalAllocated * group.packQty} {group.unit})</span></div>
                          <div>Backordered: <span className="text-danger-600">{group.totalBackorder} pack{group.totalBackorder !== 1 ? 's' : ''} ({group.totalBackorder * group.packQty} {group.unit})</span></div>
                        </>
                      ) : (
                        <>
                          <div>Allocated: <span className="text-brand-600">{group.totalAllocated} {group.unit}</span></div>
                          <div>Backordered: <span className="text-danger-600">{group.totalBackorder} {group.unit}</span></div>
                        </>
                      )}
                    </div>
                    <Badge variant={status.variant as any}>{status.label}</Badge>
                    <button
                      onClick={() => handleAutoAllocateGroup(group.itemName)}
                      className="text-xs bg-white border border-brand-200 text-brand-700 hover:bg-brand-50 font-bold px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-1 shadow-sm"
                    >
                      <Sparkles className="h-3 w-3" /> Auto Allocate Full Qty
                    </button>
                  </div>
                </CardHeader>
                
                {isExpanded && (
                  <CardContent className="p-0 border-t border-neutral-100">
                    <Table>
                      <TableHeader className="bg-neutral-50/30 text-xs text-neutral-500 uppercase tracking-wider">
                        <TableRow>
                          <TableHead className="px-5 py-2.5 w-[20%]">Location</TableHead>
                          <TableHead className="py-2.5 text-center w-[12%]">Requested</TableHead>
                          <TableHead className="py-2.5 text-center w-[18%]">Allocated</TableHead>
                          <TableHead className="py-2.5 text-center w-[18%]">Backorder Qty</TableHead>
                          <TableHead className="py-2.5 px-4 w-[22%]">Fulfillment Note</TableHead>
                          <TableHead className="py-2.5 text-right px-5 w-[10%]">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.items.map((item: any) => {
                          const draft = drafts[item.id] || { allocatedQty: item.allocatedQty, backorderQty: item.backorderQty, fulfillmentNote: item.fulfillmentNote, dirty: false };
                          
                          return (
                            <TableRow key={item.id} className="hover:bg-neutral-50/30 border-b border-neutral-100 last:border-0">
                              <TableCell className="px-5 py-3.5">
                                <div className="font-semibold text-neutral-900 text-sm">{item.locationName}</div>
                                <div className="text-[10px] text-neutral-500 mt-0.5">
                                  Req: {item.requisitionNumber} · Date: {item.requisitionDate}
                                </div>
                              </TableCell>
                              <TableCell className="py-3.5 text-center text-sm font-semibold text-neutral-700">
                                {item.isFGMode ? (
                                  <>
                                    {item.quantityRequested} pack{item.quantityRequested !== 1 ? 's' : ''} ({item.quantityRequested * (item.packQty || 1)} {item.unit || "ea"})
                                  </>
                                ) : (
                                  <>
                                    {item.quantityRequested} {item.unit || "ea"}
                                  </>
                                )}
                              </TableCell>
                              <TableCell className="py-3.5 px-4">
                                <div className="flex flex-col items-center gap-1">
                                  <input
                                    type="number"
                                    min="0"
                                    step={item.isFGMode ? "1" : "any"}
                                    value={draft.allocatedQty}
                                    onChange={e => {
                                      const val = e.target.value === "" ? 0 : parseFloat(e.target.value);
                                      const resolvedVal = item.isFGMode ? Math.round(val) : val;
                                      handleFieldChange(item.id, "allocatedQty", resolvedVal);
                                    }}
                                    className={`w-full border rounded-lg p-2 text-sm text-center font-semibold focus:outline-none focus:ring-1 focus:ring-brand-500 ${draft.dirty ? "border-amber-300 bg-amber-50/30" : "border-neutral-200 bg-white"}`}
                                  />
                                  {item.isFGMode && (
                                    <span className="text-[10px] text-neutral-500 font-medium">
                                      packs ({draft.allocatedQty * (item.packQty || 1)} {item.unit || "ea"})
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="py-3.5 px-4">
                                <div className="flex flex-col items-center gap-1">
                                  <input
                                    type="number"
                                    min="0"
                                    step={item.isFGMode ? "1" : "any"}
                                    value={draft.backorderQty}
                                    onChange={e => {
                                      const val = e.target.value === "" ? 0 : parseFloat(e.target.value);
                                      const resolvedVal = item.isFGMode ? Math.round(val) : val;
                                      handleFieldChange(item.id, "backorderQty", resolvedVal);
                                    }}
                                    className={`w-full border rounded-lg p-2 text-sm text-center font-semibold focus:outline-none focus:ring-1 focus:ring-brand-500 ${draft.dirty ? "border-amber-300 bg-amber-50/30" : "border-neutral-200 bg-white"}`}
                                  />
                                  {item.isFGMode && (
                                    <span className="text-[10px] text-neutral-500 font-medium">
                                      packs ({draft.backorderQty * (item.packQty || 1)} {item.unit || "ea"})
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="py-3.5 px-4">
                                <input
                                  type="text"
                                  value={draft.fulfillmentNote}
                                  onChange={e => handleFieldChange(item.id, "fulfillmentNote", e.target.value)}
                                  placeholder="Add fulfillment note..."
                                  className={`w-full border rounded-lg p-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 ${draft.dirty ? "border-amber-300 bg-amber-50/30" : "border-neutral-200 bg-white"}`}
                                />
                              </TableCell>
                              <TableCell className="py-3.5 text-right px-5 whitespace-nowrap space-x-2">
                                {item.requisitionStatus !== "fulfilled" ? (
                                  <>
                                    <button
                                      onClick={() => handleMarkShortRow(item.id, item.quantityRequested)}
                                      className="text-xs font-semibold text-danger-700 bg-danger-50 hover:bg-danger-100 px-2.5 py-1.5 rounded-lg border border-danger-200 transition-colors"
                                      title="Mark item as short (sets allocation to 0 and backorders the entire quantity)"
                                    >
                                      Mark Short
                                    </button>
                                    <button
                                      onClick={() => handleCompleteFulfillment(item.requisitionId)}
                                      disabled={completingId !== null}
                                      className="text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1.5 rounded-lg border border-emerald-200 transition-colors inline-flex items-center gap-1"
                                      title="Complete this entire requisition's stock movement and update HQ inventory levels"
                                    >
                                      <PackageCheck className="h-3.5 w-3.5" />
                                      {completingId === item.requisitionId ? "Processing..." : "Complete Fulfillment"}
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    {item.deliveryTicketId ? (
                                      <Badge variant="success" className="font-semibold text-xs py-1 px-2.5">
                                        Ticket: {item.deliveryTicketNumber}
                                      </Badge>
                                    ) : (
                                      <button
                                        onClick={() => handleCreateDeliveryTicket(item.requisitionId)}
                                        disabled={ticketingId !== null}
                                        className="text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 px-2.5 py-1.5 rounded-lg transition-colors inline-flex items-center gap-1 shadow-sm"
                                        title="Generate a delivery ticket using the fulfilled allocations for this requisition"
                                      >
                                        <Truck className="h-3.5 w-3.5" />
                                        {ticketingId === item.requisitionId ? "Creating..." : "Create Delivery Ticket"}
                                      </button>
                                    )}
                                  </>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
