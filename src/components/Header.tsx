"use client";

import { usePathname } from "next/navigation";
import { Bell, Search, MapPin, ChevronDown, LogOut, User, Check, Menu } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { useState, useEffect, useRef } from "react";
import { isHqStaff } from "@/lib/roles";
import { useActiveLocation, type LocationOption } from "./LocationContext";
import { loadLocations } from "@/lib/storage";

const getPageTitle = (pathname: string) => {
  if (pathname === "/") return "Overview";
  const segment = pathname.split("/")[1];
  return segment ? segment.charAt(0).toUpperCase() + segment.slice(1) : "";
};

export function Header({ onMenuToggle }: { onMenuToggle?: () => void }) {
  const pathname = usePathname();
  const title = getPageTitle(pathname);
  const { user, signOut } = useAuth();
  const { activeLocation, setActiveLocation } = useActiveLocation();

  const [profileOpen, setProfileOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const locationBtnRef = useRef<HTMLDivElement>(null);

  const isHQ = isHqStaff(user);

  // Load location list once for HQ admins
  useEffect(() => {
    if (!isHQ) return;
    loadLocations().then((locs: any[]) => {
      const mapped: LocationOption[] = Array.isArray(locs)
        ? locs.map((l: any) => ({ id: l.id, name: l.name || l.id }))
        : [];
      console.log("[Header] loaded locations for dropdown:", mapped);
      setLocations(mapped);
    });
  }, [isHQ]);

  // Close location dropdown on outside click
  useEffect(() => {
    if (!locationOpen) return;
    const handler = (e: MouseEvent) => {
      if (locationBtnRef.current && !locationBtnRef.current.contains(e.target as Node)) {
        setLocationOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [locationOpen]);

  const locationLabel = isHQ
    ? (activeLocation ? activeLocation.name : "All Locations (HQ View)")
    : (user?.locationId || "My Location");

  console.log(
    "[Header] role=", user?.role,
    "| isHQ=", isHQ,
    "| activeLocation=", activeLocation,
    "| user.locationId=", user?.locationId
  );

  return (
    <header className="h-12 sm:h-16 flex items-center justify-between px-3 sm:px-6 lg:px-8 border-b border-neutral-200 bg-white sticky top-0 z-10 w-full shadow-sm">
      <div className="flex items-center gap-2 sm:gap-4">
        {/* Hamburger — mobile only */}
        <button
          onClick={onMenuToggle}
          className="md:hidden p-2 -ml-1 rounded-lg text-neutral-500 hover:text-neutral-800 hover:bg-neutral-100 transition-colors"
          aria-label="Open navigation"
        >
          <Menu className="h-5 w-5" />
        </button>

        <h1 className="text-base sm:text-xl font-semibold text-neutral-800 tracking-tight">{title}</h1>
        <div className="h-6 w-px bg-neutral-200 hidden md:block" />

        {/* ── Location selector ─────────────────────────────────────────── */}
        {!isHQ ? (
          /* Location manager: fixed read-only pill */
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-md border border-neutral-200 bg-neutral-50 text-sm font-medium text-neutral-700 cursor-default select-none">
            <MapPin className="h-4 w-4 text-brand-600" />
            <span>{locationLabel}</span>
          </div>
        ) : (
          /* HQ admin: functional dropdown */
          <div ref={locationBtnRef} className="relative hidden md:block">
            <button
              onClick={() => setLocationOpen((o) => !o)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition-all text-sm font-medium ${
                activeLocation
                  ? "border-brand-400 bg-brand-50 text-brand-700"
                  : "border-neutral-200 hover:bg-neutral-50 text-neutral-700 hover:border-neutral-300"
              }`}
            >
              <MapPin className={`h-4 w-4 ${activeLocation ? "text-brand-600" : "text-neutral-400"}`} />
              <span className="max-w-[160px] truncate">{locationLabel}</span>
              <ChevronDown className="h-4 w-4 text-neutral-400 ml-1 shrink-0" />
            </button>

            {locationOpen && (
              <div className="stockiq-location-menu absolute left-0 mt-2 w-64 overflow-hidden rounded-xl border border-zinc-800 bg-[#111111] shadow-2xl shadow-black/40 z-50">
                {/* All Locations (read-only) option */}
                <button
                  onClick={() => {
                    console.log("[Header] selected: All Locations (read-only mode)");
                    setActiveLocation(null);
                    setLocationOpen(false);
                  }}
                  className={`stockiq-location-menu-item w-full text-left px-4 py-3 text-sm flex items-center justify-between transition-colors ${
                    !activeLocation ? "bg-blue-600/20 font-semibold text-white" : "text-zinc-200 hover:bg-zinc-800/80 hover:text-white"
                  }`}
                >
                  <span>All Locations (HQ View)</span>
                  {!activeLocation && <Check className="h-3.5 w-3.5 text-blue-400" />}
                </button>

                {locations.length > 0 && (
                  <div className="border-t border-zinc-800">
                    <p className="stockiq-location-menu-label px-4 pt-2 pb-1 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                      Select Active Location
                    </p>
                    {locations.map((loc) => (
                      <button
                        key={loc.id}
                        onClick={() => {
                          console.log("[Header] selected location →", loc);
                          setActiveLocation(loc);
                          setLocationOpen(false);
                        }}
                        className={`stockiq-location-menu-item w-full text-left px-4 py-2.5 text-sm flex items-center justify-between transition-colors ${
                          activeLocation?.id === loc.id
                            ? "bg-blue-600/20 text-white font-semibold"
                            : "text-zinc-200 hover:bg-zinc-800/80 hover:text-white"
                        }`}
                      >
                        <span>{loc.name}</span>
                        {activeLocation?.id === loc.id && (
                          <Check className="h-3.5 w-3.5 text-blue-400" />
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {locations.length === 0 && (
                  <p className="border-t border-zinc-800 px-4 py-3 text-xs italic text-zinc-500">
                    No locations found in DB.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 sm:gap-3">
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

        <button className="relative p-1.5 sm:p-2 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-full transition-colors">
          <Bell className="h-5 w-5" />
          <span className="absolute top-1 right-1 sm:top-1.5 sm:right-1.5 h-2 w-2 rounded-full bg-danger-500 border-2 border-white" />
        </button>

        {/* Profile menu */}
        <div className="relative">
          <button
            onClick={() => setProfileOpen(!profileOpen)}
            className="flex items-center gap-2 pl-2 pr-1 h-8 sm:h-9 bg-neutral-50 hover:bg-neutral-100 border border-neutral-200 rounded-full transition-colors"
          >
            <div className="h-6 w-6 sm:h-7 sm:w-7 bg-brand-100 text-brand-700 flex items-center justify-center rounded-full text-xs font-bold shrink-0">
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
