-- migration_requisition_manual_hq_supply_override.sql
-- Controlled Manual HQ Supply Override for local_vendor / unmapped requisition lines.
--
-- Purpose:
--   Allow authorized HQ users to mark a specific blocked requisition line as
--   physically supplied by HQ for this order only, without inventory deduction,
--   inventory movements, or permanent catalog mapping.
--
-- Do not run until approved.

CREATE TABLE IF NOT EXISTS public.requisition_fulfillment_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id text NOT NULL REFERENCES public.requisitions(id) ON DELETE CASCADE,
  requisition_item_id uuid NOT NULL REFERENCES public.requisition_items(id) ON DELETE CASCADE,
  item_name_snapshot text,
  original_source_type text,
  fulfilled_qty numeric NOT NULL,
  fulfilled_value numeric,
  unit_price_snapshot numeric,
  override_reason text NOT NULL,
  override_note text,
  overridden_by uuid NOT NULL,
  overridden_by_name text,
  overridden_by_role text,
  overridden_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  CONSTRAINT requisition_fulfillment_overrides_one_per_line UNIQUE (requisition_item_id),
  CONSTRAINT requisition_fulfillment_overrides_reason_check CHECK (
    override_reason IN (
      'HQ physically supplied today',
      'Temporary emergency supply',
      'Catalog setup pending',
      'Other'
    )
  ),
  CONSTRAINT requisition_fulfillment_overrides_other_note_check CHECK (
    override_reason <> 'Other' OR length(trim(COALESCE(override_note, ''))) > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_requisition_fulfillment_overrides_req
  ON public.requisition_fulfillment_overrides (requisition_id);

CREATE INDEX IF NOT EXISTS idx_requisition_fulfillment_overrides_item
  ON public.requisition_fulfillment_overrides (requisition_item_id);

CREATE INDEX IF NOT EXISTS idx_requisition_fulfillment_overrides_at
  ON public.requisition_fulfillment_overrides (overridden_at);

ALTER TABLE public.requisition_fulfillment_overrides ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.requisition_fulfillment_overrides FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.requisition_fulfillment_overrides FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.requisition_fulfillment_overrides FROM authenticated;
GRANT SELECT ON public.requisition_fulfillment_overrides TO authenticated;

DROP POLICY IF EXISTS "Requisition fulfillment overrides: authorized read" ON public.requisition_fulfillment_overrides;
CREATE POLICY "Requisition fulfillment overrides: authorized read"
  ON public.requisition_fulfillment_overrides
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.is_active = true
        AND (
          up.role IN ('hq_admin', 'hq_master', 'hq_ops', 'hq_fulfillment')
          OR (
            up.role = 'location_manager'
            AND EXISTS (
              SELECT 1
              FROM public.requisitions r
              WHERE r.id = requisition_fulfillment_overrides.requisition_id
                AND r.location_id = up.location_id
            )
          )
        )
    )
  );

CREATE OR REPLACE FUNCTION public.finalize_requisition_fulfillment_v3(
  p_requisition_id text,
  p_fulfilled_lines jsonb,
  p_user_id uuid,
  p_user_name text,
  p_idempotency_key text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_line RECORD;
  v_line_id uuid;
  v_proposed_fulfilled numeric;
  v_available numeric;
  v_manual_override boolean;
  v_override_reason text;
  v_override_note text;
  v_item_id text;
  v_finished_good_id text;
  v_source_type text;
  v_item_name_snapshot text;
  v_quantity_requested numeric;
  v_previous_fulfilled numeric;
  v_delta numeric;
  v_pack_qty numeric;
  v_base_delta numeric;
  v_shared_item_id text;
  v_hq_stock numeric;
  v_dest_location_id text;
  v_unit_cost numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_user_role text;
  v_existing_key text;
  v_existing_override_key text;

  v_all_supplied boolean := true;
  v_any_supplied boolean := false;
  v_any_backorder boolean := false;

  v_status text;
  v_now timestamptz := now();
  v_movement_ref text;
  v_result jsonb;
BEGIN
  SELECT role INTO v_user_role
  FROM public.user_profiles
  WHERE user_id = p_user_id
    AND is_active = true
  LIMIT 1;

  IF v_user_role NOT IN ('hq_admin', 'hq_master', 'hq_ops', 'hq_fulfillment') THEN
    RAISE EXCEPTION
      'Permission denied: User % does not have an authorized HQ role (got: %).',
      p_user_id, COALESCE(v_user_role, '(no active profile found)');
  END IF;

  SELECT status, location_id, idempotency_key INTO v_status, v_dest_location_id, v_existing_key
  FROM public.requisitions
  WHERE id = p_requisition_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Requisition % not found.', p_requisition_id;
  END IF;

  IF v_status = 'fulfilled' THEN
    IF v_existing_key = p_idempotency_key THEN
      SELECT total_amount INTO v_line_total FROM public.requisitions WHERE id = p_requisition_id;
      RETURN jsonb_build_object(
        'success', true,
        'new_status', v_status,
        'total_amount', v_line_total,
        'already_processed', true
      );
    ELSE
      RAISE EXCEPTION 'Requisition % is fully fulfilled and cannot be re-opened.', p_requisition_id;
    END IF;
  END IF;

  IF v_status IN ('partially_fulfilled', 'backordered') THEN
    IF v_existing_key = p_idempotency_key THEN
      SELECT total_amount INTO v_line_total FROM public.requisitions WHERE id = p_requisition_id;
      RETURN jsonb_build_object(
        'success', true,
        'new_status', v_status,
        'total_amount', v_line_total,
        'already_processed', true
      );
    END IF;
  END IF;

  FOR v_line IN
    SELECT *
    FROM jsonb_to_recordset(p_fulfilled_lines) AS x(
      line_id uuid,
      fulfilled_qty numeric,
      available_qty numeric,
      manual_hq_supply_override boolean,
      override_reason text,
      override_note text
    )
  LOOP
    v_line_id := v_line.line_id;
    v_proposed_fulfilled := v_line.fulfilled_qty;
    v_available := COALESCE(v_line.available_qty, 0);
    v_manual_override := COALESCE(v_line.manual_hq_supply_override, false);
    v_override_reason := NULLIF(trim(COALESCE(v_line.override_reason, '')), '');
    v_override_note := NULLIF(trim(COALESCE(v_line.override_note, '')), '');
    v_movement_ref := null;

    SELECT item_id, finished_good_id, source_type, item_name_snapshot,
           quantity_requested, quantity_fulfilled, pack_qty_snapshot, unit_price
    INTO v_item_id, v_finished_good_id, v_source_type, v_item_name_snapshot,
         v_quantity_requested, v_previous_fulfilled, v_pack_qty, v_unit_price
    FROM public.requisition_items
    WHERE id = v_line_id
      AND requisition_id = p_requisition_id;

    IF v_quantity_requested IS NULL THEN
      RAISE EXCEPTION 'Requisition item % not found for requisition %.', v_line_id, p_requisition_id;
    END IF;

    v_previous_fulfilled := COALESCE(v_previous_fulfilled, 0);
    v_delta := v_proposed_fulfilled - v_previous_fulfilled;
    v_pack_qty := COALESCE(v_pack_qty, 1);

    IF v_proposed_fulfilled < v_previous_fulfilled THEN
      RAISE EXCEPTION
        'Cannot reduce fulfilled quantity below already-committed value for item %. Committed: %, Proposed: %.',
        v_line_id, v_previous_fulfilled, v_proposed_fulfilled;
    END IF;

    IF v_proposed_fulfilled > v_quantity_requested THEN
      RAISE EXCEPTION 'Fulfilled quantity % exceeds requested quantity %', v_proposed_fulfilled, v_quantity_requested;
    END IF;

    IF lower(COALESCE(v_source_type, '')) = 'local_vendor'
       OR (v_item_id IS NULL AND v_finished_good_id IS NULL) THEN
      IF NOT v_manual_override THEN
        RAISE EXCEPTION
          'Manual HQ supply override is required for local vendor or unmapped requisition item %.',
          v_line_id;
      END IF;

      IF v_user_role NOT IN ('hq_admin', 'hq_master', 'hq_ops', 'hq_fulfillment') THEN
        RAISE EXCEPTION 'Permission denied: role % cannot create manual HQ supply overrides.', COALESCE(v_user_role, '(none)');
      END IF;

      IF v_override_reason NOT IN (
        'HQ physically supplied today',
        'Temporary emergency supply',
        'Catalog setup pending',
        'Other'
      ) THEN
        RAISE EXCEPTION 'Invalid manual HQ supply override reason for item %.', v_line_id;
      END IF;

      IF v_override_reason = 'Other' AND v_override_note IS NULL THEN
        RAISE EXCEPTION 'Override note is required when reason is Other for item %.', v_line_id;
      END IF;

      SELECT idempotency_key INTO v_existing_override_key
      FROM public.requisition_fulfillment_overrides
      WHERE requisition_item_id = v_line_id
      FOR UPDATE;

      IF v_existing_override_key IS NOT NULL AND v_existing_override_key IS DISTINCT FROM p_idempotency_key THEN
        RAISE EXCEPTION 'Manual HQ supply override already exists for requisition item %.', v_line_id;
      END IF;

      v_line_total := v_proposed_fulfilled * COALESCE(v_unit_price, 0);

      UPDATE public.requisition_items
      SET
        quantity_fulfilled            = v_proposed_fulfilled,
        allocated_qty                 = v_proposed_fulfilled,
        backorder_qty                 = v_quantity_requested - v_proposed_fulfilled,
        line_total                    = v_line_total,
        fulfilled_by                  = p_user_id,
        fulfilled_at                  = v_now,
        available_qty_at_finalization = v_available,
        fulfilled_value               = v_line_total,
        stock_movement_reference      = 'MANUAL-HQ-SUPPLY-OVERRIDE',
        fulfillment_note              = trim(concat_ws(
          ' ',
          NULLIF(fulfillment_note, ''),
          '[MANUAL HQ SUPPLY OVERRIDE:',
          v_override_reason,
          CASE WHEN v_override_note IS NOT NULL THEN '- ' || v_override_note ELSE '' END,
          ']'
        )),
        updated_at                    = v_now
      WHERE id = v_line_id;

      INSERT INTO public.requisition_fulfillment_overrides (
        requisition_id,
        requisition_item_id,
        item_name_snapshot,
        original_source_type,
        fulfilled_qty,
        fulfilled_value,
        unit_price_snapshot,
        override_reason,
        override_note,
        overridden_by,
        overridden_by_name,
        overridden_by_role,
        idempotency_key
      )
      VALUES (
        p_requisition_id,
        v_line_id,
        v_item_name_snapshot,
        v_source_type,
        v_proposed_fulfilled,
        v_line_total,
        v_unit_price,
        v_override_reason,
        v_override_note,
        p_user_id,
        p_user_name,
        v_user_role,
        p_idempotency_key
      )
      ON CONFLICT (requisition_item_id) DO NOTHING;

      CONTINUE;
    END IF;

    IF v_delta != 0 THEN
      IF v_finished_good_id IS NOT NULL THEN
        v_base_delta := v_delta * v_pack_qty;
        SELECT COALESCE(instock, 0), COALESCE(making_cost, 0) INTO v_hq_stock, v_unit_cost
        FROM public.hq_sale_items WHERE id = v_finished_good_id;

        IF v_base_delta > 0 AND v_base_delta > v_hq_stock THEN
          RAISE EXCEPTION 'Cannot fulfill quantity % packs (% base units) - only % base units available in HQ stock.', v_delta, v_base_delta, v_hq_stock;
        END IF;

        UPDATE public.hq_sale_items SET instock = instock - v_base_delta, updated_at = v_now WHERE id = v_finished_good_id;

        v_movement_ref := 'REQ-MOV-' || p_requisition_id || '-' || v_line_id;
        IF v_base_delta > 0 THEN
          INSERT INTO public.inventory_movements (location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at)
          VALUES ('LOC-HQ', v_finished_good_id, 'transfer_out', v_base_delta, v_unit_cost, v_base_delta * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment (FG) -> ' || v_dest_location_id, v_now);
        ELSE
          INSERT INTO public.inventory_movements (location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at)
          VALUES ('LOC-HQ', v_finished_good_id, 'transfer_in', abs(v_base_delta), v_unit_cost, abs(v_base_delta) * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment reduction (FG) from ' || v_dest_location_id, v_now);
        END IF;

      ELSE
        SELECT item_id INTO v_shared_item_id FROM public.inventory_items WHERE id = v_item_id;
        IF v_shared_item_id IS NULL THEN
          RAISE EXCEPTION 'Shared item_id not resolved for inventory item %', v_item_id;
        END IF;

        SELECT COALESCE(instock, 0), COALESCE(cost, 0) INTO v_hq_stock, v_unit_cost
        FROM public.inventory_items WHERE item_id = v_shared_item_id AND location_id = 'LOC-HQ';

        IF v_hq_stock IS NULL THEN
          RAISE EXCEPTION 'HQ inventory row missing for shared item_id %', v_shared_item_id;
        END IF;

        IF v_delta > 0 AND v_delta > v_hq_stock THEN
          RAISE EXCEPTION 'Cannot fulfill quantity % - only % available in HQ stock.', v_delta, v_hq_stock;
        END IF;

        UPDATE public.inventory_items SET instock = instock - v_delta, updated_at = v_now
        WHERE item_id = v_shared_item_id AND location_id = 'LOC-HQ';

        IF EXISTS (SELECT 1 FROM public.inventory_items WHERE item_id = v_shared_item_id AND location_id = v_dest_location_id) THEN
          UPDATE public.inventory_items SET instock = instock + v_delta, updated_at = v_now
          WHERE item_id = v_shared_item_id AND location_id = v_dest_location_id;
        ELSE
          INSERT INTO public.inventory_items (id, location_id, item_id, name, instock, created_at, updated_at)
          VALUES (gen_random_uuid()::text, v_dest_location_id, v_shared_item_id, 'Item ' || v_shared_item_id, v_delta, v_now, v_now);
        END IF;

        v_movement_ref := 'REQ-MOV-' || p_requisition_id || '-' || v_line_id;
        IF v_delta > 0 THEN
          INSERT INTO public.inventory_movements (location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at)
          VALUES ('LOC-HQ', v_shared_item_id, 'transfer_out', v_delta, v_unit_cost, v_delta * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment -> ' || v_dest_location_id, v_now);
          INSERT INTO public.inventory_movements (location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at)
          VALUES (v_dest_location_id, v_shared_item_id, 'transfer_in', v_delta, v_unit_cost, v_delta * v_unit_cost, 'requisition', p_requisition_id, 'Received from HQ', v_now);
        ELSE
          INSERT INTO public.inventory_movements (location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at)
          VALUES ('LOC-HQ', v_shared_item_id, 'transfer_in', abs(v_delta), v_unit_cost, abs(v_delta) * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment reduction from ' || v_dest_location_id, v_now);
          INSERT INTO public.inventory_movements (location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at)
          VALUES (v_dest_location_id, v_shared_item_id, 'transfer_out', abs(v_delta), v_unit_cost, abs(v_delta) * v_unit_cost, 'requisition', p_requisition_id, 'Fulfillment reduction returned to HQ', v_now);
        END IF;
      END IF;
    END IF;

    v_line_total := v_proposed_fulfilled * v_unit_price;
    UPDATE public.requisition_items
    SET
      quantity_fulfilled            = v_proposed_fulfilled,
      allocated_qty                 = v_proposed_fulfilled,
      backorder_qty                 = v_quantity_requested - v_proposed_fulfilled,
      line_total                    = v_line_total,
      fulfilled_by                  = p_user_id,
      fulfilled_at                  = v_now,
      available_qty_at_finalization = v_available,
      fulfilled_value               = v_line_total,
      stock_movement_reference      = COALESCE(v_movement_ref, stock_movement_reference),
      updated_at                    = v_now
    WHERE id = v_line_id;
  END LOOP;

  SELECT
    COALESCE(bool_and(quantity_fulfilled = quantity_requested), true),
    COALESCE(bool_or(quantity_fulfilled > 0), false),
    COALESCE(bool_or(backorder_qty > 0), false)
  INTO v_all_supplied, v_any_supplied, v_any_backorder
  FROM public.requisition_items
  WHERE requisition_id = p_requisition_id;

  IF v_all_supplied THEN
    v_status := 'fulfilled';
  ELSIF v_any_supplied AND v_any_backorder THEN
    v_status := 'partially_fulfilled';
  ELSE
    v_status := 'backordered';
  END IF;

  SELECT COALESCE(SUM(quantity_fulfilled * unit_price), 0) INTO v_line_total
  FROM public.requisition_items
  WHERE requisition_id = p_requisition_id;

  UPDATE public.requisitions
  SET status = v_status, total_amount = v_line_total, idempotency_key = p_idempotency_key, updated_at = v_now
  WHERE id = p_requisition_id;

  SELECT jsonb_build_object('success', true, 'new_status', v_status, 'total_amount', v_line_total)
  INTO v_result;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_requisition_fulfillment_v3(TEXT, JSONB, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_requisition_fulfillment_v3(TEXT, JSONB, UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.finalize_requisition_fulfillment_v3(TEXT, JSONB, UUID, TEXT, TEXT) TO authenticated;

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
  existing_invoice_cycle TEXT,
  existing_invoice_period_start DATE,
  existing_invoice_period_end DATE,
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
          AND rfo.id IS NULL
      ) AS local_vendor_fulfilled_line_count,
      COUNT(*) FILTER (
        WHERE COALESCE(ri.quantity_fulfilled, 0) > 0
          AND (
            lower(COALESCE(ri.source_type, 'hq_supplied')) <> 'local_vendor'
            OR rfo.id IS NOT NULL
          )
      ) AS hq_fulfilled_line_count,
      string_agg(DISTINCT COALESCE(ri.source_type, 'hq_supplied'), ', ' ORDER BY COALESCE(ri.source_type, 'hq_supplied')) AS source_types,
      COALESCE(SUM(COALESCE(ri.quantity_fulfilled, 0)) FILTER (
        WHERE lower(COALESCE(ri.source_type, 'hq_supplied')) <> 'local_vendor'
           OR rfo.id IS NOT NULL
      ), 0) AS billable_fulfilled_qty,
      COALESCE(SUM(
        CASE
          WHEN lower(COALESCE(ri.source_type, 'hq_supplied')) = 'local_vendor' AND rfo.id IS NULL THEN 0
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
    LEFT JOIN public.requisition_fulfillment_overrides rfo ON rfo.requisition_item_id = ri.id
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
    SELECT id, invoice_number, status, billing_frequency, period_start, period_end
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
    ai.billing_frequency::text AS existing_invoice_cycle,
    ai.period_start AS existing_invoice_period_start,
    ai.period_end AS existing_invoice_period_end,
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
    PERFORM 1
    FROM public.requisitions r
    JOIN public.get_billable_requisition_candidates(p_billing_frequency, v_period_start, v_period_end, p_location_id) c
      ON c.requisition_id = r.id
    WHERE c.is_eligible
      AND c.location_id = v_location.location_id
    FOR UPDATE OF r;

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
      COALESCE(ri.finished_good_id::text, ri.item_id::text, ri.catalog_item_id::text, ri.id::text),
      COALESCE(ri.item_name_snapshot, ri.finished_good_id::text, ri.item_id::text, ri.catalog_item_id::text, 'Unknown item'),
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
    LEFT JOIN public.requisition_fulfillment_overrides rfo ON rfo.requisition_item_id = ri.id
    WHERE c.is_eligible
      AND c.location_id = v_location.location_id
      AND COALESCE(ri.quantity_fulfilled, 0) > 0
      AND (
        lower(COALESCE(ri.source_type, 'hq_supplied')) <> 'local_vendor'
        OR rfo.id IS NOT NULL
      );

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
