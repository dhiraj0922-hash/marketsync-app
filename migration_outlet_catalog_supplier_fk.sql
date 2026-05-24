-- =============================================================================
-- MIGRATION: migration_outlet_catalog_supplier_fk.sql
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
-- Adds an optional supplier_id FK column to outlet_catalog_items so that
-- Location Catalog items can be linked to the global suppliers master table.
--
-- Design decisions:
--   - supplier_id is NULLABLE — backward compatible with existing rows that
--     only have the free-text supplier column.
--   - ON DELETE SET NULL — deleting a supplier does not orphan catalog rows;
--     the supplier text column still holds the display name.
--   - The existing free-text `supplier` column is KEPT for display/backward compat.
--   - Safe to re-run: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
--
-- Scope: outlet_catalog_items only.
-- Does NOT touch: inventory_items, purchase_options, suppliers, hq_sale_items,
--   location_inventory_items, recipes, production, requisitions, reports.
-- =============================================================================

ALTER TABLE public.outlet_catalog_items
  ADD COLUMN IF NOT EXISTS supplier_id INTEGER
    REFERENCES public.suppliers(id)
    ON DELETE SET NULL;

COMMENT ON COLUMN public.outlet_catalog_items.supplier_id IS
  'Optional FK → suppliers.id. NULL for items whose supplier is stored as free-text only. '
  'ON DELETE SET NULL preserves catalog row if supplier is deleted. '
  'The free-text supplier column is kept for backward compatibility and display.';

-- Index: only index non-null values (sparse index — most rows may be null initially)
CREATE INDEX IF NOT EXISTS idx_outlet_catalog_supplier_id
  ON public.outlet_catalog_items(supplier_id)
  WHERE supplier_id IS NOT NULL;

-- =============================================================================
-- Verify
-- =============================================================================
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'outlet_catalog_items'
ORDER BY ordinal_position;
