"use client";

import { FgCountContent } from "@/app/fg-count/page";
import { HQOnlyGuard } from "@/components/HQOnlyGuard";

export default function FinishedGoodsCountPage() {
  return (
    <HQOnlyGuard allowFulfillment={true}>
      <FgCountContent />
    </HQOnlyGuard>
  );
}
