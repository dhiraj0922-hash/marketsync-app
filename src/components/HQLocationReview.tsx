"use client";

/**
 * HQLocationReview — HQ-only cross-location drill-down panel.
 * Visible only to hq_admin. Given a list of locations, lets HQ select one
 * and immediately see that location's operational snapshot:
 *   - Inventory (low-stock highlighted)
 *   - Open requisitions
 *   - Pending / active counts
 *   - Recent purchase orders
 *
 * Data is loaded on-demand when the user picks a location, using the
 * existing location_id-scoped storage functions.
 */

import { useState, useCallback } from "react";
import { Search, X, MapPin, Package, FileText, ClipboardCheck, ShoppingCart, AlertTriangle, ChevronDown, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { loadInventory, loadRequisitions, loadCounts, loadOrders } from "@/lib/storage";

interface Location {
  id: string;
  name: string;
  [key: string]: any;
}

interface HQLocationReviewProps {
  locations: Location[];
}

// ─── tiny status normaliser ──────────────────────────────────────────────────
const FULFILLABLE = new Set(["approved", "partial", "backordered"]);
const normStatus = (s: string) => (s ?? "").toLowerCase();

export default function HQLocationReview({ locations }: HQLocationReviewProps) {
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Loaded data for selected location
  const [locInventory, setLocInventory]     = useState<any[]>([]);
  const [locReqs, setLocReqs]               = useState<any[]>([]);
  const [locCounts, setLocCounts]           = useState<any[]>([]);
  const [locOrders, setLocOrders]           = useState<any[]>([]);

  const filteredLocations = locations.filter(l =>
    l.name?.toLowerCase().includes(search.toLowerCase()) ||
    l.id?.toLowerCase().includes(search.toLowerCase())
  );

  const loadLocationData = useCallback(async (loc: Location) => {
    setIsLoading(true);
    setSelectedLocation(loc);
    setIsOpen(false);
    setSearch("");
    try {
      const [inv, reqs, cnts, ords] = await Promise.all([
        loadInventory(loc.id),
        loadRequisitions(loc.id),
        loadCounts(loc.id),
        loadOrders(loc.id),
      ]);
      setLocInventory(inv);
      setLocReqs(reqs);
      setLocCounts(cnts);
      setLocOrders(ords);
    } catch (e) {
      console.error("[HQLocationReview] load failed", e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const clearSelection = () => {
    setSelectedLocation(null);
    setLocInventory([]);
    setLocReqs([]);
    setLocCounts([]);
    setLocOrders([]);
  };

  // ── Derived metrics ──────────────────────────────────────────────────────
  const lowStockItems   = locInventory.filter(i => i.inStock < i.parLevel);
  const openReqs        = locReqs.filter(r => FULFILLABLE.has(normStatus(r.status)));
  const pendingCounts   = locCounts.filter(c => normStatus(c.status) === "submitted" || normStatus(c.status) === "draft");
  const recentOrders    = locOrders.slice(0, 5);
  const backorderedReqs = locReqs.filter(r => normStatus(r.status) === "backordered");

  return (
    <div className="space-y-4">
      {/* ── Header bar ──────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-indigo-600 text-white rounded-md">
            <MapPin className="h-4 w-4" />
          </div>
          <h3 className="text-base font-bold text-neutral-900">Location Review</h3>
          <span className="text-[10px] uppercase tracking-wider font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">HQ Only</span>
        </div>

        {/* ── Location picker ─────────────────────────────────────────── */}
        <div className="relative sm:ml-auto">
          <button
            onClick={() => setIsOpen(v => !v)}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-neutral-200 rounded-lg text-sm font-medium text-neutral-700 hover:bg-neutral-50 shadow-sm transition-colors min-w-[200px] justify-between"
          >
            <span className="flex items-center gap-2 truncate">
              <MapPin className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
              {selectedLocation ? selectedLocation.name : "Select a location…"}
            </span>
            <ChevronDown className={`h-3.5 w-3.5 text-neutral-400 shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} />
          </button>

          {isOpen && (
            <div className="absolute z-50 top-full mt-1 right-0 w-64 bg-white border border-neutral-200 rounded-xl shadow-xl overflow-hidden">
              {/* search */}
              <div className="p-2 border-b border-neutral-100">
                <div className="flex items-center gap-2 bg-neutral-50 border border-neutral-200 rounded-lg px-3 py-1.5">
                  <Search className="h-3.5 w-3.5 text-neutral-400 shrink-0" />
                  <input
                    autoFocus
                    type="text"
                    placeholder="Search locations…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="bg-transparent text-sm w-full outline-none text-neutral-700 placeholder:text-neutral-400"
                  />
                  {search && (
                    <button onClick={() => setSearch("")}>
                      <X className="h-3.5 w-3.5 text-neutral-400 hover:text-neutral-600" />
                    </button>
                  )}
                </div>
              </div>
              {/* list */}
              <div className="max-h-56 overflow-y-auto">
                {filteredLocations.length === 0 ? (
                  <div className="p-4 text-center text-sm text-neutral-400">No locations found.</div>
                ) : filteredLocations.map(loc => (
                  <button
                    key={loc.id}
                    onClick={() => loadLocationData(loc)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-indigo-50 transition-colors ${selectedLocation?.id === loc.id ? "bg-indigo-50 text-indigo-700 font-semibold" : "text-neutral-700"}`}
                  >
                    <MapPin className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                    <div>
                      <div className="font-medium">{loc.name}</div>
                      <div className="text-[10px] text-neutral-400">{loc.id}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {selectedLocation && (
          <button
            onClick={clearSelection}
            className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700 transition-colors"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        )}
      </div>

      {/* ── Loading spinner ──────────────────────────────────────────────── */}
      {isLoading && (
        <div className="flex items-center justify-center py-10 text-neutral-400 gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading {selectedLocation?.name} data…
        </div>
      )}

      {/* ── Review panel (only when a location is selected and loaded) ───── */}
      {!isLoading && selectedLocation && (
        <div className="space-y-4">
          {/* ── Summary bar ────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Inventory Items",  value: locInventory.length,   icon: <Package className="h-4 w-4" />,        color: "bg-indigo-50 text-indigo-600"  },
              { label: "Open Requisitions", value: openReqs.length,      icon: <FileText className="h-4 w-4" />,       color: "bg-amber-50  text-amber-600"   },
              { label: "Pending Counts",   value: pendingCounts.length,  icon: <ClipboardCheck className="h-4 w-4" />, color: "bg-violet-50 text-violet-600"  },
              { label: "Recent POs",       value: recentOrders.length,   icon: <ShoppingCart className="h-4 w-4" />,   color: "bg-sky-50    text-sky-600"     },
            ].map(m => (
              <Card key={m.label} className="shadow-sm border-neutral-200">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className={`p-2 rounded-md shrink-0 ${m.color}`}>{m.icon}</div>
                  <div>
                    <div className="text-xl font-bold text-neutral-900">{m.value}</div>
                    <div className="text-xs text-neutral-500">{m.label}</div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* ── Alert ribbon (low stock + backorders) ──────────────────── */}
          {(lowStockItems.length > 0 || backorderedReqs.length > 0) && (
            <div className="flex flex-wrap gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              {lowStockItems.length > 0 && (
                <span className="text-xs font-medium text-amber-800">
                  {lowStockItems.length} item{lowStockItems.length !== 1 ? "s" : ""} below par
                </span>
              )}
              {lowStockItems.length > 0 && backorderedReqs.length > 0 && (
                <span className="text-xs text-amber-400">·</span>
              )}
              {backorderedReqs.length > 0 && (
                <span className="text-xs font-medium text-amber-800">
                  {backorderedReqs.length} backordered requisition{backorderedReqs.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          )}

          {/* ── Four-column detail grid ─────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* Inventory snapshot */}
            <Card className="shadow-sm border-neutral-200">
              <CardHeader className="border-b border-neutral-100 pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold text-neutral-700 flex items-center gap-2">
                  <Package className="h-4 w-4 text-indigo-500" /> Inventory Snapshot
                  {lowStockItems.length > 0 && (
                    <Badge variant="warning" className="ml-auto text-[10px]">
                      {lowStockItems.length} low
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 max-h-56 overflow-y-auto">
                {locInventory.length === 0 ? (
                  <p className="text-xs text-neutral-400 text-center py-6">No inventory rows found.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-neutral-50 sticky top-0">
                      <tr>
                        <th className="text-left font-medium text-neutral-500 px-4 py-2">Item</th>
                        <th className="text-center font-medium text-neutral-500 px-2 py-2">Stock</th>
                        <th className="text-center font-medium text-neutral-500 px-2 py-2">Par</th>
                        <th className="text-right font-medium text-neutral-500 px-4 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {locInventory.map(item => {
                        const isLow = item.inStock < item.parLevel;
                        return (
                          <tr key={item.id} className={isLow ? "bg-amber-50/50" : ""}>
                            <td className="px-4 py-2 font-medium text-neutral-800 max-w-[140px] truncate">{item.name}</td>
                            <td className="px-2 py-2 text-center text-neutral-600">{item.inStock} {item.unit}</td>
                            <td className="px-2 py-2 text-center text-neutral-500">{item.parLevel}</td>
                            <td className="px-4 py-2 text-right">
                              {item.inStock === 0
                                ? <span className="text-[10px] font-bold text-danger-600">Out</span>
                                : isLow
                                ? <span className="text-[10px] font-bold text-amber-600">Low</span>
                                : <span className="text-[10px] text-success-600 font-medium">OK</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {/* Open Requisitions */}
            <Card className="shadow-sm border-neutral-200">
              <CardHeader className="border-b border-neutral-100 pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold text-neutral-700 flex items-center gap-2">
                  <FileText className="h-4 w-4 text-amber-500" /> Open Requisitions
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 max-h-56 overflow-y-auto">
                {locReqs.length === 0 ? (
                  <p className="text-xs text-neutral-400 text-center py-6">No requisitions found.</p>
                ) : (
                  <div className="divide-y divide-neutral-100">
                    {locReqs.slice(0, 10).map(req => (
                      <div key={req.id} className="px-4 py-2.5 flex items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-semibold text-neutral-800">{req.id}</div>
                          <div className="text-[10px] text-neutral-400">
                            {req.date} · {req.lineItems?.length ?? 0} line{(req.lineItems?.length ?? 0) !== 1 ? "s" : ""}
                            {req.totalAmount > 0 && (
                              <span className="ml-1.5 font-semibold text-neutral-600">
                                · ${Number(req.totalAmount).toFixed(2)}
                              </span>
                            )}
                          </div>
                        </div>
                        <Badge
                          variant={
                            normStatus(req.status) === "fulfilled" ? "success"
                            : normStatus(req.status) === "approved" ? "default"
                            : normStatus(req.status) === "backordered" ? "danger"
                            : "neutral"
                          }
                          className="text-[10px] shrink-0"
                        >
                          {req.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Count Status */}
            <Card className="shadow-sm border-neutral-200">
              <CardHeader className="border-b border-neutral-100 pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold text-neutral-700 flex items-center gap-2">
                  <ClipboardCheck className="h-4 w-4 text-violet-500" /> Count Status
                  {pendingCounts.length > 0 && (
                    <Badge variant="warning" className="ml-auto text-[10px]">
                      {pendingCounts.length} pending
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 max-h-56 overflow-y-auto">
                {locCounts.length === 0 ? (
                  <p className="text-xs text-neutral-400 text-center py-6">No counts found.</p>
                ) : (
                  <div className="divide-y divide-neutral-100">
                    {locCounts.slice(0, 8).map(c => (
                      <div key={c.id} className="px-4 py-2.5 flex items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-semibold text-neutral-800 truncate max-w-[160px]">{c.name}</div>
                          <div className="text-[10px] text-neutral-400">{c.date} · {c.type}</div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge
                            variant={
                              normStatus(c.status) === "approved" ? "success"
                              : normStatus(c.status) === "submitted" ? "default"
                              : "warning"
                            }
                            className="text-[10px]"
                          >
                            {c.status}
                          </Badge>
                          {c.totalVarianceValue !== 0 && (
                            <span className={`text-[10px] font-medium ${c.totalVarianceValue < 0 ? "text-danger-600" : "text-success-600"}`}>
                              {c.totalVarianceValue > 0 ? "+" : ""}${c.totalVarianceValue?.toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Recent POs */}
            <Card className="shadow-sm border-neutral-200">
              <CardHeader className="border-b border-neutral-100 pb-3 pt-4 px-4">
                <CardTitle className="text-sm font-semibold text-neutral-700 flex items-center gap-2">
                  <ShoppingCart className="h-4 w-4 text-sky-500" /> Recent Purchase Orders
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 max-h-56 overflow-y-auto">
                {recentOrders.length === 0 ? (
                  <p className="text-xs text-neutral-400 text-center py-6">No purchase orders found.</p>
                ) : (
                  <div className="divide-y divide-neutral-100">
                    {recentOrders.map(o => (
                      <div key={o.id} className="px-4 py-2.5 flex items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-semibold text-neutral-800">{o.id}</div>
                          <div className="text-[10px] text-neutral-400">{o.date} · {o.items} item{o.items !== 1 ? "s" : ""}</div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge
                            variant={o.status === "Delivered" ? "success" : o.status === "Sent" ? "default" : "warning"}
                            className="text-[10px]"
                          >
                            {o.status}
                          </Badge>
                          <span className="text-[10px] font-medium text-neutral-600">${Number(o.total).toFixed(2)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ── Empty state (no selection yet) ─────────────────────────────────── */}
      {!isLoading && !selectedLocation && (
        <div className="flex flex-col items-center justify-center py-10 text-neutral-400 gap-2">
          <MapPin className="h-8 w-8 text-neutral-200" />
          <p className="text-sm">Select a location above to review its operational data.</p>
        </div>
      )}
    </div>
  );
}
