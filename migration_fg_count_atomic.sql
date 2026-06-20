-- =============================================================================
-- Atomic Count Saving Function
-- Safe to re-run. Creates save_fg_count_line_atomic RPC.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.save_fg_count_line_atomic(
  p_session_id TEXT,
  p_count_date DATE,
  p_session_name TEXT,
  p_counted_by UUID,
  p_counted_by_name TEXT,
  p_item_id TEXT,
  p_item_name TEXT,
  p_unit TEXT,
  p_physical_qty NUMERIC,
  p_unit_cost NUMERIC
) RETURNS JSONB AS $$
DECLARE
  v_expected_stock NUMERIC := 0;
  v_variance NUMERIC := 0;
  v_now TIMESTAMPTZ := NOW();
  v_result JSONB;
BEGIN
  -- 1. Calculate Expected Stock from inventory_movements as of the count date,
  -- excluding any previous variance movement logged for the current session.
  SELECT COALESCE(SUM(
    CASE 
      WHEN movement_type IN ('production_in', 'count_variance_gain', 'purchase_in', 'adjustment_in', 'correction_in', 'transfer_in', 'opening_balance') THEN quantity 
      WHEN movement_type IN ('transfer_out', 'count_variance_loss', 'adjustment_out', 'correction_out', 'production_void_remove_finished_good') THEN -quantity 
      ELSE 0 
    END
  ), 0)
  INTO v_expected_stock
  FROM public.inventory_movements
  WHERE location_id = 'LOC-HQ' 
    AND item_id = p_item_id 
    AND created_at <= (p_count_date || ' 23:59:59.999')::timestamp
    AND (reference_id IS NULL OR reference_id != p_session_id);

  -- 2. Calculate Variance
  v_variance := p_physical_qty - v_expected_stock;

  -- 3. Upsert Session
  INSERT INTO public.fg_count_sessions (id, count_date, session_name, counted_by, counted_by_name, updated_at)
  VALUES (p_session_id, p_count_date, p_session_name, p_counted_by, p_counted_by_name, v_now)
  ON CONFLICT (id) DO UPDATE SET
    count_date = EXCLUDED.count_date,
    session_name = EXCLUDED.session_name,
    counted_by = EXCLUDED.counted_by,
    counted_by_name = EXCLUDED.counted_by_name,
    updated_at = v_now;

  -- 4. Upsert Line
  INSERT INTO public.fg_count_lines (
    id, session_id, item_id, item_name, unit, system_qty, physical_qty, variance_qty, unit_cost, variance_value, updated_at
  )
  VALUES (
    p_session_id || ':' || p_item_id, p_session_id, p_item_id, p_item_name, p_unit, v_expected_stock, p_physical_qty, v_variance, p_unit_cost, v_variance * p_unit_cost, v_now
  )
  ON CONFLICT (session_id, item_id) DO UPDATE SET
    item_name = EXCLUDED.item_name,
    unit = EXCLUDED.unit,
    system_qty = EXCLUDED.system_qty,
    physical_qty = EXCLUDED.physical_qty,
    variance_qty = EXCLUDED.variance_qty,
    unit_cost = EXCLUDED.unit_cost,
    variance_value = EXCLUDED.variance_value,
    updated_at = v_now;

  -- 5. Update hq_sale_items.instock
  UPDATE public.hq_sale_items
  SET instock = p_physical_qty, updated_at = v_now
  WHERE id = p_item_id;

  -- 6. Prevent duplicate count adjustments (reconcile old variance movements)
  DELETE FROM public.inventory_movements
  WHERE location_id = 'LOC-HQ' 
    AND item_id = p_item_id 
    AND reference_type = 'fg_count' 
    AND reference_id = p_session_id;

  -- Insert new variance movement if there is a variance
  IF v_variance != 0 THEN
    INSERT INTO public.inventory_movements (
      location_id, item_id, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, notes, created_at
    )
    VALUES (
      'LOC-HQ',
      p_item_id,
      CASE WHEN v_variance > 0 THEN 'count_variance_gain' ELSE 'count_variance_loss' END,
      ABS(v_variance),
      CASE WHEN p_unit_cost > 0 THEN p_unit_cost ELSE NULL END,
      ABS(v_variance) * p_unit_cost,
      'fg_count',
      p_session_id,
      '{"kind":"fg_count_session","count_date":"' || p_count_date || '","session_name":' || COALESCE('"' || p_session_name || '"', 'null') || ',"item_name":"' || p_item_name || '","system_qty":' || v_expected_stock || ',"physical_qty":' || p_physical_qty || ',"variance_qty":' || v_variance || '}',
      v_now
    );
  END IF;

  SELECT jsonb_build_object(
    'success', true,
    'expected_stock', v_expected_stock,
    'variance', v_variance
  ) INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;
