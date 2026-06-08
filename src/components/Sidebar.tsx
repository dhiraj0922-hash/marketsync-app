"use client";

/**
 * Sidebar — role-aware navigation
 *
 * On desktop (≥ md): permanent left sidebar, full labels visible.
 * On mobile (< md): hidden by default; controlled externally via `isOpen` + `onClose`.
 *   - Slide-in drawer from the left.
 *   - Backdrop overlay closes it on tap.
 *
 * HQ-only items are filtered from the DOM entirely for location_manager users.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Package,
  ClipboardList,
  ClipboardCheck,
  ShoppingCart,
  Truck,
  ChefHat,
  BarChart4,
  Users,
  Inbox,
  Factory,
  PackageCheck,
  CheckSquare,
  Settings,
  MapPin,
  Database,
  BookOpen,
  ReceiptText,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/AuthProvider";
import { canAccessPath, isDriver, isHqMaster, isHqOps, isLocationManager } from "@/lib/roles";

interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
  hqOnly?: boolean;
}

const navigation: NavItem[] = [
  { name: "Dashboard",        href: "/",               icon: LayoutDashboard },
  { name: "Approvals",        href: "/approvals",      icon: CheckSquare,    hqOnly: true },
  { name: "Inventory",        href: "/inventory",      icon: Package },
  { name: "Outlet Inventory", href: "/outlet-inventory", icon: MapPin },
  { name: "Menu Costing",     href: "/menu-costing",     icon: ChefHat },
  { name: "Location Catalog", href: "/location-catalog", icon: BookOpen, hqOnly: true },
  { name: "Counts",           href: "/counts",         icon: ClipboardList },
  { name: "Orders",           href: "/orders",         icon: ShoppingCart },
  { name: "Requisitions",     href: "/requisitions",   icon: Inbox },
  { name: "Deliveries",       href: "/deliveries",     icon: Truck },
  { name: "Suppliers",        href: "/suppliers",      icon: Truck },
  { name: "Finished Goods",   href: "/hq-sale-items",  icon: PackageCheck,   hqOnly: true },
  { name: "FG Count",         href: "/fg-count",       icon: ClipboardCheck, hqOnly: true },
  { name: "Production",       href: "/finished-goods", icon: Factory,        hqOnly: true },
  { name: "Invoices",         href: "/invoices",       icon: ReceiptText,    hqOnly: true },
  { name: "Recipes",          href: "/recipes",        icon: ChefHat,        hqOnly: true },
  { name: "Sales Entry",      href: "/location-sales", icon: ReceiptText },
  { name: "Reports",          href: "/reports",        icon: BarChart4 },
  { name: "Users",            href: "/users",          icon: Users,          hqOnly: true },
  { name: "Settings",         href: "/settings",       icon: Settings,       hqOnly: true },
];

interface SidebarProps {
  /** Mobile: whether the drawer is open */
  isOpen?: boolean;
  /** Mobile: called when the user closes the drawer */
  onClose?: () => void;
}

export function Sidebar({ isOpen = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { user } = useAuth();

  const isHQAdmin = isHqMaster(user);
  const driverMode = isDriver(user);
  const visibleNav = driverMode
    ? [{ name: "My Routes", href: "/deliveries", icon: Truck }]
    : navigation.filter((item) => canAccessPath(user, item.href));

  const initials = user?.name
    ? user.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()
    : (isHQAdmin ? "HQ" : driverMode ? "DR" : "LM");

  const roleLabel = isHQAdmin
    ? "HQ Master"
    : isHqOps(user)
      ? "HQ Operations"
    : isLocationManager(user)
      ? "Location Manager"
      : driverMode
        ? "Driver"
      : "Staff";

  const NavContent = (
    <div className="flex flex-col h-full w-64 bg-white border-r border-neutral-200">
      {/* Logo + close button (mobile only) */}
      <div className="flex items-center justify-between h-14 sm:h-16 border-b border-neutral-200 px-5">
        <div className="flex items-center gap-2 font-bold text-xl text-neutral-900">
          <ChefHat className="h-6 w-6 text-brand-600 shrink-0" />
          <span>STOCK DHARMA</span>
        </div>
        {/* Close button — mobile only */}
        <button
          onClick={onClose}
          className="md:hidden p-1.5 rounded-lg text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors"
          aria-label="Close navigation"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2.5 space-y-0.5">
        {visibleNav.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              title={item.name}
              onClick={onClose}      /* auto-close on mobile nav tap */
              className={cn(
                "group flex items-center px-3 py-2.5 text-sm font-medium rounded-lg transition-colors",
                isActive
                  ? "bg-brand-50 text-brand-700"
                  : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
              )}
            >
              <item.icon
                className={cn(
                  "flex-shrink-0 h-5 w-5 mr-3 transition-colors",
                  isActive ? "text-brand-600" : "text-neutral-400 group-hover:text-neutral-600"
                )}
                aria-hidden="true"
              />
              <span>{item.name}</span>
            </Link>
          );
        })}
      </nav>

      {/* User pill */}
      <div className="p-3 border-t border-neutral-200">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-bold text-sm shrink-0">
            {initials}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-900 truncate">
              {user?.name ?? "Loading…"}
            </p>
            <div className="flex items-center gap-1">
              <p className="text-xs text-neutral-500">{roleLabel}</p>
              {user?.locationId && (
                <span className="flex items-center gap-0.5 text-[10px] text-neutral-400 ml-1">
                  <MapPin className="h-2.5 w-2.5" />
                  {user.locationId}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* ── Desktop sidebar (md+): always visible, no overlay ─────────────── */}
      <div className="hidden md:flex md:flex-col md:shrink-0">
        {NavContent}
      </div>

      {/* ── Mobile drawer + backdrop ────────────────────────────────────────── */}
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 bg-black/40 z-40 transition-opacity md:hidden",
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col transition-transform duration-300 md:hidden",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {NavContent}
      </div>
    </>
  );
}
