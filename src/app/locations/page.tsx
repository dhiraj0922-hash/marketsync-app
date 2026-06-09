"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/components/AuthProvider";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Search,
  Plus,
  MapPin,
  Building,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  RefreshCw,
  FileText,
  Users,
  Truck,
  Building2,
  Activity,
  Phone,
  ShieldAlert,
  Info,
  CreditCard,
  User,
  Heart,
  XCircle,
  AlertCircle
} from "lucide-react";
import {
  getAllLocationsForRegistry,
  getLocationRegistryHealth,
  createLocationWithProfile,
  updateLocationRegistryRecord,
  updateLocationBillingProfile,
  getLocationUsers,
  getLocationActivityCounts,
  syncLocationAddressToOpenTickets,
  type LocationBillingProfile,
  type UserProfileRow,
} from "@/lib/storage";
import {
  isActiveLocation,
  isStoreLocation,
  isHqLocation,
  isInternalLocation,
  isWarehouseLocation,
  isDeliveryDestinationLocation,
  buildFullLocationAddress,
  getLocationHealthStatus,
} from "@/lib/locationRegistry";

type Tab = "info" | "address" | "billing" | "users" | "delivery" | "health";

export default function Locations() {
  return (
    <HQOnlyGuard>
      <LocationsPageContent />
    </HQOnlyGuard>
  );
}

function LocationsPageContent() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState<any[]>([]);
  const [healthSummary, setHealthSummary] = useState<any>(null);
  const [activityMap, setActivityMap] = useState<Record<string, any>>({});
  const [warningsMap, setWarningsMap] = useState<Record<string, string[]>>({});

  // Search and Filter States
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [purposeFilter, setPurposeFilter] = useState("all");

  // Drawer States
  const [isAddDrawerOpen, setIsAddDrawerOpen] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<any | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("info");
  const [drawerUsers, setDrawerUsers] = useState<UserProfileRow[]>([]);
  const [drawerActivity, setDrawerActivity] = useState<any>(null);
  const [drawerWarnings, setDrawerWarnings] = useState<string[]>([]);
  const [syncCount, setSyncCount] = useState<number | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  // Forms
  const [addForm, setAddForm] = useState({
    id: "",
    name: "",
    code: "",
    status: "active",
    type: "branch",
    subtype: "Store",
    purpose: "store",
    isDeliveryDestination: true,
    isHq: false,
    isInternal: false,
    notes: "",
    storeAddress: "",
    storeCity: "",
    storeProvince: "",
    storePostalCode: "",
    storePhone: "",
    storeManagerName: "",
  });

  const [editBasicForm, setEditBasicForm] = useState({
    name: "",
    code: "",
    status: "active",
    type: "branch",
    subtype: "Store",
    purpose: "store",
    isDeliveryDestination: true,
    isHq: false,
    isInternal: false,
    notes: "",
    sortOrder: "" as string | number,
  });

  const [editAddressForm, setEditAddressForm] = useState({
    storeAddress: "",
    storeCity: "",
    storeProvince: "",
    storePostalCode: "",
    storePhone: "",
    storeManagerName: "",
  });

  const [editBillingForm, setEditBillingForm] = useState({
    legalName: "",
    incorporationAddress: "",
    billingAddress: "",
    billingCity: "",
    billingProvince: "",
    billingPostalCode: "",
    hstNumber: "",
    businessNumber: "",
    billingEmail: "",
    invoiceContactName: "",
  });

  // Action status states
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const allLocs = await getAllLocationsForRegistry();
      setLocations(allLocs);

      const health = await getLocationRegistryHealth();
      setHealthSummary(health.summary);

      // Pre-map activities and warnings for table display
      const actMap: Record<string, any> = {};
      const warnMap: Record<string, string[]> = {};
      
      if (health?.records) {
        for (const record of health.records) {
          actMap[record.location.id] = record.activity;
          warnMap[record.location.id] = record.warnings;
        }
      }
      setActivityMap(actMap);
      setWarningsMap(warnMap);
    } catch (err) {
      console.error("Failed to load locations registry:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle click on location row
  const handleSelectLocation = async (loc: any) => {
    setSelectedLocation(loc);
    setActiveTab("info");
    setDrawerLoading(true);
    setActionError(null);
    setActionSuccess(null);
    setSyncCount(null);

    // Populate forms
    setEditBasicForm({
      name: loc.name || "",
      code: loc.code || "",
      status: loc.status || "active",
      type: loc.type || "branch",
      subtype: loc.subtype || "Store",
      purpose: loc.purpose || "store",
      isDeliveryDestination: loc.isDeliveryDestination !== false,
      isHq: !!loc.isHq,
      isInternal: !!loc.isInternal,
      notes: loc.notes || "",
      sortOrder: loc.sortOrder ?? "",
    });

    const bp = loc.billingProfile || {};
    setEditAddressForm({
      storeAddress: bp.storeAddress || "",
      storeCity: bp.storeCity || "",
      storeProvince: bp.storeProvince || "",
      storePostalCode: bp.storePostalCode || "",
      storePhone: bp.storePhone || "",
      storeManagerName: bp.storeManagerName || "",
    });

    setEditBillingForm({
      legalName: bp.legalName || "",
      incorporationAddress: bp.incorporationAddress || "",
      billingAddress: bp.billingAddress || "",
      billingCity: bp.billingCity || "",
      billingProvince: bp.billingProvince || "",
      billingPostalCode: bp.billingPostalCode || "",
      hstNumber: bp.hstNumber || "",
      businessNumber: bp.businessNumber || "",
      billingEmail: bp.billingEmail || "",
      invoiceContactName: bp.invoiceContactName || "",
    });

    try {
      const [users, activity] = await Promise.all([
        getLocationUsers(loc.id),
        getLocationActivityCounts(loc.id),
      ]);
      setDrawerUsers(users);
      setDrawerActivity(activity);
      
      const warnings = getLocationHealthStatus(loc, loc.billingProfile, activity);
      setDrawerWarnings(warnings);
    } catch (e) {
      console.error("Failed to load drawer details", e);
    } finally {
      setDrawerLoading(false);
    }
  };

  // Create new location
  const handleAddLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    setActionSuccess(null);

    if (!addForm.id.trim() || !addForm.name.trim()) {
      setActionError("Location ID and Name are required.");
      return;
    }

    const payload = {
      location: {
        id: addForm.id.trim().toUpperCase(),
        name: addForm.name.trim(),
        code: addForm.code.trim(),
        status: addForm.status,
        type: addForm.type,
        subtype: addForm.subtype,
        purpose: addForm.purpose,
        isDeliveryDestination: addForm.isDeliveryDestination,
        isHq: addForm.isHq,
        isInternal: addForm.isInternal,
        notes: addForm.notes,
      },
      billingProfile: {
        storeAddress: addForm.storeAddress.trim() || null,
        storeCity: addForm.storeCity.trim() || null,
        storeProvince: addForm.storeProvince.trim() || null,
        storePostalCode: addForm.storePostalCode.trim() || null,
        storePhone: addForm.storePhone.trim() || null,
        storeManagerName: addForm.storeManagerName.trim() || null,
      },
    };

    setActionLoading(true);
    try {
      const res = await createLocationWithProfile(payload);
      if (res.success) {
        setActionSuccess("Location and profile created successfully.");
        // Reset form
        setAddForm({
          id: "",
          name: "",
          code: "",
          status: "active",
          type: "branch",
          subtype: "Store",
          purpose: "store",
          isDeliveryDestination: true,
          isHq: false,
          isInternal: false,
          notes: "",
          storeAddress: "",
          storeCity: "",
          storeProvince: "",
          storePostalCode: "",
          storePhone: "",
          storeManagerName: "",
        });
        setIsAddDrawerOpen(false);
        await loadData();
      } else {
        setActionError(res.error?.message || "Failed to create location.");
      }
    } catch (err: any) {
      setActionError(err.message || "An unexpected error occurred.");
    } finally {
      setActionLoading(false);
    }
  };

  // Save changes — Basic Info
  const handleSaveBasic = async () => {
    if (!selectedLocation) return;
    setActionError(null);
    setActionSuccess(null);
    setActionLoading(true);

    const sortOrderVal = editBasicForm.sortOrder === "" ? null : Number(editBasicForm.sortOrder);

    const patch = {
      name: editBasicForm.name,
      code: editBasicForm.code,
      status: editBasicForm.status,
      type: editBasicForm.type,
      subtype: editBasicForm.subtype,
      purpose: editBasicForm.purpose,
      isDeliveryDestination: editBasicForm.isDeliveryDestination,
      isHq: editBasicForm.isHq,
      isInternal: editBasicForm.isInternal,
      notes: editBasicForm.notes,
      sortOrder: sortOrderVal,
    };

    try {
      const res = await updateLocationRegistryRecord(selectedLocation.id, patch);
      if (res.success) {
        setActionSuccess("Basic location details updated.");
        // Update local object representation
        const updatedLoc = {
          ...selectedLocation,
          ...patch,
        };
        setSelectedLocation(updatedLoc);
        
        // Refresh Warnings
        const newWarnings = getLocationHealthStatus(updatedLoc, updatedLoc.billingProfile, drawerActivity);
        setDrawerWarnings(newWarnings);

        await loadData();
      } else {
        setActionError(res.error?.message || "Failed to update record.");
      }
    } catch (err: any) {
      setActionError(err.message || "An unexpected error occurred.");
    } finally {
      setActionLoading(false);
    }
  };

  // Save changes — Physical Address
  const handleSaveAddress = async () => {
    if (!selectedLocation) return;
    setActionError(null);
    setActionSuccess(null);
    setActionLoading(true);

    try {
      const res = await updateLocationBillingProfile(selectedLocation.id, editAddressForm);
      if (res.success) {
        setActionSuccess("Physical address details updated.");
        const updatedLoc = {
          ...selectedLocation,
          billingProfile: {
            ...(selectedLocation.billingProfile || {}),
            ...editAddressForm,
          },
        };
        setSelectedLocation(updatedLoc);

        // Refresh Warnings
        const newWarnings = getLocationHealthStatus(updatedLoc, updatedLoc.billingProfile, drawerActivity);
        setDrawerWarnings(newWarnings);

        await loadData();
      } else {
        setActionError(res.error?.message || "Failed to update address.");
      }
    } catch (err: any) {
      setActionError(err.message || "An unexpected error occurred.");
    } finally {
      setActionLoading(false);
    }
  };

  // Save changes — Billing Info
  const handleSaveBilling = async () => {
    if (!selectedLocation) return;
    setActionError(null);
    setActionSuccess(null);
    setActionLoading(true);

    try {
      const res = await updateLocationBillingProfile(selectedLocation.id, editBillingForm);
      if (res.success) {
        setActionSuccess("Billing and legal details updated.");
        const updatedLoc = {
          ...selectedLocation,
          billingProfile: {
            ...(selectedLocation.billingProfile || {}),
            ...editBillingForm,
          },
        };
        setSelectedLocation(updatedLoc);

        // Refresh Warnings
        const newWarnings = getLocationHealthStatus(updatedLoc, updatedLoc.billingProfile, drawerActivity);
        setDrawerWarnings(newWarnings);

        await loadData();
      } else {
        setActionError(res.error?.message || "Failed to update billing info.");
      }
    } catch (err: any) {
      setActionError(err.message || "An unexpected error occurred.");
    } finally {
      setActionLoading(false);
    }
  };

  // Sync address to open tickets
  const handleSyncTickets = async () => {
    if (!selectedLocation) return;
    setActionError(null);
    setActionSuccess(null);
    setSyncCount(null);
    setActionLoading(true);

    try {
      const res = await syncLocationAddressToOpenTickets(selectedLocation.id);
      if (res.success) {
        setSyncCount(res.count);
        setActionSuccess(`Successfully updated ${res.count} active delivery ticket destination addresses.`);
        await loadData();
      } else {
        setActionError(res.error?.message || "Failed to sync address to open tickets.");
      }
    } catch (err: any) {
      setActionError(err.message || "An unexpected error occurred.");
    } finally {
      setActionLoading(false);
    }
  };

  // Filters logic
  const filteredLocations = locations.filter((loc) => {
    // Search filter
    const matchesSearch =
      loc.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      loc.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (loc.billingProfile?.storeManagerName || "")
        .toLowerCase()
        .includes(searchQuery.toLowerCase()) ||
      (loc.billingProfile?.storeAddress || "")
        .toLowerCase()
        .includes(searchQuery.toLowerCase());

    // Status filter
    const statusLower = (loc.status ?? "").toLowerCase();
    const isActive = statusLower === "active";
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && isActive) ||
      (statusFilter === "inactive" && !isActive);

    // Purpose filter
    const matchesPurpose =
      purposeFilter === "all" ||
      (purposeFilter === "store" && isStoreLocation(loc)) ||
      (purposeFilter === "hq" && isHqLocation(loc)) ||
      (purposeFilter === "warehouse" && isWarehouseLocation(loc)) ||
      (purposeFilter === "internal" && isInternalLocation(loc) && !isHqLocation(loc));

    return matchesSearch && matchesStatus && matchesPurpose;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Location Registry</h2>
          <p className="text-neutral-500 text-sm mt-0.5">
            Central directory and data health registry of operational units, warehouses, and corporate offices.
          </p>
        </div>
        <button
          onClick={() => setIsAddDrawerOpen(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition-colors shadow-sm self-start sm:self-auto"
        >
          <Plus className="h-4 w-4" /> Add Location
        </button>
      </div>

      {/* Summary Cards */}
      {healthSummary && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="shadow-sm border-neutral-200">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Total Locations</p>
                  <p className="text-2xl font-extrabold text-neutral-900">{healthSummary.totalLocations}</p>
                </div>
                <div className="p-3 bg-neutral-50 text-neutral-600 rounded-xl border border-neutral-100">
                  <Building className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm border-neutral-200">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Active Stores / Dest</p>
                  <p className="text-2xl font-extrabold text-brand-700">
                    {healthSummary.activeStores} <span className="text-sm font-normal text-neutral-400">/ {healthSummary.deliveryDestinations}</span>
                  </p>
                </div>
                <div className="p-3 bg-brand-50 text-brand-600 rounded-xl border border-brand-100">
                  <Truck className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm border-neutral-200">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Configuration Warnings</p>
                  <p className="text-2xl font-extrabold text-warning-600">
                    {healthSummary.missingAddress + healthSummary.missingBillingProfile + healthSummary.inactiveWithActivity}
                  </p>
                </div>
                <div className="p-3 bg-warning-50 text-warning-600 rounded-xl border border-warning-100">
                  <AlertTriangle className="h-5 w-5" />
                </div>
              </div>
              <div className="mt-2 text-[10px] text-neutral-500 flex gap-2">
                <span>{healthSummary.missingAddress} missing addr</span>
                <span>•</span>
                <span>{healthSummary.inactiveWithActivity} inactive w/ activity</span>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm border-neutral-200">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Tickets Missing Address</p>
                  <p className="text-2xl font-extrabold text-danger-600">
                    {healthSummary.deliveryTicketsMissingAddress}
                  </p>
                </div>
                <div className="p-3 bg-danger-50 text-danger-600 rounded-xl border border-danger-100">
                  <ShieldAlert className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Table & Filters */}
      <Card className="shadow-sm border-neutral-200">
        <CardContent className="p-0">
          {/* Controls Panel */}
          <div className="p-4 border-b border-neutral-100 bg-neutral-50/50 flex flex-col md:flex-row md:items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search location ID, name, manager, address..."
                className="w-full pl-9 pr-4 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
              />
            </div>
            
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-neutral-500 uppercase">Status</span>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="px-2.5 py-1.5 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="all">All</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-neutral-500 uppercase">Purpose</span>
                <select
                  value={purposeFilter}
                  onChange={(e) => setPurposeFilter(e.target.value)}
                  className="px-2.5 py-1.5 border border-neutral-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="all">All Purposes</option>
                  <option value="store">Store / Outlet</option>
                  <option value="hq">HQ / Start Address</option>
                  <option value="warehouse">Warehouse</option>
                  <option value="internal">Internal / Support</option>
                </select>
              </div>

              {(searchQuery !== "" || statusFilter !== "all" || purposeFilter !== "all") && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                    setStatusFilter("all");
                    setPurposeFilter("all");
                  }}
                  className="text-xs font-semibold text-brand-600 hover:text-brand-700 underline"
                >
                  Clear Filters
                </button>
              )}

              <button
                onClick={loadData}
                disabled={loading}
                className="p-2 border border-neutral-200 hover:bg-neutral-100 rounded-lg text-neutral-500 hover:text-neutral-700 transition-colors shrink-0 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Table View */}
          {loading ? (
            <div className="py-24 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-brand-500 mx-auto" />
              <p className="text-sm font-semibold text-neutral-500 mt-2">Loading Location Registry...</p>
            </div>
          ) : filteredLocations.length === 0 ? (
            <div className="py-16 text-center text-neutral-500">
              <p className="font-semibold text-base">No locations found</p>
              <p className="text-xs mt-1">Try adjusting your search criteria or filter tags.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-semibold w-[120px]">Location ID</TableHead>
                  <TableHead className="font-semibold">Name</TableHead>
                  <TableHead className="font-semibold">Status</TableHead>
                  <TableHead className="font-semibold">Purpose</TableHead>
                  <TableHead className="font-semibold">Roles / Flags</TableHead>
                  <TableHead className="font-semibold">Physical Address</TableHead>
                  <TableHead className="font-semibold text-right">Health Diagnostics</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLocations.map((loc) => {
                  const act = activityMap[loc.id] || {};
                  const warns = warningsMap[loc.id] || [];
                  const isAct = isActiveLocation(loc);
                  const isHq = isHqLocation(loc);
                  const isInternal = isInternalLocation(loc);
                  const isDest = isDeliveryDestinationLocation(loc);
                  const addressStr = buildFullLocationAddress(loc, loc.billingProfile);

                  return (
                    <TableRow
                      key={loc.id}
                      className="cursor-pointer hover:bg-neutral-50/50"
                      onClick={() => handleSelectLocation(loc)}
                    >
                      <TableCell className="font-semibold">
                        <Badge variant="neutral" className="bg-neutral-50 uppercase border-neutral-300 font-mono text-xs">
                          {loc.id}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-semibold text-neutral-800">
                        {loc.name}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={
                            isAct
                              ? "bg-success-50 text-success-700 border-success-200 hover:bg-success-50"
                              : "bg-neutral-100 text-neutral-500 border-neutral-200 hover:bg-neutral-100"
                          }
                        >
                          {isAct ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="neutral"
                          className={
                            isHq
                              ? "bg-purple-50 text-purple-700 border-purple-200"
                              : isWarehouseLocation(loc)
                              ? "bg-blue-50 text-blue-700 border-blue-200"
                              : "bg-teal-50 text-teal-700 border-teal-200"
                          }
                        >
                          {isHq
                            ? "HQ / Start"
                            : isWarehouseLocation(loc)
                            ? "Warehouse"
                            : isStoreLocation(loc)
                            ? "Store Outlet"
                            : "Support / Internal"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1.5 flex-wrap">
                          {isHq && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 border border-purple-200 uppercase">
                              HQ
                            </span>
                          )}
                          {isInternal && !isHq && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200 uppercase">
                              INTERNAL
                            </span>
                          )}
                          {isDest && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-brand-100 text-brand-800 border border-brand-200 uppercase">
                              ROUTABLE
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[240px] truncate text-xs text-neutral-600">
                        {addressStr ? (
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-neutral-400 shrink-0" />
                            {addressStr}
                          </span>
                        ) : (
                          <span className="text-danger-500 italic flex items-center gap-1 font-medium">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" /> No address config
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {warns.length > 0 ? (
                          <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-warning-50 text-warning-700 border border-warning-200 text-xs font-semibold">
                            <AlertTriangle className="h-3.5 w-3.5 text-warning-500 shrink-0" />
                            {warns.length} issues
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-success-50 text-success-700 border border-success-200 text-xs font-semibold">
                            <CheckCircle2 className="h-3.5 w-3.5 text-success-500 shrink-0" />
                            Healthy
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add Location Drawer */}
      <Drawer
        isOpen={isAddDrawerOpen}
        onClose={() => setIsAddDrawerOpen(false)}
        title="Add Operational Unit"
        description="Initialize a new operational registry profile and physical address routing profile."
        footer={
          <div className="flex items-center justify-between">
            <button
              onClick={() => setIsAddDrawerOpen(false)}
              className="px-4 py-2 border border-neutral-200 hover:bg-neutral-100 rounded-lg text-sm text-neutral-600 font-semibold"
            >
              Cancel
            </button>
            <button
              onClick={handleAddLocation}
              disabled={actionLoading}
              className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {actionLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Create Registry
            </button>
          </div>
        }
      >
        <form onSubmit={handleAddLocation} className="space-y-6">
          {actionError && (
            <div className="p-3 bg-danger-50 border border-danger-200 text-danger-700 rounded-lg text-xs font-semibold flex items-center gap-1.5">
              <XCircle className="h-4 w-4 shrink-0" />
              {actionError}
            </div>
          )}

          {/* Registry Base */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold uppercase tracking-wider text-brand-600 flex items-center gap-1.5 border-b border-neutral-100 pb-1.5">
              <Building2 className="h-3.5 w-3.5" /> Registry Identity
            </h4>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Location ID (Unique)</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. LOC-MALL"
                  value={addForm.id}
                  onChange={(e) => setAddForm({ ...addForm, id: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm uppercase placeholder:normal-case focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Internal Short Code</label>
                <input
                  type="text"
                  placeholder="e.g. MALL"
                  value={addForm.code}
                  onChange={(e) => setAddForm({ ...addForm, code: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Display Name</label>
              <input
                type="text"
                required
                placeholder="e.g. Stock Dharma Metrotown Store"
                value={addForm.name}
                onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Status</label>
                <select
                  value={addForm.status}
                  onChange={(e) => setAddForm({ ...addForm, status: e.target.value })}
                  className="w-full px-2 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Registry Purpose</label>
                <select
                  value={addForm.purpose}
                  onChange={(e) => setAddForm({ ...addForm, purpose: e.target.value })}
                  className="w-full px-2 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="store">Store / Outlet</option>
                  <option value="hq">HQ Office</option>
                  <option value="warehouse">Warehouse</option>
                  <option value="internal">Internal Support</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Subtype Tag</label>
                <select
                  value={addForm.subtype}
                  onChange={(e) => setAddForm({ ...addForm, subtype: e.target.value })}
                  className="w-full px-2 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="Store">Store</option>
                  <option value="Airport">Airport</option>
                  <option value="Mall">Mall</option>
                  <option value="Warehouse">Warehouse</option>
                  <option value="HQ">HQ</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2 py-1 bg-neutral-50 p-3 rounded-lg border border-neutral-200">
              <label className="flex items-center gap-2 text-xs font-semibold text-neutral-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={addForm.isDeliveryDestination}
                  onChange={(e) => setAddForm({ ...addForm, isDeliveryDestination: e.target.checked })}
                  className="h-4 w-4 text-brand-600 focus:ring-brand-500 border-neutral-300 rounded"
                />
                Is Delivery Destination
              </label>

              <label className="flex items-center gap-2 text-xs font-semibold text-neutral-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={addForm.isHq}
                  onChange={(e) => setAddForm({ ...addForm, isHq: e.target.checked })}
                  className="h-4 w-4 text-brand-600 focus:ring-brand-500 border-neutral-300 rounded"
                />
                Is HQ Start point
              </label>

              <label className="flex items-center gap-2 text-xs font-semibold text-neutral-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={addForm.isInternal}
                  onChange={(e) => setAddForm({ ...addForm, isInternal: e.target.checked })}
                  className="h-4 w-4 text-brand-600 focus:ring-brand-500 border-neutral-300 rounded"
                />
                Is Internal Only
              </label>
            </div>
          </div>

          {/* Physical Address Info */}
          <div className="space-y-4">
            <h4 className="text-xs font-bold uppercase tracking-wider text-brand-600 flex items-center gap-1.5 border-b border-neutral-100 pb-1.5">
              <MapPin className="h-3.5 w-3.5" /> Physical Location & Contact
            </h4>

            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Street Address</label>
              <input
                type="text"
                placeholder="e.g. 4500 Kingsway"
                value={addForm.storeAddress}
                onChange={(e) => setAddForm({ ...addForm, storeAddress: e.target.value })}
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">City</label>
                <input
                  type="text"
                  placeholder="e.g. Burnaby"
                  value={addForm.storeCity}
                  onChange={(e) => setAddForm({ ...addForm, storeCity: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Province</label>
                <input
                  type="text"
                  placeholder="e.g. BC"
                  value={addForm.storeProvince}
                  onChange={(e) => setAddForm({ ...addForm, storeProvince: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Postal Code</label>
                <input
                  type="text"
                  placeholder="e.g. V5H 2A9"
                  value={addForm.storePostalCode}
                  onChange={(e) => setAddForm({ ...addForm, storePostalCode: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Location Manager</label>
                <input
                  type="text"
                  placeholder="e.g. John Doe"
                  value={addForm.storeManagerName}
                  onChange={(e) => setAddForm({ ...addForm, storeManagerName: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Phone Contact</label>
                <input
                  type="text"
                  placeholder="e.g. +1 604-555-0199"
                  value={addForm.storePhone}
                  onChange={(e) => setAddForm({ ...addForm, storePhone: e.target.value })}
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Notes</label>
            <textarea
              rows={2}
              placeholder="Registry notes, access codes, or secondary tags..."
              value={addForm.notes}
              onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
              className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        </form>
      </Drawer>

      {/* Edit / View Details Drawer */}
      <Drawer
        isOpen={selectedLocation !== null}
        onClose={() => setSelectedLocation(null)}
        title={selectedLocation ? `Location Details: ${selectedLocation.id}` : ""}
        description={selectedLocation ? selectedLocation.name : ""}
        footer={
          <div className="flex justify-end gap-3 w-full">
            <button
              onClick={() => setSelectedLocation(null)}
              className="px-4 py-2 border border-neutral-200 hover:bg-neutral-100 rounded-lg text-sm text-neutral-600 font-semibold"
            >
              Close
            </button>
            {activeTab === "info" && (
              <button
                onClick={handleSaveBasic}
                disabled={actionLoading}
                className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {actionLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save Basic Info
              </button>
            )}
            {activeTab === "address" && (
              <button
                onClick={handleSaveAddress}
                disabled={actionLoading}
                className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {actionLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save Address
              </button>
            )}
            {activeTab === "billing" && (
              <button
                onClick={handleSaveBilling}
                disabled={actionLoading}
                className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                {actionLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save Billing Info
              </button>
            )}
          </div>
        }
      >
        {selectedLocation && (
          <div className="space-y-6">
            {/* Action Feedback alerts */}
            {actionError && (
              <div className="p-3 bg-danger-50 border border-danger-200 text-danger-700 rounded-lg text-xs font-semibold flex items-center gap-1.5">
                <XCircle className="h-4 w-4 shrink-0" />
                {actionError}
              </div>
            )}
            {actionSuccess && (
              <div className="p-3 bg-success-50 border border-success-200 text-success-700 rounded-lg text-xs font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                {actionSuccess}
              </div>
            )}

            {/* Tab Links */}
            <div className="flex border-b border-neutral-200 overflow-x-auto gap-2">
              <button
                onClick={() => setActiveTab("info")}
                className={`py-2 px-3 border-b-2 text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-all ${
                  activeTab === "info"
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-neutral-500 hover:text-neutral-800"
                }`}
              >
                Basic Info
              </button>
              <button
                onClick={() => setActiveTab("address")}
                className={`py-2 px-3 border-b-2 text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-all ${
                  activeTab === "address"
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-neutral-500 hover:text-neutral-800"
                }`}
              >
                Address
              </button>
              <button
                onClick={() => setActiveTab("billing")}
                className={`py-2 px-3 border-b-2 text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-all ${
                  activeTab === "billing"
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-neutral-500 hover:text-neutral-800"
                }`}
              >
                Billing Profile
              </button>
              <button
                onClick={() => setActiveTab("users")}
                className={`py-2 px-3 border-b-2 text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-1 ${
                  activeTab === "users"
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-neutral-500 hover:text-neutral-800"
                }`}
              >
                Users ({drawerUsers.length})
              </button>
              <button
                onClick={() => setActiveTab("delivery")}
                className={`py-2 px-3 border-b-2 text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-1 ${
                  activeTab === "delivery"
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-neutral-500 hover:text-neutral-800"
                }`}
              >
                Delivery/Routing
              </button>
              <button
                onClick={() => setActiveTab("health")}
                className={`py-2 px-3 border-b-2 text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-1 ${
                  activeTab === "health"
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-neutral-500 hover:text-neutral-800"
                } ${drawerWarnings.length > 0 ? "text-warning-600 font-black" : ""}`}
              >
                Health {drawerWarnings.length > 0 && `(${drawerWarnings.length})`}
              </button>
            </div>

            {/* Tab Contents */}
            {drawerLoading ? (
              <div className="py-16 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-brand-500 mx-auto" />
                <p className="text-xs font-medium text-neutral-500 mt-2">Loading location diagnostics...</p>
              </div>
            ) : (
              <div className="space-y-4">
                
                {/* 1. Basic Info Tab */}
                {activeTab === "info" && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Location ID (Read Only)</label>
                        <input
                          type="text"
                          disabled
                          value={selectedLocation.id}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-neutral-100 font-mono"
                        />
                      </div>
                      
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Short Code</label>
                        <input
                          type="text"
                          value={editBasicForm.code}
                          onChange={(e) => setEditBasicForm({ ...editBasicForm, code: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Display Name</label>
                      <input
                        type="text"
                        value={editBasicForm.name}
                        onChange={(e) => setEditBasicForm({ ...editBasicForm, name: e.target.value })}
                        className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Status</label>
                        <select
                          value={editBasicForm.status}
                          onChange={(e) => setEditBasicForm({ ...editBasicForm, status: e.target.value })}
                          className="w-full px-2 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        >
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Registry Purpose</label>
                        <select
                          value={editBasicForm.purpose}
                          onChange={(e) => setEditBasicForm({ ...editBasicForm, purpose: e.target.value })}
                          className="w-full px-2 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        >
                          <option value="store">Store / Outlet</option>
                          <option value="hq">HQ Office</option>
                          <option value="warehouse">Warehouse</option>
                          <option value="internal">Internal Support</option>
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Sort Order (Optional)</label>
                        <input
                          type="number"
                          placeholder="No order"
                          value={editBasicForm.sortOrder}
                          onChange={(e) => setEditBasicForm({ ...editBasicForm, sortOrder: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-x-6 gap-y-2 py-1 bg-neutral-50 p-3 rounded-lg border border-neutral-200">
                      <label className="flex items-center gap-2 text-xs font-semibold text-neutral-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editBasicForm.isDeliveryDestination}
                          onChange={(e) => setEditBasicForm({ ...editBasicForm, isDeliveryDestination: e.target.checked })}
                          className="h-4 w-4 text-brand-600 focus:ring-brand-500 border-neutral-300 rounded"
                        />
                        Is Delivery Destination
                      </label>

                      <label className="flex items-center gap-2 text-xs font-semibold text-neutral-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editBasicForm.isHq}
                          onChange={(e) => setEditBasicForm({ ...editBasicForm, isHq: e.target.checked })}
                          className="h-4 w-4 text-brand-600 focus:ring-brand-500 border-neutral-300 rounded"
                        />
                        Is HQ Start Address
                      </label>

                      <label className="flex items-center gap-2 text-xs font-semibold text-neutral-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editBasicForm.isInternal}
                          onChange={(e) => setEditBasicForm({ ...editBasicForm, isInternal: e.target.checked })}
                          className="h-4 w-4 text-brand-600 focus:ring-brand-500 border-neutral-300 rounded"
                        />
                        Is Internal Only
                      </label>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Internal Notes</label>
                      <textarea
                        rows={3}
                        value={editBasicForm.notes}
                        onChange={(e) => setEditBasicForm({ ...editBasicForm, notes: e.target.value })}
                        className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>
                  </div>
                )}

                {/* 2. Physical Address Tab */}
                {activeTab === "address" && (
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Store Street Address</label>
                      <input
                        type="text"
                        value={editAddressForm.storeAddress}
                        onChange={(e) => setEditAddressForm({ ...editAddressForm, storeAddress: e.target.value })}
                        className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">City</label>
                        <input
                          type="text"
                          value={editAddressForm.storeCity}
                          onChange={(e) => setEditAddressForm({ ...editAddressForm, storeCity: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Province</label>
                        <input
                          type="text"
                          value={editAddressForm.storeProvince}
                          onChange={(e) => setEditAddressForm({ ...editAddressForm, storeProvince: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Postal Code</label>
                        <input
                          type="text"
                          value={editAddressForm.storePostalCode}
                          onChange={(e) => setEditAddressForm({ ...editAddressForm, storePostalCode: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Store Manager</label>
                        <input
                          type="text"
                          value={editAddressForm.storeManagerName}
                          onChange={(e) => setEditAddressForm({ ...editAddressForm, storeManagerName: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Store Phone</label>
                        <input
                          type="text"
                          value={editAddressForm.storePhone}
                          onChange={(e) => setEditAddressForm({ ...editAddressForm, storePhone: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* 3. Billing Profile Tab */}
                {activeTab === "billing" && (
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Legal Entity Corporate Name</label>
                      <input
                        type="text"
                        value={editBillingForm.legalName}
                        onChange={(e) => setEditBillingForm({ ...editBillingForm, legalName: e.target.value })}
                        className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Incorporation Address</label>
                      <input
                        type="text"
                        value={editBillingForm.incorporationAddress}
                        onChange={(e) => setEditBillingForm({ ...editBillingForm, incorporationAddress: e.target.value })}
                        className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Billing Street Address</label>
                      <input
                        type="text"
                        value={editBillingForm.billingAddress}
                        onChange={(e) => setEditBillingForm({ ...editBillingForm, billingAddress: e.target.value })}
                        className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Billing City</label>
                        <input
                          type="text"
                          value={editBillingForm.billingCity}
                          onChange={(e) => setEditBillingForm({ ...editBillingForm, billingCity: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Billing Province</label>
                        <input
                          type="text"
                          value={editBillingForm.billingProvince}
                          onChange={(e) => setEditBillingForm({ ...editBillingForm, billingProvince: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Billing Postal Code</label>
                        <input
                          type="text"
                          value={editBillingForm.billingPostalCode}
                          onChange={(e) => setEditBillingForm({ ...editBillingForm, billingPostalCode: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">HST / GST Registry Number</label>
                        <input
                          type="text"
                          value={editBillingForm.hstNumber}
                          onChange={(e) => setEditBillingForm({ ...editBillingForm, hstNumber: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Corporate Business Number</label>
                        <input
                          type="text"
                          value={editBillingForm.businessNumber}
                          onChange={(e) => setEditBillingForm({ ...editBillingForm, businessNumber: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">AP / Billing Contact Email</label>
                        <input
                          type="email"
                          value={editBillingForm.billingEmail}
                          onChange={(e) => setEditBillingForm({ ...editBillingForm, billingEmail: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">Billing Invoice Contact Name</label>
                        <input
                          type="text"
                          value={editBillingForm.invoiceContactName}
                          onChange={(e) => setEditBillingForm({ ...editBillingForm, invoiceContactName: e.target.value })}
                          className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* 4. Users Tab */}
                {activeTab === "users" && (
                  <div className="space-y-4">
                    <h5 className="text-sm font-semibold text-neutral-800">Assigned Staff ({drawerUsers.length})</h5>
                    {drawerUsers.length === 0 ? (
                      <div className="p-8 border border-dashed border-neutral-200 rounded-xl text-center bg-neutral-50/50">
                        <Users className="h-6 w-6 text-neutral-400 mx-auto" />
                        <p className="text-xs font-semibold text-neutral-500 mt-1">No Staff Assigned</p>
                        <p className="text-[10px] text-neutral-400">Manage user profiles to link team members here.</p>
                      </div>
                    ) : (
                      <div className="border border-neutral-200 rounded-lg overflow-hidden bg-white">
                        <Table>
                          <TableHeader className="bg-neutral-50/50">
                            <TableRow>
                              <TableHead className="py-2.5 text-xs">Name</TableHead>
                              <TableHead className="py-2.5 text-xs">Email</TableHead>
                              <TableHead className="py-2.5 text-xs text-right">System Role</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {drawerUsers.map((u) => (
                              <TableRow key={u.id}>
                                <TableCell className="py-2.5 text-xs font-semibold text-neutral-700">{u.fullName || "—"}</TableCell>
                                <TableCell className="py-2.5 text-xs text-neutral-500">{u.email}</TableCell>
                                <TableCell className="py-2.5 text-xs text-right font-mono uppercase text-brand-600 font-semibold">{u.role}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                )}

                {/* 5. Delivery Tab */}
                {activeTab === "delivery" && (
                  <div className="space-y-6">
                    {/* Routing Stats */}
                    <div className="p-4 bg-neutral-50 border border-neutral-200 rounded-lg grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">Open Delivery Tickets</span>
                        <div className="text-xl font-bold text-neutral-800">
                          {drawerActivity?.openTicketsCount ?? 0}
                        </div>
                      </div>
                      
                      <div className="space-y-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">Open Requisitions</span>
                        <div className="text-xl font-bold text-neutral-800">
                          {drawerActivity?.openRequisitionsCount ?? 0}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h5 className="text-sm font-semibold text-neutral-800">Active Delivery Snapshot Actions</h5>
                      <p className="text-xs text-neutral-500 leading-relaxed">
                        To preserve historical snapshots, existing delivery tickets do not change their destination addresses automatically when location address profiles are updated. 
                        Use the sync tool below to update active, undelivered tickets for this location.
                      </p>

                      <button
                        onClick={handleSyncTickets}
                        disabled={actionLoading || !buildFullLocationAddress(selectedLocation, selectedLocation.billingProfile)}
                        className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 border border-brand-200 hover:border-brand-300 bg-brand-50 hover:bg-brand-100 text-brand-700 font-semibold rounded-lg text-sm transition-colors disabled:opacity-50"
                      >
                        {actionLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin text-brand-700" />
                        ) : (
                          <RefreshCw className="h-4 w-4 text-brand-700" />
                        )}
                        Sync & Update Address on Open Tickets
                      </button>

                      {!buildFullLocationAddress(selectedLocation, selectedLocation.billingProfile) && (
                        <p className="text-[10px] text-danger-600 font-semibold mt-1">
                          * Cannot sync address because physical store street address is not configured.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* 6. Health Diagnostics Tab */}
                {activeTab === "health" && (
                  <div className="space-y-4">
                    <h5 className="text-sm font-semibold text-neutral-800 flex items-center gap-1">
                      <Activity className="h-4 w-4 text-brand-600" /> Data Configuration Warnings
                    </h5>
                    
                    {drawerWarnings.length === 0 ? (
                      <div className="p-6 bg-success-50 border border-success-200 text-success-800 rounded-lg text-xs font-semibold flex items-start gap-2">
                        <CheckCircle2 className="h-4 w-4 text-success-600 shrink-0 mt-0.5" />
                        <div>
                          <p>Registry Record Healthy</p>
                          <p className="font-normal text-[10px] text-success-600 mt-0.5">
                            All physical address parameters, billing profiles, and delivery settings are configured properly.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {drawerWarnings.map((w, idx) => (
                          <div
                            key={idx}
                            className="p-3 bg-warning-50 border border-warning-200 text-warning-800 rounded-lg text-xs font-semibold flex items-center gap-2"
                          >
                            <AlertTriangle className="h-4 w-4 text-warning-500 shrink-0" />
                            {w}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="pt-2 border-t border-neutral-100">
                      <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">Health Diagnostic Rules</span>
                      <ul className="text-[10px] text-neutral-500 space-y-1 mt-1 list-disc pl-4">
                        <li>Location must have a street address to compute routing coordinates.</li>
                        <li>Location must have a complete City, Province, and Postal Code configuration.</li>
                        <li>Active locations of type "Store" should have billing profile record.</li>
                        <li>Active branch locations must be explicitly flagged as delivery destinations to accept tickets.</li>
                        <li>Locations marked inactive must not contain open requisitions or active delivery tickets.</li>
                      </ul>
                    </div>
                  </div>
                )}

              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
