-- ─────────────────────────────────────────────────────────────────────────────
-- Delivery Management Phase 3: Route Tracking + Vehicle Daily Logs
-- Additive only. Does not drop/rewrite existing delivery tables and does not
-- touch inventory, requisition fulfillment, movements, recipes, production,
-- reports, or invoices.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.delivery_runs
  ADD COLUMN IF NOT EXISTS start_location_name text,
  ADD COLUMN IF NOT EXISTS start_address text,
  ADD COLUMN IF NOT EXISTS odometer_start_km numeric,
  ADD COLUMN IF NOT EXISTS odometer_end_km numeric,
  ADD COLUMN IF NOT EXISTS actual_distance_km numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_duration_minutes integer NOT NULL DEFAULT 0;

ALTER TABLE public.delivery_tickets
  ADD COLUMN IF NOT EXISTS arrived_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_notes text,
  ADD COLUMN IF NOT EXISTS driver_departed_previous_stop_at timestamptz;

CREATE TABLE IF NOT EXISTS public.vehicle_daily_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  log_date date NOT NULL,
  driver_id uuid REFERENCES public.drivers(id) ON DELETE SET NULL,
  odometer_start_km numeric NOT NULL,
  odometer_end_km numeric,
  total_odometer_km numeric,
  total_run_km numeric,
  variance_km numeric,
  fuel_start_level text,
  fuel_end_level text,
  start_condition_notes text,
  end_condition_notes text,
  damage_reported boolean NOT NULL DEFAULT false,
  damage_notes text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'cancelled')),
  created_by uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(vehicle_id, log_date)
);

CREATE INDEX IF NOT EXISTS vehicle_daily_logs_vehicle_id_idx ON public.vehicle_daily_logs(vehicle_id);
CREATE INDEX IF NOT EXISTS vehicle_daily_logs_driver_id_idx ON public.vehicle_daily_logs(driver_id);
CREATE INDEX IF NOT EXISTS vehicle_daily_logs_log_date_idx ON public.vehicle_daily_logs(log_date);
CREATE INDEX IF NOT EXISTS vehicle_daily_logs_status_idx ON public.vehicle_daily_logs(status);
CREATE INDEX IF NOT EXISTS delivery_runs_vehicle_run_date_idx ON public.delivery_runs(vehicle_id, run_date);
CREATE INDEX IF NOT EXISTS delivery_runs_driver_run_date_idx ON public.delivery_runs(driver_id, run_date);
CREATE INDEX IF NOT EXISTS delivery_tickets_run_sequence_idx ON public.delivery_tickets(delivery_run_id, stop_sequence);

DROP TRIGGER IF EXISTS vehicle_daily_logs_set_updated_at ON public.vehicle_daily_logs;
CREATE TRIGGER vehicle_daily_logs_set_updated_at
  BEFORE UPDATE ON public.vehicle_daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.vehicle_daily_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Vehicle Daily Logs: HQ full access" ON public.vehicle_daily_logs;
CREATE POLICY "Vehicle Daily Logs: HQ full access"
  ON public.vehicle_daily_logs
  FOR ALL
  TO authenticated
  USING (public.is_hq_admin_profile())
  WITH CHECK (public.is_hq_admin_profile());
