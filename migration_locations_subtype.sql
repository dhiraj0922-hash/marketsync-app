-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Add locations.subtype column
-- Run in Supabase SQL Editor (safe to run multiple times — additive only)
--
-- Context:
--   The DB trigger check_location_type enforces:
--     locations.type IN ('hq', 'branch', 'warehouse')
--   But the UI shows human-friendly labels (HQ / Store / Airport / Mall / Other).
--   mapLocationToDB now translates UI labels → canonical DB types before every write.
--   This migration adds a `subtype` column to preserve the original UI label for
--   display purposes, so "Store" round-trips correctly even though type = 'branch'.
--
-- Subtype meaning:
--   type = 'hq'        → subtype = 'HQ'
--   type = 'branch'    → subtype = 'Store' | 'Airport' | 'Mall' | 'Other'
--   type = 'warehouse' → subtype = 'Warehouse'
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: Add subtype column (text, nullable, no DB-level constraint — app controls values)
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS subtype TEXT DEFAULT NULL;

-- Step 2: Backfill existing rows whose type is already canonical
--   hq rows     → subtype = 'HQ'
--   branch rows → subtype = 'Store'  (best-effort; actual label was lost before this fix)
--   warehouse   → subtype = 'Warehouse'
UPDATE public.locations
  SET subtype = CASE
    WHEN type = 'hq'        THEN 'HQ'
    WHEN type = 'branch'    THEN 'Store'
    WHEN type = 'warehouse' THEN 'Warehouse'
    ELSE type               -- preserve any unexpected legacy value
  END
  WHERE subtype IS NULL;

-- Step 3: Also backfill any rows still holding the old UI literal values.
--   These exist if the app saved 'Store', 'Airport', 'Mall', 'Other' before
--   the mapLocationToDB fix was deployed.
UPDATE public.locations
  SET
    subtype = type,                 -- preserve original UI label
    type    = CASE
      WHEN type = 'HQ'      THEN 'hq'
      WHEN type = 'Store'   THEN 'branch'
      WHEN type = 'Airport' THEN 'branch'
      WHEN type = 'Mall'    THEN 'branch'
      WHEN type = 'Other'   THEN 'branch'
      ELSE type
    END
  WHERE type NOT IN ('hq', 'branch', 'warehouse');

-- Verify: no rows should remain with a non-canonical type
SELECT id, name, type, subtype, status
FROM public.locations
ORDER BY name;
