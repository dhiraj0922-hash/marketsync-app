-- =================================================================================
-- PHASE 2 — STEP 1 (ADJUSTED): Harden inventory_items.location_id
-- All rows already have location_id populated. No backfill needed.
-- Additive only. Idempotent. No RLS. No other tables touched.
-- =================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Enforce NOT NULL on location_id
--
-- ALTER COLUMN SET NOT NULL is idempotent in Postgres — safe to re-run.
-- This will succeed because all existing rows already have a value.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.inventory_items
  ALTER COLUMN location_id SET NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Ensure FK constraint to public.locations(id) exists
--
-- We cannot use ADD CONSTRAINT IF NOT EXISTS directly for FKs in Postgres,
-- so we check the information_schema first and add only if missing.
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
      AND tc.table_name      = 'inventory_items'
      AND kcu.column_name    = 'location_id'
  ) THEN
    ALTER TABLE public.inventory_items
      ADD CONSTRAINT fk_inventory_items_location_id
        FOREIGN KEY (location_id)
        REFERENCES public.locations(id)
        ON DELETE RESTRICT;

    RAISE NOTICE 'FK constraint fk_inventory_items_location_id added.';
  ELSE
    RAISE NOTICE 'FK constraint on inventory_items.location_id already exists — skipped.';
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: Index on location_id
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_inventory_items_location_id
  ON public.inventory_items (location_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: Column comment (documents intent for Phase 2 isolation)
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON COLUMN public.inventory_items.location_id IS
  'Phase 2: Required FK to locations.id. Every inventory record must belong to exactly one location. RLS will filter by this column in a later phase.';
