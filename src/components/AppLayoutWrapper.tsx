"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

export function AppLayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  return isLoginPage ? (
    <main className="w-full h-screen bg-neutral-50 flex items-center justify-center">
      {children}
    </main>
  ) : (
    <div className="flex bg-neutral-50 text-neutral-900 min-h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header />
        <main className="flex-1 p-2 sm:p-5 lg:p-8 min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
