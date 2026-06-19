"use client";

import Counts from "@/app/counts/page";
import { useAuth } from "@/components/AuthProvider";
import { isHqFulfillment, isHqMaster, isHqOps } from "@/lib/roles";

export default function InventoryCountPage() {
  const { user } = useAuth();
  
  const allowed = isHqMaster(user) || isHqOps(user) || isHqFulfillment(user);
  if (!allowed) {
    return (
      <div className="p-6 text-center text-sm font-semibold text-red-500">
        Unauthorized Access
      </div>
    );
  }

  return <Counts />;
}
