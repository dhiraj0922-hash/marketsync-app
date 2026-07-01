"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Drawer } from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import {
  addTicketsToDeliveryRun,
  closeVehicleDailyLog,
  completeDeliveryRun,
  createDeliveryRun,
  createDriver,
  createVehicleDailyLog,
  createVehicle,
  getDeliveryRuns,
  getDeliveryRunReport,
  getDeliveryTickets,
  getActiveDriverByEmail,
  getDrivers,
  getVehicleDailyLogs,
  getVehicleDailyLogReport,
  getVehicles,
  loadLocations,
  markDeliveryTicketArrived,
  markDeliveryTicketDelivered,
  reportDeliveryTicketIssue,
  removeTicketFromDeliveryRun,
  reorderDeliveryRunStops,
  startDeliveryRun,
  updateDeliveryRun,
  updateDeliveryTicket,
  updateDeliveryTicketItems,
  updateDeliveryTicketStatus,
  updateDriver,
  updateVehicle,
  estimateDeliveryRunRoute,
  buildGoogleMapsDirectionsUrl,
  getDeliveryRunById,
  updateTicketAddressFromProfile,
  type DeliveryRunStatus,
  type DeliveryTicketStatus,
} from "@/lib/storage";
import { useAuth } from "@/components/AuthProvider";
import { isDeliveryDestinationLocation } from "@/lib/locationRegistry";
import { canAssignDrivers, isDriver, isHqStaff, isLocationManager, resolveLocationId } from "@/lib/roles";
import { DeliveryTicketDrawer } from "@/components/DeliveryTicketDrawer";
import { supabase } from "@/lib/supabase";
import {
  CalendarDays,
  CheckCircle2,
  Clock,
  Edit3,
  MapPin,
  PackageCheck,
  Plus,
  Printer,
  RefreshCw,
  Route,
  Truck,
  UserRound,
  AlertTriangle,
  Bell,
  ChevronRight,
  FileText,
  Gauge,
  Play,
  SquareCheckBig,
  Search,
} from "lucide-react";

const ticketStatuses: DeliveryTicketStatus[] = ["draft", "assigned", "loaded", "out_for_delivery", "delivered", "issue_reported", "cancelled"];
const runStatuses: DeliveryRunStatus[] = ["draft", "assigned", "loaded", "in_progress", "completed", "cancelled"];

const getTicketPrintUrl = (ticketId: string, mode?: "print" | "pdf") =>
  `/deliveries/tickets/${ticketId}/print${mode ? `?mode=${mode}` : ""}`;

const getRunTicketsPrintUrl = (runId: string, mode?: "print" | "pdf") =>
  `/deliveries/runs/${runId}/print${mode ? `?mode=${mode}` : ""}`;

const deliveryPageCss = `
  @media print {
    body * { visibility: hidden; }
    #delivery-ticket-print, #delivery-ticket-print * { visibility: visible; }
    #delivery-ticket-print { position: absolute; inset: 0; width: 100%; background: white; color: black; padding: 32px; }
  }
`;

const labelize = (value: string) => value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

function statusBadge(status: string) {
  const classes =
    status === "delivered" || status === "completed" ? "bg-emerald-50 text-emerald-700 border-emerald-100" :
    status === "loaded" ? "bg-green-50 text-green-700 border-green-100" :
    status === "assigned" ? "bg-blue-50 text-blue-700 border-blue-100" :
    status === "out_for_delivery" || status === "in_progress" ? "bg-amber-50 text-amber-700 border-amber-100" :
    status === "cancelled" || status === "issue_reported" ? "bg-red-50 text-red-700 border-red-100" :
    "bg-slate-100 text-slate-700 border-slate-200";
  return <Badge variant="neutral" className={`rounded-md border px-2 py-0.5 ${classes}`}>{labelize(status || "draft")}</Badge>;
}

function formatDateTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-10 text-center">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </div>
  );
}

function SummaryCard({ label, value, helper, icon: Icon, accent = "green" }: { label: string; value: React.ReactNode; helper: string; icon: React.ElementType; accent?: "green" | "blue" | "amber" | "slate" }) {
  const tone = {
    green: "bg-emerald-50 text-emerald-700 ring-emerald-100",
    blue: "bg-blue-50 text-blue-700 ring-blue-100",
    amber: "bg-amber-50 text-amber-700 ring-amber-100",
    slate: "bg-slate-100 text-slate-700 ring-slate-200",
  }[accent];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</p>
          <div className="mt-2 text-2xl font-bold tracking-tight text-slate-950">{value}</div>
        </div>
        <div className={`rounded-xl p-2.5 ring-1 ${tone}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 text-xs font-medium text-slate-500">{helper}</p>
    </div>
  );
}

export default function DeliveriesPage() {
  const { user } = useAuth();
  const hqAdmin = isHqStaff(user);
  const driverUser = isDriver(user);
  const managerUser = isLocationManager(user);
  const canManageDispatch = canAssignDrivers(user);
  const userLocationId = resolveLocationId(user);

  const [activeTab, setActiveTab] = useState<"tickets" | "runs" | "drivers" | "vehicles">("tickets");
  const [tickets, setTickets] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [vehicleLogs, setVehicleLogs] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<any | null>(null);
  const [selectedRun, setSelectedRun] = useState<any | null>(null);
  const [routeRun, setRouteRun] = useState<any | null>(null);
  const [runReport, setRunReport] = useState<any | null>(null);
  const [selectedVehicleLog, setSelectedVehicleLog] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [currentDriver, setCurrentDriver] = useState<any | null>(null);
  const [driverResolved, setDriverResolved] = useState(false);
  const [ticketFilter, setTicketFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [ticketSearch, setTicketSearch] = useState("");
  const [ticketDateFilter, setTicketDateFilter] = useState("");
  const [runDateFilter, setRunDateFilter] = useState("");
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [showAllTickets, setShowAllTickets] = useState(false);
  const [newRun, setNewRun] = useState({
    runDate: new Date().toISOString().slice(0, 10),
    driverId: "",
    vehicleId: "",
    estimatedDistanceKm: 0,
    estimatedDurationMinutes: 0,
    notes: "",
    ticketIds: [] as string[],
  });
  const [driverDraft, setDriverDraft] = useState({ name: "", phone: "", email: "", hourlyRate: "", notes: "" });
  const [vehicleDraft, setVehicleDraft] = useState({ vehicleName: "", plateNumber: "", notes: "" });
  const [vehicleLogDraft, setVehicleLogDraft] = useState({
    vehicleId: "",
    driverId: "",
    logDate: new Date().toISOString().slice(0, 10),
    odometerStartKm: "",
    fuelStartLevel: "",
    startConditionNotes: "",
  });
  const [vehicleLogCloseDraft, setVehicleLogCloseDraft] = useState({
    odometerEndKm: "",
    fuelEndLevel: "",
    endConditionNotes: "",
    damageReported: false,
    damageNotes: "",
  });
  const [runControlDraft, setRunControlDraft] = useState({ odometerStartKm: "", odometerEndKm: "" });
  const [manualEstimateDraft, setManualEstimateDraft] = useState({
    estimatedDistanceKm: "",
    estimatedDurationMinutes: "",
    routeEstimateSource: "manual",
    notes: "",
  });
  const [savingManualEstimate, setSavingManualEstimate] = useState(false);
  const [receivedBy, setReceivedBy] = useState("");
  const [ticketItemDrafts, setTicketItemDrafts] = useState<any[]>([]);
  const [estimatingRoute, setEstimatingRoute] = useState(false);
  const [returnToStart, setReturnToStart] = useState(true);
  const [showAddStopsPicker, setShowAddStopsPicker] = useState(false);
  const [selectedStopsToAssign, setSelectedStopsToAssign] = useState<string[]>([]);
  const [editingStopId, setEditingStopId] = useState<string | null>(null);
  const [stopEditDraft, setStopEditDraft] = useState({
    destinationName: "",
    destinationAddress: "",
    destinationContact: "",
    destinationPhone: "",
  });

  const refresh = async () => {
    setLoading(true);
    try {
      const currentDriverRow = driverUser ? await getActiveDriverByEmail(user?.email ?? "") : null;
      setCurrentDriver(currentDriverRow);
      setDriverResolved(true);

      if (process.env.NODE_ENV === "development" && driverUser) {
        console.log("[DeliveriesDriverScope] resolved driver context", {
          authEmail: user?.email ?? null,
          userRole: user?.role ?? null,
          driverId: currentDriverRow?.id ?? null,
          driverEmail: currentDriverRow?.email ?? null,
          driverActive: currentDriverRow?.active ?? null,
          runsFilter: currentDriverRow?.id ? `delivery_runs.driver_id = ${currentDriverRow.id}` : "no driver row resolved",
        });
      }
      const scopedLocation = hqAdmin || driverUser ? undefined : userLocationId;
      const [ticketRows, runRows, vehicleRows, locationRows, vehicleLogRows] = await Promise.all([
        driverUser
          ? Promise.resolve([])
          : getDeliveryTickets({
              locationId: scopedLocation ?? undefined,
              status: ticketFilter !== 'all' ? ticketFilter : undefined,
              fromDate: ticketDateFilter || undefined,
              toDate: ticketDateFilter || undefined,
              showAll: showAllTickets,
            }),
        hqAdmin
          ? getDeliveryRuns({
              runDate: runDateFilter || undefined,
              showAll: showAllRuns,
            })
          : driverUser && currentDriverRow?.id
            ? getDeliveryRuns({
                driverId: currentDriverRow.id,
                driverEmail: user?.email ?? "",
                runDate: runDateFilter || undefined,
                showAll: showAllRuns,
              })
            : Promise.resolve([]),
        hqAdmin ? getVehicles() : Promise.resolve([]),
        loadLocations(),
        hqAdmin ? getVehicleDailyLogs() : Promise.resolve([]),
      ]);

      const filteredRuns = runRows;

      if (process.env.NODE_ENV === "development" && driverUser) {
        console.log("[DeliveriesDriverScope] runs returned", {
          authEmail: user?.email ?? null,
          driverId: currentDriverRow?.id ?? null,
          count: filteredRuns.length,
          runNumbers: filteredRuns.map((run: any) => run.runNumber),
        });
      }
      const driverTicketRows = driverUser
        ? filteredRuns.flatMap((run: any) => (run.tickets ?? []).map((ticket: any) => ({ ...ticket, deliveryRun: run })))
        : ticketRows;
      setTickets(driverTicketRows);
      setRuns(filteredRuns);
      setDrivers(hqAdmin ? await getDrivers() : currentDriverRow ? [currentDriverRow] : []);
      setVehicles(vehicleRows);
      setLocations(locationRows);
      setVehicleLogs(vehicleLogRows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [hqAdmin, userLocationId, ticketFilter, ticketDateFilter, runDateFilter, showAllTickets, showAllRuns]);

  useEffect(() => {
    setTicketItemDrafts(selectedTicket?.items ? selectedTicket.items.map((item: any) => ({ ...item })) : []);
    setReceivedBy(selectedTicket?.receivedBy ?? "");
  }, [selectedTicket]);

  useEffect(() => {
    if (!routeRun) return;
    setRunControlDraft({
      odometerStartKm: routeRun.odometerStartKm ?? "",
      odometerEndKm: routeRun.odometerEndKm ?? "",
    });
    setManualEstimateDraft({
      estimatedDistanceKm: routeRun.estimatedDistanceKm != null && routeRun.estimatedDistanceKm !== 0 ? String(routeRun.estimatedDistanceKm) : "",
      estimatedDurationMinutes: routeRun.estimatedDurationMinutes != null && routeRun.estimatedDurationMinutes !== 0 ? String(routeRun.estimatedDurationMinutes) : "",
      routeEstimateSource: ["manual", "google_manual", "google"].includes(routeRun.routeEstimateSource) ? routeRun.routeEstimateSource : "manual",
      notes: routeRun.notes ?? "",
    });
  }, [routeRun]);

  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      console.log("[driver-ui-guard]", {
        role: user?.role,
        isDriver: driverUser,
        visibleRuns: runs.map(r => ({
          runNumber: r.runNumber || r.run_number,
          status: r.status,
          stopCount: r.tickets?.length ?? 0
        }))
      });
    }
  }, [runs, user, driverUser]);

  const visibleTickets = useMemo(() => {
    const q = ticketSearch.trim().toLowerCase();
    return tickets.filter((ticket) => {
      const statusOk = ticketFilter === "all" || ticket.status === ticketFilter;
      const locationOk = locationFilter === "all" || ticket.locationId === locationFilter;
      const createdAt = String(ticket.createdAt ?? ticket.created_at ?? "");
      const dateOk = !ticketDateFilter || createdAt.startsWith(ticketDateFilter);
      const searchOk = !q ||
        ticket.ticketNumber?.toLowerCase().includes(q) ||
        ticket.requisitionId?.toLowerCase().includes(q) ||
        ticket.destinationName?.toLowerCase().includes(q);
      return statusOk && locationOk && dateOk && searchOk;
    });
  }, [tickets, ticketFilter, locationFilter, ticketSearch, ticketDateFilter]);

  const openTickets = tickets.filter((ticket) => !ticket.deliveryRunId && !["delivered", "cancelled"].includes(ticket.status));
  const activeTickets = useMemo(() => {
    return tickets.filter((t) => !["delivered", "cancelled"].includes(t.status));
  }, [tickets]);
  const summary = useMemo(() => ({
    openTickets: tickets.filter((ticket) => !ticket.deliveryRunId && !["delivered", "cancelled"].includes(ticket.status)).length,
    assignedTickets: tickets.filter((ticket) => Boolean(ticket.deliveryRunId) || ticket.status === "assigned").length,
    activeRuns: runs.filter((run) => ["assigned", "loaded", "in_progress"].includes(run.status)).length,
    availableDrivers: drivers.filter((driver) => driver.active).length,
    vehiclesReady: vehicles.filter((vehicle) => vehicle.active).length,
  }), [tickets, runs, drivers, vehicles]);

  const saveTicketItems = async () => {
    if (!selectedTicket) return;
    const res = await updateDeliveryTicketItems(selectedTicket.id, ticketItemDrafts);
    if (!res.success) {
      alert(`Could not save ticket items: ${res.error?.message ?? "Unknown error"}`);
      return;
    }
    setToast("Delivery ticket items updated.");
    await refresh();
  };

  const markDelivered = async () => {
    if (!selectedTicket) return;
    for (const item of ticketItemDrafts) {
      const del = Number(item.deliveredQty ?? 0);
      const iss = Number(item.issueQty ?? 0);
      const shp = Number(item.shippedQty ?? 0);
      if (del + iss !== shp) {
        alert(`Cannot complete delivery for ${item.itemName}: Delivered Quantity (${del}) + Issue Quantity (${iss}) must equal Shipped Quantity (${shp}).`);
        return;
      }
    }
    const res = await markDeliveryTicketDelivered(selectedTicket.id, receivedBy.trim(), ticketItemDrafts);
    if (!res.success) {
      alert(`Could not mark delivered: ${res.error?.message ?? "Unknown error"}`);
      return;
    }
    setToast("Delivery ticket closed.");
    setSelectedTicket(null);
    await refresh();
  };

  const markArrived = async (ticket?: any) => {
    const target = ticket ?? selectedTicket;
    if (!target) return;
    const res = await markDeliveryTicketArrived(target.id);
    if (!res.success) return alert(`Could not mark arrived: ${res.error?.message ?? "Unknown error"}`);
    setToast("Stop marked arrived.");
    if (selectedTicket?.id === target.id) setSelectedTicket({ ...selectedTicket, arrivedAt: new Date().toISOString(), status: "out_for_delivery" });
    await refresh();
  };

  const openTicketPrintView = (ticket: any, mode: "view" | "print" | "pdf" = "view") => {
    if (!ticket?.id) {
      setToast("Delivery ticket is missing an internal ID.");
      return;
    }
    const printMode = mode === "view" ? undefined : mode;
    const url = getTicketPrintUrl(ticket.id, printMode);
    console.log("[Delivery Ticket Print Action]", {
      action: mode,
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      printUrl: url,
    });
    const printWindow = window.open(url, "_blank", "noopener,noreferrer");
    if (!printWindow) {
      setToast("Browser blocked the print window. Allow pop-ups and try again.");
    }
  };

  const openRunTicketsPrintView = (run: any, mode: "view" | "print" | "pdf" = "print") => {
    if (!run?.id) {
      setToast("Delivery run is missing an internal ID.");
      return;
    }
    const printMode = mode === "view" ? undefined : mode;
    const url = getRunTicketsPrintUrl(run.id, printMode);
    console.log("[Delivery Run Tickets Print Action]", {
      action: mode,
      runId: run.id,
      runNumber: run.runNumber,
      printUrl: url,
    });
    const printWindow = window.open(url, "_blank", "noopener,noreferrer");
    if (!printWindow) {
      setToast("Browser blocked the print window. Allow pop-ups and try again.");
    }
  };

  const reportIssue = async (ticket?: any) => {
    const target = ticket ?? selectedTicket;
    if (!target) return;
    const items = target.id === selectedTicket?.id ? ticketItemDrafts : target.items ?? [];
    const res = await reportDeliveryTicketIssue(target.id, {
      items,
      deliveryNotes: target.deliveryNotes ?? selectedTicket?.deliveryNotes ?? "",
      receivedBy: target.receivedBy ?? selectedTicket?.receivedBy ?? "",
    });
    if (!res.success) return alert(`Could not report issue: ${res.error?.message ?? "Unknown error"}`);
    setToast("Delivery issue reported.");
    setSelectedTicket(null);
    await refresh();
  };

  const handleCreateRun = async () => {
    if (!hqAdmin) return;
    if (!newRun.runDate) return alert("Run date is required.");
    const res = await createDeliveryRun(newRun);
    if (!res.success) return alert(`Could not create run: ${res.error?.message ?? "Unknown error"}`);
    if (newRun.ticketIds.length > 0) {
      const addRes = await addTicketsToDeliveryRun(res.data.id, newRun.ticketIds);
      if (!addRes.success) return alert(`Run created, but tickets could not be added: ${addRes.error?.message ?? "Unknown error"}`);
    }
    setToast("Delivery run created.");
    setNewRun({ runDate: new Date().toISOString().slice(0, 10), driverId: "", vehicleId: "", estimatedDistanceKm: 0, estimatedDurationMinutes: 0, notes: "", ticketIds: [] });
    await refresh();

    // Automatically open the Manage Route drawer for the new run
    const updatedRunRes = await getDeliveryRunById(res.data.id);
    if (updatedRunRes.success) {
      setRouteRun(updatedRunRes.data);
    }
  };

  const handleRunStatus = async (run: any, status: DeliveryRunStatus) => {
    if (status === "in_progress" || status === "completed") {
      const stopsCount = (run.tickets ?? []).length;
      if (stopsCount === 0) {
        return alert(`Cannot transition run to ${status} with 0 stops/tickets.`);
      }
    }
    if (status === "completed") {
      const incomplete = (run.tickets ?? []).some((ticket: any) => !["delivered", "issue_reported", "cancelled"].includes(ticket.status));
      if (incomplete) return alert("A run can be completed only when all tickets are delivered, issue reported, or cancelled.");
    }
    const res = await updateDeliveryRun(run.id, { status });
    if (!res.success) return alert(`Could not update run: ${res.error?.message ?? "Unknown error"}`);
    await refresh();
  };

  const handleStartRun = async (run: any) => {
    const stopsCount = (run.tickets ?? []).length;
    if (stopsCount === 0) {
      return alert("Cannot start a delivery run with 0 stops/tickets.");
    }
    const odometerStartKm = runControlDraft.odometerStartKm || run.odometerStartKm;
    if (odometerStartKm === "" || odometerStartKm == null) return alert("Starting odometer is required to start the run.");
    const res = await startDeliveryRun(run.id, { odometerStartKm });
    if (!res.success) return alert(`Could not start run: ${res.error?.message ?? "Unknown error"}`);
    setToast("Delivery run started.");
    setRouteRun(res.data);
    await refresh();
  };

  const handleCompleteRun = async (run: any) => {
    const stopsCount = (run.tickets ?? []).length;
    if (stopsCount === 0) {
      return alert("Cannot complete a delivery run with 0 stops/tickets.");
    }
    const odometerEndKm = runControlDraft.odometerEndKm || run.odometerEndKm;
    if (odometerEndKm === "" || odometerEndKm == null) return alert("Ending odometer is required to complete the run.");
    const res = await completeDeliveryRun(run.id, { odometerEndKm });
    if (!res.success) return alert(`Could not complete run: ${res.error?.message ?? "Unknown error"}`);
    setToast("Delivery run completed.");
    setRouteRun(null);
    await refresh();
  };

  const openRunReport = async (run: any) => {
    const res = await getDeliveryRunReport(run.id);
    if (!res.success) return alert(`Could not load report: ${res.error?.message ?? "Unknown error"}`);
    setRunReport(res.data);
  };

  const moveStop = async (run: any, ticketId: string, direction: -1 | 1) => {
    const ordered = [...(run.tickets ?? [])].sort((a, b) => (a.stopSequence ?? 999) - (b.stopSequence ?? 999));
    const index = ordered.findIndex((ticket) => ticket.id === ticketId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ordered.length) return;
    [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
    const res = await reorderDeliveryRunStops(run.id, ordered.map((ticket) => ticket.id));
    if (!res.success) return alert(`Could not reorder stops: ${res.error?.message ?? "Unknown error"}`);
    await refresh();
  };

  const handleEstimateRoute = async (run: any, optimize = false) => {
    console.log("selectedRun.id", run?.id);
    console.log("selectedRun.runNumber", run?.runNumber);
    console.log("selectedRun.run_number", run?.run_number);
    console.log("[Estimate Route Clicked]", {
      selectedRunId: run?.id,
      selectedRunNumber: run?.runNumber,
      optimize,
      returnToStart,
    });
    if (!run?.id) {
      setToast("No delivery run selected.");
      return;
    }
    setEstimatingRoute(true);
    setToast(optimize ? "Optimizing route..." : "Estimating route...");
    try {
      const res = await estimateDeliveryRunRoute(run.id, { optimize, returnToStart });
      if (!res.success) {
        setToast(`Route calculation failed: ${res.error || (res as any).message || "Unknown error"}`);
        return;
      }
      if (res.data && res.data.routeEstimateAvailable === false) {
        setToast(`Route estimation unavailable: ${res.data.message}`);
        return;
      }
      
      const km = res.data?.estimatedDistanceKm ?? 0;
      const mins = res.data?.estimatedDurationMinutes ?? 0;
      if (optimize) {
        setToast(`Route optimized: ${km} km / ${mins} min`);
      } else {
        setToast(`Route estimated: ${km} km / ${mins} min`);
      }
      
      await refresh();
      const updatedRunRes = await getDeliveryRunById(run.id);
      if (updatedRunRes.success) {
        setRouteRun(updatedRunRes.data);
      }
    } catch (err: any) {
      console.error("Route estimate error:", err);
      setToast(`Route calculation error: ${err.message || "Unknown error"}`);
    } finally {
      setEstimatingRoute(false);
    }
  };

  const handleSaveManualEstimate = async () => {
    if (!routeRun?.id) {
      setToast("No delivery run selected.");
      return;
    }
    setSavingManualEstimate(true);
    setToast("Saving manual estimate...");
    try {
      const dist = manualEstimateDraft.estimatedDistanceKm.trim();
      const dur = manualEstimateDraft.estimatedDurationMinutes.trim();
      const distNum = Number(dist);
      const durNum = Number(dur);
      
      const patch = {
        estimatedDistanceKm: isNaN(distNum) ? 0 : distNum,
        estimatedDurationMinutes: isNaN(durNum) ? 0 : durNum,
        routeEstimateSource: manualEstimateDraft.routeEstimateSource,
        routeEstimatedAt: new Date().toISOString(),
        notes: manualEstimateDraft.notes,
      };

      const res = await updateDeliveryRun(routeRun.id, patch);
      if (!res.success) {
        setToast(`Failed to save manual estimate: ${res.error?.message ?? "Unknown error"}`);
        return;
      }
      setToast("Manual route estimate saved.");
      await refresh();
      const updatedRunRes = await getDeliveryRunById(routeRun.id);
      if (updatedRunRes.success) {
        setRouteRun(updatedRunRes.data);
      }
    } catch (err: any) {
      console.error("Manual estimate save error:", err);
      setToast(`Error saving manual estimate: ${err.message || "Unknown error"}`);
    } finally {
      setSavingManualEstimate(false);
    }
  };

  const handleOpenInGoogleMaps = async (run: any) => {
    const stopsCount = (run.tickets ?? []).length;
    if (stopsCount === 0) {
      return alert("This run has no stops. Add delivery tickets first.");
    }
    const url = await buildGoogleMapsDirectionsUrl(run.id);
    if (url) {
      window.open(url, "_blank");
    } else {
      alert("Could not construct Google Maps Directions URL.");
    }
  };

  const handleCreateDriver = async () => {
    if (!driverDraft.name.trim()) return alert("Driver name is required.");
    const res = await createDriver(driverDraft);
    if (!res.success) return alert(`Could not save driver: ${res.error?.message ?? "Unknown error"}`);
    setDriverDraft({ name: "", phone: "", email: "", hourlyRate: "", notes: "" });
    await refresh();
  };

  const handleCreateVehicle = async () => {
    if (!vehicleDraft.vehicleName.trim()) return alert("Vehicle name is required.");
    const res = await createVehicle(vehicleDraft);
    if (!res.success) return alert(`Could not save vehicle: ${res.error?.message ?? "Unknown error"}`);
    setVehicleDraft({ vehicleName: "", plateNumber: "", notes: "" });
    await refresh();
  };

  const handleOpenVehicleLog = async () => {
    if (!vehicleLogDraft.vehicleId) return alert("Select a vehicle.");
    if (!vehicleLogDraft.odometerStartKm) return alert("Starting odometer is required.");
    const res = await createVehicleDailyLog(vehicleLogDraft);
    if (!res.success) return alert(`Could not open vehicle log: ${res.error?.message ?? "Unknown error"}`);
    setToast("Vehicle daily log opened.");
    setVehicleLogDraft({ vehicleId: "", driverId: "", logDate: new Date().toISOString().slice(0, 10), odometerStartKm: "", fuelStartLevel: "", startConditionNotes: "" });
    await refresh();
  };

  const handleCloseVehicleLog = async (log: any) => {
    const odometerEndKm = vehicleLogCloseDraft.odometerEndKm || log.odometerEndKm;
    if (odometerEndKm === "" || odometerEndKm == null) return alert("Ending odometer is required.");
    const res = await closeVehicleDailyLog(log.id, { ...vehicleLogCloseDraft, odometerEndKm });
    if (!res.success) return alert(`Could not close vehicle log: ${res.error?.message ?? "Unknown error"}`);
    setToast("Vehicle daily log closed.");
    setSelectedVehicleLog(null);
    setVehicleLogCloseDraft({ odometerEndKm: "", fuelEndLevel: "", endConditionNotes: "", damageReported: false, damageNotes: "" });
    await refresh();
  };

  const openVehicleLogReport = async (log: any) => {
    const res = await getVehicleDailyLogReport(log.id);
    if (!res.success) return alert(`Could not load vehicle log: ${res.error?.message ?? "Unknown error"}`);
    setSelectedVehicleLog(res.data);
    setVehicleLogCloseDraft({
      odometerEndKm: res.data.odometerEndKm ?? "",
      fuelEndLevel: res.data.fuelEndLevel ?? "",
      endConditionNotes: res.data.endConditionNotes ?? "",
      damageReported: Boolean(res.data.damageReported),
      damageNotes: res.data.damageNotes ?? "",
    });
  };

  return (
    <div className="delivery-light w-full space-y-6 text-slate-900">
      <style>{deliveryPageCss}</style>

        {toast && (
          <div className="fixed right-5 top-20 z-[140] rounded-xl border border-emerald-200 bg-white px-4 py-3 text-sm font-medium text-emerald-800 shadow-2xl">
            {toast}
            <button className="ml-3 text-emerald-700 underline" onClick={() => setToast(null)}>Dismiss</button>
          </div>
        )}

        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-sm">
                <Truck className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-black tracking-[0.18em] text-slate-950">STOCK DHARMA</p>
                <p className="text-xs font-medium text-slate-500">Page title: Deliveries</p>
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
                <MapPin className="h-4 w-4 text-emerald-600" />
                Head Office / Central Kitchen
              </div>
              <div className="relative min-w-0 sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  placeholder="Search inventory, orders..."
                  className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 outline-none transition focus:border-emerald-300 focus:ring-2 focus:ring-emerald-100"
                />
              </div>
              <button className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:bg-slate-50" aria-label="Notifications">
                <Bell className="h-4 w-4" />
              </button>
              <div className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-bold text-white">
                {driverUser ? "Driver" : "HQ Admin"}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-700">Delivery Management</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
              {driverUser ? "My Routes & Stops" : "Tickets & Runs"}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {driverUser
                ? "View and execute your assigned delivery runs and stops."
                : "Operational delivery documents and driver runs. Inventory is not deducted here."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={refresh} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
            {hqAdmin && (
              <>
                <button onClick={() => setActiveTab("runs")} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700">
                  <Plus className="h-4 w-4" /> New Delivery Run
                </button>
                <button onClick={() => routeRun ? setShowAddStopsPicker(true) : setActiveTab("tickets")} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
                  <PackageCheck className="h-4 w-4" /> Assign Tickets
                </button>
              </>
            )}
          </div>
        </div>

        {hqAdmin && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <SummaryCard label="Open Tickets" value={summary.openTickets} helper="Not assigned yet" icon={PackageCheck} accent="green" />
            <SummaryCard label="Assigned Tickets" value={summary.assignedTickets} helper="Linked to runs" icon={CheckCircle2} accent="blue" />
            <SummaryCard label="Active Runs" value={summary.activeRuns} helper="Assigned, loaded, in progress" icon={Route} accent="amber" />
            <SummaryCard label="Available Drivers" value={summary.availableDrivers} helper="Active driver profiles" icon={UserRound} accent="slate" />
            <SummaryCard label="Vehicles Ready" value={summary.vehiclesReady} helper="Active fleet records" icon={Truck} accent="green" />
          </div>
        )}

        <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
          {[
            ["tickets", driverUser ? "My Stops" : "Delivery Tickets", PackageCheck],
            ["runs", driverUser ? "My Routes" : "Delivery Runs", Route],
            ["drivers", "Drivers", UserRound],
            ["vehicles", "Vehicles", Truck],
          ].filter(([key]) => {
            if (driverUser) {
              return key === "tickets" || key === "runs";
            }
            if (managerUser) {
              return key === "tickets" || key === "runs";
            }
            return hqAdmin || key === "tickets";
          }).map(([key, label, Icon]: any) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                activeTab === key ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        {driverUser && driverResolved && !currentDriver ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center shadow-sm">
            <p className="text-sm font-semibold text-slate-900">No active driver profile found for this login email. Ask HQ to add this email in Drivers.</p>
          </div>
        ) : loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500 shadow-sm">Loading deliveries...</div>
        ) : activeTab === "tickets" ? (
          <Card className="overflow-hidden rounded-2xl border-slate-200 bg-white shadow-sm">
            <CardHeader className="border-b border-slate-100">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <CardTitle className="text-slate-950">Delivery Tickets</CardTitle>
                <div className="flex flex-wrap gap-2">
                  <input value={ticketSearch} onChange={(e) => setTicketSearch(e.target.value)} placeholder="Search tickets..." className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-emerald-300 focus:ring-2 focus:ring-emerald-100" />
                  <select value={ticketFilter} onChange={(e) => setTicketFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-emerald-300">
                    <option value="all">All statuses</option>
                    {ticketStatuses.map((status) => <option key={status} value={status}>{labelize(status)}</option>)}
                  </select>
                  <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-emerald-300">
                    <option value="all">All locations</option>
                    {locations.filter(isDeliveryDestinationLocation).map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                  </select>
                  <input
                    type="date"
                    value={ticketDateFilter}
                    onChange={(event) => setTicketDateFilter(event.target.value)}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-emerald-300"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showAllTickets}
                      onChange={(e) => setShowAllTickets(e.target.checked)}
                      className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    Load older history
                  </label>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {visibleTickets.length === 0 ? <div className="p-5"><EmptyState title="No delivery tickets found" detail="Generate tickets from approved or fulfilled requisitions." /></div> : (
                <>
                  <div className="hidden overflow-x-auto md:block">
                    <Table>
                      <TableHeader className="bg-slate-50">
                        <TableRow className="border-slate-200">
                          <TableHead className="text-slate-500">Ticket</TableHead>
                          <TableHead className="text-slate-500">Requisition</TableHead>
                          <TableHead className="text-slate-500">Destination</TableHead>
                          <TableHead className="text-slate-500">Run</TableHead>
                          <TableHead className="text-slate-500">Status</TableHead>
                          <TableHead className="text-right text-slate-500">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleTickets.map((ticket) => (
                          <TableRow key={ticket.id} className="border-slate-100 hover:bg-slate-50">
                            <TableCell className="font-mono text-xs font-semibold text-slate-800">{ticket.ticketNumber}</TableCell>
                            <TableCell className="font-mono text-xs text-slate-500">{ticket.requisitionId}</TableCell>
                            <TableCell>
                              <div className="font-semibold text-slate-950">{ticket.destinationName || "—"}</div>
                              <div className="text-xs text-slate-500">{ticket.destinationAddress || ticket.locationId || "No address snapshot"}</div>
                            </TableCell>
                            <TableCell className="text-slate-600">{ticket.deliveryRun?.runNumber ? `Assigned to ${ticket.deliveryRun.runNumber}` : "Not assigned"}</TableCell>
                            <TableCell>{statusBadge(ticket.status)}</TableCell>
                            <TableCell className="text-right">
                              <button onClick={() => setSelectedTicket(ticket)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50">Open</button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="space-y-3 p-4 md:hidden">
                    {visibleTickets.map((ticket) => (
                      <div key={ticket.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-mono text-xs font-bold text-slate-900">{ticket.ticketNumber}</p>
                            <p className="mt-1 text-sm font-semibold text-slate-950">{ticket.destinationName || "—"}</p>
                          </div>
                          {statusBadge(ticket.status)}
                        </div>
                        <div className="mt-3 space-y-1 text-xs text-slate-500">
                          <p>Requisition: <span className="font-mono">{ticket.requisitionId}</span></p>
                          <p>Run: {ticket.deliveryRun?.runNumber ? `Assigned to ${ticket.deliveryRun.runNumber}` : "Not assigned"}</p>
                          <p>{ticket.destinationAddress || ticket.locationId || "No address snapshot"}</p>
                        </div>
                        <button onClick={() => setSelectedTicket(ticket)} className="mt-4 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-800">Open</button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        ) : activeTab === "runs" && (hqAdmin || driverUser || managerUser) ? (
          <div className={`grid grid-cols-1 gap-5 ${hqAdmin ? "xl:grid-cols-[390px_1fr]" : ""}`}>
            {hqAdmin && <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
              <CardHeader className="border-b border-slate-100"><CardTitle className="text-slate-950">Create Delivery Run</CardTitle></CardHeader>
              <CardContent className="space-y-3 p-4">
                <input type="date" value={newRun.runDate} onChange={(e) => setNewRun({ ...newRun, runDate: e.target.value })} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
                <select value={newRun.driverId} onChange={(e) => setNewRun({ ...newRun, driverId: e.target.value })} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950">
                  <option value="">Assign driver later</option>
                  {drivers.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <select value={newRun.vehicleId} onChange={(e) => setNewRun({ ...newRun, vehicleId: e.target.value })} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950">
                  <option value="">No vehicle</option>
                  {vehicles.filter((v) => v.active).map((v) => <option key={v.id} value={v.id}>{v.vehicleName} {v.plateNumber ? `(${v.plateNumber})` : ""}</option>)}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <input type="number" min="0" value={newRun.estimatedDistanceKm} onChange={(e) => setNewRun({ ...newRun, estimatedDistanceKm: Number(e.target.value) })} placeholder="Estimated km" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
                  <input type="number" min="0" value={newRun.estimatedDurationMinutes} onChange={(e) => setNewRun({ ...newRun, estimatedDurationMinutes: Number(e.target.value) })} placeholder="Minutes" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
                </div>
                <textarea value={newRun.notes} onChange={(e) => setNewRun({ ...newRun, notes: e.target.value })} placeholder="Run notes" className="min-h-20 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Open tickets</p>
                  <div className="max-h-52 space-y-2 overflow-y-auto">
                    {activeTickets.length === 0 ? (
                      <p className="text-xs text-slate-500">No active tickets available.</p>
                    ) : (
                      activeTickets.map((ticket) => {
                        const isAssigned = !!ticket.deliveryRunId;
                        const runNum = ticket.deliveryRun?.runNumber;
                        return (
                          <label
                            key={ticket.id}
                            className={`flex items-start gap-2 rounded-md border p-2 text-xs transition-colors ${
                              isAssigned
                                ? "border-slate-100 bg-slate-50 text-slate-500 opacity-60"
                                : "border-slate-100 bg-slate-50 text-slate-700 cursor-pointer hover:bg-slate-50"
                            }`}
                          >
                            <input
                              type="checkbox"
                              disabled={isAssigned}
                              checked={newRun.ticketIds.includes(ticket.id)}
                              onChange={(e) =>
                                setNewRun((prev) => ({
                                  ...prev,
                                  ticketIds: e.target.checked
                                    ? [...prev.ticketIds, ticket.id]
                                    : prev.ticketIds.filter((id) => id !== ticket.id),
                                }))
                              }
                            />
                            <div className="flex-1">
                              <div className="flex items-center justify-between gap-1">
                                <strong>{ticket.ticketNumber}</strong>
                                <span className="text-[10px] text-slate-500">
                                  {isAssigned ? `Assigned to ${runNum || "another run"}` : "Not assigned"}
                                </span>
                              </div>
                              <p className="mt-0.5 truncate">{ticket.destinationName}</p>
                            </div>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
                <button onClick={handleCreateRun} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700">
                  <Plus className="h-4 w-4" /> Create Run
                </button>
              </CardContent>
            </Card>}

            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
                <p className="text-sm font-semibold text-slate-950">Delivery Runs</p>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={runDateFilter}
                    onChange={(e) => setRunDateFilter(e.target.value)}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-emerald-300 focus:ring-2 focus:ring-emerald-100"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showAllRuns}
                      onChange={(e) => setShowAllRuns(e.target.checked)}
                      className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    Load older history
                  </label>
                </div>
              </div>

              {runs.length === 0 ? (
                driverUser ? (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-white p-10 text-center shadow-sm">
                    <p className="text-sm font-semibold text-slate-950">No assigned delivery runs found for {user?.email ?? "your email"}.</p>
                    {(hqAdmin || process.env.NODE_ENV === "development") && (
                      <p className="mt-2 text-xs text-slate-500 font-mono">
                        Check delivery_runs.driver_id matches drivers.id.
                      </p>
                    )}
                  </div>
                ) : (
                  <EmptyState title="No delivery runs yet" detail="Create a run and assign open delivery tickets as stops." />
                )
              ) : runs.map((run) => {
                const orderedTickets = [...(run.tickets ?? [])].sort((a, b) => (a.stopSequence ?? 999) - (b.stopSequence ?? 999));
                const matchingVehicleLog = run.vehicleId
                  ? vehicleLogs.find((log) => log.vehicleId === run.vehicleId && log.logDate === run.runDate)
                  : null;
                return (
                  <Card key={run.id} className="rounded-2xl border-slate-200 bg-white shadow-sm">
                    <CardHeader className="border-b border-slate-100">
                      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <CardTitle className="text-slate-950 flex items-center gap-2">
                            {run.runNumber}
                            {run.routeEstimateSource === 'google' ? (
                              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                                Estimated by Google
                              </span>
                            ) : run.routeEstimateSource === 'google_manual' ? (
                              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                                Google Maps Manual Entry
                              </span>
                            ) : (
                              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                                Manual estimate
                              </span>
                            )}
                          </CardTitle>
                          <p className="mt-1 text-xs text-slate-500">{run.runDate} · {run.driver?.name ?? "No driver"} · {run.vehicle?.vehicleName ?? "No vehicle"}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {statusBadge(run.status)}
                          {canManageDispatch && (
                            <select value={run.status} onChange={(e) => handleRunStatus(run, e.target.value as DeliveryRunStatus)} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-950">
                              {runStatuses.map((status) => <option key={status} value={status}>{labelize(status)}</option>)}
                            </select>
                          )}
                          <button onClick={() => setRouteRun(run)} className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100"><Route className="h-3.5 w-3.5" /> Manage Route</button>
                          <button onClick={() => openRunReport(run)} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"><FileText className="h-3.5 w-3.5" /> Report</button>
                          {canManageDispatch && <button onClick={() => setSelectedRun(run)} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"><Edit3 className="h-3.5 w-3.5" /> Edit</button>}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="p-4">
                      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
                        <div className="rounded-lg border border-slate-100 bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Stops</p><p className="text-lg font-bold text-slate-950">{orderedTickets.length}</p></div>
                        <div className="rounded-lg border border-slate-100 bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Estimated km</p><p className="text-lg font-bold text-slate-950">{run.estimatedDistanceKm}</p></div>
                        <div className="rounded-lg border border-slate-100 bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Est. minutes</p><p className="text-lg font-bold text-slate-950">{run.estimatedDurationMinutes}</p></div>
                        <div className="rounded-lg border border-slate-100 bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Actual km</p><p className="text-lg font-bold text-slate-950">{run.actualDistanceKm ?? 0}</p></div>
                        <div className="rounded-lg border border-slate-100 bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Actual min</p><p className="text-lg font-bold text-slate-950">{run.actualDurationMinutes ?? 0}</p></div>
                        <div className="rounded-lg border border-slate-100 bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Started</p><p className="text-sm font-bold text-slate-950">{formatDateTime(run.actualStartTime)}</p></div>
                        <div className="rounded-lg border border-slate-100 bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Completed</p><p className="text-sm font-bold text-slate-950">{formatDateTime(run.actualEndTime)}</p></div>
                        <div className="rounded-lg border border-slate-100 bg-slate-50 p-3"><p className="text-[10px] uppercase text-slate-500">Odometer</p><p className="text-sm font-bold text-slate-950">{run.odometerStartKm ?? "—"} → {run.odometerEndKm ?? "—"}</p></div>
                      </div>
                      {run.vehicleId && !matchingVehicleLog && (
                        <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          <AlertTriangle className="h-4 w-4" /> No vehicle daily log opened for this vehicle/date.
                        </div>
                      )}
                      <div className="space-y-2">
                        {orderedTickets.map((ticket, index) => (
                          <div key={ticket.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-slate-950">#{index + 1} {ticket.destinationName}</p>
                              <p className="text-xs text-slate-500">{ticket.ticketNumber} · {ticket.destinationAddress || ticket.locationId}</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              {hqAdmin && (
                                <>
                                  <button onClick={() => moveStop(run, ticket.id, -1)} className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-700">Up</button>
                                  <button onClick={() => moveStop(run, ticket.id, 1)} className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-700">Down</button>
                                </>
                              )}
                              <button onClick={() => setSelectedTicket(ticket)} className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-700">Open</button>
                              {hqAdmin && (
                                <button onClick={async () => { await removeTicketFromDeliveryRun(ticket.id); await refresh(); }} className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">Remove</button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        ) : activeTab === "drivers" && hqAdmin ? (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]">
            <Card className="rounded-2xl border-slate-200 bg-white shadow-sm"><CardHeader><CardTitle className="text-slate-950">Add Driver</CardTitle></CardHeader><CardContent className="space-y-2">
              <input value={driverDraft.name} onChange={(e) => setDriverDraft({ ...driverDraft, name: e.target.value })} placeholder="Name" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
              <input value={driverDraft.phone} onChange={(e) => setDriverDraft({ ...driverDraft, phone: e.target.value })} placeholder="Phone" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
              <input value={driverDraft.email} onChange={(e) => setDriverDraft({ ...driverDraft, email: e.target.value })} placeholder="Email" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
              <input type="number" value={driverDraft.hourlyRate} onChange={(e) => setDriverDraft({ ...driverDraft, hourlyRate: e.target.value })} placeholder="Hourly rate" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
              <textarea value={driverDraft.notes} onChange={(e) => setDriverDraft({ ...driverDraft, notes: e.target.value })} placeholder="Notes" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
              <button onClick={handleCreateDriver} className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white">Save Driver</button>
            </CardContent></Card>
            <PeopleTable rows={drivers} type="driver" onToggle={async (row) => { await updateDriver(row.id, { active: !row.active }); await refresh(); }} />
          </div>
        ) : activeTab === "vehicles" && hqAdmin ? (
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]">
              <Card className="rounded-2xl border-slate-200 bg-white shadow-sm"><CardHeader><CardTitle className="text-slate-950">Add Vehicle</CardTitle></CardHeader><CardContent className="space-y-2">
                <input value={vehicleDraft.vehicleName} onChange={(e) => setVehicleDraft({ ...vehicleDraft, vehicleName: e.target.value })} placeholder="Vehicle name" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
                <input value={vehicleDraft.plateNumber} onChange={(e) => setVehicleDraft({ ...vehicleDraft, plateNumber: e.target.value })} placeholder="Plate number" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
                <textarea value={vehicleDraft.notes} onChange={(e) => setVehicleDraft({ ...vehicleDraft, notes: e.target.value })} placeholder="Notes" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
                <button onClick={handleCreateVehicle} className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white">Save Vehicle</button>
              </CardContent></Card>
              <PeopleTable rows={vehicles} type="vehicle" onToggle={async (row) => { await updateVehicle(row.id, { active: !row.active }); await refresh(); }} />
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]">
              <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
                <CardHeader className="border-b border-slate-100"><CardTitle className="text-slate-950">Open Vehicle Daily Log</CardTitle></CardHeader>
                <CardContent className="space-y-2 p-4">
                  <select value={vehicleLogDraft.vehicleId} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, vehicleId: e.target.value })} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950">
                    <option value="">Select vehicle</option>
                    {vehicles.filter((v) => v.active).map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicleName} {vehicle.plateNumber ? `(${vehicle.plateNumber})` : ""}</option>)}
                  </select>
                  <select value={vehicleLogDraft.driverId} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, driverId: e.target.value })} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950">
                    <option value="">Driver optional</option>
                    {drivers.filter((d) => d.active).map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
                  </select>
                  <input type="date" value={vehicleLogDraft.logDate} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, logDate: e.target.value })} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
                  <input type="number" min="0" value={vehicleLogDraft.odometerStartKm} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, odometerStartKm: e.target.value })} placeholder="Starting odometer km" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
                  <input value={vehicleLogDraft.fuelStartLevel} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, fuelStartLevel: e.target.value })} placeholder="Fuel start level" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
                  <textarea value={vehicleLogDraft.startConditionNotes} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, startConditionNotes: e.target.value })} placeholder="Start condition notes" className="min-h-20 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950" />
                  <button onClick={handleOpenVehicleLog} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white"><Gauge className="h-4 w-4" /> Open Daily Log</button>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
                <CardHeader className="border-b border-slate-100"><CardTitle className="text-slate-950">Vehicle Daily Logs</CardTitle></CardHeader>
                <CardContent className="p-0">
                  {vehicleLogs.length === 0 ? <div className="p-5"><EmptyState title="No vehicle daily logs" detail="Open a daily log before dispatch to compare odometer usage later." /></div> : (
                    <Table>
                      <TableHeader className="bg-slate-50">
                        <TableRow className="border-slate-100">
                          <TableHead className="text-slate-500">Date</TableHead>
                          <TableHead className="text-slate-500">Vehicle</TableHead>
                          <TableHead className="text-slate-500">Driver</TableHead>
                          <TableHead className="text-slate-500">KM</TableHead>
                          <TableHead className="text-slate-500">Variance</TableHead>
                          <TableHead className="text-slate-500">Damage</TableHead>
                          <TableHead className="text-right text-slate-500">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {vehicleLogs.map((log) => (
                          <TableRow key={log.id} className="border-slate-100">
                            <TableCell className="text-slate-700">{log.logDate}<div>{statusBadge(log.status)}</div></TableCell>
                            <TableCell className="font-semibold text-slate-950">{log.vehicle?.vehicleName ?? log.vehicleId}</TableCell>
                            <TableCell className="text-slate-500">{log.driver?.name ?? "—"}</TableCell>
                            <TableCell className="text-slate-500">{log.odometerStartKm} → {log.odometerEndKm ?? "—"}<div className="text-xs text-slate-400">Total {log.totalOdometerKm ?? "—"} km</div></TableCell>
                            <TableCell className={`${Number(log.varianceKm ?? 0) > 25 ? "text-red-600" : Number(log.varianceKm ?? 0) > 10 ? "text-amber-600" : "text-slate-500"}`}>{log.varianceKm ?? "—"} km</TableCell>
                            <TableCell className={log.damageReported ? "text-red-600" : "text-slate-500"}>{log.damageReported ? "Yes" : "No"}</TableCell>
                            <TableCell className="text-right"><button onClick={() => openVehicleLogReport(log)} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">{log.status === "open" ? "Close / View" : "View Logs"}</button></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        ) : null}

        <DeliveryTicketDrawer
          ticket={selectedTicket}
          onClose={() => setSelectedTicket(null)}
          onRefresh={refresh}
          user={user}
          canEditAdmin={hqAdmin}
          canActOnTicket={hqAdmin || driverUser || managerUser}
          onToast={setToast}
        />

        <Drawer isOpen={!!routeRun} onClose={() => setRouteRun(null)} title={`Manage Route ${routeRun?.runNumber ?? ""}`} description="Start the run, manage stops, and record odometer actuals." variant="dialog">
          {routeRun && (() => {
            const orderedTickets = [...(routeRun.tickets ?? [])].sort((a, b) => (a.stopSequence ?? 999) - (b.stopSequence ?? 999));
            const vehicleLog = routeRun.vehicleId ? vehicleLogs.find((log) => log.vehicleId === routeRun.vehicleId && log.logDate === routeRun.runDate) : null;
            const stopsCount = orderedTickets.length;
            const isStartAddressMissing = !routeRun.startAddress?.trim();
            const isAnyStopAddressMissing = orderedTickets.some((t: any) => !t.destinationAddress?.trim());
            const isEstimateDisabled = stopsCount === 0 || isStartAddressMissing || isAnyStopAddressMissing || estimatingRoute;
            const estimateDisabledReasons = [
              stopsCount === 0 ? "Add delivery tickets/stops" : null,
              isStartAddressMissing ? "Start address missing" : null,
              stopsCount > 0 && isAnyStopAddressMissing ? "One or more stops missing destination address" : null,
            ].filter(Boolean);

            return (
              <div className="space-y-4 text-neutral-700">
                <div className="rounded-xl border border-neutral-200 bg-white p-4">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                    <InfoLine icon={<CalendarDays className="h-4 w-4" />} label="Run Date" value={routeRun.runDate} />
                    <InfoLine icon={<UserRound className="h-4 w-4" />} label="Driver" value={routeRun.driver?.name ?? "—"} />
                    <InfoLine icon={<Truck className="h-4 w-4" />} label="Vehicle" value={routeRun.vehicle?.vehicleName ?? "—"} />
                    <InfoLine icon={<MapPin className="h-4 w-4" />} label="Stops" value={String(orderedTickets.length)} />
                  </div>
                  {routeRun.vehicleId && !vehicleLog && (
                    <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <AlertTriangle className="h-4 w-4" /> No vehicle daily log opened for this vehicle/date.
                    </div>
                  )}
                  <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-4">
                    <input type="number" min="0" value={runControlDraft.odometerStartKm} onChange={(e) => setRunControlDraft({ ...runControlDraft, odometerStartKm: e.target.value })} placeholder="Odometer start km" className="rounded-lg border border-neutral-200 px-3 py-2 text-sm" />
                    <input type="number" min="0" value={runControlDraft.odometerEndKm} onChange={(e) => setRunControlDraft({ ...runControlDraft, odometerEndKm: e.target.value })} placeholder="Odometer end km" className="rounded-lg border border-neutral-200 px-3 py-2 text-sm" />
                    <button onClick={() => handleStartRun(routeRun)} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white"><Play className="h-4 w-4" /> Start Run</button>
                    <button onClick={() => handleCompleteRun(routeRun)} className="inline-flex items-center justify-center gap-2 rounded-lg bg-success-600 px-3 py-2 text-sm font-semibold text-white"><SquareCheckBig className="h-4 w-4" /> Complete Run</button>
                  </div>
                </div>

                {hqAdmin ? (
                  <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-3">
                    <label className="block text-xs font-bold uppercase tracking-wider text-neutral-500 font-semibold">Start Address (Origin)</label>
                    <div className="flex gap-2">
                      <input
                        value={routeRun.startAddress ?? ""}
                        onChange={(e) => setRouteRun({ ...routeRun, startAddress: e.target.value })}
                        placeholder="Start address (e.g. HQ address)"
                        className="flex-1 rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900"
                      />
                      <button
                        onClick={async () => {
                          const res = await updateDeliveryRun(routeRun.id, { startAddress: routeRun.startAddress });
                          if (res.success) {
                            setToast("Start address updated.");
                            await refresh();
                          } else {
                            alert(`Failed to save start address: ${res.error?.message ?? "Unknown error"}`);
                          }
                        }}
                        className="rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white"
                      >
                        Save
                      </button>
                      <button
                        onClick={async () => {
                          // Load LOC-HQ to check for address in location_billing_profiles
                          const { data: hqProfile } = await supabase
                            .from('location_billing_profiles')
                            .select('*')
                            .eq('location_id', 'LOC-HQ')
                            .maybeSingle();
                          
                          let hqAddress = '';
                          if (hqProfile) {
                            const storeAddress = hqProfile.store_address || hqProfile.storeAddress;
                            const city = hqProfile.store_city || hqProfile.storeCity;
                            const province = hqProfile.store_province || hqProfile.storeProvince;
                            const postalCode = hqProfile.store_postal_code || hqProfile.storePostalCode;
                            if (storeAddress) {
                              hqAddress = `${storeAddress}, ${city || ''}, ${province || ''} ${postalCode || ''}, Canada`
                                .replace(/,\s*,/g, ',')
                                .replace(/\s+/g, ' ')
                                .trim();
                            }
                          }

                          if (!hqAddress) {
                            // locations fallback
                            const { data: hqLoc } = await supabase
                              .from('locations')
                              .select('*')
                              .eq('id', 'LOC-HQ')
                              .maybeSingle();
                            if (hqLoc) {
                              hqAddress = [
                                hqLoc.address,
                                hqLoc.street,
                                hqLoc.city,
                                hqLoc.province ?? hqLoc.state,
                                hqLoc.postal_code ?? hqLoc.postalCode,
                              ].filter(Boolean).join(', ');
                            }
                          }

                          if (hqAddress) {
                            const res = await updateDeliveryRun(routeRun.id, { startAddress: hqAddress });
                            if (res.success) {
                              setToast("Start address defaulted from HQ profile.");
                              setRouteRun({ ...routeRun, startAddress: hqAddress });
                              await refresh();
                            } else {
                              alert(`Failed to save start address: ${res.error?.message ?? "Unknown error"}`);
                            }
                          } else {
                            alert("HQ location profile address is not configured.");
                          }
                        }}
                        className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs font-semibold text-neutral-700 hover:bg-neutral-100"
                      >
                        Default HQ
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-neutral-200 bg-white p-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-neutral-500 font-semibold">Start Address (Origin)</p>
                    <p className="mt-1 text-sm font-medium text-neutral-900">{routeRun.startAddress || "—"}</p>
                  </div>
                )}

                <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-3">
                  <p className="text-xs font-bold uppercase tracking-wider text-neutral-500">Google Maps Route Integration</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {hqAdmin && (
                      <>
                        <button
                          disabled={isEstimateDisabled}
                          onClick={() => handleEstimateRoute(routeRun, false)}
                          className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                        >
                          {estimatingRoute ? "Estimating..." : "Estimate Route"}
                        </button>
                        <button
                          disabled={isEstimateDisabled}
                          onClick={() => handleEstimateRoute(routeRun, true)}
                          className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                        >
                          {estimatingRoute ? "Optimizing..." : "Optimize Route"}
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => handleOpenInGoogleMaps(routeRun)}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
                    >
                      Open in Google Maps
                    </button>
                  </div>
                  {hqAdmin && estimateDisabledReasons.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                      {estimateDisabledReasons.join(" · ")}
                    </div>
                  )}
                  {hqAdmin && (
                    <label className="flex items-center gap-2 text-xs font-semibold text-neutral-600">
                      <input
                        type="checkbox"
                        checked={returnToStart}
                        onChange={(e) => setReturnToStart(e.target.checked)}
                        className="rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
                      />
                      Return to start (HQ / Start Address)
                    </label>
                  )}
                </div>

                {/* Google Route Result Section */}
                <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-4">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-500">Google Route Result</h4>
                  
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div className="rounded-lg bg-neutral-50 p-3">
                      <div className="text-[10px] font-semibold uppercase text-neutral-500">Estimate Source</div>
                      <p className="mt-1 text-xs font-semibold text-neutral-900">
                        {routeRun.routeEstimateSource === 'google'
                          ? 'Google API'
                          : routeRun.routeEstimateSource === 'google_manual'
                          ? 'Google Maps Manual Entry'
                          : 'Manual'}
                      </p>
                    </div>
                    <div className="rounded-lg bg-neutral-50 p-3">
                      <div className="text-[10px] font-semibold uppercase text-neutral-500">Total Distance</div>
                      <p className="mt-1 text-sm font-bold text-neutral-950">{routeRun.estimatedDistanceKm ?? 0} km</p>
                    </div>
                    <div className="rounded-lg bg-neutral-50 p-3">
                      <div className="text-[10px] font-semibold uppercase text-neutral-500">Total Duration</div>
                      <p className="mt-1 text-sm font-bold text-neutral-950">{routeRun.estimatedDurationMinutes ?? 0} mins</p>
                    </div>
                    <div className="rounded-lg bg-neutral-50 p-3">
                      <div className="text-[10px] font-semibold uppercase text-neutral-500">Return to Start</div>
                      <p className="mt-1 text-sm font-semibold text-neutral-900">
                        {routeRun.googleRouteSummary?.returnToStart ? 'Yes' : 'No'}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-2 text-xs text-neutral-500 md:grid-cols-2 border-t border-neutral-100 pt-3">
                    <div>
                      <span className="font-semibold text-neutral-700">Estimated At:</span>{' '}
                      {routeRun.routeEstimatedAt ? formatDateTime(routeRun.routeEstimatedAt) : '—'}
                    </div>
                    <div>
                      <span className="font-semibold text-neutral-700">Number of Stops:</span> {stopsCount}
                    </div>
                  </div>

                  {/* Warnings */}
                  <div className="space-y-2">
                    {stopsCount === 0 && (
                      <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>Add delivery tickets/stops before estimating route. Use Add Delivery Tickets to assign delivery tickets to this run.</span>
                      </div>
                    )}
                    {stopsCount > 0 && isStartAddressMissing && (
                      <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>Start address missing. Add HQ/start address before estimating route.</span>
                      </div>
                    )}
                    {stopsCount > 0 && !isStartAddressMissing && isAnyStopAddressMissing && (
                      <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>One or more delivery tickets are missing destination address.</span>
                      </div>
                    )}
                  </div>

                  {/* Leg Details */}
                  {routeRun.routeEstimateSource === 'google' && routeRun.googleRouteSummary?.legs && (
                    <div className="border-t border-neutral-100 pt-3 space-y-3">
                      <p className="text-xs font-bold uppercase tracking-wider text-neutral-500">Leg Details</p>
                      <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                        {routeRun.googleRouteSummary.legs.map((leg: any, idx: number) => (
                          <div key={idx} className="rounded-lg border border-neutral-100 bg-neutral-50 p-3 text-xs space-y-1">
                            <div className="flex items-center justify-between border-b border-neutral-100 pb-1 font-semibold text-neutral-900">
                              <span>Leg {leg.sequence}: {leg.fromName || 'Start'} → {leg.toName || 'End'}</span>
                              <span className="text-blue-600 font-bold">{leg.distanceKm} km · {leg.durationMinutes} min</span>
                            </div>
                            <div className="text-[11px] text-neutral-500">
                              <div><span className="font-semibold text-neutral-600">From:</span> {leg.fromAddress}</div>
                              <div><span className="font-semibold text-neutral-600">To:</span> {leg.toAddress}</div>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] pt-1 text-neutral-600">
                              {leg.estimatedArrivalTime && (
                                <div>
                                  <span className="font-semibold">ETA:</span> {formatDateTime(leg.estimatedArrivalTime)}
                                </div>
                              )}
                              {leg.ticketNumber && (
                                <div>
                                  <span className="font-semibold">Ticket:</span> {leg.ticketNumber}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Manual Route Estimate Override Section */}
                <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-4">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-500">Manual Estimate Override</h4>
                  
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-neutral-600 mb-1">Estimated KM</label>
                      <input
                        type="number"
                        step="any"
                        placeholder="e.g. 172"
                        value={manualEstimateDraft.estimatedDistanceKm}
                        onChange={(e) => setManualEstimateDraft(prev => ({ ...prev, estimatedDistanceKm: e.target.value }))}
                        className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-neutral-600 mb-1">Estimated Minutes</label>
                      <input
                        type="number"
                        step="any"
                        placeholder="e.g. 108"
                        value={manualEstimateDraft.estimatedDurationMinutes}
                        onChange={(e) => setManualEstimateDraft(prev => ({ ...prev, estimatedDurationMinutes: e.target.value }))}
                        className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-neutral-600 mb-1">Estimate Source</label>
                    <select
                      value={manualEstimateDraft.routeEstimateSource}
                      onChange={(e) => setManualEstimateDraft(prev => ({ ...prev, routeEstimateSource: e.target.value }))}
                      className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-950 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="manual">Manual</option>
                      <option value="google_manual">Google Maps Manual Entry</option>
                      {manualEstimateDraft.routeEstimateSource === 'google' && (
                        <option value="google" disabled>Google API</option>
                      )}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-neutral-600 mb-1">Route Notes</label>
                    <textarea
                      placeholder="Enter details about the manual estimate override..."
                      value={manualEstimateDraft.notes}
                      onChange={(e) => setManualEstimateDraft(prev => ({ ...prev, notes: e.target.value }))}
                      rows={2}
                      className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                  </div>

                  <p className="text-[11px] text-neutral-500 italic">
                    If Google estimate fails, open Google Maps, copy the distance/time, and save it here.
                  </p>

                  <button
                    disabled={savingManualEstimate}
                    onClick={handleSaveManualEstimate}
                    className="w-full inline-flex items-center justify-center rounded-lg bg-neutral-900 hover:bg-neutral-800 disabled:opacity-50 text-white font-semibold text-sm px-4 py-2.5 shadow-sm transition-colors"
                  >
                    {savingManualEstimate ? "Saving Estimate..." : "Save Manual Estimate"}
                  </button>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-500">Stops List</h4>
                    <div className="flex flex-wrap gap-2">
                      {orderedTickets.length > 0 && (
                        <button
                          onClick={() => openRunTicketsPrintView(routeRun, "print")}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                        >
                          <Printer className="h-3.5 w-3.5" /> Print All Tickets
                        </button>
                      )}
                      {hqAdmin && orderedTickets.length > 0 && (
                        <button
                          onClick={() => {
                            setSelectedStopsToAssign([]);
                            setShowAddStopsPicker(true);
                          }}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-semibold text-neutral-700 hover:bg-neutral-50"
                        >
                          <Plus className="h-3.5 w-3.5 text-neutral-500" /> Add Tickets
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    {orderedTickets.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 p-6 text-center">
                        <p className="text-sm font-semibold text-neutral-950">No stops assigned to this run.</p>
                        {hqAdmin && (
                          <button
                            onClick={() => {
                              setSelectedStopsToAssign([]);
                              setShowAddStopsPicker(true);
                            }}
                            className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                          >
                            <Plus className="h-3.5 w-3.5" /> Add Delivery Tickets
                          </button>
                        )}
                      </div>
                    ) : (
                      orderedTickets.map((ticket, index) => (
                        <div key={ticket.id} className="rounded-xl border border-neutral-200 bg-white p-4">
                          {editingStopId === ticket.id ? (
                            <div className="space-y-3 text-xs">
                              <p className="font-bold text-neutral-500 uppercase">Edit Stop #{index + 1} Details</p>
                              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                                <div>
                                  <label className="text-[10px] font-bold text-neutral-500 font-semibold">Destination Name</label>
                                  <input
                                    type="text"
                                    value={stopEditDraft.destinationName}
                                    onChange={(e) => setStopEditDraft({ ...stopEditDraft, destinationName: e.target.value })}
                                    placeholder="Name"
                                    className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-900 font-medium"
                                  />
                                </div>
                                <div>
                                  <label className="text-[10px] font-bold text-neutral-500 font-semibold">Destination Address</label>
                                  <input
                                    type="text"
                                    value={stopEditDraft.destinationAddress}
                                    onChange={(e) => setStopEditDraft({ ...stopEditDraft, destinationAddress: e.target.value })}
                                    placeholder="Full address"
                                    className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-900 font-medium"
                                  />
                                </div>
                                <div>
                                  <label className="text-[10px] font-bold text-neutral-500 font-semibold">Contact Person</label>
                                  <input
                                    type="text"
                                    value={stopEditDraft.destinationContact}
                                    onChange={(e) => setStopEditDraft({ ...stopEditDraft, destinationContact: e.target.value })}
                                    placeholder="Contact Name"
                                    className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-900 font-medium"
                                  />
                                </div>
                                <div>
                                  <label className="text-[10px] font-bold text-neutral-500 font-semibold">Contact Phone</label>
                                  <input
                                    type="text"
                                    value={stopEditDraft.destinationPhone}
                                    onChange={(e) => setStopEditDraft({ ...stopEditDraft, destinationPhone: e.target.value })}
                                    placeholder="Phone"
                                    className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-xs text-neutral-900 font-medium"
                                  />
                                </div>
                              </div>
                              <div className="flex gap-2 pt-1">
                                <button
                                  onClick={async () => {
                                    const res = await updateDeliveryTicket(ticket.id, stopEditDraft);
                                    if (res.success) {
                                      setToast("Stop details updated.");
                                      setEditingStopId(null);
                                      await refresh();
                                      const updatedRunRes = await getDeliveryRunById(routeRun.id);
                                      if (updatedRunRes.success) {
                                        setRouteRun(updatedRunRes.data);
                                      }
                                    } else {
                                      alert(`Failed to save changes: ${res.error?.message ?? "Unknown error"}`);
                                    }
                                  }}
                                  className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-800"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingStopId(null)}
                                  className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                              <div>
                                <p className="text-sm font-bold text-neutral-950 font-semibold">Stop #{index + 1} · {ticket.destinationName}</p>
                                <p className="text-xs text-neutral-500 font-medium">{ticket.ticketNumber} · Requisition {ticket.requisitionId}</p>
                                <div className="mt-1 text-xs">
                                  {ticket.destinationAddress ? (
                                    <span className="text-neutral-600 font-medium">{ticket.destinationAddress}</span>
                                  ) : (
                                    <span className="text-red-600 font-semibold flex items-center gap-1">
                                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Destination address missing.
                                    </span>
                                  )}
                                </div>
                                {(ticket.destinationContact || ticket.destinationPhone) && (
                                  <div className="mt-1 text-xs text-neutral-500 flex flex-wrap gap-x-3 gap-y-0.5">
                                    {ticket.destinationContact && (
                                      <span>
                                        <span className="font-semibold text-neutral-600">Contact:</span> {ticket.destinationContact}
                                      </span>
                                    )}
                                    {ticket.destinationPhone && (
                                      <span>
                                        <span className="font-semibold text-neutral-600">Phone:</span> {ticket.destinationPhone}
                                      </span>
                                    )}
                                  </div>
                                )}
                                <div className="mt-2 flex flex-wrap gap-2 text-xs text-neutral-500 font-medium">
                                  <span>ETA: {formatDateTime(ticket.estimatedArrivalTime)}</span>
                                  <span>Arrived: {formatDateTime(ticket.arrivedAt)}</span>
                                  <span>Delivered: {formatDateTime(ticket.deliveredAt)}</span>
                                  <span>Received: {ticket.receivedBy || "—"}</span>
                                  <span>Issues: {(ticket.items ?? []).reduce((sum: number, item: any) => sum + Number(item.issueQty ?? 0), 0)}</span>
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {statusBadge(ticket.status)}
                                {hqAdmin && (
                                  <>
                                    <button
                                      onClick={() => {
                                        setEditingStopId(ticket.id);
                                        setStopEditDraft({
                                          destinationName: ticket.destinationName || "",
                                          destinationAddress: ticket.destinationAddress || "",
                                          destinationContact: ticket.destinationContact || "",
                                          destinationPhone: ticket.destinationPhone || "",
                                        });
                                      }}
                                      className="rounded border border-neutral-200 px-2 py-1 text-xs font-semibold hover:bg-neutral-50"
                                    >
                                      Edit Address
                                    </button>
                                    <button
                                      onClick={async () => {
                                        const res = await updateTicketAddressFromProfile(ticket.id);
                                        if (res.success) {
                                          setToast("Delivery address updated from store profile.");
                                          await refresh();
                                          const updatedRunRes = await getDeliveryRunById(routeRun.id);
                                          if (updatedRunRes.success) {
                                            setRouteRun(updatedRunRes.data);
                                          }
                                        } else {
                                          alert(`Address update failed: ${res.error?.message ?? "Unknown error"}`);
                                        }
                                      }}
                                      className="rounded border border-neutral-200 px-2 py-1 text-xs font-semibold hover:bg-neutral-50 text-blue-600 border-blue-200 bg-blue-50/30"
                                    >
                                      Update Address from Store Profile
                                    </button>
                                    <button onClick={() => moveStop(routeRun, ticket.id, -1)} className="rounded border border-neutral-200 px-2 py-1 text-xs font-semibold hover:bg-neutral-50">Up</button>
                                    <button onClick={() => moveStop(routeRun, ticket.id, 1)} className="rounded border border-neutral-200 px-2 py-1 text-xs font-semibold hover:bg-neutral-50">Down</button>
                                  </>
                                )}
                                <button onClick={() => setSelectedTicket(ticket)} className="rounded border border-neutral-200 px-2 py-1 text-xs font-semibold hover:bg-neutral-50">Open Ticket</button>
                                <button onClick={() => openTicketPrintView(ticket, "print")} className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100">Print Ticket</button>
                                {(hqAdmin || driverUser) && <button onClick={() => markArrived(ticket)} className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100">Mark Arrived</button>}
                                {(hqAdmin || driverUser || managerUser) && <button onClick={() => { setSelectedTicket(ticket); }} className="rounded border border-success-200 bg-success-50 px-2 py-1 text-xs font-semibold text-success-700 hover:bg-success-100">{managerUser ? "Confirm Receipt" : "Mark Delivered"}</button>}
                                {(hqAdmin || driverUser || managerUser) && <button onClick={() => reportIssue(ticket)} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-100">Report Issue</button>}
                              </div>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            );
          })()}
        </Drawer>

        <Drawer
          isOpen={showAddStopsPicker}
          onClose={() => setShowAddStopsPicker(false)}
          title="Add Delivery Tickets"
          description={`Select open delivery tickets to add to run ${routeRun?.runNumber ?? ""}`}
          variant="dialog"
        >
          <div className="space-y-4 text-neutral-700">
            <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
              {activeTickets.length === 0 ? (
                <p className="text-sm text-neutral-500 text-center py-4">No active delivery tickets found.</p>
              ) : (
                activeTickets.map((ticket) => {
                  const isAssigned = !!ticket.deliveryRunId;
                  const runNum = ticket.deliveryRun?.runNumber || (ticket.deliveryRunId ? `Run ID: ${ticket.deliveryRunId}` : "");
                  const isAddressComplete = !!ticket.destinationAddress?.trim();
                  
                  return (
                    <label
                      key={ticket.id}
                      className={`flex items-start gap-3 rounded-xl border p-3 text-sm transition-colors ${
                        isAssigned
                          ? "border-neutral-100 bg-neutral-50/50 text-neutral-400 opacity-65 font-medium"
                          : "border-neutral-200 bg-white text-neutral-700 cursor-pointer hover:bg-neutral-50 font-medium"
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={isAssigned}
                        checked={selectedStopsToAssign.includes(ticket.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedStopsToAssign((prev) => [...prev, ticket.id]);
                          } else {
                            setSelectedStopsToAssign((prev) => prev.filter((id) => id !== ticket.id));
                          }
                        }}
                        className="mt-0.5 rounded border-neutral-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <strong className="font-mono text-xs text-neutral-900">{ticket.ticketNumber}</strong>
                          <span className="text-[10px] font-semibold">
                            {isAssigned ? (
                              <span className="text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                                Assigned: {runNum}
                              </span>
                            ) : (
                              <span className="text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">
                                Available
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-neutral-600 font-semibold truncate">
                          {ticket.destinationName || "No Destination Name"}
                        </div>
                        <div className="text-[11px] text-neutral-500 truncate">
                          {ticket.destinationAddress || "No destination address snapshot"}
                        </div>
                        <div className="mt-2 flex items-center justify-between text-[10px]">
                          <span className="text-neutral-400 font-mono">Req: {ticket.requisitionId}</span>
                          <span>
                            {isAddressComplete ? (
                              <span className="text-emerald-600 font-medium">Address: Complete</span>
                            ) : (
                              <span className="text-red-500 font-semibold">Address: Missing</span>
                            )}
                          </span>
                        </div>
                      </div>
                    </label>
                  );
                })
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-neutral-100 pt-3">
              <button
                onClick={() => setShowAddStopsPicker(false)}
                className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
              >
                Cancel
              </button>
              <button
                disabled={selectedStopsToAssign.length === 0}
                onClick={async () => {
                  if (!routeRun) return;
                  const res = await addTicketsToDeliveryRun(routeRun.id, selectedStopsToAssign);
                  if (res.success) {
                    setToast(`${selectedStopsToAssign.length} ticket(s) added to run.`);
                    setShowAddStopsPicker(false);
                    await refresh();
                    const updatedRunRes = await getDeliveryRunById(routeRun.id);
                    if (updatedRunRes.success) {
                      setRouteRun(updatedRunRes.data);
                    }
                  } else {
                    alert(`Failed to add tickets: ${res.error?.message ?? "Unknown error"}`);
                  }
                }}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Add Selected Tickets
              </button>
            </div>
          </div>
        </Drawer>

        <Drawer isOpen={!!runReport} onClose={() => setRunReport(null)} title={`Delivery Run Report ${runReport?.run?.runNumber ?? ""}`} variant="dialog">
          {runReport && (
            <DeliveryRunReport
              report={runReport}
              onPrint={() => window.print()}
              onPrintTicket={(ticket) => openTicketPrintView(ticket, "print")}
              onPrintAllTickets={(run) => openRunTicketsPrintView(run, "print")}
            />
          )}
        </Drawer>

        <Drawer isOpen={!!selectedVehicleLog} onClose={() => setSelectedVehicleLog(null)} title={`Vehicle Daily Log ${selectedVehicleLog?.vehicle?.vehicleName ?? ""}`} variant="dialog">
          {selectedVehicleLog && (
            <div className="space-y-4 text-neutral-700">
              <div className="rounded-xl border border-neutral-200 bg-white p-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                  <InfoLine icon={<Truck className="h-4 w-4" />} label="Vehicle" value={selectedVehicleLog.vehicle?.vehicleName ?? selectedVehicleLog.vehicleId} />
                  <InfoLine icon={<UserRound className="h-4 w-4" />} label="Driver" value={selectedVehicleLog.driver?.name ?? "—"} />
                  <InfoLine icon={<CalendarDays className="h-4 w-4" />} label="Date / Status" value={`${selectedVehicleLog.logDate}\n${labelize(selectedVehicleLog.status)}`} />
                  <InfoLine icon={<Gauge className="h-4 w-4" />} label="Variance" value={`${selectedVehicleLog.varianceKm ?? "—"} km`} />
                </div>
                {Number(selectedVehicleLog.varianceKm ?? 0) > 10 && (
                  <div className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${Number(selectedVehicleLog.varianceKm ?? 0) > 25 ? "border border-red-200 bg-red-50 text-red-800" : "border border-amber-200 bg-amber-50 text-amber-800"}`}>
                    <AlertTriangle className="h-4 w-4" />
                    Vehicle odometer km is higher than delivery run km. Please review fuel stops, detours, personal use, missing runs, or incorrect odometer entry.
                  </div>
                )}
                {selectedVehicleLog.status === "open" && (
                  <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <input type="number" min="0" value={vehicleLogCloseDraft.odometerEndKm} onChange={(e) => setVehicleLogCloseDraft({ ...vehicleLogCloseDraft, odometerEndKm: e.target.value })} placeholder="Ending odometer km" className="rounded-lg border border-neutral-200 px-3 py-2 text-sm" />
                    <input value={vehicleLogCloseDraft.fuelEndLevel} onChange={(e) => setVehicleLogCloseDraft({ ...vehicleLogCloseDraft, fuelEndLevel: e.target.value })} placeholder="Fuel end level" className="rounded-lg border border-neutral-200 px-3 py-2 text-sm" />
                    <textarea value={vehicleLogCloseDraft.endConditionNotes} onChange={(e) => setVehicleLogCloseDraft({ ...vehicleLogCloseDraft, endConditionNotes: e.target.value })} placeholder="End condition notes" className="min-h-20 rounded-lg border border-neutral-200 px-3 py-2 text-sm" />
                    <div className="space-y-2 rounded-lg border border-neutral-200 p-3">
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={vehicleLogCloseDraft.damageReported} onChange={(e) => setVehicleLogCloseDraft({ ...vehicleLogCloseDraft, damageReported: e.target.checked })} /> Damage reported</label>
                      <input value={vehicleLogCloseDraft.damageNotes} onChange={(e) => setVehicleLogCloseDraft({ ...vehicleLogCloseDraft, damageNotes: e.target.value })} placeholder="Damage notes" className="w-full rounded border border-neutral-200 px-2 py-1 text-sm" />
                    </div>
                    <button onClick={() => handleCloseVehicleLog(selectedVehicleLog)} className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white md:col-span-2">Close Vehicle Daily Log</button>
                  </div>
                )}
              </div>
              <div className="rounded-xl border border-neutral-200 bg-white p-4">
                <h3 className="mb-3 text-sm font-bold text-neutral-950">Linked Runs</h3>
                <div className="space-y-2">
                  {(selectedVehicleLog.runs ?? []).length === 0 ? <p className="text-sm text-neutral-500">No runs linked to this vehicle/date.</p> : selectedVehicleLog.runs.map((run: any) => (
                    <div key={run.id} className="flex items-center justify-between rounded-lg border border-neutral-200 p-3 text-sm">
                      <div><strong>{run.runNumber}</strong><div className="text-xs text-neutral-500">{formatDateTime(run.actualStartTime)} → {formatDateTime(run.actualEndTime)}</div></div>
                      <div className="text-right">{run.actualDistanceKm ?? 0} km<div className="text-xs text-neutral-500">{run.actualDurationMinutes ?? 0} min · {run.tickets?.length ?? 0} stops</div></div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Drawer>

        <Drawer isOpen={!!selectedRun} onClose={() => setSelectedRun(null)} title={`Edit Run ${selectedRun?.runNumber ?? ""}`} variant="dialog">
          {selectedRun && (
            <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-4 text-neutral-700">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <input type="date" value={selectedRun.runDate} onChange={(e) => setSelectedRun({ ...selectedRun, runDate: e.target.value })} className="rounded-lg border border-neutral-200 px-3 py-2" />
                <select value={selectedRun.driverId ?? ""} onChange={(e) => setSelectedRun({ ...selectedRun, driverId: e.target.value })} className="rounded-lg border border-neutral-200 px-3 py-2"><option value="">No driver</option>{drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
                <select value={selectedRun.vehicleId ?? ""} onChange={(e) => setSelectedRun({ ...selectedRun, vehicleId: e.target.value })} className="rounded-lg border border-neutral-200 px-3 py-2"><option value="">No vehicle</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.vehicleName}</option>)}</select>
                <select value={selectedRun.status} onChange={(e) => setSelectedRun({ ...selectedRun, status: e.target.value })} className="rounded-lg border border-neutral-200 px-3 py-2">{runStatuses.map((status) => <option key={status} value={status}>{labelize(status)}</option>)}</select>
                <input type="number" min="0" value={selectedRun.estimatedDistanceKm} onChange={(e) => setSelectedRun({ ...selectedRun, estimatedDistanceKm: Number(e.target.value) })} className="rounded-lg border border-neutral-200 px-3 py-2" placeholder="Estimated km" />
                <input type="number" min="0" value={selectedRun.estimatedDurationMinutes} onChange={(e) => setSelectedRun({ ...selectedRun, estimatedDurationMinutes: Number(e.target.value) })} className="rounded-lg border border-neutral-200 px-3 py-2" placeholder="Estimated minutes" />
                <input type="datetime-local" value={selectedRun.actualStartTime ? selectedRun.actualStartTime.slice(0, 16) : ""} onChange={(e) => setSelectedRun({ ...selectedRun, actualStartTime: e.target.value })} className="rounded-lg border border-neutral-200 px-3 py-2" />
                <input type="datetime-local" value={selectedRun.actualEndTime ? selectedRun.actualEndTime.slice(0, 16) : ""} onChange={(e) => setSelectedRun({ ...selectedRun, actualEndTime: e.target.value })} className="rounded-lg border border-neutral-200 px-3 py-2" />
              </div>
              <textarea value={selectedRun.notes ?? ""} onChange={(e) => setSelectedRun({ ...selectedRun, notes: e.target.value })} className="min-h-24 w-full rounded-lg border border-neutral-200 px-3 py-2" />
              <button onClick={async () => { const res = await updateDeliveryRun(selectedRun.id, selectedRun); if (!res.success) alert(res.error?.message ?? "Run update failed"); else { setSelectedRun(null); await refresh(); } }} className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white">Save Run</button>
            </div>
          )}
        </Drawer>
    </div>
  );
}

function InfoLine({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase text-neutral-500">{icon}{label}</div>
      <p className="mt-1 whitespace-pre-line text-sm font-medium text-neutral-900">{value || "—"}</p>
    </div>
  );
}

function DeliveryRunReport({
  report,
  onPrint,
  onPrintTicket,
  onPrintAllTickets,
}: {
  report: any;
  onPrint: () => void;
  onPrintTicket: (ticket: any) => void;
  onPrintAllTickets: (run: any) => void;
}) {
  const run = report.run;
  const vehicleLog = report.vehicleDailyLog;
  const vehicleTotals = report.vehicleTotals ?? {};
  const totals = report.totals ?? {};
  const orderedTickets = [...(run.tickets ?? [])].sort((a, b) => (a.stopSequence ?? 999) - (b.stopSequence ?? 999));

  return (
    <div className="space-y-4 text-neutral-700">
      <div id="delivery-ticket-print" className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex flex-col gap-3 border-b border-neutral-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-neutral-500">STOCK DHARMA Delivery Run Report</p>
            <h2 className="mt-1 text-2xl font-bold text-neutral-950">{run.runNumber}</h2>
            <p className="text-sm text-neutral-500">{run.runDate} · {run.driver?.name ?? "No driver"} · {run.vehicle?.vehicleName ?? "No vehicle"}</p>
          </div>
          <div className="print:hidden flex flex-wrap gap-2">
            <button onClick={onPrintAllTickets.bind(null, run)} className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100">
              <Printer className="h-4 w-4" /> Print All Tickets
            </button>
            <button onClick={onPrint} className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50">
              <Printer className="h-4 w-4" /> Print Report
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <InfoLine icon={<Clock className="h-4 w-4" />} label="Started" value={formatDateTime(run.actualStartTime)} />
          <InfoLine icon={<Clock className="h-4 w-4" />} label="Completed" value={formatDateTime(run.actualEndTime)} />
          <InfoLine icon={<Route className="h-4 w-4" />} label="KM" value={`Est ${run.estimatedDistanceKm ?? 0} (${run.routeEstimateSource === 'google' ? 'Google' : run.routeEstimateSource === 'google_manual' ? 'Google Manual' : 'Manual'})\nActual ${run.actualDistanceKm ?? 0}`} />
          <InfoLine icon={<Clock className="h-4 w-4" />} label="Minutes" value={`Est ${run.estimatedDurationMinutes ?? 0} (${run.routeEstimateSource === 'google' ? 'Google' : run.routeEstimateSource === 'google_manual' ? 'Google Manual' : 'Manual'})\nActual ${run.actualDurationMinutes ?? 0}`} />
        </div>

        <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4">
          <h3 className="text-sm font-bold text-neutral-950">Vehicle Odometer Cross-check</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
            <InfoLine icon={<Truck className="h-4 w-4" />} label="Log Status" value={vehicleLog ? labelize(vehicleLog.status) : "No vehicle daily log"} />
            <InfoLine icon={<Gauge className="h-4 w-4" />} label="Start KM" value={String(vehicleLog?.odometerStartKm ?? "—")} />
            <InfoLine icon={<Gauge className="h-4 w-4" />} label="End KM" value={String(vehicleLog?.odometerEndKm ?? "—")} />
            <InfoLine icon={<Route className="h-4 w-4" />} label="All Runs KM" value={String(vehicleTotals.totalRunKm ?? "—")} />
            <InfoLine icon={<AlertTriangle className="h-4 w-4" />} label="Variance" value={`${vehicleTotals.varianceKm ?? "—"} km`} />
          </div>
        </div>

        {/* Route Details Section */}
        <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4 space-y-3">
          <h3 className="text-sm font-bold text-neutral-950">Route Estimate & Leg-by-leg Details</h3>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <InfoLine icon={<Route className="h-4 w-4" />} label="Estimate Source" value={run.routeEstimateSource === 'google' ? 'Google API' : run.routeEstimateSource === 'google_manual' ? 'Google Maps Manual Entry' : 'Manual'} />
            <InfoLine icon={<Route className="h-4 w-4" />} label="Est Distance" value={`${run.estimatedDistanceKm ?? 0} km`} />
            <InfoLine icon={<Clock className="h-4 w-4" />} label="Est Duration" value={`${run.estimatedDurationMinutes ?? 0} minutes`} />
            <InfoLine icon={<RefreshCw className="h-4 w-4" />} label="Return to Start" value={run.googleRouteSummary?.returnToStart ? 'Yes' : 'No'} />
          </div>
          {run.routeEstimatedAt && (
            <p className="text-xs text-neutral-500">Route estimated at: {formatDateTime(run.routeEstimatedAt)}</p>
          )}

          {run.routeEstimateSource === 'google' && run.googleRouteSummary?.legs && (
            <div className="border-t border-neutral-200 pt-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-500 mb-2">Leg-by-leg Details</h4>
              <div className="space-y-2">
                {run.googleRouteSummary.legs.map((leg: any, idx: number) => (
                  <div key={idx} className="flex flex-col md:flex-row md:items-center justify-between border-b border-neutral-200/50 pb-2 text-xs text-neutral-700 gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-neutral-900">
                        Leg {leg.sequence}: {leg.fromName} → {leg.toName}
                      </div>
                      <div className="text-[11px] text-neutral-500 truncate">
                        {leg.fromAddress} → {leg.toAddress}
                      </div>
                      {leg.ticketNumber && (
                        <div className="text-[10px] font-medium text-neutral-500 mt-0.5">
                          Stop Ticket: {leg.ticketNumber} {leg.toName ? `(${leg.toName})` : ''}
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-bold text-neutral-900">{leg.distanceKm} km · {leg.durationMinutes} mins</div>
                      {leg.estimatedArrivalTime && (
                        <div className="text-[10px] text-neutral-500">ETA: {formatDateTime(leg.estimatedArrivalTime)}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 overflow-x-auto">
          <h3 className="mb-2 text-sm font-bold text-neutral-950">Stops Summary</h3>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-neutral-200 text-left text-xs uppercase text-neutral-500">
              <th className="py-2">Stop</th><th>Ticket</th><th>Location</th><th>Requisition</th><th>Status</th><th>Arrived</th><th>Delivered</th><th>Received</th><th>Issues</th><th className="print:hidden">Action</th>
            </tr></thead>
            <tbody>
              {orderedTickets.map((ticket, index) => (
                <tr key={ticket.id} className="border-b border-neutral-100">
                  <td className="py-2">{index + 1}</td>
                  <td>{ticket.ticketNumber}</td>
                  <td>{ticket.destinationName}<div className="text-xs text-neutral-400">{ticket.destinationAddress}</div></td>
                  <td>{ticket.requisitionId}</td>
                  <td>{labelize(ticket.status)}</td>
                  <td>{formatDateTime(ticket.arrivedAt)}</td>
                  <td>{formatDateTime(ticket.deliveredAt)}</td>
                  <td>{ticket.receivedBy || "—"}</td>
                  <td>{(ticket.items ?? []).reduce((sum: number, item: any) => sum + Number(item.issueQty ?? 0), 0)}</td>
                  <td className="print:hidden">
                    <button onClick={() => onPrintTicket(ticket)} className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100">
                      Print Ticket
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 overflow-x-auto">
          <h3 className="mb-2 text-sm font-bold text-neutral-950">Items Delivered</h3>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-neutral-200 text-left text-xs uppercase text-neutral-500">
              <th className="py-2">Ticket / Location</th><th>Item</th><th>Unit</th><th className="text-right">Shipped</th><th className="text-right">Delivered</th><th className="text-right">Issue</th><th>Issue Reason</th>
            </tr></thead>
            <tbody>
              {orderedTickets.flatMap((ticket) => (ticket.items ?? []).map((item: any) => (
                <tr key={`${ticket.id}-${item.id}`} className="border-b border-neutral-100">
                  <td className="py-2">{ticket.ticketNumber}<div className="text-xs text-neutral-400">{ticket.destinationName}</div></td>
                  <td>{item.itemName}</td>
                  <td>{item.unit}</td>
                  <td className="text-right">{item.shippedQty}</td>
                  <td className="text-right">{item.deliveredQty}</td>
                  <td className="text-right">{item.issueQty}</td>
                  <td>{item.issueReason || "—"}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <InfoLine icon={<MapPin className="h-4 w-4" />} label="Stops / Tickets" value={`${totals.stops ?? 0} / ${totals.tickets ?? 0}`} />
          <InfoLine icon={<PackageCheck className="h-4 w-4" />} label="Item Lines" value={String(totals.itemLines ?? 0)} />
          <InfoLine icon={<CheckCircle2 className="h-4 w-4" />} label="Delivered Qty" value={String(totals.deliveredQty ?? 0)} />
          <InfoLine icon={<AlertTriangle className="h-4 w-4" />} label="Issue Qty" value={String(totals.issueQty ?? 0)} />
        </div>
      </div>
    </div>
  );
}

function PeopleTable({ rows, type, onToggle }: { rows: any[]; type: "driver" | "vehicle"; onToggle: (row: any) => void }) {
  return (
    <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
      <CardHeader><CardTitle className="text-slate-950">{type === "driver" ? "Drivers" : "Vehicles"}</CardTitle></CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? <div className="p-5"><EmptyState title={`No ${type}s yet`} detail={`Add your first ${type} to assign delivery runs.`} /></div> : (
          <Table>
            <TableHeader className="bg-slate-50"><TableRow className="border-slate-100"><TableHead className="text-slate-500">Name</TableHead><TableHead className="text-slate-500">Contact</TableHead><TableHead className="text-slate-500">Status</TableHead><TableHead className="text-right text-slate-500">Action</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="border-slate-100">
                  <TableCell className="font-semibold text-slate-950">{type === "driver" ? row.name : row.vehicleName}<div className="text-xs text-slate-500">{type === "vehicle" ? row.plateNumber : row.notes}</div></TableCell>
                  <TableCell className="text-slate-500">{type === "driver" ? `${row.phone || "—"} ${row.email || ""}` : row.notes || "—"}</TableCell>
                  <TableCell>{row.active ? <span className="font-semibold text-emerald-700">Active</span> : <span className="text-slate-500">Inactive</span>}</TableCell>
                  <TableCell className="text-right"><button onClick={() => onToggle(row)} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700">{row.active ? "Deactivate" : "Activate"}</button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
