-- =================================================================================
-- PHASE 3 — STEP 1: Requisitions Database Structure
--
-- Context: A public.requisitions table already exists with:
--   id TEXT PK, location TEXT, requestedBy TEXT, date TEXT, status TEXT,
--   items INT, notes TEXT, lineItems JSONB, created_at TIMESTAMPTZ
--
-- This migration:
--   1. Patches the existing requisitions table with proper FK columns and
--      updated_at, keeping all existing rows and columns intact.
--   2. Backfills location_id from the existing location TEXT column where
--      the value matches a valid locations.id.
--   3. Keeps created_by nullable — no unsafe backfill from requestedBy TEXT.
--   4. Adds a status CHECK via trigger (cannot add CHECK to existing TEXT
--      column without a full rewrite — deferred to Phase 4 UUID migration).
--   5. Creates the new requisition_items table for normalized line items.
--   6. Adds all FKs and indexes.
--
-- Additive only. Idempotent. No RLS.
-- =================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Patch existing requisitions table — add missing structural columns
-- ─────────────────────────────────────────────────────────────────────────────

-- location_id: proper FK to locations (alongside existing loose location TEXT)
ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS location_id TEXT NULL
    REFERENCES public.locations(id) ON DELETE SET NULL;

-- created_by: auth.users FK — nullable; historical rows are not backfilled
-- because requestedBy is a free-text name, not a reliable auth identity.
ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS created_by UUID NULL
    REFERENCES auth.users(id) ON DELETE SET NULL;

-- updated_at: for change tracking
ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

COMMENT ON TABLE public.requisitions IS
  'Phase 3: location_id FK, created_by (nullable), and updated_at added. lineItems JSONB preserved for backward compatibility; requisition_items is the normalized source going forward.';

COMMENT ON COLUMN public.requisitions.location_id IS
  'Phase 3: FK to locations.id. Backfilled from location TEXT where a direct id match exists.';

COMMENT ON COLUMN public.requisitions.created_by IS
  'Phase 3: FK to auth.users.id. Nullable — historical rows keep NULL because requestedBy TEXT cannot be safely mapped to auth identities without a reliable join.';


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Idempotent FK on requisitions.location_id
-- Ensures the FK constraint is present even if the column was added in a
-- prior migration run without the explicit constraint name.
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
      AND tc.table_name      = 'requisitions'
      AND kcu.column_name    = 'location_id'
  ) THEN
    ALTER TABLE public.requisitions
      ADD CONSTRAINT fk_requisitions_location_id
        FOREIGN KEY (location_id)
        REFERENCES public.locations(id)
        ON DELETE SET NULL;
    RAISE NOTICE 'FK fk_requisitions_location_id added.';
  ELSE
    RAISE NOTICE 'FK on requisitions.location_id already exists — skipped.';
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: Safe backfill of requisitions.location_id
--
-- Strategy: for each row where location_id IS NULL, attempt a direct match
-- of the existing requisitions.location TEXT field against public.locations.id.
-- Only rows with an exact match are updated. No guessing, no fallback.
-- Rows already populated are untouched (idempotent).
-- created_by is intentionally NOT backfilled — requestedBy TEXT is a display
-- name, not a reliable mapping to auth.users.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  rec            RECORD;
  resolved_id    TEXT;
  matched_count  INT := 0;
  skipped_count  INT := 0;
BEGIN

  FOR rec IN
    SELECT id, location
    FROM public.requisitions
    WHERE location_id IS NULL
  LOOP
    resolved_id := NULL;

    -- Direct match: requisitions.location == locations.id
    IF rec.location IS NOT NULL AND rec.location <> '' THEN
      SELECT l.id INTO resolved_id
      FROM public.locations l
      WHERE l.id = rec.location
      LIMIT 1;
    END IF;

    IF resolved_id IS NOT NULL THEN
      UPDATE public.requisitions
        SET location_id = resolved_id
        WHERE id = rec.id;
      matched_count := matched_count + 1;
    ELSE
      RAISE NOTICE 'Backfill SKIPPED: requisitions.id=% has location="%" which does not match any locations.id. Assign location_id manually.', rec.id, rec.location;
      skipped_count := skipped_count + 1;
    END IF;

  END LOOP;

  RAISE NOTICE '──────────────────────────────────────────────────────────────';
  RAISE NOTICE 'Requisitions location_id backfill complete.';
  RAISE NOTICE '  Matched and updated  : %', matched_count;
  RAISE NOTICE '  Skipped (no match)   : %', skipped_count;
  RAISE NOTICE '──────────────────────────────────────────────────────────────';

  IF skipped_count > 0 THEN
    RAISE NOTICE 'ACTION REQUIRED: % requisition row(s) could not be assigned a location_id. Find "Backfill SKIPPED" lines above and assign manually.', skipped_count;
  END IF;

END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: updated_at trigger on requisitions
--
-- Uses public.set_updated_at() as defined in Phase 1. Redeclared here with
-- CREATE OR REPLACE so this file is self-contained without changing behavior.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS requisitions_set_updated_at ON public.requisitions;
CREATE TRIGGER requisitions_set_updated_at
  BEFORE UPDATE ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: Status value enforcement via trigger
--
-- Cannot add a CHECK constraint to an existing TEXT column without rewriting
-- the table. Enforced via trigger. Phase 4 UUID migration will replace this
-- with a proper column CHECK constraint.
--
-- Valid statuses: draft, submitted, approved, rejected, fulfilled
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_requisition_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS NOT NULL
     AND NEW.status NOT IN ('draft', 'submitted', 'approved', 'rejected', 'fulfilled')
  THEN
    RAISE EXCEPTION
      'requisitions.status must be one of: draft, submitted, approved, rejected, fulfilled. Got: %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS check_requisition_status ON public.requisitions;
CREATE TRIGGER check_requisition_status
  BEFORE INSERT OR UPDATE ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_requisition_status();


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 6: Indexes on requisitions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_requisitions_location_id
  ON public.requisitions (location_id);

CREATE INDEX IF NOT EXISTS idx_requisitions_created_by
  ON public.requisitions (created_by);

CREATE INDEX IF NOT EXISTS idx_requisitions_status
  ON public.requisitions (status);


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 7: Create requisition_items table (normalized line items)
--
-- requisition_id is TEXT — matches requisitions.id TEXT PK.
-- item_id is TEXT — matches inventory_items.id TEXT PK.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.requisition_items (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id      TEXT    NOT NULL
    REFERENCES public.requisitions(id) ON DELETE CASCADE,
  item_id             TEXT    NOT NULL
    REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  quantity_requested  NUMERIC NOT NULL DEFAULT 0 CHECK (quantity_requested >= 0),
  quantity_approved   NUMERIC NULL     CHECK (quantity_approved >= 0),
  quantity_fulfilled  NUMERIC NULL     CHECK (quantity_fulfilled >= 0),
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE public.requisition_items IS
  'Phase 3: Normalized line items for requisitions. Replaces the lineItems JSONB blob in the parent requisitions table.';

COMMENT ON COLUMN public.requisition_items.quantity_requested IS
  'Amount the requesting location wants.';

COMMENT ON COLUMN public.requisition_items.quantity_approved IS
  'Amount approved by HQ. NULL until the requisition is reviewed.';

COMMENT ON COLUMN public.requisition_items.quantity_fulfilled IS
  'Amount actually dispatched. NULL until fulfilled.';


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 8: updated_at trigger on requisition_items
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS requisition_items_set_updated_at ON public.requisition_items;
CREATE TRIGGER requisition_items_set_updated_at
  BEFORE UPDATE ON public.requisition_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 9: Indexes on requisition_items
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_requisition_items_requisition_id
  ON public.requisition_items (requisition_id);

CREATE INDEX IF NOT EXISTS idx_requisition_items_item_id
  ON public.requisition_items (item_id);
