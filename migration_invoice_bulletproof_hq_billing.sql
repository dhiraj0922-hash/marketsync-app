-- ============================================================
-- STOCK DHARMA — BULLETPROOF HQ INVOICING RESET
-- Requisition-level duplicate guard, fulfilled-quantity billing only.
--
-- Safe design:
--   * One shared candidate source:
--       public.get_billable_requisition_candidates(...)
--   * Audit and generate both consume that source.
--   * Invoice generation snapshots fulfilled HQ lines only.
--   * Local vendor and backordered/unfulfilled quantities are excluded.
--   * HST is calculated server-side.
--   * Voided invoices do not block regeneration.
--
-- Run after existing invoice migrations.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Snapshot columns for permanent invoice line data ────────────────────────
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS unit_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS pack_qty_snapshot NUMERIC,
  ADD COLUMN IF NOT EXISTS quantity_fulfilled_snapshot NUMERIC,
  ADD COLUMN IF NOT EXISTS source_type_snapshot TEXT;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS location_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC NOT NULL DEFAULT 0.13,
  ADD COLUMN IF NOT EXISTS tax_name TEXT NOT NULL DEFAULT 'HST',
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID;

-- Helpful indexes; all are non-destructive.
CREATE INDEX IF NOT EXISTS idx_requisition_items_req_fulfilled
  ON public.requisition_items(requisition_id, fulfilled_at, updated_at)
  WHERE COALESCE(quantity_fulfilled, 0) > 0;

CREATE INDEX IF NOT EXISTS idx_invoice_items_requisition_item_id
  ON public.invoice_items(requisition_item_id);

-- Older monthly-only guard blocks daily/biweekly invoices in the same month.
DROP INDEX IF EXISTS public.invoices_location_month_active_idx;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_location_period_frequency_active_idx
  ON public.invoices(location_id, period_start, period_end, billing_frequency)
  WHERE status <> 'void';

-- ── Replace old public RPCs/views with the new shared-source contract ────────
DROP FUNCTION IF EXISTS public.get_billable_requisition_candidates(TEXT, DATE, DATE, TEXT);
DROP FUNCTION IF EXISTS public.get_invoice_eligibility_audit(TEXT, DATE, DATE, TEXT);
DROP FUNCTION IF EXISTS public.generate_invoices(TEXT, DATE, TEXT);
DROP FUNCTION IF EXISTS public.generate_monthly_invoices(DATE, TEXT);

-- ============================================================
-- Shared eligibility source
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_billable_requisition_candidates(
  p_billing_frequency TEXT,
  p_period_start DATE,
  p_period_end DATE,
  p_location_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  requisition_id TEXT,
  request_id TEXT,
  location_id TEXT,
  location_name TEXT,
  status TEXT,
  fulfillment_anchor_at TIMESTAMPTZ,
  source_type_summary TEXT,
  fulfilled_qty_total NUMERIC,
  fulfilled_value_total NUMERIC,
  backorder_qty_total NUMERIC,
  existing_invoice_id TEXT,
  existing_invoice_number TEXT,
  existing_invoice_status TEXT,
  is_eligible BOOLEAN,
  exclusion_reason TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT
      CASE
        WHEN p_billing_frequency = 'monthly'
          THEN date_trunc('month', p_period_start)::date
        WHEN p_billing_frequency = 'biweekly' AND extract(day from p_period_start) <= 15
          THEN date_trunc('month', p_period_start)::date
        WHEN p_billing_frequency = 'biweekly'
          THEN (date_trunc('month', p_period_start)::date + interval '15 days')::date
        ELSE p_period_start
      END AS period_start,
      CASE
        WHEN p_billing_frequency = 'monthly'
          THEN (date_trunc('month', p_period_start) + interval '1 month')::date
        WHEN p_billing_frequency = 'biweekly' AND extract(day from p_period_start) <= 15
          THEN (date_trunc('month', p_period_start)::date + interval '15 days')::date
        WHEN p_billing_frequency = 'biweekly'
          THEN (date_trunc('month', p_period_start) + interval '1 month')::date
        ELSE (p_period_end + interval '1 day')::date
      END AS period_end_exclusive
    WHERE public.is_hq_admin_profile()
  ),
  line_rollup AS (
    SELECT
      r.id AS req_id,
      r.location_id AS loc_id,
      COALESCE(l.name, r.location, r.location_id) AS loc_name,
      r.status AS req_status,
      r.invoice_id AS req_invoice_id,
      MAX(COALESCE(ri.fulfilled_at, ri.updated_at)) FILTER (
        WHERE COALESCE(ri.quantity_fulfilled, 0) > 0
      ) AS anchor_at,
      COUNT(*) FILTER (WHERE COALESCE(ri.quantity_fulfilled, 0) > 0) AS fulfilled_line_count,
      COUNT(*) FILTER (
        WHERE COALESCE(ri.quantity_fulfilled, 0) > 0
          AND lower(COALESCE(ri.source_type, 'hq_supplied')) = 'local_vendor'
      ) AS local_vendor_fulfilled_line_count,
      COUNT(*) FILTER (
        WHERE COALESCE(ri.quantity_fulfilled, 0) > 0
          AND lower(COALESCE(ri.source_type, 'hq_supplied')) <> 'local_vendor'
      ) AS hq_fulfilled_line_count,
      string_agg(DISTINCT COALESCE(ri.source_type, 'hq_supplied'), ', ' ORDER BY COALESCE(ri.source_type, 'hq_supplied')) AS source_types,
      COALESCE(SUM(COALESCE(ri.quantity_fulfilled, 0)) FILTER (
        WHERE lower(COALESCE(ri.source_type, 'hq_supplied')) <> 'local_vendor'
      ), 0) AS billable_fulfilled_qty,
      COALESCE(SUM(
        CASE
          WHEN lower(COALESCE(ri.source_type, 'hq_supplied')) = 'local_vendor' THEN 0
          WHEN COALESCE(ri.quantity_fulfilled, 0) <= 0 THEN 0
          WHEN ri.fulfilled_value IS NOT NULL THEN ri.fulfilled_value
          WHEN ri.unit_price IS NOT NULL THEN COALESCE(ri.quantity_fulfilled, 0) * ri.unit_price
          WHEN COALESCE(ri.quantity_requested, 0) > 0 THEN
            COALESCE(ri.line_total, 0) * COALESCE(ri.quantity_fulfilled, 0) / NULLIF(ri.quantity_requested, 0)
          ELSE 0
        END
      ), 0) AS billable_fulfilled_value,
      COALESCE(SUM(
        GREATEST(
          COALESCE(ri.backorder_qty, COALESCE(ri.quantity_requested, 0) - COALESCE(ri.quantity_fulfilled, 0)),
          0
        )
      ), 0) AS backorder_qty
    FROM public.requisitions r
    LEFT JOIN public.requisition_items ri ON ri.requisition_id = r.id
    LEFT JOIN public.locations l ON l.id = r.location_id
    WHERE r.location_id IS NOT NULL
      AND r.location_id <> 'LOC-HQ'
      AND (p_location_id IS NULL OR r.location_id = p_location_id)
    GROUP BY r.id, r.location_id, COALESCE(l.name, r.location, r.location_id), r.status, r.invoice_id
  ),
  scoped AS (
    SELECT lr.*
    FROM line_rollup lr
    CROSS JOIN bounds b
    WHERE lr.anchor_at >= (b.period_start::timestamp AT TIME ZONE 'America/Toronto')
      AND lr.anchor_at < (b.period_end_exclusive::timestamp AT TIME ZONE 'America/Toronto')
  ),
  active_invoice AS (
    SELECT id, invoice_number, status
    FROM public.invoices
    WHERE status IN ('draft', 'issued', 'sent', 'paid', 'finalized')
  )
  SELECT
    s.req_id::text AS requisition_id,
    s.req_id::text AS request_id,
    s.loc_id::text AS location_id,
    s.loc_name::text AS location_name,
    COALESCE(s.req_status, '')::text AS status,
    s.anchor_at AS fulfillment_anchor_at,
    COALESCE(s.source_types, 'none')::text AS source_type_summary,
    ROUND(COALESCE(s.billable_fulfilled_qty, 0)::numeric, 4) AS fulfilled_qty_total,
    ROUND(COALESCE(s.billable_fulfilled_value, 0)::numeric, 2) AS fulfilled_value_total,
    ROUND(COALESCE(s.backorder_qty, 0)::numeric, 4) AS backorder_qty_total,
    ai.id::text AS existing_invoice_id,
    ai.invoice_number::text AS existing_invoice_number,
    ai.status::text AS existing_invoice_status,
    (
      lower(COALESCE(s.req_status, '')) IN ('fulfilled', 'partially_fulfilled', 'partial', 'partial_fulfilled', 'backordered')
      AND ai.id IS NULL
      AND COALESCE(s.hq_fulfilled_line_count, 0) > 0
      AND COALESCE(s.billable_fulfilled_qty, 0) > 0
      AND COALESCE(s.billable_fulfilled_value, 0) > 0
    ) AS is_eligible,
    CASE
      WHEN lower(COALESCE(s.req_status, '')) IN ('draft', 'submitted', 'approved')
        THEN 'Not fulfilled yet: ' || COALESCE(s.req_status, 'unknown')
      WHEN lower(COALESCE(s.req_status, '')) IN ('rejected', 'cancelled', 'voided', 'void')
        THEN 'Cancelled/rejected/voided requisition'
      WHEN ai.id IS NOT NULL
        THEN 'Already invoiced: ' || COALESCE(ai.invoice_number, ai.id::text)
      WHEN COALESCE(s.fulfilled_line_count, 0) = 0
        THEN 'No fulfilled quantity'
      WHEN COALESCE(s.hq_fulfilled_line_count, 0) = 0 AND COALESCE(s.local_vendor_fulfilled_line_count, 0) > 0
        THEN 'Local vendor lines only'
      WHEN COALESCE(s.billable_fulfilled_qty, 0) <= 0
        THEN 'No billable fulfilled HQ quantity'
      WHEN COALESCE(s.billable_fulfilled_value, 0) <= 0
        THEN 'Fulfilled value is zero'
      ELSE NULL
    END::text AS exclusion_reason
  FROM scoped s
  LEFT JOIN active_invoice ai ON ai.id = s.req_invoice_id
  ORDER BY s.anchor_at DESC NULLS LAST, s.loc_name, s.req_id;
$$;

REVOKE ALL ON FUNCTION public.get_billable_requisition_candidates(TEXT, DATE, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_billable_requisition_candidates(TEXT, DATE, DATE, TEXT) TO authenticated;

-- ============================================================
-- Compatibility audit RPC: now a thin wrapper around shared source
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_invoice_eligibility_audit(
  p_billing_frequency TEXT,
  p_period_start DATE,
  p_period_end DATE,
  p_location_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  requisition_id TEXT,
  location_id TEXT,
  location_name TEXT,
  request_date TEXT,
  header_status TEXT,
  fulfillment_date TIMESTAMPTZ,
  fulfillment_source TEXT,
  fulfilled_qty NUMERIC,
  fulfilled_value NUMERIC,
  backorder_qty NUMERIC,
  existing_invoice_id TEXT,
  existing_invoice_no TEXT,
  existing_inv_status TEXT,
  result TEXT,
  exclusion_reason TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.requisition_id,
    c.location_id,
    c.location_name,
    c.request_id AS request_date,
    c.status AS header_status,
    c.fulfillment_anchor_at AS fulfillment_date,
    'MAX(COALESCE(requisition_items.fulfilled_at, requisition_items.updated_at))'::text AS fulfillment_source,
    c.fulfilled_qty_total AS fulfilled_qty,
    c.fulfilled_value_total AS fulfilled_value,
    c.backorder_qty_total AS backorder_qty,
    c.existing_invoice_id,
    c.existing_invoice_number AS existing_invoice_no,
    c.existing_invoice_status AS existing_inv_status,
    CASE WHEN c.is_eligible THEN 'Eligible' ELSE 'Excluded' END AS result,
    c.exclusion_reason
  FROM public.get_billable_requisition_candidates(p_billing_frequency, p_period_start, p_period_end, p_location_id) c;
$$;

REVOKE ALL ON FUNCTION public.get_invoice_eligibility_audit(TEXT, DATE, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invoice_eligibility_audit(TEXT, DATE, DATE, TEXT) TO authenticated;

-- ============================================================
-- Generation RPC: consumes shared source, locks requisitions, snapshots lines
-- ============================================================
CREATE OR REPLACE FUNCTION public.generate_invoices(
  p_billing_frequency TEXT,
  p_period_start DATE,
  p_location_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  invoice_id UUID,
  invoice_number TEXT,
  location_id TEXT,
  location_name TEXT,
  invoice_month DATE,
  subtotal NUMERIC,
  tax_amount NUMERIC,
  total_amount NUMERIC,
  requisition_count INTEGER,
  item_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period_start DATE;
  v_period_end DATE;
  v_period_end_exclusive DATE;
  v_tax_rate NUMERIC := 0.13;
  v_location RECORD;
  v_invoice_id UUID;
  v_base_invoice_number TEXT;
  v_invoice_number TEXT;
  v_existing_number_count INTEGER;
  v_subtotal NUMERIC;
  v_tax_amount NUMERIC;
  v_total NUMERIC;
  v_req_count INTEGER;
  v_item_count INTEGER;
BEGIN
  IF NOT public.is_hq_admin_profile() THEN
    RAISE EXCEPTION 'HQ admin access required';
  END IF;

  IF p_billing_frequency NOT IN ('daily', 'biweekly', 'monthly') THEN
    RAISE EXCEPTION 'Invalid billing frequency: %', p_billing_frequency;
  END IF;

  IF p_billing_frequency = 'monthly' THEN
    v_period_start := date_trunc('month', p_period_start)::date;
    v_period_end_exclusive := (date_trunc('month', p_period_start) + interval '1 month')::date;
  ELSIF p_billing_frequency = 'biweekly' THEN
    IF extract(day from p_period_start) <= 15 THEN
      v_period_start := date_trunc('month', p_period_start)::date;
      v_period_end_exclusive := (date_trunc('month', p_period_start)::date + interval '15 days')::date;
    ELSE
      v_period_start := (date_trunc('month', p_period_start)::date + interval '15 days')::date;
      v_period_end_exclusive := (date_trunc('month', p_period_start) + interval '1 month')::date;
    END IF;
  ELSE
    v_period_start := p_period_start;
    v_period_end_exclusive := (p_period_start + interval '1 day')::date;
  END IF;

  v_period_end := (v_period_end_exclusive - interval '1 day')::date;

  PERFORM pg_advisory_xact_lock(hashtext(
    'hq_invoice_generation:' || p_billing_frequency || ':' || v_period_start::text || ':' || COALESCE(p_location_id, 'ALL')
  ));

  FOR v_location IN
    SELECT DISTINCT c.location_id, c.location_name
    FROM public.get_billable_requisition_candidates(p_billing_frequency, v_period_start, v_period_end, p_location_id) c
    WHERE c.is_eligible
    ORDER BY c.location_name
  LOOP
    -- Lock the exact candidate requisitions before using them.
    PERFORM 1
    FROM public.requisitions r
    JOIN public.get_billable_requisition_candidates(p_billing_frequency, v_period_start, v_period_end, p_location_id) c
      ON c.requisition_id = r.id
    WHERE c.is_eligible
      AND c.location_id = v_location.location_id
    FOR UPDATE OF r;

    -- Re-read after lock so concurrent void/generate changes are respected.
    SELECT
      ROUND(SUM(c.fulfilled_value_total)::numeric, 2),
      COUNT(*)::integer
    INTO v_subtotal, v_req_count
    FROM public.get_billable_requisition_candidates(p_billing_frequency, v_period_start, v_period_end, p_location_id) c
    WHERE c.is_eligible
      AND c.location_id = v_location.location_id;

    IF COALESCE(v_subtotal, 0) <= 0 OR COALESCE(v_req_count, 0) = 0 THEN
      CONTINUE;
    END IF;

    IF p_billing_frequency = 'daily' THEN
      v_base_invoice_number := 'INV-D-' || to_char(v_period_start, 'YYYYMMDD') || '-' || regexp_replace(v_location.location_id, '[^A-Za-z0-9]+', '', 'g');
    ELSIF p_billing_frequency = 'biweekly' THEN
      v_base_invoice_number := 'INV-B-' || to_char(v_period_start, 'YYYYMMDD') || '-' || regexp_replace(v_location.location_id, '[^A-Za-z0-9]+', '', 'g');
    ELSE
      v_base_invoice_number := 'INV-' || to_char(v_period_start, 'YYYYMM') || '-' || regexp_replace(v_location.location_id, '[^A-Za-z0-9]+', '', 'g');
    END IF;

    -- Non-void invoice for the same location/period/frequency already exists: skip.
    IF EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.location_id = v_location.location_id
        AND i.period_start = v_period_start
        AND i.period_end = v_period_end
        AND i.billing_frequency = p_billing_frequency
        AND i.status <> 'void'
    ) THEN
      CONTINUE;
    END IF;

    SELECT COUNT(*) INTO v_existing_number_count
    FROM public.invoices i
    WHERE i.invoice_number = v_base_invoice_number
       OR i.invoice_number LIKE v_base_invoice_number || '-R%';

    v_invoice_number := CASE
      WHEN v_existing_number_count = 0 THEN v_base_invoice_number
      ELSE v_base_invoice_number || '-R' || (v_existing_number_count + 1)::text
    END;

    v_tax_amount := ROUND((v_subtotal * v_tax_rate)::numeric, 2);
    v_total := v_subtotal + v_tax_amount;

    INSERT INTO public.invoices (
      invoice_number,
      location_id,
      location_name_snapshot,
      invoice_month,
      status,
      subtotal,
      tax_rate,
      tax_name,
      tax_amount,
      total_amount,
      generated_at,
      created_by,
      billing_frequency,
      period_start,
      period_end
    )
    VALUES (
      v_invoice_number,
      v_location.location_id,
      v_location.location_name,
      v_period_start,
      'draft',
      v_subtotal,
      v_tax_rate,
      'HST',
      v_tax_amount,
      v_total,
      now(),
      auth.uid(),
      p_billing_frequency,
      v_period_start,
      v_period_end
    )
    RETURNING id INTO v_invoice_id;

    INSERT INTO public.invoice_items (
      invoice_id,
      requisition_id,
      requisition_item_id,
      item_id,
      item_name,
      unit_snapshot,
      pack_qty_snapshot,
      quantity,
      quantity_fulfilled_snapshot,
      unit_price,
      line_total,
      source_type_snapshot
    )
    SELECT
      v_invoice_id,
      r.id,
      ri.id::text,
      COALESCE(ri.finished_good_id::text, ri.item_id::text),
      COALESCE(ri.item_name_snapshot, ri.finished_good_id::text, ri.item_id::text, 'Unknown item'),
      ri.unit_snapshot,
      ri.pack_qty_snapshot,
      COALESCE(ri.quantity_fulfilled, 0),
      COALESCE(ri.quantity_fulfilled, 0),
      CASE
        WHEN ri.unit_price IS NOT NULL THEN ri.unit_price
        WHEN COALESCE(ri.quantity_requested, 0) > 0
          THEN COALESCE(ri.line_total, 0) / NULLIF(ri.quantity_requested, 0)
        ELSE 0
      END,
      ROUND((
        CASE
          WHEN ri.fulfilled_value IS NOT NULL THEN ri.fulfilled_value
          WHEN ri.unit_price IS NOT NULL THEN COALESCE(ri.quantity_fulfilled, 0) * ri.unit_price
          WHEN COALESCE(ri.quantity_requested, 0) > 0
            THEN COALESCE(ri.line_total, 0) * COALESCE(ri.quantity_fulfilled, 0) / NULLIF(ri.quantity_requested, 0)
          ELSE 0
        END
      )::numeric, 2),
      COALESCE(ri.source_type, 'hq_supplied')
    FROM public.requisition_items ri
    JOIN public.requisitions r ON r.id = ri.requisition_id
    JOIN public.get_billable_requisition_candidates(p_billing_frequency, v_period_start, v_period_end, p_location_id) c
      ON c.requisition_id = r.id
    WHERE c.is_eligible
      AND c.location_id = v_location.location_id
      AND COALESCE(ri.quantity_fulfilled, 0) > 0
      AND lower(COALESCE(ri.source_type, 'hq_supplied')) <> 'local_vendor';

    SELECT COUNT(*)::integer, ROUND(COALESCE(SUM(line_total), 0)::numeric, 2)
    INTO v_item_count, v_subtotal
    FROM public.invoice_items
    WHERE invoice_id = v_invoice_id;

    v_tax_amount := ROUND((v_subtotal * v_tax_rate)::numeric, 2);
    v_total := v_subtotal + v_tax_amount;

    UPDATE public.invoices
    SET subtotal = v_subtotal,
        tax_rate = v_tax_rate,
        tax_name = 'HST',
        tax_amount = v_tax_amount,
        total_amount = v_total
    WHERE id = v_invoice_id;

    UPDATE public.requisitions r
    SET invoice_id = v_invoice_id,
        invoiced_at = now()
    FROM public.get_billable_requisition_candidates(p_billing_frequency, v_period_start, v_period_end, p_location_id) c
    WHERE c.requisition_id = r.id
      AND c.is_eligible
      AND c.location_id = v_location.location_id
      AND r.invoice_id IS NULL;

    RETURN QUERY
    SELECT
      v_invoice_id,
      v_invoice_number,
      v_location.location_id,
      v_location.location_name,
      v_period_start,
      v_subtotal,
      v_tax_amount,
      v_total,
      v_req_count,
      v_item_count;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_invoices(TEXT, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_invoices(TEXT, DATE, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.generate_monthly_invoices(
  p_invoice_month DATE,
  p_location_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  invoice_id UUID,
  invoice_number TEXT,
  location_id TEXT,
  location_name TEXT,
  invoice_month DATE,
  subtotal NUMERIC,
  tax_amount NUMERIC,
  total_amount NUMERIC,
  requisition_count INTEGER,
  item_count INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.generate_invoices('monthly', p_invoice_month, p_location_id);
$$;

REVOKE ALL ON FUNCTION public.generate_monthly_invoices(DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_monthly_invoices(DATE, TEXT) TO authenticated;

-- ============================================================
-- Void: clear requisition duplicate guards so voided invoices regenerate
-- ============================================================
CREATE OR REPLACE FUNCTION public.void_invoice(
  p_invoice_id UUID,
  p_void_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice RECORD;
BEGIN
  IF NOT public.is_hq_admin_profile() THEN
    RAISE EXCEPTION 'HQ admin access required';
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % does not exist', p_invoice_id;
  END IF;

  IF v_invoice.status = 'void' THEN
    RAISE EXCEPTION 'Invoice % is already voided', v_invoice.invoice_number;
  END IF;

  UPDATE public.invoices
  SET status = 'void',
      void_reason = p_void_reason,
      voided_at = now(),
      voided_by = auth.uid()
  WHERE id = p_invoice_id;

  UPDATE public.requisitions
  SET invoice_id = NULL,
      invoiced_at = NULL
  WHERE invoice_id = p_invoice_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'invoice_number', v_invoice.invoice_number
  );
END;
$$;

REVOKE ALL ON FUNCTION public.void_invoice(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.void_invoice(UUID, TEXT) TO authenticated;

-- ============================================================
-- HST repair for existing draft invoices
-- ============================================================
UPDATE public.invoices
SET tax_name = 'HST',
    tax_rate = 0.13,
    tax_amount = ROUND((subtotal * 0.13)::numeric, 2),
    total_amount = subtotal + ROUND((subtotal * 0.13)::numeric, 2)
WHERE status = 'draft'
  AND subtotal > 0
  AND COALESCE(tax_amount, 0) = 0;

-- Verification helpers after execution:
-- SELECT invoice_number, subtotal, tax_rate, tax_amount, total_amount
-- FROM public.invoices
-- WHERE status = 'draft' AND subtotal > 0
-- ORDER BY generated_at DESC;
--
-- SELECT * FROM public.get_billable_requisition_candidates('monthly', '2026-06-01', '2026-06-30', 'LOC-HARBOUR');
