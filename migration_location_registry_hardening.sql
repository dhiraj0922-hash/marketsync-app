-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Location Registry Hardening
-- Run in Supabase SQL Editor (safe to run multiple times — additive only)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add new columns to locations if missing
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS purpose TEXT DEFAULT 'store',
  ADD COLUMN IF NOT EXISTS is_delivery_destination BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_hq BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL;

-- 2. Backfill system locations & default values
-- Mark LOC-HQ as HQ and Internal and not a delivery destination
UPDATE public.locations
SET 
  is_hq = true,
  is_internal = true,
  is_delivery_destination = false,
  purpose = 'hq'
WHERE id = 'LOC-HQ';

-- Verify and ensure active stores are marked as delivery destinations and non-HQ
UPDATE public.locations
SET
  is_hq = false,
  is_internal = false,
  is_delivery_destination = true
WHERE id != 'LOC-HQ' AND (type = 'branch' OR subtype = 'Store');

-- Ensure all existing locations have a purpose defaulted to 'store' if null
UPDATE public.locations
SET purpose = 'store'
WHERE purpose IS NULL;
