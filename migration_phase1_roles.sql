-- =================================================================================
-- PHASE 1: ROLE & LOCATION FOUNDATION MIGRATION
-- Run this in your Supabase SQL Editor (safe to run multiple times — all additive)
-- =================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Patch locations table (ADDITIVE ONLY — keeps TEXT primary key)
-- ─────────────────────────────────────────────────────────────────────────────

-- Add is_active boolean column if not present
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Normalize ALL rows from the existing status column.
-- No WHERE clause — we update every row to ensure consistent state.
UPDATE locations
  SET is_active = (status IS DISTINCT FROM 'Inactive');

-- Nothing to ADD for type — the column already exists as TEXT.
-- Enforcement is done via trigger in STEP 5 below.

COMMENT ON TABLE locations IS
  'Phase 1: is_active added. TYPE check enforced via trigger. UUID PK and UNIQUE code deferred to Phase 2.';


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Create user_profiles table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID    UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name    TEXT,
  role         TEXT    NOT NULL CHECK (role IN ('hq_admin', 'location_manager')),
  -- location_id stays TEXT to match the existing locations.id TEXT PK.
  -- Will be changed to UUID FK once locations migrates to UUID in Phase 2.
  location_id  TEXT    NULL REFERENCES public.locations(id) ON DELETE SET NULL,
  is_active    BOOLEAN DEFAULT true,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE public.user_profiles IS
  'Phase 1: Auth-linked user role and location assignment. location_id is TEXT FK matching locations.id until Phase 2 UUID migration.';
COMMENT ON COLUMN public.user_profiles.role IS
  'Phase 1 roles: hq_admin (full access, null location_id allowed) or location_manager (must have location_id).';


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: updated_at auto-trigger
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop if exists first so re-runs are safe
DROP TRIGGER IF EXISTS user_profiles_set_updated_at ON public.user_profiles;
CREATE TRIGGER user_profiles_set_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: Business rule — location_manager must have a location_id
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_location_manager_has_location()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role = 'location_manager' AND NEW.location_id IS NULL THEN
    RAISE EXCEPTION
      'A location_manager must be assigned to a location. Set location_id before saving.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS check_location_manager_location ON public.user_profiles;
CREATE TRIGGER check_location_manager_location
  BEFORE INSERT OR UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_location_manager_has_location();


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: locations type validation trigger (Phase 1 — replaces CHECK constraint)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_location_type()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.type IS NOT NULL AND NEW.type NOT IN ('hq', 'branch', 'warehouse') THEN
    RAISE EXCEPTION
      'locations.type must be one of: hq, branch, warehouse. Got: %', NEW.type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS check_location_type ON public.locations;
CREATE TRIGGER check_location_type
  BEFORE INSERT OR UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_location_type();


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 6: get_my_profile() — safe helper function for app-side use
-- ─────────────────────────────────────────────────────────────────────────────
-- Returns the current authenticated user's profile in one call.
-- SECURITY DEFINER bypasses RLS so it can read user_profiles without recursion.
-- SET search_path = public, auth prevents search_path injection attacks.
-- The WHERE clause is always pinned to auth.uid() — no caller-supplied input.

CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS TABLE (
  id           UUID,
  user_id      UUID,
  full_name    TEXT,
  role         TEXT,
  location_id  TEXT,
  is_active    BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    up.id,
    up.user_id,
    up.full_name,
    up.role,
    up.location_id,
    up.is_active
  FROM public.user_profiles up
  WHERE up.user_id = auth.uid()
  LIMIT 1;
$$;

-- Lock down execution — only authenticated users may call this function
REVOKE ALL ON FUNCTION public.get_my_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 7: Enable RLS on user_profiles
-- (RLS policies are in rls_policies_phase1.sql — kept separate for clarity)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;


-- =================================================================================
-- BACKFILL SCRIPT: system_users → user_profiles
--
-- This script reads from public.system_users and inserts into public.user_profiles.
--
-- Expected columns in system_users (confirmed from schema):
--   name             TEXT
--   email            TEXT UNIQUE NOT NULL
--   role             TEXT
--   assignedLocations JSONB  -- array of location id strings, e.g. ["LOC-001"]
--
-- Matching strategy: join system_users to auth.users by email (case-insensitive).
--
-- Role mapping:
--   'HQ Admin'          → 'hq_admin'
--   'HQ Manager'        → 'hq_admin'
--   'Finance / Purchasing' → 'hq_admin'
--   'Location Manager'  → 'location_manager' (requires resolvable location_id)
--   All other values    → SKIP (do not grant any access)
--
-- Skip conditions:
--   1. No matching auth.users row by email       → skipped_noauth
--   2. Row already exists in user_profiles       → skipped_dup
--   3. location_manager with no valid location   → skipped_noloc
--   4. Unrecognized role string                  → skipped_unknownrole
-- =================================================================================

DO $$
DECLARE
  rec                  RECORD;
  matched_count        INT := 0;
  inserted_count       INT := 0;
  skipped_noauth       INT := 0;
  skipped_dup          INT := 0;
  skipped_noloc        INT := 0;
  skipped_unknownrole  INT := 0;
  auth_user_id         UUID;
  mapped_role          TEXT;
  first_location       TEXT;
BEGIN

  FOR rec IN
    SELECT su.id, su.name, su.email, su.role, su.assignedLocations
    FROM public.system_users su
  LOOP

    -- ── Look up matching auth.users row by email ──────────────────────────
    SELECT au.id INTO auth_user_id
    FROM auth.users au
    WHERE lower(au.email) = lower(rec.email)
    LIMIT 1;

    IF auth_user_id IS NULL THEN
      -- No matching Supabase auth user — skip
      RAISE NOTICE 'Backfill SKIPPED (no auth): % has no matching auth.users row. Invite this user via Supabase Auth first.', rec.email;
      skipped_noauth := skipped_noauth + 1;
      CONTINUE;
    END IF;

    matched_count := matched_count + 1;

    -- ── Check for existing user_profiles row (avoid duplicate) ────────────
    IF EXISTS (
      SELECT 1 FROM public.user_profiles up WHERE up.user_id = auth_user_id
    ) THEN
      skipped_dup := skipped_dup + 1;
      CONTINUE;
    END IF;

    -- ── Map legacy role string to Phase 1 role enum ───────────────────────
    -- Unknown roles are SKIPPED — we do not assign any default elevated access.
    mapped_role := CASE
      WHEN rec.role IN ('HQ Admin', 'HQ Manager', 'Finance / Purchasing') THEN 'hq_admin'
      WHEN rec.role = 'Location Manager'                                   THEN 'location_manager'
      ELSE NULL
    END;

    IF mapped_role IS NULL THEN
      RAISE NOTICE 'Backfill SKIPPED (unknown role): % has unrecognized role value "%". Map this role manually to hq_admin or location_manager before inserting.', rec.email, rec.role;
      skipped_unknownrole := skipped_unknownrole + 1;
      CONTINUE;
    END IF;

    -- ── Resolve first assigned location from JSONB array ──────────────────
    -- assignedLocations is a JSONB array of location id strings e.g. ["LOC-001", "LOC-002"]
    -- We take the first element only if it matches an existing row in locations.
    first_location := NULL;

    IF rec.assignedLocations IS NOT NULL
       AND jsonb_typeof(rec.assignedLocations) = 'array'
       AND jsonb_array_length(rec.assignedLocations) > 0
    THEN
      SELECT l.id INTO first_location
      FROM public.locations l
      WHERE l.id = (rec.assignedLocations ->> 0)
      LIMIT 1;
    END IF;

    -- ── Business rule: location_manager needs a resolvable location ───────
    -- HARD SKIP — do NOT fall back to hq_admin. That would grant broader
    -- access than the original role intended.
    IF mapped_role = 'location_manager' AND first_location IS NULL THEN
      RAISE NOTICE 'Backfill SKIPPED (no location): % (system_users.id=%) is a location_manager but no valid location_id could be resolved from assignedLocations. Assign a valid location first, then insert manually.', rec.email, rec.id;
      skipped_noloc := skipped_noloc + 1;
      CONTINUE;
    END IF;

    -- ── Insert into user_profiles ─────────────────────────────────────────
    INSERT INTO public.user_profiles (user_id, full_name, role, location_id, is_active)
    VALUES (
      auth_user_id,
      rec.name,
      mapped_role,
      first_location,
      true
    );

    inserted_count := inserted_count + 1;

  END LOOP;

  -- ── Summary ───────────────────────────────────────────────────────────────
  RAISE NOTICE '──────────────────────────────────────────────────────────';
  RAISE NOTICE 'Backfill Complete: system_users → user_profiles';
  RAISE NOTICE '  Auth-matched rows                   : %', matched_count;
  RAISE NOTICE '  Inserted                            : %', inserted_count;
  RAISE NOTICE '  Skipped (no auth user)              : %', skipped_noauth;
  RAISE NOTICE '  Skipped (already in profiles)       : %', skipped_dup;
  RAISE NOTICE '  Skipped (loc_mgr, no location)      : %', skipped_noloc;
  RAISE NOTICE '  Skipped (unrecognized role)         : %', skipped_unknownrole;
  RAISE NOTICE '──────────────────────────────────────────────────────────';

  IF skipped_noloc > 0 THEN
    RAISE NOTICE 'ACTION REQUIRED: % location_manager row(s) skipped due to missing location. Find "Backfill SKIPPED (no location)" lines above to identify affected emails.', skipped_noloc;
  END IF;

  IF skipped_unknownrole > 0 THEN
    RAISE NOTICE 'ACTION REQUIRED: % row(s) skipped due to unrecognized role string. Find "Backfill SKIPPED (unknown role)" lines above and correct manually.', skipped_unknownrole;
  END IF;

  IF skipped_noauth > 0 THEN
    RAISE NOTICE 'ACTION REQUIRED: % row(s) have no matching Supabase Auth account. Invite these users via the Supabase Auth dashboard, then re-run this script.', skipped_noauth;
  END IF;

END $$;
