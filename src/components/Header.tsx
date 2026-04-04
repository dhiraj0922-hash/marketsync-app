"use client";

import { usePathname } from "next/navigation";
import { Bell, Search, MapPin, ChevronDown } from "lucide-react";

const getPageTitle = (pathname: string) => {
  if (pathname === "/") return "Overview";
  const segment = pathname.split("/")[1];
  return segment ? segment.charAt(0).toUpperCase() + segment.slice(1) : "";
};

export function Header() {
  const pathname = usePathname();
  const title = getPageTitle(pathname);

  return (
    <header className="h-16 flex items-center justify-between px-6 lg:px-8 border-b border-neutral-200 bg-white sticky top-0 z-10 w-full shadow-sm">
      <div className="flex items-center gap-6">
        <h1 className="text-xl font-semibold text-neutral-800 tracking-tight">{title}</h1>
        
        <div className="h-6 w-px bg-neutral-200 hidden md:block"></div>
        
        <button className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-neutral-50 border border-transparent hover:border-neutral-200 transition-all text-sm font-medium text-neutral-700">
          <MapPin className="h-4 w-4 text-brand-600" />
          <span>All Locations (HQ View)</span>
          <ChevronDown className="h-4 w-4 text-neutral-400 ml-1" />
        </button>
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
        
        <button className="relative p-2 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-full transition-colors">
          <Bell className="h-5 w-5" />
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-danger-500 border-2 border-white"></span>
        </button>
      </div>
    </header>
  );
}

