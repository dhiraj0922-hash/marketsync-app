-- migration_outlet_catalog.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Additive migration for Outlet Inventory v2 architecture.
--
-- Changes:
--   1. Create outlet_catalog_items  — global outlet item catalog (HQ-managed)
--   2. Extend location_inventory_items with local-override columns
--   3. Seed outlet_catalog_items from hq_sale_items (HQ-supplied items)
--   4. RLS policies using existing get_my_role() / get_my_location_id()
--
-- Safe to run multiple times (IF NOT EXISTS + ADD COLUMN IF NOT EXISTS).
-- Does NOT touch: inventory_items, recipes, production, requisitions, counts.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. outlet_catalog_items ──────────────────────────────────────────────────
-- Global catalog of items outlets can stock.
-- source_type = 'hq_supplied' → links to hq_sale_items
-- source_type = 'local_vendor' → outlet-purchased, no HQ link
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.outlet_catalog_items (
  item_id           TEXT        PRIMARY KEY,
  name              TEXT        NOT NULL,
  category          TEXT,
  uom               TEXT,
  type              TEXT        NOT NULL DEFAULT 'Inventory item',
  source_type       TEXT        NOT NULL DEFAULT 'local_vendor'
                                CHECK (source_type IN ('hq_supplied', 'local_vendor')),
  hq_sale_item_id   TEXT,       -- FK to hq_sale_items.id when source_type = 'hq_supplied'
  supplier          TEXT,
  purchase_option   TEXT,
  product_code      TEXT,
  scan_barcode      TEXT,
  price             NUMERIC     NOT NULL DEFAULT 0,
  tax_rate          NUMERIC     NOT NULL DEFAULT 0,
  pack_qty          NUMERIC     NOT NULL DEFAULT 1,
  ordering_enabled  BOOLEAN     NOT NULL DEFAULT true,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.outlet_catalog_items IS
  'Global outlet item catalog. HQ manages this. '
  'source_type=hq_supplied items may link to hq_sale_items; '
  'source_type=local_vendor items are purchased directly by outlets.';

COMMENT ON COLUMN public.outlet_catalog_items.source_type IS
  '''hq_supplied'' = HQ provides this item; ''local_vendor'' = outlet buys directly';

-- updated_at trigger (reuse existing function from migration_outlet_inventory.sql)
DROP TRIGGER IF EXISTS set_outlet_catalog_items_updated_at ON public.outlet_catalog_items;
CREATE TRIGGER set_outlet_catalog_items_updated_at
  BEFORE UPDATE ON public.outlet_catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 2. Extend location_inventory_items with local-override columns ─────────────
ALTER TABLE public.location_inventory_items
  ADD COLUMN IF NOT EXISTS local_supplier       TEXT,
  ADD COLUMN IF NOT EXISTS local_purchase_option TEXT,
  ADD COLUMN IF NOT EXISTS local_price           NUMERIC,
  ADD COLUMN IF NOT EXISTS local_product_code    TEXT;

-- Note: local_notes already exists from migration_outlet_inventory.sql

-- ── 3. Seed outlet_catalog_items from hq_sale_items ──────────────────────────
-- Seeds active + requisitionable HQ finished goods into the outlet catalog.
--
-- Real hq_sale_items column names (verified from storage.ts mapSaleItemToFrontend):
--   name            → name
--   base_unit       → UOM / unit shown in the UI
--   category        → category
--   making_cost     → cost to produce
--   manual_price    → HQ override price
--   suggested_price → generated column (making_cost * 1.20)
--   effective_price → COALESCE(manual_price, suggested_price) — used by requisitions
--   pack_qty        → sellable pack size
--   is_active       → active flag
--   is_requisitionable → visible/orderable by locations
--
-- item_id is prefixed 'hq_' + id to keep it distinct from local vendor item_ids.
-- Only seeds items that are: is_active = true AND is_requisitionable = true.
-- Safe to re-run: ON CONFLICT (item_id) DO NOTHING skips existing rows.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.outlet_catalog_items
  (item_id, name, category, uom, type, source_type, hq_sale_item_id,
   price, pack_qty, ordering_enabled, is_active)
SELECT
  'hq_' || id::text                                        AS item_id,
  name,
  category,
  COALESCE(NULLIF(TRIM(base_unit), ''), 'ea')              AS uom,
  'Finished Good'                                          AS type,
  'hq_supplied'                                            AS source_type,
  id::text                                                 AS hq_sale_item_id,
  -- Use effective_price (manual override if set, else suggested) for outlet price.
  -- effective_price is a generated/computed column; fall back to manual_price or
  -- suggested_price if the column does not exist in older schema versions.
  COALESCE(
    NULLIF(manual_price, 0),
    NULLIF(suggested_price, 0),
    making_cost,
    0
  )                                                        AS price,
  COALESCE(NULLIF(pack_qty, 0), 1)                         AS pack_qty,
  true                                                     AS ordering_enabled,
  true                                                     AS is_active
FROM public.hq_sale_items
WHERE
  (is_active        IS NULL OR is_active        = true)
  AND (is_requisitionable IS NULL OR is_requisitionable = true)
ON CONFLICT (item_id) DO NOTHING;

-- ── 4. RLS for outlet_catalog_items ──────────────────────────────────────────
ALTER TABLE public.outlet_catalog_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hq_admin can read all catalog items"       ON public.outlet_catalog_items;
DROP POLICY IF EXISTS "hq_admin can insert catalog items"          ON public.outlet_catalog_items;
DROP POLICY IF EXISTS "hq_admin can update catalog items"          ON public.outlet_catalog_items;
DROP POLICY IF EXISTS "hq_admin can delete catalog items"          ON public.outlet_catalog_items;
DROP POLICY IF EXISTS "location_manager can read active catalog"   ON public.outlet_catalog_items;

-- HQ admin: full CRUD
CREATE POLICY "hq_admin can read all catalog items"
  ON public.outlet_catalog_items FOR SELECT
  USING ( public.get_my_role() = 'hq_admin' );

CREATE POLICY "hq_admin can insert catalog items"
  ON public.outlet_catalog_items FOR INSERT
  WITH CHECK ( public.get_my_role() = 'hq_admin' );

CREATE POLICY "hq_admin can update catalog items"
  ON public.outlet_catalog_items FOR UPDATE
  USING ( public.get_my_role() = 'hq_admin' );

CREATE POLICY "hq_admin can delete catalog items"
  ON public.outlet_catalog_items FOR DELETE
  USING ( public.get_my_role() = 'hq_admin' );

-- Location manager: read active items only (catalog is global / read-only for outlets)
CREATE POLICY "location_manager can read active catalog"
  ON public.outlet_catalog_items FOR SELECT
  USING (
    public.get_my_role() = 'location_manager'
    AND is_active = true
  );

-- ── 5. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_outlet_catalog_source_type
  ON public.outlet_catalog_items(source_type);

CREATE INDEX IF NOT EXISTS idx_outlet_catalog_hq_sale_item_id
  ON public.outlet_catalog_items(hq_sale_item_id)
  WHERE hq_sale_item_id IS NOT NULL;
