-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Orders RLS — SECURITY DEFINER fix
-- Run in Supabase SQL Editor AFTER migration_orders_rls.sql
-- Safe to re-run — all DROP IF EXISTS guarded
--
-- Root cause (confirmed):
--   The "Orders: Write by Role" policy checks location_manager access via a
--   plain EXISTS subquery against user_profiles inside the policy USING/WITH CHECK.
--   This plain subquery runs under the caller's RLS context. Even though
--   "Profiles: Read Own" (user_id = auth.uid()) should allow the read, RLS
--   evaluation of a subquery inside a policy can recursively re-evaluate policies,
--   causing unpredictable results in some Supabase/PostgreSQL versions.
--
-- Fix:
--   Replace the inline EXISTS subquery with a SECURITY DEFINER helper function
--   (same pattern as is_hq_admin_profile) that bypasses RLS on user_profiles.
--   This makes the check deterministic and identical to how is_hq_admin_profile works.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Step 1: Create SECURITY DEFINER helper for location_manager location check ─
--
-- Checks whether auth.uid() is an active location_manager for a given location_id.
-- SECURITY DEFINER: bypasses RLS on user_profiles (same as is_hq_admin_profile).
-- This prevents recursive/uncertain RLS evaluation inside policy expressions.
--
CREATE OR REPLACE FUNCTION public.is_location_manager_for(check_location_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE user_id    = auth.uid()
      AND role       = 'location_manager'
      AND is_active  = true
      AND location_id = check_location_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_location_manager_for(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_location_manager_for(TEXT) TO authenticated;


-- ── Step 2: Drop and recreate both orders policies using the SECURITY DEFINER helper ─

DROP POLICY IF EXISTS "Orders: Read by Role"  ON public.orders;
DROP POLICY IF EXISTS "Orders: Write by Role" ON public.orders;


-- READ: hq_admin unrestricted; location_manager scoped to own location_id
CREATE POLICY "Orders: Read by Role"
  ON public.orders
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(orders.location_id)
  );


-- WRITE (INSERT / UPDATE / DELETE):
-- USING: checks existing row ownership (for UPDATE/DELETE)
-- WITH CHECK: checks new row values (for INSERT/UPDATE)
-- Both use SECURITY DEFINER functions — no recursive RLS evaluation
CREATE POLICY "Orders: Write by Role"
  ON public.orders
  FOR ALL
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(orders.location_id)
  )
  WITH CHECK (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(orders.location_id)
  );


-- ── Step 3: Verify ─────────────────────────────────────────────────────────────
-- Check policies
SELECT policyname, cmd, qual
FROM pg_policies
WHERE tablename = 'orders'
ORDER BY policyname;

-- Check function exists
SELECT routine_name, security_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('is_hq_admin_profile', 'is_location_manager_for');
