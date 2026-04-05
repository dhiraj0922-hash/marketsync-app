"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  LayoutDashboard, 
  Package, 
  ClipboardList, 
  ShoppingCart, 
  Truck, 
  ChefHat, 
  BarChart4, 
  Users,
  Inbox,
  Factory,
  CheckSquare,
  Settings
} from "lucide-react";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Approvals", href: "/approvals", icon: CheckSquare },
  { name: "Inventory", href: "/inventory", icon: Package },
  { name: "Counts", href: "/counts", icon: ClipboardList },
  { name: "Orders", href: "/orders", icon: ShoppingCart },
  { name: "Requisitions", href: "/requisitions", icon: Inbox },
  { name: "Finished Goods", href: "/finished-goods", icon: Factory },
  { name: "Suppliers", href: "/suppliers", icon: Truck },
  { name: "Recipes", href: "/recipes", icon: ChefHat },
  { name: "Reports", href: "/reports", icon: BarChart4 },
  { name: "Users", href: "/users", icon: Users },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="flex flex-col w-64 bg-white border-r border-neutral-200 min-h-screen">
      <div className="flex items-center justify-center h-16 border-b border-neutral-200 px-6">
        <div className="flex items-center gap-2 font-bold text-xl text-neutral-900 w-full">
          <ChefHat className="h-6 w-6 text-brand-600" />
          <span>MarketSync</span>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
        {navigation.map((item) => {
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
      <div className="p-4 border-t border-neutral-200">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-bold text-sm">
            HQ
          </div>
          <div>
            <p className="text-sm font-medium text-neutral-900">Admin User</p>
            <p className="text-xs text-neutral-500">HQ Manager</p>
          </div>
        </div>
      </div>
    </div>
  );
}
