import { createClient } from "@supabase/supabase-js";

const supabaseUrl     = process.env.NEXT_PUBLIC_SUPABASE_URL     ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

if (!supabaseUrl || !supabaseAnonKey) {
  // This fires in the browser console on production if env vars are missing from Vercel.
  // Check: Vercel → Project → Settings → Environment Variables.
  console.error(
    "[supabase] NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is missing. " +
    "Auth will hang indefinitely. Add both variables to your Vercel Environment Variables and redeploy."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Persist session in localStorage (default). Explicitly declared so behaviour
    // is clear and not affected by future supabase-js defaults changes.
    persistSession: true,
    // Do NOT attempt to detect OAuth tokens in the URL on every page load —
    // this is only needed on the /auth/callback route and adds latency elsewhere.
    detectSessionInUrl: false,
    // Automatically refresh the access token before it expires.
    autoRefreshToken: true,
  },
});

/** True if the Supabase client was created with valid credentials. */
export const supabaseConfigured = !!(supabaseUrl && supabaseAnonKey);
