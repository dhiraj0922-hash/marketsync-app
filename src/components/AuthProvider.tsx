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
/** Per-fetch limit for the user_profiles query */
const PROFILE_TIMEOUT_MS   =  7_000;

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

  const markLoadingFalse = (label: string) => {
    console.log(`[AuthProvider] setLoading(false) via: ${label}`);
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
    console.log("[AuthProvider] loadProfile START  uid=", authUser.id, " email=", authUser.email, " isBootstrap=", isBootstrap);

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

      console.log("[AuthProvider] loadProfile RESULT", {
        found:       !!profile,
        role:        profile?.role        ?? null,
        location_id: profile?.location_id ?? null,
        is_active:   profile?.is_active   ?? null,
        errorCode:   error?.code          ?? null,
        errorMsg:    error?.message       ?? null,
      });

      if (error || !profile) {
        // ── Profile row missing ───────────────────────────────────────────
        // PGRST116 = "not found" — profile row doesn't exist yet.
        // Other errors = DB/network problem.
        console.warn("[AuthProvider] loadProfile: no profile row or DB error — code:", error?.code);

        if (lastGoodUser.current) {
          // Token refresh path: don't downgrade. Restore last-known-good user.
          console.warn("[AuthProvider] loadProfile: restoring lastGoodUser (no downgrade on refresh path)");
          setUser({ ...lastGoodUser.current, profileError: true });
        } else {
          // Bootstrap path: genuinely no profile. Set minimal user with error flag.
          const minimal: AppUser = {
            id:           authUser.id,
            email:        authUser.email ?? "",
            name:         authUser.email?.split("@")[0] ?? "Unknown",
            role:         null,
            locationId:   null,
            profileError: true,
          };
          setUser(minimal);
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
      console.log("[AuthProvider] loadProfile OK → role=", resolved.role, " locationId=", resolved.locationId);
      lastGoodUser.current = resolved;
      setUser(resolved);
      setBootstrapError(null);

    } catch (err: any) {
      console.error("[AuthProvider] loadProfile THREW:", err?.message ?? err);

      if (lastGoodUser.current) {
        // Restore last-known-good — timeout on token-refresh shouldn't log you out
        console.warn("[AuthProvider] loadProfile: timeout/error on refresh — restoring lastGoodUser");
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
        if (isBootstrap) setBootstrapError("timeout");
      }
    }
  };

  // ── Bootstrap — runs exactly once on mount ────────────────────────────────
  useEffect(() => {
    let isMounted = true;

    console.log("[AuthProvider] bootstrap START  supabaseConfigured=", supabaseConfigured);

    const failsafe = setTimeout(() => {
      if (isMounted && loadingRef.current) {
        console.warn(`[AuthProvider] FAILSAFE after ${BOOTSTRAP_TIMEOUT_MS}ms — forcing loading=false`);
        bootstrapDone.current = true;
        setBootstrapError("timeout");
        // Don't wipe user — just unblock the UI
        markLoadingFalse("failsafe-timeout");
      }
    }, BOOTSTRAP_TIMEOUT_MS);

    async function bootstrap() {
      try {
        if (!supabaseConfigured) {
          console.error("[AuthProvider] Supabase env vars missing.");
          setUser(null);
          return;
        }

        console.log("[AuthProvider] getSession START");
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        console.log("[AuthProvider] getSession END", {
          sessionPresent: !!session,
          userId:         session?.user?.id   ?? null,
          errorMsg:       sessionError?.message ?? null,
        });

        if (!isMounted) return;

        if (session?.user) {
          console.log("[AuthProvider] session found → loadProfile uid=", session.user.id);
          await loadProfile(session.user, /* isBootstrap */ true);
        } else {
          console.log("[AuthProvider] no session → setUser(null)");
          setUser(null);
        }
      } catch (err: any) {
        console.error("[AuthProvider] bootstrap THREW:", err?.message ?? err);
        if (isMounted) setUser(null);
      } finally {
        clearTimeout(failsafe);
        bootstrapDone.current = true;
        markLoadingFalse("bootstrap-finally");
      }
    }

    bootstrap();

    // ── Auth state listener ───────────────────────────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log("[AuthProvider] onAuthStateChange event=", event, "bootstrapDone=", bootstrapDone.current);

      // INITIAL_SESSION is handled by bootstrap() — skip to avoid the race
      if (event === "INITIAL_SESSION") return;

      if (!isMounted) return;

      if (event === "TOKEN_REFRESHED") {
        // Token refreshed silently. Re-validate the profile in the background
        // but DO NOT show loading spinner (would flash the screen on every refresh).
        // Also: if the refetch fails, lastGoodUser ensures we keep the good role.
        if (session?.user) {
          console.log("[AuthProvider] TOKEN_REFRESHED — silent profile revalidation uid=", session.user.id);
          // Fire-and-forget: loading stays false, role is preserved via lastGoodUser
          loadProfile(session.user, /* isBootstrap */ false);
        }
        return;
      }

      if (event === "SIGNED_IN" && session?.user) {
        // New login — set loading so the redirect effect fires cleanly
        if (bootstrapDone.current) {
          await loadProfile(session.user, /* isBootstrap */ false);
          markLoadingFalse("onAuthStateChange-signed-in");
        }
        return;
      }

      if (event === "SIGNED_OUT") {
        lastGoodUser.current = null;
        setUser(null);
        if (bootstrapDone.current) markLoadingFalse("onAuthStateChange-signed-out");
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
    if (!user && pathname !== "/login") {
      console.log("[AuthProvider] redirect → /login  pathname=", pathname);
      router.push("/login");
    } else if (user && pathname === "/login") {
      console.log("[AuthProvider] redirect → /  (authenticated user on /login)");
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
