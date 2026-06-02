-- =============================================================================
-- Measurement Family: adds a single nullable TEXT column to inventory_items.
--
-- Values: weight | volume | count | labour | preparation | finished_good
--
-- Locked internal base units per family:
--   weight       → g
--   volume       → ml
--   count        → ea
--   labour       → hr
--   preparation  → g  (inherits from inner measurement unit family)
--   finished_good→ ea
--
-- All existing rows stay NULL — legacy costing fallback is untouched.
-- New rows set this when created via the redesigned Add/Edit Item drawer.
-- =============================================================================

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS measurement_family TEXT DEFAULT NULL;

-- Optional: add a check constraint to enforce allowed values
ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS chk_inventory_measurement_family;

ALTER TABLE public.inventory_items
  ADD CONSTRAINT chk_inventory_measurement_family
  CHECK (
    measurement_family IS NULL OR
    measurement_family IN (
      'weight', 'volume', 'count', 'labour', 'preparation', 'finished_good'
    )
  );

COMMENT ON COLUMN public.inventory_items.measurement_family IS
  'Measurement dimension family. Drives the locked internal base unit used for '
  'recipe costing, production deductions, and COGS reports. '
  'Values: weight=g, volume=ml, count=ea, labour=hr, preparation=g, finished_good=ea. '
  'NULL means the row was created before this field was added (legacy fallback applies).';

-- Verify ─────────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'inventory_items'
  AND column_name = 'measurement_family';
