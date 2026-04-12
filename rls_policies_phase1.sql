-- =================================================================================
-- PHASE 1: RLS POLICIES — user_profiles
-- Run AFTER migration_phase1_roles.sql
-- Safe to re-run — all DROP IF EXISTS guards are in place.
-- =================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER FUNCTION: public.is_hq_admin_profile()
--
-- Checks whether the current auth.uid() has an active hq_admin profile row.
-- SECURITY DEFINER: bypasses RLS on user_profiles to prevent infinite recursion
--   when policies on user_profiles themselves call this function.
-- SET search_path = public, auth: prevents search_path injection attacks.
-- Fully qualified as public.user_profiles for safety.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_hq_admin_profile()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE user_id = auth.uid()
      AND role = 'hq_admin'
      AND is_active = true
  );
$$;

-- Lock down execution — only authenticated users may call this function
REVOKE ALL ON FUNCTION public.is_hq_admin_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_hq_admin_profile() TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- POLICIES: user_profiles
--
-- Drop ALL policies before creating — ensures safe re-runs with no duplicates.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Profiles: Read Own"            ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles: HQ Admin Read All"   ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles: HQ Admin Write"      ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles: HQ Admin Insert"     ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles: HQ Admin Update"     ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles: HQ Admin Delete"     ON public.user_profiles;

-- Each authenticated user can read only their own profile row
CREATE POLICY "Profiles: Read Own"
  ON public.user_profiles
  FOR SELECT
  USING (user_id = auth.uid());

-- hq_admin can read ALL profiles (needed for the Users management page)
CREATE POLICY "Profiles: HQ Admin Read All"
  ON public.user_profiles
  FOR SELECT
  USING (public.is_hq_admin_profile());

-- Only hq_admin can insert new profiles
CREATE POLICY "Profiles: HQ Admin Insert"
  ON public.user_profiles
  FOR INSERT
  WITH CHECK (public.is_hq_admin_profile());

-- Only hq_admin can update profiles
CREATE POLICY "Profiles: HQ Admin Update"
  ON public.user_profiles
  FOR UPDATE
  USING (public.is_hq_admin_profile())
  WITH CHECK (public.is_hq_admin_profile());

-- Only hq_admin can delete profiles
CREATE POLICY "Profiles: HQ Admin Delete"
  ON public.user_profiles
  FOR DELETE
  USING (public.is_hq_admin_profile());
