"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  FileText,
  Filter,
  Loader2,
  Play,
  Save,
  Search,
  Send,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/components/AuthProvider";
import {
  approveAndPostEnterpriseFgCountSession,
  createEnterpriseFgCountSession,
  loadEnterpriseFgCountSessionById,
  loadEnterpriseFgCountSessions,
  loadLocations,
  saveEnterpriseFgCountDraft,
  submitEnterpriseFgCountSession,
  type EnterpriseFgCountLine,
  type EnterpriseFgCountSession,
  type EnterpriseFgCountSessionDetail,
} from "@/lib/storage";
import { isHqMaster, isHqOps, isLocationManager, resolveLocationId } from "@/lib/roles";
import { isActiveLocation } from "@/lib/locationRegistry";

const COUNT_TYPES = ["Opening Count", "Closing Count", "Weekly Count", "Monthly Count", "Cycle Count", "Spot Audit"];
const STATUSES = ["All", "draft", "submitted", "approved", "rejected", "cancelled"];

const todayISO = () => {
  const d = new Date();
  const offsetMs = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, 10);
};

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

const qty = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const dateLabel = (iso?: string | null) => {
  if (!iso) return "Not recorded";
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const dateTimeLabel = (iso?: string | null) => {
  if (!iso) return "Not recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
};

const statusTone = (status: string) => {
  if (status === "approved") return "success";
  if (status === "submitted") return "default";
  if (status === "draft") return "warning";
  if (status === "rejected" || status === "cancelled") return "danger";
  return "neutral";
};

type LineDraft = Record<string, { physicalQty: string; notes: string }>;

export default function FgCountPage() {
  return <FgCountContent />;
}

export function FgCountContent() {
  const { user } = useAuth();
  const canApprove = isHqMaster(user);
  const canCreate = isHqMaster(user) || isHqOps(user) || isLocationManager(user);
  const isReadOnly = !canCreate && !canApprove;
  const userLocationId = resolveLocationId(user);

  const [sessions, setSessions] = useState<EnterpriseFgCountSession[]>([]);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [locationFilter, setLocationFilter] = useState("All");
  const [businessDateFilter, setBusinessDateFilter] = useState("");
  const [countTypeFilter, setCountTypeFilter] = useState("All");

  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeDetail, setActiveDetail] = useState<EnterpriseFgCountSessionDetail | null>(null);
  const [lineDraft, setLineDraft] = useState<LineDraft>({});

  const [newLocationId, setNewLocationId] = useState("LOC-HQ");
  const [newBusinessDate, setNewBusinessDate] = useState(todayISO());
  const [newSessionName, setNewSessionName] = useState("");
  const [newCountType, setNewCountType] = useState("Closing Count");
  const [newCounterName, setNewCounterName] = useState(user?.name || user?.email || "");
  const [newNotes, setNewNotes] = useState("");
  const [duplicateSessionId, setDuplicateSessionId] = useState<string | null>(null);

  const [lineSearch, setLineSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [varianceFilter, setVarianceFilter] = useState("All");
  const [approvalReason, setApprovalReason] = useState("");

  const loadDashboard = useCallback(async () => {
    setIsLoading(true);
    try {
      const [loadedSessions, loadedLocations] = await Promise.all([
        loadEnterpriseFgCountSessions(),
        loadLocations(),
      ]);
      setSessions(loadedSessions);
      setLocations(
        (loadedLocations || [])
          .filter((loc: any) => isActiveLocation(loc))
          .map((loc: any) => ({ id: loc.id, name: loc.name }))
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (isLocationManager(user)) {
      setNewLocationId(userLocationId);
      setLocationFilter(userLocationId);
    } else {
      setNewLocationId("LOC-HQ");
    }
  }, [user, userLocationId]);

  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessions.filter((session) => {
      if (statusFilter !== "All" && session.status !== statusFilter) return false;
      if (locationFilter !== "All" && session.locationId !== locationFilter) return false;
      if (businessDateFilter && session.businessDate !== businessDateFilter) return false;
      if (countTypeFilter !== "All" && session.countType !== countTypeFilter) return false;
      if (q) {
        const haystack = [
          session.sessionName,
          session.locationName,
          session.locationId,
          session.countType,
          session.status,
          session.counterName,
        ].join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [businessDateFilter, countTypeFilter, locationFilter, search, sessions, statusFilter]);

  const dashboard = useMemo(() => {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthSessions = sessions.filter(s => s.businessDate.startsWith(monthKey));
    return {
      pendingReview: sessions.filter(s => s.status === "submitted").length,
      drafts: sessions.filter(s => s.status === "draft").length,
      approvedMtd: monthSessions.filter(s => s.status === "approved").reduce((sum, s) => sum + s.varianceValue, 0),
      sessionsThisMonth: monthSessions.length,
      totalVariance: sessions.filter(s => s.status === "approved").reduce((sum, s) => sum + s.varianceValue, 0),
    };
  }, [sessions]);

  const openSession = async (sessionId: string) => {
    setIsSaving(true);
    try {
      const detail = await loadEnterpriseFgCountSessionById(sessionId);
      if (!detail) {
        setMessage("FG count session could not be loaded.");
        return;
      }
      setActiveDetail(detail);
      setLineDraft(Object.fromEntries(detail.lines.map(line => [
        line.itemId,
        {
          physicalQty: line.physicalQtyEntered ? String(line.physicalQty) : "",
          notes: line.notes ?? "",
        },
      ])));
      setLineSearch("");
      setCategoryFilter("All");
      setVarianceFilter("All");
      setApprovalReason("");
      setDetailOpen(true);
    } finally {
      setIsSaving(false);
    }
  };

  const openCreate = () => {
    const businessDate = todayISO();
    setNewBusinessDate(businessDate);
    setNewCountType("Closing Count");
    setNewSessionName(`${dateLabel(businessDate)} Closing FG Count`);
    setNewCounterName(user?.name || user?.email || "");
    setNewNotes("");
    setDuplicateSessionId(null);
    setCreateOpen(true);
  };

  const createSession = async (createAdditional = false) => {
    if (!newBusinessDate || !newSessionName.trim()) {
      setMessage("Business date and session name are required.");
      return;
    }
    setIsSaving(true);
    setDuplicateSessionId(null);
    try {
      const result = await createEnterpriseFgCountSession({
        locationId: newLocationId,
        businessDate: newBusinessDate,
        sessionName: newSessionName.trim(),
        countType: newCountType,
        notes: newNotes.trim() || null,
        counterName: newCounterName.trim() || null,
        createAdditional,
      });
      if (result.duplicate) {
        setDuplicateSessionId(result.existingSessionId ?? null);
        setMessage(result.message ?? "A count already exists for this business date.");
        return;
      }
      if (!result.success || !result.sessionId) {
        setMessage(result.message ?? "Unable to create FG count session.");
        return;
      }
      setCreateOpen(false);
      await loadDashboard();
      await openSession(result.sessionId);
    } finally {
      setIsSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!activeDetail) return;
    setIsSaving(true);
    try {
      const result = await saveEnterpriseFgCountDraft({
        sessionId: activeDetail.session.id,
        notes: activeDetail.session.notes,
        lines: activeDetail.lines.map(line => ({
          itemId: line.itemId,
          physicalQty: lineDraft[line.itemId]?.physicalQty === ""
            ? null
            : Number(lineDraft[line.itemId]?.physicalQty ?? 0),
          notes: lineDraft[line.itemId]?.notes ?? null,
        })),
      });
      if (!result.success) {
        setMessage(result.message ?? "Save draft failed.");
        return;
      }
      await loadDashboard();
      await openSession(activeDetail.session.id);
      setMessage("Draft saved.");
    } finally {
      setIsSaving(false);
    }
  };

  const submitSession = async () => {
    if (!activeDetail) return;
    await saveDraft();
    setIsSaving(true);
    try {
      const result = await submitEnterpriseFgCountSession(activeDetail.session.id);
      if (!result.success) {
        setMessage(result.message ?? "Submit failed.");
        return;
      }
      await loadDashboard();
      await openSession(activeDetail.session.id);
      setMessage("FG count submitted for review.");
    } finally {
      setIsSaving(false);
    }
  };

  const approveSession = async () => {
    if (!activeDetail) return;
    if (!approvalReason.trim()) {
      setMessage("Approval reason is required before posting adjustments.");
      return;
    }
    setIsSaving(true);
    try {
      const result = await approveAndPostEnterpriseFgCountSession(activeDetail.session.id, approvalReason.trim());
      if (!result.success) {
        setMessage(result.message ?? "Approve and post failed.");
        return;
      }
      await loadDashboard();
      await openSession(activeDetail.session.id);
      setMessage(`FG count approved and posted. ${result.movementCount ?? 0} adjustment movements created.`);
    } finally {
      setIsSaving(false);
    }
  };

  const updateLine = (itemId: string, patch: Partial<{ physicalQty: string; notes: string }>) => {
    setLineDraft(prev => ({
      ...prev,
      [itemId]: { physicalQty: prev[itemId]?.physicalQty ?? "", notes: prev[itemId]?.notes ?? "", ...patch },
    }));
  };

  const visibleLines = useMemo(() => {
    const lines = activeDetail?.lines ?? [];
    const q = lineSearch.trim().toLowerCase();
    return lines.filter(line => {
      if (q && !`${line.itemName} ${line.sku ?? ""}`.toLowerCase().includes(q)) return false;
      if (categoryFilter !== "All" && (line.category || "Uncategorized") !== categoryFilter) return false;
      const draft = lineDraft[line.itemId]?.physicalQty;
      const physicalEntered = draft !== undefined && draft !== "";
      const physical = physicalEntered ? Number(draft) : line.physicalQty;
      const variance = physicalEntered ? physical - line.expectedQty : line.varianceQty;
      if (varianceFilter === "Gains" && variance <= 0) return false;
      if (varianceFilter === "Losses" && variance >= 0) return false;
      if (varianceFilter === "Zero Variance" && variance !== 0) return false;
      if (varianceFilter === "Uncounted" && physicalEntered) return false;
      return true;
    });
  }, [activeDetail, categoryFilter, lineDraft, lineSearch, varianceFilter]);

  const categories = useMemo(() => {
    const values = new Set((activeDetail?.lines ?? []).map(line => line.category || "Uncategorized"));
    return ["All", ...Array.from(values).sort((a, b) => a.localeCompare(b))];
  }, [activeDetail]);

  const liveSummary = useMemo(() => {
    const lines = activeDetail?.lines ?? [];
    return lines.reduce((acc, line) => {
      const draft = lineDraft[line.itemId]?.physicalQty;
      const entered = draft !== undefined && draft !== "";
      const physical = entered ? Number(draft) : line.physicalQty;
      const variance = entered ? physical - line.expectedQty : line.varianceQty;
      const varianceValue = variance * line.makingCost;
      acc.counted += entered || line.physicalQtyEntered ? 1 : 0;
      acc.varianceItems += variance !== 0 && (entered || line.physicalQtyEntered) ? 1 : 0;
      acc.expectedValue += line.expectedValue;
      acc.physicalValue += entered || line.physicalQtyEntered ? physical * line.makingCost : 0;
      acc.varianceValue += entered || line.physicalQtyEntered ? varianceValue : 0;
      acc.gains += varianceValue > 0 ? varianceValue : 0;
      acc.losses += varianceValue < 0 ? Math.abs(varianceValue) : 0;
      return acc;
    }, { counted: 0, varianceItems: 0, expectedValue: 0, physicalValue: 0, varianceValue: 0, gains: 0, losses: 0 });
  }, [activeDetail, lineDraft]);

  const detailReadOnly = !activeDetail || activeDetail.session.status !== "draft" || isReadOnly;

  if (isLoading) {
    return (
      <div className="-m-6 flex min-h-[calc(100vh-4rem)] items-center justify-center gap-2 bg-slate-50 p-12 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading Finished Goods Count…
      </div>
    );
  }

  return (
    <div className="-m-6 min-h-[calc(100vh-4rem)] bg-slate-50 p-4 text-slate-900 sm:p-6">
      <div className="mx-auto w-full max-w-screen-2xl space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-700">Finished Goods Control</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Finished Goods Count Dashboard</h1>
            <p className="mt-1 text-sm text-slate-500">
              Session-based finished goods counts with immutable snapshots, review, approval, and posting control.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void loadDashboard()}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <Filter className="h-4 w-4" /> Refresh
            </button>
            {canCreate && (
              <button
                onClick={openCreate}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
              >
                <Play className="h-4 w-4" /> Start New Count
              </button>
            )}
          </div>
        </div>

        {message && (
          <div className="flex items-start justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            <span>{message}</span>
            <button onClick={() => setMessage(null)} className="font-bold">Dismiss</button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <MetricCard title="Start New Count" value={canCreate ? "Ready" : "Read Only"} helper="Create a snapshot session" />
          <MetricCard title="Pending Review" value={dashboard.pendingReview} helper="Submitted sessions" />
          <MetricCard title="Draft Sessions" value={dashboard.drafts} helper="In progress" />
          <MetricCard title="Approved Variance (MTD)" value={money(dashboard.approvedMtd)} helper="Posted this month" />
          <MetricCard title="Sessions This Month" value={dashboard.sessionsThisMonth} helper="All statuses" />
          <MetricCard title="Total Variance Value" value={money(dashboard.totalVariance)} helper="Approved sessions" />
        </div>

        <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
          <CardHeader className="border-b border-slate-100">
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardCheck className="h-4 w-4 text-emerald-700" /> Recent Finished Goods Count Sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
              <div className="relative md:col-span-2">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search sessions..." className="w-full rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm" />
              </div>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">
                {STATUSES.map(s => <option key={s} value={s}>{s === "All" ? "All Statuses" : s}</option>)}
              </select>
              <input type="date" value={businessDateFilter} onChange={e => setBusinessDateFilter(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm" />
              <select value={countTypeFilter} onChange={e => setCountTypeFilter(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">
                <option value="All">All Count Types</option>
                {COUNT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
              </select>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Session Name</th>
                    <th className="px-3 py-2">Location</th>
                    <th className="px-3 py-2">Business Date</th>
                    <th className="px-3 py-2">Count Type</th>
                    <th className="px-3 py-2">Created By</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Variance Value</th>
                    <th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2">Submitted</th>
                    <th className="px-3 py-2">Approved</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSessions.map(session => (
                    <tr key={session.id} onClick={() => void openSession(session.id)} className="cursor-pointer border-t border-slate-100 hover:bg-emerald-50/40">
                      <td className="px-3 py-3 font-semibold text-slate-900">{session.sessionName || "Unnamed Session"}</td>
                      <td className="px-3 py-3">{session.locationName || session.locationId}</td>
                      <td className="px-3 py-3">{dateLabel(session.businessDate)}</td>
                      <td className="px-3 py-3">{session.countType}</td>
                      <td className="px-3 py-3">{session.countedByName || "Unknown"}</td>
                      <td className="px-3 py-3"><Badge variant={statusTone(session.status) as any}>{session.status}</Badge></td>
                      <td className={`px-3 py-3 text-right font-semibold ${session.varianceValue < 0 ? "text-red-600" : session.varianceValue > 0 ? "text-emerald-700" : "text-slate-500"}`}>{money(session.varianceValue)}</td>
                      <td className="px-3 py-3">{dateTimeLabel(session.createdAt)}</td>
                      <td className="px-3 py-3">{dateTimeLabel(session.submittedAt)}</td>
                      <td className="px-3 py-3">{dateTimeLabel(session.approvedAt)}</td>
                    </tr>
                  ))}
                  {filteredSessions.length === 0 && (
                    <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-500">No FG count sessions match the selected filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Drawer
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Start New FG Count"
        description="Create a permanent snapshot before counting starts."
        variant="dialog"
        footer={
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
            <button onClick={() => setCreateOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold">Cancel</button>
            {duplicateSessionId && (
              <button onClick={() => void openSession(duplicateSessionId)} className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700">Open Existing</button>
            )}
            {duplicateSessionId && canApprove && (
              <button onClick={() => void createSession(true)} className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800">Create Additional Count</button>
            )}
            <button onClick={() => void createSession(false)} disabled={isSaving} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {isSaving ? "Creating..." : "Create Snapshot"}
            </button>
          </div>
        }
      >
        <div className="space-y-4 rounded-2xl bg-white p-4">
          <Field label="Location">
            <select value={newLocationId} onChange={e => setNewLocationId(e.target.value)} disabled={isLocationManager(user)} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm">
              <option value="LOC-HQ">Head Office</option>
              {locations.map(loc => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
            </select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business Date">
              <input type="date" value={newBusinessDate} onChange={e => {
                setNewBusinessDate(e.target.value);
                setNewSessionName(`${dateLabel(e.target.value)} ${newCountType}`);
              }} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            </Field>
            <Field label="Count Type">
              <select value={newCountType} onChange={e => {
                setNewCountType(e.target.value);
                setNewSessionName(`${dateLabel(newBusinessDate)} ${e.target.value}`);
              }} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm">
                {COUNT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Session Name">
            <input value={newSessionName} onChange={e => setNewSessionName(e.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          </Field>
          <Field label="Counter Name">
            <input value={newCounterName} onChange={e => setNewCounterName(e.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          </Field>
          <Field label="Notes">
            <textarea value={newNotes} onChange={e => setNewNotes(e.target.value)} className="min-h-24 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          </Field>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            Creating the session snapshots every active finished good, including expected quantity, making cost, pack size, category, and last count date.
          </div>
        </div>
      </Drawer>

      <Drawer
        isOpen={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={activeDetail?.session.sessionName || "FG Count Session"}
        description={activeDetail ? `${activeDetail.session.countType} · ${dateLabel(activeDetail.session.businessDate)} · ${activeDetail.session.status}` : undefined}
        variant="dialog"
        dialogClassName="md:max-w-[1500px] 2xl:max-w-[1600px]"
        footer={activeDetail && (
          <div className="flex w-full flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="text-sm font-semibold text-slate-700">Variance: <span className={liveSummary.varianceValue < 0 ? "text-red-600" : "text-emerald-700"}>{money(liveSummary.varianceValue)}</span></div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button onClick={() => setDetailOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold">Close</button>
              {!detailReadOnly && (
                <>
                  <button onClick={() => void saveDraft()} disabled={isSaving} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold">
                    <Save className="h-4 w-4" /> Save Draft
                  </button>
                  <button onClick={() => void submitSession()} disabled={isSaving} className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
                    <Send className="h-4 w-4" /> Submit
                  </button>
                </>
              )}
              {activeDetail.session.status === "submitted" && canApprove && (
                <button onClick={() => void approveSession()} disabled={isSaving} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white">
                  <ShieldCheck className="h-4 w-4" /> Approve & Post Adjustment
                </button>
              )}
            </div>
          </div>
        )}
      >
        {activeDetail && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <MetricCard title="Items Counted" value={`${liveSummary.counted} / ${activeDetail.lines.length}`} helper="Physical counts entered" />
              <MetricCard title="Items With Variance" value={liveSummary.varianceItems} helper="Gain or loss" />
              <MetricCard title="Expected FG Value" value={money(liveSummary.expectedValue)} helper="Snapshot value" />
              <MetricCard title="Variance Value" value={money(liveSummary.varianceValue)} helper={`${money(liveSummary.gains)} gains · ${money(liveSummary.losses)} losses`} />
            </div>

            <Card className="rounded-2xl border-slate-200 bg-white">
              <CardContent className="grid grid-cols-1 gap-3 p-4 md:grid-cols-4">
                <Info label="Location" value={activeDetail.session.locationName || activeDetail.session.locationId} />
                <Info label="Business Date" value={dateLabel(activeDetail.session.businessDate)} />
                <Info label="Created By" value={activeDetail.session.countedByName || "Unknown"} />
                <Info label="Created Date" value={dateTimeLabel(activeDetail.session.createdAt)} />
                <Info label="Submitted By" value={activeDetail.session.submittedByName || "Not submitted"} />
                <Info label="Submitted Date" value={dateTimeLabel(activeDetail.session.submittedAt)} />
                <Info label="Approved By" value={activeDetail.session.approvedByName || "Not approved"} />
                <Info label="Posted Date" value={dateTimeLabel(activeDetail.session.postedAt)} />
              </CardContent>
            </Card>

            {activeDetail.session.status === "submitted" && canApprove && (
              <Card className="rounded-2xl border-amber-200 bg-amber-50">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-center gap-2 font-semibold text-amber-900"><AlertTriangle className="h-4 w-4" /> Manager Review</div>
                  <p className="text-sm text-amber-800">Approval posts count variance to inventory movements and updates finished goods stock. This cannot be posted twice.</p>
                  <textarea value={approvalReason} onChange={e => setApprovalReason(e.target.value)} placeholder="Reason / approval note required" className="min-h-20 w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm" />
                </CardContent>
              </Card>
            )}

            <Card className="rounded-2xl border-slate-200 bg-white">
              <CardContent className="space-y-3 p-4">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                  <div className="relative md:col-span-2">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input value={lineSearch} onChange={e => setLineSearch(e.target.value)} placeholder="Search finished goods..." className="w-full rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm" />
                  </div>
                  <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">
                    {categories.map(category => <option key={category} value={category}>{category === "All" ? "All Categories" : category}</option>)}
                  </select>
                  <select value={varianceFilter} onChange={e => setVarianceFilter(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm">
                    {["All", "Gains", "Losses", "Zero Variance", "Uncounted"].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1280px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Finished Good</th>
                        <th className="px-3 py-2">SKU</th>
                        <th className="px-3 py-2">Category</th>
                        <th className="px-3 py-2">Pack Size</th>
                        <th className="px-3 py-2 text-right">Expected Qty</th>
                        <th className="px-3 py-2">Physical Qty</th>
                        <th className="px-3 py-2 text-right">Variance Qty</th>
                        <th className="px-3 py-2 text-right">Variance %</th>
                        <th className="px-3 py-2 text-right">Making Cost</th>
                        <th className="px-3 py-2 text-right">Variance Value</th>
                        <th className="px-3 py-2">Last Count</th>
                        <th className="px-3 py-2">Notes</th>
                        <th className="px-3 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleLines.map(line => {
                        const draftValue = lineDraft[line.itemId]?.physicalQty ?? "";
                        const entered = draftValue !== "";
                        const physical = entered ? Number(draftValue) : line.physicalQty;
                        const variance = entered ? physical - line.expectedQty : line.varianceQty;
                        const varianceValue = variance * line.makingCost;
                        const variancePct = line.expectedQty !== 0 ? (variance / line.expectedQty) * 100 : null;
                        return (
                          <tr key={line.id} className="border-t border-slate-100">
                            <td className="px-3 py-2 font-semibold text-slate-900">{line.itemName}</td>
                            <td className="px-3 py-2 text-slate-500">{line.sku || line.itemId}</td>
                            <td className="px-3 py-2">{line.category || "Uncategorized"}</td>
                            <td className="px-3 py-2">{line.packSize || `${line.packQty} ${line.unit || "ea"}`}</td>
                            <td className="px-3 py-2 text-right">{qty(line.expectedQty)}</td>
                            <td className="px-3 py-2">
                              {detailReadOnly ? (
                                <span>{line.physicalQtyEntered ? qty(line.physicalQty) : "Not counted"}</span>
                              ) : (
                                <input type="number" min="0" value={draftValue} onChange={e => updateLine(line.itemId, { physicalQty: e.target.value })} className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-right" />
                              )}
                            </td>
                            <td className={`px-3 py-2 text-right font-semibold ${variance < 0 ? "text-red-600" : variance > 0 ? "text-emerald-700" : "text-slate-500"}`}>{qty(variance)}</td>
                            <td className="px-3 py-2 text-right">{variancePct == null ? "—" : `${qty(variancePct)}%`}</td>
                            <td className="px-3 py-2 text-right">{money(line.makingCost)}</td>
                            <td className={`px-3 py-2 text-right font-semibold ${varianceValue < 0 ? "text-red-600" : varianceValue > 0 ? "text-emerald-700" : "text-slate-500"}`}>{money(varianceValue)}</td>
                            <td className="px-3 py-2">{dateLabel(line.lastCountDate)}</td>
                            <td className="px-3 py-2">
                              {detailReadOnly ? (
                                <span>{line.notes || "—"}</span>
                              ) : (
                                <input value={lineDraft[line.itemId]?.notes ?? ""} onChange={e => updateLine(line.itemId, { notes: e.target.value })} className="w-44 rounded-lg border border-slate-200 px-2 py-1" />
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {variance > 0 ? <Badge variant="success">Gain</Badge> : variance < 0 ? <Badge variant="danger">Loss</Badge> : entered || line.physicalQtyEntered ? <Badge variant="neutral">Counted</Badge> : <Badge variant="warning">Uncounted</Badge>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-2xl border-slate-200 bg-white">
              <CardHeader><CardTitle className="text-base">Audit Log</CardTitle></CardHeader>
              <CardContent className="space-y-2 p-4 pt-0">
                {activeDetail.audit.map(log => (
                  <div key={log.id} className="flex flex-col rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <div><span className="font-semibold capitalize">{log.action.replace(/_/g, " ")}</span> by {log.actorName || "Unknown"}</div>
                    <div className="text-slate-500">{dateTimeLabel(log.createdAt)}</div>
                  </div>
                ))}
                {activeDetail.audit.length === 0 && <div className="text-sm text-slate-500">No audit events recorded.</div>}
              </CardContent>
            </Card>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function MetricCard({ title, value, helper }: { title: string; value: string | number; helper: string }) {
  return (
    <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
      <CardContent className="p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
        <div className="mt-2 text-2xl font-bold text-slate-950">{value}</div>
        <div className="mt-1 text-xs text-slate-500">{helper}</div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  );
}
