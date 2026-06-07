"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import { ROLE_HQ_ADMIN, LOC_HQ, type AppUser } from "@/lib/roles";

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser]           = useState<AppUser | null>(null);
  const [loading, setLoading]     = useState(true);
  const [bootstrapError, setBootstrapError] = useState<BootstrapError>(null);

  const router   = useRouter();
  const pathname = usePathname();

  // Prevents concurrent profile fetches (bootstrap + onAuthStateChange race)
  const bootstrapDone = useRef(false);
  const loadingRef    = useRef(true);
  // Retain the last successfully loaded user so a token-refresh profile
  // re-fetch failure doesn't wipe out a known-good role.
  const lastGoodUser  = useRef<AppUser | null>(null);

  const markLoadingFalse = () => {
    loadingRef.current = false;
    setLoading(false);
  };

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
          console.error("[AuthProvider] profile query failed", {
            code:    error.code,
            message: error.message,
            status:  (error as any).status ?? null,
          });
        }

        if (lastGoodUser.current) {
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
      setUser(resolved);
      setBootstrapError(null);

    } catch (err: any) {
      const isTimeout = err?.message?.includes("[AuthProvider] timeout");
      if (!isTimeout) {
        // Real exceptions are always logged; timeouts are expected on cold-start
        console.error("[AuthProvider] profile load exception:", err?.message ?? err);
      }

      if (lastGoodUser.current) {
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
          console.log("[AuthProvider] Using dev mock user hq_admin");
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
          setUser(null);
          return;
        }

        const { data: { session }, error: sessionError } = await supabase.auth.getSession();

        if (sessionError) {
          console.error("[AuthProvider] getSession error:", sessionError.message);
        }

        if (!isMounted) return;

        if (session?.user) {
          await loadProfile(session.user, /* isBootstrap */ true);
        } else {
          setUser(null);
        }
      } catch (err: any) {
        console.error("[AuthProvider] bootstrap error:", err?.message ?? err);
        if (isMounted) setUser(null);
      } finally {
        clearTimeout(failsafe);
        bootstrapDone.current = true;
        markLoadingFalse();
      }
    }

    bootstrap();

    // ── Auth state listener ───────────────────────────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      // INITIAL_SESSION is handled by bootstrap() — skip to avoid the race
      if (event === "INITIAL_SESSION") return;

      if (!isMounted) return;

      if (event === "TOKEN_REFRESHED") {
        // Token refreshed silently — the JWT is renewed but the profile row
        // has NOT changed. Skip the profile re-fetch entirely.
        // lastGoodUser already holds the correct role.
        return;
      }

      if (event === "SIGNED_IN" && session?.user) {
        // Supabase fires SIGNED_IN after bootstrap INITIAL_SESSION too.
        // If we already have a good user (bootstrap loaded it), skip the
        // redundant re-fetch — it was causing repeated timeouts.
        if (lastGoodUser.current) {
          if (bootstrapDone.current) markLoadingFalse();
          return;
        }
        // Fresh login path (no prior user) — load profile and unblock UI
        if (bootstrapDone.current) {
          await loadProfile(session.user, /* isBootstrap */ false);
          markLoadingFalse();
        }
        return;
      }

      if (event === "SIGNED_OUT") {
        lastGoodUser.current = null;
        setUser(null);
        if (bootstrapDone.current) markLoadingFalse();
        return;
      }
    });

    return () => {
      isMounted = false;
      clearTimeout(failsafe);
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Redirect effect ───────────────────────────────────────────────────────
  useEffect(() => {
    if (loading) return;
    // Block unauthenticated users AND explicitly deactivated users.
    // user.isActive === false (strict) avoids blocking during cold-start
    // when isActive is undefined (profile not yet resolved).
    if ((!user || user.isActive === false) && pathname !== "/login") {
      router.push("/login");
    } else if (user && user.isActive !== false && pathname === "/login") {
      router.push("/");
    }
  }, [user, loading, pathname, router]);

  // ── Loading screen ────────────────────────────────────────────────────────
  if (loading && pathname !== "/login") {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          {bootstrapError ? (
            // Error / timeout state — clear message + retry
            <>
              <div className="text-neutral-700 text-sm font-semibold text-center max-w-xs">
                {bootstrapError === "timeout"
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
      lastGoodUser.current = null;
      await supabase.auth.signOut();
      setUser(null);
      router.push("/login");
    } catch (e) {
      console.error("[AuthProvider] signOut error:", e);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
