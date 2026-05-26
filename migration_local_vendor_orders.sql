-- =============================================================================
-- MIGRATION: migration_local_vendor_orders.sql
-- Phase 3: Make Location Catalog Local Vendor items orderable.
--
-- Adds 4 nullable columns to public.requisition_items so that orders can
-- reference outlet_catalog_items directly WITHOUT touching inventory_items,
-- purchase_options, hq_sale_items, or any HQ table.
--
-- Design:
--   • catalog_item_id TEXT NULL  FK → outlet_catalog_items(item_id)
--     Used when source_type = 'local_vendor'. item_id and finished_good_id
--     remain NULL for local vendor rows.
--   • source_type TEXT NULL DEFAULT 'hq_supplied'
--     Discriminates HQ supplied vs local vendor line items.
--   • supplier_snapshot TEXT NULL
--     Snapshot of outlet_catalog_items.supplier at order time.
--   • pack_qty_snapshot NUMERIC NULL DEFAULT 1
--     Snapshot of outlet_catalog_items.pack_qty at order time.
--   • unit_snapshot already exists — used for UOM display.
--   • item_name_snapshot already exists — used for item name display.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- Does NOT touch: inventory_items, purchase_options, hq_sale_items,
--   recipes, production, reports, FG count, or movement RPCs.
-- =============================================================================

-- 1. catalog_item_id — FK to outlet_catalog_items.item_id
ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS catalog_item_id TEXT
    REFERENCES public.outlet_catalog_items(item_id)
    ON DELETE RESTRICT;

COMMENT ON COLUMN public.requisition_items.catalog_item_id IS
  'FK → outlet_catalog_items(item_id). Set for local_vendor order lines. '
  'item_id and finished_good_id are NULL when catalog_item_id is set. '
  'ON DELETE RESTRICT prevents deleting an ordered catalog item.';

-- 2. source_type — discriminates HQ supplied vs local vendor lines
ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'hq_supplied';

-- Enforce valid values via CHECK constraint (only if column was just added)
-- We use a DO block to guard against duplicate constraint errors on re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name   = 'requisition_items'
      AND constraint_name = 'chk_req_items_source_type'
  ) THEN
    ALTER TABLE public.requisition_items
      ADD CONSTRAINT chk_req_items_source_type
      CHECK (source_type IN ('hq_supplied', 'local_vendor'));
  END IF;
END $$;

COMMENT ON COLUMN public.requisition_items.source_type IS
  'hq_supplied = HQ finished goods or HQ inventory item. '
  'local_vendor = local vendor catalog item (catalog_item_id set).';

-- 3. supplier_snapshot — captured from outlet_catalog_items.supplier at order time
ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS supplier_snapshot TEXT;

COMMENT ON COLUMN public.requisition_items.supplier_snapshot IS
  'Snapshot of the supplier name at the time the order was placed. '
  'Set for local_vendor lines from outlet_catalog_items.supplier. '
  'NULL for HQ supplied lines.';

-- 4. pack_qty_snapshot — units per pack at order time
ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS pack_qty_snapshot NUMERIC DEFAULT 1;

COMMENT ON COLUMN public.requisition_items.pack_qty_snapshot IS
  'Snapshot of pack_qty at order time. '
  'For local_vendor: outlet_catalog_items.pack_qty. '
  'For HQ FG: hq_sale_items.pack_qty. Defaults to 1 for legacy rows.';

-- Index: sparse — only index rows that have a catalog_item_id
CREATE INDEX IF NOT EXISTS idx_req_items_catalog_item_id
  ON public.requisition_items(catalog_item_id)
  WHERE catalog_item_id IS NOT NULL;

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
  AND table_name   = 'requisition_items'
ORDER BY ordinal_position;
