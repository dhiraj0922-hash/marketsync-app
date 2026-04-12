"use client";

import { usePathname } from "next/navigation";
import { Bell, Search, MapPin, ChevronDown, LogOut, User } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { useState } from "react";

const getPageTitle = (pathname: string) => {
  if (pathname === "/") return "Overview";
  const segment = pathname.split("/")[1];
  return segment ? segment.charAt(0).toUpperCase() + segment.slice(1) : "";
};

export function Header() {
  const pathname = usePathname();
  const title = getPageTitle(pathname);
  const { user, signOut } = useAuth();
  const [profileOpen, setProfileOpen] = useState(false);

  // Normalise role string coming from either system_users ("Location Manager")
  // or user_profiles ("location_manager") so the header works regardless of source.
  const rawRole: string = user?.role ?? "";
  const isLocationManager =
    rawRole === "location_manager" ||
    rawRole.toLowerCase() === "location manager";

  // Location pill label: use assigned location if available, otherwise generic.
  const locationLabel: string =
    user?.locationId ||
    (Array.isArray(user?.assignedLocations) && user.assignedLocations[0] !== "All"
      ? user.assignedLocations[0]
      : null) ||
    "My Location";

  console.log("HEADER ROLE", rawRole, "| isLocationManager:", isLocationManager, "| locationId:", user?.locationId);

  return (
    <header className="h-16 flex items-center justify-between px-6 lg:px-8 border-b border-neutral-200 bg-white sticky top-0 z-10 w-full shadow-sm">
      <div className="flex items-center gap-6">
        <h1 className="text-xl font-semibold text-neutral-800 tracking-tight">{title}</h1>

        <div className="h-6 w-px bg-neutral-200 hidden md:block"></div>

        {/* ── Location selector — role-aware ─────────────────────────────── */}
        {isLocationManager ? (
          /* Location manager: read-only pill, no dropdown, no location switching */
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-md border border-neutral-200 bg-neutral-50 text-sm font-medium text-neutral-700 cursor-default select-none">
            <MapPin className="h-4 w-4 text-brand-600" />
            <span>{locationLabel}</span>
          </div>
        ) : (
          /* HQ admin: interactive dropdown with All Locations label */
          <button className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-neutral-50 border border-transparent hover:border-neutral-200 transition-all text-sm font-medium text-neutral-700">
            <MapPin className="h-4 w-4 text-brand-600" />
            <span>All Locations (HQ View)</span>
            <ChevronDown className="h-4 w-4 text-neutral-400 ml-1" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="relative hidden lg:block">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="h-4 w-4 text-neutral-400" />
          </div>
          <input
            type="text"
            placeholder="Search inventory, orders..."
            className="pl-9 pr-4 py-1.5 border border-neutral-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 bg-neutral-50 hover:bg-white transition-colors w-64 text-neutral-900"
          />
        </div>

        <button className="relative p-2 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-full transition-colors mr-2">
          <Bell className="h-5 w-5" />
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-danger-500 border-2 border-white"></span>
        </button>

        {/* Profile / Context Bound Menu */}
        <div className="relative">
          <button
            onClick={() => setProfileOpen(!profileOpen)}
            className="flex items-center gap-2 pl-2 pr-1 h-9 bg-neutral-50 hover:bg-neutral-100 border border-neutral-200 rounded-full transition-colors"
          >
            <div className="h-7 w-7 bg-brand-100 text-brand-700 flex items-center justify-center rounded-full text-xs font-bold shrink-0">
              {user?.name ? user.name.substring(0, 2).toUpperCase() : <User className="h-4 w-4" />}
            </div>
            <div className="hidden sm:flex flex-col items-start pr-1 max-w-[100px]">
              <span className="text-[11px] font-bold text-neutral-900 leading-tight truncate w-full">{user?.name || "System Base"}</span>
              <span className="text-[10px] font-medium text-brand-700 leading-none truncate w-full">{user?.role || "Pending..."}</span>
            </div>
            <ChevronDown className="h-4 w-4 text-neutral-400 shrink-0 mr-1" />
          </button>

          {profileOpen && (
            <div className="absolute right-0 mt-2 w-48 bg-white border border-neutral-200 rounded-lg shadow-lg overflow-hidden py-1 z-50">
              <div className="px-4 py-2 border-b border-neutral-100 mb-1">
                <p className="text-sm font-semibold text-neutral-900 truncate">{user?.email || "Unknown node"}</p>
                <p className="text-xs text-neutral-500 mt-0.5 truncate">Perm: {user?.role || "None"}</p>
              </div>
              <button
                onClick={signOut}
                className="w-full px-4 py-2 text-left text-sm text-danger-600 font-medium hover:bg-danger-50 transition-colors flex items-center gap-2"
              >
                <LogOut className="h-4 w-4" />
                Eject Session
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
