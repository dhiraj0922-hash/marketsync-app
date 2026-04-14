"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { Factory, Lock, Mail, ServerCrash, KeyRound, CheckCircle2 } from "lucide-react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const router = useRouter();

  // ─ Forgot password state ──────────────────────────────────────────────────
  const [forgotMode, setForgotMode]     = useState(false);
  const [resetEmail, setResetEmail]     = useState("");
  const [resetSent, setResetSent]       = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError]     = useState<string | null>(null);

  // ─ Handlers ───────────────────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) setError(authError.message);
      else if (data.session) router.push("/");
    } catch {
      setError("An unexpected network error occurred.");
    } finally {
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
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-neutral-100 overflow-hidden">

        {/* Header */}
        <div className="p-8 pb-6 border-b border-neutral-100 bg-neutral-50/50 flex flex-col items-center">
          <h2 className="text-2xl font-bold text-neutral-900 tracking-tight">StockIQ</h2>
          <p className="text-sm text-neutral-500 mt-1">Sign in to your account</p>
        </div>

        {/* Body */}
        <div className="p-8 space-y-5">

          {/* Sign-in error */}
          {error && !forgotMode && (
            <div className="p-3 bg-danger-50 border border-danger-100 rounded-lg text-danger-600 text-sm flex items-start gap-2">
              <ServerCrash className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Email field — always visible */}
          <div className="space-y-1">
            <label className="text-xs font-bold text-neutral-600 uppercase tracking-widest pl-1">
              Email
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-400">
                <Mail className="h-4 w-4" />
              </div>
              <input
                id="login-email"
                type="email"
                required
                value={forgotMode ? resetEmail : email}
                onChange={e => forgotMode ? setResetEmail(e.target.value) : setEmail(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-neutral-50 border border-neutral-200 rounded-lg text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 transition-all font-medium placeholder-neutral-400"
                placeholder={forgotMode ? "your-email@example.com" : "admin@hq.com"}
              />
            </div>
          </div>

          {/* Security Clearance label + Forgot password toggle */}
          <div className="flex items-center justify-between pl-1 pr-1">
            <label className="text-xs font-bold text-neutral-600 uppercase tracking-widest">
              {forgotMode ? "Password Reset" : "Password"}
            </label>
            <button
              id="forgot-password-toggle"
              type="button"
              onClick={() => { setForgotMode(f => !f); setResetSent(false); setResetError(null); }}
              className="text-[11px] font-medium text-brand-600 hover:text-brand-700 hover:underline transition-colors"
            >
              {forgotMode ? "← Back to sign in" : "Forgot password?"}
            </button>
          </div>

          {/* ── Branch: forgot mode ───────────────────────────────────────────── */}
          {forgotMode ? (
            resetSent ? (
              // Confirmation state
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="h-11 w-11 rounded-full bg-success-100 flex items-center justify-center">
                  <CheckCircle2 className="h-6 w-6 text-success-600" />
                </div>
                <p className="text-sm font-bold text-neutral-900">Reset email sent</p>
                <p className="text-xs text-neutral-500 text-center">
                  Check <span className="font-semibold">{resetEmail}</span> for a link to set a new password.
                </p>
                <button
                  id="back-to-signin"
                  type="button"
                  onClick={() => { setForgotMode(false); setResetSent(false); }}
                  className="text-xs font-semibold text-brand-600 hover:underline"
                >
                  Back to sign in
                </button>
              </div>
            ) : (
              // Reset form
              <>
                {resetError && (
                  <div className="p-3 bg-danger-50 border border-danger-100 rounded-lg text-danger-600 text-xs flex items-start gap-2">
                    <ServerCrash className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{resetError}</span>
                  </div>
                )}
                <button
                  id="send-reset-email-btn"
                  type="button"
                  disabled={resetLoading || !resetEmail.trim()}
                  onClick={handleForgotPassword}
                  className={`w-full py-2.5 rounded-lg text-sm font-bold text-white shadow-sm transition-all flex items-center justify-center gap-2 ${
                    resetLoading || !resetEmail.trim()
                      ? "bg-neutral-400 cursor-not-allowed"
                      : "bg-brand-600 hover:bg-brand-700"
                  }`}
                >
                  {resetLoading
                    ? <><div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Sending…</>
                    : <><KeyRound className="h-4 w-4" /> Send Reset Email</>}
                </button>
              </>
            )
          ) : (
            // ── Normal sign-in: password + submit ─────────────────────────────
            <form id="login-form" onSubmit={handleLogin} className="space-y-4">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-400">
                  <Lock className="h-4 w-4" />
                </div>
                <input
                  id="login-password"
                  type="password"
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-neutral-50 border border-neutral-200 rounded-lg text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 transition-all font-medium placeholder-neutral-400"
                  placeholder="••••••••••••"
                />
              </div>
              <button
                id="login-submit-btn"
                type="submit"
                disabled={loading}
                className={`w-full py-2.5 rounded-lg text-sm font-bold text-white shadow-sm transition-all focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 flex items-center justify-center ${
                  loading ? "bg-neutral-400 cursor-not-allowed" : "bg-brand-600 hover:bg-brand-700 hover:shadow-md"
                }`}
              >
                {loading
                  ? <><div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>Validating Node...</>
                  : "Sign In"}
              </button>
            </form>
          )}

          <div className="mt-2 text-center text-xs font-medium text-neutral-400">
            Access is limited based on your assigned role.
          </div>
        </div>
      </div>
    </div>
  );
}
