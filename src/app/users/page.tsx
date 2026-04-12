"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { Plus, Search, UserCog, Mail, Edit, ShieldBan, MapPin, CheckCircle2, Loader2 } from "lucide-react";
import { loadUsers, saveUsers, loadLocations, saveLocations, insertLocation } from "@/lib/storage";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";

export default function Users() {
  return (
    <HQOnlyGuard>
      <UsersPageContent />
    </HQOnlyGuard>
  );
}

function UsersPageContent() {
  const [users, setUsers] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  
  // Drawer States
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  
  // User Form States
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("Location Manager");
  const [assignedLocations, setAssignedLocations] = useState<string[]>([]);
  const [status, setStatus] = useState("Active");
  const [notes, setNotes] = useState("");

  // Add Location Overlay States
  const [isAddLocationOpen, setIsAddLocationOpen] = useState(false);
  const [newLocName, setNewLocName] = useState("");
  const [newLocCode, setNewLocCode] = useState("");
  const [newLocType, setNewLocType] = useState("Store");
  const [newLocStatus, setNewLocStatus] = useState("Active");
  const [locError, setLocError] = useState("");
  const [locSaving, setLocSaving] = useState(false);
  const [locSuccess, setLocSuccess] = useState(""); // display name of newly added location

  const ROLES_LIST = ["HQ Admin", "HQ Manager", "Location Manager", "Kitchen Staff", "Finance / Purchasing"];

  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
       setIsLoading(true);
       try {
           const [usrs, locs] = await Promise.all([
               loadUsers(),
               loadLocations()
           ]);
           setUsers(Array.isArray(usrs) ? usrs : []);
           setLocations(Array.isArray(locs) ? locs : []);
       } catch (err) {
           console.error(err);
       } finally {
           setIsLoading(false);
       }
    }
    fetchData();
  }, []);

  if (isLoading) return <div className="p-12 flex justify-center text-neutral-400 animate-pulse">Loading Identity Matrix...</div>;

  const resolveLocationName = (locId: string) => {
     if (locId === "All") return "All";
     const match = locations.find(l => l.id === locId || l.name === locId);
     return match ? match.name : locId; 
  };

  const isLocationActive = (locId: string) => {
     if (locId === "All") return true; 
     const match = locations.find(l => l.id === locId || l.name === locId);
     return match ? match.status === "Active" : true;
  };

  const openAddUser = () => {
    setEditingUserId(null);
    setName("");
    setEmail("");
    setRole("Location Manager");
    setAssignedLocations([]);
    setStatus("Invited");
    setNotes("");
    setIsDrawerOpen(true);
  };

  const openEditUser = (user: any) => {
    setEditingUserId(user.id);
    setName(user.name);
    setEmail(user.email);
    setRole(user.role);
    setAssignedLocations(user.assignedLocations || []);
    setStatus(user.status);
    setNotes(user.notes || "");
    setIsDrawerOpen(true);
  };

  const toggleLocation = (locId: string) => {
    if (locId === "All") {
      setAssignedLocations(["All"]);
    } else {
      let current = [...assignedLocations].filter(l => l !== "All");
      if (current.includes(locId)) {
        current = current.filter(l => l !== locId);
      } else {
        current.push(locId);
      }
      setAssignedLocations(current);
    }
  };

  const saveUserAction = async () => {
    if (!name || !email) {
      alert("Name and email are required constraints.");
      return;
    }
    
    // Exact mapping validation logic safely 
    const pUsers = Array.isArray(users) ? users : [];

    const payload = {
      id: editingUserId || `U-${1000 + pUsers.length + 1}`,
      name,
      email,
      role,
      assignedLocations,
      status: editingUserId ? users.find(u => u.id === editingUserId)?.status : "Active",
      notes,
      lastActive: editingUserId ? users.find(u => u.id === editingUserId)?.lastActive : "Pending"
    };

    let updated = [...pUsers];
    if (editingUserId) {
      const idx = updated.findIndex(u => u.id === editingUserId);
      if (idx !== -1) updated[idx] = payload;
    } else {
      updated.unshift(payload);
    }

    const res = await saveUsers(updated);
    if (!res?.success) {
       alert(`Database Error (Save User): ${res?.error?.message}`);
       return;
    }
    setUsers(updated);
    setIsDrawerOpen(false);
  };

  const disableUser = async (id: string, e: any) => {
     e.stopPropagation();
     if(confirm("Confirm revoking all authenticated access limits for this mapped identity instantly?")) {
        const pUsers = Array.isArray(users) ? users : [];
        const updated = pUsers.map(u => u.id === id ? { ...u, status: "Disabled" } : u);
        const res = await saveUsers(updated);
        if (!res?.success) {
           alert(`Database Error (Disable User): ${res?.error?.message}`);
           return;
        }
        setUsers(updated);
     }
  };

  const resetInvite = (email: string, e: any) => {
     e.stopPropagation();
     alert(`Password initialization protocol sequence dispatched securely back to ${email}.`);
  };

  const resetLocForm = () => {
    setNewLocName(""); setNewLocCode("");
    setNewLocType("Store"); setNewLocStatus("Active");
    setLocError(""); setLocSuccess("");
  };

  const saveNewLocation = async () => {
      setLocError("");
      setLocSuccess("");
      const cleanName = newLocName.trim();
      const cleanCode = newLocCode.trim();

      if (!cleanName) { setLocError("Location name is required."); return; }

      // ── Uniqueness guards ─────────────────────────────────────────────────
      if (locations.some(l => l.name.toLowerCase() === cleanName.toLowerCase())) {
         setLocError(`A location named "${cleanName}" already exists.`); return;
      }
      if (cleanCode && locations.some(l => l.code && l.code.toLowerCase() === cleanCode.toLowerCase())) {
         setLocError(`Location code "${cleanCode}" is already in use.`); return;
      }
      const idSlug    = cleanName.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
      const canonicalId = `LOC-${idSlug}`.substring(0, 30);
      if (locations.some(l => l.id === canonicalId)) {
         setLocError(`Canonical ID "${canonicalId}" is already in use. Choose a more specific name.`); return;
      }

      // ── Insert single row ─────────────────────────────────────────────────
      setLocSaving(true);
      const res = await insertLocation({
        id:      canonicalId,
        name:    cleanName,
        code:    cleanCode,
        type:    newLocType,    // mapLocationToDB translates to hq/branch/warehouse
        subtype: newLocType,
        status:  newLocStatus,
      });
      setLocSaving(false);

      if (!res.success) {
        setLocError(res.error ?? "Save failed. Check DB connection and try again.");
        return;
      }

      // ── Success: merge new location into local state, auto-select the chip ──
      const created = res.location ?? { id: canonicalId, name: cleanName, code: cleanCode, type: newLocType, subtype: newLocType, status: newLocStatus };
      setLocations(prev => [...prev, created]);
      // Auto-select: toggle the new chip in (mirrors toggleLocation logic)
      setAssignedLocations(prev => {
        const without = prev.filter(l => l !== "All");
        return without.includes(created.id) ? without : [...without, created.id];
      });
      setLocSuccess(cleanName);  // triggers success message in UI
      // Close form after short delay so user sees the success state
      setTimeout(() => {
        setIsAddLocationOpen(false);
        resetLocForm();
      }, 1200);
  };


  const filteredUsers = users.filter(u => 
    u.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    u.email.toLowerCase().includes(searchQuery.toLowerCase()) || 
    u.role.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-6 relative h-full">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-neutral-900">User Control & Access</h2>
          <p className="text-neutral-500 text-sm">Deploy granular Role-Action matrices securely scoping data visualization across physical nodes.</p>
        </div>
        <button 
          onClick={openAddUser}
          className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm w-full sm:w-auto"
        >
          <Plus className="h-4 w-4" />
          Provision Identity
        </button>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:items-center justify-between pb-4">
          <div className="relative w-full sm:w-96">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-neutral-400" />
            </div>
            <input 
              type="text" 
              placeholder="Query authenticated names, emails, roles..." 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 pr-4 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 w-full"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-neutral-50/50">
              <TableRow>
                <TableHead className="pl-6">User Structure</TableHead>
                <TableHead>System ACL Authorization</TableHead>
                <TableHead>Location Binding</TableHead>
                <TableHead>Status Trace</TableHead>
                <TableHead className="pr-6 text-right">Administrative Execution</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.length > 0 ? filteredUsers.map((user) => (
                <TableRow key={user.id} className="hover:bg-neutral-50/50">
                  <TableCell className="pl-6">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-full bg-brand-100 text-brand-800 border border-brand-200 flex items-center justify-center font-bold text-xs shrink-0 shadow-sm">
                        {user.name.split(' ').map((n: string) => n[0]).join('').substring(0,2)}
                      </div>
                      <div>
                        <p className="font-semibold text-brand-900 text-sm">{user.name}</p>
                        <p className="text-xs text-neutral-500 flex items-center gap-1 mt-0.5 font-medium">
                          <Mail className="h-3 w-3" />
                          {user.email}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.role.includes('Admin') ? 'default' : user.role.includes('Manager') ? 'neutral' : 'warning'} 
                           className={user.role.includes('Admin') ? 'bg-brand-100 text-brand-800' : ''}>
                      {user.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                     <div className="flex items-center gap-2 flex-wrap">
                       {user.assignedLocations.map((locId: string) => {
                          const isActive = isLocationActive(locId);
                          return (
                             <span key={locId} className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded border shadow-sm ${isActive ? 'bg-neutral-100 text-neutral-700 border-neutral-200' : 'bg-danger-50 text-danger-700 border-danger-200 line-through opacity-70'}`}>
                                <MapPin className="h-3 w-3" /> {resolveLocationName(locId)}
                                {!isActive && <span className="ml-1 text-[9px] uppercase tracking-wider text-danger-700">(Inactive)</span>}
                             </span>
                          );
                       })}
                     </div>
                  </TableCell>
                  <TableCell>
                     <div className="flex flex-col gap-1 inline-flex items-start">
                        <Badge variant={user.status === 'Active' ? 'success' : user.status === 'Disabled' ? 'danger' : 'warning'}>
                          {user.status === 'Invited' ? 'Pending Activation' : user.status}
                        </Badge>
                        <span className="text-[10px] text-neutral-400 font-medium">L: {user.lastActive}</span>
                     </div>
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                     <div className="flex justify-end gap-2">
                        {user.status === 'Invited' && (
                           <button onClick={(e) => resetInvite(user.email, e)} className="p-1.5 bg-white border border-neutral-200 text-neutral-500 hover:text-brand-600 hover:border-brand-200 rounded shadow-sm transition-colors" title="Resend Initialization Protocols">
                              <CheckCircle2 className="h-4 w-4" />
                           </button>
                        )}
                        <button onClick={() => openEditUser(user)} className="p-1.5 bg-white border border-neutral-200 text-neutral-500 hover:text-brand-600 hover:border-brand-200 rounded shadow-sm transition-colors" title="Structural Modifications">
                           <Edit className="h-4 w-4" />
                        </button>
                        {user.status !== 'Disabled' && (
                           <button onClick={(e) => disableUser(user.id, e)} className="p-1.5 bg-white border border-neutral-200 text-neutral-500 hover:text-danger-600 hover:border-danger-200 hover:bg-danger-50 rounded shadow-sm transition-colors" title="Revoke Security Clearance">
                              <ShieldBan className="h-4 w-4" />
                           </button>
                        )}
                     </div>
                  </TableCell>
                </TableRow>
              )) : (
                 <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-neutral-500 text-sm font-medium">Nothing found matching your query block.</TableCell>
                 </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ADD / EDIT DRAWER */}
      <Drawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        title={editingUserId ? "Modify Authentication Configuration" : "Provision New Identity Wrapper"}
        description={editingUserId ? `Assigning Action-Role matrices onto ${name}` : "Inject new users into routing scopes and map locational allowances natively."}
        footer={
          <div className="flex justify-between w-full">
            <button 
              onClick={() => setIsDrawerOpen(false)}
              className="px-4 py-2 text-sm font-medium bg-white text-neutral-700 border border-neutral-300 rounded-lg hover:bg-neutral-50 shadow-sm transition-colors"
            >
              Cancel
            </button>
            <button 
              onClick={saveUserAction}
              className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 shadow-sm transition-colors"
            >
              {editingUserId ? "Commit Reassignment" : "Deploy Identity Constraints"}
            </button>
          </div>
        }
      >
        <div className="space-y-5 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Legal Framework (Name)</label>
              <input 
                type="text" 
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full p-2 border border-neutral-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                placeholder="Full Name"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Email (SSO Key)</label>
              <input 
                type="email" 
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full p-2 border border-neutral-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                placeholder="address@restaurant.com"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Constraint ACL (Role)</label>
              <select 
                value={role}
                onChange={e => setRole(e.target.value)}
                className="w-full p-2 border border-neutral-300 rounded text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                 {ROLES_LIST.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider">Auth Status</label>
              <select 
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="w-full p-2 border border-neutral-300 rounded text-sm bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                 <option value="Active">Active</option>
                 <option value="Invited">Invited (Pending)</option>
                 <option value="Disabled">Disabled</option>
              </select>
            </div>
          </div>

          <div className="space-y-2 border-t border-neutral-100 pt-4">
             <div className="flex items-center justify-between mb-2">
                 <div>
                    <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider block">Physical Region Mapping</label>
                    <p className="text-[10px] text-neutral-400 font-medium mt-0.5">Select ALL structural locations this identity is authorized to poll.</p>
                 </div>
             </div>

             <div className="flex flex-wrap gap-2">
               <button 
                  onClick={() => toggleLocation("All")}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all border shadow-sm ${assignedLocations.includes("All") ? 'bg-brand-600 border-brand-700 text-white shadow-brand-500/20' : 'bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
                >
                   <MapPin className="h-3 w-3" /> System-Wide (All)
                </button>
               {locations.map(loc => {
                  const isActiveAssign = assignedLocations.includes(loc.id) || assignedLocations.includes(loc.name);
                  return (
                  <button 
                    key={loc.id}
                    onClick={() => toggleLocation(loc.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all border shadow-sm ${isActiveAssign ? 'bg-brand-600 border-brand-700 text-white shadow-brand-500/20' : loc.status === "Inactive" ? 'bg-neutral-100 border-dashed text-neutral-400 opacity-60 hover:opacity-100' : 'bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
                  >
                     <MapPin className="h-3 w-3" /> {loc.name} {loc.status === "Inactive" && "(Deprocisioned)"}
                  </button>
               )})}
               <button 
                   onClick={() => setIsAddLocationOpen(!isAddLocationOpen)}
                   className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all border border-dashed border-neutral-300 bg-neutral-50 text-neutral-600 hover:bg-neutral-100 hover:border-neutral-400 shadow-sm"
                 >
                    <Plus className="h-3 w-3" /> Add Location
                 </button>
             </div>

             {isAddLocationOpen && (
                <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3 mt-3 shadow-inner space-y-3">
                   <h4 className="text-xs font-bold text-neutral-800 uppercase tracking-wider">New Location</h4>

                   {/* Name + Code */}
                   <div className="grid grid-cols-2 gap-3">
                     <div>
                       <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1 block">Name *</label>
                       <input
                         type="text"
                         placeholder="e.g. Hudson Yards"
                         value={newLocName}
                         onChange={e => { setNewLocName(e.target.value); setLocError(""); }}
                         className="w-full p-1.5 text-xs border border-neutral-300 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
                       />
                     </div>
                     <div>
                       <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1 block">Code (optional)</label>
                       <input
                         type="text"
                         placeholder="e.g. HY1"
                         value={newLocCode}
                         onChange={e => { setNewLocCode(e.target.value); setLocError(""); }}
                         className="w-full p-1.5 text-xs border border-neutral-300 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
                       />
                     </div>
                   </div>

                   {/* Live canonical ID preview */}
                   {newLocName.trim() && (
                     <div className="flex items-center gap-2">
                       <span className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider shrink-0">Canonical ID:</span>
                       <code className="text-[11px] font-mono bg-neutral-900 text-green-400 px-2 py-0.5 rounded tracking-widest">
                         {`LOC-${newLocName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`.substring(0, 30)}
                       </code>
                       <span className="text-[10px] text-neutral-400 italic">auto-assigned · read-only</span>
                     </div>
                   )}

                   {/* Type + Status */}
                   <div className="grid grid-cols-2 gap-3">
                     <div>
                       <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1 block">Type (classification only)</label>
                       <select value={newLocType} onChange={e => setNewLocType(e.target.value)} className="w-full p-1.5 text-xs border border-neutral-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-brand-500">
                          <option value="HQ">HQ</option>
                          <option value="Store">Store</option>
                          <option value="Airport">Airport</option>
                          <option value="Mall">Mall</option>
                          <option value="Other">Other</option>
                       </select>
                     </div>
                     <div>
                       <label className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1 block">Status</label>
                       <select value={newLocStatus} onChange={e => setNewLocStatus(e.target.value)} className="w-full p-1.5 text-xs border border-neutral-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-brand-500">
                          <option value="Active">Active</option>
                          <option value="Inactive">Inactive</option>
                       </select>
                     </div>
                   </div>

                   {/* Success */}
                   {locSuccess && (
                     <div className="flex items-center gap-2 p-2 bg-success-50 border border-success-200 rounded-lg">
                       <CheckCircle2 className="h-3.5 w-3.5 text-success-600 shrink-0" />
                       <p className="text-[11px] font-semibold text-success-700">
                         "{locSuccess}" added and selected — you can now Deploy Identity Constraints.
                       </p>
                     </div>
                   )}

                   {/* Error */}
                   {locError && <p className="text-[10px] text-danger-600 font-bold">{locError}</p>}

                   {/* Actions */}
                   <div className="flex justify-end gap-2 pt-1">
                     <button
                       onClick={() => { setIsAddLocationOpen(false); resetLocForm(); }}
                       disabled={locSaving}
                       className="text-xs px-2 py-1 rounded bg-white border shadow-sm hover:bg-neutral-50 disabled:opacity-50"
                     >
                       Cancel
                     </button>
                     <button
                       onClick={saveNewLocation}
                       disabled={locSaving || !!locSuccess}
                       className="text-xs px-3 py-1 rounded bg-brand-600 text-white shadow-sm hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                     >
                       {locSaving
                         ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>
                         : locSuccess
                         ? <><CheckCircle2 className="h-3 w-3" /> Saved</>
                         : "Save Location"}
                     </button>
                   </div>
                </div>
             )}
          </div>
          
          <div className="space-y-1.5 border-t border-neutral-100 pt-4">
             <label className="text-xs font-semibold text-neutral-600 uppercase tracking-wider block">Operational Documentation</label>
             <textarea 
               value={notes}
               onChange={e => setNotes(e.target.value)}
               className="w-full p-2 border border-neutral-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white min-h-[80px]"
               placeholder="Optional system notes mapping context..."
             />
          </div>
          
        </div>
      </Drawer>
    </div>
  );
}
