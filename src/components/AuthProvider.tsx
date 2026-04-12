"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";

type AuthContextType = {
  user: any;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({ user: null, loading: true, signOut: async () => {} });

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  /**
   * Fetch profile from user_profiles using auth.uid().
   * This is the single source of truth for role and location_id.
   * No email-based lookup, no hardcoded fallbacks.
   */
  const loadProfile = async (authUser: { id: string; email?: string }) => {
    const { data: profile, error } = await supabase
      .from("user_profiles")
      .select("id, user_id, full_name, role, location_id, is_active")
      .eq("user_id", authUser.id)
      .single();

    if (error || !profile) {
      console.warn("AuthProvider: no user_profiles row for uid", authUser.id, error?.message);
      // Not null — keep the auth session but mark role as unconfigured
      // so all pages can render their "Access Not Configured" state safely.
      setUser({
        id: authUser.id,
        email: authUser.email ?? "",
        name: authUser.email?.split("@")[0] ?? "Unknown",
        role: null,        // explicit null → UI shows restricted state
        locationId: null,
      });
      return;
    }

    setUser({
      id: profile.user_id,
      email: authUser.email ?? "",
      name: profile.full_name ?? authUser.email?.split("@")[0] ?? "User",
      role: profile.role,               // "hq_admin" | "location_manager"
      locationId: profile.location_id,  // used by Header pill and role guards
      isActive: profile.is_active,
    });
  };

  useEffect(() => {
    let mounted = true;

    async function checkSession() {
      try {
        const { data: { session } } = await supabase.auth.getSession();

        if (session?.user) {
          await loadProfile(session.user);
        } else {
          setUser(null);
          if (pathname !== "/login") {
            router.push("/login");
          }
        }
      } catch (e) {
        console.error("Auth check failed:", e);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    checkSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        await loadProfile(session.user);
        if (pathname === "/login") {
          router.push("/");
        }
      } else {
        setUser(null);
        if (pathname !== "/login") {
          router.push("/login");
        }
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, router]);

  const signOut = async () => {
    try {
      await supabase.auth.signOut();
      setUser(null);
      router.push("/login");
    } catch (e) {
      console.error(e);
    }
  };

  // Global app lock state
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

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
