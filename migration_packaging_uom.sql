-- =============================================================================
-- Phase 1: Structured packaging / UOM columns for inventory_items
--
-- All columns nullable with NULL default.
-- Existing rows are completely unaffected — NULL triggers legacy fallback
-- in recipe costing. No existing data is read, written, or migrated.
-- =============================================================================

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS purchase_uom        TEXT    DEFAULT NULL,  -- e.g. 'case', 'bag', 'bottle'
  ADD COLUMN IF NOT EXISTS pack_qty            NUMERIC DEFAULT NULL,  -- inner units per purchase_uom (e.g. 12 cans/case)
  ADD COLUMN IF NOT EXISTS inner_unit_type     TEXT    DEFAULT NULL,  -- e.g. 'can', 'bottle', 'ea'
  ADD COLUMN IF NOT EXISTS inner_unit_size     NUMERIC DEFAULT NULL,  -- volume/mass per inner unit (e.g. 330)
  ADD COLUMN IF NOT EXISTS inner_unit_uom      TEXT    DEFAULT NULL,  -- unit for inner_unit_size (e.g. 'ml', 'g')
  ADD COLUMN IF NOT EXISTS base_uom            TEXT    DEFAULT NULL,  -- canonical costing unit; overrides baseunit when set
  ADD COLUMN IF NOT EXISTS allowed_recipe_uoms TEXT[]  DEFAULT NULL;  -- soft-warning whitelist for recipe builder

-- Verify ─────────────────────────────────────────────────────────────────────
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name   = 'inventory_items'
  AND column_name IN (
    'purchase_uom', 'pack_qty', 'inner_unit_type',
    'inner_unit_size', 'inner_unit_uom', 'base_uom', 'allowed_recipe_uoms'
  )
ORDER BY column_name;

-- Guard: no existing rows should have these populated yet
SELECT
  COUNT(*) FILTER (WHERE purchase_uom    IS NOT NULL) AS has_purchase_uom,
  COUNT(*) FILTER (WHERE pack_qty        IS NOT NULL) AS has_pack_qty,
  COUNT(*) FILTER (WHERE inner_unit_type IS NOT NULL) AS has_inner_unit_type,
  COUNT(*) FILTER (WHERE inner_unit_size IS NOT NULL) AS has_inner_unit_size,
  COUNT(*) FILTER (WHERE inner_unit_uom  IS NOT NULL) AS has_inner_unit_uom,
  COUNT(*) FILTER (WHERE base_uom        IS NOT NULL) AS has_base_uom,
  COUNT(*) FILTER (WHERE allowed_recipe_uoms IS NOT NULL) AS has_allowed_recipe_uoms
FROM public.inventory_items;
-- All counts above should be 0.
