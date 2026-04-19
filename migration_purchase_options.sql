-- =============================================================================
-- MIGRATION: purchase_options
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
-- One inventory item can have MANY purchase_options rows (multi-supplier).
-- Each row = one supplier offer imported from the legacy app export.
--
-- NOTE: inventory_items.id is TEXT (not UUID) — the FK below uses TEXT to match.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.purchase_options (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FK to inventory_items — TEXT because inventory_items.id TEXT PRIMARY KEY
  -- ON DELETE SET NULL: if the item is deleted, the supplier pricing history is
  -- preserved (orphaned) rather than destroyed. Allows post-import auditing.
  inventory_item_id     TEXT        REFERENCES public.inventory_items(id) ON DELETE SET NULL,

  -- Supplier identity
  supplier_name         TEXT        NOT NULL,
  supplier_product_name TEXT,                         -- supplier's own product label

  -- Packaging / UOM
  purchase_uom          TEXT        NOT NULL,         -- the unit you buy in (e.g. 'case', 'bag', 'kg')
  pack_qty              NUMERIC,                      -- quantity per purchase_uom (e.g. 12 cans per case)
  pack_uom              TEXT,                         -- unit for pack_qty (e.g. 'can', 'ea', 'ml')

  -- Pricing
  unit_price            NUMERIC     NOT NULL DEFAULT 0,  -- price per purchase_uom

  -- Preference flag
  is_preferred          BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Timestamps
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.purchase_options IS
  'Multi-supplier purchase mapping. Each row is one supplier offer for one inventory item. '
  'inventory_item_id is TEXT to match inventory_items.id TEXT PK. '
  'is_preferred=TRUE marks the default supplier for auto-PO generation.';

COMMENT ON COLUMN public.purchase_options.inventory_item_id IS
  'FK → inventory_items.id (TEXT). NULL when the parent item has been deleted (SET NULL).';

COMMENT ON COLUMN public.purchase_options.purchase_uom IS
  'The unit you order from the supplier — e.g. case, bag, kg, litre, ea.';

COMMENT ON COLUMN public.purchase_options.pack_qty IS
  'How many pack_uom units are in one purchase_uom. '
  'e.g. 1 case (purchase_uom) = 24 cans (pack_qty=24, pack_uom=can).';

COMMENT ON COLUMN public.purchase_options.unit_price IS
  'Price per one purchase_uom unit (as invoiced by supplier).';

COMMENT ON COLUMN public.purchase_options.is_preferred IS
  'TRUE = default supplier for this item. '
  'Enforced as at-most-one-per-item in application logic.';


-- Indexes
CREATE INDEX IF NOT EXISTS idx_purchase_options_inventory_item_id
  ON public.purchase_options (inventory_item_id);

CREATE INDEX IF NOT EXISTS idx_purchase_options_supplier_name
  ON public.purchase_options (supplier_name);


-- updated_at trigger — reuses set_updated_at() already defined in migration_phase1_roles.sql
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS purchase_options_set_updated_at ON public.purchase_options;
CREATE TRIGGER purchase_options_set_updated_at
  BEFORE UPDATE ON public.purchase_options
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- RLS: disabled (consistent with rest of app)
ALTER TABLE public.purchase_options DISABLE ROW LEVEL SECURITY;


-- Verify
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'purchase_options'
ORDER BY ordinal_position;

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename  = 'purchase_options'
  AND schemaname = 'public';
