-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Suppliers RLS — allow authenticated location_manager users
-- to SELECT from suppliers (HQ master read) but never INSERT/UPDATE/DELETE.
--
-- Context:
--   The existing "Suppliers: Operational Read" policy in rls_policies.sql
--   uses get_session_role() which reads from system_users (legacy table).
--   Users created via user_profiles (Phase 1) have role stored there, not
--   in system_users, so get_session_role() may return NULL for them,
--   causing the SELECT policy to fail and loadSuppliers() to return [].
--
-- Fix:
--   Add a separate permissive SELECT policy that allows any authenticated
--   user to read suppliers. Suppliers are global HQ master data — there is
--   no security reason to hide them from authenticated location users.
--
--   The existing write policy already blocks location_manager INSERTs.
--   resolveSupplier() in the application layer now also refuses to INSERT,
--   so defence is layered (DB + app).
--
-- Run in Supabase SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: Drop the old restrictive read policy
DROP POLICY IF EXISTS "Suppliers: Operational Read" ON public.suppliers;

-- Step 2: Replace with a universal authenticated read
-- Any signed-in user may read the supplier master list.
-- Writes remain restricted to HQ / Finance by the existing write policy.
CREATE POLICY "Suppliers: Authenticated Read"
  ON public.suppliers
  FOR SELECT
  TO authenticated
  USING (true);

-- Step 3: Ensure the write policy still blocks location_manager inserts.
-- (This is the existing policy from rls_policies.sql — re-stated here for clarity.
--  Do NOT re-run this if it already exists. Safe to re-run with DROP IF EXISTS guard.)
DROP POLICY IF EXISTS "Suppliers: Operations Write"   ON public.suppliers;
DROP POLICY IF EXISTS "Suppliers: HQ Write"           ON public.suppliers;

CREATE POLICY "Suppliers: HQ Write"
  ON public.suppliers
  FOR ALL
  TO authenticated
  USING (
    public.is_hq_admin_profile()
  )
  WITH CHECK (
    public.is_hq_admin_profile()
  );

-- Step 4: Verify
-- Should return all suppliers for any authenticated session.
SELECT id, name, status FROM public.suppliers ORDER BY name LIMIT 20;

-- The following should return 0 rows (no auto-created junk from failed imports):
SELECT id, name, status FROM public.suppliers WHERE status = 'Auto-created';
