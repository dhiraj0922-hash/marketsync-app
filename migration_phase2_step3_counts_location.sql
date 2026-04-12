-- =================================================================================
-- PHASE 2 — STEP 3: Prepare counts table for location-based isolation
-- Adds location_id FK column, backfills from existing location TEXT column,
-- enforces NOT NULL only when safe, adds index.
-- Additive only. Idempotent. No RLS. No other tables touched.
-- =================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Add location_id column if not already present
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.counts
  ADD COLUMN IF NOT EXISTS location_id TEXT NULL
    REFERENCES public.locations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.counts.location_id IS
  'Phase 2: FK to locations.id. Replaces the loose location TEXT column for strict isolation. RLS will filter by this column in a later phase.';


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1b: Ensure FK constraint exists on location_id
-- Covers the case where location_id already existed without a FK constraint.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema    = kcu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema    = 'public'
      AND tc.table_name      = 'counts'
      AND kcu.column_name    = 'location_id'
  ) THEN
    ALTER TABLE public.counts
      ADD CONSTRAINT fk_counts_location_id
        FOREIGN KEY (location_id)
        REFERENCES public.locations(id)
        ON DELETE SET NULL;
    RAISE NOTICE 'FK constraint fk_counts_location_id added.';
  ELSE
    RAISE NOTICE 'FK constraint on counts.location_id already exists — skipped.';
  END IF;
END $$;



-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Index on location_id
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_counts_location_id
  ON public.counts (location_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: Safe backfill of location_id from existing location TEXT column
--
-- Strategy (per row where location_id IS NULL):
--   A) Try to match counts.location directly to locations.id (exact FK match)
--   B) If no direct match and only one active location exists, assign that
--   C) If no direct match and multiple active locations exist, leave NULL
--      and report the row so the operator can assign manually
--
-- Rows where location_id is already populated are untouched (idempotent).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  active_loc_count  INT;
  fallback_loc_id   TEXT;
  fallback_loc_name TEXT;
  matched_direct    INT := 0;
  matched_fallback  INT := 0;
  unresolved        INT := 0;
  rec               RECORD;
  resolved_id       TEXT;
BEGIN

  -- Count active locations for fallback decision
  SELECT COUNT(*) INTO active_loc_count
  FROM public.locations
  WHERE is_active = true;

  -- Capture single fallback location if only one exists
  IF active_loc_count = 1 THEN
    SELECT id, name INTO fallback_loc_id, fallback_loc_name
    FROM public.locations
    WHERE is_active = true
    LIMIT 1;
  END IF;

  -- ── Per-row resolution for unassigned counts ───────────────────────────────
  FOR rec IN
    SELECT id, location
    FROM public.counts
    WHERE location_id IS NULL
  LOOP
    resolved_id := NULL;

    -- Strategy A: try direct match of counts.location → locations.id
    IF rec.location IS NOT NULL AND rec.location <> '' THEN
      SELECT l.id INTO resolved_id
      FROM public.locations l
      WHERE l.id = rec.location
      LIMIT 1;
    END IF;

    IF resolved_id IS NOT NULL THEN
      -- Direct FK match found
      UPDATE public.counts
        SET location_id = resolved_id
        WHERE id = rec.id;
      matched_direct := matched_direct + 1;
      CONTINUE;
    END IF;

    -- Strategy B: no direct match — use single active location as fallback
    IF fallback_loc_id IS NOT NULL THEN
      UPDATE public.counts
        SET location_id = fallback_loc_id
        WHERE id = rec.id;
      matched_fallback := matched_fallback + 1;
      CONTINUE;
    END IF;

    -- Strategy C: multiple active locations, no direct match — leave NULL, report
    RAISE NOTICE 'Backfill UNRESOLVED: counts.id=% has location="%" which does not match any locations.id, and multiple active locations exist. Assign location_id manually.', rec.id, rec.location;
    unresolved := unresolved + 1;

  END LOOP;

  -- ── Summary ───────────────────────────────────────────────────────────────
  RAISE NOTICE '──────────────────────────────────────────────────────────────';
  RAISE NOTICE 'Counts backfill complete.';
  RAISE NOTICE '  Matched via direct FK    : %', matched_direct;
  RAISE NOTICE '  Matched via fallback loc : % (location: "%", id: %)', matched_fallback, fallback_loc_name, fallback_loc_id;
  RAISE NOTICE '  Unresolved (NULL kept)   : %', unresolved;
  RAISE NOTICE '──────────────────────────────────────────────────────────────';

  IF unresolved > 0 THEN
    RAISE NOTICE 'ACTION REQUIRED: % counts row(s) could not be assigned a location_id. Find "Backfill UNRESOLVED" lines above and assign manually.', unresolved;
  END IF;

END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: Enforce NOT NULL only if all rows are now populated
--
-- Checks for any remaining NULLs. If none exist, tightens the constraint.
-- If NULLs remain (unresolved rows), skips and prints an action notice.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  null_count INT;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM public.counts
  WHERE location_id IS NULL;

  IF null_count = 0 THEN
    ALTER TABLE public.counts
      ALTER COLUMN location_id SET NOT NULL;
    RAISE NOTICE 'NOT NULL enforced on counts.location_id — all rows are populated.';
  ELSE
    RAISE NOTICE 'NOT NULL NOT enforced: % counts row(s) still have NULL location_id. Resolve them, then re-run this migration to apply the constraint.', null_count;
  END IF;
END $$;
