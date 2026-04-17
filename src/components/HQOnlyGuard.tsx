"use client";

/**
 * HQOnlyGuard
 *
 * Page-level route protection for HQ-admin-only pages.
 *
 * Behaviour:
 *   - While auth is loading: spinner.
 *   - profileError=true: shows a non-blocking warning banner but still renders
 *     children IF the last known role was hq_admin (prevents lock-out on cold-start).
 *   - isHqAdmin(): renders children normally.
 *   - Any other role: renders an access-denied screen (no redirect).
 *
 * Uses the central isHqAdmin() helper from roles.ts so role matching is
 * case-insensitive and consistent across the entire app.
 */

import { useAuth } from "@/components/AuthProvider";
import { isHqAdmin } from "@/lib/roles";
import { ShieldOff, ArrowLeft, AlertTriangle } from "lucide-react";
import Link from "next/link";

interface HQOnlyGuardProps {
  children: React.ReactNode;
}

export function HQOnlyGuard({ children }: HQOnlyGuardProps) {
  const { user, loading } = useAuth();

  // ── Still resolving session ────────────────────────────────────────────────
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

  // ── Profile fetch failed (DB cold-start / network error) ──────────────────
  // Show the banner ONLY when the profile query failed on the initial bootstrap
  // and has never successfully loaded (profileLoaded is falsy).
  // If profileLoaded=true was previously set (lastGoodUser restore path), the
  // role is still valid — suppress the banner, the user doesn't need to see it.
  const profileError   = (user as any)?.profileError  === true;
  const profileLoaded  = (user as any)?.profileLoaded === true;
  const neverLoaded    = profileError && !profileLoaded;

  if (neverLoaded && isHqAdmin(user)) {
    return (
      <>
        <div className="w-full bg-warning-50 border-b border-warning-200 px-6 py-2 flex items-center gap-2 text-warning-700 text-xs font-medium">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Profile failed to load on startup — using cached session.&nbsp;
          <button
            onClick={() => window.location.reload()}
            className="underline font-semibold hover:text-warning-800"
          >
            Retry
          </button>
        </div>
        {children}
      </>
    );
  }

  // ── Authorised ─────────────────────────────────────────────────────────────
  if (isHqAdmin(user)) {
    return <>{children}</>;
  }

  // ── Access denied ──────────────────────────────────────────────────────────
  const roleDisplay = user?.role ?? "unauthenticated";
  return (
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-5">
        <div className="flex justify-center">
          <div className="h-16 w-16 rounded-2xl bg-danger-50 flex items-center justify-center">
            <ShieldOff className="h-8 w-8 text-danger-500" />
          </div>
        </div>
        <div>
          <h1 className="text-xl font-bold text-neutral-900 mb-2">HQ Admin Access Only</h1>
          <p className="text-sm text-neutral-500 leading-relaxed">
            This section is restricted to HQ administrators. Your account
            ({roleDisplay}) does not have permission to view this page.
          </p>
          {(user as any)?.profileError && (
            <p className="text-xs text-warning-600 mt-2">
              Your profile failed to load — if you are an HQ admin, please&nbsp;
              <button onClick={() => window.location.reload()} className="underline font-semibold">
                retry
              </button>.
            </p>
          )}
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
