-- =============================================================================
-- MIGRATION: migration_backorder_unique_index.sql
-- Purpose: Create a partial unique index on requisition_backorders to prevent
--          duplicate backorder records for the same original requisition line.
--
-- IMPORTANT: This file MUST be run as a standalone statement, outside any
-- transaction block. CREATE INDEX CONCURRENTLY cannot run inside a transaction.
--
-- In Supabase SQL Editor: paste and run this statement alone.
-- In psql: do not wrap in BEGIN/COMMIT.
--
-- Run ONLY after:
--   1. migration_backorder_reason_and_rls.sql has been applied successfully.
--   2. The duplicate check query has confirmed 0 duplicate rows:
--      SELECT original_requisition_item_id, COUNT(*) AS cnt
--      FROM public.requisition_backorders
--      WHERE original_requisition_item_id IS NOT NULL
--      GROUP BY original_requisition_item_id
--      HAVING COUNT(*) > 1;
-- =============================================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  requisition_backorders_unique_original_line
ON public.requisition_backorders (original_requisition_item_id)
WHERE original_requisition_item_id IS NOT NULL;

-- =============================================================================
-- Verification query (run after the index creation completes):
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'requisition_backorders'
--   AND indexname = 'requisition_backorders_unique_original_line';
-- =============================================================================
