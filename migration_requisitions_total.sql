-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: requisitions.total_amount
-- Run in Supabase SQL Editor. Safe to re-run — ADD COLUMN IF NOT EXISTS.
--
-- Adds total_amount to the requisitions header row.
-- This is the canonical source of truth for requisition total value.
-- Computed by the app as SUM(line_total) before insert and stored here so
-- every downstream consumer (list, detail, HQ review, dashboard) can read
-- it without re-joining requisition_items.
--
-- Backfill: computes total from requisition_items for all existing rows.
-- Rows without line items get total_amount = 0 (graceful degradation).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add column
ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS total_amount NUMERIC DEFAULT 0;

COMMENT ON COLUMN public.requisitions.total_amount IS
  'Grand total value of the requisition (SUM of requisition_items.line_total). '
  'Written by the app on create. Backfilled for legacy rows from requisition_items.';

-- 2. Backfill existing rows from requisition_items
UPDATE public.requisitions r
SET    total_amount = COALESCE(
         (SELECT SUM(ri.line_total)
          FROM   public.requisition_items ri
          WHERE  ri.requisition_id = r.id),
         0
       )
WHERE  r.total_amount IS NULL OR r.total_amount = 0;

-- 3. Verify
SELECT id, total_amount, items
FROM   public.requisitions
ORDER  BY created_at DESC
LIMIT  10;
