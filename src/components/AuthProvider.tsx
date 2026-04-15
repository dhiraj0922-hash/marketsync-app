"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase, supabaseConfigured } from "@/lib/supabase";

type AuthContextType = {
  user: any;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({ user: null, loading: true, signOut: async () => {} });

export const useAuth = () => useContext(AuthContext);

// Hard timeout for the entire bootstrap (getSession + loadProfile).
const BOOTSTRAP_TIMEOUT_MS = 10_000;
// Hard timeout for the user_profiles fetch alone — prevents a slow DB from
// consuming the entire bootstrap budget and leaving no room for state updates.
const PROFILE_TIMEOUT_MS   =  6_000;

// Promise that rejects after `ms` milliseconds with a clear message.
function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`[AuthProvider] timeout: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e);  }
    );
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // NOTE: this log fires on every render — normal for a context provider.
  // The key line to watch is "[AuthProvider] bootstrap START" which fires once.
  const [user, setUser]             = useState<any>(null);
  const [loading, setLoading]       = useState(true);
  // Exposed in the loading screen so users know when to retry instead of waiting.
  const [timedOut, setTimedOut]     = useState(false);
  const router   = useRouter();
  const pathname = usePathname();

  // Tracks whether the initial bootstrap is complete.
  // onAuthStateChange INITIAL_SESSION is suppressed during bootstrap to prevent
  // a concurrent loadProfile() race with the bootstrap's own profile fetch.
  const bootstrapDone = useRef(false);
  // Ref so the failsafe callback always sees the live value, not a stale closure.
  const loadingRef    = useRef(true);

  const markLoadingFalse = (label: string) => {
    console.log(`[AuthProvider] setLoading(false) via: ${label}`);
    loadingRef.current = false;
    setLoading(false);
  };

  // ── Profile loader with its own timeout ────────────────────────────────────
  const loadProfile = async (authUser: { id: string; email?: string }) => {
    console.log("[AuthProvider] loadProfile START  uid=", authUser.id, " email=", authUser.email);

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
        console.warn("[AuthProvider] loadProfile: no profile row — setting user with role=null");
        setUser({
          id: authUser.id,
          email: authUser.email ?? "",
          name: authUser.email?.split("@")[0] ?? "Unknown",
          role: null,
          locationId: null,
        });
        return;
      }

      console.log("[AuthProvider] loadProfile OK → role=", profile.role, " locationId=", profile.location_id);
      setUser({
        id: profile.user_id,
        email: authUser.email ?? "",
        name: profile.full_name ?? authUser.email?.split("@")[0] ?? "User",
        role: profile.role,
        locationId: profile.location_id,
        isActive: profile.is_active,
      });
    } catch (err: any) {
      console.error("[AuthProvider] loadProfile THREW:", err?.message ?? err);
      // Always set a minimal user so the app isn't stuck.
      setUser({
        id: authUser.id,
        email: authUser.email ?? "",
        name: authUser.email?.split("@")[0] ?? "Unknown",
        role: null,
        locationId: null,
      });
    }
  };

  // ── Bootstrap: run ONCE on mount ────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;
    console.log("[AuthProvider] bootstrap START supabaseConfigured=", supabaseConfigured);

    // Failsafe: if bootstrap has not resolved within BOOTSTRAP_TIMEOUT_MS,
    // force the spinner off and show the retry message.
    // Uses loadingRef (not the stale closure `loading`) to check live state.
    const failsafe = setTimeout(() => {
      if (isMounted && loadingRef.current) {
        console.warn(`[AuthProvider] FAILSAFE after ${BOOTSTRAP_TIMEOUT_MS}ms — bootstrap never completed.`);
        bootstrapDone.current = true;
        setTimedOut(true);
        setUser(null);
        markLoadingFalse("failsafe-timeout");
      }
    }, BOOTSTRAP_TIMEOUT_MS);

    async function bootstrap() {
      try {
        if (!supabaseConfigured) {
          console.error("[AuthProvider] Supabase env vars missing — cannot call getSession.");
          setUser(null);
          return;
        }

        console.log("[AuthProvider] getSession START");
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        console.log("[AuthProvider] getSession END", {
          sessionPresent: !!session,
          userId:         session?.user?.id     ?? null,
          userEmail:      session?.user?.email  ?? null,
          accessToken:    session?.access_token ? "<present>" : null,
          expiresAt:      session?.expires_at   ?? null,
          errorMsg:       sessionError?.message ?? null,
        });

        if (!isMounted) {
          console.log("[AuthProvider] bootstrap: unmounted after getSession — aborting");
          return;
        }

        if (session?.user) {
          console.log("[AuthProvider] session found → loadProfile uid=", session.user.id);
          await loadProfile(session.user);
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

    // Auth state listener — INITIAL_SESSION is suppressed so it doesn't race
    // with bootstrap(). SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED are handled
    // here after bootstrap completes.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log("[AuthProvider] onAuthStateChange event=", event, "bootstrapDone=", bootstrapDone.current);

      if (event === "INITIAL_SESSION") {
        console.log("[AuthProvider] skipping INITIAL_SESSION — handled by bootstrap()");
        return;
      }

      if (!isMounted) return;

      if (session?.user) {
        await loadProfile(session.user);
        // After a SIGNED_IN event (post-login), ensure loading is cleared
        // in case bootstrap already ran and set it false, but a re-render
        // race put it back to true.
        if (bootstrapDone.current) {
          markLoadingFalse("onAuthStateChange-signed-in");
        }
      } else {
        setUser(null);
        if (bootstrapDone.current) {
          markLoadingFalse("onAuthStateChange-signed-out");
        }
      }
    });

    return () => {
      isMounted = false;
      clearTimeout(failsafe);
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — bootstrap runs exactly once on mount

  // ── Redirect effect: runs only AFTER loading=false ─────────────────────────
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

  // ── Loading screen ──────────────────────────────────────────────────────────
  if (loading && pathname !== "/login") {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          {timedOut ? (
            // Timeout state — never show infinite spinner
            <>
              <div className="text-neutral-500 text-sm font-medium text-center max-w-xs">
                Authentication is taking longer than expected. Please retry.
              </div>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 text-sm font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
              >
                Retry
              </button>
            </>
          ) : (
            // Normal loading spinner
            <div className="animate-pulse flex flex-col items-center">
              <div className="h-8 w-8 rounded-full border-4 border-brand-500 border-t-transparent animate-spin mb-4"></div>
              <div className="text-neutral-500 text-sm font-medium">Validating security context...</div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const signOut = async () => {
    try {
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
