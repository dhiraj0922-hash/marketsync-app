"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/components/AuthProvider";
import { 
  getDeliveryTickets, 
  getDeliveryRuns, 
  addTicketsToDeliveryRun, 
  removeTicketFromDeliveryRun, 
  updateDeliveryTicket 
} from "@/lib/storage";
import { isHqFulfillment, isHqMaster, isHqOps } from "@/lib/roles";
import { ChevronDown, ChevronRight, Search, RefreshCw, AlertTriangle, Truck, Check, Edit2, X, ClipboardList } from "lucide-react";

export default function DispatchTicketsPage() {
  const { user } = useAuth();
  const [tickets, setTickets] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Search and Filter states
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [runFilter, setRunFilter] = useState("all");

  // Expanded tickets list
  const [expandedTickets, setExpandedTickets] = useState<Record<string, boolean>>({});

  const isAllowed = isHqMaster(user) || isHqOps(user) || isHqFulfillment(user);

  const loadData = async () => {
    setLoading(true);
    try {
      const [ticketsList, runsList] = await Promise.all([
        getDeliveryTickets({ showAll: true }),
        getDeliveryRuns({ showAll: false }) // Fetch active/recent runs
      ]);
      setTickets(ticketsList);
      setRuns(runsList.filter((r: any) => r.status !== 'completed' && r.status !== 'cancelled'));
    } catch (e) {
      console.error("Failed to load dispatch ticket data:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAllowed) {
      loadData();
    }
  }, [isAllowed]);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const toggleExpand = (ticketId: string) => {
    setExpandedTickets(prev => ({
      ...prev,
      [ticketId]: !prev[ticketId]
    }));
  };

  const handleAssignRun = async (ticketId: string, runId: string) => {
    setUpdatingId(ticketId);
    try {
      let res;
      if (runId === "unassigned") {
        res = await removeTicketFromDeliveryRun(ticketId);
        if (res.success) {
          setToast("Ticket removed from delivery run.");
        }
      } else {
        res = await addTicketsToDeliveryRun(runId, [ticketId]);
        if (res.success) {
          const run = runs.find(r => r.id === runId);
          setToast(`Ticket assigned to run ${run?.runNumber || ""} successfully!`);
        }
      }

      if (!res.success) {
        alert(`Assignment failed: ${res.error?.message ?? "Unknown error"}`);
      } else {
        await loadData();
      }
    } catch (e) {
      console.error(e);
      alert("Error assigning delivery ticket.");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleStatusChange = async (ticketId: string, status: string) => {
    setUpdatingId(ticketId);
    try {
      const res = await updateDeliveryTicket(ticketId, { status });
      if (res.success) {
        setToast(`Ticket status updated to ${status} successfully!`);
        await loadData();
      } else {
        alert(`Status update failed: ${res.error?.message ?? "Unknown error"}`);
      }
    } catch (e) {
      console.error(e);
      alert("Error updating ticket status.");
    } finally {
      setUpdatingId(null);
    }
  };

  // Filtered tickets
  const filteredTickets = useMemo(() => {
    return tickets.filter(ticket => {
      const matchSearch = 
        ticket.ticketNumber.toLowerCase().includes(search.toLowerCase()) ||
        ticket.destinationName.toLowerCase().includes(search.toLowerCase()) ||
        (ticket.deliveryRun?.runNumber ?? "").toLowerCase().includes(search.toLowerCase());
      
      const matchStatus = statusFilter === "all" || ticket.status === statusFilter;
      
      const matchRun = 
        runFilter === "all" ? true :
        runFilter === "assigned" ? !!ticket.deliveryRunId :
        runFilter === "unassigned" ? !ticket.deliveryRunId :
        ticket.deliveryRunId === runFilter;

      return matchSearch && matchStatus && matchRun;
    });
  }, [tickets, search, statusFilter, runFilter]);

  const getStatusBadge = (status: string) => {
    const s = String(status).toLowerCase();
    let variant = "neutral";
    if (s === "draft") variant = "warning";
    if (s === "assigned") variant = "brand";
    if (s === "loaded") variant = "info";
    if (s === "out_for_delivery") variant = "purple";
    if (s === "delivered") variant = "success";
    if (s === "issue_reported") variant = "danger";
    if (s === "cancelled") variant = "neutral";
    return <Badge variant={variant as any}>{status}</Badge>;
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
          <h2 className="text-2xl font-bold tracking-tight">Dispatch & Delivery Tickets</h2>
          <p className="text-neutral-500">Manage packing lists, prepare dispatches, and assign tickets to active delivery runs.</p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button 
            onClick={loadData}
            disabled={loading}
            className="flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors shadow-sm w-full sm:w-auto"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
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
      <Card className="shadow-sm border-neutral-200 bg-white">
        <CardContent className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="relative min-w-[240px] flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search by ticket #, location, or run #..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 bg-neutral-50"
            />
          </div>
          
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-neutral-700 min-w-[160px]"
          >
            <option value="all">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="assigned">Assigned</option>
            <option value="loaded">Loaded</option>
            <option value="out_for_delivery">Out for Delivery</option>
            <option value="delivered">Delivered</option>
            <option value="issue_reported">Issue Reported</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <select
            value={runFilter}
            onChange={e => setRunFilter(e.target.value)}
            className="px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-neutral-700 min-w-[180px]"
          >
            <option value="all">All Assignments</option>
            <option value="unassigned">Unassigned Only</option>
            <option value="assigned">Assigned Only</option>
            {runs.map(run => (
              <option key={run.id} value={run.id}>
                {run.runNumber} {run.driverName ? `(${run.driverName})` : ""}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      {/* Tickets List */}
      {loading ? (
        <div className="text-center py-12 text-neutral-400">Loading delivery tickets...</div>
      ) : filteredTickets.length === 0 ? (
        <Card className="p-8 text-center border-dashed border-neutral-300 bg-white">
          <AlertTriangle className="h-8 w-8 text-neutral-400 mx-auto mb-2" />
          <p className="text-sm font-semibold text-neutral-900">No Delivery Tickets Found</p>
          <p className="text-xs text-neutral-500 mt-1">There are no tickets matching the current filters.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredTickets.map(ticket => {
            const isExpanded = expandedTickets[ticket.id] || false;
            
            return (
              <Card key={ticket.id} className="overflow-hidden border-neutral-200 shadow-sm bg-white">
                <CardHeader className="bg-neutral-50/50 py-4 px-5 border-b border-neutral-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div className="flex items-center gap-3 cursor-pointer" onClick={() => toggleExpand(ticket.id)}>
                    {isExpanded ? (
                      <ChevronDown className="h-5 w-5 text-neutral-500 shrink-0" />
                    ) : (
                      <ChevronRight className="h-5 w-5 text-neutral-500 shrink-0" />
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-base text-neutral-950 font-bold">{ticket.ticketNumber}</CardTitle>
                        {getStatusBadge(ticket.status)}
                      </div>
                      <CardDescription className="text-xs mt-0.5">
                        Dest: <span className="font-bold text-neutral-900">{ticket.destinationName}</span> · Date: {new Date(ticket.createdAt).toLocaleDateString()}
                      </CardDescription>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 sm:self-center">
                    {/* Status Dropdown selector */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-neutral-500">Status:</span>
                      <select
                        value={ticket.status}
                        onChange={e => handleStatusChange(ticket.id, e.target.value)}
                        disabled={updatingId === ticket.id || ['delivered', 'cancelled'].includes(ticket.status)}
                        className="text-xs border border-neutral-200 rounded px-2 py-1 bg-white focus:outline-none text-neutral-700"
                      >
                        <option value="draft">Draft</option>
                        <option value="assigned">Assigned</option>
                        <option value="loaded">Loaded</option>
                        <option value="cancelled">Cancelled</option>
                      </select>
                    </div>

                    {/* Run Assignment Dropdown */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-neutral-500">Run:</span>
                      <select
                        value={ticket.deliveryRunId || "unassigned"}
                        onChange={e => handleAssignRun(ticket.id, e.target.value)}
                        disabled={updatingId === ticket.id || ['delivered', 'cancelled'].includes(ticket.status)}
                        className="text-xs border border-neutral-200 rounded px-2 py-1 bg-white focus:outline-none text-neutral-700"
                      >
                        <option value="unassigned">Unassigned</option>
                        {runs.map(run => (
                          <option key={run.id} value={run.id}>
                            {run.runNumber} {run.driverName ? `(${run.driverName})` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </CardHeader>

                {isExpanded && (
                  <CardContent className="p-0 border-t border-neutral-100">
                    <div className="px-5 py-3.5 bg-neutral-50/20 border-b border-neutral-100 text-xs text-neutral-600 grid grid-cols-1 md:grid-cols-2 gap-2">
                      <div><span className="font-semibold text-neutral-500">Address:</span> {ticket.destinationAddress}</div>
                      <div><span className="font-semibold text-neutral-500">Contact:</span> {ticket.destinationContact} {ticket.destinationPhone ? `(${ticket.destinationPhone})` : ""}</div>
                      {ticket.notes && <div className="md:col-span-2"><span className="font-semibold text-neutral-500">Req Notes:</span> {ticket.notes}</div>}
                    </div>
                    <Table>
                      <TableHeader className="bg-neutral-50/10 text-xs text-neutral-500 uppercase tracking-wider">
                        <TableRow>
                          <TableHead className="px-5 py-2.5">Item Name</TableHead>
                          <TableHead className="py-2.5 text-center">Unit</TableHead>
                          <TableHead className="py-2.5 text-center">Requested</TableHead>
                          <TableHead className="py-2.5 text-center">Fulfilled / Shipped</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {ticket.items.map((item: any) => (
                          <TableRow key={item.id} className="hover:bg-neutral-50/10 border-b border-neutral-100 last:border-0">
                            <TableCell className="px-5 py-3 font-semibold text-neutral-900 text-sm">{item.itemName}</TableCell>
                            <TableCell className="py-3 text-center text-sm text-neutral-500">{item.unit || "ea"}</TableCell>
                            <TableCell className="py-3 text-center text-sm text-neutral-600">{item.requestedQty}</TableCell>
                            <TableCell className="py-3 text-center text-sm font-bold text-brand-600">{item.shippedQty}</TableCell>
                          </TableRow>
                        ))}
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
