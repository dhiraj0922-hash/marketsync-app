-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: hq_sale_items — add pack_qty column
--
-- Purpose:
--   Allow HQ Finished Goods to define a "pack / case quantity" so the UI can
--   show an effective pack price:
--
--     effectivePackPrice = unitSalePrice × packQty
--
--   Example: DOSA BATTER 11L per pack
--     unitSalePrice = $3.00 / l
--     packQty       = 11
--     effectivePackPrice = $33.00 / pack
--
-- Design decisions:
--   • DEFAULT 1 — existing rows without a pack_qty behave identically to before
--     (pack price = unit price × 1 = unit price). No data migration needed.
--   • NOT NULL is intentional on DEFAULT 1 so application code can always rely
--     on pack_qty being a non-null number.
--   • This column does NOT affect making_cost, suggested_price, or any RPC.
--     It is a display-only multiplier for the HQ catalog page.
--   • No RLS change — hq_sale_items already has RLS disabled.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.hq_sale_items
  ADD COLUMN IF NOT EXISTS pack_qty NUMERIC NOT NULL DEFAULT 1;

-- Verify
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'hq_sale_items'
  AND column_name  = 'pack_qty';
