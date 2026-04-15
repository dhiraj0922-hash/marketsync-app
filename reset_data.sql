-- =============================================================================
-- SAFE RESET SCRIPT — StockIQ / Supabase
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
--
-- DELETE ORDER (child before parent):
--   inventory_movements       child ledger — no FK children
--   ai_import_logs            standalone log table
--   import_batches            standalone import history
--   requisition_items         child of requisitions (FK: requisition_id)
--   requisitions              parent — deleted after its children
--   orders                    line items stored as JSONB lineitems column (no child table)
--   counts                    line items stored as JSONB items column (no child table)
--   production_history        child audit rows for production
--   production_plans          parent production plan rows
--
-- SOFT RESET (rows kept, stock/cost zeroed):
--   inventory_items           instock → 0, avg_cost → 0
--   hq_sale_items             instock → 0, making_cost → 0
--
-- UNTOUCHED (master/config):
--   suppliers, recipes, recipe_ingredients, locations,
--   user_profiles, auth.users, hq_sale_items (structure),
--   item_groups, categories
-- =============================================================================

BEGIN;

-- ── 1. Inventory movement ledger ──────────────────────────────────────────────
DELETE FROM public.inventory_movements;

-- ── 2. AI import logs ─────────────────────────────────────────────────────────
DELETE FROM public.ai_import_logs;

-- ── 3. CSV import batches ─────────────────────────────────────────────────────
DELETE FROM public.import_batches;

-- ── 4. Requisition line items (child → before parent) ─────────────────────────
DELETE FROM public.requisition_items;

-- ── 5. Requisition headers ────────────────────────────────────────────────────
DELETE FROM public.requisitions;

-- ── 6. Purchase orders (lineitems embedded as JSONB — no child table) ─────────
DELETE FROM public.orders;

-- ── 7. Inventory counts (items embedded as JSONB — no child table) ─────────────
DELETE FROM public.counts;

-- ── 8. Production history (audit rows — child before plans) ───────────────────
DELETE FROM public.production_history;

-- ── 9. Production plans ───────────────────────────────────────────────────────
DELETE FROM public.production_plans;

-- ── 10. Zero HQ inventory stock (keep master rows, names, par levels) ──────────
UPDATE public.inventory_items
SET    instock   = 0,
       avg_cost  = 0;    -- remove this line if avg_cost column not yet migrated

-- ── 11. Zero HQ sale item stock (keep items, prices, recipe links) ─────────────
UPDATE public.hq_sale_items
SET    instock     = 0,
       making_cost = 0;

COMMIT;

-- =============================================================================
-- VERIFICATION — all transactional tables should show 0 rows
-- =============================================================================
SELECT tbl, row_count FROM (
  SELECT 'inventory_movements'       AS tbl, COUNT(*)::int AS row_count FROM public.inventory_movements        UNION ALL
  SELECT 'ai_import_logs',                   COUNT(*)      FROM public.ai_import_logs                         UNION ALL
  SELECT 'import_batches',                   COUNT(*)      FROM public.import_batches                         UNION ALL
  SELECT 'requisition_items',                COUNT(*)      FROM public.requisition_items                      UNION ALL
  SELECT 'requisitions',                     COUNT(*)      FROM public.requisitions                           UNION ALL
  SELECT 'orders',                           COUNT(*)      FROM public.orders                                 UNION ALL
  SELECT 'counts',                           COUNT(*)      FROM public.counts                                 UNION ALL
  SELECT 'production_history',               COUNT(*)      FROM public.production_history                     UNION ALL
  SELECT 'production_plans',                 COUNT(*)      FROM public.production_plans                      UNION ALL
  -- Soft-reset verification: master rows should still exist, stock should be 0
  SELECT 'inventory_items (total rows)',      COUNT(*)      FROM public.inventory_items                       UNION ALL
  SELECT 'inventory_items (instock=0)',       COUNT(*)      FROM public.inventory_items  WHERE instock = 0    UNION ALL
  SELECT 'hq_sale_items (total rows)',        COUNT(*)      FROM public.hq_sale_items                        UNION ALL
  SELECT 'hq_sale_items (instock=0)',         COUNT(*)      FROM public.hq_sale_items    WHERE instock = 0
) t
ORDER BY tbl;
