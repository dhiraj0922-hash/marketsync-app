"use client";

import React, { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

export function AppLayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  const [sidebarOpen, setSidebarOpen] = useState(false);

  return isLoginPage ? (
    <main className="w-full h-screen bg-neutral-50 flex items-center justify-center">
      {children}
    </main>
  ) : (
    <div className="flex bg-neutral-50 text-neutral-900 min-h-screen">
      {/* Sidebar: desktop = static column; mobile = drawer controlled by sidebarOpen */}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Pass the hamburger toggle to Header so it can render the ☰ button */}
        <Header onMenuToggle={() => setSidebarOpen((o) => !o)} />
        <main className="flex-1 p-3 sm:p-5 lg:p-8 min-w-0 overflow-x-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
