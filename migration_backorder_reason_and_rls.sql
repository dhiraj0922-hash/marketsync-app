-- =============================================================================
-- MIGRATION: migration_backorder_reason_and_rls.sql
-- Purpose:
--   1. Add backorder_reason column to requisition_backorders
--   2. Conservative backfill of backorder_reason
--   3. Create is_hq_management_profile() helper (hq_admin, hq_master, hq_ops)
--   4. Add supplemental RLS SELECT policies for hq_management + hq_fulfillment
--      on requisition_backorders and requisition_backorder_fulfillments
--      (existing policies are preserved unchanged)
--   5. Create set_requisition_backorder_reason() SECURITY DEFINER RPC
--   6. Patch finalize_requisition_fulfillment_v3:
--        CHANGE A: relaxed idempotency gate for partially_fulfilled / backordered
--        CHANGE B: no-decrease guard on fulfilled quantity
--      Base: exact live pg_get_functiondef() output (CSV export, 2026-06-27)
--
-- DOES NOT contain CREATE INDEX CONCURRENTLY.
-- Run that separately via migration_backorder_unique_index.sql.
-- =============================================================================

-- ─── Step 0: Prerequisite duplicate check (run standalone first) ───────────────
-- SELECT original_requisition_item_id, COUNT(*) AS cnt
-- FROM public.requisition_backorders
-- WHERE original_requisition_item_id IS NOT NULL
-- GROUP BY original_requisition_item_id
-- HAVING COUNT(*) > 1;
-- Expected: 0 rows. If any rows returned, STOP and report.

-- ─── Step 1: Add backorder_reason column ──────────────────────────────────────
-- Note: fulfilled_at already exists in the schema (migration_requisition_backorders.sql).
ALTER TABLE public.requisition_backorders
  ADD COLUMN IF NOT EXISTS backorder_reason TEXT
  CHECK (
    backorder_reason IS NULL OR backorder_reason IN (
      'out_of_stock',
      'awaiting_production',
      'awaiting_supplier_delivery',
      'hq_supplier_setup_required',
      'local_vendor_not_hq_fulfillable',
      'manual_hold'
    )
  );

-- ─── Step 2: Conservative backfill ────────────────────────────────────────────
-- Rule (approved):
--   source_type NOT IN ('finished_good', 'raw_item')  →  local_vendor_not_hq_fulfillable
--   everything else (no confident classification)      →  out_of_stock
--
-- Do NOT infer awaiting_production or awaiting_supplier_delivery from source_type alone.
-- Authorized roles (hq_master, hq_admin, hq_ops) correct reasons manually afterward.

UPDATE public.requisition_backorders
SET backorder_reason = 'local_vendor_not_hq_fulfillable'
WHERE backorder_reason IS NULL
  AND source_type NOT IN ('finished_good', 'raw_item');

UPDATE public.requisition_backorders
SET backorder_reason = 'out_of_stock'
WHERE backorder_reason IS NULL;

-- ─── Step 3: Create is_hq_management_profile() ────────────────────────────────
-- Covers hq_admin, hq_master, hq_ops for supplemental read / write policies.
-- Does NOT replace is_hq_admin_profile() which is used by existing policies.

CREATE OR REPLACE FUNCTION public.is_hq_management_profile()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE user_id = auth.uid()
      AND is_active = true
      AND role IN ('hq_admin', 'hq_master', 'hq_ops')
  );
$$;

-- ─── Step 4: Supplemental RLS policies on requisition_backorders ───────────────
-- The original policies are KEPT UNCHANGED:
--   "Backorders: Read by Role"      (SELECT for is_hq_admin_profile() OR location_manager)
--   "Backorders: Write by HQ Admin" (ALL    for is_hq_admin_profile())
--
-- hq_master and hq_ops gain explicit read coverage via is_hq_management_profile().
-- hq_fulfillment gains read-only access (no write, no reason edit).

DROP POLICY IF EXISTS "hq_management_read_backorders" ON public.requisition_backorders;
CREATE POLICY "hq_management_read_backorders"
  ON public.requisition_backorders
  FOR SELECT
  TO authenticated
  USING (public.is_hq_management_profile());

DROP POLICY IF EXISTS "hq_fulfillment_read_backorders" ON public.requisition_backorders;
CREATE POLICY "hq_fulfillment_read_backorders"
  ON public.requisition_backorders
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles
      WHERE user_id = auth.uid()
        AND is_active = true
        AND role = 'hq_fulfillment'
    )
  );

-- ─── Step 5: Supplemental RLS policies on requisition_backorder_fulfillments ──
-- Original policies KEPT UNCHANGED:
--   "Fulfillments: Read by Role"      (SELECT for is_hq_admin_profile() OR location-join)
--   "Fulfillments: Write by HQ Admin" (ALL    for is_hq_admin_profile())

DROP POLICY IF EXISTS "hq_management_read_bo_fulfillments" ON public.requisition_backorder_fulfillments;
CREATE POLICY "hq_management_read_bo_fulfillments"
  ON public.requisition_backorder_fulfillments
  FOR SELECT
  TO authenticated
  USING (public.is_hq_management_profile());

DROP POLICY IF EXISTS "hq_fulfillment_read_bo_fulfillments" ON public.requisition_backorder_fulfillments;
CREATE POLICY "hq_fulfillment_read_bo_fulfillments"
  ON public.requisition_backorder_fulfillments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles
      WHERE user_id = auth.uid()
        AND is_active = true
        AND role = 'hq_fulfillment'
    )
  );

-- ─── Step 6: set_requisition_backorder_reason() SECURITY DEFINER RPC ──────────
-- Authorized roles: hq_master, hq_admin, hq_ops only.
-- Updates ONLY backorder_reason and updated_at.
-- Does not allow changes to quantities, status, supplier, item, price,
-- location, FK links, or any other field.

CREATE OR REPLACE FUNCTION public.set_requisition_backorder_reason(
  p_backorder_id UUID,
  p_reason       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_role TEXT;
  v_now       TIMESTAMPTZ := NOW();
BEGIN
  -- A. Role check: hq_master, hq_admin, hq_ops only
  SELECT role INTO v_user_role
  FROM public.user_profiles
  WHERE user_id = auth.uid()
    AND is_active = true
  LIMIT 1;

  IF v_user_role NOT IN ('hq_admin', 'hq_master', 'hq_ops') THEN
    RAISE EXCEPTION 'Permission denied: only hq_admin, hq_master, and hq_ops may update backorder reasons. Got: %',
      COALESCE(v_user_role, '(no active profile found)');
  END IF;

  -- B. Validate reason value against allowed set
  IF p_reason IS NOT NULL AND p_reason NOT IN (
    'out_of_stock',
    'awaiting_production',
    'awaiting_supplier_delivery',
    'hq_supplier_setup_required',
    'local_vendor_not_hq_fulfillable',
    'manual_hold'
  ) THEN
    RAISE EXCEPTION 'Invalid backorder_reason value: %. Allowed: out_of_stock, awaiting_production, awaiting_supplier_delivery, hq_supplier_setup_required, local_vendor_not_hq_fulfillable, manual_hold.', p_reason;
  END IF;

  -- C. Update only backorder_reason and updated_at
  UPDATE public.requisition_backorders
  SET
    backorder_reason = p_reason,
    updated_at       = v_now
  WHERE id = p_backorder_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backorder record % not found.', p_backorder_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'backorder_id', p_backorder_id, 'reason', p_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.set_requisition_backorder_reason(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_requisition_backorder_reason(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_requisition_backorder_reason(UUID, TEXT) TO authenticated;

-- ─── Step 7: Patch finalize_requisition_fulfillment_v3 ────────────────────────
-- Base: exact live production definition retrieved via pg_get_functiondef()
-- from Supabase SQL Editor (exported as CSV, 2026-06-27).
--
-- ONLY TWO CHANGES from the live definition:
--
--   CHANGE A — Idempotency gate
--     BEFORE (live):
--       IF (v_status = 'fulfilled' OR v_status = 'partially_fulfilled' OR v_status = 'backordered') THEN
--         IF v_existing_key = p_idempotency_key THEN ... idempotent return ...
--         ELSE RAISE EXCEPTION 'Requisition % is already finalized with a different key.'
--         END IF;
--       END IF;
--     AFTER:
--       fulfilled              → permanently locked; new key = hard error.
--       partially_fulfilled /
--       backordered            → same key = idempotent replay;
--                                new key  = allowed re-entry for follow-up fulfillment.
--
--   CHANGE B — No-decrease guard
--     ADDED after v_pack_qty := COALESCE(v_pack_qty, 1);
--     Prevents proposed fulfilled qty from being lower than already-committed qty.
--
-- EVERYTHING ELSE IS CHARACTER-FOR-CHARACTER FROM THE LIVE pg_get_functiondef() OUTPUT:
--   Exact signature:  (text, jsonb, uuid, text, text)
--   $function$ delimiters, SET search_path TO 'public'
--   RETURNS jsonb (lowercase), LANGUAGE plpgsql (after $function$)
--   '(no active profile found)' error text
--   Extended hq_fulfillment comment in section A
--   Section labels A/B/C/D/E/F/G/H
--   All FG + raw stock movement logic verbatim
--   allocated_qty, backorder_qty, available_qty_at_finalization,
--   fulfilled_value, stock_movement_reference field writes verbatim

CREATE OR REPLACE FUNCTION public.finalize_requisition_fulfillment_v3(p_requisition_id text, p_fulfilled_lines jsonb, p_user_id uuid, p_user_name text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_line RECORD;
  v_line_id UUID;
  v_proposed_fulfilled NUMERIC;
  v_available NUMERIC;
  v_item_id TEXT;
  v_finished_good_id TEXT;
  v_quantity_requested NUMERIC;
  v_previous_fulfilled NUMERIC;
  v_delta NUMERIC;
  v_pack_qty NUMERIC;
  v_base_delta NUMERIC;
  v_shared_item_id TEXT;
  v_hq_stock NUMERIC;
  v_dest_location_id TEXT;
  v_unit_cost NUMERIC;
  v_unit_price NUMERIC;
  v_line_total NUMERIC;
  v_user_role TEXT;
  v_existing_key TEXT;

  v_all_supplied BOOLEAN := TRUE;
  v_any_supplied BOOLEAN := FALSE;
  v_any_backorder BOOLEAN := FALSE;

  v_status TEXT;
  v_now TIMESTAMPTZ := NOW();
  v_movement_ref TEXT;
  v_result JSONB;
BEGIN
  -- A. Role Enforcement: Only allow HQ fulfillment/admin roles to execute.
  --    hq_fulfillment added: it is the primary role responsible for finalizing
  --    requisitions. hq_master and hq_ops retain access. hq_admin (legacy) included.
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

  -- B. Concurrency & Idempotency Locking
  SELECT status, location_id, idempotency_key INTO v_status, v_dest_location_id, v_existing_key
  FROM public.requisitions
  WHERE id = p_requisition_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Requisition % not found.', p_requisition_id;
  END IF;

  -- ── CHANGE A: Split idempotency gate ─────────────────────────────────────────
  -- LIVE ORIGINAL (replaced):
  --   IF (v_status = 'fulfilled' OR v_status = 'partially_fulfilled' OR v_status = 'backordered') THEN
  --     IF v_existing_key = p_idempotency_key THEN ... idempotent return ...
  --     ELSE RAISE EXCEPTION 'Requisition % is already finalized with a different key.'
  --     END IF;
  --   END IF;
  --
  -- NEW BEHAVIOUR:
  --   fulfilled              → permanently locked; new key = hard error.
  --   partially_fulfilled /
  --   backordered            → same key = idempotent replay;
  --                            new key  = allowed re-entry for follow-up fulfillment.
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

  IF (v_status = 'partially_fulfilled' OR v_status = 'backordered') THEN
    IF v_existing_key = p_idempotency_key THEN
      SELECT total_amount INTO v_line_total FROM public.requisitions WHERE id = p_requisition_id;
      RETURN jsonb_build_object(
        'success', true,
        'new_status', v_status,
        'total_amount', v_line_total,
        'already_processed', true
      );
    END IF;
    -- New key: allowed re-entry for follow-up fulfillment. Continue processing.
  END IF;
  -- ── END CHANGE A ─────────────────────────────────────────────────────────────

  -- C. Process each line
  FOR v_line IN SELECT * FROM jsonb_to_recordset(p_fulfilled_lines) AS x(line_id UUID, fulfilled_qty NUMERIC, available_qty NUMERIC) LOOP
    v_line_id := v_line.line_id;
    v_proposed_fulfilled := v_line.fulfilled_qty;
    v_available := v_line.available_qty;

    SELECT item_id, finished_good_id, quantity_requested, quantity_fulfilled, pack_qty_snapshot, unit_price
    INTO v_item_id, v_finished_good_id, v_quantity_requested, v_previous_fulfilled, v_pack_qty, v_unit_price
    FROM public.requisition_items
    WHERE id = v_line_id;

    IF v_quantity_requested IS NULL THEN
      RAISE EXCEPTION 'Requisition item % not found.', v_line_id;
    END IF;

    v_previous_fulfilled := COALESCE(v_previous_fulfilled, 0);
    v_delta := v_proposed_fulfilled - v_previous_fulfilled;
    v_pack_qty := COALESCE(v_pack_qty, 1);

    -- ── CHANGE B: No-decrease guard ──────────────────────────────────────────────
    -- Proposed fulfilled quantity must never be lower than already-committed quantity.
    -- Prevents a follow-up fulfillment draft from zeroing out a previously supplied line.
    IF v_proposed_fulfilled < v_previous_fulfilled THEN
      RAISE EXCEPTION
        'Cannot reduce fulfilled quantity below already-committed value for item %. Committed: %, Proposed: %.',
        v_line_id, v_previous_fulfilled, v_proposed_fulfilled;
    END IF;
    -- ── END CHANGE B ─────────────────────────────────────────────────────────────

    IF v_proposed_fulfilled > v_quantity_requested THEN
      RAISE EXCEPTION 'Fulfilled quantity % exceeds requested quantity %', v_proposed_fulfilled, v_quantity_requested;
    END IF;

    -- D. Adjust stock and log movements
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
          VALUES ('LOC-HQ', v_finished_good_id, 'transfer_out', v_base_delta, v_unit_cost, v_base_delta * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment (FG) → ' || v_dest_location_id, v_now);
        ELSE
          INSERT INTO public.inventory_movements (location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at)
          VALUES ('LOC-HQ', v_finished_good_id, 'transfer_in', ABS(v_base_delta), v_unit_cost, ABS(v_base_delta) * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment reduction (FG) from ' || v_dest_location_id, v_now);
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
          VALUES ('LOC-HQ', v_shared_item_id, 'transfer_out', v_delta, v_unit_cost, v_delta * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment → ' || v_dest_location_id, v_now);
          INSERT INTO public.inventory_movements (location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at)
          VALUES (v_dest_location_id, v_shared_item_id, 'transfer_in', v_delta, v_unit_cost, v_delta * v_unit_cost, 'requisition', p_requisition_id, 'Received from HQ', v_now);
        ELSE
          INSERT INTO public.inventory_movements (location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at)
          VALUES ('LOC-HQ', v_shared_item_id, 'transfer_in', ABS(v_delta), v_unit_cost, ABS(v_delta) * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment reduction from ' || v_dest_location_id, v_now);
          INSERT INTO public.inventory_movements (location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at)
          VALUES (v_dest_location_id, v_shared_item_id, 'transfer_out', ABS(v_delta), v_unit_cost, ABS(v_delta) * v_unit_cost, 'requisition', p_requisition_id, 'Fulfillment reduction returned to HQ', v_now);
        END IF;
      END IF;
    END IF;

    -- E. Update line item values + audit trail
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

  -- F. Determine final status
  SELECT
    COALESCE(bool_and(quantity_fulfilled = quantity_requested), TRUE),
    COALESCE(bool_or(quantity_fulfilled > 0), FALSE),
    COALESCE(bool_or(backorder_qty > 0), FALSE)
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

  -- G. Calculate total supplied value
  SELECT COALESCE(SUM(quantity_fulfilled * unit_price), 0) INTO v_line_total
  FROM public.requisition_items
  WHERE requisition_id = p_requisition_id;

  -- H. Commit parent status + total_amount
  UPDATE public.requisitions
  SET status = v_status, total_amount = v_line_total, idempotency_key = p_idempotency_key, updated_at = v_now
  WHERE id = p_requisition_id;

  SELECT jsonb_build_object('success', true, 'new_status', v_status, 'total_amount', v_line_total)
  INTO v_result;
  RETURN v_result;
END;
$function$
;

-- Permissions (verbatim from original migration_requisition_fulfillment_safeguards.sql)
REVOKE ALL ON FUNCTION public.finalize_requisition_fulfillment_v3(
  TEXT, JSONB, UUID, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_requisition_fulfillment_v3(
  TEXT, JSONB, UUID, TEXT, TEXT
) FROM anon;
GRANT EXECUTE ON FUNCTION public.finalize_requisition_fulfillment_v3(
  TEXT, JSONB, UUID, TEXT, TEXT
) TO authenticated;
