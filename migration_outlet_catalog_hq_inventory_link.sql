-- migration_outlet_catalog_hq_inventory_link.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Structural fix: adds hq_inventory_item_id to outlet_catalog_items.
--
-- This resolves the gap where HQ raw inventory items (e.g. SALT, GINGER)
-- could only be represented as local_vendor in the outlet catalog because
-- hq_sale_item_id only covers finished goods.
--
-- NEW MODEL for outlet_catalog_items:
--
--   source_type = 'hq_supplied' + hq_sale_item_id IS NOT NULL
--     → Finished Good (links to hq_sale_items.id)
--     → requisition_items.finished_good_id = hq_sale_item_id
--
--   source_type = 'hq_supplied' + hq_inventory_item_id IS NOT NULL
--     → HQ Raw Inventory (links to inventory_items.id at LOC-HQ)
--     → requisition_items.item_id = hq_inventory_item_id
--     → stock deducted from inventory_items WHERE location_id = 'LOC-HQ'
--
--   source_type = 'local_vendor' + both NULL
--     → Local Vendor (no HQ link)
--     → requisition_items.catalog_item_id = outlet_catalog_items.item_id
--
-- hq_inventory_item_id stores inventory_items.id (TEXT PK) of the LOC-HQ row.
-- The finalize_requisition_fulfillment_v3 RPC resolves:
--   inventory_items.id → inventory_items.item_id (shared) → LOC-HQ stock
--
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS, DO $$ guards).
-- Does NOT touch: requisitions, requisition_items, hq_sale_items, hq stock.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Add hq_inventory_item_id column ───────────────────────────────────────
ALTER TABLE public.outlet_catalog_items
  ADD COLUMN IF NOT EXISTS hq_inventory_item_id TEXT
    REFERENCES public.inventory_items(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.outlet_catalog_items.hq_inventory_item_id IS
  'FK to inventory_items.id (TEXT PK) of the LOC-HQ row for this item. '
  'Set when source_type = ''hq_supplied'' and item is a raw HQ inventory item '
  '(e.g. SALT, GINGER CS). Mutually exclusive with hq_sale_item_id. '
  'Used by requisition creation to populate requisition_items.item_id, '
  'which the finalize_requisition_fulfillment_v3 RPC uses to deduct LOC-HQ stock.';

-- ── 2. Index for FK lookups ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_outlet_catalog_hq_inventory_item_id
  ON public.outlet_catalog_items(hq_inventory_item_id)
  WHERE hq_inventory_item_id IS NOT NULL;

-- ── 3. XOR constraint (NOT VALID — does not recheck existing rows) ────────────
-- Ensures that for hq_supplied items, exactly one of the two HQ links is set.
-- NOT VALID prevents migration failure on legacy rows with both NULL.
-- Run VALIDATE CONSTRAINT manually once data has been cleaned.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_hq_catalog_link_xor'
      AND conrelid = 'public.outlet_catalog_items'::regclass
  ) THEN
    ALTER TABLE public.outlet_catalog_items
      ADD CONSTRAINT chk_hq_catalog_link_xor CHECK (
        -- local_vendor: both HQ links must be NULL
        (source_type = 'local_vendor'
          AND hq_sale_item_id IS NULL
          AND hq_inventory_item_id IS NULL)
        -- hq_supplied via finished good: only hq_sale_item_id set
        OR (source_type = 'hq_supplied'
          AND hq_sale_item_id IS NOT NULL
          AND hq_inventory_item_id IS NULL)
        -- hq_supplied via raw inventory: only hq_inventory_item_id set
        OR (source_type = 'hq_supplied'
          AND hq_sale_item_id IS NULL
          AND hq_inventory_item_id IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;

COMMENT ON CONSTRAINT chk_hq_catalog_link_xor ON public.outlet_catalog_items IS
  'XOR: hq_supplied items must have exactly one of hq_sale_item_id (FG) or '
  'hq_inventory_item_id (raw inventory). local_vendor items must have neither. '
  'Added NOT VALID — run VALIDATE CONSTRAINT after data repair is complete.';

-- ── 4. SALT repair SQL (prepared — DO NOT uncomment until LOC-HQ row confirmed)
-- ─────────────────────────────────────────────────────────────────────────────
-- RUN THIS DIAGNOSTIC FIRST:
--   SELECT id, item_id, location_id, name, instock, cost, unit
--   FROM public.inventory_items
--   WHERE lower(name) LIKE '%salt%'
--   ORDER BY location_id;
--
-- If LOC-HQ row exists, record its id and use it below.
-- If LOC-HQ row is MISSING, run Step A first.
--
-- ─── Step A (only if LOC-HQ row missing for SALT) ────────────────────────────
-- INSERT INTO public.inventory_items (id, name, item_id, location_id, instock, cost, unit, category, created_at, updated_at)
-- SELECT gen_random_uuid()::text, name, item_id, 'LOC-HQ', 0, cost, unit, category, NOW(), NOW()
-- FROM public.inventory_items
-- WHERE lower(name) LIKE '%salt%'
--   AND location_id = 'LOC-1091'
--   AND NOT EXISTS (
--     SELECT 1 FROM public.inventory_items hq
--     WHERE hq.item_id = (
--         SELECT item_id FROM public.inventory_items WHERE lower(name) LIKE '%salt%' AND location_id = 'LOC-1091' LIMIT 1
--       )
--       AND hq.location_id = 'LOC-HQ'
--   )
-- LIMIT 1;
--
-- ─── Step B: Update outlet_catalog_items for SALT ────────────────────────────
-- UPDATE public.outlet_catalog_items
-- SET
--   source_type          = 'hq_supplied',
--   hq_sale_item_id      = NULL,
--   hq_inventory_item_id = '<inventory_items.id at LOC-HQ for SALT>',
--   supplier             = 'Commissary HQ',
--   updated_at           = NOW()
-- WHERE lower(name) LIKE '%salt%'
--   AND source_type = 'local_vendor';
--
-- ─── Step C: Repair open requisition_items rows for SALT ─────────────────────
-- UPDATE public.requisition_items ri
-- SET
--   source_type                = 'hq_supplied',
--   item_id                    = '<inventory_items.id at LOC-HQ for SALT>',
--   catalog_item_id            = NULL,
--   source_commissary_snapshot = 'Commissary HQ',
--   updated_at                 = NOW()
-- WHERE lower(ri.item_name_snapshot) LIKE '%salt%'
--   AND ri.source_type = 'local_vendor'
--   AND ri.item_id IS NULL
--   AND EXISTS (
--     SELECT 1 FROM public.requisitions r
--     WHERE r.id = ri.requisition_id
--       AND r.status IN ('submitted', 'approved', 'backordered', 'partially_fulfilled')
--   );

-- ── 5. GINGER repair SQL (prepared — DO NOT uncomment until mapping chosen) ───
-- Choose ONE of: GINGER CS / Ginger Powder / Ginger Powder Dry / Ginger Root Fresh
-- Then run same Step B+C pattern as SALT above.
--
-- RUN THIS DIAGNOSTIC FIRST:
--   SELECT id, item_id, location_id, name, instock, cost, unit
--   FROM public.inventory_items
--   WHERE lower(name) LIKE '%ginger%'
--   ORDER BY location_id, name;
