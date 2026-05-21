"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * Next.js App Router error boundary for /finished-goods.
 * Catches runtime crashes in the Production page and shows
 * a recoverable error screen instead of a blank white page.
 */
export default function FinishedGoodsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console so the dev can see the real stack trace
    console.error("[Production page error]", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50 text-red-500">
        <AlertTriangle className="h-8 w-8" />
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-bold text-neutral-900">
          Production page crashed
        </h2>
        <p className="max-w-md text-sm text-neutral-500">
          Something went wrong while loading the Production module. The error
          has been logged to the browser console.
        </p>
        {error?.message && (
          <pre className="mx-auto mt-3 max-w-lg rounded-lg bg-neutral-100 px-4 py-3 text-left text-xs font-mono text-red-700 whitespace-pre-wrap break-all">
            {error.message}
          </pre>
        )}
        {error?.digest && (
          <p className="text-[10px] text-neutral-400 font-mono">
            digest: {error.digest}
          </p>
        )}
      </div>

      <button
        onClick={reset}
        className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 transition-colors"
      >
        <RefreshCw className="h-4 w-4" />
        Reload Production
      </button>
    </div>
  );
}
