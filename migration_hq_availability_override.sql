-- migration_hq_availability_override.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds optional HQ-controlled availability override to hq_sale_items.
--
-- Purpose:
--   HQ can manually set the availability label shown to outlet/location users.
--   If null, the system calculates from instock / par_level automatically.
--   This prevents outlets from making ordering decisions based on raw HQ stock
--   numbers that may be inaccurate or stale.
--
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS).
-- Does NOT touch: inventory_items, outlet_catalog_items, requisitions, recipes.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.hq_sale_items
  ADD COLUMN IF NOT EXISTS availability_override TEXT
    CHECK (
      availability_override IS NULL
      OR availability_override IN ('available', 'low_stock', 'out_of_stock', 'not_available')
    );

COMMENT ON COLUMN public.hq_sale_items.availability_override IS
  'Optional HQ override for the availability badge shown to outlet/location users. '
  'If null, calculated automatically from instock and par_level. '
  'Allowed values: available, low_stock, out_of_stock, not_available.';
