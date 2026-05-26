-- Monthly HQ location invoices
-- Creates one draft invoice per location/month from fulfilled quantities only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT UNIQUE NOT NULL,
  location_id TEXT NOT NULL,
  invoice_month DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','finalized','sent','paid','void')),
  subtotal NUMERIC NOT NULL DEFAULT 0,
  tax_amount NUMERIC NOT NULL DEFAULT 0,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  requisition_id TEXT,
  requisition_item_id TEXT,
  item_id TEXT,
  item_name TEXT NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit_price NUMERIC NOT NULL DEFAULT 0,
  line_total NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES public.invoices(id),
  ADD COLUMN IF NOT EXISTS invoiced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_location_month_active_idx
  ON public.invoices(location_id, invoice_month)
  WHERE status <> 'void';

CREATE INDEX IF NOT EXISTS invoice_items_invoice_id_idx
  ON public.invoice_items(invoice_id);

CREATE INDEX IF NOT EXISTS requisitions_invoice_id_idx
  ON public.requisitions(invoice_id);

CREATE OR REPLACE FUNCTION public.set_invoice_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_set_updated_at ON public.invoices;
CREATE TRIGGER invoices_set_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.set_invoice_updated_at();

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Invoices: HQ Admin Read" ON public.invoices;
DROP POLICY IF EXISTS "Invoices: HQ Admin Insert" ON public.invoices;
DROP POLICY IF EXISTS "Invoices: HQ Admin Update" ON public.invoices;
DROP POLICY IF EXISTS "Invoices: HQ Admin Delete" ON public.invoices;

CREATE POLICY "Invoices: HQ Admin Read"
  ON public.invoices
  FOR SELECT
  USING (public.is_hq_admin_profile());

CREATE POLICY "Invoices: HQ Admin Insert"
  ON public.invoices
  FOR INSERT
  WITH CHECK (public.is_hq_admin_profile());

CREATE POLICY "Invoices: HQ Admin Update"
  ON public.invoices
  FOR UPDATE
  USING (public.is_hq_admin_profile())
  WITH CHECK (public.is_hq_admin_profile());

CREATE POLICY "Invoices: HQ Admin Delete"
  ON public.invoices
  FOR DELETE
  USING (public.is_hq_admin_profile());

DROP POLICY IF EXISTS "Invoice Items: HQ Admin Read" ON public.invoice_items;
DROP POLICY IF EXISTS "Invoice Items: HQ Admin Insert" ON public.invoice_items;
DROP POLICY IF EXISTS "Invoice Items: HQ Admin Update" ON public.invoice_items;
DROP POLICY IF EXISTS "Invoice Items: HQ Admin Delete" ON public.invoice_items;

CREATE POLICY "Invoice Items: HQ Admin Read"
  ON public.invoice_items
  FOR SELECT
  USING (public.is_hq_admin_profile());

CREATE POLICY "Invoice Items: HQ Admin Insert"
  ON public.invoice_items
  FOR INSERT
  WITH CHECK (public.is_hq_admin_profile());

CREATE POLICY "Invoice Items: HQ Admin Update"
  ON public.invoice_items
  FOR UPDATE
  USING (public.is_hq_admin_profile())
  WITH CHECK (public.is_hq_admin_profile());

CREATE POLICY "Invoice Items: HQ Admin Delete"
  ON public.invoice_items
  FOR DELETE
  USING (public.is_hq_admin_profile());

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
DECLARE
  v_month_start DATE := date_trunc('month', p_invoice_month)::date;
  v_month_end DATE := (date_trunc('month', p_invoice_month)::date + INTERVAL '1 month')::date;
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

  FOR v_location IN
    SELECT DISTINCT r.location_id
    FROM public.requisitions r
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    WHERE r.invoice_id IS NULL
      AND r.location_id IS NOT NULL
      AND r.location_id <> 'LOC-HQ'
      AND (p_location_id IS NULL OR r.location_id = p_location_id)
      AND lower(coalesce(r.status, '')) IN ('fulfilled', 'partial')
      AND r.created_at >= v_month_start
      AND r.created_at < v_month_end
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
      AND r.created_at >= v_month_start
      AND r.created_at < v_month_end
      AND coalesce(ri.quantity_fulfilled, 0) > 0;

    IF coalesce(v_subtotal, 0) <= 0 OR v_req_count = 0 THEN
      CONTINUE;
    END IF;

    v_invoice_number :=
      'INV-' ||
      to_char(v_month_start, 'YYYYMM') ||
      '-' ||
      regexp_replace(v_location, '[^A-Za-z0-9]+', '', 'g');

    INSERT INTO public.invoices (
      invoice_number,
      location_id,
      invoice_month,
      status,
      subtotal,
      tax_amount,
      total_amount,
      generated_at,
      created_by
    )
    VALUES (
      v_invoice_number,
      v_location,
      v_month_start,
      'draft',
      v_subtotal,
      0,
      v_subtotal,
      now(),
      auth.uid()
    )
    ON CONFLICT ON CONSTRAINT invoices_invoice_number_key DO NOTHING
    RETURNING id INTO v_invoice_id;

    IF v_invoice_id IS NULL THEN
      SELECT i.id
      INTO v_invoice_id
      FROM public.invoices i
      WHERE i.invoice_number = v_invoice_number
        AND i.status <> 'void'
      LIMIT 1;

      IF v_invoice_id IS NOT NULL THEN
        CONTINUE;
      END IF;
    END IF;

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
      AND r.created_at >= v_month_start
      AND r.created_at < v_month_end
      AND coalesce(ri.quantity_fulfilled, 0) > 0;

    UPDATE public.requisitions r
    SET invoice_id = v_invoice_id,
        invoiced_at = now()
    WHERE r.invoice_id IS NULL
      AND r.location_id = v_location
      AND lower(coalesce(r.status, '')) IN ('fulfilled', 'partial')
      AND r.created_at >= v_month_start
      AND r.created_at < v_month_end
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
      v_month_start,
      v_subtotal,
      0::numeric,
      v_subtotal,
      v_req_count,
      v_item_count;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_monthly_invoices(DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_monthly_invoices(DATE, TEXT) TO authenticated;
