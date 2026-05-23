-- =============================================================================
-- MIGRATION: HQ requisition notification emails
-- Safe additive migration for location/franchise → HQ requisition notifications.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.requisition_email_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id      TEXT REFERENCES public.requisitions(id) ON DELETE SET NULL,
  location_id         TEXT REFERENCES public.locations(id) ON DELETE SET NULL,
  recipient_email     TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  provider            TEXT NOT NULL DEFAULT 'resend',
  provider_id         TEXT,
  error               TEXT,
  triggered_by        UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_requisition_email_logs_requisition_id
  ON public.requisition_email_logs (requisition_id);

CREATE INDEX IF NOT EXISTS idx_requisition_email_logs_created_at
  ON public.requisition_email_logs (created_at DESC);

ALTER TABLE public.requisition_email_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Requisition Email Logs: Read by Role" ON public.requisition_email_logs;
CREATE POLICY "Requisition Email Logs: Read by Role"
  ON public.requisition_email_logs
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR public.is_location_manager_for(requisition_email_logs.location_id)
  );

DROP POLICY IF EXISTS "Requisition Email Logs: Service Write" ON public.requisition_email_logs;
CREATE POLICY "Requisition Email Logs: Service Write"
  ON public.requisition_email_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

