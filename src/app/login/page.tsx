"use client";

import { useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  ArrowRight,
  BarChart3,
  Boxes,
  CheckCircle2,
  Factory,
  KeyRound,
  Lock,
  Mail,
  PackageCheck,
  ServerCrash,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [forgotMode, setForgotMode] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const submittingRef = useRef(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) {
      console.log("[Login] submit blocked — already in flight");
      return;
    }
    submittingRef.current = true;
    setLoading(true);
    setError(null);
    console.log("[Login] submit start  email=", email);

    try {
      const signInPromise = supabase.auth.signInWithPassword({ email, password });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Sign-in timed out. Please retry in a moment.")), 10_000)
      );

      const { data, error: authError } = await Promise.race([signInPromise, timeoutPromise]);

      if (authError) {
        console.log("[Login] submit error", authError.message);
        setError(authError.message);
      } else if (data.session) {
        console.log("[Login] submit success  uid=", data.session.user.id);
      }
    } catch (err: any) {
      console.log("[Login] submit error (caught)", err?.message ?? err);
      setError(err?.message ?? "An unexpected network error occurred.");
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setResetLoading(true);
    setResetError(null);
    try {
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(
        resetEmail.trim(),
        { redirectTo: `${window.location.origin}/login` }
      );
      if (resetErr) setResetError(resetErr.message);
      else setResetSent(true);
    } catch {
      setResetError("An unexpected error occurred.");
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full overflow-hidden bg-[#070807] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_12%_12%,rgba(22,163,74,0.22),transparent_34%),radial-gradient(circle_at_88%_18%,rgba(37,99,235,0.24),transparent_30%),linear-gradient(135deg,#070807_0%,#10140f_45%,#07100c_100%)]" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-300/40 to-transparent" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-300/30 bg-emerald-400/10 shadow-lg shadow-emerald-500/10">
              <Factory className="h-5 w-5 text-emerald-300" />
            </div>
            <div>
              <p className="text-sm font-black tracking-[0.28em] text-white">STOCK DHARMA</p>
              <p className="text-[11px] font-medium text-zinc-500">Restaurant inventory command center</p>
            </div>
          </div>
          <a
            href="/login"
            className="hidden rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-zinc-200 backdrop-blur transition-colors hover:bg-white/10 sm:inline-flex"
          >
            Sign In
          </a>
        </header>

        <div className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[1.08fr_0.92fr] lg:py-12">
          <section className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-emerald-200">
              <Sparkles className="h-3.5 w-3.5" />
              Purpose-built restaurant stock control
            </div>

            <h1 className="mt-7 max-w-4xl text-5xl font-black tracking-tight text-white sm:text-6xl lg:text-[64px]">
              Control every count, order, and requisition before it costs you.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-zinc-400 sm:text-lg">
              STOCK DHARMA gives HQ and franchise teams a single operating layer for live inventory, supplier orders, production, and location requisitions.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="/login"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-400 px-5 py-3 text-sm font-black text-neutral-950 shadow-xl shadow-emerald-500/20 transition hover:bg-emerald-300"
              >
                Get Started
                <ArrowRight className="h-4 w-4" />
              </a>
              <a
                href="/login"
                className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.06] px-5 py-3 text-sm font-bold text-white backdrop-blur transition hover:bg-white/[0.1]"
              >
                Login
              </a>
            </div>

            <div className="mt-10 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
              {[
                { label: "Live COGS", value: "28.4%", icon: TrendingUp },
                { label: "Open Orders", value: "42", icon: PackageCheck },
                { label: "Stock Alerts", value: "18", icon: Boxes },
              ].map((stat) => (
                <div key={stat.label} className="rounded-xl border border-white/10 bg-white/[0.055] p-4 backdrop-blur">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-500">{stat.label}</span>
                    <stat.icon className="h-4 w-4 text-emerald-300" />
                  </div>
                  <div className="mt-3 text-2xl font-black tracking-tight text-white">{stat.value}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="relative mx-auto w-full max-w-md lg:max-w-none">
            <div className="absolute -inset-4 rounded-[2rem] bg-gradient-to-br from-emerald-400/20 via-blue-500/10 to-transparent blur-2xl" />
            <div className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#101210]/85 shadow-2xl shadow-black/50 backdrop-blur-xl">
              <div className="border-b border-white/10 bg-white/[0.035] p-6 sm:p-7">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.22em] text-emerald-300">Secure access</p>
                    <h2 className="mt-2 text-2xl font-black tracking-tight text-white">Welcome back</h2>
                    <p className="mt-1 text-sm text-zinc-500">Sign in to STOCK DHARMA</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <ShieldCheck className="h-5 w-5 text-emerald-300" />
                  </div>
                </div>
              </div>

              <div className="space-y-5 p-6 sm:p-7">
                {error && !forgotMode && (
                  <div className="flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-200">
                    <ServerCrash className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <div className="space-y-1">
                  <label className="pl-1 text-xs font-bold uppercase tracking-widest text-zinc-400">
                    Email
                  </label>
                  <div className="relative">
                    <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
                      <Mail className="h-4 w-4" />
                    </div>
                    <input
                      id="login-email"
                      type="email"
                      required
                      value={forgotMode ? resetEmail : email}
                      onChange={(e) => forgotMode ? setResetEmail(e.target.value) : setEmail(e.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-black/25 py-3 pl-10 pr-4 text-sm font-medium text-white outline-none transition-all placeholder:text-zinc-600 focus:border-emerald-300/60 focus:ring-2 focus:ring-emerald-400/15"
                      placeholder={forgotMode ? "your-email@example.com" : "example@stockdharma.com"}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between px-1">
                  <label className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                    {forgotMode ? "Password Reset" : "Password"}
                  </label>
                  <button
                    id="forgot-password-toggle"
                    type="button"
                    onClick={() => { setForgotMode((f) => !f); setResetSent(false); setResetError(null); }}
                    className="text-[11px] font-semibold text-emerald-300 transition-colors hover:text-emerald-200 hover:underline"
                  >
                    {forgotMode ? "Back to sign in" : "Forgot password?"}
                  </button>
                </div>

                {forgotMode ? (
                  resetSent ? (
                    <div className="flex flex-col items-center gap-3 py-4">
                      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-400/15">
                        <CheckCircle2 className="h-6 w-6 text-emerald-300" />
                      </div>
                      <p className="text-sm font-bold text-white">Reset email sent</p>
                      <p className="text-center text-xs text-zinc-500">
                        Check <span className="font-semibold">{resetEmail}</span> for a link to set a new password.
                      </p>
                      <button
                        id="back-to-signin"
                        type="button"
                        onClick={() => { setForgotMode(false); setResetSent(false); }}
                        className="text-xs font-semibold text-emerald-300 hover:underline"
                      >
                        Back to sign in
                      </button>
                    </div>
                  ) : (
                    <>
                      {resetError && (
                        <div className="flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-xs text-red-200">
                          <ServerCrash className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{resetError}</span>
                        </div>
                      )}
                      <button
                        id="send-reset-email-btn"
                        type="button"
                        disabled={resetLoading || !resetEmail.trim()}
                        onClick={handleForgotPassword}
                        className={`flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-black shadow-sm transition-all ${
                          resetLoading || !resetEmail.trim()
                            ? "cursor-not-allowed bg-zinc-700 text-zinc-400"
                            : "bg-emerald-400 text-neutral-950 hover:bg-emerald-300"
                        }`}
                      >
                        {resetLoading
                          ? <><div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-950/40 border-t-neutral-950" /> Sending...</>
                          : <><KeyRound className="h-4 w-4" /> Send Reset Email</>}
                      </button>
                    </>
                  )
                ) : (
                  <form id="login-form" onSubmit={handleLogin} className="space-y-4">
                    <div className="relative">
                      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500">
                        <Lock className="h-4 w-4" />
                      </div>
                      <input
                        id="login-password"
                        type="password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full rounded-xl border border-white/10 bg-black/25 py-3 pl-10 pr-4 text-sm font-medium text-white outline-none transition-all placeholder:text-zinc-600 focus:border-emerald-300/60 focus:ring-2 focus:ring-emerald-400/15"
                        placeholder="••••••••••••"
                      />
                    </div>
                    <button
                      id="login-submit-btn"
                      type="submit"
                      disabled={loading}
                      className={`flex w-full items-center justify-center rounded-xl py-3 text-sm font-black shadow-xl transition-all focus:ring-2 focus:ring-emerald-400/30 ${
                        loading ? "cursor-not-allowed bg-zinc-700 text-zinc-400" : "bg-emerald-400 text-neutral-950 shadow-emerald-500/20 hover:bg-emerald-300"
                      }`}
                    >
                      {loading
                        ? <><div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-neutral-950/40 border-t-neutral-950" />Signing in...</>
                        : "Sign In"}
                    </button>
                  </form>
                )}

                <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                  <div className="flex items-center gap-3">
                    <BarChart3 className="h-4 w-4 text-blue-300" />
                    <p className="text-xs font-semibold text-zinc-400">Access is limited based on your assigned role.</p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
