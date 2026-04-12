-- =================================================================================
-- PHASE 2 — STEP 4: RLS Policies for public.counts
-- Enforces strict location-based read/write isolation.
-- hq_admin bypasses all restrictions and sees all rows.
-- Safe to re-run — all DROP IF EXISTS guards in place.
--
-- Depends on: public.get_my_role() and public.get_my_location_id()
-- created in Phase 2 Step 2. If running this file standalone, ensure
-- those functions exist first (rls_phase2_step2_inventory.sql).
-- =================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- ENSURE SCALAR HELPERS EXIST
-- Re-declare here so this file is self-contained. CREATE OR REPLACE is safe
-- if they already exist from Step 2.
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

ALTER TABLE public.counts ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────────────────
-- DROP EXISTING POLICIES (safe re-run)
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Counts: Select by location"  ON public.counts;
DROP POLICY IF EXISTS "Counts: Insert by location"  ON public.counts;
DROP POLICY IF EXISTS "Counts: Update by location"  ON public.counts;
DROP POLICY IF EXISTS "Counts: Delete by location"  ON public.counts;


-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT
-- hq_admin sees all rows.
-- location_manager sees only rows matching their assigned location_id.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "Counts: Select by location"
  ON public.counts
  FOR SELECT
  USING (
    public.get_my_role() = 'hq_admin'
    OR
    counts.location_id = public.get_my_location_id()
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- INSERT
-- hq_admin may insert rows for any location.
-- location_manager may only insert rows for their own location_id.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "Counts: Insert by location"
  ON public.counts
  FOR INSERT
  WITH CHECK (
    public.get_my_role() = 'hq_admin'
    OR
    counts.location_id = public.get_my_location_id()
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATE
-- Both USING and WITH CHECK enforced — prevents moving a row to a
-- location_id the user does not own.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "Counts: Update by location"
  ON public.counts
  FOR UPDATE
  USING (
    public.get_my_role() = 'hq_admin'
    OR
    counts.location_id = public.get_my_location_id()
  )
  WITH CHECK (
    public.get_my_role() = 'hq_admin'
    OR
    counts.location_id = public.get_my_location_id()
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- DELETE
-- hq_admin may delete any row.
-- location_manager may only delete rows belonging to their location.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "Counts: Delete by location"
  ON public.counts
  FOR DELETE
  USING (
    public.get_my_role() = 'hq_admin'
    OR
    counts.location_id = public.get_my_location_id()
  );
