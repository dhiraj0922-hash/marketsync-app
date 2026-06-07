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
  type DeliveryRunStatus,
  type DeliveryTicketStatus,
} from "@/lib/storage";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin, resolveLocationId } from "@/lib/roles";
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
  FileText,
  Gauge,
  Play,
  SquareCheckBig,
} from "lucide-react";

const ticketStatuses: DeliveryTicketStatus[] = ["draft", "assigned", "loaded", "out_for_delivery", "delivered", "issue_reported", "cancelled"];
const runStatuses: DeliveryRunStatus[] = ["draft", "assigned", "loaded", "in_progress", "completed", "cancelled"];

const darkShellCss = `
  body .flex.bg-neutral-50.text-neutral-900.min-h-screen { background:#070707!important; color:#e4e4e7!important; }
  body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] { background:#111!important; border-color:#262626!important; }
  body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] a,
  body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] button { color:#a1a1aa!important; }
  body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] a[class*="bg-brand-50"],
  body div[class*="sm:w-56"][class*="bg-white"][class*="border-r"] a:hover { background:#2563eb!important; color:#fff!important; }
  body header[class*="bg-white"][class*="border-b"] { background:#111!important; border-color:#262626!important; box-shadow:none!important; }
  body header[class*="bg-white"] h1, body header[class*="bg-white"] button, body header[class*="bg-white"] span { color:#e4e4e7!important; }
  body header[class*="bg-white"] input, body header[class*="bg-white"] [role="button"] { background:#171717!important; border-color:#262626!important; color:#e4e4e7!important; }
  @media print {
    body * { visibility: hidden; }
    #delivery-ticket-print, #delivery-ticket-print * { visibility: visible; }
    #delivery-ticket-print { position: absolute; inset: 0; width: 100%; background: white; color: black; padding: 32px; }
  }
`;

const labelize = (value: string) => value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

function statusBadge(status: string) {
  const tone =
    status === "delivered" || status === "completed" ? "success" :
    status === "cancelled" || status === "issue_reported" ? "danger" :
    status === "out_for_delivery" || status === "in_progress" ? "warning" :
    "neutral";
  return <Badge variant={tone as any} className="rounded-md px-2 py-0.5">{labelize(status || "draft")}</Badge>;
}

function formatDateTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/10 bg-[#101010] p-10 text-center">
      <p className="text-sm font-semibold text-white">{title}</p>
      <p className="mt-1 text-xs text-zinc-500">{detail}</p>
    </div>
  );
}

export default function DeliveriesPage() {
  const { user } = useAuth();
  const hqAdmin = isHqAdmin(user);
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
  const [ticketFilter, setTicketFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [ticketSearch, setTicketSearch] = useState("");
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
  const [receivedBy, setReceivedBy] = useState("");
  const [ticketItemDrafts, setTicketItemDrafts] = useState<any[]>([]);

  const refresh = async () => {
    setLoading(true);
    try {
      const scopedLocation = hqAdmin ? undefined : userLocationId;
      const [ticketRows, runRows, driverRows, vehicleRows, locationRows, vehicleLogRows] = await Promise.all([
        getDeliveryTickets({ locationId: scopedLocation ?? undefined }),
        hqAdmin ? getDeliveryRuns() : Promise.resolve([]),
        hqAdmin ? getDrivers() : Promise.resolve([]),
        hqAdmin ? getVehicles() : Promise.resolve([]),
        loadLocations(),
        hqAdmin ? getVehicleDailyLogs() : Promise.resolve([]),
      ]);
      setTickets(ticketRows);
      setRuns(runRows);
      setDrivers(driverRows);
      setVehicles(vehicleRows);
      setLocations(locationRows);
      setVehicleLogs(vehicleLogRows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [hqAdmin, userLocationId]);

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
  }, [routeRun]);

  const visibleTickets = useMemo(() => {
    const q = ticketSearch.trim().toLowerCase();
    return tickets.filter((ticket) => {
      const statusOk = ticketFilter === "all" || ticket.status === ticketFilter;
      const locationOk = locationFilter === "all" || ticket.locationId === locationFilter;
      const searchOk = !q ||
        ticket.ticketNumber?.toLowerCase().includes(q) ||
        ticket.requisitionId?.toLowerCase().includes(q) ||
        ticket.destinationName?.toLowerCase().includes(q);
      return statusOk && locationOk && searchOk;
    });
  }, [tickets, ticketFilter, locationFilter, ticketSearch]);

  const openTickets = tickets.filter((ticket) => !ticket.deliveryRunId && !["delivered", "cancelled"].includes(ticket.status));

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
  };

  const handleRunStatus = async (run: any, status: DeliveryRunStatus) => {
    if (status === "completed") {
      const incomplete = (run.tickets ?? []).some((ticket: any) => !["delivered", "issue_reported", "cancelled"].includes(ticket.status));
      if (incomplete) return alert("A run can be completed only when all tickets are delivered, issue reported, or cancelled.");
    }
    const res = await updateDeliveryRun(run.id, { status });
    if (!res.success) return alert(`Could not update run: ${res.error?.message ?? "Unknown error"}`);
    await refresh();
  };

  const handleStartRun = async (run: any) => {
    const odometerStartKm = runControlDraft.odometerStartKm || run.odometerStartKm;
    if (odometerStartKm === "" || odometerStartKm == null) return alert("Starting odometer is required to start the run.");
    const res = await startDeliveryRun(run.id, { odometerStartKm });
    if (!res.success) return alert(`Could not start run: ${res.error?.message ?? "Unknown error"}`);
    setToast("Delivery run started.");
    setRouteRun(res.data);
    await refresh();
  };

  const handleCompleteRun = async (run: any) => {
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
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-[#070707] p-6 text-zinc-100">
      <style>{darkShellCss}</style>
      <div className="mx-auto max-w-[1408px] space-y-5">
        {toast && (
          <div className="fixed right-5 top-20 z-[140] rounded-lg border border-emerald-500/30 bg-emerald-950 px-4 py-3 text-sm text-emerald-100 shadow-2xl">
            {toast}
            <button className="ml-3 text-emerald-300" onClick={() => setToast(null)}>Dismiss</button>
          </div>
        )}

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-500">Delivery Management</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">Tickets & Runs</h1>
            <p className="mt-1 text-sm text-zinc-500">Operational delivery documents and driver runs. Inventory is not deducted here.</p>
          </div>
          <button onClick={refresh} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-[#151515] px-3 py-2 text-sm font-semibold text-zinc-200 hover:bg-white/10">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {[
            ["tickets", "Delivery Tickets", PackageCheck],
            ["runs", "Delivery Runs", Route],
            ["drivers", "Drivers", UserRound],
            ["vehicles", "Vehicles", Truck],
          ].filter(([key]) => hqAdmin || key === "tickets").map(([key, label, Icon]: any) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                activeTab === key ? "bg-blue-600 text-white" : "border border-white/10 bg-[#151515] text-zinc-400 hover:text-white"
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="rounded-xl border border-white/10 bg-[#111] p-10 text-center text-sm text-zinc-500">Loading deliveries...</div>
        ) : activeTab === "tickets" ? (
          <Card className="rounded-xl border-white/10 bg-[#111]">
            <CardHeader className="border-b border-white/5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <CardTitle className="text-white">Delivery Tickets</CardTitle>
                <div className="flex flex-wrap gap-2">
                  <input value={ticketSearch} onChange={(e) => setTicketSearch(e.target.value)} placeholder="Search tickets..." className="rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white placeholder:text-zinc-600" />
                  <select value={ticketFilter} onChange={(e) => setTicketFilter(e.target.value)} className="rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white">
                    <option value="all">All statuses</option>
                    {ticketStatuses.map((status) => <option key={status} value={status}>{labelize(status)}</option>)}
                  </select>
                  <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} className="rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white">
                    <option value="all">All locations</option>
                    {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                  </select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {visibleTickets.length === 0 ? <div className="p-5"><EmptyState title="No delivery tickets found" detail="Generate tickets from approved or fulfilled requisitions." /></div> : (
                <Table>
                  <TableHeader className="bg-[#151515]">
                    <TableRow className="border-white/5">
                      <TableHead className="text-zinc-500">Ticket</TableHead>
                      <TableHead className="text-zinc-500">Requisition</TableHead>
                      <TableHead className="text-zinc-500">Destination</TableHead>
                      <TableHead className="text-zinc-500">Run</TableHead>
                      <TableHead className="text-zinc-500">Status</TableHead>
                      <TableHead className="text-right text-zinc-500">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleTickets.map((ticket) => (
                      <TableRow key={ticket.id} className="border-white/5 hover:bg-white/[0.03]">
                        <TableCell className="font-mono text-xs text-zinc-300">{ticket.ticketNumber}</TableCell>
                        <TableCell className="font-mono text-xs text-zinc-500">{ticket.requisitionId}</TableCell>
                        <TableCell>
                          <div className="font-semibold text-white">{ticket.destinationName || "—"}</div>
                          <div className="text-xs text-zinc-500">{ticket.destinationAddress || ticket.locationId || "No address snapshot"}</div>
                        </TableCell>
                        <TableCell className="text-zinc-400">{ticket.deliveryRun?.runNumber ?? "Unassigned"}</TableCell>
                        <TableCell>{statusBadge(ticket.status)}</TableCell>
                        <TableCell className="text-right">
                          <button onClick={() => setSelectedTicket(ticket)} className="rounded-md border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-white/10">Open</button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        ) : activeTab === "runs" && hqAdmin ? (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[390px_1fr]">
            <Card className="rounded-xl border-white/10 bg-[#111]">
              <CardHeader className="border-b border-white/5"><CardTitle className="text-white">Create Delivery Run</CardTitle></CardHeader>
              <CardContent className="space-y-3 p-4">
                <input type="date" value={newRun.runDate} onChange={(e) => setNewRun({ ...newRun, runDate: e.target.value })} className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
                <select value={newRun.driverId} onChange={(e) => setNewRun({ ...newRun, driverId: e.target.value })} className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white">
                  <option value="">Assign driver later</option>
                  {drivers.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <select value={newRun.vehicleId} onChange={(e) => setNewRun({ ...newRun, vehicleId: e.target.value })} className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white">
                  <option value="">No vehicle</option>
                  {vehicles.filter((v) => v.active).map((v) => <option key={v.id} value={v.id}>{v.vehicleName} {v.plateNumber ? `(${v.plateNumber})` : ""}</option>)}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <input type="number" min="0" value={newRun.estimatedDistanceKm} onChange={(e) => setNewRun({ ...newRun, estimatedDistanceKm: Number(e.target.value) })} placeholder="Estimated km" className="rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
                  <input type="number" min="0" value={newRun.estimatedDurationMinutes} onChange={(e) => setNewRun({ ...newRun, estimatedDurationMinutes: Number(e.target.value) })} placeholder="Minutes" className="rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
                </div>
                <textarea value={newRun.notes} onChange={(e) => setNewRun({ ...newRun, notes: e.target.value })} placeholder="Run notes" className="min-h-20 w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
                <div className="rounded-lg border border-white/10 bg-[#151515] p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Open tickets</p>
                  <div className="max-h-52 space-y-2 overflow-y-auto">
                    {openTickets.length === 0 ? <p className="text-xs text-zinc-500">No open tickets available.</p> : openTickets.map((ticket) => (
                      <label key={ticket.id} className="flex items-start gap-2 rounded-md border border-white/5 p-2 text-xs text-zinc-300">
                        <input type="checkbox" checked={newRun.ticketIds.includes(ticket.id)} onChange={(e) => setNewRun((prev) => ({ ...prev, ticketIds: e.target.checked ? [...prev.ticketIds, ticket.id] : prev.ticketIds.filter((id) => id !== ticket.id) }))} />
                        <span><strong>{ticket.ticketNumber}</strong><br />{ticket.destinationName}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <button onClick={handleCreateRun} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500">
                  <Plus className="h-4 w-4" /> Create Run
                </button>
              </CardContent>
            </Card>

            <div className="space-y-4">
              {runs.length === 0 ? <EmptyState title="No delivery runs yet" detail="Create a run and assign open delivery tickets as stops." /> : runs.map((run) => {
                const orderedTickets = [...(run.tickets ?? [])].sort((a, b) => (a.stopSequence ?? 999) - (b.stopSequence ?? 999));
                const matchingVehicleLog = run.vehicleId
                  ? vehicleLogs.find((log) => log.vehicleId === run.vehicleId && log.logDate === run.runDate)
                  : null;
                return (
                  <Card key={run.id} className="rounded-xl border-white/10 bg-[#111]">
                    <CardHeader className="border-b border-white/5">
                      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <CardTitle className="text-white">{run.runNumber}</CardTitle>
                          <p className="mt-1 text-xs text-zinc-500">{run.runDate} · {run.driver?.name ?? "No driver"} · {run.vehicle?.vehicleName ?? "No vehicle"}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {statusBadge(run.status)}
                          <select value={run.status} onChange={(e) => handleRunStatus(run, e.target.value as DeliveryRunStatus)} className="rounded-md border border-white/10 bg-[#171717] px-2 py-1 text-xs text-white">
                            {runStatuses.map((status) => <option key={status} value={status}>{labelize(status)}</option>)}
                          </select>
                          <button onClick={() => setRouteRun(run)} className="inline-flex items-center gap-1 rounded-md border border-blue-500/30 px-3 py-1.5 text-xs font-semibold text-blue-200 hover:bg-blue-500/10"><Route className="h-3.5 w-3.5" /> Manage Route</button>
                          <button onClick={() => openRunReport(run)} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-white/10"><FileText className="h-3.5 w-3.5" /> Report</button>
                          <button onClick={() => setSelectedRun(run)} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-white/10"><Edit3 className="h-3.5 w-3.5" /> Edit</button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="p-4">
                      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
                        <div className="rounded-lg bg-[#171717] p-3"><p className="text-[10px] uppercase text-zinc-500">Stops</p><p className="text-lg font-bold text-white">{orderedTickets.length}</p></div>
                        <div className="rounded-lg bg-[#171717] p-3"><p className="text-[10px] uppercase text-zinc-500">Estimated km</p><p className="text-lg font-bold text-white">{run.estimatedDistanceKm}</p></div>
                        <div className="rounded-lg bg-[#171717] p-3"><p className="text-[10px] uppercase text-zinc-500">Est. minutes</p><p className="text-lg font-bold text-white">{run.estimatedDurationMinutes}</p></div>
                        <div className="rounded-lg bg-[#171717] p-3"><p className="text-[10px] uppercase text-zinc-500">Actual km</p><p className="text-lg font-bold text-white">{run.actualDistanceKm ?? 0}</p></div>
                        <div className="rounded-lg bg-[#171717] p-3"><p className="text-[10px] uppercase text-zinc-500">Actual min</p><p className="text-lg font-bold text-white">{run.actualDurationMinutes ?? 0}</p></div>
                        <div className="rounded-lg bg-[#171717] p-3"><p className="text-[10px] uppercase text-zinc-500">Started</p><p className="text-sm font-bold text-white">{formatDateTime(run.actualStartTime)}</p></div>
                        <div className="rounded-lg bg-[#171717] p-3"><p className="text-[10px] uppercase text-zinc-500">Completed</p><p className="text-sm font-bold text-white">{formatDateTime(run.actualEndTime)}</p></div>
                        <div className="rounded-lg bg-[#171717] p-3"><p className="text-[10px] uppercase text-zinc-500">Odometer</p><p className="text-sm font-bold text-white">{run.odometerStartKm ?? "—"} → {run.odometerEndKm ?? "—"}</p></div>
                      </div>
                      {run.vehicleId && !matchingVehicleLog && (
                        <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
                          <AlertTriangle className="h-4 w-4" /> No vehicle daily log opened for this vehicle/date.
                        </div>
                      )}
                      <div className="space-y-2">
                        {orderedTickets.map((ticket, index) => (
                          <div key={ticket.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-[#151515] p-3">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-white">#{index + 1} {ticket.destinationName}</p>
                              <p className="text-xs text-zinc-500">{ticket.ticketNumber} · {ticket.destinationAddress || ticket.locationId}</p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button onClick={() => moveStop(run, ticket.id, -1)} className="rounded border border-white/10 px-2 py-1 text-xs text-zinc-300">Up</button>
                              <button onClick={() => moveStop(run, ticket.id, 1)} className="rounded border border-white/10 px-2 py-1 text-xs text-zinc-300">Down</button>
                              <button onClick={() => setSelectedTicket(ticket)} className="rounded border border-white/10 px-2 py-1 text-xs text-zinc-300">Open</button>
                              <button onClick={async () => { await removeTicketFromDeliveryRun(ticket.id); await refresh(); }} className="rounded border border-red-500/30 px-2 py-1 text-xs text-red-300">Remove</button>
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
            <Card className="rounded-xl border-white/10 bg-[#111]"><CardHeader><CardTitle className="text-white">Add Driver</CardTitle></CardHeader><CardContent className="space-y-2">
              <input value={driverDraft.name} onChange={(e) => setDriverDraft({ ...driverDraft, name: e.target.value })} placeholder="Name" className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
              <input value={driverDraft.phone} onChange={(e) => setDriverDraft({ ...driverDraft, phone: e.target.value })} placeholder="Phone" className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
              <input value={driverDraft.email} onChange={(e) => setDriverDraft({ ...driverDraft, email: e.target.value })} placeholder="Email" className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
              <input type="number" value={driverDraft.hourlyRate} onChange={(e) => setDriverDraft({ ...driverDraft, hourlyRate: e.target.value })} placeholder="Hourly rate" className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
              <textarea value={driverDraft.notes} onChange={(e) => setDriverDraft({ ...driverDraft, notes: e.target.value })} placeholder="Notes" className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
              <button onClick={handleCreateDriver} className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white">Save Driver</button>
            </CardContent></Card>
            <PeopleTable rows={drivers} type="driver" onToggle={async (row) => { await updateDriver(row.id, { active: !row.active }); await refresh(); }} />
          </div>
        ) : activeTab === "vehicles" && hqAdmin ? (
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]">
              <Card className="rounded-xl border-white/10 bg-[#111]"><CardHeader><CardTitle className="text-white">Add Vehicle</CardTitle></CardHeader><CardContent className="space-y-2">
                <input value={vehicleDraft.vehicleName} onChange={(e) => setVehicleDraft({ ...vehicleDraft, vehicleName: e.target.value })} placeholder="Vehicle name" className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
                <input value={vehicleDraft.plateNumber} onChange={(e) => setVehicleDraft({ ...vehicleDraft, plateNumber: e.target.value })} placeholder="Plate number" className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
                <textarea value={vehicleDraft.notes} onChange={(e) => setVehicleDraft({ ...vehicleDraft, notes: e.target.value })} placeholder="Notes" className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
                <button onClick={handleCreateVehicle} className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white">Save Vehicle</button>
              </CardContent></Card>
              <PeopleTable rows={vehicles} type="vehicle" onToggle={async (row) => { await updateVehicle(row.id, { active: !row.active }); await refresh(); }} />
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]">
              <Card className="rounded-xl border-white/10 bg-[#111]">
                <CardHeader className="border-b border-white/5"><CardTitle className="text-white">Open Vehicle Daily Log</CardTitle></CardHeader>
                <CardContent className="space-y-2 p-4">
                  <select value={vehicleLogDraft.vehicleId} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, vehicleId: e.target.value })} className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white">
                    <option value="">Select vehicle</option>
                    {vehicles.filter((v) => v.active).map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicleName} {vehicle.plateNumber ? `(${vehicle.plateNumber})` : ""}</option>)}
                  </select>
                  <select value={vehicleLogDraft.driverId} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, driverId: e.target.value })} className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white">
                    <option value="">Driver optional</option>
                    {drivers.filter((d) => d.active).map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
                  </select>
                  <input type="date" value={vehicleLogDraft.logDate} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, logDate: e.target.value })} className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
                  <input type="number" min="0" value={vehicleLogDraft.odometerStartKm} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, odometerStartKm: e.target.value })} placeholder="Starting odometer km" className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
                  <input value={vehicleLogDraft.fuelStartLevel} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, fuelStartLevel: e.target.value })} placeholder="Fuel start level" className="w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
                  <textarea value={vehicleLogDraft.startConditionNotes} onChange={(e) => setVehicleLogDraft({ ...vehicleLogDraft, startConditionNotes: e.target.value })} placeholder="Start condition notes" className="min-h-20 w-full rounded-lg border border-white/10 bg-[#171717] px-3 py-2 text-sm text-white" />
                  <button onClick={handleOpenVehicleLog} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white"><Gauge className="h-4 w-4" /> Open Daily Log</button>
                </CardContent>
              </Card>

              <Card className="rounded-xl border-white/10 bg-[#111]">
                <CardHeader className="border-b border-white/5"><CardTitle className="text-white">Vehicle Daily Logs</CardTitle></CardHeader>
                <CardContent className="p-0">
                  {vehicleLogs.length === 0 ? <div className="p-5"><EmptyState title="No vehicle daily logs" detail="Open a daily log before dispatch to compare odometer usage later." /></div> : (
                    <Table>
                      <TableHeader className="bg-[#151515]">
                        <TableRow className="border-white/5">
                          <TableHead className="text-zinc-500">Date</TableHead>
                          <TableHead className="text-zinc-500">Vehicle</TableHead>
                          <TableHead className="text-zinc-500">Driver</TableHead>
                          <TableHead className="text-zinc-500">KM</TableHead>
                          <TableHead className="text-zinc-500">Variance</TableHead>
                          <TableHead className="text-zinc-500">Damage</TableHead>
                          <TableHead className="text-right text-zinc-500">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {vehicleLogs.map((log) => (
                          <TableRow key={log.id} className="border-white/5">
                            <TableCell className="text-zinc-300">{log.logDate}<div>{statusBadge(log.status)}</div></TableCell>
                            <TableCell className="font-semibold text-white">{log.vehicle?.vehicleName ?? log.vehicleId}</TableCell>
                            <TableCell className="text-zinc-400">{log.driver?.name ?? "—"}</TableCell>
                            <TableCell className="text-zinc-400">{log.odometerStartKm} → {log.odometerEndKm ?? "—"}<div className="text-xs text-zinc-600">Total {log.totalOdometerKm ?? "—"} km</div></TableCell>
                            <TableCell className={`${Number(log.varianceKm ?? 0) > 25 ? "text-red-300" : Number(log.varianceKm ?? 0) > 10 ? "text-amber-300" : "text-zinc-400"}`}>{log.varianceKm ?? "—"} km</TableCell>
                            <TableCell className={log.damageReported ? "text-red-300" : "text-zinc-500"}>{log.damageReported ? "Yes" : "No"}</TableCell>
                            <TableCell className="text-right"><button onClick={() => openVehicleLogReport(log)} className="rounded-md border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-white/10">{log.status === "open" ? "Close / View" : "View Logs"}</button></TableCell>
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

        <Drawer
          isOpen={!!selectedTicket}
          onClose={() => setSelectedTicket(null)}
          title={`Delivery Ticket ${selectedTicket?.ticketNumber ?? ""}`}
          description={`Requisition ${selectedTicket?.requisitionId ?? "—"} · ${selectedTicket?.destinationName ?? "—"}`}
          variant="dialog"
          footer={selectedTicket && (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <button onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"><Printer className="h-4 w-4" /> Print</button>
              <div className="flex flex-wrap gap-2">
                {hqAdmin && ticketStatuses.map((status) => (
                  <button key={status} onClick={async () => { const res = await updateDeliveryTicketStatus(selectedTicket.id, status); if (!res.success) alert(res.error?.message ?? "Update failed"); else { setSelectedTicket({ ...selectedTicket, status }); await refresh(); } }} className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs font-semibold text-neutral-700 hover:bg-neutral-50">{labelize(status)}</button>
                ))}
                {hqAdmin && <button onClick={saveTicketItems} className="rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white">Save Lines</button>}
                {hqAdmin && <button onClick={() => markArrived()} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white">Mark Arrived</button>}
                {hqAdmin && <button onClick={() => reportIssue()} className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white">Report Issue</button>}
                {hqAdmin && <button onClick={markDelivered} className="rounded-lg bg-success-600 px-3 py-2 text-sm font-semibold text-white">Mark Delivered</button>}
              </div>
            </div>
          )}
        >
          {selectedTicket && (
            <div className="space-y-4 text-neutral-700">
              <div id="delivery-ticket-print" className="rounded-xl border border-neutral-200 bg-white p-5">
                <div className="flex flex-col gap-3 border-b border-neutral-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-neutral-500">STOCK DHARMA Delivery Ticket</p>
                    <h2 className="mt-1 text-2xl font-bold text-neutral-950">{selectedTicket.ticketNumber}</h2>
                    <p className="text-sm text-neutral-500">Requisition {selectedTicket.requisitionId}</p>
                  </div>
                  <div className="text-left sm:text-right">
                    {statusBadge(selectedTicket.status)}
                    <p className="mt-2 text-xs text-neutral-500">Run: {selectedTicket.deliveryRun?.runNumber ?? "Unassigned"}</p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <InfoLine icon={<MapPin className="h-4 w-4" />} label="Destination" value={`${selectedTicket.destinationName || "—"}\n${selectedTicket.destinationAddress || "No address snapshot"}`} />
                  <InfoLine icon={<Truck className="h-4 w-4" />} label="Driver / Vehicle" value={`${selectedTicket.deliveryRun?.driver?.name ?? "—"}\n${selectedTicket.deliveryRun?.vehicle?.vehicleName ?? "—"}`} />
                  <InfoLine icon={<Clock className="h-4 w-4" />} label="Arrived At" value={formatDateTime(selectedTicket.arrivedAt)} />
                  <InfoLine icon={<Clock className="h-4 w-4" />} label="Delivered At" value={formatDateTime(selectedTicket.deliveredAt)} />
                  <InfoLine icon={<UserRound className="h-4 w-4" />} label="Received By" value={selectedTicket.receivedBy || "Signature required"} />
                </div>
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 text-left text-xs uppercase text-neutral-500">
                        <th className="py-2">Item</th><th className="py-2 text-right">Requested</th><th className="py-2 text-right">Approved</th><th className="py-2 text-right">Shipped</th><th className="py-2 text-right">Delivered</th><th className="py-2 text-right">Issue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ticketItemDrafts.map((item, index) => (
                        <tr key={item.id} className="border-b border-neutral-100">
                          <td className="py-2 font-medium text-neutral-900">{item.itemName}<div className="text-xs text-neutral-400">{item.unit}</div></td>
                          <td className="py-2 text-right">{item.requestedQty}</td>
                          <td className="py-2 text-right">{item.approvedQty}</td>
                          <td className="py-2 text-right">{item.shippedQty}</td>
                          <td className="py-2 text-right">
                            {hqAdmin ? <input type="number" min="0" value={item.deliveredQty} onChange={(e) => setTicketItemDrafts((prev) => prev.map((row, idx) => idx === index ? { ...row, deliveredQty: Number(e.target.value) } : row))} className="w-20 rounded border border-neutral-200 px-2 py-1 text-right" /> : item.deliveredQty}
                          </td>
                          <td className="py-2 text-right">
                            {hqAdmin ? (
                              <div className="flex justify-end gap-2">
                                <input type="number" min="0" value={item.issueQty} onChange={(e) => setTicketItemDrafts((prev) => prev.map((row, idx) => idx === index ? { ...row, issueQty: Number(e.target.value) } : row))} className="w-16 rounded border border-neutral-200 px-2 py-1 text-right" />
                                <input value={item.issueReason ?? ""} onChange={(e) => setTicketItemDrafts((prev) => prev.map((row, idx) => idx === index ? { ...row, issueReason: e.target.value } : row))} placeholder="Reason" className="w-32 rounded border border-neutral-200 px-2 py-1" />
                              </div>
                            ) : item.issueQty}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div><p className="text-xs font-semibold uppercase text-neutral-500">Notes</p><p className="mt-1 whitespace-pre-wrap text-sm">{selectedTicket.notes || "—"}</p></div>
                  <div className="border-t border-neutral-300 pt-8 text-sm text-neutral-500">Receiver signature</div>
                </div>
              </div>
              {hqAdmin && (
                <div className="rounded-xl border border-neutral-200 bg-white p-4">
                  <label className="text-xs font-semibold uppercase text-neutral-500">Received by</label>
                  <input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Receiver name" className="mt-1 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm" />
                  <label className="mt-3 block text-xs font-semibold uppercase text-neutral-500">Ticket notes</label>
                  <textarea value={selectedTicket.notes ?? ""} onChange={(e) => setSelectedTicket({ ...selectedTicket, notes: e.target.value })} onBlur={async () => { await updateDeliveryTicket(selectedTicket.id, { notes: selectedTicket.notes }); await refresh(); }} className="mt-1 min-h-20 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm" />
                  <label className="mt-3 block text-xs font-semibold uppercase text-neutral-500">Delivery notes</label>
                  <textarea value={selectedTicket.deliveryNotes ?? ""} onChange={(e) => setSelectedTicket({ ...selectedTicket, deliveryNotes: e.target.value })} onBlur={async () => { await updateDeliveryTicket(selectedTicket.id, { deliveryNotes: selectedTicket.deliveryNotes }); await refresh(); }} className="mt-1 min-h-20 w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm" />
                </div>
              )}
            </div>
          )}
        </Drawer>

        <Drawer isOpen={!!routeRun} onClose={() => setRouteRun(null)} title={`Manage Route ${routeRun?.runNumber ?? ""}`} description="Start the run, manage stops, and record odometer actuals." variant="dialog">
          {routeRun && (() => {
            const orderedTickets = [...(routeRun.tickets ?? [])].sort((a, b) => (a.stopSequence ?? 999) - (b.stopSequence ?? 999));
            const vehicleLog = routeRun.vehicleId ? vehicleLogs.find((log) => log.vehicleId === routeRun.vehicleId && log.logDate === routeRun.runDate) : null;
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

                <div className="space-y-2">
                  {orderedTickets.map((ticket, index) => (
                    <div key={ticket.id} className="rounded-xl border border-neutral-200 bg-white p-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <p className="text-sm font-bold text-neutral-950">Stop #{index + 1} · {ticket.destinationName}</p>
                          <p className="text-xs text-neutral-500">{ticket.ticketNumber} · Requisition {ticket.requisitionId}</p>
                          <p className="mt-1 text-xs text-neutral-500">{ticket.destinationAddress || "No address snapshot"}</p>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-neutral-500">
                            <span>ETA: {formatDateTime(ticket.estimatedArrivalTime)}</span>
                            <span>Arrived: {formatDateTime(ticket.arrivedAt)}</span>
                            <span>Delivered: {formatDateTime(ticket.deliveredAt)}</span>
                            <span>Received: {ticket.receivedBy || "—"}</span>
                            <span>Issues: {(ticket.items ?? []).reduce((sum: number, item: any) => sum + Number(item.issueQty ?? 0), 0)}</span>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {statusBadge(ticket.status)}
                          <button onClick={() => moveStop(routeRun, ticket.id, -1)} className="rounded border border-neutral-200 px-2 py-1 text-xs">Up</button>
                          <button onClick={() => moveStop(routeRun, ticket.id, 1)} className="rounded border border-neutral-200 px-2 py-1 text-xs">Down</button>
                          <button onClick={() => setSelectedTicket(ticket)} className="rounded border border-neutral-200 px-2 py-1 text-xs">Open Ticket</button>
                          <button onClick={() => markArrived(ticket)} className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-700">Mark Arrived</button>
                          <button onClick={() => { setSelectedTicket(ticket); }} className="rounded border border-success-200 bg-success-50 px-2 py-1 text-xs text-success-700">Mark Delivered</button>
                          <button onClick={() => reportIssue(ticket)} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700">Report Issue</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </Drawer>

        <Drawer isOpen={!!runReport} onClose={() => setRunReport(null)} title={`Delivery Run Report ${runReport?.run?.runNumber ?? ""}`} variant="dialog">
          {runReport && <DeliveryRunReport report={runReport} onPrint={() => window.print()} />}
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

function DeliveryRunReport({ report, onPrint }: { report: any; onPrint: () => void }) {
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
          <button onClick={onPrint} className="print:hidden inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50">
            <Printer className="h-4 w-4" /> Print
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <InfoLine icon={<Clock className="h-4 w-4" />} label="Started" value={formatDateTime(run.actualStartTime)} />
          <InfoLine icon={<Clock className="h-4 w-4" />} label="Completed" value={formatDateTime(run.actualEndTime)} />
          <InfoLine icon={<Route className="h-4 w-4" />} label="KM" value={`Est ${run.estimatedDistanceKm ?? 0}\nActual ${run.actualDistanceKm ?? 0}`} />
          <InfoLine icon={<Clock className="h-4 w-4" />} label="Minutes" value={`Est ${run.estimatedDurationMinutes ?? 0}\nActual ${run.actualDurationMinutes ?? 0}`} />
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

        <div className="mt-5 overflow-x-auto">
          <h3 className="mb-2 text-sm font-bold text-neutral-950">Stops Summary</h3>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-neutral-200 text-left text-xs uppercase text-neutral-500">
              <th className="py-2">Stop</th><th>Ticket</th><th>Location</th><th>Requisition</th><th>Status</th><th>Arrived</th><th>Delivered</th><th>Received</th><th>Issues</th>
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
    <Card className="rounded-xl border-white/10 bg-[#111]">
      <CardHeader><CardTitle className="text-white">{type === "driver" ? "Drivers" : "Vehicles"}</CardTitle></CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? <div className="p-5"><EmptyState title={`No ${type}s yet`} detail={`Add your first ${type} to assign delivery runs.`} /></div> : (
          <Table>
            <TableHeader className="bg-[#151515]"><TableRow className="border-white/5"><TableHead className="text-zinc-500">Name</TableHead><TableHead className="text-zinc-500">Contact</TableHead><TableHead className="text-zinc-500">Status</TableHead><TableHead className="text-right text-zinc-500">Action</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="border-white/5">
                  <TableCell className="font-semibold text-white">{type === "driver" ? row.name : row.vehicleName}<div className="text-xs text-zinc-500">{type === "vehicle" ? row.plateNumber : row.notes}</div></TableCell>
                  <TableCell className="text-zinc-400">{type === "driver" ? `${row.phone || "—"} ${row.email || ""}` : row.notes || "—"}</TableCell>
                  <TableCell>{row.active ? <span className="text-emerald-300">Active</span> : <span className="text-zinc-500">Inactive</span>}</TableCell>
                  <TableCell className="text-right"><button onClick={() => onToggle(row)} className="rounded-md border border-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-200">{row.active ? "Deactivate" : "Activate"}</button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
