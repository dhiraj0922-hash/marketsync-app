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

// Hard ceiling on the auth bootstrap. If getSession() or the profile fetch
// haven't resolved after AUTH_TIMEOUT_MS we force loading=false so the user
// is not stuck on a spinner forever. They will be redirected to /login by the
// redirect effect below because user will still be null.
const AUTH_TIMEOUT_MS = 8_000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser]       = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const router   = useRouter();
  const pathname = usePathname();

  // ── Profile loader ──────────────────────────────────────────────────────────
  const loadProfile = async (authUser: { id: string; email?: string }) => {
    console.log("[AuthProvider] loadProfile start uid=", authUser.id);
    const { data: profile, error } = await supabase
      .from("user_profiles")
      .select("id, user_id, full_name, role, location_id, is_active")
      .eq("user_id", authUser.id)
      .single();

    if (error || !profile) {
      console.warn("[AuthProvider] no user_profiles row for uid", authUser.id, error?.message);
      setUser({
        id: authUser.id,
        email: authUser.email ?? "",
        name: authUser.email?.split("@")[0] ?? "Unknown",
        role: null,
        locationId: null,
      });
      return;
    }

    console.log("[AuthProvider] loadProfile OK role=", profile.role);
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
  // DO NOT include pathname/router in the dependency array.
  // pathname changes every navigation — putting it here causes a new getSession()
  // and a new onAuthStateChange subscription on every page visit, leading to
  // race conditions and the spinner never clearing on cold-start.
  useEffect(() => {
    let mounted = true;
    console.log("[AuthProvider] bootstrap start. supabaseConfigured=", supabaseConfigured);

    // Hard timeout: if the entire bootstrap takes longer than AUTH_TIMEOUT_MS,
    // force loading=false so the user is never stuck on the spinner indefinitely.
    const hardTimeout = setTimeout(() => {
      if (mounted) {
        console.warn(
          `[AuthProvider] bootstrap exceeded ${AUTH_TIMEOUT_MS}ms — forcing loading=false. ` +
          "Check NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel env vars."
        );
        setLoading(false);
      }
    }, AUTH_TIMEOUT_MS);

    async function checkSession() {
      try {
        if (!supabaseConfigured) {
          console.error("[AuthProvider] Supabase env vars not configured — skipping getSession.");
          return; // finally will still run → setLoading(false)
        }

        console.log("[AuthProvider] getSession start");
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        console.log("[AuthProvider] getSession end session=", session ? "present" : "null", "error=", sessionError?.message);

        if (!mounted) return;

        if (session?.user) {
          console.log("[AuthProvider] session found, loading profile");
          await loadProfile(session.user);
        } else {
          console.log("[AuthProvider] no session");
          setUser(null);
        }
      } catch (e: any) {
        console.error("[AuthProvider] checkSession threw:", e?.message ?? e);
        if (mounted) setUser(null);
      } finally {
        console.log("[AuthProvider] bootstrap finally — setting loading=false");
        clearTimeout(hardTimeout);
        if (mounted) setLoading(false);
      }
    }

    checkSession();

    // Auth state listener — handles sign-in / sign-out events AFTER bootstrap.
    // Does NOT call setLoading(false) — bootstrap's finally always handles that.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log("[AuthProvider] onAuthStateChange event=", event, "session=", session ? "present" : "null");
      if (!mounted) return;

      if (session?.user) {
        await loadProfile(session.user);
      } else {
        setUser(null);
      }
    });

    return () => {
      mounted = false;
      clearTimeout(hardTimeout);
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ← intentionally empty: bootstrap runs exactly once on mount

  // ── Redirect effect: separate from bootstrap ────────────────────────────────
  // Runs whenever user or pathname changes, AFTER loading is resolved.
  // Keeping this separate from the bootstrap effect eliminates the dependency
  // on pathname/router that was causing re-bootstrap on every navigation.
  useEffect(() => {
    if (loading) return; // don't redirect until we know the auth state

    if (!user && pathname !== "/login") {
      console.log("[AuthProvider] redirect → /login (no user, pathname=", pathname, ")");
      router.push("/login");
    } else if (user && pathname === "/login") {
      console.log("[AuthProvider] redirect → / (user present, on /login)");
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
      console.error(e);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
