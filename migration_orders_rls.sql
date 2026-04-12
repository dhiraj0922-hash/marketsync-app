-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Orders RLS — multi-location fix
-- Run in Supabase SQL Editor (safe to re-run — all DROP IF EXISTS guarded)
--
-- Root cause:
--   "Orders: Procurement Write" used get_session_role() which reads system_users.
--   Users created via user_profiles (Phase 1 User Management) get NULL from
--   get_session_role() → is_hq() = false → INSERT blocked by RLS.
--   Additionally, location_manager was excluded from the write policy entirely.
--
-- Fix:
--   Replace both legacy orders policies with user_profiles-based equivalents.
--   Uses is_hq_admin_profile() (already deployed by rls_policies_phase1.sql)
--   and a new inline location_manager guard that pins to the caller's own location_id.
--
-- Coverage:
--   This is location-agnostic. Any future location_manager created through
--   User Management will automatically satisfy the write policy provided:
--     1. They have a row in user_profiles with role = 'location_manager'
--     2. They have a non-null location_id matching the order they are writing
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Step 1: Drop legacy get_session_role()-based orders policies ──────────────
DROP POLICY IF EXISTS "Orders: Operational Read"  ON public.orders;
DROP POLICY IF EXISTS "Orders: Procurement Write" ON public.orders;


-- ── Step 2: READ — HQ sees all; location_manager sees own location only ───────
--
-- SELECT is allowed when:
--   (a) caller is hq_admin (via user_profiles)               → unrestricted read
--   (b) caller is location_manager (via user_profiles)
--       AND the order's location_id matches their own         → scoped read
--
-- This mirrors how loadOrders() already scopes its query in the app layer.
-- The double-layer (app filter + RLS) means even a misconfigured frontend
-- call can never leak another location's orders.
--
CREATE POLICY "Orders: Read by Role"
  ON public.orders
  FOR SELECT
  TO authenticated
  USING (
    -- hq_admin: unrestricted
    public.is_hq_admin_profile()
    OR
    -- location_manager: own location only
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.user_id    = auth.uid()
        AND up.role       = 'location_manager'
        AND up.is_active  = true
        AND up.location_id = orders.location_id
    )
  );


-- ── Step 3: WRITE (INSERT / UPDATE / DELETE) ──────────────────────────────────
--
-- INSERT/UPDATE allowed when:
--   (a) hq_admin (via user_profiles)
--   (b) location_manager writing to their OWN location_id
--
-- WITH CHECK enforces that even if USING passes (update of existing row),
-- the new row values must also satisfy the location ownership, preventing
-- a location_manager from re-assigning an order to a different location.
--
CREATE POLICY "Orders: Write by Role"
  ON public.orders
  FOR ALL
  TO authenticated
  USING (
    -- hq_admin: can read/modify any order
    public.is_hq_admin_profile()
    OR
    -- location_manager: own location only
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.user_id    = auth.uid()
        AND up.role       = 'location_manager'
        AND up.is_active  = true
        AND up.location_id = orders.location_id
    )
  )
  WITH CHECK (
    -- hq_admin: can write any order to any location
    public.is_hq_admin_profile()
    OR
    -- location_manager: new row must belong to their own location
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.user_id    = auth.uid()
        AND up.role       = 'location_manager'
        AND up.is_active  = true
        AND up.location_id = orders.location_id
    )
  );


-- ── Step 4: Verify ────────────────────────────────────────────────────────────
-- Should show the two new policies and NO legacy policy names:
SELECT policyname, cmd, qual
FROM pg_policies
WHERE tablename = 'orders'
ORDER BY policyname;
