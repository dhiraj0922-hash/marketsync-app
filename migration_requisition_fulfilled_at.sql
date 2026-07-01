-- ============================================================
-- Migration: Add fulfilled_at / fulfilled_by to requisitions
-- Run in: Supabase SQL Editor
-- Safe to run multiple times (IF NOT EXISTS / WHERE NULL guards)
-- ============================================================

-- 1. Add the two columns (no-op if they already exist)
ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS fulfilled_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulfilled_by  TEXT;

-- 2. Backfill fulfilled_at for existing fulfilled requisitions
--    Use MAX(requisition_items.fulfilled_at) per requisition.
UPDATE public.requisitions r
SET fulfilled_at = sub.max_fulfilled_at
FROM (
  SELECT
    requisition_id,
    MAX(fulfilled_at) AS max_fulfilled_at
  FROM public.requisition_items
  WHERE fulfilled_at IS NOT NULL
  GROUP BY requisition_id
) sub
WHERE r.id = sub.requisition_id
  AND r.status = 'fulfilled'
  AND r.fulfilled_at IS NULL;

-- 3. For any fulfilled requisitions still missing fulfilled_at
--    fall back to updated_at if the column exists.
UPDATE public.requisitions r
SET fulfilled_at = r.updated_at
WHERE r.status = 'fulfilled'
  AND r.fulfilled_at IS NULL
  AND r.updated_at IS NOT NULL;

-- 4. Verify
SELECT id, status, fulfilled_at, fulfilled_by
FROM public.requisitions
WHERE status = 'fulfilled'
ORDER BY fulfilled_at DESC NULLS LAST
LIMIT 20;
