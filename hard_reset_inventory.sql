-- =============================================================================
-- HARD RESET — inventory + finished goods (rows fully deleted)
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
-- DELETES ALL ROWS from:
--   inventory_movements, counts, requisition_items, requisitions,
--   orders, production_history, production_plans,
--   fg_location_pricing, inventory_items, hq_sale_items
--
-- FK dependency order (child → parent):
--   1.  inventory_movements      (no FK children)
--   2.  counts                   (no FK children)
--   3.  fg_location_pricing      FK → hq_sale_items (child)
--   4.  requisition_items        FK → requisitions  (child)
--   5.  requisitions             (parent — cleared after children)
--   6.  orders                   (JSONB lineitems — no child table)
--   7.  production_history       (audit rows — cleared before plans)
--   8.  production_plans         (parent)
--   9.  hq_sale_items            (cleared after fg_location_pricing)
--  10.  inventory_items          (cleared last — nothing FKs into it from above)
--
-- UNTOUCHED:
--   user_profiles, locations, suppliers,
--   recipes, recipe_ingredients, auth.users
-- =============================================================================

BEGIN;

-- ── 1. Inventory movement ledger ─────────────────────────────────────────────
DELETE FROM public.inventory_movements;
SELECT 'inventory_movements cleared' AS step, COUNT(*) AS remaining FROM public.inventory_movements;

-- ── 2. Counts ─────────────────────────────────────────────────────────────────
DELETE FROM public.counts;
SELECT 'counts cleared' AS step, COUNT(*) AS remaining FROM public.counts;

-- ── 3. FG location pricing ────────────────────────────────────────────────────
-- Must delete before hq_sale_items (FK: sale_item_id → hq_sale_items.id)
DELETE FROM public.fg_location_pricing;
SELECT 'fg_location_pricing cleared' AS step, COUNT(*) AS remaining FROM public.fg_location_pricing;

-- ── 4. Requisition line items (child → before parent) ────────────────────────
DELETE FROM public.requisition_items;
SELECT 'requisition_items cleared' AS step, COUNT(*) AS remaining FROM public.requisition_items;

-- ── 5. Requisition headers ───────────────────────────────────────────────────
DELETE FROM public.requisitions;
SELECT 'requisitions cleared' AS step, COUNT(*) AS remaining FROM public.requisitions;

-- ── 6. Purchase orders ────────────────────────────────────────────────────────
DELETE FROM public.orders;
SELECT 'orders cleared' AS step, COUNT(*) AS remaining FROM public.orders;

-- ── 7. Production history (audit rows — cleared before plans) ─────────────────
DELETE FROM public.production_history;
SELECT 'production_history cleared' AS step, COUNT(*) AS remaining FROM public.production_history;

-- ── 8. Production plans ───────────────────────────────────────────────────────
DELETE FROM public.production_plans;
SELECT 'production_plans cleared' AS step, COUNT(*) AS remaining FROM public.production_plans;

-- ── 9. HQ sale items (finished goods catalog) ────────────────────────────────
DELETE FROM public.hq_sale_items;
SELECT 'hq_sale_items cleared' AS step, COUNT(*) AS remaining FROM public.hq_sale_items;

-- ── 10. Inventory items (raw + prep + FG in inventory layer) ──────────────────
DELETE FROM public.inventory_items;
SELECT 'inventory_items cleared' AS step, COUNT(*) AS remaining FROM public.inventory_items;

COMMIT;

-- =============================================================================
-- VERIFICATION — run after commit to confirm all tables are empty
-- =============================================================================
SELECT tbl, row_count FROM (
  SELECT 'inventory_movements'  AS tbl, COUNT(*)::int AS row_count FROM public.inventory_movements   UNION ALL
  SELECT 'counts',                       COUNT(*)      FROM public.counts                             UNION ALL
  SELECT 'fg_location_pricing',          COUNT(*)      FROM public.fg_location_pricing               UNION ALL
  SELECT 'requisition_items',            COUNT(*)      FROM public.requisition_items                  UNION ALL
  SELECT 'requisitions',                 COUNT(*)      FROM public.requisitions                       UNION ALL
  SELECT 'orders',                       COUNT(*)      FROM public.orders                             UNION ALL
  SELECT 'production_history',           COUNT(*)      FROM public.production_history                 UNION ALL
  SELECT 'production_plans',             COUNT(*)      FROM public.production_plans                   UNION ALL
  SELECT 'hq_sale_items',                COUNT(*)      FROM public.hq_sale_items                     UNION ALL
  SELECT 'inventory_items',              COUNT(*)      FROM public.inventory_items
) t
ORDER BY tbl;
-- Every row_count should be 0.

-- =============================================================================
-- SAFETY CHECK — these must still have rows (untouched tables)
-- =============================================================================
SELECT tbl, row_count FROM (
  SELECT 'suppliers'        AS tbl, COUNT(*)::int AS row_count FROM public.suppliers       UNION ALL
  SELECT 'locations',                COUNT(*)      FROM public.locations                   UNION ALL
  SELECT 'user_profiles',            COUNT(*)      FROM public.user_profiles               UNION ALL
  SELECT 'recipes',                  COUNT(*)      FROM public.recipes
) t
ORDER BY tbl;
-- These should all be > 0 (untouched).
