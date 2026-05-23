-- =============================================================================
-- MIGRATION: supplier order email sending
-- Safe additive migration for existing orders/suppliers flow.
--
-- Adds delivery metadata directly to public.orders and creates a small email log
-- because no existing supplier-order email audit table is present.
-- =============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_error TEXT;

CREATE TABLE IF NOT EXISTS public.order_email_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        TEXT REFERENCES public.orders(id) ON DELETE SET NULL,
  supplier_id     INTEGER REFERENCES public.suppliers(id) ON DELETE SET NULL,
  supplier_email  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  provider        TEXT NOT NULL DEFAULT 'resend',
  provider_id     TEXT,
  error           TEXT,
  sent_by         UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_email_logs_order_id
  ON public.order_email_logs (order_id);

CREATE INDEX IF NOT EXISTS idx_order_email_logs_created_at
  ON public.order_email_logs (created_at DESC);

ALTER TABLE public.order_email_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Order Email Logs: Read by Order Role" ON public.order_email_logs;
CREATE POLICY "Order Email Logs: Read by Order Role"
  ON public.order_email_logs
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.id = order_email_logs.order_id
        AND public.is_location_manager_for(o.location_id)
    )
  );

DROP POLICY IF EXISTS "Order Email Logs: Service Write" ON public.order_email_logs;
CREATE POLICY "Order Email Logs: Service Write"
  ON public.order_email_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

