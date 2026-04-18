"use client";

/**
 * Sidebar — role-aware navigation
 *
 * Each nav item carries an optional `hqOnly` flag. Items flagged `hqOnly`
 * are filtered out for location_manager users — both from the rendered list
 * and from the DOM entirely (not just hidden with CSS so screen readers
 * and keyboard navigation don't encounter them).
 *
 * New roles / locations added via User Management automatically inherit
 * the correct nav set — no per-location or per-user configuration needed.
 *
 * HQ-only items:
 *   /users    — User Management (create users, assign locations)
 *   /settings — System Controls + User Management tab
 *   /reports  — Cross-location reporting (HQ analytics)
 *   /recipes  — Master recipe management (HQ controls recipe library)
 *
 * Shared items (both roles):
 *   Dashboard, Approvals, Inventory, Counts, Orders, Requisitions,
 *   Finished Goods, Suppliers
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/AuthProvider";

interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
  /** If true, only visible to hq_admin users */
  hqOnly?: boolean;
}

const navigation: NavItem[] = [
  { name: "Dashboard",     href: "/",              icon: LayoutDashboard },
  { name: "Approvals",     href: "/approvals",     icon: CheckSquare },
  { name: "Inventory",     href: "/inventory",     icon: Package },
  { name: "Counts",        href: "/counts",        icon: ClipboardList },
  { name: "Orders",        href: "/orders",        icon: ShoppingCart },
  { name: "Requisitions",  href: "/requisitions",  icon: Inbox },
  { name: "Suppliers",     href: "/suppliers",     icon: Truck },
  // ── HQ-only ─────────────────────────────────────────────────────────────────
  { name: "Finished Goods", href: "/hq-sale-items", icon: PackageCheck,   hqOnly: true },
  { name: "FG Count",       href: "/fg-count",      icon: ClipboardCheck, hqOnly: true },
  { name: "Production",    href: "/finished-goods", icon: Factory,        hqOnly: true },
  { name: "Recipes",       href: "/recipes",        icon: ChefHat,        hqOnly: true },
  { name: "Reports",       href: "/reports",        icon: BarChart4,      hqOnly: true },
  { name: "Users",         href: "/users",          icon: Users,          hqOnly: true },
  { name: "Settings",      href: "/settings",       icon: Settings,       hqOnly: true },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user } = useAuth();

  const isHQAdmin = user?.role === "hq_admin";

  // Filter navigation based on role.
  // location_manager sees only items without hqOnly flag.
  // hq_admin sees everything.
  const visibleNav = navigation.filter((item) => !item.hqOnly || isHQAdmin);

  // User pill — show real data from auth context
  const initials = user?.name
    ? user.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()
    : (isHQAdmin ? "HQ" : "LM");

  const roleLabel = isHQAdmin
    ? "HQ Admin"
    : user?.role === "location_manager"
      ? "Location Manager"
      : "Staff";

  return (
    <div className="flex flex-col w-64 bg-white border-r border-neutral-200 min-h-screen">
      {/* Logo */}
      <div className="flex items-center justify-center h-16 border-b border-neutral-200 px-6">
        <div className="flex items-center gap-2 font-bold text-xl text-neutral-900 w-full">
          <ChefHat className="h-6 w-6 text-brand-600" />
          <span>MarketSync</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
        {visibleNav.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "group flex items-center px-3 py-2.5 text-sm font-medium rounded-lg transition-colors",
                isActive
                  ? "bg-brand-50 text-brand-700"
                  : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
              )}
            >
              <item.icon
                className={cn(
                  "mr-3 flex-shrink-0 h-5 w-5 transition-colors",
                  isActive ? "text-brand-600" : "text-neutral-400 group-hover:text-neutral-600"
                )}
                aria-hidden="true"
              />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* User pill — real data from auth context */}
      <div className="p-4 border-t border-neutral-200">
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
}
