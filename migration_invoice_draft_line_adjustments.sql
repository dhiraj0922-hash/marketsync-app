-- ============================================================
-- STOCK DHARMA — Draft Invoice Line Review + Adjustment Workflow
--
-- Accounting-safe rule:
--   * Requisitions / fulfillment / inventory remain operational truth.
--   * Draft invoice lines may be adjusted before finalization only.
--   * Every invoice-line adjustment is logged with reason and user.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS adjusted_quantity NUMERIC,
  ADD COLUMN IF NOT EXISTS adjusted_unit_price NUMERIC,
  ADD COLUMN IF NOT EXISTS adjustment_reason TEXT,
  ADD COLUMN IF NOT EXISTS adjusted_by UUID,
  ADD COLUMN IF NOT EXISTS adjusted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS original_quantity_snapshot NUMERIC,
  ADD COLUMN IF NOT EXISTS original_unit_price_snapshot NUMERIC,
  ADD COLUMN IF NOT EXISTS original_line_total_snapshot NUMERIC,
  ADD COLUMN IF NOT EXISTS is_adjusted BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.invoice_adjustment_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  invoice_item_id UUID NOT NULL REFERENCES public.invoice_items(id) ON DELETE CASCADE,
  requisition_id TEXT,
  requisition_item_id TEXT,
  field_changed TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  changed_by UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_adjustment_logs_invoice_id
  ON public.invoice_adjustment_logs(invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoice_adjustment_logs_invoice_item_id
  ON public.invoice_adjustment_logs(invoice_item_id);

ALTER TABLE public.invoice_adjustment_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Invoice Adjustment Logs: HQ Read" ON public.invoice_adjustment_logs;
CREATE POLICY "Invoice Adjustment Logs: HQ Read"
  ON public.invoice_adjustment_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.is_active = true
        AND up.role IN ('hq_admin', 'hq_master', 'hq_ops')
    )
  );

DROP POLICY IF EXISTS "Invoice Adjustment Logs: HQ Insert" ON public.invoice_adjustment_logs;
CREATE POLICY "Invoice Adjustment Logs: HQ Insert"
  ON public.invoice_adjustment_logs
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.is_active = true
        AND up.role IN ('hq_admin', 'hq_master', 'hq_ops')
    )
  );

DROP FUNCTION IF EXISTS public.update_draft_invoice_item(UUID, NUMERIC, NUMERIC, TEXT);

CREATE OR REPLACE FUNCTION public.update_draft_invoice_item(
  p_invoice_item_id UUID,
  p_new_quantity NUMERIC,
  p_new_unit_price NUMERIC,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_item RECORD;
  v_invoice RECORD;
  v_new_line_total NUMERIC;
  v_subtotal NUMERIC;
  v_tax_rate NUMERIC := 0.13;
  v_tax_amount NUMERIC;
  v_total NUMERIC;
BEGIN
  SELECT role INTO v_role
  FROM public.user_profiles
  WHERE user_id = auth.uid()
    AND is_active = true
  LIMIT 1;

  IF v_role NOT IN ('hq_admin', 'hq_master', 'hq_ops') THEN
    RAISE EXCEPTION 'Permission denied: only HQ invoice roles may adjust draft invoice lines';
  END IF;

  IF p_new_quantity IS NULL OR p_new_quantity < 0 THEN
    RAISE EXCEPTION 'Invoice quantity must be numeric and greater than or equal to 0';
  END IF;

  IF p_new_unit_price IS NULL OR p_new_unit_price < 0 THEN
    RAISE EXCEPTION 'Unit price must be numeric and greater than or equal to 0';
  END IF;

  IF length(trim(COALESCE(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'Adjustment reason is required';
  END IF;

  SELECT ii.*, i.status AS invoice_status, i.tax_rate AS invoice_tax_rate
  INTO v_item
  FROM public.invoice_items ii
  JOIN public.invoices i ON i.id = ii.invoice_id
  WHERE ii.id = p_invoice_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice item % does not exist', p_invoice_item_id;
  END IF;

  IF v_item.invoice_status <> 'draft' THEN
    RAISE EXCEPTION 'Invoice line edits are allowed only while invoice is draft';
  END IF;

  IF p_new_quantity > COALESCE(v_item.quantity_fulfilled_snapshot, v_item.quantity, 0)
     AND v_role NOT IN ('hq_admin', 'hq_master') THEN
    RAISE EXCEPTION 'Adjusted invoice quantity exceeds fulfilled quantity. hq_admin or hq_master approval is required.';
  END IF;

  v_new_line_total := ROUND((p_new_quantity * p_new_unit_price)::numeric, 2);

  IF v_new_line_total < 0 THEN
    RAISE EXCEPTION 'Final line total cannot be negative';
  END IF;

  IF v_item.original_quantity_snapshot IS NULL THEN
    UPDATE public.invoice_items
    SET original_quantity_snapshot = quantity,
        original_unit_price_snapshot = unit_price,
        original_line_total_snapshot = line_total
    WHERE id = p_invoice_item_id;
  END IF;

  IF COALESCE(v_item.quantity, 0) <> p_new_quantity THEN
    INSERT INTO public.invoice_adjustment_logs (
      invoice_id, invoice_item_id, requisition_id, requisition_item_id,
      field_changed, old_value, new_value, reason, changed_by
    )
    VALUES (
      v_item.invoice_id, v_item.id, v_item.requisition_id, v_item.requisition_item_id,
      'quantity', v_item.quantity::text, p_new_quantity::text, trim(p_reason), auth.uid()
    );
  END IF;

  IF COALESCE(v_item.unit_price, 0) <> p_new_unit_price THEN
    INSERT INTO public.invoice_adjustment_logs (
      invoice_id, invoice_item_id, requisition_id, requisition_item_id,
      field_changed, old_value, new_value, reason, changed_by
    )
    VALUES (
      v_item.invoice_id, v_item.id, v_item.requisition_id, v_item.requisition_item_id,
      'unit_price', v_item.unit_price::text, p_new_unit_price::text, trim(p_reason), auth.uid()
    );
  END IF;

  IF COALESCE(v_item.line_total, 0) <> v_new_line_total THEN
    INSERT INTO public.invoice_adjustment_logs (
      invoice_id, invoice_item_id, requisition_id, requisition_item_id,
      field_changed, old_value, new_value, reason, changed_by
    )
    VALUES (
      v_item.invoice_id, v_item.id, v_item.requisition_id, v_item.requisition_item_id,
      'line_total', v_item.line_total::text, v_new_line_total::text, trim(p_reason), auth.uid()
    );
  END IF;

  UPDATE public.invoice_items
  SET quantity = p_new_quantity,
      unit_price = p_new_unit_price,
      line_total = v_new_line_total,
      adjusted_quantity = p_new_quantity,
      adjusted_unit_price = p_new_unit_price,
      adjustment_reason = trim(p_reason),
      adjusted_by = auth.uid(),
      adjusted_at = now(),
      is_adjusted = true
  WHERE id = p_invoice_item_id;

  SELECT COALESCE(i.tax_rate, 0.13) INTO v_tax_rate
  FROM public.invoices i
  WHERE i.id = v_item.invoice_id
  FOR UPDATE;

  SELECT ROUND(COALESCE(SUM(line_total), 0)::numeric, 2)
  INTO v_subtotal
  FROM public.invoice_items
  WHERE invoice_id = v_item.invoice_id;

  v_tax_amount := ROUND((v_subtotal * v_tax_rate)::numeric, 2);
  v_total := v_subtotal + v_tax_amount;

  UPDATE public.invoices
  SET subtotal = v_subtotal,
      tax_name = 'HST',
      tax_rate = v_tax_rate,
      tax_amount = v_tax_amount,
      total_amount = v_total,
      updated_at = now()
  WHERE id = v_item.invoice_id
  RETURNING * INTO v_invoice;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', v_item.invoice_id,
    'invoice_item_id', p_invoice_item_id,
    'subtotal', v_subtotal,
    'tax_rate', v_tax_rate,
    'tax_amount', v_tax_amount,
    'total_amount', v_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_draft_invoice_item(UUID, NUMERIC, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_draft_invoice_item(UUID, NUMERIC, NUMERIC, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_draft_invoice_item(UUID, NUMERIC, NUMERIC, TEXT) TO authenticated;
