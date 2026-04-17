"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import {
  Plus, Search, Mail, Edit, ShieldBan, MapPin, CheckCircle2, Loader2,
  KeyRound, Copy, RefreshCw, Eye, EyeOff, UserPlus, AlertCircle,
} from "lucide-react";
import {
  loadUserProfiles, updateUserProfile,
  loadLocations, insertLocation,
  setUserPassword, provisionUser,
} from "@/lib/storage";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";

// ── Role maps ─────────────────────────────────────────────────────────────────
// DB roles ↔ display labels
const DB_ROLE_MAP: Record<string, string> = {
  hq_admin:          "HQ Admin",
  location_manager:  "Location Manager",
  staff:             "Staff",
};
const DISPLAY_ROLE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(DB_ROLE_MAP).map(([k, v]) => [v, k])
);
const ROLES_LIST = Object.values(DB_ROLE_MAP); // display labels for <select>

export default function Users() {
  return (
    <HQOnlyGuard>
      <UsersPageContent />
    </HQOnlyGuard>
  );
}

function UsersPageContent() {
  const [profiles, setProfiles] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  // ── Provision drawer (new user) ───────────────────────────────────────────
  const [isProvDrawerOpen, setIsProvDrawerOpen]   = useState(false);
  const [provName, setProvName]                   = useState("");
  const [provEmail, setProvEmail]                 = useState("");
  const [provRole, setProvRole]                   = useState("Location Manager");
  const [provLocation, setProvLocation]           = useState("");
  const [provPwd, setProvPwd]                     = useState("");
  const [provPwdShow, setProvPwdShow]             = useState(false);
  const [provSaving, setProvSaving]               = useState(false);
  const [provError, setProvError]                 = useState<string | null>(null);
  const [provResult, setProvResult]               = useState<{
    action: string; generatedPassword?: string;
  } | null>(null);

  // ── Edit drawer (existing profile) ───────────────────────────────────────
  const [isEditOpen, setIsEditOpen]       = useState(false);
  const [editProfile, setEditProfile]     = useState<any | null>(null);
  const [editName, setEditName]           = useState("");
  const [editRole, setEditRole]           = useState("Location Manager");
  const [editLocation, setEditLocation]   = useState("");
  const [editActive, setEditActive]       = useState(true);
  const [editSaving, setEditSaving]       = useState(false);
  const [editError, setEditError]         = useState<string | null>(null);

  // ── Add Location inline (shared by both drawers) ─────────────────────────
  const [isAddLocOpen, setIsAddLocOpen]   = useState(false);
  const [newLocName, setNewLocName]       = useState("");
  const [newLocCode, setNewLocCode]       = useState("");
  const [newLocType, setNewLocType]       = useState("Store");
  const [newLocStatus, setNewLocStatus]   = useState("Active");
  const [locError, setLocError]           = useState("");
  const [locSaving, setLocSaving]         = useState(false);
  const [locSuccess, setLocSuccess]       = useState("");

  // ── Set Password modal ────────────────────────────────────────────────────
  const [pwdModal, setPwdModal]       = useState<{ id: string; name: string; email: string } | null>(null);
  const [pwdValue, setPwdValue]       = useState("");
  const [pwdShow, setPwdShow]         = useState(false);
  const [pwdSaving, setPwdSaving]     = useState(false);
  const [pwdError, setPwdError]       = useState<string | null>(null);
  const [pwdSuccess, setPwdSuccess]   = useState(false);
  const [pwdCopied, setPwdCopied]     = useState(false);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setIsLoading(true);
      try {
        const [profs, locs] = await Promise.all([loadUserProfiles(), loadLocations()]);
        setProfiles(Array.isArray(profs) ? profs : []);
        setLocations(Array.isArray(locs) ? locs : []);
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  if (isLoading) return (
    <div className="p-12 flex justify-center text-neutral-400 animate-pulse">
      Loading users…
    </div>
  );

  // ── Helpers ───────────────────────────────────────────────────────────────
  const resolveLocationName = (locId: string | null) => {
    if (!locId) return "—";
    const match = locations.find(l => l.id === locId || l.name === locId);
    return match ? match.name : locId;
  };

  const generateTempPassword = () => {
    const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
    return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  };

  const copyText = async (text: string, setCopied: (v: boolean) => void) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard unavailable */ }
  };

  // ── Filtered list ─────────────────────────────────────────────────────────
  const q = searchQuery.toLowerCase();
  const filtered = profiles.filter(p =>
    (p.fullName ?? "").toLowerCase().includes(q) ||
    (p.email    ?? "").toLowerCase().includes(q) ||
    (p.role     ?? "").toLowerCase().includes(q)
  );

  // ── Provision drawer ──────────────────────────────────────────────────────
  const openProvDrawer = () => {
    setProvName(""); setProvEmail(""); setProvRole("Location Manager");
    setProvLocation(""); setProvPwd(""); setProvPwdShow(false);
    setProvError(null); setProvResult(null);
    setIsProvDrawerOpen(true);
  };

  const handleProvision = async () => {
    if (!provEmail.trim()) { setProvError("Email is required."); return; }
    if (!provName.trim())  { setProvError("Full name is required."); return; }
    const dbRole = DISPLAY_ROLE_MAP[provRole] ?? "location_manager";
    if (dbRole === "location_manager" && !provLocation) {
      setProvError("Location is required for Location Manager role."); return;
    }
    setProvSaving(true); setProvError(null);
    const res = await provisionUser({
      email:      provEmail.trim(),
      fullName:   provName.trim(),
      role:       dbRole,
      locationId: provLocation || null,
      password:   provPwd.length >= 8 ? provPwd : undefined,
    });
    setProvSaving(false);
    if (!res.success) { setProvError(res.error ?? "Provisioning failed."); return; }
    setProvResult({ action: res.action ?? "created", generatedPassword: res.generatedPassword });
    // Refresh profile list
    const fresh = await loadUserProfiles();
    setProfiles(Array.isArray(fresh) ? fresh : []);
  };

  const closeProvDrawer = () => { setIsProvDrawerOpen(false); setProvResult(null); };

  // ── Edit drawer ───────────────────────────────────────────────────────────
  const openEditDrawer = (p: any) => {
    setEditProfile(p);
    setEditName(p.fullName ?? "");
    setEditRole(DB_ROLE_MAP[p.role] ?? "Location Manager");
    setEditLocation(p.locationId ?? "");
    setEditActive(p.isActive !== false);
    setEditError(null);
    setIsEditOpen(true);
  };

  const handleEditSave = async () => {
    if (!editProfile) return;
    const dbRole = DISPLAY_ROLE_MAP[editRole] ?? "location_manager";
    setEditSaving(true); setEditError(null);
    const res = await updateUserProfile(editProfile.id, {
      fullName:   editName.trim() || null,
      role:       dbRole,
      locationId: editLocation || null,
      isActive:   editActive,
    });
    setEditSaving(false);
    if (!res.success) { setEditError(res.error ?? "Update failed."); return; }
    // Optimistic update
    setProfiles(prev => prev.map(p =>
      p.id === editProfile.id
        ? { ...p, fullName: editName, role: dbRole, locationId: editLocation || null, isActive: editActive }
        : p
    ));
    setIsEditOpen(false);
  };

  const handleDisable = async (profile: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Disable ${profile.fullName ?? profile.email}? They will no longer be able to log in.`)) return;
    const res = await updateUserProfile(profile.id, { isActive: false });
    if (!res.success) { alert("Failed to disable user."); return; }
    setProfiles(prev => prev.map(p => p.id === profile.id ? { ...p, isActive: false } : p));
  };

  const handleEnable = async (profile: any, e: React.MouseEvent) => {
    e.stopPropagation();
    const res = await updateUserProfile(profile.id, { isActive: true });
    if (!res.success) { alert("Failed to enable user."); return; }
    setProfiles(prev => prev.map(p => p.id === profile.id ? { ...p, isActive: true } : p));
  };

  // ── Add Location ──────────────────────────────────────────────────────────
  const resetLocForm = () => {
    setNewLocName(""); setNewLocCode(""); setNewLocType("Store");
    setNewLocStatus("Active"); setLocError(""); setLocSuccess("");
  };

  const saveNewLocation = async () => {
    setLocError(""); setLocSuccess("");
    const cleanName = newLocName.trim();
    if (!cleanName) { setLocError("Location name is required."); return; }
    if (locations.some(l => l.name.toLowerCase() === cleanName.toLowerCase())) {
      setLocError(`"${cleanName}" already exists.`); return;
    }
    const idSlug      = cleanName.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    const canonicalId = `LOC-${idSlug}`.substring(0, 30);
    setLocSaving(true);
    const res = await insertLocation({ id: canonicalId, name: cleanName, code: newLocCode, type: newLocType, subtype: newLocType, status: newLocStatus });
    setLocSaving(false);
    if (!res.success) { setLocError(res.error ?? "Save failed."); return; }
    const created = res.location ?? { id: canonicalId, name: cleanName, type: newLocType, status: newLocStatus };
    setLocations(prev => [...prev, created]);
    setLocSuccess(cleanName);
    setTimeout(() => { setIsAddLocOpen(false); resetLocForm(); }, 1200);
  };

  // ── Set Password modal ────────────────────────────────────────────────────
  const openPwdModal = (profile: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setPwdModal({ id: profile.id, name: profile.fullName ?? profile.email, email: profile.email ?? "" });
    setPwdValue(""); setPwdShow(false); setPwdError(null); setPwdSuccess(false); setPwdCopied(false);
  };
  const closePwdModal = () => { setPwdModal(null); setPwdValue(""); setPwdError(null); setPwdSuccess(false); };

  const handleSetPassword = async () => {
    if (!pwdModal) return;
    if (!pwdValue.trim())   { setPwdError("Password cannot be empty."); return; }
    if (pwdValue.length < 6){ setPwdError("Password must be at least 6 characters."); return; }
    setPwdSaving(true); setPwdError(null);
    const res = await setUserPassword(pwdModal.email, pwdValue);
    setPwdSaving(false);
    if (!res.success) { setPwdError(res.error ?? "Failed."); return; }
    setPwdSuccess(true);
    setTimeout(closePwdModal, 1800);
  };

  // ── Role badge colour ─────────────────────────────────────────────────────
  const roleBadgeClass = (dbRole: string) => {
    if (dbRole === "hq_admin")         return "bg-brand-100 text-brand-800 border-brand-200";
    if (dbRole === "location_manager") return "bg-neutral-100 text-neutral-700 border-neutral-200";
    return "bg-warning-50 text-warning-700 border-warning-200";
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 relative h-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">User Control &amp; Access</h2>
          <p className="text-neutral-500 text-sm">Manage team members, roles, and location access.</p>
        </div>
        <button
          onClick={openProvDrawer}
          className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm w-full sm:w-auto"
        >
          <UserPlus className="h-4 w-4" />
          Provision User
        </button>
      </div>

      {/* Table */}
      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <div className="relative w-full sm:w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search name, email, role…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 pr-4 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 w-full"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/50">
              <TableRow>
                <TableHead className="pl-6">User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length > 0 ? filtered.map((profile) => (
                <TableRow key={profile.id} className="hover:bg-neutral-50/50">
                  <TableCell className="pl-6">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-full bg-brand-100 text-brand-800 border border-brand-200 flex items-center justify-center font-bold text-xs shrink-0">
                        {(profile.fullName ?? profile.email ?? "?").split(" ").map((n: string) => n[0]).join("").substring(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-semibold text-neutral-900 text-sm">{profile.fullName ?? "—"}</p>
                        <p className="text-xs text-neutral-500 flex items-center gap-1 mt-0.5">
                          <Mail className="h-3 w-3" />
                          {profile.email ?? "no email"}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${roleBadgeClass(profile.role)}`}>
                      {DB_ROLE_MAP[profile.role] ?? profile.role}
                    </span>
                  </TableCell>
                  <TableCell>
                    {profile.locationId ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-neutral-700 bg-neutral-100 border border-neutral-200 px-2 py-0.5 rounded">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {resolveLocationName(profile.locationId)}
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-400">All / HQ</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold border ${
                      profile.isActive
                        ? "bg-success-50 text-success-700 border-success-200"
                        : "bg-danger-50 text-danger-700 border-danger-200"
                    }`}>
                      {profile.isActive ? "Active" : "Disabled"}
                    </span>
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <div className="flex justify-end gap-1.5">
                      {/* 🔑 Set Password */}
                      <button
                        onClick={e => openPwdModal(profile, e)}
                        className="p-1.5 bg-white border border-neutral-200 text-neutral-500 hover:text-brand-600 hover:border-brand-300 rounded-md shadow-sm transition-colors"
                        title="Set Password"
                      >
                        <KeyRound className="h-4 w-4" />
                      </button>
                      {/* ✏️ Edit profile */}
                      <button
                        onClick={() => openEditDrawer(profile)}
                        className="p-1.5 bg-white border border-neutral-200 text-neutral-500 hover:text-brand-600 hover:border-brand-300 rounded-md shadow-sm transition-colors"
                        title="Edit Profile"
                      >
                        <Edit className="h-4 w-4" />
                      </button>
                      {/* Enable / Disable */}
                      {profile.isActive ? (
                        <button
                          onClick={e => handleDisable(profile, e)}
                          className="p-1.5 bg-white border border-neutral-200 text-neutral-500 hover:text-danger-600 hover:border-danger-300 hover:bg-danger-50 rounded-md shadow-sm transition-colors"
                          title="Disable User"
                        >
                          <ShieldBan className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          onClick={e => handleEnable(profile, e)}
                          className="p-1.5 bg-white border border-neutral-200 text-neutral-500 hover:text-success-600 hover:border-success-300 hover:bg-success-50 rounded-md shadow-sm transition-colors"
                          title="Enable User"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={5} className="py-12 text-center text-neutral-400 text-sm">
                    {searchQuery ? "No users match your search." : "No users provisioned yet. Click \"Provision User\" to add the first."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ═══════════════════════════════════════════════════════════════════════
          PROVISION NEW USER DRAWER
      ═══════════════════════════════════════════════════════════════════════ */}
      <Drawer
        isOpen={isProvDrawerOpen}
        onClose={closeProvDrawer}
        title="Provision New User"
        description="Creates or reconciles the Supabase auth account and profile row in one step."
        footer={
          !provResult ? (
            <div className="flex justify-between w-full">
              <button onClick={closeProvDrawer} className="px-4 py-2 text-sm font-medium bg-white text-neutral-700 border border-neutral-300 rounded-lg hover:bg-neutral-50 shadow-sm">
                Cancel
              </button>
              <button
                onClick={handleProvision}
                disabled={provSaving}
                className="px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm disabled:opacity-50 flex items-center gap-2"
              >
                {provSaving ? <><Loader2 className="h-4 w-4 animate-spin" /> Provisioning…</> : <><UserPlus className="h-4 w-4" /> Provision</>}
              </button>
            </div>
          ) : (
            <div className="w-full flex justify-end">
              <button onClick={closeProvDrawer} className="px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm">
                Done
              </button>
            </div>
          )
        }
      >
        <div className="space-y-5 py-4">
          {provResult ? (
            /* ── Success state ── */
            <ProvisionSuccess
              action={provResult.action}
              name={provName}
              email={provEmail}
              generatedPassword={provResult.generatedPassword}
            />
          ) : (
            /* ── Form ── */
            <>
              {/* Name + Email */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Full Name *</label>
                  <input
                    type="text"
                    value={provName}
                    onChange={e => { setProvName(e.target.value); setProvError(null); }}
                    placeholder="Jane Doe"
                    className="w-full p-2 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-neutral-50"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Email *</label>
                  <input
                    type="email"
                    value={provEmail}
                    onChange={e => { setProvEmail(e.target.value); setProvError(null); }}
                    placeholder="jane@example.com"
                    className="w-full p-2 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-neutral-50"
                  />
                </div>
              </div>

              {/* Role + Location */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Role *</label>
                  <select
                    value={provRole}
                    onChange={e => { setProvRole(e.target.value); setProvError(null); }}
                    className="w-full p-2 border border-neutral-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    {ROLES_LIST.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">
                    Location {provRole === "Location Manager" && <span className="text-danger-500">*</span>}
                  </label>
                  <select
                    value={provLocation}
                    onChange={e => { setProvLocation(e.target.value); setProvError(null); }}
                    className="w-full p-2 border border-neutral-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    <option value="">— None / HQ —</option>
                    {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
              </div>

              {/* Password */}
              <div className="space-y-1.5 border-t border-neutral-100 pt-4">
                <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">
                  Password <span className="text-neutral-400 font-normal">(optional — leave blank to auto-generate)</span>
                </label>
                <div className="relative">
                  <input
                    type={provPwdShow ? "text" : "password"}
                    value={provPwd}
                    onChange={e => setProvPwd(e.target.value)}
                    placeholder="Min 8 characters, or leave blank"
                    className="w-full pr-20 pl-3 py-2 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-neutral-50 font-mono"
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                    <button type="button" onClick={() => setProvPwd(generateTempPassword())} className="p-1 text-neutral-400 hover:text-brand-600" title="Generate">
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => setProvPwdShow(v => !v)} className="p-1 text-neutral-400 hover:text-neutral-700" title="Toggle visibility">
                      {provPwdShow ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                    {provPwd && (
                      <CopyButton text={provPwd} />
                    )}
                  </div>
                </div>
                <p className="text-[10px] text-neutral-400">
                  If left blank, a secure password is auto-generated and shown after provisioning.
                  Share it with the user — they can change it after login.
                </p>
              </div>

              {/* Inline Add Location */}
              <div className="border-t border-neutral-100 pt-3">
                <button
                  type="button"
                  onClick={() => setIsAddLocOpen(v => !v)}
                  className="text-xs text-brand-600 hover:text-brand-800 font-semibold flex items-center gap-1"
                >
                  <Plus className="h-3.5 w-3.5" /> Add new location
                </button>
                {isAddLocOpen && (
                  <AddLocationForm
                    name={newLocName} setName={n => { setNewLocName(n); setLocError(""); }}
                    code={newLocCode} setCode={c => { setNewLocCode(c); setLocError(""); }}
                    type={newLocType} setType={setNewLocType}
                    status={newLocStatus} setStatus={setNewLocStatus}
                    error={locError} success={locSuccess} saving={locSaving}
                    onSave={saveNewLocation}
                    onCancel={() => { setIsAddLocOpen(false); resetLocForm(); }}
                  />
                )}
              </div>

              {/* Error */}
              {provError && (
                <div className="flex items-start gap-2 p-3 bg-danger-50 border border-danger-200 rounded-lg">
                  <AlertCircle className="h-4 w-4 text-danger-600 mt-0.5 shrink-0" />
                  <p className="text-xs text-danger-700 font-medium">{provError}</p>
                </div>
              )}
            </>
          )}
        </div>
      </Drawer>

      {/* ═══════════════════════════════════════════════════════════════════════
          EDIT PROFILE DRAWER
      ═══════════════════════════════════════════════════════════════════════ */}
      <Drawer
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        title="Edit User Profile"
        description={editProfile ? `${editProfile.fullName ?? editProfile.email}` : ""}
        footer={
          <div className="flex justify-between w-full">
            <button onClick={() => setIsEditOpen(false)} className="px-4 py-2 text-sm font-medium bg-white text-neutral-700 border border-neutral-300 rounded-lg hover:bg-neutral-50 shadow-sm">
              Cancel
            </button>
            <button
              onClick={handleEditSave}
              disabled={editSaving}
              className="px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm disabled:opacity-50 flex items-center gap-2"
            >
              {editSaving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : "Save Changes"}
            </button>
          </div>
        }
      >
        <div className="space-y-5 py-4">
          {/* Full name */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Full Name</label>
            <input
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              className="w-full p-2 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-neutral-50"
            />
          </div>

          {/* Role + Location */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Role</label>
              <select
                value={editRole}
                onChange={e => setEditRole(e.target.value)}
                className="w-full p-2 border border-neutral-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {ROLES_LIST.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Location</label>
              <select
                value={editLocation}
                onChange={e => setEditLocation(e.target.value)}
                className="w-full p-2 border border-neutral-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="">— None / HQ —</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </div>

          {/* Active toggle */}
          <div className="flex items-center justify-between border border-neutral-200 rounded-lg px-4 py-3 bg-neutral-50">
            <div>
              <p className="text-sm font-semibold text-neutral-800">Account Active</p>
              <p className="text-xs text-neutral-500">Disabled users cannot log in.</p>
            </div>
            <button
              type="button"
              onClick={() => setEditActive(v => !v)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${editActive ? "bg-brand-600" : "bg-neutral-300"}`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${editActive ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>

          {editError && (
            <div className="flex items-start gap-2 p-3 bg-danger-50 border border-danger-200 rounded-lg">
              <AlertCircle className="h-4 w-4 text-danger-600 mt-0.5 shrink-0" />
              <p className="text-xs text-danger-700 font-medium">{editError}</p>
            </div>
          )}
        </div>
      </Drawer>

      {/* ═══════════════════════════════════════════════════════════════════════
          SET PASSWORD MODAL
      ═══════════════════════════════════════════════════════════════════════ */}
      {pwdModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closePwdModal} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="bg-gradient-to-r from-brand-600 to-brand-700 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-white/20 flex items-center justify-center">
                  <KeyRound className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h3 className="text-white font-bold text-base">Set Password</h3>
                  <p className="text-brand-100 text-xs">{pwdModal.name} · {pwdModal.email}</p>
                </div>
              </div>
            </div>
            <div className="px-6 py-5 space-y-4">
              {pwdSuccess ? (
                <div className="flex flex-col items-center gap-3 py-4">
                  <div className="h-12 w-12 rounded-full bg-success-100 flex items-center justify-center">
                    <CheckCircle2 className="h-6 w-6 text-success-600" />
                  </div>
                  <p className="text-success-700 font-semibold text-sm">Password updated!</p>
                  <p className="text-neutral-500 text-xs text-center">{pwdModal.name} can now log in with the new password.</p>
                </div>
              ) : (
                <>
                  <p className="text-neutral-500 text-sm">Set a new password directly — no email will be sent.</p>
                  <div>
                    <label className="block text-xs font-semibold text-neutral-600 uppercase tracking-wider mb-1.5">New Password</label>
                    <div className="relative">
                      <input
                        type={pwdShow ? "text" : "password"}
                        value={pwdValue}
                        onChange={e => { setPwdValue(e.target.value); setPwdError(null); }}
                        onKeyDown={e => e.key === "Enter" && handleSetPassword()}
                        placeholder="Minimum 6 characters"
                        autoFocus
                        className="w-full pr-20 pl-3 py-2.5 text-sm border border-neutral-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-400 bg-neutral-50 font-mono tracking-widest"
                      />
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                        <button type="button" onClick={() => { setPwdValue(generateTempPassword()); setPwdError(null); }} className="p-1 text-neutral-400 hover:text-brand-600" title="Generate">
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                        {pwdValue && <CopyButton text={pwdValue} />}
                        <button type="button" onClick={() => setPwdShow(v => !v)} className="p-1 text-neutral-400 hover:text-neutral-700">
                          {pwdShow ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                    {pwdError && <p className="mt-1.5 text-xs text-danger-600 font-medium">{pwdError}</p>}
                  </div>
                </>
              )}
            </div>
            {!pwdSuccess && (
              <div className="px-6 pb-5 flex justify-end gap-3">
                <button onClick={closePwdModal} disabled={pwdSaving} className="px-4 py-2 text-sm font-medium border border-neutral-300 rounded-lg bg-white hover:bg-neutral-50 text-neutral-700 disabled:opacity-50">Cancel</button>
                <button onClick={handleSetPassword} disabled={pwdSaving || !pwdValue.trim()} className="px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm disabled:opacity-50 flex items-center gap-2">
                  {pwdSaving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : <><KeyRound className="h-4 w-4" /> Set Password</>}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
      }}
      className="p-1 text-neutral-400 hover:text-brand-600"
      title="Copy"
    >
      {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-success-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function ProvisionSuccess({
  action, name, email, generatedPassword,
}: {
  action: string; name: string; email: string; generatedPassword?: string;
}) {
  const label = action === "created" ? "User Created" : action === "reconciled" ? "User Reconciled" : "User Updated";
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3 py-4">
        <div className="h-14 w-14 rounded-full bg-success-100 flex items-center justify-center">
          <CheckCircle2 className="h-7 w-7 text-success-600" />
        </div>
        <p className="text-success-700 font-bold text-base">{label}!</p>
        <p className="text-neutral-500 text-sm text-center">
          <span className="font-semibold text-neutral-800">{name}</span> ({email}) is ready to log in.
        </p>
      </div>

      {generatedPassword && (
        <div className="bg-neutral-900 rounded-xl p-4 space-y-2">
          <p className="text-xs text-neutral-400 font-semibold uppercase tracking-wider">Auto-generated Password</p>
          <div className="flex items-center justify-between gap-3">
            <code className="text-green-400 font-mono text-sm tracking-widest break-all">{generatedPassword}</code>
            <button
              onClick={async () => {
                try { await navigator.clipboard.writeText(generatedPassword); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
              }}
              className="shrink-0 p-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white transition-colors"
              title="Copy password"
            >
              {copied ? <CheckCircle2 className="h-4 w-4 text-success-400" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-[10px] text-neutral-500">Copy and share securely. This will not be shown again.</p>
        </div>
      )}
    </div>
  );
}

function AddLocationForm({
  name, setName, code, setCode, type, setType, status, setStatus,
  error, success, saving, onSave, onCancel,
}: any) {
  return (
    <div className="mt-3 bg-neutral-50 border border-neutral-200 rounded-lg p-3 space-y-3">
      <h4 className="text-xs font-bold text-neutral-800 uppercase tracking-wider">New Location</h4>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1 block">Name *</label>
          <input type="text" placeholder="e.g. Downtown" value={name} onChange={e => setName(e.target.value as string)}
            className="w-full p-1.5 text-xs border border-neutral-300 rounded focus:outline-none focus:ring-1 focus:ring-brand-500" />
        </div>
        <div>
          <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1 block">Code</label>
          <input type="text" placeholder="e.g. DT1" value={code} onChange={e => setCode(e.target.value as string)}
            className="w-full p-1.5 text-xs border border-neutral-300 rounded focus:outline-none focus:ring-1 focus:ring-brand-500" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1 block">Type</label>
          <select value={type} onChange={e => setType(e.target.value)} className="w-full p-1.5 text-xs border border-neutral-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-brand-500">
            {["HQ","Store","Airport","Mall","Other"].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1 block">Status</label>
          <select value={status} onChange={e => setStatus(e.target.value)} className="w-full p-1.5 text-xs border border-neutral-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-brand-500">
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>
        </div>
      </div>
      {success && (
        <div className="flex items-center gap-2 p-2 bg-success-50 border border-success-200 rounded-lg">
          <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />
          <p className="text-[11px] font-semibold text-success-700">"{success}" added successfully.</p>
        </div>
      )}
      {error && <p className="text-[10px] text-danger-600 font-bold">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} disabled={saving} className="text-xs px-2 py-1 rounded bg-white border shadow-sm hover:bg-neutral-50 disabled:opacity-50">Cancel</button>
        <button onClick={onSave} disabled={saving || !!success} className="text-xs px-3 py-1 rounded bg-brand-600 text-white shadow-sm hover:bg-brand-700 disabled:opacity-50 inline-flex items-center gap-1.5">
          {saving ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</> : success ? <><CheckCircle2 className="h-3 w-3" /> Saved</> : "Save Location"}
        </button>
      </div>
    </div>
  );
}
