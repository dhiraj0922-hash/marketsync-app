-- =================================================================================
-- PHASE 2 — STEP 2: RLS Policies for inventory_items
-- Enforces strict location-based read/write isolation.
-- hq_admin bypasses all restrictions and sees all rows.
-- Safe to re-run — all DROP IF EXISTS guards in place.
-- =================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- DROP HELPER FUNCTIONS (safe re-run)
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_my_role();
DROP FUNCTION IF EXISTS public.get_my_location_id();


-- ─────────────────────────────────────────────────────────────────────────────
-- SCALAR HELPER FUNCTIONS
--
-- Calling get_my_profile() (a set-returning function) inline inside a policy
-- USING clause would execute per-row. We wrap it in two thin scalar
-- SECURITY DEFINER functions so the DB can cache the result within a query.
-- Both functions are locked to authenticated users only.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT role
  FROM public.user_profiles
  WHERE user_id = auth.uid()
    AND is_active = true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_my_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;


CREATE OR REPLACE FUNCTION public.get_my_location_id()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT location_id
  FROM public.user_profiles
  WHERE user_id = auth.uid()
    AND is_active = true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_my_location_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_location_id() TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- ENABLE RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────────────────
-- DROP EXISTING POLICIES (safe re-run)
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Inventory: Select by location"  ON public.inventory_items;
DROP POLICY IF EXISTS "Inventory: Insert by location"  ON public.inventory_items;
DROP POLICY IF EXISTS "Inventory: Update by location"  ON public.inventory_items;
DROP POLICY IF EXISTS "Inventory: Delete by location"  ON public.inventory_items;


-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT
-- hq_admin sees all rows.
-- location_manager sees only rows matching their assigned location_id.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "Inventory: Select by location"
  ON public.inventory_items
  FOR SELECT
  USING (
    public.get_my_role() = 'hq_admin'
    OR
    inventory_items.location_id = public.get_my_location_id()
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- INSERT
-- hq_admin may insert rows for any location.
-- location_manager may only insert rows for their own location_id.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "Inventory: Insert by location"
  ON public.inventory_items
  FOR INSERT
  WITH CHECK (
    public.get_my_role() = 'hq_admin'
    OR
    inventory_items.location_id = public.get_my_location_id()
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATE
-- hq_admin may update any row.
-- location_manager may only update rows belonging to their location.
-- Both USING (which rows are visible to update) and WITH CHECK (what the
-- updated row must look like) are enforced so a user cannot move a row
-- to a different location_id they do not own.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "Inventory: Update by location"
  ON public.inventory_items
  FOR UPDATE
  USING (
    public.get_my_role() = 'hq_admin'
    OR
    inventory_items.location_id = public.get_my_location_id()
  )
  WITH CHECK (
    public.get_my_role() = 'hq_admin'
    OR
    inventory_items.location_id = public.get_my_location_id()
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- DELETE
-- hq_admin may delete any row.
-- location_manager may only delete rows belonging to their location.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "Inventory: Delete by location"
  ON public.inventory_items
  FOR DELETE
  USING (
    public.get_my_role() = 'hq_admin'
    OR
    inventory_items.location_id = public.get_my_location_id()
  );
