-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: inventory_items RLS — Modernize to user_profiles-based helpers
--
-- Root cause:
--   rls_phase2_step2_inventory.sql introduced get_my_role() and
--   get_my_location_id() — scalar SECURITY DEFINER functions that look up
--   user_profiles. However, calling them inside a policy USING clause causes
--   Postgres to re-evaluate RLS on user_profiles per-row during query
--   execution. In Supabase/Postgres 15+ this can silently return NULL instead
--   of raising an error, making every policy check evaluate to FALSE.
--   Result: loadInventory() returns zero rows and the browser shows "{}".
--
--   This is the EXACT same bug that was fixed for orders (via
--   migration_orders_rls_v2.sql) and suppliers. The fix is identical: replace
--   inline subquery helpers with the two canonical SECURITY DEFINER functions
--   that are already deployed and proven:
--     public.is_hq_admin_profile()          — returns TRUE for hq_admin
--     public.is_location_manager_for(TEXT)  — returns TRUE for location_manager
--                                              whose location_id matches arg
--
-- Safe to re-run — all DROP IF EXISTS guarded.
-- Run in Supabase SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Step 0: Ensure helper functions exist (idempotent) ────────────────────────
--
-- is_hq_admin_profile() was created in migration_phase1_roles.sql / rls_policies.sql
-- is_location_manager_for() was created in migration_orders_rls_v2.sql
--
-- Re-create both here so this script is fully self-contained and safe to run
-- on a fresh project or after a rollback.

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
    WHERE user_id  = auth.uid()
      AND role     = 'hq_admin'
      AND is_active = true
  );
$$;

REVOKE ALL ON FUNCTION public.is_hq_admin_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_hq_admin_profile() TO authenticated;


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


-- ── Step 1: Drop ALL existing inventory_items policies ────────────────────────
--
-- Drops both the legacy (get_my_role / get_my_location) style and any
-- previously named variants so we start clean.

DROP POLICY IF EXISTS "Inventory: Select by location"       ON public.inventory_items;
DROP POLICY IF EXISTS "Inventory: Insert by location"       ON public.inventory_items;
DROP POLICY IF EXISTS "Inventory: Update by location"       ON public.inventory_items;
DROP POLICY IF EXISTS "Inventory: Delete by location"       ON public.inventory_items;
-- Legacy names from rls_policies.sql / rls_phase2_step2_inventory.sql
DROP POLICY IF EXISTS "Inventory: HQ full access"           ON public.inventory_items;
DROP POLICY IF EXISTS "Inventory: Location read"            ON public.inventory_items;
DROP POLICY IF EXISTS "Inventory: Location write"           ON public.inventory_items;
DROP POLICY IF EXISTS "Inventory: Read by Role"             ON public.inventory_items;
DROP POLICY IF EXISTS "Inventory: Write by Role"            ON public.inventory_items;


-- ── Step 2: Re-enable RLS (idempotent — no-op if already enabled) ────────────

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;


-- ── Step 3: SELECT ────────────────────────────────────────────────────────────
--
-- hq_admin   → sees all rows (unrestricted)
-- location_manager → sees only rows where inventory_items.location_id
--                    matches their own location_id in user_profiles
--
-- is_location_manager_for() passes the ROW's location_id as argument,
-- so the function checks: does the current user own THAT location?
-- This is the same pattern used by the working orders policy.

CREATE POLICY "Inventory: Read by Role"
  ON public.inventory_items
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(inventory_items.location_id)
  );


-- ── Step 4: INSERT ────────────────────────────────────────────────────────────
--
-- WITH CHECK only (no USING needed for INSERT — there is no pre-existing row).
-- hq_admin may insert for any location.
-- location_manager may only insert rows stamped with their own location_id.

CREATE POLICY "Inventory: Write by Role"
  ON public.inventory_items
  FOR ALL
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(inventory_items.location_id)
  )
  WITH CHECK (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(inventory_items.location_id)
  );


-- ── Step 5: Verify ────────────────────────────────────────────────────────────

-- Should show exactly 2 policies: "Inventory: Read by Role", "Inventory: Write by Role"
SELECT policyname, cmd, roles, qual
FROM pg_policies
WHERE tablename = 'inventory_items'
ORDER BY policyname;

-- Should show 2 functions with security_type = 'DEFINER'
SELECT routine_name, security_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('is_hq_admin_profile', 'is_location_manager_for')
ORDER BY routine_name;
