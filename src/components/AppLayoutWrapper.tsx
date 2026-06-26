"use client";

import React, { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

export function AppLayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";
  const isPrintPage =
    pathname?.startsWith("/deliveries/tickets/") && pathname.endsWith("/print") ||
    pathname?.startsWith("/deliveries/runs/") && pathname.endsWith("/print");

  const [sidebarOpen, setSidebarOpen] = useState(false);

  return isLoginPage ? (
    <main className="w-full h-screen bg-neutral-50 flex items-center justify-center">
      {children}
    </main>
  ) : isPrintPage ? (
    <main className="w-full min-h-screen bg-white">
      {children}
    </main>
  ) : (
    <div className="flex bg-neutral-50 text-neutral-900 min-h-screen h-screen overflow-hidden">
      {/* Sidebar: desktop = static column; mobile = drawer controlled by sidebarOpen */}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Pass the hamburger toggle to Header so it can render the ☰ button */}
        <Header onMenuToggle={() => setSidebarOpen((o) => !o)} />
        <main className="flex-1 p-4 sm:p-5 lg:px-8 lg:py-5 xl:px-10 min-w-0 overflow-x-hidden overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
