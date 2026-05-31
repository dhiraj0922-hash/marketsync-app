"use client";

import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin } from "@/lib/roles";
import {
  loadLocations,
  loadDailySales,
  upsertDailySales,
  loadGratuitySettings,
  saveGratuitySettings,
  type LocationDailySales,
  type LocationSalesGratuitySettings,
} from "@/lib/storage";
import {
  ReceiptText,
  Save,
  Calendar,
  AlertCircle,
  CheckCircle2,
  TrendingUp,
  MapPin,
  Settings,
  BarChart4,
  DollarSign,
  Percent,
  Plus,
  ArrowRight,
  TrendingDown,
  Info
} from "lucide-react";

export default function LocationSalesPage() {
  const { user } = useAuth();
  const hq = isHqAdmin(user);

  // ── Common States ──────────────────────────────────────────────────────────
  const [locations, setLocations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // ── Location Manager Sales Entry States ────────────────────────────────────
  const [salesDate, setSalesDate] = useState(() => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });

  const [posSales, setPosSales]           = useState("");
  const [uberSales, setUberSales]         = useState("");
  const [onlineSales, setOnlineSales]     = useState("");
  const [cateringSales, setCateringSales] = useState("");
  const [skipSales, setSkipSales]         = useState("");
  const [doordashSales, setDoordashSales] = useState("");
  const [salesNotes, setSalesNotes]       = useState("");
  const [submitting, setSubmitting]       = useState(false);

  // ── HQ States ──────────────────────────────────────────────────────────────
  const [allSales, setAllSales] = useState<LocationDailySales[]>([]);
  const [gratuitySettings, setGratuitySettings] = useState<LocationSalesGratuitySettings>({
    id: "00000000-0000-0000-0000-000000000000",
    posPercent: 0,
    uberPercent: 0,
    onlinePercent: 0,
    cateringPercent: 0,
    skipPercent: 0,
    doordashPercent: 0,
  });

  // HQ Filters
  const [filterLocation, setFilterLocation] = useState("all");
  const [filterStartDate, setFilterStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });
  const [filterEndDate, setFilterEndDate] = useState(() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });
  const [viewMode, setViewMode] = useState<"daily" | "monthly">("daily");

  // HQ Settings Panel Modal
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [editPosPercent, setEditPosPercent]           = useState(0);
  const [editUberPercent, setEditUberPercent]         = useState(0);
  const [editOnlinePercent, setEditOnlinePercent]     = useState(0);
  const [editCateringPercent, setEditCateringPercent] = useState(0);
  const [editSkipPercent, setEditSkipPercent]         = useState(0);
  const [editDoordashPercent, setEditDoordashPercent] = useState(0);
  const [savingSettings, setSavingSettings]           = useState(false);

  // Load Initial Metadata
  useEffect(() => {
    async function init() {
      try {
        setLoading(true);
        const locs = await loadLocations();
        setLocations(locs.filter(l => l.status !== "Inactive"));

        if (hq) {
          const g = await loadGratuitySettings();
          setGratuitySettings(g);
          setEditPosPercent(g.posPercent);
          setEditUberPercent(g.uberPercent);
          setEditOnlinePercent(g.onlinePercent);
          setEditCateringPercent(g.cateringPercent);
          setEditSkipPercent(g.skipPercent);
          setEditDoordashPercent(g.doordashPercent);

          const sales = await loadDailySales(null, filterStartDate, filterEndDate);
          setAllSales(sales);
        } else if (user?.locationId) {
          // prefill sales if already entered for this date
          await fetchExistingEntry(user.locationId, salesDate);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [hq, user?.locationId]);

  // Fetch Existing Entry for Manager date-change
  const fetchExistingEntry = async (locId: string, dateStr: string) => {
    const existing = await loadDailySales(locId, dateStr, dateStr);
    if (existing && existing.length > 0) {
      const e = existing[0];
      setPosSales(e.posSales ? String(e.posSales) : "");
      setUberSales(e.uberSales ? String(e.uberSales) : "");
      setOnlineSales(e.onlineSales ? String(e.onlineSales) : "");
      setCateringSales(e.cateringSales ? String(e.cateringSales) : "");
      setSkipSales(e.skipSales ? String(e.skipSales) : "");
      setDoordashSales(e.doordashSales ? String(e.doordashSales) : "");
      setSalesNotes(e.notes ?? "");
    } else {
      setPosSales("");
      setUberSales("");
      setOnlineSales("");
      setCateringSales("");
      setSkipSales("");
      setDoordashSales("");
      setSalesNotes("");
    }
  };

  useEffect(() => {
    if (!hq && user?.locationId && salesDate) {
      fetchExistingEntry(user.locationId, salesDate);
    }
  }, [salesDate, hq, user?.locationId]);

  // HQ Load filtered sales
  const handleHqSearch = async () => {
    setLoading(true);
    try {
      const locFilter = filterLocation === "all" ? null : filterLocation;
      const sales = await loadDailySales(locFilter, filterStartDate, filterEndDate);
      setAllSales(sales);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Manager Save/Update Daily sales
  const handleSaveSales = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.locationId) {
      setMessage({ type: "error", text: "No assigned location found for your profile." });
      return;
    }

    const pos = Math.max(0, Number(posSales || 0));
    const uber = Math.max(0, Number(uberSales || 0));
    const online = Math.max(0, Number(onlineSales || 0));
    const cat = Math.max(0, Number(cateringSales || 0));
    const skip = Math.max(0, Number(skipSales || 0));
    const dd = Math.max(0, Number(doordashSales || 0));

    if (pos < 0 || uber < 0 || online < 0 || cat < 0 || skip < 0 || dd < 0) {
      setMessage({ type: "error", text: "Sales figures cannot be negative." });
      return;
    }

    setSubmitting(true);
    setMessage(null);

    const payload: LocationDailySales = {
      locationId: user.locationId,
      salesDate,
      posSales: pos,
      uberSales: uber,
      onlineSales: online,
      cateringSales: cat,
      skipSales: skip,
      doordashSales: dd,
      notes: salesNotes.trim() || null,
      createdBy: user.id || null,
    };

    const res = await upsertDailySales(payload);
    setSubmitting(false);

    if (res.success) {
      setMessage({ type: "success", text: `Sales details for ${salesDate} successfully saved!` });
      setTimeout(() => setMessage(null), 5000);
    } else {
      setMessage({ type: "error", text: res.error ?? "Failed to save sales data. Please try again." });
    }
  };

  // Save HQ Gratuity Percentages Settings
  const handleSaveGratuitySettings = async () => {
    setSavingSettings(true);
    const res = await saveGratuitySettings({
      id: "00000000-0000-0000-0000-000000000000",
      posPercent: Number(editPosPercent),
      uberPercent: Number(editUberPercent),
      onlinePercent: Number(editOnlinePercent),
      cateringPercent: Number(editCateringPercent),
      skipPercent: Number(editSkipPercent),
      doordashPercent: Number(editDoordashPercent),
      updatedBy: user?.id || null,
    });
    setSavingSettings(false);

    if (res.success) {
      setGratuitySettings({
        id: "00000000-0000-0000-0000-000000000000",
        posPercent: Number(editPosPercent),
        uberPercent: Number(editUberPercent),
        onlinePercent: Number(editOnlinePercent),
        cateringPercent: Number(editCateringPercent),
        skipPercent: Number(editSkipPercent),
        doordashPercent: Number(editDoordashPercent),
      });
      setShowSettingsPanel(false);
      setMessage({ type: "success", text: "Gratuity configurations saved." });
      setTimeout(() => setMessage(null), 3000);
    } else {
      alert("Failed to save settings: " + res.error);
    }
  };

  // Dynamic Manager Gross sales
  const currentGrossTotal = useMemo(() => {
    return (
      Number(posSales || 0) +
      Number(uberSales || 0) +
      Number(onlineSales || 0) +
      Number(cateringSales || 0) +
      Number(skipSales || 0) +
      Number(doordashSales || 0)
    );
  }, [posSales, uberSales, onlineSales, cateringSales, skipSales, doordashSales]);

  // Helpers to calculate detailed sales / gratuities row-wise
  const getRowCalculations = (row: LocationDailySales) => {
    const posGrat = row.posSales * (gratuitySettings.posPercent / 100);
    const uberGrat = row.uberSales * (gratuitySettings.uberPercent / 100);
    const onlineGrat = row.onlineSales * (gratuitySettings.onlinePercent / 100);
    const cateringGrat = row.cateringSales * (gratuitySettings.cateringPercent / 100);
    const skipGrat = row.skipSales * (gratuitySettings.skipPercent / 100);
    const ddGrat = row.doordashSales * (gratuitySettings.doordashPercent / 100);

    const totalGratuity = posGrat + uberGrat + onlineGrat + cateringGrat + skipGrat + ddGrat;
    const grossTotal =
      row.posSales +
      row.uberSales +
      row.onlineSales +
      row.cateringSales +
      row.skipSales +
      row.doordashSales;

    const finalSales = grossTotal + totalGratuity;

    return {
      posGrat,
      uberGrat,
      onlineGrat,
      cateringGrat,
      skipGrat,
      ddGrat,
      totalGratuity,
      grossTotal,
      finalSales,
    };
  };

  // HQ Aggregated KPIs
  const kpis = useMemo(() => {
    let pos = 0;
    let delivery = 0;
    let catering = 0;
    let gross = 0;
    let gratuity = 0;

    allSales.forEach(row => {
      pos += row.posSales;
      delivery += (row.uberSales + row.skipSales + row.doordashSales + row.onlineSales);
      catering += row.cateringSales;

      const calcs = getRowCalculations(row);
      gross += calcs.grossTotal;
      gratuity += calcs.totalGratuity;
    });

    return {
      pos,
      delivery,
      catering,
      gross,
      gratuity,
      final: gross + gratuity,
    };
  }, [allSales, gratuitySettings]);

  // Monthly Aggregated rows
  const monthlyAggregatedRows = useMemo(() => {
    if (!hq) return [];

    const map = new Map<string, {
      locationId: string;
      month: string; // YYYY-MM
      posSales: number;
      uberSales: number;
      onlineSales: number;
      cateringSales: number;
      skipSales: number;
      doordashSales: number;
    }>();

    allSales.forEach(row => {
      const month = row.salesDate.substring(0, 7); // YYYY-MM
      const key = `${row.locationId}_${month}`;

      if (!map.has(key)) {
        map.set(key, {
          locationId: row.locationId,
          month,
          posSales: 0,
          uberSales: 0,
          onlineSales: 0,
          cateringSales: 0,
          skipSales: 0,
          doordashSales: 0,
        });
      }

      const item = map.get(key)!;
      item.posSales += row.posSales;
      item.uberSales += row.uberSales;
      item.onlineSales += row.onlineSales;
      item.cateringSales += row.cateringSales;
      item.skipSales += row.skipSales;
      item.doordashSales += row.doordashSales;
    });

    return Array.from(map.values()).sort((a, b) => b.month.localeCompare(a.month) || a.locationId.localeCompare(b.locationId));
  }, [allSales, hq]);

  const assignedLoc = locations.find(l => l.id === user?.locationId);

  // Return Manager UI View
  if (!hq) {
    return (
      <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-6">
        {/* Header Title */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-neutral-200/80 shadow-sm">
          <div>
            <h1 className="text-2xl font-extrabold text-neutral-900 tracking-tight flex items-center gap-2">
              <ReceiptText className="h-6 w-6 text-brand-600" />
              Daily Sales Entry
            </h1>
            <p className="text-xs text-neutral-500 font-medium mt-1">
              Log and track your store sales categories on a daily basis.
            </p>
          </div>
          <div className="flex items-center gap-2 bg-brand-50/50 text-brand-700 px-3 py-1.5 rounded-lg border border-brand-200/50 text-xs font-bold uppercase tracking-wider shrink-0">
            <MapPin className="h-4 w-4" />
            {assignedLoc ? assignedLoc.name : user?.locationId ?? "No Location"}
          </div>
        </div>

        {/* Alerts */}
        {message && (
          <div
            className={`p-4 rounded-xl border flex items-start gap-3 animate-fade-in ${
              message.type === "success"
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : "bg-rose-50 border-rose-200 text-rose-800"
            }`}
          >
            {message.type === "success" ? (
              <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
            )}
            <div>
              <p className="text-sm font-semibold">{message.text}</p>
            </div>
          </div>
        )}

        {!user?.locationId ? (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 p-5 rounded-xl flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
            <div>
              <p className="text-sm font-bold">No Location Assigned</p>
              <p className="text-xs mt-1">Please contact your HQ Admin to assign a location profile to your credentials.</p>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSaveSales} className="space-y-6">
            {/* Sales Date Selector */}
            <div className="bg-white p-5 rounded-2xl border border-neutral-200/80 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1">
                <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">Sales Date</label>
                <p className="text-xs text-neutral-400">Selecting a date will pre-populate any previously saved entry.</p>
              </div>
              <div className="relative shrink-0 w-full md:w-64">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400 pointer-events-none" />
                <input
                  type="date"
                  value={salesDate}
                  onChange={e => setSalesDate(e.target.value)}
                  required
                  className="w-full pl-9 pr-4 py-2 border border-neutral-200 rounded-xl font-semibold text-neutral-700 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors"
                />
              </div>
            </div>

            {/* Platform Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* POS */}
              <div className="bg-white p-5 rounded-2xl border border-neutral-200/80 shadow-sm space-y-3 focus-within:border-brand-500 transition-colors">
                <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">POS Sales</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-neutral-400 pointer-events-none">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    value={posSales}
                    onChange={e => setPosSales(e.target.value)}
                    className="w-full pl-7 pr-4 py-2 bg-neutral-50/50 border border-neutral-200 rounded-xl text-sm font-semibold text-neutral-800 focus:bg-white focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
              </div>

              {/* Uber */}
              <div className="bg-white p-5 rounded-2xl border border-neutral-200/80 shadow-sm space-y-3 focus-within:border-brand-500 transition-colors">
                <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">Uber Sales</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-neutral-400 pointer-events-none">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    value={uberSales}
                    onChange={e => setUberSales(e.target.value)}
                    className="w-full pl-7 pr-4 py-2 bg-neutral-50/50 border border-neutral-200 rounded-xl text-sm font-semibold text-neutral-800 focus:bg-white focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
              </div>

              {/* Online */}
              <div className="bg-white p-5 rounded-2xl border border-neutral-200/80 shadow-sm space-y-3 focus-within:border-brand-500 transition-colors">
                <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">Online Sales</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-neutral-400 pointer-events-none">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    value={onlineSales}
                    onChange={e => setOnlineSales(e.target.value)}
                    className="w-full pl-7 pr-4 py-2 bg-neutral-50/50 border border-neutral-200 rounded-xl text-sm font-semibold text-neutral-800 focus:bg-white focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
              </div>

              {/* Catering */}
              <div className="bg-white p-5 rounded-2xl border border-neutral-200/80 shadow-sm space-y-3 focus-within:border-brand-500 transition-colors">
                <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">Catering Sales</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-neutral-400 pointer-events-none">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    value={cateringSales}
                    onChange={e => setCateringSales(e.target.value)}
                    className="w-full pl-7 pr-4 py-2 bg-neutral-50/50 border border-neutral-200 rounded-xl text-sm font-semibold text-neutral-800 focus:bg-white focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
              </div>

              {/* Skip */}
              <div className="bg-white p-5 rounded-2xl border border-neutral-200/80 shadow-sm space-y-3 focus-within:border-brand-500 transition-colors">
                <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">Skip Sales</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-neutral-400 pointer-events-none">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    value={skipSales}
                    onChange={e => setSkipSales(e.target.value)}
                    className="w-full pl-7 pr-4 py-2 bg-neutral-50/50 border border-neutral-200 rounded-xl text-sm font-semibold text-neutral-800 focus:bg-white focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
              </div>

              {/* DoorDash */}
              <div className="bg-white p-5 rounded-2xl border border-neutral-200/80 shadow-sm space-y-3 focus-within:border-brand-500 transition-colors">
                <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">DoorDash Sales</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-neutral-400 pointer-events-none">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    value={doordashSales}
                    onChange={e => setDoordashSales(e.target.value)}
                    className="w-full pl-7 pr-4 py-2 bg-neutral-50/50 border border-neutral-200 rounded-xl text-sm font-semibold text-neutral-800 focus:bg-white focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
              </div>
            </div>

            {/* Notes & Summary Block */}
            <div className="bg-white p-6 rounded-2xl border border-neutral-200/80 shadow-sm grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">Additional Notes</label>
                <textarea
                  placeholder="Enter any platform downtime, caterings details, or sales notes here..."
                  rows={4}
                  value={salesNotes}
                  onChange={e => setSalesNotes(e.target.value)}
                  className="w-full p-3 bg-neutral-50/50 border border-neutral-200 rounded-xl text-sm font-semibold text-neutral-800 focus:bg-white focus:outline-none focus:border-brand-500 transition-colors placeholder:text-neutral-400 resize-none"
                />
              </div>

              <div className="flex flex-col justify-between border-t md:border-t-0 md:border-l border-neutral-200 pt-5 md:pt-0 md:pl-6">
                <div>
                  <h3 className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Gross Sales Realtime Summary</h3>
                  <div className="flex items-baseline gap-1 mt-2 text-brand-700">
                    <span className="text-2xl font-extrabold">$</span>
                    <span className="text-4xl font-black leading-none tracking-tight">
                      {currentGrossTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <p className="text-[11px] text-neutral-500 mt-2 font-medium">
                    This automatically aggregates pos + delivery + catering categories. HQ configured percentages will be applied post-saving for gratuity evaluations.
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white font-bold text-sm py-3 px-6 rounded-xl shadow-lg shadow-brand-600/10 hover:shadow-brand-600/20 flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed mt-4"
                >
                  <Save className="h-4 w-4" />
                  {submitting ? "Saving Entry..." : "Save Sales Entry"}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    );
  }

  // Return HQ Admin UI Dashboard View
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1600px] mx-auto">
      {/* HQ Title Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-neutral-200/80 shadow-sm">
        <div>
          <h1 className="text-2xl font-extrabold text-neutral-900 tracking-tight flex items-center gap-2">
            <BarChart4 className="h-6 w-6 text-brand-600" />
            Location Sales Report
          </h1>
          <p className="text-xs text-neutral-500 font-medium mt-1">
            Track gross daily/monthly platform numbers and apply gratuity percentage additions.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowSettingsPanel(true)}
            className="flex items-center gap-2 px-4 py-2 border border-neutral-200 hover:bg-neutral-50 text-neutral-700 font-bold text-xs rounded-xl transition-colors"
          >
            <Settings className="h-4 w-4" />
            Configure Gratuity Rates
          </button>
        </div>
      </div>

      {/* Alerts */}
      {message && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-4 rounded-xl flex items-center gap-3 animate-fade-in">
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          <p className="text-sm font-semibold">{message.text}</p>
        </div>
      )}

      {/* Filters Form Panel */}
      <div className="bg-white p-5 rounded-2xl border border-neutral-200/80 shadow-sm space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider block">Target Location</label>
            <select
              value={filterLocation}
              onChange={e => setFilterLocation(e.target.value)}
              className="w-full p-2 bg-neutral-50/50 border border-neutral-200 rounded-xl text-xs font-semibold text-neutral-700 focus:bg-white focus:outline-none focus:border-brand-500 transition-colors"
            >
              <option value="all">All Locations</option>
              {locations.map(l => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider block">Start Date</label>
            <input
              type="date"
              value={filterStartDate}
              onChange={e => setFilterStartDate(e.target.value)}
              className="w-full p-2 bg-neutral-50/50 border border-neutral-200 rounded-xl text-xs font-semibold text-neutral-700 focus:bg-white focus:outline-none focus:border-brand-500 transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider block">End Date</label>
            <input
              type="date"
              value={filterEndDate}
              onChange={e => setFilterEndDate(e.target.value)}
              className="w-full p-2 bg-neutral-50/50 border border-neutral-200 rounded-xl text-xs font-semibold text-neutral-700 focus:bg-white focus:outline-none focus:border-brand-500 transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider block">Report Aggregation</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setViewMode("daily")}
                className={`py-2 px-3 border rounded-xl text-xs font-bold transition-all ${
                  viewMode === "daily"
                    ? "bg-brand-600 border-brand-600 text-white shadow-sm"
                    : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                }`}
              >
                Daily Details
              </button>
              <button
                type="button"
                onClick={() => setViewMode("monthly")}
                className={`py-2 px-3 border rounded-xl text-xs font-bold transition-all ${
                  viewMode === "monthly"
                    ? "bg-brand-600 border-brand-600 text-white shadow-sm"
                    : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                }`}
              >
                Monthly Summary
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={handleHqSearch}
            className="bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white font-bold text-xs py-2.5 px-6 rounded-xl flex items-center gap-2 shadow-sm transition-colors"
          >
            Search Report Records
          </button>
        </div>
      </div>

      {/* HQ KPI Summary Cards Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {/* KPI: POS */}
        <div className="bg-white p-4 rounded-2xl border border-neutral-200/80 shadow-sm space-y-1">
          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">POS Sales</p>
          <p className="text-xl font-extrabold text-neutral-800">${kpis.pos.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>

        {/* KPI: Delivery/App */}
        <div className="bg-white p-4 rounded-2xl border border-neutral-200/80 shadow-sm space-y-1">
          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">App & Online</p>
          <p className="text-xl font-extrabold text-neutral-800">${kpis.delivery.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>

        {/* KPI: Catering */}
        <div className="bg-white p-4 rounded-2xl border border-neutral-200/80 shadow-sm space-y-1">
          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Catering</p>
          <p className="text-xl font-extrabold text-neutral-800">${kpis.catering.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>

        {/* KPI: Gross Sales */}
        <div className="bg-white p-4 rounded-2xl border border-neutral-200/80 shadow-sm space-y-1 bg-brand-50/20 border-brand-100">
          <p className="text-[10px] font-bold text-brand-600 uppercase tracking-wider">Gross Sales</p>
          <p className="text-xl font-black text-brand-800">${kpis.gross.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>

        {/* KPI: Gratuity */}
        <div className="bg-white p-4 rounded-2xl border border-neutral-200/80 shadow-sm space-y-1 bg-emerald-50/20 border-emerald-100">
          <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider">Gratuity Total</p>
          <p className="text-xl font-extrabold text-emerald-800">${kpis.gratuity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>

        {/* KPI: Final Sales */}
        <div className="bg-white p-4 rounded-2xl border border-neutral-200/80 shadow-sm space-y-1 bg-neutral-900 border-neutral-900">
          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Final Sales</p>
          <p className="text-xl font-black text-white">${kpis.final.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>
      </div>

      {/* Main Table Segment */}
      <div className="bg-white rounded-2xl border border-neutral-200/80 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-200/80 flex items-center justify-between">
          <h3 className="font-extrabold text-sm text-neutral-800">
            {viewMode === "daily" ? "Daily Location Details Logs" : "Monthly Location Aggregations"}
          </h3>
          <span className="text-[10px] bg-neutral-100 text-neutral-500 font-bold px-2 py-0.5 rounded uppercase">
            {viewMode} report
          </span>
        </div>

        <div className="overflow-x-auto">
          {viewMode === "daily" ? (
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-neutral-50/75 border-b border-neutral-200/80 text-neutral-400 font-bold uppercase tracking-wider">
                  <th className="px-5 py-3">Location</th>
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3 text-right">POS Sales</th>
                  <th className="px-5 py-3 text-right">Uber</th>
                  <th className="px-5 py-3 text-right">Online</th>
                  <th className="px-5 py-3 text-right">Catering</th>
                  <th className="px-5 py-3 text-right">Skip</th>
                  <th className="px-5 py-3 text-right">DoorDash</th>
                  <th className="px-5 py-3 text-right font-semibold text-neutral-500 bg-neutral-50/50">Gross Sales</th>
                  <th className="px-5 py-3 text-right font-semibold text-emerald-600 bg-emerald-50/10">Gratuity</th>
                  <th className="px-5 py-3 text-right font-bold text-neutral-700 bg-neutral-50/50">Final Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 font-semibold text-neutral-700">
                {allSales.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="text-center py-8 text-neutral-400 font-medium">
                      No daily sales records found for the selected filter criteria.
                    </td>
                  </tr>
                ) : (
                  allSales.map(row => {
                    const calcs = getRowCalculations(row);
                    const lName = locations.find(l => l.id === row.locationId)?.name ?? row.locationId;
                    return (
                      <tr key={row.id} className="hover:bg-neutral-50/50">
                        <td className="px-5 py-3 text-neutral-900 font-extrabold">{lName}</td>
                        <td className="px-5 py-3 text-neutral-500 font-medium">{row.salesDate}</td>
                        <td className="px-5 py-3 text-right">${row.posSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">${row.uberSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">${row.onlineSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">${row.cateringSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">${row.skipSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">${row.doordashSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right font-extrabold text-neutral-800 bg-neutral-50/30">${calcs.grossTotal.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right font-extrabold text-emerald-700 bg-emerald-50/5">${calcs.totalGratuity.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right font-black text-neutral-900 bg-neutral-50/30">${calcs.finalSales.toFixed(2)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-neutral-50/75 border-b border-neutral-200/80 text-neutral-400 font-bold uppercase tracking-wider">
                  <th className="px-5 py-3">Location</th>
                  <th className="px-5 py-3">Month</th>
                  <th className="px-5 py-3 text-right">POS Sales</th>
                  <th className="px-5 py-3 text-right">Uber</th>
                  <th className="px-5 py-3 text-right">Online</th>
                  <th className="px-5 py-3 text-right">Catering</th>
                  <th className="px-5 py-3 text-right">Skip</th>
                  <th className="px-5 py-3 text-right">DoorDash</th>
                  <th className="px-5 py-3 text-right font-semibold text-neutral-500 bg-neutral-50/50">Gross Sales</th>
                  <th className="px-5 py-3 text-right font-semibold text-emerald-600 bg-emerald-50/10">Gratuity</th>
                  <th className="px-5 py-3 text-right font-bold text-neutral-700 bg-neutral-50/50">Final Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 font-semibold text-neutral-700">
                {monthlyAggregatedRows.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="text-center py-8 text-neutral-400 font-medium">
                      No monthly summaries generated for the selected criteria.
                    </td>
                  </tr>
                ) : (
                  monthlyAggregatedRows.map(row => {
                    const dummyRow: LocationDailySales = {
                      locationId: row.locationId,
                      salesDate: `${row.month}-01`,
                      posSales: row.posSales,
                      uberSales: row.uberSales,
                      onlineSales: row.onlineSales,
                      cateringSales: row.cateringSales,
                      skipSales: row.skipSales,
                      doordashSales: row.doordashSales,
                    };
                    const calcs = getRowCalculations(dummyRow);
                    const lName = locations.find(l => l.id === row.locationId)?.name ?? row.locationId;
                    return (
                      <tr key={`${row.locationId}_${row.month}`} className="hover:bg-neutral-50/50">
                        <td className="px-5 py-3 text-neutral-900 font-extrabold">{lName}</td>
                        <td className="px-5 py-3 text-neutral-500 font-medium">{row.month}</td>
                        <td className="px-5 py-3 text-right">${row.posSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">${row.uberSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">${row.onlineSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">${row.cateringSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">${row.skipSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">${row.doordashSales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right font-extrabold text-neutral-800 bg-neutral-50/30">${calcs.grossTotal.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right font-extrabold text-emerald-700 bg-emerald-50/5">${calcs.totalGratuity.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right font-black text-neutral-900 bg-neutral-50/30">${calcs.finalSales.toFixed(2)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Gratuity Rate Settings Side/Modal Panel */}
      {showSettingsPanel && (
        <div className="fixed inset-0 bg-neutral-900/40 backdrop-blur-sm z-50 flex justify-end">
          <div className="w-full max-w-md bg-white h-full shadow-2xl flex flex-col animate-slide-in">
            <div className="p-5 border-b border-neutral-200/80 flex items-center justify-between bg-neutral-50">
              <h2 className="font-extrabold text-base text-neutral-900 flex items-center gap-2">
                <Settings className="h-5 w-5 text-brand-600" />
                Configure Gratuity Rates
              </h2>
              <button
                onClick={() => setShowSettingsPanel(false)}
                className="p-1 rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 transition-all"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              <p className="text-xs text-neutral-500 font-medium leading-relaxed">
                Set category-specific gratuity percentages. Gratuity percentage values must be between <strong>0% and 10%</strong>. Setting a value will instantly re-calculate calculations in the table and KPI widgets above.
              </p>

              {/* POS */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">POS Gratuity %</label>
                  <span className="text-xs font-extrabold text-neutral-800">{editPosPercent}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={editPosPercent}
                  onChange={e => setEditPosPercent(Number(e.target.value))}
                  className="w-full accent-brand-600"
                />
              </div>

              {/* Uber */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">Uber Gratuity %</label>
                  <span className="text-xs font-extrabold text-neutral-800">{editUberPercent}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={editUberPercent}
                  onChange={e => setEditUberPercent(Number(e.target.value))}
                  className="w-full accent-brand-600"
                />
              </div>

              {/* Online */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">Online Gratuity %</label>
                  <span className="text-xs font-extrabold text-neutral-800">{editOnlinePercent}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={editOnlinePercent}
                  onChange={e => setEditOnlinePercent(Number(e.target.value))}
                  className="w-full accent-brand-600"
                />
              </div>

              {/* Catering */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">Catering Gratuity %</label>
                  <span className="text-xs font-extrabold text-neutral-800">{editCateringPercent}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={editCateringPercent}
                  onChange={e => setEditCateringPercent(Number(e.target.value))}
                  className="w-full accent-brand-600"
                />
              </div>

              {/* Skip */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">Skip Gratuity %</label>
                  <span className="text-xs font-extrabold text-neutral-800">{editSkipPercent}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={editSkipPercent}
                  onChange={e => setEditSkipPercent(Number(e.target.value))}
                  className="w-full accent-brand-600"
                />
              </div>

              {/* DoorDash */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold text-neutral-500 uppercase tracking-wider block">DoorDash Gratuity %</label>
                  <span className="text-xs font-extrabold text-neutral-800">{editDoordashPercent}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={editDoordashPercent}
                  onChange={e => setEditDoordashPercent(Number(e.target.value))}
                  className="w-full accent-brand-600"
                />
              </div>
            </div>

            <div className="p-6 border-t border-neutral-200 bg-neutral-50 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowSettingsPanel(false)}
                className="w-1/2 py-2.5 px-4 border border-neutral-200 rounded-xl font-bold text-xs hover:bg-neutral-100 text-neutral-600 transition-colors"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={handleSaveGratuitySettings}
                disabled={savingSettings}
                className="w-1/2 py-2.5 px-4 bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white font-bold text-xs rounded-xl shadow-lg shadow-brand-600/10 hover:shadow-brand-600/20 flex items-center justify-center gap-1 transition-all"
              >
                <Save className="h-4.5 w-4.5" />
                {savingSettings ? "Saving Settings..." : "Save Configs"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Inline fallback X close icon
function XIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
