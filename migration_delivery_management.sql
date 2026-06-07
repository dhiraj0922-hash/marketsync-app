-- ─────────────────────────────────────────────────────────────────────────────
-- Delivery Management Phase 1 + Phase 2
-- Additive only. Does not touch inventory, requisition fulfillment, movements,
-- production, recipes, reports, or invoices.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  email text,
  active boolean NOT NULL DEFAULT true,
  hourly_rate numeric,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_name text NOT NULL,
  plate_number text,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.delivery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_number text UNIQUE NOT NULL,
  run_date date NOT NULL,
  driver_id uuid REFERENCES public.drivers(id) ON DELETE SET NULL,
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'assigned', 'loaded', 'in_progress', 'completed', 'cancelled')),
  estimated_distance_km numeric NOT NULL DEFAULT 0,
  estimated_duration_minutes integer NOT NULL DEFAULT 0,
  actual_start_time timestamptz,
  actual_end_time timestamptz,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.delivery_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number text UNIQUE NOT NULL,
  delivery_run_id uuid REFERENCES public.delivery_runs(id) ON DELETE SET NULL,
  requisition_id text REFERENCES public.requisitions(id) ON DELETE SET NULL,
  location_id text REFERENCES public.locations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'assigned', 'loaded', 'out_for_delivery', 'delivered', 'issue_reported', 'cancelled')),
  stop_sequence integer,
  destination_name text,
  destination_address text,
  destination_contact text,
  destination_phone text,
  estimated_arrival_time timestamptz,
  delivered_at timestamptz,
  received_by text,
  proof_photo_url text,
  signature_url text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.delivery_ticket_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_ticket_id uuid NOT NULL REFERENCES public.delivery_tickets(id) ON DELETE CASCADE,
  requisition_item_id uuid,
  inventory_item_id uuid,
  item_name_snapshot text NOT NULL,
  unit_snapshot text,
  requested_qty numeric NOT NULL DEFAULT 0,
  approved_qty numeric NOT NULL DEFAULT 0,
  shipped_qty numeric NOT NULL DEFAULT 0,
  delivered_qty numeric NOT NULL DEFAULT 0,
  issue_qty numeric NOT NULL DEFAULT 0,
  issue_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS delivery_tickets_one_per_requisition_idx
  ON public.delivery_tickets(requisition_id)
  WHERE requisition_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS delivery_tickets_delivery_run_id_idx ON public.delivery_tickets(delivery_run_id);
CREATE INDEX IF NOT EXISTS delivery_tickets_location_id_idx ON public.delivery_tickets(location_id);
CREATE INDEX IF NOT EXISTS delivery_tickets_status_idx ON public.delivery_tickets(status);
CREATE INDEX IF NOT EXISTS delivery_runs_driver_id_idx ON public.delivery_runs(driver_id);
CREATE INDEX IF NOT EXISTS delivery_runs_run_date_idx ON public.delivery_runs(run_date);
CREATE INDEX IF NOT EXISTS delivery_runs_status_idx ON public.delivery_runs(status);
CREATE INDEX IF NOT EXISTS delivery_ticket_items_delivery_ticket_id_idx ON public.delivery_ticket_items(delivery_ticket_id);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS drivers_set_updated_at ON public.drivers;
CREATE TRIGGER drivers_set_updated_at
  BEFORE UPDATE ON public.drivers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS vehicles_set_updated_at ON public.vehicles;
CREATE TRIGGER vehicles_set_updated_at
  BEFORE UPDATE ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS delivery_runs_set_updated_at ON public.delivery_runs;
CREATE TRIGGER delivery_runs_set_updated_at
  BEFORE UPDATE ON public.delivery_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS delivery_tickets_set_updated_at ON public.delivery_tickets;
CREATE TRIGGER delivery_tickets_set_updated_at
  BEFORE UPDATE ON public.delivery_tickets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_ticket_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Drivers: HQ full access" ON public.drivers;
CREATE POLICY "Drivers: HQ full access"
  ON public.drivers
  FOR ALL
  TO authenticated
  USING (public.is_hq_admin_profile())
  WITH CHECK (public.is_hq_admin_profile());

DROP POLICY IF EXISTS "Vehicles: HQ full access" ON public.vehicles;
CREATE POLICY "Vehicles: HQ full access"
  ON public.vehicles
  FOR ALL
  TO authenticated
  USING (public.is_hq_admin_profile())
  WITH CHECK (public.is_hq_admin_profile());

DROP POLICY IF EXISTS "Delivery Runs: HQ full access" ON public.delivery_runs;
CREATE POLICY "Delivery Runs: HQ full access"
  ON public.delivery_runs
  FOR ALL
  TO authenticated
  USING (public.is_hq_admin_profile())
  WITH CHECK (public.is_hq_admin_profile());

DROP POLICY IF EXISTS "Delivery Tickets: Read by Role" ON public.delivery_tickets;
CREATE POLICY "Delivery Tickets: Read by Role"
  ON public.delivery_tickets
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR public.is_location_manager_for(delivery_tickets.location_id)
  );

DROP POLICY IF EXISTS "Delivery Tickets: HQ write" ON public.delivery_tickets;
CREATE POLICY "Delivery Tickets: HQ write"
  ON public.delivery_tickets
  FOR ALL
  TO authenticated
  USING (public.is_hq_admin_profile())
  WITH CHECK (public.is_hq_admin_profile());

DROP POLICY IF EXISTS "Delivery Ticket Items: Read by Role" ON public.delivery_ticket_items;
CREATE POLICY "Delivery Ticket Items: Read by Role"
  ON public.delivery_ticket_items
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR EXISTS (
      SELECT 1
      FROM public.delivery_tickets dt
      WHERE dt.id = delivery_ticket_items.delivery_ticket_id
        AND public.is_location_manager_for(dt.location_id)
    )
  );

DROP POLICY IF EXISTS "Delivery Ticket Items: HQ write" ON public.delivery_ticket_items;
CREATE POLICY "Delivery Ticket Items: HQ write"
  ON public.delivery_ticket_items
  FOR ALL
  TO authenticated
  USING (public.is_hq_admin_profile())
  WITH CHECK (public.is_hq_admin_profile());
