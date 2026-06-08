"use client";

import React, { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ServerCrash, ShieldAlert, Users, Plus, Pencil, X, Loader2, MapPin, CheckCircle2, XCircle, Copy, Check, KeyRound } from "lucide-react";
import {
  saveOrders,
  saveRequisitions,
  saveCounts,
  saveProductionPlans,
  saveProductionHistory,
  saveInventoryActivity,
  saveImportBatches,
  loadInventory,
  saveInventory,
  loadUserProfiles,
  updateUserProfile,
  inviteUser,
  createUserDirect,
  resetUserPassword,
  loadLocations,
  type UserProfileRow,
} from "@/lib/storage";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/components/AuthProvider";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";
import { isHqMaster } from "@/lib/roles";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type Tab = "system" | "users";
const ROLE_OPTIONS = ["hq_master", "hq_ops", "location_manager", "driver"] as const;

const ROLE_LABELS: Record<string, string> = {
  hq_master:        "HQ Master",
  hq_ops:           "HQ Operations",
  hq_admin:         "HQ Master (Legacy)",
  location_manager: "Location Manager",
  driver:           "Driver",
};

// ─────────────────────────────────────────────────────────────────────────────
// User drawer form state
// ─────────────────────────────────────────────────────────────────────────────
interface UserForm {
  email: string;
  fullName: string;
  phone: string;
  role: string;
  locationId: string;
  isActive: boolean;
}

const emptyForm = (): UserForm => ({
  email: "", fullName: "", phone: "", role: "location_manager", locationId: "", isActive: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  return (
    <HQOnlyGuard>
      <SettingsPageContent />
    </HQOnlyGuard>
  );
}

function SettingsPageContent() {
  const { user } = useAuth();
  const isHQAdmin = isHqMaster(user);

  // ── Tab state ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<Tab>("system");

  // ── System reset state ─────────────────────────────────────────────────────
  const [resetModalOpen, setResetModalOpen]   = useState(false);
  const [confirmText, setConfirmText]         = useState("");
  const [isResetting, setIsResetting]         = useState(false);
  const expectedPhrase = "RESET ALL DATA";
  const isValid = confirmText === expectedPhrase;

  // ── User management state ──────────────────────────────────────────────────
  const [profiles, setProfiles]               = useState<UserProfileRow[]>([]);
  const [locations, setLocations]             = useState<any[]>([]);
  const [usersLoading, setUsersLoading]       = useState(false);
  const [drawerOpen, setDrawerOpen]           = useState(false);
  const [editingProfile, setEditingProfile]   = useState<UserProfileRow | null>(null);
  const [form, setForm]                       = useState<UserForm>(emptyForm());
  const [formSaving, setFormSaving]           = useState(false);
  const [formError, setFormError]             = useState<string | null>(null);
  const [formSuccess, setFormSuccess]         = useState<string | null>(null);
  // null = not yet checked, true = service key present, false = missing
  const [inviteReady, setInviteReady]         = useState<boolean | null>(null);
  // "invite" = magic-link email | "direct" = create with temp password (rate-limit fallback)
  const [createMode, setCreateMode]           = useState<"invite" | "direct">("invite");
  const [tempPassword, setTempPassword]       = useState("");
  // Holds details shown in the one-time post-creation confirmation screen
  const [createdAccountInfo, setCreatedAccountInfo] = useState<{
    email: string; fullName: string; role: string; locationId: string | null; password: string;
  } | null>(null);
  const [copied, setCopied]                   = useState(false);
  // Map of userId → reset email state: undefined | 'sending' | 'sent' | 'error'
  const [resetSent, setResetSent]             = useState<Record<string, 'sending' | 'sent' | 'error'>>({});

  // ── Load user profiles + health-check when tab is opened (HQ only) ─────────
  useEffect(() => {
    if (activeTab === "users" && isHQAdmin) {
      setUsersLoading(true);
      Promise.all([
        loadUserProfiles(),
        loadLocations(),
        fetch("/api/users/invite").then(r => r.json()).catch(() => ({ ready: false })),
      ])
        .then(([profs, locs, health]) => {
          setProfiles(profs);
          setLocations(locs);
          setInviteReady((health as any).ready === true);
        })
        .finally(() => setUsersLoading(false));
    }
  }, [activeTab, isHQAdmin]);

  // ── Open create drawer ─────────────────────────────────────────────────────
  const openCreate = () => {
    setEditingProfile(null);
    setForm(emptyForm());
    setFormError(null);
    setFormSuccess(null);
    setCreateMode("invite");
    setTempPassword("");
    setCreatedAccountInfo(null);
    setCopied(false);
    setDrawerOpen(true);
  };

  // ── Open edit drawer ───────────────────────────────────────────────────────
  const openEdit = (profile: UserProfileRow) => {
    setEditingProfile(profile);
    setForm({
      email:      profile.email ?? "",
      fullName:   profile.fullName ?? "",
      phone:      profile.phone ?? "",
      role:       profile.role,
      locationId: profile.locationId ?? "",
      isActive:   profile.isActive,
    });
    setFormError(null);
    setFormSuccess(null);
    setCreatedAccountInfo(null);
    setCopied(false);
    setDrawerOpen(true);
  };

  // ── Form field helper ──────────────────────────────────────────────────────
  const setField = <K extends keyof UserForm>(k: K, v: UserForm[K]) =>
    setForm(prev => ({ ...prev, [k]: v }));

  // ── Save handler ───────────────────────────────────────────────────────────
  const handleSave = async () => {
    setFormError(null);
    setFormSuccess(null);

    if (!form.email && !editingProfile) {
      setFormError("Email is required to invite a new user.");
      return;
    }
    if (form.role === "location_manager" && !form.locationId) {
      setFormError("A location must be selected for Location Manager role.");
      return;
    }

    setFormSaving(true);

    if (editingProfile) {
      // ── Update existing profile ───────────────────────────────────────────
      const res = await updateUserProfile(editingProfile.id, {
        fullName:   form.fullName || null,
        phone:      form.phone || null,
        role:       form.role,
        locationId: form.locationId || null,
        isActive:   form.isActive,
      });
      if (!res.success) {
        setFormError(res.error ?? "Failed to update user.");
        setFormSaving(false);
        return;
      }
      setProfiles(prev => prev.map(p =>
        p.id === editingProfile.id
          ? { ...p, fullName: form.fullName || null, phone: form.phone || null, role: form.role, locationId: form.locationId || null, isActive: form.isActive }
          : p
      ));
      setFormSuccess("User updated successfully.");
    } else if (createMode === "direct") {
      // ── Fallback: create with temp password (no email) ────────────────────
      if (!tempPassword || tempPassword.length < 8) {
        setFormError("Temporary password must be at least 8 characters.");
        setFormSaving(false);
        return;
      }
      const res = await createUserDirect({
        email:      form.email,
        password:   tempPassword,
        fullName:   form.fullName,
        role:       form.role,
        locationId: form.locationId || null,
        phone:      form.phone || null,
      });
      if (!res.success) {
        setFormError(res.error ?? "Failed to create user.");
        setFormSaving(false);
        return;
      }
      // Show one-time confirmation — do NOT auto-close, do NOT re-use tempPassword anywhere
      const refreshed = await loadUserProfiles();
      setProfiles(refreshed);
      setFormSaving(false);
      setCreatedAccountInfo({
        email:      form.email,
        fullName:   form.fullName || "—",
        role:       form.role,
        locationId: form.locationId || null,
        password:   tempPassword,
      });
      setTempPassword(""); // clear from state immediately after capture
      return;             // skip the auto-close timeout below
    } else {
      // ── Normal: send magic-link invite ────────────────────────────────────
      const res = await inviteUser({
        email:      form.email,
        fullName:   form.fullName,
        role:       form.role,
        locationId: form.locationId || null,
        phone:      form.phone || null,
      });
      if (!res.success) {
        // Auto-surface the fallback if the error is rate-limit related
        const isRateLimit = res.error?.toLowerCase().includes("rate") ||
                            res.error?.toLowerCase().includes("limit") ||
                            res.error?.toLowerCase().includes("too many");
        if (isRateLimit) {
          setFormError(`Email rate limit hit. Switch to "Create Without Email" below to proceed.`);
          setCreateMode("direct");
        } else {
          setFormError(res.error ?? "Failed to invite user.");
        }
        setFormSaving(false);
        return;
      }
      setFormSuccess(`Invite sent to ${form.email}. They will receive a magic-link to set their password.`);
      const refreshed = await loadUserProfiles();
      setProfiles(refreshed);
    }

    setFormSaving(false);
    // Only auto-close for invite and edit flows (not for direct-create which shows confirmation)
    setTimeout(() => { setDrawerOpen(false); setFormSuccess(null); }, 1500);
  };

  // ── Reset password (HQ action) ────────────────────────────────────────────
  const handleResetPassword = async (profile: UserProfileRow) => {
    const email = profile.email;
    if (!email) return;
    setResetSent(prev => ({ ...prev, [profile.userId]: 'sending' }));
    const res = await resetUserPassword(email);
    setResetSent(prev => ({ ...prev, [profile.userId]: res.success ? 'sent' : 'error' }));
    // Auto-clear status label after 4 s
    setTimeout(() => setResetSent(prev => { const n = { ...prev }; delete n[profile.userId]; return n; }), 4000);
  };

  // ── Toggle active status ───────────────────────────────────────────────────
  const handleToggleActive = async (profile: UserProfileRow) => {
    const res = await updateUserProfile(profile.id, { isActive: !profile.isActive });
    if (res.success) {
      setProfiles(prev =>
        prev.map(p => p.id === profile.id ? { ...p, isActive: !p.isActive } : p)
      );
    }
  };

  // ── System reset ───────────────────────────────────────────────────────────
  const handleSystemReset = async () => {
    if (!isValid) return;
    setIsResetting(true);
    try {
      await Promise.all([
        supabase.from('orders').delete().neq('id', 'SYS-PLACEHOLDER'),
        supabase.from('requisitions').delete().neq('id', 'SYS-PLACEHOLDER'),
        supabase.from('counts').delete().neq('id', 'SYS-PLACEHOLDER'),
        supabase.from('production_plans').delete().neq('id', 'SYS-PLACEHOLDER'),
        supabase.from('production_history').delete().neq('id', 'SYS-PLACEHOLDER'),
        supabase.from('import_batches').delete().neq('id', 'SYS-PLACEHOLDER'),
        supabase.from('inventory_activity').delete().neq('id', 0),
      ]);
      const inventory = await loadInventory();
      await saveInventory(inventory.map((item: any) => ({ ...item, inStock: 0 })));
      window.location.href = "/";
    } catch (e) {
      console.error("Critical failure during reset routine:", e);
      alert("Failed to execute complete wipe sequence. Check console.");
      setIsResetting(false);
    }
  };

  // ── Location lookup helper ─────────────────────────────────────────────────
  const locationName = (id: string | null) => {
    if (!id) return "—";
    return locations.find(l => l.id === id)?.name ?? id;
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 max-w-5xl">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">Settings</h2>
          <p className="text-neutral-500 text-sm">Administrative controls and user management.</p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-neutral-200">
        {([["system", "System Controls"], ...(isHQAdmin ? [["users", "User Management"]] : [])] as [Tab, string][]).map(([tab, label]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {tab === "users" && <Users className="inline h-3.5 w-3.5 mr-1.5 -mt-0.5" />}
            {label}
          </button>
        ))}
      </div>

      {/* ── SYSTEM CONTROLS TAB ─────────────────────────────────────────────── */}
      {activeTab === "system" && (
        <div className="space-y-8">
          <Card className="shadow-sm border-neutral-200">
            <CardHeader>
              <CardTitle className="text-lg">General Settings</CardTitle>
              <CardDescription>Configure localization frameworks and system preferences.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-neutral-500 italic p-4 bg-neutral-50 rounded border border-dashed text-center">
                System configurations will map here structurally in the future...
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm border-danger-200 overflow-hidden">
            <CardHeader className="bg-danger-50/50 border-b border-danger-100">
              <CardTitle className="text-lg text-danger-800 flex items-center gap-2">
                <ShieldAlert className="h-5 w-5" /> Danger Zone
              </CardTitle>
              <CardDescription className="text-danger-600/80">
                Highly destructive administrative controls. Restricted to HQ System Owners natively.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6">
              <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4">
                <div>
                  <h4 className="font-bold text-neutral-900 text-sm">Purge Operational Framework</h4>
                  <p className="text-sm text-neutral-500 mt-1 max-w-xl">
                    Permanently wipes all active transactions (Counts, Requisitions, POs, Recipes, Alerts) whilst rigidly preserving master structure records.
                  </p>
                </div>
                <button
                  onClick={() => setResetModalOpen(true)}
                  className="shrink-0 px-4 py-2 bg-danger-600 hover:bg-danger-700 text-white text-sm font-bold rounded-lg shadow-sm transition-colors flex items-center gap-2"
                >
                  <ServerCrash className="h-4 w-4" /> System Reset
                </button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── USER MANAGEMENT TAB ─────────────────────────────────────────────── */}
      {activeTab === "users" && isHQAdmin && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-neutral-900">User Accounts</h3>
              <p className="text-xs text-neutral-500 mt-0.5">
                Invite and manage user roles and location access. New users receive a magic-link invite.
              </p>
            </div>
            <button
              onClick={openCreate}
              className="flex items-center gap-2 px-3 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 shadow-sm transition-colors"
            >
              <Plus className="h-3.5 w-3.5" /> Invite User
            </button>
          </div>

          <Card className="shadow-sm border-neutral-200">
            <CardContent className="p-0">
              {usersLoading ? (
                <div className="flex items-center justify-center py-12 text-neutral-400 gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading users…
                </div>
              ) : profiles.length === 0 ? (
                <div className="text-center py-12 text-sm text-neutral-400">
                  No user profiles found. Invite the first user above.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-neutral-50 border-b border-neutral-200">
                    <tr>
                      <th className="text-left text-xs font-medium text-neutral-500 uppercase tracking-wider px-6 py-3">Name / Email</th>
                      <th className="text-left text-xs font-medium text-neutral-500 uppercase tracking-wider px-4 py-3">Role</th>
                      <th className="text-left text-xs font-medium text-neutral-500 uppercase tracking-wider px-4 py-3">Location</th>
                      <th className="text-left text-xs font-medium text-neutral-500 uppercase tracking-wider px-4 py-3">Phone</th>
                      <th className="text-left text-xs font-medium text-neutral-500 uppercase tracking-wider px-4 py-3">Status</th>
                      <th className="text-right text-xs font-medium text-neutral-500 uppercase tracking-wider px-6 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {profiles.map(profile => (
                      <tr key={profile.id} className="hover:bg-neutral-50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="font-semibold text-neutral-900">{profile.fullName ?? "—"}</div>
                          <div className="text-xs text-neutral-500 mt-0.5">{profile.email ?? profile.userId}</div>
                        </td>
                        <td className="px-4 py-4">
                          <Badge
                            variant={profile.role === "hq_master" || profile.role === "hq_admin" ? "default" : profile.role === "location_manager" ? "neutral" : "warning"}
                            className="text-[10px] font-medium"
                          >
                            {ROLE_LABELS[profile.role] ?? profile.role}
                          </Badge>
                        </td>
                        <td className="px-4 py-4">
                          <span className="flex items-center gap-1 text-xs text-neutral-600">
                            {profile.locationId && <MapPin className="h-3 w-3 text-neutral-400 shrink-0" />}
                            {locationName(profile.locationId)}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-xs text-neutral-600">{profile.phone ?? "—"}</td>
                        <td className="px-4 py-4">
                          <button
                            onClick={() => handleToggleActive(profile)}
                            className="flex items-center gap-1 text-xs font-medium"
                            title="Click to toggle"
                          >
                            {profile.isActive
                              ? <><CheckCircle2 className="h-3.5 w-3.5 text-success-500" /><span className="text-success-600">Active</span></>
                              : <><XCircle     className="h-3.5 w-3.5 text-neutral-400" /><span className="text-neutral-400">Inactive</span></>
                            }
                          </button>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {/* Reset password */}
                            {profile.email && (
                              <button
                                onClick={() => handleResetPassword(profile)}
                                disabled={resetSent[profile.userId] === 'sending'}
                                title="Send password reset email"
                                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border shadow-sm transition-colors ${
                                  resetSent[profile.userId] === 'sent'
                                    ? 'bg-success-50 border-success-200 text-success-700'
                                    : resetSent[profile.userId] === 'error'
                                    ? 'bg-danger-50 border-danger-200 text-danger-600'
                                    : 'bg-white border-neutral-200 text-neutral-700 hover:bg-amber-50 hover:border-amber-200 hover:text-amber-700'
                                }`}
                              >
                                {resetSent[profile.userId] === 'sending' && <Loader2 className="h-3 w-3 animate-spin" />}
                                {resetSent[profile.userId] === 'sent'    && <Check   className="h-3 w-3" />}
                                {resetSent[profile.userId] === 'error'   && <XCircle className="h-3 w-3" />}
                                {!resetSent[profile.userId]              && <KeyRound className="h-3 w-3" />}
                                {
                                  resetSent[profile.userId] === 'sending' ? 'Sending…' :
                                  resetSent[profile.userId] === 'sent'    ? 'Email sent' :
                                  resetSent[profile.userId] === 'error'   ? 'Failed' :
                                  'Reset PW'
                                }
                              </button>
                            )}
                            {/* Edit */}
                            <button
                              onClick={() => openEdit(profile)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-neutral-200 text-neutral-700 rounded-md hover:bg-neutral-50 hover:border-brand-200 hover:text-brand-700 transition-colors shadow-sm"
                            >
                              <Pencil className="h-3 w-3" /> Edit
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {/* ── Service key notice — shown only when health-check fails ──── */}
          {inviteReady === false && (
            <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">Inviting users requires the Supabase service role key.</span>{" "}
                Add <code className="bg-amber-100 px-1 rounded font-mono">SUPABASE_SERVICE_ROLE_KEY=&lt;your-key&gt;</code> to{" "}
                <code className="bg-amber-100 px-1 rounded font-mono">.env.local</code> then restart the dev server.
                Find it at: Supabase Dashboard → Project Settings → API → service_role key.
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── User create / edit drawer ──────────────────────────────────────── */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm"
            onClick={() => { if (!createdAccountInfo) setDrawerOpen(false); }}
          />
          <div className="relative z-10 w-full max-w-md bg-white shadow-2xl flex flex-col h-full animate-in slide-in-from-right duration-200">
            {/* Drawer header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
              <div>
                <h3 className="text-base font-bold text-neutral-900">
                  {createdAccountInfo ? "Account Created" : editingProfile ? "Edit User" : "Add New User"}
                </h3>
                <p className="text-xs text-neutral-500 mt-0.5">
                  {createdAccountInfo
                    ? "Save the temporary password below — it will not be shown again."
                    : editingProfile
                    ? "Update role, location, or status."
                    : createMode === "invite"
                    ? "A magic-link invite email will be sent."
                    : "Account created immediately — share temp password manually."}
                </p>
              </div>
              {/* Only show close X when not on the confirmation screen */}
              {!createdAccountInfo && (
                <button onClick={() => setDrawerOpen(false)} className="p-1.5 hover:bg-neutral-100 rounded-md transition-colors">
                  <X className="h-4 w-4 text-neutral-500" />
                </button>
              )}
            </div>

            {/* Drawer body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">

              {/* ── One-time credential confirmation screen ────────────────── */}
              {createdAccountInfo ? (
                <div className="space-y-5">
                  {/* Success header */}
                  <div className="flex items-center gap-3 p-4 bg-success-50 border border-success-200 rounded-xl">
                    <div className="h-9 w-9 flex-shrink-0 rounded-full bg-success-100 flex items-center justify-center">
                      <CheckCircle2 className="h-5 w-5 text-success-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-success-800">Account created successfully</p>
                      <p className="text-xs text-success-600 mt-0.5">The user can log in immediately with the credentials below.</p>
                    </div>
                  </div>

                  {/* Warning banner */}
                  <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-300 rounded-lg">
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs font-semibold text-amber-800">
                      This is the only time this password will be shown. Copy it now before closing.
                    </p>
                  </div>

                  {/* Account details */}
                  <div className="space-y-3">
                    {([
                      { label: "Email",     value: createdAccountInfo.email },
                      { label: "Full Name", value: createdAccountInfo.fullName },
                      { label: "Role",      value: ROLE_LABELS[createdAccountInfo.role] ?? createdAccountInfo.role },
                      { label: "Location",  value: locationName(createdAccountInfo.locationId) },
                    ] as { label: string; value: string }[]).map(({ label, value }) => (
                      <div key={label} className="flex justify-between items-center py-2 border-b border-neutral-100">
                        <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">{label}</span>
                        <span className="text-sm text-neutral-800 font-medium">{value}</span>
                      </div>
                    ))}
                  </div>

                  {/* Temporary password — high-visibility copy block */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Temporary Password</label>
                    <div className="flex items-center gap-2 p-3 bg-neutral-900 rounded-xl">
                      <span className="flex-1 font-mono text-sm text-green-400 tracking-widest select-all">
                        {createdAccountInfo.password}
                      </span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(createdAccountInfo!.password);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                        className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white text-xs font-semibold rounded-lg transition-colors"
                      >
                        {copied
                          ? <><Check className="h-3.5 w-3.5 text-green-400" /> Copied!</>
                          : <><Copy className="h-3.5 w-3.5" /> Copy</>}
                      </button>
                    </div>
                    <p className="text-[10px] text-neutral-400">Select all (⌘A) to highlight · Ask the user to change this on first login.</p>
                  </div>
                </div>
              ) : (
                // ── Normal form ────────────────────────────────────────────────
                <>
              {/* Create mode toggle — new users only */}
              {!editingProfile && (
                <div className="flex rounded-lg border border-neutral-200 overflow-hidden text-xs font-semibold">
                  <button
                    onClick={() => { setCreateMode("invite"); setTempPassword(""); setFormError(null); }}
                    className={`flex-1 py-2 transition-colors ${
                      createMode === "invite"
                        ? "bg-brand-600 text-white"
                        : "bg-white text-neutral-500 hover:bg-neutral-50"
                    }`}
                  >
                    Send Invite Email
                  </button>
                  <button
                    onClick={() => { setCreateMode("direct"); setFormError(null); }}
                    className={`flex-1 py-2 transition-colors border-l border-neutral-200 ${
                      createMode === "direct"
                        ? "bg-indigo-600 text-white"
                        : "bg-white text-neutral-500 hover:bg-neutral-50"
                    }`}
                  >
                    Create Without Email
                  </button>
                </div>
              )}

              {/* Email */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">Email *</label>
                <input
                  type="email"
                  disabled={!!editingProfile}
                  value={form.email}
                  onChange={e => setField("email", e.target.value)}
                  placeholder="user@example.com"
                  className="w-full text-sm border border-neutral-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-neutral-50 disabled:text-neutral-400"
                />
                {editingProfile && <p className="text-[10px] text-neutral-400">Email cannot be changed after account creation.</p>}
              </div>

              {/* Temporary password — direct-create mode only */}
              {!editingProfile && createMode === "direct" && (
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">Temporary Password *</label>
                  <input
                    type="text"
                    value={tempPassword}
                    onChange={e => setTempPassword(e.target.value)}
                    placeholder="min. 8 characters — share this securely"
                    className="w-full text-sm border border-neutral-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                  />
                  <p className="text-[10px] text-neutral-400">The user can log in immediately with this password and should change it on first login.</p>
                </div>
              )}

              {/* Full name */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">Full Name</label>
                <input
                  type="text"
                  value={form.fullName}
                  onChange={e => setField("fullName", e.target.value)}
                  placeholder="Jane Smith"
                  className="w-full text-sm border border-neutral-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>

              {/* Phone */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">Phone</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={e => setField("phone", e.target.value)}
                  placeholder="+1 (555) 000-0000"
                  className="w-full text-sm border border-neutral-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>

              {/* Role */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">Role *</label>
                <select
                  value={form.role}
                  onChange={e => { setField("role", e.target.value); if (e.target.value === "hq_master" || e.target.value === "hq_ops" || e.target.value === "driver") setField("locationId", ""); }}
                  className="w-full text-sm border border-neutral-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                >
                  {ROLE_OPTIONS.map(r => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              </div>

              {/* Location — required for location_manager */}
              {form.role === "location_manager" && (
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                    Location {form.role === "location_manager" ? "*" : ""}
                  </label>
                  <select
                    value={form.locationId}
                    onChange={e => setField("locationId", e.target.value)}
                    className="w-full text-sm border border-neutral-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                  >
                    <option value="">— Select location —</option>
                    {locations.map(l => (
                      <option key={l.id} value={l.id}>{l.name} ({l.id})</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Status toggle (edit only) */}
              {editingProfile && (
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">Status</label>
                  <div className="flex gap-3">
                    {[true, false].map(v => (
                      <button
                        key={String(v)}
                        onClick={() => setField("isActive", v)}
                        className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                          form.isActive === v
                            ? v ? "bg-success-50 border-success-300 text-success-700" : "bg-neutral-100 border-neutral-300 text-neutral-600"
                            : "bg-white border-neutral-200 text-neutral-400 hover:border-neutral-300"
                        }`}
                      >
                        {v ? "Active" : "Inactive"}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Error / success */}
              {formError && (
                <div className="flex items-start gap-2 p-3 bg-danger-50 border border-danger-200 rounded-lg text-xs text-danger-700">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {formError}
                </div>
              )}
              {formSuccess && (
                <div className="flex items-start gap-2 p-3 bg-success-50 border border-success-200 rounded-lg text-xs text-success-700">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {formSuccess}
                </div>
              )}
                </>
              )}
            </div>

            {/* Drawer footer */}
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-neutral-100 bg-neutral-50">
              {createdAccountInfo ? (
                // Confirmation screen: only a Done button — no cancel
                <button
                  onClick={() => { setDrawerOpen(false); setCreatedAccountInfo(null); }}
                  className="w-full flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold bg-success-600 text-white rounded-lg hover:bg-success-700 shadow-sm transition-colors"
                >
                  <Check className="h-4 w-4" /> I have saved the password — Done
                </button>
              ) : (
                // Normal form footer
                <>
                  <button
                    onClick={() => setDrawerOpen(false)}
                    className="px-4 py-2 text-sm font-medium bg-white border border-neutral-200 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={formSaving}
                    className="flex items-center gap-2 px-5 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-60 shadow-sm transition-colors"
                  >
                    {formSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {editingProfile ? "Save Changes" : createMode === "direct" ? "Create Account" : "Send Invite"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── System reset confirmation modal ───────────────────────────────── */}
      {resetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="p-5 border-b border-neutral-100 bg-danger-50">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 flex-shrink-0 rounded-full bg-danger-100 text-danger-600 flex items-center justify-center">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-danger-900">Execute System Reset</h3>
                  <p className="text-xs text-danger-700 mt-0.5">This action operates irreversibly.</p>
                </div>
              </div>
            </div>
            <div className="p-5 space-y-4">
              <ul className="text-sm text-neutral-600 space-y-2 list-disc pl-4 bg-neutral-50 p-3 rounded-lg border border-neutral-100">
                <li><strong className="text-neutral-900">Removed Permanently:</strong> Orders, Approvals, Requisitions, Plans, Sessions, Batch Logs.</li>
                <li><strong className="text-neutral-900">Zeroed Instantly:</strong> All active Inventory / Finished Good Stock.</li>
                <li><strong className="text-brand-700">Preserved:</strong> Location mapping, Role bounds, Recipes, Supplier Matrix, Structural Item Definitions.</li>
              </ul>
              <div className="pt-2">
                <label className="block text-xs font-bold text-neutral-700 uppercase tracking-wider mb-2">
                  Type <span className="bg-neutral-100 text-danger-600 px-1 py-0.5 rounded font-mono">{expectedPhrase}</span> to confirm.
                </label>
                <input
                  type="text" autoFocus value={confirmText}
                  onChange={e => setConfirmText(e.target.value)}
                  className={`w-full font-mono text-sm p-2.5 border rounded-lg focus:outline-none focus:ring-2 transition-colors ${isValid ? "border-success-500 focus:ring-success-500 text-success-700" : "border-neutral-300 focus:ring-danger-500"}`}
                  placeholder={expectedPhrase}
                />
              </div>
            </div>
            <div className="p-4 bg-neutral-50 border-t border-neutral-100 flex justify-end gap-3">
              <button disabled={isResetting} onClick={() => { setResetModalOpen(false); setConfirmText(""); }}
                className="px-4 py-2 text-sm font-semibold text-neutral-600 hover:text-neutral-900 bg-white border border-neutral-200 rounded-lg shadow-sm transition-colors">
                Abort Command
              </button>
              <button disabled={!isValid || isResetting} onClick={handleSystemReset}
                className={`px-4 py-2 text-sm font-bold text-white rounded-lg shadow-sm transition-all flex items-center justify-center min-w-[140px] ${isValid ? "bg-danger-600 hover:bg-danger-700" : "bg-neutral-300 cursor-not-allowed"}`}>
                {isResetting ? "WIPING..." : "Verify & Destruct"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
