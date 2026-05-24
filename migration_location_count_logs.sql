-- =============================================================================
-- MIGRATION: Location Physical Count Audit Logs
-- Safe additive migration — creates location_inventory_count_logs.
-- Run ONCE against your Supabase project.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.location_inventory_count_logs (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     TEXT         NOT NULL,
  item_id         TEXT         NOT NULL,
  previous_stock  NUMERIC      NOT NULL,
  physical_count  NUMERIC      NOT NULL,
  variance_qty    NUMERIC      NOT NULL,
  counted_by      UUID,
  notes           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loc_count_logs_location_id
  ON public.location_inventory_count_logs (location_id);

CREATE INDEX IF NOT EXISTS idx_loc_count_logs_item_id
  ON public.location_inventory_count_logs (item_id);

CREATE INDEX IF NOT EXISTS idx_loc_count_logs_created_at
  ON public.location_inventory_count_logs (created_at DESC);

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.location_inventory_count_logs ENABLE ROW LEVEL SECURITY;

-- HQ admin can read all logs
DROP POLICY IF EXISTS "Count Logs: HQ admin read all" ON public.location_inventory_count_logs;
CREATE POLICY "Count Logs: HQ admin read all"
  ON public.location_inventory_count_logs
  FOR SELECT
  TO authenticated
  USING ( public.get_my_role() = 'hq_admin' );

-- Location manager can read their own location's logs
DROP POLICY IF EXISTS "Count Logs: Location manager read own" ON public.location_inventory_count_logs;
CREATE POLICY "Count Logs: Location manager read own"
  ON public.location_inventory_count_logs
  FOR SELECT
  TO authenticated
  USING (
    public.get_my_role() = 'location_manager'
    AND location_id = public.get_my_location_id()
  );

-- Location manager can insert logs for their own location
DROP POLICY IF EXISTS "Count Logs: Location manager insert own" ON public.location_inventory_count_logs;
CREATE POLICY "Count Logs: Location manager insert own"
  ON public.location_inventory_count_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    location_id = public.get_my_location_id()
    OR public.get_my_role() = 'hq_admin'
  );

-- Service role (API routes, edge functions) can do anything
DROP POLICY IF EXISTS "Count Logs: Service role all" ON public.location_inventory_count_logs;
CREATE POLICY "Count Logs: Service role all"
  ON public.location_inventory_count_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
