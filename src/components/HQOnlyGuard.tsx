"use client";

/**
 * HQOnlyGuard
 *
 * Page-level route protection for HQ-admin-only pages.
 *
 * Usage — wrap the entire page export:
 *
 *   export default function UsersPage() {
 *     return (
 *       <HQOnlyGuard>
 *         <ActualPageContent />
 *       </HQOnlyGuard>
 *     );
 *   }
 *
 * Behaviour:
 *   - While auth is loading: shows a neutral spinner (same style as AuthProvider).
 *   - hq_admin: renders children normally.
 *   - location_manager or unconfigured role: renders an access-denied screen.
 *     The user is NOT redirected — they stay on the URL so they can see the
 *     message, but no page content or data is rendered.
 *
 * Location-agnostic: the check reads from useAuth() which reads user_profiles.
 * Every future location_manager automatically inherits the block.
 */

import { useAuth } from "@/components/AuthProvider";
import { ShieldOff, ArrowLeft } from "lucide-react";
import Link from "next/link";

interface HQOnlyGuardProps {
  children: React.ReactNode;
}

export function HQOnlyGuard({ children }: HQOnlyGuardProps) {
  const { user, loading } = useAuth();

  // ── Still resolving session ──────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="animate-pulse flex flex-col items-center">
          <div className="h-8 w-8 rounded-full border-4 border-brand-500 border-t-transparent animate-spin mb-4" />
          <div className="text-neutral-500 text-sm font-medium">Validating access…</div>
        </div>
      </div>
    );
  }

  // ── Authorised ───────────────────────────────────────────────────────────
  if (user?.role === "hq_admin") {
    return <>{children}</>;
  }

  // ── Access denied — location_manager or unconfigured ────────────────────
  return (
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-5">
        <div className="flex justify-center">
          <div className="h-16 w-16 rounded-2xl bg-danger-50 flex items-center justify-center">
            <ShieldOff className="h-8 w-8 text-danger-500" />
          </div>
        </div>
        <div>
          <h1 className="text-xl font-bold text-neutral-900 mb-2">
            HQ Admin Access Only
          </h1>
          <p className="text-sm text-neutral-500 leading-relaxed">
            This section is restricted to HQ administrators. Your account
            ({user?.role ?? "unauthenticated"}) does not have permission to
            view this page.
          </p>
        </div>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
