-- =================================================================================
-- MIGRATION: Requisition Backorder System
-- Description: Sets up requisition_backorders and requisition_backorder_fulfillments
--              tables, RLS policies, and integrates them with invoice generation.
-- Date: 2026-06-07
-- =================================================================================

-- 1. Create requisition_backorders table
CREATE TABLE IF NOT EXISTS public.requisition_backorders (
  id                            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  original_requisition_id       TEXT          NOT NULL REFERENCES public.requisitions(id) ON DELETE CASCADE,
  original_requisition_item_id  UUID          NOT NULL REFERENCES public.requisition_items(id) ON DELETE CASCADE,
  location_id                   TEXT          NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  item_id                       TEXT          NOT NULL, -- finished_good_id or item_id
  item_name                     TEXT          NOT NULL,
  requested_qty                 NUMERIC       NOT NULL DEFAULT 0 CHECK (requested_qty >= 0),
  fulfilled_qty                 NUMERIC       NOT NULL DEFAULT 0 CHECK (fulfilled_qty >= 0),
  backorder_qty                 NUMERIC       NOT NULL DEFAULT 0 CHECK (backorder_qty >= 0),
  remaining_qty                 NUMERIC       NOT NULL DEFAULT 0 CHECK (remaining_qty >= 0),
  unit                          TEXT,
  unit_price                    NUMERIC       NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  source_type                   TEXT          CHECK (source_type IN ('finished_good', 'raw_item')),
  supplier_name                 TEXT,
  status                        TEXT          NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partially_fulfilled', 'fulfilled', 'cancelled')),
  created_at                    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at                    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  fulfilled_at                  TIMESTAMP WITH TIME ZONE,
  notes                         TEXT
);

-- 2. Create requisition_backorder_fulfillments table
CREATE TABLE IF NOT EXISTS public.requisition_backorder_fulfillments (
  id                            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  backorder_id                  UUID          NOT NULL REFERENCES public.requisition_backorders(id) ON DELETE CASCADE,
  quantity_fulfilled            NUMERIC       NOT NULL CHECK (quantity_fulfilled > 0),
  created_at                    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  invoice_id                    UUID          REFERENCES public.invoices(id) ON DELETE SET NULL,
  notes                         TEXT
);

-- 3. Create Indexes
CREATE INDEX IF NOT EXISTS idx_req_backorders_location_id ON public.requisition_backorders(location_id);
CREATE INDEX IF NOT EXISTS idx_req_backorders_status ON public.requisition_backorders(status);
CREATE INDEX IF NOT EXISTS idx_req_backorders_orig_req ON public.requisition_backorders(original_requisition_id);
CREATE INDEX IF NOT EXISTS idx_req_backorders_orig_item ON public.requisition_backorders(original_requisition_item_id);
CREATE INDEX IF NOT EXISTS idx_req_bo_fulfillments_bo_id ON public.requisition_backorder_fulfillments(backorder_id);
CREATE INDEX IF NOT EXISTS idx_req_bo_fulfillments_invoice_id ON public.requisition_backorder_fulfillments(invoice_id);

-- 4. Set up updated_at trigger
DROP TRIGGER IF EXISTS requisition_backorders_set_updated_at ON public.requisition_backorders;
CREATE TRIGGER requisition_backorders_set_updated_at
  BEFORE UPDATE ON public.requisition_backorders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 5. Enable RLS
ALTER TABLE public.requisition_backorders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requisition_backorder_fulfillments ENABLE ROW LEVEL SECURITY;

-- 6. RLS Policies
DROP POLICY IF EXISTS "Backorders: Read by Role" ON public.requisition_backorders;
CREATE POLICY "Backorders: Read by Role"
  ON public.requisition_backorders
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(location_id)
  );

DROP POLICY IF EXISTS "Backorders: Write by HQ Admin" ON public.requisition_backorders;
CREATE POLICY "Backorders: Write by HQ Admin"
  ON public.requisition_backorders
  FOR ALL
  TO authenticated
  USING (
    public.is_hq_admin_profile()
  )
  WITH CHECK (
    public.is_hq_admin_profile()
  );

DROP POLICY IF EXISTS "Fulfillments: Read by Role" ON public.requisition_backorder_fulfillments;
CREATE POLICY "Fulfillments: Read by Role"
  ON public.requisition_backorder_fulfillments
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    EXISTS (
      SELECT 1 FROM public.requisition_backorders b
      WHERE b.id = backorder_id
        AND public.is_location_manager_for(b.location_id)
    )
  );

DROP POLICY IF EXISTS "Fulfillments: Write by HQ Admin" ON public.requisition_backorder_fulfillments;
CREATE POLICY "Fulfillments: Write by HQ Admin"
  ON public.requisition_backorder_fulfillments
  FOR ALL
  TO authenticated
  USING (
    public.is_hq_admin_profile()
  )
  WITH CHECK (
    public.is_hq_admin_profile()
  );


-- 7. Update generate_invoices function to support backorder fulfillments
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
SET search_path = public, auth
AS $$
DECLARE
  v_start DATE;
  v_end DATE;
  v_location TEXT;
  v_invoice_id UUID;
  v_invoice_number TEXT;
  v_req_subtotal NUMERIC;
  v_bo_subtotal NUMERIC;
  v_subtotal NUMERIC;
  v_req_count INTEGER;
  v_item_count INTEGER;
  v_bo_count INTEGER;
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

  -- Loop through locations that have either:
  --   1. Uninvoiced standard requisition items in the period
  --   2. Uninvoiced backorder fulfillments in the period
  FOR v_location IN
    SELECT DISTINCT loc.location_id
    FROM (
      SELECT r.location_id
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

      UNION

      SELECT bo.location_id
      FROM public.requisition_backorder_fulfillments bf
      JOIN public.requisition_backorders bo ON bf.backorder_id = bo.id
      WHERE bf.invoice_id IS NULL
        AND bo.location_id IS NOT NULL
        AND bo.location_id <> 'LOC-HQ'
        AND (p_location_id IS NULL OR bo.location_id = p_location_id)
        AND bf.created_at >= v_start
        AND bf.created_at < v_end
        AND bf.quantity_fulfilled > 0
    ) loc
  LOOP

    -- Calculate standard requisition items subtotal
    SELECT
      coalesce(round(sum(coalesce(ri.quantity_fulfilled, 0) * coalesce(ri.unit_price, 0))::numeric, 2), 0),
      coalesce(count(DISTINCT r.id)::integer, 0),
      coalesce(count(ri.id)::integer, 0)
    INTO v_req_subtotal, v_req_count, v_item_count
    FROM public.requisitions r
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    WHERE r.invoice_id IS NULL
      AND r.location_id = v_location
      AND lower(coalesce(r.status, '')) IN ('fulfilled', 'partial')
      AND r.created_at >= v_start
      AND r.created_at < v_end
      AND coalesce(ri.quantity_fulfilled, 0) > 0;

    -- Calculate backorder fulfillments subtotal
    SELECT
      coalesce(round(sum(coalesce(bf.quantity_fulfilled, 0) * coalesce(bo.unit_price, 0))::numeric, 2), 0),
      coalesce(count(DISTINCT bo.id)::integer, 0)
    INTO v_bo_subtotal, v_bo_count
    FROM public.requisition_backorder_fulfillments bf
    JOIN public.requisition_backorders bo ON bf.backorder_id = bo.id
    WHERE bf.invoice_id IS NULL
      AND bo.location_id = v_location
      AND bf.created_at >= v_start
      AND bf.created_at < v_end
      AND bf.quantity_fulfilled > 0;

    v_subtotal := v_req_subtotal + v_bo_subtotal;

    IF coalesce(v_subtotal, 0) <= 0 THEN
      CONTINUE;
    END IF;

    -- Update total item count
    v_item_count := v_item_count + v_bo_count;

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

    -- Insert Invoice Header
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

    -- Insert standard requisition items
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

    -- Insert backorder fulfillments
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
      bo.original_requisition_id,
      bf.id::text,
      bo.item_id,
      coalesce(bo.item_name, 'Unknown item') || ' (Backorder)',
      bf.quantity_fulfilled,
      coalesce(bo.unit_price, 0),
      round((bf.quantity_fulfilled * coalesce(bo.unit_price, 0))::numeric, 2)
    FROM public.requisition_backorder_fulfillments bf
    JOIN public.requisition_backorders bo ON bf.backorder_id = bo.id
    WHERE bf.invoice_id IS NULL
      AND bo.location_id = v_location
      AND bf.created_at >= v_start
      AND bf.created_at < v_end
      AND bf.quantity_fulfilled > 0;

    -- Mark standard requisitions as invoiced
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

    -- Mark backorder fulfillments as invoiced
    UPDATE public.requisition_backorder_fulfillments bf
    SET invoice_id = v_invoice_id
    FROM public.requisition_backorders bo
    WHERE bf.backorder_id = bo.id
      AND bf.invoice_id IS NULL
      AND bo.location_id = v_location
      AND bf.created_at >= v_start
      AND bf.created_at < v_end
      AND bf.quantity_fulfilled > 0;

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

GRANT EXECUTE ON FUNCTION public.generate_invoices(TEXT, DATE, TEXT) TO authenticated;
