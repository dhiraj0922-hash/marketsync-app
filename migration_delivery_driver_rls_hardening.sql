-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Driver Delivery Access RLS Hardening
-- Additive only. Run in Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. DRIVERS TABLE ACCESS
DROP POLICY IF EXISTS "Drivers: Driver read active own" ON public.drivers;
CREATE POLICY "Drivers: Driver read active own" ON public.drivers
  FOR SELECT TO authenticated
  USING (lower(email) = auth.jwt()->>'email' AND active = true);

-- 2. VEHICLES TABLE ACCESS
DROP POLICY IF EXISTS "Vehicles: Driver read active" ON public.vehicles;
CREATE POLICY "Vehicles: Driver read active" ON public.vehicles
  FOR SELECT TO authenticated
  USING (active = true);

-- 3. VEHICLE DAILY LOGS ACCESS
-- SELECT policy
DROP POLICY IF EXISTS "Vehicle Logs: Driver read own" ON public.vehicle_daily_logs;
CREATE POLICY "Vehicle Logs: Driver read own" ON public.vehicle_daily_logs
  FOR SELECT TO authenticated
  USING (
    driver_id IN (
      SELECT id FROM public.drivers 
      WHERE lower(email) = auth.jwt()->>'email' AND active = true
    )
  );

-- INSERT policy
DROP POLICY IF EXISTS "Vehicle Logs: Driver insert own" ON public.vehicle_daily_logs;
CREATE POLICY "Vehicle Logs: Driver insert own" ON public.vehicle_daily_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    driver_id IN (
      SELECT id FROM public.drivers 
      WHERE lower(email) = auth.jwt()->>'email' AND active = true
    )
  );

-- UPDATE policy
DROP POLICY IF EXISTS "Vehicle Logs: Driver update own" ON public.vehicle_daily_logs;
CREATE POLICY "Vehicle Logs: Driver update own" ON public.vehicle_daily_logs
  FOR UPDATE TO authenticated
  USING (
    driver_id IN (
      SELECT id FROM public.drivers 
      WHERE lower(email) = auth.jwt()->>'email' AND active = true
    )
  )
  WITH CHECK (
    driver_id IN (
      SELECT id FROM public.drivers 
      WHERE lower(email) = auth.jwt()->>'email' AND active = true
    )
  );

-- 4. DELIVERY RUNS TABLE ACCESS
-- SELECT policy
DROP POLICY IF EXISTS "Delivery Runs: Driver read assigned" ON public.delivery_runs;
CREATE POLICY "Delivery Runs: Driver read assigned" ON public.delivery_runs
  FOR SELECT TO authenticated
  USING (
    driver_id IN (
      SELECT id FROM public.drivers 
      WHERE lower(email) = auth.jwt()->>'email' AND active = true
    )
  );

-- UPDATE policy
DROP POLICY IF EXISTS "Delivery Runs: Driver update assigned" ON public.delivery_runs;
CREATE POLICY "Delivery Runs: Driver update assigned" ON public.delivery_runs
  FOR UPDATE TO authenticated
  USING (
    driver_id IN (
      SELECT id FROM public.drivers 
      WHERE lower(email) = auth.jwt()->>'email' AND active = true
    )
  )
  WITH CHECK (
    driver_id IN (
      SELECT id FROM public.drivers 
      WHERE lower(email) = auth.jwt()->>'email' AND active = true
    )
  );

-- 5. DELIVERY TICKETS TABLE ACCESS
-- SELECT policy
DROP POLICY IF EXISTS "Delivery Tickets: Driver read stops" ON public.delivery_tickets;
CREATE POLICY "Delivery Tickets: Driver read stops" ON public.delivery_tickets
  FOR SELECT TO authenticated
  USING (
    delivery_run_id IN (
      SELECT id FROM public.delivery_runs
      WHERE driver_id IN (
        SELECT id FROM public.drivers 
        WHERE lower(email) = auth.jwt()->>'email' AND active = true
      )
    )
  );

-- UPDATE policy
DROP POLICY IF EXISTS "Delivery Tickets: Driver update stops" ON public.delivery_tickets;
CREATE POLICY "Delivery Tickets: Driver update stops" ON public.delivery_tickets
  FOR UPDATE TO authenticated
  USING (
    delivery_run_id IN (
      SELECT id FROM public.delivery_runs
      WHERE driver_id IN (
        SELECT id FROM public.drivers 
        WHERE lower(email) = auth.jwt()->>'email' AND active = true
      )
    )
  )
  WITH CHECK (
    delivery_run_id IN (
      SELECT id FROM public.delivery_runs
      WHERE driver_id IN (
        SELECT id FROM public.drivers 
        WHERE lower(email) = auth.jwt()->>'email' AND active = true
      )
    )
  );

-- 6. DELIVERY TICKET ITEMS TABLE ACCESS
-- SELECT policy
DROP POLICY IF EXISTS "Delivery Ticket Items: Driver read items" ON public.delivery_ticket_items;
CREATE POLICY "Delivery Ticket Items: Driver read items" ON public.delivery_ticket_items
  FOR SELECT TO authenticated
  USING (
    delivery_ticket_id IN (
      SELECT id FROM public.delivery_tickets
      WHERE delivery_run_id IN (
        SELECT id FROM public.delivery_runs
        WHERE driver_id IN (
          SELECT id FROM public.drivers 
          WHERE lower(email) = auth.jwt()->>'email' AND active = true
        )
      )
    )
  );

-- UPDATE policy
DROP POLICY IF EXISTS "Delivery Ticket Items: Driver update items" ON public.delivery_ticket_items;
CREATE POLICY "Delivery Ticket Items: Driver update items" ON public.delivery_ticket_items
  FOR UPDATE TO authenticated
  USING (
    delivery_ticket_id IN (
      SELECT id FROM public.delivery_tickets
      WHERE delivery_run_id IN (
        SELECT id FROM public.delivery_runs
        WHERE driver_id IN (
          SELECT id FROM public.drivers 
          WHERE lower(email) = auth.jwt()->>'email' AND active = true
        )
      )
    )
  )
  WITH CHECK (
    delivery_ticket_id IN (
      SELECT id FROM public.delivery_tickets
      WHERE delivery_run_id IN (
        SELECT id FROM public.delivery_runs
        WHERE driver_id IN (
          SELECT id FROM public.drivers 
          WHERE lower(email) = auth.jwt()->>'email' AND active = true
        )
      )
    )
  );
