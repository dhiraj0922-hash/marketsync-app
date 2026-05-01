-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: production_plans RLS
--
-- Context:
--   production_plans was created in init.sql with RLS explicitly disabled.
--   No subsequent migration added RLS. The table has a freetext `location`
--   column (e.g. 'System Generated', 'Main HQ') — not a location_id FK —
--   so it cannot be used directly with is_location_manager_for().
--
--   This migration:
--     1. Adds a `location_id` column (TEXT, nullable) to production_plans.
--     2. Backfills location_id = 'LOC-HQ' for existing rows (all current
--        plans are HQ-generated — this is safe).
--     3. Applies RLS policies using the canonical SECURITY DEFINER helpers.
--
-- Access model:
--   SELECT  hq_admin sees all rows.
--           location_manager sees only rows where location_id = their location.
--           Rows with location_id IS NULL (future edge case) are hq_admin only.
--
--   INSERT  hq_admin only. The automation engine (runAutomationEngine) always
--           runs in the browser session of an hq_admin. A location_manager
--           cannot trigger plan creation.
--
--   UPDATE  hq_admin only. Approving, rejecting, or changing plan status
--           ("Approved", "Rejected", "In Production", "Completed") must
--           only be done by HQ.
--
--   DELETE  hq_admin only.
--
-- Why location_manager cannot INSERT/UPDATE/DELETE production_plans:
--   Production plans represent HQ-level commitments: raw ingredient
--   deductions, production runs, and downstream PO generation. A
--   location_manager approving or creating their own plans would bypass
--   the HQ review workflow entirely.
--
-- Safe to re-run — all DROP IF EXISTS and ADD COLUMN IF NOT EXISTS guarded.
-- Run in Supabase SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Step 0: Re-declare helpers (self-contained, idempotent) ──────────────────

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


-- ── Step 1: Add location_id column to production_plans ───────────────────────
--
-- production_plans.location is a freetext label, not a location FK.
-- We add a proper location_id column and backfill it so RLS has a
-- reliable FK-style value to scope against.
--
-- Nullable because: automation may generate plans before a specific
-- location is assigned (e.g. cross-location HQ plans).
-- Those rows will be visible to hq_admin only (NULL fails the
-- is_location_manager_for() check by design).

ALTER TABLE public.production_plans
  ADD COLUMN IF NOT EXISTS location_id TEXT NULL
    REFERENCES public.locations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.production_plans.location_id IS
  'FK to locations.id. Added by migration_production_plans_rls.sql. '
  'Controls RLS visibility: location_manager sees only their location. '
  'Backfilled to LOC-HQ for all pre-migration HQ-generated rows.';


-- ── Step 2: Backfill location_id for all existing rows ───────────────────────
--
-- All pre-existing production plans were created by the HQ automation engine
-- (automation.ts sets location = "System Generated" or "Main HQ").
-- Backfill location_id = 'LOC-HQ' so they remain visible to hq_admin after
-- RLS is enabled, and are correctly scoped as HQ plans.
--
-- Only updates rows where location_id IS NULL (idempotent).
-- Only assigns LOC-HQ if that location exists in the locations table.

DO $$
DECLARE
  hq_exists BOOLEAN;
  updated_count INT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.locations WHERE id = 'LOC-HQ'
  ) INTO hq_exists;

  IF hq_exists THEN
    UPDATE public.production_plans
       SET location_id = 'LOC-HQ'
     WHERE location_id IS NULL;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE 'Backfill: % production_plans row(s) set to LOC-HQ.', updated_count;
  ELSE
    RAISE WARNING
      'LOC-HQ not found in locations table. '
      'Backfill skipped — existing rows will have location_id = NULL and '
      'will only be visible to hq_admin after RLS is enabled. '
      'ACTION REQUIRED: ensure LOC-HQ exists in the locations table, '
      'then re-run this migration.';
  END IF;
END $$;


-- ── Step 3: Drop all existing production_plans policies ──────────────────────

DROP POLICY IF EXISTS "Production Plans: Read by Role"   ON public.production_plans;
DROP POLICY IF EXISTS "Production Plans: Write by Role"  ON public.production_plans;
DROP POLICY IF EXISTS "Production Plans: HQ full access" ON public.production_plans;
DROP POLICY IF EXISTS "Production Plans: Location read"  ON public.production_plans;
-- Defensive catch-all for any other legacy names
DROP POLICY IF EXISTS "Plans: Select by location"        ON public.production_plans;
DROP POLICY IF EXISTS "Plans: Insert by location"        ON public.production_plans;
DROP POLICY IF EXISTS "Plans: Update by location"        ON public.production_plans;
DROP POLICY IF EXISTS "Plans: Delete by location"        ON public.production_plans;


-- ── Step 4: Enable RLS ───────────────────────────────────────────────────────

ALTER TABLE public.production_plans ENABLE ROW LEVEL SECURITY;


-- ── Step 5: SELECT ───────────────────────────────────────────────────────────
--
-- hq_admin sees all rows.
-- location_manager sees only rows where location_id matches their location.
-- Rows with location_id IS NULL (edge case, shouldn't exist after backfill)
-- are visible to hq_admin only.

CREATE POLICY "Production Plans: Read by Role"
  ON public.production_plans
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(production_plans.location_id)
  );


-- ── Step 6: INSERT — hq_admin only ──────────────────────────────────────────
--
-- Only hq_admin (or the automation engine running as hq_admin) may create
-- production plans. location_manager cannot create plans directly.

CREATE POLICY "Production Plans: Insert HQ Only"
  ON public.production_plans
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_hq_admin_profile()
  );


-- ── Step 7: UPDATE — hq_admin only ──────────────────────────────────────────
--
-- Only hq_admin may update production plans (approve, reject, change status,
-- assign production staff, mark complete).
-- location_manager has no update capability — they can only read plans for
-- their location via the SELECT policy.

CREATE POLICY "Production Plans: Update HQ Only"
  ON public.production_plans
  FOR UPDATE
  TO authenticated
  USING (
    public.is_hq_admin_profile()
  )
  WITH CHECK (
    public.is_hq_admin_profile()
  );


-- ── Step 8: DELETE — hq_admin only ──────────────────────────────────────────

CREATE POLICY "Production Plans: Delete HQ Only"
  ON public.production_plans
  FOR DELETE
  TO authenticated
  USING (
    public.is_hq_admin_profile()
  );


-- ── Step 9: Verify ───────────────────────────────────────────────────────────

-- Should show exactly 4 policies: Read, Insert HQ Only, Update HQ Only, Delete HQ Only
SELECT policyname, cmd, roles
FROM pg_policies
WHERE tablename = 'production_plans'
ORDER BY policyname;

-- Confirm location_id column exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'production_plans'
  AND column_name  = 'location_id';

-- Confirm backfill: should show 0 rows with location_id IS NULL (if LOC-HQ exists)
SELECT COUNT(*) AS null_location_id_count
FROM public.production_plans
WHERE location_id IS NULL;
