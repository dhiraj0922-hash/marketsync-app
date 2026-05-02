-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: requisitions RLS
--
-- Context:
--   migration_phase3_step1_requisitions.sql added structural columns
--   (location_id FK, created_by UUID, updated_at) but explicitly noted
--   "Additive only. Idempotent. No RLS." This migration adds the missing
--   RLS policies using the two canonical SECURITY DEFINER helpers that are
--   already deployed and proven across inventory_items, orders, and suppliers:
--
--     public.is_hq_admin_profile()          → TRUE for hq_admin
--     public.is_location_manager_for(TEXT)  → TRUE for location_manager
--                                              whose location_id matches arg
--
-- Access model:
--   SELECT  hq_admin sees all rows.
--           location_manager sees only rows where location_id = their location.
--           Rows with location_id IS NULL (old rows where backfill was skipped)
--           are visible to hq_admin only — is_location_manager_for(NULL)
--           always returns FALSE.
--
--   INSERT  hq_admin may create requisitions for any location.
--           location_manager may only create requisitions for their own
--           location_id — WITH CHECK enforces the stamp matches their profile.
--
--   UPDATE  Both roles may update requisitions within their allowed scope
--           (location_manager: their own location only).
--           This allows location_manager to submit a Draft → Submitted, add
--           notes, etc.
--           hq_admin can update any requisition (approve, reject, fulfill).
--           USING prevents selecting a row outside scope for update.
--           WITH CHECK prevents moving a row to a different location_id.
--
--   DELETE  hq_admin only. location_manager cannot delete requisitions.
--
-- Safe to re-run — all DROP IF EXISTS guarded.
-- Run in Supabase SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Step 0: Re-declare helpers (self-contained, idempotent) ──────────────────
--
-- These functions already exist in production. Re-declared here so this script
-- is fully self-contained and safe to run on a fresh project or after a rollback.

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


-- ── Step 1: Drop all existing requisitions policies ──────────────────────────

DROP POLICY IF EXISTS "Requisitions: Read by Role"         ON public.requisitions;
DROP POLICY IF EXISTS "Requisitions: Write by Role"        ON public.requisitions;
DROP POLICY IF EXISTS "Requisitions: Delete by Role"       ON public.requisitions;
-- Legacy names from earlier attempts (defensive)
DROP POLICY IF EXISTS "Requisitions: Select by location"   ON public.requisitions;
DROP POLICY IF EXISTS "Requisitions: Insert by location"   ON public.requisitions;
DROP POLICY IF EXISTS "Requisitions: Update by location"   ON public.requisitions;
DROP POLICY IF EXISTS "Requisitions: Delete by location"   ON public.requisitions;
DROP POLICY IF EXISTS "Requisitions: HQ full access"       ON public.requisitions;
DROP POLICY IF EXISTS "Requisitions: Location read"        ON public.requisitions;
DROP POLICY IF EXISTS "Requisitions: Location write"       ON public.requisitions;


-- ── Step 2: Enable RLS (idempotent) ─────────────────────────────────────────

ALTER TABLE public.requisitions ENABLE ROW LEVEL SECURITY;


-- ── Step 3: SELECT ───────────────────────────────────────────────────────────
--
-- hq_admin sees all rows.
-- location_manager sees only rows where requisitions.location_id matches
-- their own location_id in user_profiles.
-- Rows where location_id IS NULL (backfill was skipped in Phase 3) are
-- invisible to location_manager — only hq_admin can access them.

CREATE POLICY "Requisitions: Read by Role"
  ON public.requisitions
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(requisitions.location_id)
  );


-- ── Step 4: INSERT ───────────────────────────────────────────────────────────
--
-- hq_admin may insert requisitions for any location.
-- location_manager may only insert rows stamped with their own location_id.
-- WITH CHECK (not USING) because INSERT has no pre-existing row.

CREATE POLICY "Requisitions: Insert by Role"
  ON public.requisitions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(requisitions.location_id)
  );


-- ── Step 5: UPDATE ───────────────────────────────────────────────────────────
--
-- USING:      controls which existing rows the user can select for update.
-- WITH CHECK: controls what the updated row must look like after the write.
--
-- Together they ensure:
--   - A location_manager can only update their own location's requisitions.
--   - A location_manager cannot re-stamp a requisition to a different location_id.
--   - hq_admin can update any row (approve, reject, fulfill).

CREATE POLICY "Requisitions: Update by Role"
  ON public.requisitions
  FOR UPDATE
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(requisitions.location_id)
  )
  WITH CHECK (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(requisitions.location_id)
  );


-- ── Step 6: DELETE ───────────────────────────────────────────────────────────
--
-- Only hq_admin may delete requisitions.
-- location_manager should not be able to silently delete a submitted or
-- approved requisition.

CREATE POLICY "Requisitions: Delete by Role"
  ON public.requisitions
  FOR DELETE
  TO authenticated
  USING (
    public.is_hq_admin_profile()
  );


-- ── Step 7: Verify ───────────────────────────────────────────────────────────

-- Should show exactly 4 policies: Read, Insert, Update, Delete
SELECT policyname, cmd, roles
FROM pg_policies
WHERE tablename = 'requisitions'
ORDER BY policyname;

-- Should show 2 functions with security_type = 'DEFINER'
SELECT routine_name, security_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('is_hq_admin_profile', 'is_location_manager_for')
ORDER BY routine_name;
