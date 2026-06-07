-- Migration: Daily, Biweekly, and Monthly Invoicing Support
-- 1. Add new columns to invoices table
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS billing_frequency TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_frequency IN ('daily', 'biweekly', 'monthly')),
  ADD COLUMN IF NOT EXISTS period_start DATE,
  ADD COLUMN IF NOT EXISTS period_end DATE;

-- 2. Backfill existing invoices
UPDATE public.invoices
SET period_start = invoice_month,
    period_end = (invoice_month + INTERVAL '1 month' - INTERVAL '1 day')::date
WHERE period_start IS NULL;

-- 3. Set NOT NULL constraint on period fields
ALTER TABLE public.invoices
  ALTER COLUMN period_start SET NOT NULL,
  ALTER COLUMN period_end SET NOT NULL;

-- 4. Replace unique constraints
DROP INDEX IF EXISTS invoices_location_month_active_idx;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_location_period_active_idx
  ON public.invoices(location_id, period_start, period_end, billing_frequency)
  WHERE status <> 'void';

-- 5. Define new SQL function for generation
CREATE OR REPLACE FUNCTION public.generate_invoices(
  p_billing_frequency TEXT,
  p_period_start DATE,
  p_location_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  invoice_id UUID,
  invoice_number TEXT,
  location_id TEXT,
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
  v_start DATE;
  v_end DATE;
  v_location TEXT;
  v_invoice_id UUID;
  v_invoice_number TEXT;
  v_subtotal NUMERIC;
  v_req_count INTEGER;
  v_item_count INTEGER;
BEGIN
  IF NOT public.is_hq_admin_profile() THEN
    RAISE EXCEPTION 'HQ admin access required';
  END IF;

  IF p_billing_frequency NOT IN ('daily', 'biweekly', 'monthly') THEN
    RAISE EXCEPTION 'Invalid billing frequency';
  END IF;

  -- Compute start and end bounds based on frequency
  IF p_billing_frequency = 'daily' THEN
    v_start := p_period_start;
    v_end := (p_period_start + INTERVAL '1 day')::date;
  ELSIF p_billing_frequency = 'biweekly' THEN
    v_start := p_period_start;
    v_end := (p_period_start + INTERVAL '14 days')::date;
  ELSE -- monthly
    v_start := date_trunc('month', p_period_start)::date;
    v_end := (date_trunc('month', p_period_start) + INTERVAL '1 month')::date;
  END IF;

  FOR v_location IN
    SELECT DISTINCT r.location_id
    FROM public.requisitions r
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    WHERE r.invoice_id IS NULL
      AND r.location_id IS NOT NULL
      AND r.location_id <> 'LOC-HQ'
      AND (p_location_id IS NULL OR r.location_id = p_location_id)
      AND lower(coalesce(r.status, '')) IN ('fulfilled', 'partial')
      AND r.created_at >= v_start
      AND r.created_at < v_end
      AND coalesce(ri.quantity_fulfilled, 0) > 0
  LOOP
    SELECT
      round(sum(coalesce(ri.quantity_fulfilled, 0) * coalesce(ri.unit_price, 0))::numeric, 2),
      count(DISTINCT r.id)::integer,
      count(ri.id)::integer
    INTO v_subtotal, v_req_count, v_item_count
    FROM public.requisitions r
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    WHERE r.invoice_id IS NULL
      AND r.location_id = v_location
      AND lower(coalesce(r.status, '')) IN ('fulfilled', 'partial')
      AND r.created_at >= v_start
      AND r.created_at < v_end
      AND coalesce(ri.quantity_fulfilled, 0) > 0;

    IF coalesce(v_subtotal, 0) <= 0 OR v_req_count = 0 THEN
      CONTINUE;
    END IF;

    -- Generate descriptive unique invoice number
    IF p_billing_frequency = 'daily' THEN
      v_invoice_number := 'INV-D-' || to_char(v_start, 'YYYYMMDD') || '-' || regexp_replace(v_location, '[^A-Za-z0-9]+', '', 'g');
    ELSIF p_billing_frequency = 'biweekly' THEN
      v_invoice_number := 'INV-B-' || to_char(v_start, 'YYYYMMDD') || '-' || regexp_replace(v_location, '[^A-Za-z0-9]+', '', 'g');
    ELSE
      v_invoice_number := 'INV-' || to_char(v_start, 'YYYYMM') || '-' || regexp_replace(v_location, '[^A-Za-z0-9]+', '', 'g');
    END IF;

    -- Check if active invoice already exists for this number to avoid duplication
    SELECT i.id INTO v_invoice_id
    FROM public.invoices i
    WHERE i.invoice_number = v_invoice_number AND i.status <> 'void'
    LIMIT 1;

    IF v_invoice_id IS NOT NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.invoices (
      invoice_number,
      location_id,
      invoice_month, -- legacy field mapped to start date
      status,
      subtotal,
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
      v_location,
      v_start,
      'draft',
      v_subtotal,
      0,
      v_subtotal,
      now(),
      auth.uid(),
      p_billing_frequency,
      v_start,
      (v_end - INTERVAL '1 day')::date
    )
    RETURNING id INTO v_invoice_id;

    INSERT INTO public.invoice_items (
      invoice_id,
      requisition_id,
      requisition_item_id,
      item_id,
      item_name,
      quantity,
      unit_price,
      line_total
    )
    SELECT
      v_invoice_id,
      r.id,
      ri.id::text,
      coalesce(ri.finished_good_id::text, ri.item_id::text),
      coalesce(ri.item_name_snapshot, ri.finished_good_id::text, ri.item_id::text, 'Unknown item'),
      coalesce(ri.quantity_fulfilled, 0),
      coalesce(ri.unit_price, 0),
      round((coalesce(ri.quantity_fulfilled, 0) * coalesce(ri.unit_price, 0))::numeric, 2)
    FROM public.requisitions r
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    WHERE r.invoice_id IS NULL
      AND r.location_id = v_location
      AND lower(coalesce(r.status, '')) IN ('fulfilled', 'partial')
      AND r.created_at >= v_start
      AND r.created_at < v_end
      AND coalesce(ri.quantity_fulfilled, 0) > 0;

    UPDATE public.requisitions r
    SET invoice_id = v_invoice_id,
        invoiced_at = now()
    WHERE r.invoice_id IS NULL
      AND r.location_id = v_location
      AND lower(coalesce(r.status, '')) IN ('fulfilled', 'partial')
      AND r.created_at >= v_start
      AND r.created_at < v_end
      AND EXISTS (
        SELECT 1
        FROM public.requisition_items ri
        WHERE ri.requisition_id = r.id
          AND coalesce(ri.quantity_fulfilled, 0) > 0
      );

    RETURN QUERY
    SELECT
      v_invoice_id,
      v_invoice_number,
      v_location,
      v_start,
      v_subtotal,
      0::numeric,
      v_subtotal,
      v_req_count,
      v_item_count;
  END LOOP;
END;
$$;

-- 6. Re-create the generate_monthly_invoices wrapper
CREATE OR REPLACE FUNCTION public.generate_monthly_invoices(
  p_invoice_month DATE,
  p_location_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  invoice_id UUID,
  invoice_number TEXT,
  location_id TEXT,
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
BEGIN
  RETURN QUERY
  SELECT * FROM public.generate_invoices('monthly', p_invoice_month, p_location_id);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_invoices(TEXT, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_invoices(TEXT, DATE, TEXT) TO authenticated;
