-- =============================================================================
-- MIGRATION: migration_requisition_fulfillment_safeguards.sql
-- Deploy safeguards: status triggers, idempotency columns, audit columns,
-- and the atomic finalize_requisition_fulfillment_v3 transaction RPC.
-- =============================================================================

-- 1. Update trigger to allow 'partially_fulfilled' and 'backordered' statuses
CREATE OR REPLACE FUNCTION public.enforce_requisition_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS NOT NULL
     AND NEW.status NOT IN ('draft', 'submitted', 'approved', 'rejected', 'fulfilled', 'partially_fulfilled', 'backordered')
  THEN
    RAISE EXCEPTION
      'requisitions.status must be one of: draft, submitted, approved, rejected, fulfilled, partially_fulfilled, backordered. Got: %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Add idempotency_key column to requisitions table
ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;

-- 3. Add audit columns to requisition_items table
ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS available_qty_at_finalization numeric,
  ADD COLUMN IF NOT EXISTS fulfilled_value numeric,
  ADD COLUMN IF NOT EXISTS stock_movement_reference text,
  ADD COLUMN IF NOT EXISTS delivery_ticket_reference text;

-- 4. Create atomic finalization function
CREATE OR REPLACE FUNCTION public.finalize_requisition_fulfillment_v3(
  p_requisition_id TEXT,
  p_fulfilled_lines JSONB, -- array of { line_id: UUID, fulfilled_qty: NUMERIC, available_qty: NUMERIC }
  p_user_id UUID,
  p_user_name TEXT,
  p_idempotency_key TEXT
) RETURNS JSONB
SECURITY DEFINER
SET search_path = public
AS $$
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
  -- A. Role Enforcement: Only allow HQ fulfillment/admin roles to execute
  -- p_user_id is the Supabase auth.users.id UUID.
  -- user_profiles.user_id maps to auth.users.id; user_profiles.id is the profile row PK.
  SELECT role INTO v_user_role
  FROM public.user_profiles
  WHERE user_id = p_user_id
    AND is_active = true
  LIMIT 1;
  IF v_user_role NOT IN ('hq_admin', 'hq_master', 'hq_ops', 'hq_fulfillment') THEN
    RAISE EXCEPTION 'Permission denied: User % does not have an authorized HQ role (got: %).', p_user_id, COALESCE(v_user_role, '(no profile found)');
  END IF;

  -- B. Concurrency & Idempotency Locking
  -- Lock the requisition row for update
  SELECT status, location_id, idempotency_key INTO v_status, v_dest_location_id, v_existing_key
  FROM public.requisitions
  WHERE id = p_requisition_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Requisition % not found.', p_requisition_id;
  END IF;

  -- If status is already fulfilled or partially_fulfilled, check the idempotency key
  IF (v_status = 'fulfilled' OR v_status = 'partially_fulfilled' OR v_status = 'backordered') THEN
    IF v_existing_key = p_idempotency_key THEN
      -- Return original result
      SELECT total_amount INTO v_line_total FROM public.requisitions WHERE id = p_requisition_id;
      RETURN jsonb_build_object(
        'success', true,
        'new_status', v_status,
        'total_amount', v_line_total,
        'already_processed', true
      );
    ELSE
      RAISE EXCEPTION 'Requisition % is already finalized with a different key.', p_requisition_id;
    END IF;
  END IF;

  -- C. Process each line in draft
  FOR v_line IN SELECT * FROM jsonb_to_recordset(p_fulfilled_lines) AS x(line_id UUID, fulfilled_qty NUMERIC, available_qty NUMERIC) LOOP
    v_line_id := v_line.line_id;
    v_proposed_fulfilled := v_line.fulfilled_qty;
    v_available := v_line.available_qty;

    -- Fetch current requisition item details
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

    -- Stock Validation Rule: fulfilledQty must never exceed requestedQty
    IF v_proposed_fulfilled > v_quantity_requested THEN
      RAISE EXCEPTION 'Fulfilled quantity % exceeds requested quantity %', v_proposed_fulfilled, v_quantity_requested;
    END IF;

    -- D. Adjust stock and log movements (strictly in base units)
    IF v_delta != 0 THEN
      IF v_finished_good_id IS NOT NULL THEN
        -- Finished Goods Mode
        v_base_delta := v_delta * v_pack_qty;
        
        -- Get fresh stock (base units)
        SELECT COALESCE(instock, 0), COALESCE(making_cost, 0) INTO v_hq_stock, v_unit_cost
        FROM public.hq_sale_items
        WHERE id = v_finished_good_id;

        -- Validate stock (base units only)
        IF v_base_delta > 0 AND v_base_delta > v_hq_stock THEN
          RAISE EXCEPTION 'Cannot fulfill quantity % packs (% base units) - only % base units available in HQ stock.', v_delta, v_base_delta, v_hq_stock;
        END IF;

        -- Update stock
        UPDATE public.hq_sale_items
        SET instock = instock - v_base_delta, updated_at = v_now
        WHERE id = v_finished_good_id;

        -- Log movement
        v_movement_ref := 'REQ-MOV-' || p_requisition_id || '-' || v_line_id;
        IF v_base_delta > 0 THEN
          INSERT INTO public.inventory_movements (
            location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at
          ) VALUES (
            'LOC-HQ', v_finished_good_id, 'transfer_out', v_base_delta, v_unit_cost, v_base_delta * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment (FG) → ' || v_dest_location_id, v_now
          );
        ELSE
          INSERT INTO public.inventory_movements (
            location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at
          ) VALUES (
            'LOC-HQ', v_finished_good_id, 'transfer_in', ABS(v_base_delta), v_unit_cost, ABS(v_base_delta) * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment reduction (FG) from ' || v_dest_location_id, v_now
          );
        END IF;

      ELSE
        -- Raw Item Mode
        -- Resolve shared item_id
        SELECT item_id INTO v_shared_item_id FROM public.inventory_items WHERE id = v_item_id;
        IF v_shared_item_id IS NULL THEN
          RAISE EXCEPTION 'Shared item_id not resolved for inventory item %', v_item_id;
        END IF;

        -- Get fresh stock
        SELECT COALESCE(instock, 0), COALESCE(cost, 0) INTO v_hq_stock, v_unit_cost
        FROM public.inventory_items
        WHERE item_id = v_shared_item_id AND location_id = 'LOC-HQ';

        IF v_hq_stock IS NULL THEN
          RAISE EXCEPTION 'HQ inventory row missing for shared item_id %', v_shared_item_id;
        END IF;

        -- Validate stock (base units only)
        IF v_delta > 0 AND v_delta > v_hq_stock THEN
          RAISE EXCEPTION 'Cannot fulfill quantity % - only % available in HQ stock.', v_delta, v_hq_stock;
        END IF;

        -- Update stock (HQ)
        UPDATE public.inventory_items
        SET instock = instock - v_delta, updated_at = v_now
        WHERE item_id = v_shared_item_id AND location_id = 'LOC-HQ';

        -- Update stock (Destination)
        IF EXISTS (SELECT 1 FROM public.inventory_items WHERE item_id = v_shared_item_id AND location_id = v_dest_location_id) THEN
          UPDATE public.inventory_items
          SET instock = instock + v_delta, updated_at = v_now
          WHERE item_id = v_shared_item_id AND location_id = v_dest_location_id;
        ELSE
          INSERT INTO public.inventory_items (
             id, location_id, item_id, name, instock, created_at, updated_at
          ) VALUES (
             gen_random_uuid()::text, v_dest_location_id, v_shared_item_id, 'Item ' || v_shared_item_id, v_delta, v_now, v_now
          );
        END IF;

        -- Log movement
        v_movement_ref := 'REQ-MOV-' || p_requisition_id || '-' || v_line_id;
        IF v_delta > 0 THEN
          INSERT INTO public.inventory_movements (
            location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at
          ) VALUES (
            'LOC-HQ', v_shared_item_id, 'transfer_out', v_delta, v_unit_cost, v_delta * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment → ' || v_dest_location_id, v_now
          );
          INSERT INTO public.inventory_movements (
            location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at
          ) VALUES (
            v_dest_location_id, v_shared_item_id, 'transfer_in', v_delta, v_unit_cost, v_delta * v_unit_cost, 'requisition', p_requisition_id, 'Received from HQ', v_now
          );
        ELSE
          INSERT INTO public.inventory_movements (
            location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at
          ) VALUES (
            'LOC-HQ', v_shared_item_id, 'transfer_in', ABS(v_delta), v_unit_cost, ABS(v_delta) * v_unit_cost, 'requisition', p_requisition_id, 'Requisition fulfillment reduction from ' || v_dest_location_id, v_now
          );
          INSERT INTO public.inventory_movements (
            location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at
          ) VALUES (
            v_dest_location_id, v_shared_item_id, 'transfer_out', ABS(v_delta), v_unit_cost, ABS(v_delta) * v_unit_cost, 'requisition', p_requisition_id, 'Fulfillment reduction returned to HQ', v_now
          );
        END IF;

      END IF;
    END IF;

    -- Update line item database values + audit trails
    v_line_total := v_proposed_fulfilled * v_unit_price;
    UPDATE public.requisition_items
    SET
      quantity_fulfilled = v_proposed_fulfilled,
      allocated_qty = v_proposed_fulfilled,
      backorder_qty = v_quantity_requested - v_proposed_fulfilled,
      line_total = v_line_total,
      fulfilled_by = p_user_id,
      fulfilled_at = v_now,
      available_qty_at_finalization = v_available,
      fulfilled_value = v_line_total,
      stock_movement_reference = COALESCE(v_movement_ref, stock_movement_reference),
      updated_at = v_now
    WHERE id = v_line_id;

  END LOOP;

  -- E. Determine final status for parent requisition
  -- status names:
  --   fulfilled: every requested line fully supplied
  --   partially_fulfilled: at least one line supplied and at least one qty remains backordered
  --   backordered: nothing was supplied (for all lines quantity_fulfilled = 0) and all requested quantity remains open
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

  -- F. Calculate total supplied value for parent requisition
  SELECT COALESCE(SUM(quantity_fulfilled * unit_price), 0) INTO v_line_total
  FROM public.requisition_items
  WHERE requisition_id = p_requisition_id;

  -- G. Commit parent status, total_amount, and idempotency key
  UPDATE public.requisitions
  SET
    status = v_status,
    total_amount = v_line_total,
    idempotency_key = p_idempotency_key,
    updated_at = v_now
  WHERE id = p_requisition_id;

  SELECT jsonb_build_object(
    'success', true,
    'new_status', v_status,
    'total_amount', v_line_total
  ) INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

-- 5. Permissions
-- Revoke from public/anon so unauthenticated callers cannot invoke the function.
REVOKE ALL ON FUNCTION public.finalize_requisition_fulfillment_v3(
  TEXT, JSONB, UUID, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_requisition_fulfillment_v3(
  TEXT, JSONB, UUID, TEXT, TEXT
) FROM anon;

-- Grant execute to authenticated Supabase users only.
-- The function itself enforces HQ-role restriction via the role check above.
GRANT EXECUTE ON FUNCTION public.finalize_requisition_fulfillment_v3(
  TEXT, JSONB, UUID, TEXT, TEXT
) TO authenticated;
