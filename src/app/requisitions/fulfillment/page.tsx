"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/components/AuthProvider";
import { getFulfillmentSummary, getFulfilledRequisitions, saveFulfillmentAllocations, completeFulfillmentMovement, createDeliveryTicketFromRequisition, approveRequisition, rejectRequisition, getActiveDeliveryRuns, assignDeliveryTicketToRun, removeTicketFromDeliveryRun, getDeliveryTicketById } from "@/lib/storage";
import { isHqFulfillment, isHqMaster, isHqOps } from "@/lib/roles";
import { ChevronDown, ChevronRight, Search, Save, Check, RefreshCw, AlertTriangle, Play, Sparkles, Truck, PackageCheck, CheckCircle2, XSquare, Loader2, Printer, FileText, X, ExternalLink, List, AlignJustify, AlertOctagon, Calendar, CalendarRange, ChevronLeft, ChevronRight as ChevronRightIcon, Info, History, Clock } from "lucide-react";
import { DeliveryTicketDrawer } from "@/components/DeliveryTicketDrawer";

type PrintScope = "visible" | "locations" | "requisitions" | "items";
type FulfillmentTab = "summary" | "allocation" | "backorders" | "completed" | "print";
type DateFilterMode = "today" | "tomorrow" | "this_week" | "custom" | "range" | "all";
type CompletedDateMode = "today" | "yesterday" | "this_week" | "custom" | "range" | "all_time";

// ─── Date helpers ─────────────────────────────────────────────────────────────
// Requisitions store `hq_run_date` as the operational HQ run date.
// Legacy rows may only have `date` (submission date), so filtering falls back
// to date when hq_run_date is missing.
// We normalise to YYYY-MM-DD for comparison.

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return toIso(new Date());
}

function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toIso(d);
}

function weekEndIso(): string {
  const d = new Date();
  // end of this ISO week (Sunday)
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? 6 : 7 - day;
  d.setDate(d.getDate() + diff);
  return toIso(d);
}

/** Normalise any date string the DB might store to YYYY-MM-DD, or null. */
function normaliseReqDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  // Locale string e.g. "May 10, 2025" or "Jul 1, 2026"
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return null;
  return toIso(parsed);
}

function fmtDisplayDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function fulfillmentMethodLabel(value?: string | null): string {
  if (value === "hq_delivery") return "HQ Delivery";
  if (value === "store_pickup") return "Store Pickup";
  return "Not specified";
}

function fulfillmentWindowLabel(value?: string | null): string {
  const labels: Record<string, string> = {
    morning: "Morning",
    afternoon: "Afternoon",
    evening: "Evening",
    next_hq_run: "Next HQ Run",
    asap_pickup: "ASAP Pickup / Call HQ",
  };
  return value ? labels[value] ?? "Not specified" : "Not specified";
}

function modeLabel(mode: DateFilterMode, customDate: string, rangeFrom: string, rangeTo: string): string {
  switch (mode) {
    case "today":     return `Today — HQ run ${fmtDisplayDate(todayIso())}`;
    case "tomorrow":  return `Tomorrow — HQ run ${fmtDisplayDate(tomorrowIso())}`;
    case "this_week": return `This Week — HQ run this week`;
    case "custom":    return customDate ? `HQ run ${fmtDisplayDate(customDate)}` : "Custom Date";
    case "range":     return (rangeFrom && rangeTo) ? `HQ run ${fmtDisplayDate(rangeFrom)} – ${fmtDisplayDate(rangeTo)}` : "Date Range";
    case "all":       return "All Open Requisitions (any HQ run date)";
  }
}

function batchRef(mode: DateFilterMode, customDate: string, rangeFrom: string): string {
  const base = mode === "today" ? todayIso()
    : mode === "tomorrow" ? tomorrowIso()
    : mode === "custom" && customDate ? customDate
    : mode === "range" && rangeFrom ? rangeFrom
    : todayIso();
  return `REQ-BATCH-${base.replace(/-/g, "")}-001`;
}

// ─── Architecture note ────────────────────────────────────────────────────────
// Fulfillment batching is now based on requisitions.hq_run_date. Legacy rows
// that predate the field fall back to requisitions.date so they remain visible
// and fulfillable.

/** Tiny inline stat for the batch summary strip. */
function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className={`text-base font-black ${color ?? "text-neutral-900"}`}>{value}</span>
      <span className="text-xs text-neutral-500">{label}</span>
    </div>
  );
}

export default function FulfillmentPage() {
  const { user } = useAuth();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FulfillmentTab>("summary");

  // ── Date filter state ─────────────────────────────────────────────────────
  const [dateMode, setDateMode]         = useState<DateFilterMode>("today");
  const [customDate, setCustomDate]     = useState(todayIso());
  const [rangeFrom, setRangeFrom]       = useState(todayIso());
  const [rangeTo, setRangeTo]           = useState(todayIso());
  const [includeOverdue, setIncludeOverdue] = useState(false);

  /** Resolved [from, to] ISO strings for the active date mode. Null means no bound. */
  const activeDateRange = useMemo((): [string | null, string | null] => {
    const t = todayIso();
    switch (dateMode) {
      case "today":     return [t, t];
      case "tomorrow":  return [tomorrowIso(), tomorrowIso()];
      case "this_week": return [t, weekEndIso()];
      case "custom":    return customDate ? [customDate, customDate] : [t, t];
      case "range":     return [rangeFrom || t, rangeTo || t];
      case "all":       return [null, null];
    }
  }, [dateMode, customDate, rangeFrom, rangeTo]);

  /** Returns true if a requisition date (normalised) falls in the active batch. */
  const reqDateInBatch = useCallback((rawDate: string | null | undefined): boolean => {
    const [from, to] = activeDateRange;
    if (from === null && to === null) return true; // all mode
    const iso = normaliseReqDate(rawDate);
    if (!iso) return false;
    // Main window
    if (from && iso >= from && to && iso <= to) return true;
    // Overdue: date is before the batch start and requisition is still open
    if (includeOverdue && from && iso < from) return true;
    return false;
  }, [activeDateRange, includeOverdue]);

  // Expanded items state
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});

  // Filter States
  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [printScope, setPrintScope] = useState<PrintScope>("visible");
  const [printSelectedLocations, setPrintSelectedLocations] = useState<string[]>([]);
  const [printSelectedRequisitions, setPrintSelectedRequisitions] = useState<string[]>([]);
  const [printSelectedItems, setPrintSelectedItems] = useState<string[]>([]);
  const [printOptions, setPrintOptions] = useState({
    includeBreakdown: true,
    includeRequisitionNumber: true,
    includeBackorders: true,
    includeNotes: true,
    includePickedQty: true,
    includeCheckedBy: true,
    pageBreakPerLocation: false,
    onlyAllocated: false,
    includeRequested: true,
  });

  // Track modified rows locally
  // key: line_id, value: { allocatedQty: number, backorderQty: number, fulfillmentNote: string, dirty: boolean }
  const [drafts, setDrafts] = useState<Record<string, { allocatedQty: number; backorderQty: number; fulfillmentNote: string; dirty: boolean }>>({});

  // Active delivery runs for the run-assignment dropdown
  const [activeRuns, setActiveRuns] = useState<{ id: string; runNumber: string; label: string; status: string }[]>([]);
  const [runAssigning, setRunAssigning] = useState<string | null>(null); // ticketId being reassigned

  // ── Completed Fulfillment Report state ──────────────────────────────────────
  // Filtered by fulfilled_at (real completion timestamp), NOT by req.date.
  const [completedData, setCompletedData] = useState<any[]>([]);
  const [completedLoading, setCompletedLoading] = useState(false);
  const [completedDateMode, setCompletedDateMode] = useState<CompletedDateMode>("today");
  const [completedCustomDate, setCompletedCustomDate] = useState(todayIso());
  const [completedRangeFrom, setCompletedRangeFrom] = useState(todayIso());
  const [completedRangeTo, setCompletedRangeTo]   = useState(todayIso());
  const [expandedCompleted, setExpandedCompleted] = useState<Record<string, boolean>>({});

  /** Resolved [fromIso, toIso] for the Completed tab's date filter. */
  const completedDateRange = useMemo((): [string | null, string | null] => {
    const t   = todayIso();
    const yes = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return toIso(d); })();
    const mon = (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1)); return toIso(d); })();
    switch (completedDateMode) {
      case "today":     return [t, t];
      case "yesterday": return [yes, yes];
      case "this_week": return [mon, t];
      case "custom":    return completedCustomDate ? [completedCustomDate, completedCustomDate] : [t, t];
      case "range":     return [completedRangeFrom || t, completedRangeTo || t];
      case "all_time":  return [null, null];
    }
  }, [completedDateMode, completedCustomDate, completedRangeFrom, completedRangeTo]);

  const [rejectModalReqId, setRejectModalReqId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [rejectActionLoading, setRejectActionLoading] = useState(false);
  const [approveActionLoading, setApproveActionLoading] = useState<string | null>(null);

  // ── Delivery Ticket Drawer state ────────────────────────────────────────────
  const [dtDrawerTicket, setDtDrawerTicket] = useState<any | null>(null);
  const [dtLoading, setDtLoading] = useState<string | null>(null);

  // ── Role-aware permission helpers ───────────────────────────────────────────
  // These drive what the DeliveryTicketDrawer renders for hq_fulfillment vs.
  // hq_master vs. hq_ops when opened from this page.
  const isUserHqMaster = isHqMaster(user);   // hq_master / hq_admin
  const isUserHqOps    = isHqOps(user);       // hq_ops
  // canEditAdmin: only hq_master may edit address / status on a ticket
  const fulfillmentCanEditAdmin   = isUserHqMaster;
  // canActOnTicket: hq_master and hq_ops may perform operational actions
  const fulfillmentCanActOnTicket = isUserHqMaster || isUserHqOps;

  const loadData = async () => {
    setLoading(true);
    try {
      const [result, runs] = await Promise.all([
        getFulfillmentSummary(),
        getActiveDeliveryRuns(),
      ]);
      setData(result);
      setActiveRuns(runs);

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

  // ── Deep-link: open ticket drawer from URL ?ticketId=<uuid> ────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const ticketId = params.get("ticketId");
    if (!ticketId) return;
    // Load and open the drawer automatically
    (async () => {
      try {
        const res = await getDeliveryTicketById(ticketId);
        if (res.success && res.data) {
          setDtDrawerTicket(res.data);
        } else {
          setToast("Could not load delivery ticket from URL. Please try again.");
        }
      } catch {
        setToast("Could not load delivery ticket from URL.");
      }
    })();
  // Run once on mount only
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Handler: load full ticket and open drawer ───────────────────────────────
  const handleOpenDeliveryTicket = async (
    deliveryTicketId: string,
    deliveryTicketNumber?: string
  ) => {
    try {
      setDtLoading(deliveryTicketId);
      const res = await getDeliveryTicketById(deliveryTicketId);
      if (!res.success || !res.data) {
        throw new Error(res.error?.message ?? "Delivery ticket not found.");
      }
      setDtDrawerTicket(res.data);
      // Reflect in URL for deep-linking / back-button support
      const url = new URL(window.location.href);
      url.searchParams.set("ticketId", deliveryTicketId);
      window.history.pushState({}, "", url.toString());
    } catch (err: any) {
      console.error("[fulfillment-open-delivery-ticket]", err);
      setToast(
        `Unable to open ${deliveryTicketNumber || "delivery ticket"}. Please refresh and try again.`
      );
    } finally {
      setDtLoading(null);
    }
  };

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  // Load completed (fulfilled) requisitions whenever the completed date filter changes.
  // Uses fulfilled_at — NOT req.date — so fulfilled requisitions are always visible
  // regardless of when they were submitted.
  useEffect(() => {
    let cancelled = false;
    setCompletedLoading(true);
    const [from, to] = completedDateRange;
    getFulfilledRequisitions({ fromIso: from ?? undefined, toIso: to ?? undefined })
      .then(rows => { if (!cancelled) setCompletedData(rows); })
      .catch(() => { if (!cancelled) setCompletedData([]); })
      .finally(() => { if (!cancelled) setCompletedLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedDateRange]);

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

  const requisitionOptions = useMemo(() => {
    const map = new Map<string, { id: string; label: string; locationName: string }>();
    for (const group of data) {
      for (const item of group.items) {
        if (!item.requisitionId) continue;
        map.set(item.requisitionId, {
          id: item.requisitionId,
          label: item.requisitionNumber || item.requisitionId,
          locationName: item.locationName || "Unknown Location",
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);

  const itemOptions = useMemo(() => {
    return data.map(group => group.itemName).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [data]);

  // Filtered Grouped Items — applies date filter + existing filters
  const filteredData = useMemo(() => {
    return data.map(group => {
      const filteredItems = group.items.filter((item: any) => {
        const matchLocation = locationFilter === "all" || item.locationName === locationFilter;
        const matchStatus = statusFilter === "all" || item.requisitionStatus === statusFilter;
        // Date filter: match HQ run date first; legacy rows fall back to submission date.
        const matchDate = reqDateInBatch(item.hqRunDate ?? item.requisitionDate);
        return matchLocation && matchStatus && matchDate;
      });

      let totalReq = 0, totalAlloc = 0, totalBO = 0;
      for (const item of filteredItems) {
        const draft = drafts[item.id] || { allocatedQty: item.allocatedQty, backorderQty: item.backorderQty };
        totalReq  += item.quantityRequested;
        totalAlloc += draft.allocatedQty;
        totalBO   += draft.backorderQty;
      }

      return { ...group, items: filteredItems, totalRequested: totalReq, totalAllocated: totalAlloc, totalBackorder: totalBO };
    }).filter(group => {
      const matchSearch = group.itemName.toLowerCase().includes(search.toLowerCase());
      return matchSearch && group.items.length > 0;
    });
  }, [data, search, locationFilter, statusFilter, drafts, reqDateInBatch]);

  const toggleExpand = (itemName: string) => {
    setExpandedItems(prev => ({
      ...prev,
      [itemName]: !prev[itemName]
    }));
  };

  const togglePrintOption = (key: keyof typeof printOptions) => {
    setPrintOptions(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleListValue = (value: string, setter: (next: string[]) => void, current: string[]) => {
    setter(current.includes(value) ? current.filter(v => v !== value) : [...current, value]);
  };

  const buildPrintUrl = (mode: "view" | "print" = "view") => {
    const params = new URLSearchParams();
    params.set("scope", printScope);
    if (mode === "print") params.set("mode", "print");
    // ── Date filter params (always propagated so print uses same batch) ──
    params.set("dateMode", dateMode);
    if (dateMode === "custom" && customDate)    params.set("customDate", customDate);
    if (dateMode === "range") {
      if (rangeFrom) params.set("rangeFrom", rangeFrom);
      if (rangeTo)   params.set("rangeTo",   rangeTo);
    }
    if (includeOverdue) params.set("includeOverdue", "1");
    // ── Existing filters ──
    if (printScope === "visible") {
      if (search.trim()) params.set("search", search.trim());
      if (locationFilter !== "all") params.set("location", locationFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
    }
    if (printScope === "locations" && printSelectedLocations.length > 0) params.set("locations", printSelectedLocations.join(","));
    if (printScope === "requisitions" && printSelectedRequisitions.length > 0) params.set("requisitions", printSelectedRequisitions.join(","));
    if (printScope === "items" && printSelectedItems.length > 0) params.set("items", printSelectedItems.join(","));
    Object.entries(printOptions).forEach(([key, value]) => { params.set(key, value ? "1" : "0"); });
    return `/requisitions/fulfillment/print?${params.toString()}`;
  };

  const openPickListPrint = (mode: "view" | "print") => {
    if (printScope === "locations" && printSelectedLocations.length === 0) {
      setToast("Select at least one location for the pick list.");
      return;
    }
    if (printScope === "requisitions" && printSelectedRequisitions.length === 0) {
      setToast("Select at least one requisition for the pick list.");
      return;
    }
    if (printScope === "items" && printSelectedItems.length === 0) {
      setToast("Select at least one item for the pick list.");
      return;
    }
    const url = buildPrintUrl(mode);
    console.log("[Fulfillment Pick List Print]", { mode, printScope, url });
    const printWindow = window.open(url, "_blank", "noopener,noreferrer");
    if (!printWindow) setToast("Browser blocked the print window. Allow pop-ups and try again.");
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
    // Collect item IDs that belong to this specific requisition only.
    // This prevents saving dirty drafts from OTHER requisitions which could
    // have stale or missing IDs and trigger the NOT NULL violation.
    const reqItemIds = new Set<string>();
    for (const group of data) {
      for (const item of group.items) {
        if (item.requisitionId === requisitionId) {
          reqItemIds.add(item.id);
        }
      }
    }

    const modifiedList = Object.entries(drafts)
      .filter(([id, d]) => d.dirty && reqItemIds.has(id))
      .map(([id, d]) => ({
        id,
        allocatedQty: Number(d.allocatedQty),
        backorderQty: Number(d.backorderQty),
        fulfillmentNote: d.fulfillmentNote,
        userId: user?.id || ""
      }));

    // Pre-flight: every entry must have a valid id before we touch the DB.
    const missingIds = modifiedList.filter(a => !a.id || !a.id.trim());
    if (missingIds.length > 0) {
      alert(`Cannot complete fulfillment: ${missingIds.length} allocation row(s) are missing their requisition_item ID. Please refresh and try again.`);
      return;
    }

    setCompletingId(requisitionId);
    try {
      if (modifiedList.length > 0) {
        const saveRes = await saveFulfillmentAllocations(modifiedList);
        if (!saveRes.success) {
          // Do NOT proceed to stock movement if allocation save failed.
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
    <>
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Requisition Fulfillment</h2>
          <p className="text-neutral-500">Grouped operational view to allocate items to location requisitions.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
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

      {/* ── REQUISITION DATE BATCH FILTER (sticky while scrolling) ── */}
      <div className="sticky top-0 z-30 bg-white border border-neutral-200 rounded-xl shadow-sm px-4 py-3">
        {/* Quick filter buttons */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="text-xs font-bold text-neutral-500 uppercase tracking-wider mr-1">Requisition Date Batch:</span>
          {(["today", "tomorrow", "this_week", "custom", "range", "all"] as DateFilterMode[]).map(m => (
            <button
              key={m}
              onClick={() => setDateMode(m)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors border ${
                dateMode === m
                  ? m === "all"
                    ? "bg-amber-500 border-amber-500 text-white"
                    : "bg-brand-600 border-brand-600 text-white"
                  : "bg-white border-neutral-200 text-neutral-600 hover:border-brand-400 hover:text-brand-700"
              }`}
            >
              {m === "today" ? "Today" : m === "tomorrow" ? "Tomorrow" : m === "this_week" ? "This Week" : m === "custom" ? "Custom Date" : m === "range" ? "Date Range" : "All Open"}
            </button>
          ))}
        </div>

        {/* Custom date / range inputs */}
        {dateMode === "custom" && (
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="h-4 w-4 text-brand-600 shrink-0" />
            <label className="text-xs font-semibold text-neutral-600">Date:</label>
            <input
              type="date"
              value={customDate}
              onChange={e => setCustomDate(e.target.value)}
              className="border border-neutral-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        )}
        {dateMode === "range" && (
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <CalendarRange className="h-4 w-4 text-brand-600 shrink-0" />
            <label className="text-xs font-semibold text-neutral-600">From:</label>
            <input
              type="date"
              value={rangeFrom}
              onChange={e => setRangeFrom(e.target.value)}
              className="border border-neutral-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <label className="text-xs font-semibold text-neutral-600">To:</label>
            <input
              type="date"
              value={rangeTo}
              onChange={e => setRangeTo(e.target.value)}
              className="border border-neutral-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        )}

        {/* Active filter label + overdue checkbox */}
        <div className="flex flex-wrap items-center gap-4">
          <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold ${
            dateMode === "all"
              ? "bg-amber-50 border border-amber-200 text-amber-800"
              : "bg-brand-50 border border-brand-200 text-brand-800"
          }`}>
            <Calendar className="h-3.5 w-3.5" />
            {dateMode === "all"
              ? "Showing all open requisitions (any HQ run date)"
              : <>Showing requisitions for: <strong className="ml-1">{modeLabel(dateMode, customDate, rangeFrom, rangeTo)}</strong></>}
          </div>
          {dateMode !== "all" && (
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeOverdue}
                onChange={e => setIncludeOverdue(e.target.checked)}
                className="h-4 w-4 rounded border-neutral-300 accent-amber-500"
              />
              <span className="text-xs font-semibold text-neutral-700">Include overdue open requisitions</span>
            </label>
          )}
        </div>

        {/* All Open mode warning */}
        {dateMode === "all" && (
          <div className="mt-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-xs font-semibold text-amber-800">
              You are viewing <strong>all open requisitions regardless of HQ run date.</strong> Allocating or printing in this mode may mix operational batches. Select a specific HQ run date for operational safety.
            </p>
          </div>
        )}
      </div>

      {/* ── BATCH SUMMARY CARD ── */}
      {!loading && (() => {
        const allItems        = filteredData.flatMap((g: any) => g.items);
        const uniqLocations   = new Set(allItems.map((it: any) => it.locationName)).size;
        const uniqReqs        = new Set(allItems.map((it: any) => it.requisitionId)).size;
        const totalLines      = allItems.length;
        const fullyAllocLines = allItems.filter((it: any) => {
          const d = drafts[it.id] || it;
          return Number(d.allocatedQty ?? it.allocatedQty) >= Number(it.quantityRequested) && Number(d.backorderQty ?? it.backorderQty) === 0;
        }).length;
        const partialLines    = allItems.filter((it: any) => {
          const d = drafts[it.id] || it;
          const alloc = Number(d.allocatedQty ?? it.allocatedQty);
          return alloc > 0 && alloc < Number(it.quantityRequested);
        }).length;
        const boLines         = allItems.filter((it: any) => Number((drafts[it.id] || it).backorderQty ?? it.backorderQty) > 0).length;
        const overdueLines    = includeOverdue
          ? allItems.filter((it: any) => {
              const iso = normaliseReqDate(it.requisitionDate);
              const [from] = activeDateRange;
              return iso && from && iso < from;
            }).length
          : 0;
        const ref = dateMode !== "all" ? batchRef(dateMode, customDate, rangeFrom) : null;

        if (filteredData.length === 0) return null;
        return (
          <Card className="border-brand-100 bg-gradient-to-r from-brand-50/30 to-white shadow-sm">
            <CardContent className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                {ref && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-neutral-400 uppercase tracking-wider">Req Batch:</span>
                    <span className="font-mono text-xs font-bold text-brand-700 bg-brand-100 px-2 py-0.5 rounded">{ref}</span>
                  </div>
                )}
                <div className="h-4 w-px bg-neutral-200 hidden sm:block" />
                <Stat label="Locations" value={uniqLocations} />
                <Stat label="Requisitions" value={uniqReqs} />
                <Stat label="Items" value={filteredData.length} />
                <div className="h-4 w-px bg-neutral-200 hidden sm:block" />
                <Stat label="Fully Allocated" value={fullyAllocLines} color="text-emerald-600" />
                <Stat label="Partial" value={partialLines} color="text-amber-600" />
                <Stat label="Backorder Lines" value={boLines} color={boLines > 0 ? "text-red-600" : "text-neutral-400"} />
                {overdueLines > 0 && <Stat label="Overdue Included" value={overdueLines} color="text-amber-700" />}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* ── Tab strip ── */}
      {(() => {
        const backorderCount = filteredData.reduce((s: number, g: any) => s + g.items.filter((it: any) => Number(it.backorderQty ?? 0) > 0).length, 0);
        const tabs: { id: FulfillmentTab; label: string; icon: React.ReactNode; badge?: number; badgeColor?: string }[] = [
          { id: "summary",    label: "Open Queue",          icon: <List className="h-3.5 w-3.5" /> },
          { id: "allocation", label: "Allocation Details",  icon: <AlignJustify className="h-3.5 w-3.5" /> },
          { id: "backorders", label: "Backorders",          icon: <AlertOctagon className="h-3.5 w-3.5" />, badge: backorderCount },
          { id: "completed",  label: "Completed",           icon: <History className="h-3.5 w-3.5" />, badge: completedData.length > 0 ? completedData.length : undefined, badgeColor: "bg-emerald-100 text-emerald-700" },
          { id: "print",      label: "Print Pick List",     icon: <Printer className="h-3.5 w-3.5" /> },
        ];
        return (
          <div className="flex items-center gap-1 border-b border-neutral-200 overflow-x-auto">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => {
                  if (tab.id === "print") { setPrintModalOpen(true); return; }
                  setActiveTab(tab.id);
                }}
                className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold whitespace-nowrap border-b-2 transition-colors ${
                  activeTab === tab.id && tab.id !== "print"
                    ? "border-brand-600 text-brand-700 bg-brand-50/50"
                    : "border-transparent text-neutral-500 hover:text-neutral-800 hover:border-neutral-300"
                }`}
              >
                {tab.icon}
                {tab.label}
                {tab.badge != null && tab.badge > 0 && (
                  <span className={`ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${tab.badgeColor ?? "bg-amber-100 text-amber-700"}`}>
                    {tab.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        );
      })()}

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

      {/* Main content — rendered based on active tab */}
      {loading ? (
        <div className="text-center py-12 text-neutral-400">Loading fulfillment data...</div>
      ) : filteredData.length === 0 ? (
        <Card className="p-8 text-center border-dashed border-neutral-300">
          <Calendar className="h-8 w-8 text-neutral-400 mx-auto mb-2" />
          <p className="text-sm font-semibold text-neutral-900">
            {dateMode === "all"
              ? "No Requisitions Awaiting Fulfillment"
              : "No eligible requisitions for this fulfillment date."}
          </p>
          <p className="text-xs text-neutral-500 mt-1">
            {dateMode === "all"
              ? "There are no approved or submitted requisitions matching the filters."
              : "Try a different date, or check \"Include overdue\" to include past open requisitions."}
          </p>
          {dateMode !== "all" && (
            <button
              onClick={() => setDateMode("all")}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-brand-600 hover:underline"
            >
              View All Open Requisitions
            </button>
          )}
        </Card>
      ) : activeTab === "backorders" ? (
        /* ── BACKORDERS TAB ── */
        /* Safeguard 8: Item, Location, Requisition, Backordered Qty, Note, Follow-up */
        /* Safeguard 8: do not show empty backorder section when no backorders exist */
        <div className="space-y-2">
          {(() => {
            const boRows = filteredData.flatMap(g =>
              g.items
                .filter((it: any) => Number(it.backorderQty ?? 0) > 0)
                .map((it: any) => ({
                  ...it,
                  itemName: g.itemName,
                  isFGMode: it.isFGMode ?? g.isFGMode,
                  packQty:  it.packQty  ?? g.packQty,
                  unit:     it.unit     ?? g.unit,
                }))
            );
            if (boRows.length === 0) return (
              <Card className="p-8 text-center border-dashed border-neutral-300">
                <Check className="h-8 w-8 text-emerald-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-neutral-900">No Backorders</p>
                <p className="text-xs text-neutral-500 mt-1">All allocated quantities are fully covered.</p>
              </Card>
            );
            return (
              <Card className="overflow-hidden border-amber-200 shadow-sm">
                <CardHeader className="bg-amber-50 py-3 px-5 border-b border-amber-100">
                  <CardTitle className="text-sm font-bold text-amber-900">
                    {boRows.length} backorder line{boRows.length !== 1 ? "s" : ""} requiring follow-up
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader className="bg-amber-50/30 text-xs text-amber-700 uppercase tracking-wider">
                      <TableRow>
                        <TableHead className="px-5 py-2.5">Item</TableHead>
                        <TableHead className="py-2.5">Location</TableHead>
                        <TableHead className="py-2.5">Requisition</TableHead>
                        <TableHead className="py-2.5 text-center">Backordered Qty</TableHead>
                        <TableHead className="py-2.5">Fulfillment Note</TableHead>
                        <TableHead className="py-2.5">Follow-up Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {boRows.map((row: any) => {
                        const pq = row.packQty != null && Number(row.packQty) > 0
                          ? Number(row.packQty) : null;
                        const boQtyLabel = row.isFGMode
                          ? (pq
                            ? `${row.backorderQty} pack${row.backorderQty !== 1 ? "s" : ""} (${row.backorderQty * pq} ${row.unit || "ea"})`
                            : `${row.backorderQty} packs`)
                          : `${row.backorderQty} ${row.unit || "ea"}`;
                        return (
                          <TableRow key={`bo-${row.id}`} className="bg-amber-50/20 hover:bg-amber-50">
                            <TableCell className="px-5 py-3 font-semibold text-sm">{row.itemName}</TableCell>
                            <TableCell className="py-3 text-sm">{row.locationName}</TableCell>
                            <TableCell className="py-3 font-mono text-xs">{row.requisitionNumber || row.requisitionId}</TableCell>
                            <TableCell className="py-3 text-center text-sm font-bold text-amber-700">{boQtyLabel}</TableCell>
                            <TableCell className="py-3 text-xs text-neutral-500">{row.fulfillmentNote || <span className="text-neutral-300 italic">—</span>}</TableCell>
                            <TableCell className="py-3 text-xs">
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                                Pending
                              </span>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            );
          })()}
        </div>
      ) : activeTab === "completed" ? (
        /* ── COMPLETED FULFILLMENT REPORT ── */
        <div className="space-y-4">
          {/* Date filter bar */}
          <Card className="shadow-sm border-neutral-200">
            <CardContent className="flex flex-wrap items-center gap-2 px-4 py-3">
              <div className="flex items-center gap-1.5 mr-1">
                <Clock className="h-4 w-4 text-emerald-600" />
                <span className="text-xs font-bold text-neutral-600 uppercase tracking-wide">Fulfilled Date</span>
              </div>
              {(["today", "yesterday", "this_week", "custom", "range", "all_time"] as CompletedDateMode[]).map(m => {
                const labels: Record<CompletedDateMode, string> = {
                  today: "Today", yesterday: "Yesterday", this_week: "This Week",
                  custom: "Custom Date", range: "Date Range", all_time: "All Time",
                };
                return (
                  <button
                    key={m}
                    onClick={() => setCompletedDateMode(m)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      completedDateMode === m
                        ? "bg-emerald-600 text-white shadow-sm"
                        : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                    }`}
                  >
                    {labels[m]}
                  </button>
                );
              })}
              {completedDateMode === "custom" && (
                <input
                  type="date"
                  value={completedCustomDate}
                  onChange={e => setCompletedCustomDate(e.target.value)}
                  className="ml-1 px-2.5 py-1.5 text-xs border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              )}
              {completedDateMode === "range" && (
                <div className="flex items-center gap-1.5 ml-1">
                  <input type="date" value={completedRangeFrom} onChange={e => setCompletedRangeFrom(e.target.value)}
                    className="px-2.5 py-1.5 text-xs border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500" />
                  <span className="text-neutral-400 text-xs">–</span>
                  <input type="date" value={completedRangeTo} onChange={e => setCompletedRangeTo(e.target.value)}
                    className="px-2.5 py-1.5 text-xs border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500" />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Stats bar */}
          {!completedLoading && completedData.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-center">
                <div className="text-2xl font-black text-emerald-700">{completedData.length}</div>
                <div className="text-[10px] font-bold text-emerald-600 uppercase tracking-wide mt-0.5">Fulfilled</div>
              </div>
              <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-3 text-center">
                <div className="text-2xl font-black text-neutral-700">
                  {new Set(completedData.map(r => r.locationId ?? r.locationName)).size}
                </div>
                <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-wide mt-0.5">Locations</div>
              </div>
              <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-3 text-center">
                <div className="text-2xl font-black text-neutral-700">
                  {completedData.filter(r => r.deliveryTicketId).length}
                </div>
                <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-wide mt-0.5">With Tickets</div>
              </div>
              <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-3 text-center">
                <div className="text-2xl font-black text-neutral-700">
                  {completedData.filter(r => r.backorderQty > 0).length}
                </div>
                <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-wide mt-0.5">Had Backorders</div>
              </div>
            </div>
          )}

          {/* Completed list */}
          {completedLoading ? (
            <div className="flex items-center justify-center py-16 gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />
              <span className="text-sm font-semibold text-neutral-500">Loading completed requisitions…</span>
            </div>
          ) : completedData.length === 0 ? (
            <Card className="p-12 text-center border-dashed border-neutral-300">
              <History className="h-10 w-10 text-neutral-300 mx-auto mb-3" />
              <p className="text-sm font-bold text-neutral-700">No fulfilled requisitions</p>
              <p className="text-xs text-neutral-400 mt-1">
                {completedDateMode === "today"
                  ? "No requisitions were fulfilled today."
                  : completedDateMode === "yesterday"
                  ? "No requisitions were fulfilled yesterday."
                  : "No fulfilled requisitions in this date range."}
              </p>
              <p className="text-xs text-neutral-400 mt-2 italic">
                Note: filtering by fulfilled date, not submission date.
              </p>
            </Card>
          ) : (
            <Card className="overflow-hidden border-emerald-200 shadow-sm">
              <CardHeader className="bg-emerald-50 py-3 px-5 border-b border-emerald-100">
                <CardTitle className="text-sm font-bold text-emerald-900 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  {completedData.length} fulfilled requisition{completedData.length !== 1 ? "s" : ""}
                  <span className="text-xs font-normal text-emerald-600 ml-1">— sorted by fulfilled date, newest first</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader className="bg-emerald-50/40 text-xs text-neutral-500 uppercase tracking-wider">
                    <TableRow>
                      <TableHead className="px-5 py-2.5 w-[40px]"></TableHead>
                      <TableHead className="px-5 py-2.5">Requisition #</TableHead>
                      <TableHead className="py-2.5">Location</TableHead>
                      <TableHead className="py-2.5">Fulfilled At</TableHead>
                      <TableHead className="py-2.5 hidden sm:table-cell">Fulfilled By</TableHead>
                      <TableHead className="py-2.5 text-center hidden sm:table-cell">Items</TableHead>
                      <TableHead className="py-2.5 hidden md:table-cell">Delivery Ticket</TableHead>
                      <TableHead className="py-2.5 hidden md:table-cell">Run #</TableHead>
                      <TableHead className="py-2.5 text-center">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {completedData.map(req => {
                      const isExpanded = !!expandedCompleted[req.id];
                      const fulfilledDate = req.fulfilledAt
                        ? new Date(req.fulfilledAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
                        : "—";
                      const hasBackorder = req.backorderQty > 0;
                      return (
                        <>
                          <TableRow
                            key={req.id}
                            className="hover:bg-emerald-50/30 cursor-pointer"
                            onClick={() => setExpandedCompleted(prev => ({ ...prev, [req.id]: !prev[req.id] }))}
                          >
                            <TableCell className="px-5 py-3">
                              {isExpanded ? <ChevronDown className="h-4 w-4 text-emerald-600" /> : <ChevronRight className="h-4 w-4 text-neutral-400" />}
                            </TableCell>
                            <TableCell className="px-5 py-3 font-mono text-xs font-semibold text-neutral-700">
                              {req.requisitionNumber}
                            </TableCell>
                            <TableCell className="py-3 text-sm font-medium">{req.locationName}</TableCell>
                            <TableCell className="py-3 text-sm">
                              <div className="font-semibold text-emerald-700">{fulfilledDate}</div>
                              {req.submittedDate && (
                                <div className="text-[10px] text-neutral-400 mt-0.5">Submitted: {req.submittedDate}</div>
                              )}
                              <div className="text-[10px] text-brand-700 mt-0.5">
                                HQ Run: {req.hqRunDate ? fmtDisplayDate(String(req.hqRunDate).slice(0, 10)) : "Not specified"}
                              </div>
                              <div className="text-[10px] text-neutral-400 mt-0.5">
                                {fulfillmentMethodLabel(req.fulfillmentMethod)} · {fulfillmentWindowLabel(req.fulfillmentWindow)}
                              </div>
                            </TableCell>
                            <TableCell className="py-3 text-sm text-neutral-600 hidden sm:table-cell">
                              {req.fulfilledBy ?? <span className="text-neutral-300 italic text-xs">—</span>}
                            </TableCell>
                            <TableCell className="py-3 text-center hidden sm:table-cell">
                              <span className="text-sm font-semibold">{req.itemCount}</span>
                            </TableCell>
                            <TableCell className="py-3 hidden md:table-cell">
                              {req.deliveryTicketId ? (
                                <button
                                  className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-0.5 hover:bg-blue-100 transition-colors"
                                  onClick={e => { e.stopPropagation(); handleOpenDeliveryTicket(req.deliveryTicketId, req.deliveryTicketNumber); }}
                                >
                                  <FileText className="h-3 w-3" />
                                  {req.deliveryTicketNumber ?? req.deliveryTicketId.slice(0, 8)}
                                </button>
                              ) : <span className="text-neutral-300 text-xs italic">None</span>}
                            </TableCell>
                            <TableCell className="py-3 hidden md:table-cell">
                              {req.deliveryRunNumber
                                ? <span className="text-xs font-semibold text-neutral-700 bg-neutral-100 border border-neutral-200 rounded px-2 py-0.5">{req.deliveryRunNumber}</span>
                                : <span className="text-neutral-300 text-xs italic">—</span>}
                            </TableCell>
                            <TableCell className="py-3 text-center">
                              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                req.status === "fulfilled"
                                  ? "bg-emerald-100 text-emerald-700"
                                  : "bg-amber-100 text-amber-700"
                              }`}>
                                {req.status === "fulfilled" ? "Fulfilled" : "Partial"}
                                {hasBackorder && " + BO"}
                              </span>
                            </TableCell>
                          </TableRow>

                          {/* Expanded line items */}
                          {isExpanded && (
                            <TableRow key={`${req.id}-expanded`} className="bg-neutral-50/60">
                              <TableCell colSpan={9} className="px-10 py-3">
                                <div className="text-xs font-bold text-neutral-500 uppercase tracking-wide mb-2">Line Items</div>
                                <div className="space-y-1.5">
                                  {req.items.map((li: any, idx: number) => {
                                    const pq = li.packQty && li.packQty > 0 ? li.packQty : null;
                                    const reqLabel = li.isFGMode && pq
                                      ? `${li.quantityRequested} pack${li.quantityRequested !== 1 ? "s" : ""} (${li.quantityRequested * pq} ${li.unit || "ea"})`
                                      : `${li.quantityRequested} ${li.unit || "ea"}`;
                                    const allocLabel = li.isFGMode && pq
                                      ? `${li.allocatedQty} pack${li.allocatedQty !== 1 ? "s" : ""} (${li.allocatedQty * pq} ${li.unit || "ea"})`
                                      : `${li.allocatedQty} ${li.unit || "ea"}`;
                                    return (
                                      <div key={idx} className="flex items-center justify-between text-sm py-1 border-b border-neutral-200 border-dashed last:border-0">
                                        <span className="font-medium text-neutral-800 min-w-0 flex-1 truncate">{li.itemName}</span>
                                        <div className="flex items-center gap-4 ml-4 shrink-0">
                                          <div className="text-right">
                                            <div className="text-[10px] text-neutral-400">Requested</div>
                                            <div className="font-semibold text-neutral-700">{reqLabel}</div>
                                          </div>
                                          <div className="text-right">
                                            <div className="text-[10px] text-neutral-400">Allocated</div>
                                            <div className="font-semibold text-emerald-700">{allocLabel}</div>
                                          </div>
                                          {li.backorderQty > 0 && (
                                            <div className="text-right">
                                              <div className="text-[10px] text-neutral-400">Backorder</div>
                                              <div className="font-semibold text-amber-700">{li.backorderQty} {li.unit || "ea"}</div>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      ) : (
        /* ── PICK SUMMARY tab (default) + ALLOCATION DETAILS tab ── */
        /* When activeTab === "allocation" all items start expanded */
        <div className="space-y-4">
          {filteredData.map(group => {
            // On Allocation Details tab: all items expanded by default
            const isExpanded = activeTab === "allocation" ? true : (expandedItems[group.itemName] || false);
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
                            {group.packQty != null && Number(group.packQty) > 0
                              ? <>Pack Size: {group.packQty} {group.unit || "ea"} · Total Pull: <span className="font-bold text-neutral-900">{group.totalRequested} pack{group.totalRequested !== 1 ? 's' : ''}</span> = <span className="font-bold text-neutral-900">{group.totalRequested * Number(group.packQty)} {group.unit || "ea"}</span></>
                              : <span className="text-amber-700 font-semibold">Pack configuration missing — confirm before picking</span>
                            }
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
                                {/* Canonical HQ-line classifier — mirrors storage.ts isHqLine() */}
                                {(() => {
                                  const fg  = item.finishedGoodId ?? null;
                                  const st  = (item.sourceType ?? '').toLowerCase().trim();
                                  const cat = item.catalogItemId ?? null;
                                  const isHqItem = fg ? true : st === 'hq_supplied' ? true : st === 'local_vendor' ? false : !cat;

                                  if (!isHqItem) {
                                    return (
                                      <span className="text-xs text-amber-600 font-medium italic">
                                        Local vendor — fulfilled outside HQ
                                      </span>
                                    );
                                  }

                                  return (
                                    <>
                                      {/* Approve/Reject — shown only for submitted requisitions */}
                                      {item.requisitionStatus === 'submitted' && (
                                        <div className="flex items-center gap-1.5 mb-1">
                                          <button
                                            onClick={() => { setRejectModalReqId(item.requisitionId); setRejectionReason(''); }}
                                            disabled={rejectActionLoading || approveActionLoading === item.requisitionId}
                                            className="text-xs font-semibold text-danger-700 bg-danger-50 hover:bg-danger-100 px-2 py-1 rounded-lg border border-danger-200 transition-colors inline-flex items-center gap-1"
                                          >
                                            <XSquare className="h-3 w-3" /> Reject
                                          </button>
                                          <button
                                            onClick={async () => {
                                              setApproveActionLoading(item.requisitionId);
                                              try {
                                                const res = await approveRequisition(
                                                  item.requisitionId,
                                                  user?.id ?? '',
                                                  user?.role ?? null
                                                );
                                                if (res.success) {
                                                  setToast(`Requisition approved!`);
                                                  await loadData();
                                                } else {
                                                  alert(`Approval failed: ${res.error?.message ?? 'Unknown error'}`);
                                                }
                                              } finally {
                                                setApproveActionLoading(null);
                                              }
                                            }}
                                            disabled={approveActionLoading === item.requisitionId || rejectActionLoading}
                                            className="text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 px-2 py-1 rounded-lg border border-emerald-200 transition-colors inline-flex items-center gap-1"
                                          >
                                            {approveActionLoading === item.requisitionId
                                              ? <Loader2 className="h-3 w-3 animate-spin" />
                                              : <CheckCircle2 className="h-3 w-3" />
                                            }
                                            Approve
                                          </button>
                                        </div>
                                      )}
                                      {item.requisitionStatus !== "fulfilled" ? (
                                          <>
                                            <button
                                              onClick={() => handleMarkShortRow(item.id, item.quantityRequested)}
                                              className="text-xs font-semibold text-danger-700 bg-danger-50 hover:bg-danger-100 px-2.5 py-1.5 rounded-lg border border-danger-200 transition-colors"
                                              title="Mark item as short (sets allocation to 0 and backorders the entire quantity)"
                                            >
                                              Mark Short
                                            </button>
                                            {/* Safeguard: never show Complete Fulfillment for rejected reqs */}
                                            {item.requisitionStatus !== 'rejected' && (() => {
                                              // Complete Fulfillment requires the requisition to be APPROVED.
                                              // Submitted reqs must be approved first.
                                              const isApproved = item.requisitionStatus === 'approved';
                                              return (
                                                <button
                                                  onClick={() => handleCompleteFulfillment(item.requisitionId)}
                                                  disabled={completingId !== null || !isApproved}
                                                  className={`text-xs font-bold px-2.5 py-1.5 rounded-lg border transition-colors inline-flex items-center gap-1 ${
                                                    isApproved
                                                      ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-200'
                                                      : 'text-neutral-400 bg-neutral-50 border-neutral-200 cursor-not-allowed opacity-60'
                                                  }`}
                                                  title={isApproved ? 'Complete stock movement for this requisition' : 'Requisition must be approved before completing fulfillment'}
                                                >
                                                  <PackageCheck className="h-3.5 w-3.5" />
                                                  {completingId === item.requisitionId ? 'Processing...' : 'Complete Fulfillment'}
                                                </button>
                                              );
                                            })()}
                                          </>
                                        ) : (
                                          <>
                                            {item.deliveryTicketId ? (
                                          <div className="flex flex-col items-end gap-1.5">
                                                {/* Ticket number badge — clickable */}
                                                <button
                                                  onClick={() => handleOpenDeliveryTicket(item.deliveryTicketId, item.deliveryTicketNumber)}
                                                  disabled={dtLoading === item.deliveryTicketId}
                                                  className="inline-flex items-center gap-1 font-mono text-xs font-bold text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1 hover:bg-blue-100 transition-colors"
                                                  title="Click to open full delivery ticket"
                                                >
                                                  {dtLoading === item.deliveryTicketId ? (
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                  ) : (
                                                    <FileText className="h-3 w-3" />
                                                  )}
                                                  {item.deliveryTicketNumber}
                                                </button>

                                                {/* Open Delivery Ticket button */}
                                                <button
                                                  onClick={() => handleOpenDeliveryTicket(item.deliveryTicketId, item.deliveryTicketNumber)}
                                                  disabled={dtLoading === item.deliveryTicketId}
                                                  className="inline-flex items-center gap-1.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 px-2.5 py-1.5 rounded-lg transition-colors shadow-sm"
                                                  title="Open the full delivery ticket"
                                                >
                                                  <ExternalLink className="h-3.5 w-3.5" />
                                                  Open Delivery Ticket
                                                </button>

                                                {/* Quick print — opens print URL directly */}
                                                <button
                                                  onClick={() => {
                                                    const url = `/deliveries/tickets/${item.deliveryTicketId}/print?mode=print`;
                                                    const win = window.open(url, "_blank", "noopener,noreferrer");
                                                    if (!win) setToast("Browser blocked the print window. Allow pop-ups and try again.");
                                                  }}
                                                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-700 bg-white hover:bg-neutral-50 border border-neutral-200 px-2.5 py-1.5 rounded-lg transition-colors shadow-sm"
                                                  title="Print delivery ticket"
                                                >
                                                  <Printer className="h-3.5 w-3.5" />
                                                  Print Ticket
                                                </button>

                                                {/* Run assignment dropdown */}
                                                {!isHqFulfillment(user) && activeRuns.length > 0 ? (
                                                  <div className="flex items-center gap-1.5">
                                                    <select
                                                      defaultValue={item.deliveryRunId ?? ""}
                                                      disabled={runAssigning === item.deliveryTicketId}
                                                      onChange={async (e) => {
                                                        const newRunId = e.target.value;
                                                        if (!newRunId) return;
                                                        setRunAssigning(item.deliveryTicketId);
                                                        try {
                                                          if (item.deliveryRunId && item.deliveryRunId !== newRunId) {
                                                            const unRes = await removeTicketFromDeliveryRun(item.deliveryTicketId);
                                                            if (!unRes.success) {
                                                              alert(`Unassign failed: ${unRes.error?.message}`);
                                                              return;
                                                            }
                                                          }
                                                          const res = await assignDeliveryTicketToRun(item.deliveryTicketId, newRunId);
                                                          if (res.success) {
                                                            setToast(`Ticket assigned to run successfully!`);
                                                            await loadData();
                                                          } else {
                                                            alert(`Assignment failed: ${res.error?.message ?? 'Unknown error'}`);
                                                          }
                                                        } finally {
                                                          setRunAssigning(null);
                                                        }
                                                      }}
                                                      className="text-xs border border-neutral-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 text-neutral-700"
                                                    >
                                                      <option value="">{item.deliveryRunId ? 'Change Run' : 'Assign to Run'}</option>
                                                      {activeRuns.map(run => (
                                                        <option key={run.id} value={run.id}>{run.label}</option>
                                                      ))}
                                                    </select>
                                                    {runAssigning === item.deliveryTicketId && (
                                                      <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />
                                                    )}
                                                  </div>
                                                ) : (
                                                  !isHqFulfillment(user) && <span className="text-[10px] text-neutral-400 italic">No active runs</span>
                                                )}
                                              </div>
                                            ) : (
                                              /* Safeguard: no ticket button for rejected reqs */
                                              item.requisitionStatus !== 'rejected' && item.fulfillmentMethod !== 'store_pickup' ? (
                                                /* Only hq_master / hq_ops can create tickets; hq_fulfillment cannot */
                                                !isHqFulfillment(user) ? (
                                                  <>
                                                    <span className="text-xs text-neutral-500 italic">No delivery ticket created yet</span>
                                                    <button
                                                      onClick={() => handleCreateDeliveryTicket(item.requisitionId)}
                                                      disabled={ticketingId !== null}
                                                      className="text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 px-2.5 py-1.5 rounded-lg transition-colors inline-flex items-center gap-1 shadow-sm"
                                                      title="Generate a delivery ticket using the fulfilled allocations for this requisition"
                                                    >
                                                      <Truck className="h-3.5 w-3.5" />
                                                      {ticketingId === item.requisitionId ? "Creating..." : "Create Delivery Ticket"}
                                                    </button>
                                                  </>
                                                ) : (
                                                  <span className="text-xs text-neutral-500 italic">No delivery ticket created yet</span>
                                                )
                                              ) : (
                                                <span className="text-xs text-danger-500 font-semibold">
                                                  {item.requisitionStatus === 'rejected' ? 'Rejected' : 'Store pickup'}
                                                </span>
                                              )
                                            )}
                                          </>
                                        )}
                                    </>
                                  );
                                })()}
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

    {/* ── Print Pick List Modal ────────────────────────────────────────────── */}

    {printModalOpen && (
      <div className="fixed inset-0 z-[190] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
        <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
          <div className="flex items-start justify-between gap-4 border-b border-neutral-200 px-6 py-4">
            <div>
              <h3 className="text-lg font-bold text-neutral-950">Print Pick List</h3>
              <p className="mt-1 text-sm text-neutral-500">Generate read-only warehouse paperwork. This does not save allocations or change stock.</p>
            </div>
            <button onClick={() => setPrintModalOpen(false)} className="rounded-lg p-2 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="grid gap-5 overflow-y-auto px-6 py-5 lg:grid-cols-[280px_1fr]">
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-neutral-500">Print Scope</p>
                <div className="space-y-2">
                  {([
                    ["visible", "All currently visible filtered items"],
                    ["locations", "Selected locations only"],
                    ["requisitions", "Selected requisitions only"],
                    ["items", "Selected items only"],
                  ] as const).map(([value, label]) => (
                    <label key={value} className="flex cursor-pointer items-start gap-2 rounded-lg border border-neutral-200 p-3 text-sm hover:bg-neutral-50">
                      <input type="radio" checked={printScope === value} onChange={() => setPrintScope(value)} className="mt-1" />
                      <span className="font-medium text-neutral-800">{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-neutral-500">Options</p>
                <div className="space-y-2 rounded-xl border border-neutral-200 p-3">
                  {([
                    ["includeBreakdown", "Include location breakdown"],
                    ["includeRequisitionNumber", "Include requisition number"],
                    ["includeBackorders", "Include backorders"],
                    ["includeNotes", "Include fulfillment notes"],
                    ["includePickedQty", "Include blank Picked Qty"],
                    ["includeCheckedBy", "Include blank Checked By"],
                    ["pageBreakPerLocation", "Page break per location"],
                    ["onlyAllocated", "Include only allocated quantities"],
                    ["includeRequested", "Include requested quantities"],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
                      <input type="checkbox" checked={printOptions[key]} onChange={() => togglePrintOption(key)} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                <p className="font-bold">Recommended setup</p>
                <p className="mt-1">Group by item, include location breakdown, allocated/backordered quantities, and blank Picked Qty / Checked By columns.</p>
              </div>

              {printScope === "visible" && (
                <div className="rounded-xl border border-neutral-200 p-4">
                  <p className="text-sm font-bold text-neutral-900">Current visible filter</p>
                  <div className="mt-3 grid gap-2 text-sm text-neutral-600 sm:grid-cols-3">
                    <div><span className="font-semibold text-neutral-500">Search:</span> {search || "All items"}</div>
                    <div><span className="font-semibold text-neutral-500">Location:</span> {locationFilter === "all" ? "All locations" : locationFilter}</div>
                    <div><span className="font-semibold text-neutral-500">Status:</span> {statusFilter === "all" ? "All statuses" : statusFilter}</div>
                  </div>
                  <p className="mt-3 text-xs text-neutral-500">{filteredData.length} grouped item{filteredData.length === 1 ? "" : "s"} currently visible.</p>
                </div>
              )}

              {printScope === "locations" && (
                <div className="rounded-xl border border-neutral-200 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-bold text-neutral-900">Locations</p>
                    <div className="flex gap-2 text-xs font-semibold">
                      <button onClick={() => setPrintSelectedLocations(locations)} className="text-emerald-700 hover:underline">Select all</button>
                      <button onClick={() => setPrintSelectedLocations([])} className="text-neutral-500 hover:underline">Clear</button>
                    </div>
                  </div>
                  <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
                    {locations.map(loc => (
                      <label key={loc} className="flex cursor-pointer items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50">
                        <input type="checkbox" checked={printSelectedLocations.includes(loc)} onChange={() => toggleListValue(loc, setPrintSelectedLocations, printSelectedLocations)} />
                        <span className="truncate">{loc}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {printScope === "requisitions" && (
                <div className="rounded-xl border border-neutral-200 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-bold text-neutral-900">Requisitions</p>
                    <div className="flex gap-2 text-xs font-semibold">
                      <button onClick={() => setPrintSelectedRequisitions(requisitionOptions.map(r => r.id))} className="text-emerald-700 hover:underline">Select all</button>
                      <button onClick={() => setPrintSelectedRequisitions([])} className="text-neutral-500 hover:underline">Clear</button>
                    </div>
                  </div>
                  <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
                    {requisitionOptions.map(req => (
                      <label key={req.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50">
                        <input type="checkbox" checked={printSelectedRequisitions.includes(req.id)} onChange={() => toggleListValue(req.id, setPrintSelectedRequisitions, printSelectedRequisitions)} />
                        <span className="min-w-0"><span className="block truncate font-medium">{req.label}</span><span className="block truncate text-xs text-neutral-500">{req.locationName}</span></span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {printScope === "items" && (
                <div className="rounded-xl border border-neutral-200 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-bold text-neutral-900">Items</p>
                    <div className="flex gap-2 text-xs font-semibold">
                      <button onClick={() => setPrintSelectedItems(itemOptions)} className="text-emerald-700 hover:underline">Select all</button>
                      <button onClick={() => setPrintSelectedItems([])} className="text-neutral-500 hover:underline">Clear</button>
                    </div>
                  </div>
                  <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
                    {itemOptions.map(itemName => (
                      <label key={itemName} className="flex cursor-pointer items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50">
                        <input type="checkbox" checked={printSelectedItems.includes(itemName)} onChange={() => toggleListValue(itemName, setPrintSelectedItems, printSelectedItems)} />
                        <span className="truncate">{itemName}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-neutral-200 px-6 py-4 sm:flex-row sm:items-center sm:justify-end">
            <button onClick={() => setPrintModalOpen(false)} className="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50">Cancel</button>
            <button onClick={() => openPickListPrint("view")} className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50">
              <FileText className="h-4 w-4" /> Preview Print List
            </button>
            <button onClick={() => openPickListPrint("print")} className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800">
              <Printer className="h-4 w-4" /> Print / Save as PDF
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── Rejection Modal ─────────────────────────────────────────────────── */}
    {rejectModalReqId && (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-danger-100">
              <XSquare className="h-5 w-5 text-danger-600" />
            </div>
            <div>
              <h3 className="text-base font-bold text-neutral-900">Reject Requisition</h3>
              <p className="text-xs text-neutral-500">This action cannot be undone.</p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-neutral-700 mb-1.5">
              Rejection Reason <span className="text-danger-600">*</span>
            </label>
            <textarea
              rows={3}
              value={rejectionReason}
              onChange={e => setRejectionReason(e.target.value)}
              placeholder="Explain why this requisition is being rejected…"
              className="w-full border border-neutral-300 rounded-lg p-3 text-sm text-neutral-900 resize-none focus:outline-none focus:ring-2 focus:ring-danger-400 placeholder:text-neutral-400"
              autoFocus
            />
            {rejectionReason.trim() === '' && (
              <p className="mt-1 text-xs text-danger-600">A reason is required before rejecting.</p>
            )}
          </div>
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-neutral-100">
            <button
              onClick={() => { setRejectModalReqId(null); setRejectionReason(''); }}
              disabled={rejectActionLoading}
              className="px-4 py-2 text-sm font-medium text-neutral-600 bg-neutral-100 hover:bg-neutral-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                if (!rejectionReason.trim() || rejectActionLoading) return;
                setRejectActionLoading(true);
                try {
                  const res = await rejectRequisition(
                    rejectModalReqId,
                    user?.id ?? '',
                    rejectionReason.trim(),
                    user?.role ?? null
                  );
                  if (res.success) {
                    setToast('Requisition rejected.');
                    setRejectModalReqId(null);
                    setRejectionReason('');
                    await loadData();
                  } else {
                    alert(`Rejection failed: ${res.error?.message ?? 'Unknown error'}`);
                  }
                } finally {
                  setRejectActionLoading(false);
                }
              }}
              disabled={!rejectionReason.trim() || rejectActionLoading}
              className="px-4 py-2 text-sm font-medium bg-danger-600 text-white rounded-lg hover:bg-danger-700 transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              {rejectActionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <XSquare className="h-4 w-4" />}
              {rejectActionLoading ? 'Rejecting...' : 'Confirm Rejection'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── Delivery Ticket Drawer (shared canonical component) ──────────────── */}
    <DeliveryTicketDrawer
      ticket={dtDrawerTicket}
      onClose={() => {
        setDtDrawerTicket(null);
        // Remove ticketId from URL when the drawer is closed
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          url.searchParams.delete("ticketId");
          window.history.pushState({}, "", url.toString());
        }
      }}
      onRefresh={loadData}
      user={user}
      canEditAdmin={fulfillmentCanEditAdmin}
      canActOnTicket={fulfillmentCanActOnTicket}
      onToast={(msg) => setToast(msg)}
    />
    </>
  );
}
