"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import { canAccessPath, getAllowedHomePath, type AppUser } from "@/lib/roles";

type AuthContextType = {
  user: AppUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({ user: null, loading: true, signOut: async () => {} });

export const useAuth = () => useContext(AuthContext);

// ── Timeouts ─────────────────────────────────────────────────────────────────
/** Hard limit for the entire initial bootstrap (getSession + loadProfile) */
const BOOTSTRAP_TIMEOUT_MS = 12_000;
/** Per-fetch limit for the user_profiles query.
 *  15s — Supabase free tier can be slow on cold starts. */
const PROFILE_TIMEOUT_MS   = 15_000;
/**
 * How long to wait before treating a SIGNED_OUT event as real.
 * Supabase JS v2 can fire spurious SIGNED_OUT during a refresh-token
 * network hiccup. We verify via getSession() before acting on it.
 */
const SIGNED_OUT_VERIFY_DELAY_MS = 800;

function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`[AuthProvider] timeout: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e);  }
    );
  });
}

// ── Error types ───────────────────────────────────────────────────────────────
type BootstrapError = "timeout" | "profile_fetch_failed" | null;

// ── Dev diagnostic state (module-level, not React state so it never causes re-renders) ──
const _diag = {
  sessionPresent:    false,
  sessionExpiry:     null as string | null,
  lastAuthEvent:     "none",
  lastEventTime:     null as string | null,
  lastTokenRefresh:  null as string | null,
  lastProfileError:  null as string | null,
  redirectCount:     0,
};

function diagLog(label: string, extra?: Record<string, unknown>) {
  if (process.env.NODE_ENV !== "production") {
    console.log(`[AuthProvider] ${label}`, {
      ...extra,
      _diag: { ..._diag },
    });
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser]           = useState<AppUser | null>(null);
  const [loading, setLoading]     = useState(true);
  const [bootstrapError, setBootstrapError] = useState<BootstrapError>(null);
  const [mounted, setMounted]     = useState(false);
  const [hostname, setHostname]   = useState("");

  const router   = useRouter();
  const pathname = usePathname();

  // Prevents concurrent profile fetches (bootstrap + onAuthStateChange race)
  const bootstrapDone = useRef(false);
  const loadingRef    = useRef(true);
  // Retain the last successfully loaded user so a token-refresh profile
  // re-fetch failure doesn't wipe out a known-good role.
  const lastGoodUser  = useRef<AppUser | null>(null);
  // Tracks whether we issued a voluntary signOut (so we don't double-redirect)
  const voluntarySignOut = useRef(false);
  // Debounce handle for SIGNED_OUT verification
  const signedOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markLoadingFalse = () => {
    loadingRef.current = false;
    setLoading(false);
  };

  useEffect(() => {
    setMounted(true);
    setHostname(window.location.hostname);
  }, []);

  // ── Profile loader ────────────────────────────────────────────────────────
  /**
   * Fetches user_profiles for the given auth user.
   *
   * On success → sets user with profileLoaded=true, updates lastGoodUser ref.
   * On timeout/error → does NOT wipe user.role. Instead:
   *   - If lastGoodUser exists (e.g. token refresh path): restores it with profileError=true flag.
   *   - If no prior user (bootstrap path): sets user with role=null and profileError=true
   *     so the UI can show a retry instead of a wrong access-denied screen.
   */
  const loadProfile = async (authUser: { id: string; email?: string }, isBootstrap = false) => {
    try {
      const { data: profile, error } = await withTimeout(
        supabase
          .from("user_profiles")
          .select("id, user_id, full_name, role, location_id, is_active")
          .eq("user_id", authUser.id)
          .single(),
        PROFILE_TIMEOUT_MS,
        "user_profiles fetch"
      );

      if (error || !profile) {
        // Log DB errors (not timeouts — those are caught below)
        if (error) {
          const errInfo = {
            code:    error.code,
            message: error.message,
            status:  (error as any).status ?? null,
          };
          console.error("[AuthProvider] profile query failed", errInfo);
          _diag.lastProfileError = `${error.code}: ${error.message}`;
        }

        if (lastGoodUser.current) {
          diagLog("profile failed — restoring last good user", { uid: authUser.id });
          setUser({ ...lastGoodUser.current, profileError: true });
        } else {
          diagLog("profile failed — no prior user, setting partial user", { uid: authUser.id });
          setUser({
            id:           authUser.id,
            email:        authUser.email ?? "",
            name:         authUser.email?.split("@")[0] ?? "Unknown",
            role:         null,
            locationId:   null,
            profileError: true,
          });
          if (isBootstrap) setBootstrapError("profile_fetch_failed");
        }
        return;
      }

      // ── Success ───────────────────────────────────────────────────────────
      const resolved: AppUser = {
        id:            profile.user_id,
        email:         authUser.email ?? "",
        name:          profile.full_name ?? authUser.email?.split("@")[0] ?? "User",
        role:          profile.role,
        locationId:    profile.location_id,
        isActive:      profile.is_active,
        profileLoaded: true,
        profileError:  false,
      };
      lastGoodUser.current = resolved;
      _diag.lastProfileError = null;
      diagLog("profile loaded", { uid: resolved.id, role: resolved.role, locationId: resolved.locationId });
      setUser(resolved);
      setBootstrapError(null);

    } catch (err: any) {
      const isTimeout = err?.message?.includes("[AuthProvider] timeout");
      if (!isTimeout) {
        console.error("[AuthProvider] profile load exception:", err?.message ?? err);
        _diag.lastProfileError = err?.message ?? "unknown exception";
      } else {
        diagLog("profile load timed out", { uid: authUser.id });
        _diag.lastProfileError = "timeout";
      }

      if (lastGoodUser.current) {
        diagLog("profile timed out — restoring last good user", { uid: authUser.id });
        setUser({ ...lastGoodUser.current, profileError: true });
      } else {
        setUser({
          id:           authUser.id,
          email:        authUser.email ?? "",
          name:         authUser.email?.split("@")[0] ?? "Unknown",
          role:         null,
          locationId:   null,
          profileError: true,
        });
        if (isBootstrap) setBootstrapError(isTimeout ? "timeout" : "profile_fetch_failed");
      }
    }
  };

  // ── Bootstrap — runs exactly once on mount ────────────────────────────────
  useEffect(() => {
    let isMounted = true;

    const failsafe = setTimeout(() => {
      if (isMounted && loadingRef.current) {
        diagLog("bootstrap failsafe fired — forcing loading=false");
        bootstrapDone.current = true;
        setBootstrapError("timeout");
        markLoadingFalse();
      }
    }, BOOTSTRAP_TIMEOUT_MS);

    async function bootstrap() {
      try {
        const isLocalDev = process.env.NODE_ENV === "development" &&
          typeof window !== "undefined" &&
          window.location.hostname === "localhost";

        if (isLocalDev && localStorage.getItem("dev_mock_user") === "hq_admin") {
          diagLog("Using dev mock user hq_admin");
          setUser({
            id: "dev-mock-admin-uuid",
            email: "admin@stockdharma.com",
            name: "Dev Mock Admin",
            role: "hq_admin",
            locationId: "LOC-HQ",
            isActive: true,
            profileLoaded: true,
            profileError: false,
          });
          bootstrapDone.current = true;
          markLoadingFalse();
          return;
        }

        if (!supabaseConfigured) {
          console.error("[AuthProvider] Supabase env vars missing — check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
          diagLog("Supabase not configured");
          setUser(null);
          return;
        }

        diagLog("bootstrap: calling getSession()", { pathname });
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();

        if (sessionError) {
          console.error("[AuthProvider] getSession error:", sessionError.message);
        }

        // Update diagnostics
        _diag.sessionPresent = !!session;
        _diag.sessionExpiry  = session?.expires_at
          ? new Date(session.expires_at * 1000).toISOString()
          : null;
        _diag.lastAuthEvent  = "INITIAL_SESSION";
        _diag.lastEventTime  = new Date().toISOString();

        diagLog("bootstrap: getSession result", {
          hasSession: !!session,
          sessionExpiry: _diag.sessionExpiry,
          sessionError: sessionError?.message ?? null,
        });

        if (!isMounted) return;

        if (session?.user) {
          await loadProfile(session.user, /* isBootstrap */ true);
        } else {
          diagLog("bootstrap: no session found — user=null");
          setUser(null);
        }
      } catch (err: any) {
        console.error("[AuthProvider] bootstrap error:", err?.message ?? err);
        if (isMounted) setUser(null);
      } finally {
        clearTimeout(failsafe);
        bootstrapDone.current = true;
        markLoadingFalse();
        diagLog("bootstrap: complete", { bootstrapDone: true });
      }
    }

    bootstrap();

    // ── Auth state listener ───────────────────────────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      // Always log auth events in development, and track in _diag in production
      _diag.lastAuthEvent  = event;
      _diag.lastEventTime  = new Date().toISOString();
      _diag.sessionPresent = !!session;
      _diag.sessionExpiry  = session?.expires_at
        ? new Date(session.expires_at * 1000).toISOString()
        : null;

      diagLog(`auth event: ${event}`, {
        uid:           session?.user?.id ?? "none",
        hasSession:    !!session,
        sessionExpiry: _diag.sessionExpiry,
        bootstrapDone: bootstrapDone.current,
        hasLastGood:   !!lastGoodUser.current,
        pathname,
      });

      // INITIAL_SESSION is handled by bootstrap() — skip to avoid the race
      if (event === "INITIAL_SESSION") return;

      if (!isMounted) return;

      if (event === "TOKEN_REFRESHED") {
        // Token refreshed silently — the JWT is renewed but the profile row
        // has NOT changed. Skip the profile re-fetch entirely.
        // lastGoodUser already holds the correct role.
        _diag.lastTokenRefresh = new Date().toISOString();
        diagLog("TOKEN_REFRESHED — session extended, no profile re-fetch needed");
        return;
      }

      if (event === "USER_UPDATED" && session?.user) {
        if (bootstrapDone.current) {
          await loadProfile(session.user, /* isBootstrap */ false);
          markLoadingFalse();
        }
        return;
      }

      if (event === "SIGNED_IN" && session?.user) {
        // Supabase fires SIGNED_IN after bootstrap INITIAL_SESSION too.
        // If we already have a good user (bootstrap loaded it), skip the
        // redundant re-fetch — it was causing repeated timeouts.
        if (lastGoodUser.current) {
          diagLog("SIGNED_IN — lastGoodUser present, skipping profile re-fetch");
          if (bootstrapDone.current) markLoadingFalse();
          return;
        }
        // Fresh login path (no prior user) — load profile and unblock UI
        if (bootstrapDone.current) {
          diagLog("SIGNED_IN — fresh login, loading profile");
          await loadProfile(session.user, /* isBootstrap */ false);
          markLoadingFalse();
        }
        return;
      }

      if (event === "SIGNED_OUT") {
        // ── CRITICAL: Do NOT immediately trust a SIGNED_OUT event ──────────
        //
        // Supabase JS v2 fires SIGNED_OUT spuriously in two known scenarios:
        //   1. A refresh-token network request fails transiently (WiFi blip,
        //      Vercel cold start) — the session is NOT actually expired.
        //   2. Two tabs: one tab signs out, the storage event propagates to
        //      other tabs as SIGNED_OUT even if those sessions are still valid.
        //
        // Fix: wait SIGNED_OUT_VERIFY_DELAY_MS then call getSession().
        // If a valid session still exists, suppress the logout and restore state.
        // Only call setUser(null) if getSession() truly returns no session.
        //
        // If this was a VOLUNTARY sign-out (user clicked "Eject Session"),
        // voluntarySignOut.current is true → skip verification, log out immediately.

        if (signedOutTimer.current) {
          clearTimeout(signedOutTimer.current);
          signedOutTimer.current = null;
        }

        if (voluntarySignOut.current) {
          diagLog("SIGNED_OUT (voluntary) — clearing user immediately");
          voluntarySignOut.current = false;
          lastGoodUser.current = null;
          setUser(null);
          if (bootstrapDone.current) markLoadingFalse();
          return;
        }

        diagLog(`SIGNED_OUT received — verifying in ${SIGNED_OUT_VERIFY_DELAY_MS}ms before acting`, {
          hasLastGood: !!lastGoodUser.current,
        });

        signedOutTimer.current = setTimeout(async () => {
          if (!isMounted) return;

          try {
            const { data: { session: verifySession } } = await supabase.auth.getSession();

            if (verifySession?.user) {
              // Session is still alive — the SIGNED_OUT was spurious.
              // Restore the last good user and log a warning.
              diagLog("SIGNED_OUT was spurious — session still valid, restoring user", {
                uid: verifySession.user.id,
                sessionExpiry: verifySession.expires_at
                  ? new Date(verifySession.expires_at * 1000).toISOString()
                  : null,
              });
              console.warn(
                "[AuthProvider] Spurious SIGNED_OUT event received but session is still valid. " +
                "This can happen during a network hiccup or Supabase refresh-token retry. " +
                "User will NOT be logged out."
              );
              // Re-apply lastGoodUser to ensure UI state is correct
              if (lastGoodUser.current) {
                setUser({ ...lastGoodUser.current });
              } else {
                // No cached user — reload profile from the live session
                await loadProfile(verifySession.user, false);
              }
              if (bootstrapDone.current) markLoadingFalse();
            } else {
              // Session is truly gone — log out for real
              diagLog("SIGNED_OUT verified — session is truly expired, logging out", { pathname });
              lastGoodUser.current = null;
              setUser(null);
              if (bootstrapDone.current) markLoadingFalse();
            }
          } catch (verifyErr: any) {
            // getSession() itself failed (no network) — do NOT log out.
            // The session may still be alive. Show the reconnecting state instead.
            diagLog("SIGNED_OUT verify — getSession() threw (likely offline), preserving session", {
              error: verifyErr?.message,
            });
            console.warn(
              "[AuthProvider] Could not verify SIGNED_OUT because getSession() threw " +
              "(possible network outage). Preserving current session state. Error:",
              verifyErr?.message
            );
            // Restore last known good user if available
            if (lastGoodUser.current) {
              setUser({ ...lastGoodUser.current, profileError: true });
            }
            if (bootstrapDone.current) markLoadingFalse();
          }
        }, SIGNED_OUT_VERIFY_DELAY_MS);

        return;
      }
    });

    return () => {
      isMounted = false;
      clearTimeout(failsafe);
      if (signedOutTimer.current) clearTimeout(signedOutTimer.current);
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Redirect effect ───────────────────────────────────────────────────────
  useEffect(() => {
    // NEVER redirect while auth is still bootstrapping
    if (loading) return;
    // NEVER redirect when there was a bootstrap timeout — show Retry instead
    if (bootstrapError) return;
    // NEVER redirect when profile fetch failed — show Retry instead
    if (user?.profileError) return;

    // Block unauthenticated users AND explicitly deactivated users.
    // user.isActive === false (strict) avoids blocking during cold-start
    // when isActive is undefined (profile not yet resolved).
    if ((!user || user.isActive === false) && pathname !== "/login") {
      _diag.redirectCount++;
      diagLog("redirect → /login", {
        reason:    !user ? "user is null" : "user.isActive is false",
        pathname,
        redirectCount: _diag.redirectCount,
        loading,
        bootstrapError,
        profileError: user?.profileError,
      });
      router.push("/login");
    } else if (user && user.isActive !== false && pathname === "/login") {
      diagLog("redirect → home (already logged in, on /login)", {
        role: user.role,
        home: getAllowedHomePath(user),
      });
      router.push(getAllowedHomePath(user));
    } else if (user && user.isActive !== false && !canAccessPath(user, pathname)) {
      diagLog("redirect → home (path not accessible)", {
        role:     user.role,
        pathname,
        home:     getAllowedHomePath(user),
      });
      router.push(getAllowedHomePath(user));
    }
  }, [user, loading, bootstrapError, pathname, router]);

  // ── Loading screen ────────────────────────────────────────────────────────
  if ((loading || bootstrapError || user?.profileError) && pathname !== "/login") {
    const errorType = bootstrapError || (user?.profileError ? "profile_fetch_failed" : null);

    // Dev diagnostic panel — visible in development only
    const showDiagPanel = process.env.NODE_ENV !== "production";

    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 max-w-sm w-full px-4">
          {errorType ? (
            // Error / timeout state — clear message + retry
            <>
              <div className="text-neutral-700 text-sm font-semibold text-center max-w-xs">
                {errorType === "timeout"
                  ? "Authentication is taking longer than expected."
                  : "Your profile could not be loaded. Please check your connection."}
              </div>
              <div className="text-neutral-500 text-xs text-center max-w-xs">
                Your session is still active — this is usually a temporary DB cold-start.
              </div>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
              >
                Retry
              </button>
            </>
          ) : (
            // Normal spinner
            <div className="animate-pulse flex flex-col items-center">
              <div className="h-8 w-8 rounded-full border-4 border-brand-500 border-t-transparent animate-spin mb-4" />
              <div className="text-neutral-500 text-sm font-medium">Validating security context...</div>
            </div>
          )}

          {/* ── Dev diagnostics panel ────────────────────────────────── */}
          {showDiagPanel && (
            <details className="mt-4 w-full rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
              <summary className="cursor-pointer font-bold text-amber-700 text-xs">
                🔍 Auth Diagnostics (dev only)
              </summary>
              <div className="mt-2 space-y-1 font-mono">
                <div>Session present: <strong>{_diag.sessionPresent ? "yes" : "no"}</strong></div>
                <div>Session expiry: <strong>{_diag.sessionExpiry ?? "—"}</strong></div>
                <div>Last auth event: <strong>{_diag.lastAuthEvent}</strong></div>
                <div>Event time: <strong>{_diag.lastEventTime ?? "—"}</strong></div>
                <div>Last token refresh: <strong>{_diag.lastTokenRefresh ?? "—"}</strong></div>
                <div>Last profile error: <strong>{_diag.lastProfileError ?? "none"}</strong></div>
                <div>Redirect count: <strong>{_diag.redirectCount}</strong></div>
                <div>Bootstrap done: <strong>{String(bootstrapDone.current)}</strong></div>
                <div>Current path: <strong>{pathname}</strong></div>
                <div>Bootstrap error: <strong>{bootstrapError ?? "none"}</strong></div>
                <div>Profile error: <strong>{String(!!user?.profileError)}</strong></div>
                <div>Hostname: <strong>{mounted ? hostname : ""}</strong></div>
              </div>
            </details>
          )}
        </div>
      </div>
    );
  }

  const signOut = async () => {
    try {
      const isLocalDev = process.env.NODE_ENV === "development" &&
        typeof window !== "undefined" &&
        window.location.hostname === "localhost";

      if (isLocalDev) {
        localStorage.removeItem("dev_mock_user");
      }
      // Mark as voluntary so SIGNED_OUT listener skips the verify delay
      voluntarySignOut.current = true;
      lastGoodUser.current = null;
      diagLog("voluntary signOut called");
      await supabase.auth.signOut();
      setUser(null);
      router.push("/login");
    } catch (e) {
      voluntarySignOut.current = false; // reset on error
      console.error("[AuthProvider] signOut error:", e);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
