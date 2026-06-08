-- ─────────────────────────────────────────────────────────────────────────────
-- Delivery Management Phase 4: Google Maps Route API Integration
-- Additive only. Safe to run multiple times.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.delivery_runs
  ADD COLUMN IF NOT EXISTS route_estimate_source text DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS route_estimated_at timestamptz,
  ADD COLUMN IF NOT EXISTS route_polyline text,
  ADD COLUMN IF NOT EXISTS google_route_summary jsonb;

-- Ensure delivery_tickets has estimated_arrival_time column.
-- (This column is already defined in Phase 1, but we ensure it exists).
ALTER TABLE public.delivery_tickets
  ADD COLUMN IF NOT EXISTS estimated_arrival_time timestamptz;
