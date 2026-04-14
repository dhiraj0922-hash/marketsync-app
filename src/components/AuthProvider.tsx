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

const BOOTSTRAP_TIMEOUT_MS = 10_000; // hard ceiling — spinner never shows longer than this

export function AuthProvider({ children }: { children: React.ReactNode }) {
  console.log("AuthProvider mounted");

  const [user, setUser]       = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const router   = useRouter();
  const pathname = usePathname();

  // Tracks whether the initial bootstrap is complete.
  // onAuthStateChange is suppressed during bootstrap so it doesn't race with
  // checkSession() — both would call loadProfile() concurrently otherwise.
  const bootstrapDone = useRef(false);

  // ── Profile loader ──────────────────────────────────────────────────────────
  const loadProfile = async (authUser: { id: string; email?: string }) => {
    console.log("[AuthProvider] loadProfile START  uid=", authUser.id, " email=", authUser.email);

    const { data: profile, error } = await supabase
      .from("user_profiles")
      .select("id, user_id, full_name, role, location_id, is_active")
      .eq("user_id", authUser.id)
      .single();

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
  };

  // ── Bootstrap: run ONCE on mount ────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;
    console.log("[AuthProvider] bootstrap START supabaseConfigured=", supabaseConfigured);

    // Unconditional failsafe — loading WILL be cleared no matter what.
    // Using a ref so clearTimeout always targets the right timer even if the
    // component re-renders between setTimeout and clearTimeout.
    const failsafe = setTimeout(() => {
      if (isMounted && loading) {
        console.warn(
          `[AuthProvider] FAILSAFE after ${BOOTSTRAP_TIMEOUT_MS}ms → setLoading(false).` +
          " Bootstrap never completed. Check Vercel env vars."
        );
        bootstrapDone.current = true;
        setLoading(false); // ← LOADING FALSE path: failsafe
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
        console.log("[AuthProvider] bootstrap DONE → setLoading(false)  isMounted=", isMounted);
        // Call unconditionally — if unmounted React will ignore the state update.
        // The only thing NOT calling this was the old `if (mounted)` guard which
        // caused the spinner to persist when the component briefly unmounted/remounted.
        setLoading(false); // ← LOADING FALSE path: normal
      }
    }

    bootstrap();

    // Auth state listener — only acts AFTER bootstrap is complete.
    // During bootstrap, checkSession already handles the initial session.
    // Allowing onAuthStateChange to run concurrently was the race condition
    // that caused double loadProfile() calls and non-deterministic loading state.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log("[AuthProvider] onAuthStateChange event=", event, "bootstrapDone=", bootstrapDone.current);

      // Suppress INITIAL_SESSION — bootstrap() handles it.
      // All other events (SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED) are handled here.
      if (event === "INITIAL_SESSION") {
        console.log("[AuthProvider] onAuthStateChange: skipping INITIAL_SESSION (handled by bootstrap)");
        return;
      }

      if (!isMounted) return;

      if (session?.user) {
        await loadProfile(session.user);
      } else {
        setUser(null);
        // Only set loading false if bootstrap is done; otherwise bootstrap's finally handles it
        if (bootstrapDone.current) {
          setLoading(false); // ← LOADING FALSE path: sign-out after bootstrap
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

  // ── Redirect effect: runs AFTER loading clears ──────────────────────────────
  useEffect(() => {
    if (loading) return; // never redirect while bootstrap is still in progress

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
        <div className="animate-pulse flex flex-col items-center">
          <div className="h-8 w-8 rounded-full border-4 border-brand-500 border-t-transparent animate-spin mb-4"></div>
          <div className="text-neutral-500 text-sm font-medium">Validating security context...</div>
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
