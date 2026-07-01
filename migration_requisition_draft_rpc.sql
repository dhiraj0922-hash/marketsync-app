-- =============================================================================
-- MIGRATION: Atomic requisition draft save + submit RPCs
--
-- Scope:
--   - Adds SECURITY DEFINER RPCs only.
--   - Does not mutate historical submitted requisition lines.
--   - Does not create stock movements, invoices, deliveries, backorders,
--     fulfillment records, or HQ notifications.
--
-- Run only after:
--   1. check_requisition_draft_duplicates.sql returns zero rows.
--   2. migration_requisition_draft_unique_index.sql has been applied.
-- =============================================================================

CREATE OR REPLACE FUNCTION public._assert_requisition_draft_access(
  p_location_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_profile RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;

  SELECT id, user_id, role, location_id, is_active
  INTO v_profile
  FROM public.user_profiles
  WHERE user_id = v_user_id
  LIMIT 1;

  IF v_profile.user_id IS NULL OR COALESCE(v_profile.is_active, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Active user profile not found.';
  END IF;

  IF p_location_id IS NULL OR btrim(p_location_id) = '' THEN
    RAISE EXCEPTION 'Location is required.';
  END IF;

  IF v_profile.role = 'location_manager' THEN
    IF v_profile.location_id IS DISTINCT FROM p_location_id THEN
      RAISE EXCEPTION 'Location managers can only save drafts for their assigned location.';
    END IF;
  ELSIF v_profile.role NOT IN ('hq_master', 'hq_admin', 'hq_ops') THEN
    RAISE EXCEPTION 'You are not allowed to save requisition drafts.';
  END IF;

  RETURN v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public._assert_requisition_draft_access(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._assert_requisition_draft_access(TEXT) FROM anon;

CREATE OR REPLACE FUNCTION public._validate_requisition_draft_line(
  p_line JSONB,
  p_location_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_type TEXT := COALESCE(NULLIF(btrim(p_line->>'source_type'), ''), 'hq_supplied');
  v_item_id TEXT := NULLIF(btrim(p_line->>'item_id'), '');
  v_finished_good_id TEXT := NULLIF(btrim(p_line->>'finished_good_id'), '');
  v_catalog_item_id TEXT := NULLIF(btrim(p_line->>'catalog_item_id'), '');
  v_item_name TEXT := NULLIF(btrim(p_line->>'item_name_snapshot'), '');
  v_unit_snapshot TEXT := NULLIF(btrim(p_line->>'unit_snapshot'), '');
  v_qty NUMERIC := COALESCE(NULLIF(p_line->>'quantity_requested', '')::NUMERIC, 0);
  v_unit_price NUMERIC := COALESCE(NULLIF(p_line->>'unit_price', '')::NUMERIC, 0);
  v_pack_qty NUMERIC := COALESCE(NULLIF(p_line->>'pack_qty_snapshot', '')::NUMERIC, 1);
BEGIN
  IF p_location_id IS NULL OR btrim(p_location_id) = '' THEN
    RAISE EXCEPTION 'Location is required for draft line validation.';
  END IF;

  IF v_source_type NOT IN ('hq_supplied', 'local_vendor') THEN
    RAISE EXCEPTION 'Invalid source_type "%". New draft lines must be hq_supplied or local_vendor.', v_source_type;
  END IF;

  IF v_item_name IS NULL THEN
    RAISE EXCEPTION 'Draft line is missing item_name_snapshot.';
  END IF;

  IF v_unit_snapshot IS NULL THEN
    RAISE EXCEPTION 'Draft line is missing unit_snapshot.';
  END IF;

  IF v_qty <= 0 THEN
    RAISE EXCEPTION 'Draft line quantity must be greater than zero.';
  END IF;

  IF v_unit_price < 0 THEN
    RAISE EXCEPTION 'Draft line unit price cannot be negative.';
  END IF;

  IF v_pack_qty <= 0 THEN
    RAISE EXCEPTION 'Draft line pack quantity must be greater than zero.';
  END IF;

  IF v_source_type = 'hq_supplied' THEN
    IF v_catalog_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'HQ supplied draft lines must not set catalog_item_id.';
    END IF;

    IF (v_item_id IS NULL AND v_finished_good_id IS NULL)
       OR (v_item_id IS NOT NULL AND v_finished_good_id IS NOT NULL) THEN
      RAISE EXCEPTION 'HQ supplied draft lines require exactly one of item_id or finished_good_id.';
    END IF;

    IF v_finished_good_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.hq_sale_items fg
      WHERE fg.id = v_finished_good_id
        AND COALESCE(fg.is_active, true) = true
        AND COALESCE(fg.is_requisitionable, true) = true
        AND (
          COALESCE(fg.location_availability_mode, 'all') = 'all'
          OR (
            fg.location_availability_mode = 'selected'
            AND EXISTS (
              SELECT 1
              FROM public.finished_good_location_availability fga
              WHERE fga.finished_good_id = fg.id
                AND fga.location_id = p_location_id
                AND COALESCE(fga.is_available, true) = true
            )
          )
        )
    ) THEN
      RAISE EXCEPTION 'Finished good "%" is not active, requisitionable, or available to location "%".', v_finished_good_id, p_location_id;
    END IF;

    IF v_item_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.inventory_items ii
      WHERE ii.id = v_item_id
        AND (ii.location_id IS NULL OR ii.location_id = 'LOC-HQ' OR ii.location_id = p_location_id)
    ) THEN
      RAISE EXCEPTION 'Inventory item "%" is not available for location "%".', v_item_id, p_location_id;
    END IF;
  END IF;

  IF v_source_type = 'local_vendor' THEN
    IF v_catalog_item_id IS NULL THEN
      RAISE EXCEPTION 'Local vendor draft lines require catalog_item_id.';
    END IF;

    IF v_item_id IS NOT NULL OR v_finished_good_id IS NOT NULL THEN
      RAISE EXCEPTION 'Local vendor draft lines must not set item_id or finished_good_id.';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.outlet_catalog_items c
      WHERE c.item_id = v_catalog_item_id
        AND COALESCE(c.is_active, true) = true
        AND COALESCE(c.ordering_enabled, true) = true
        AND c.source_type = 'local_vendor'
    ) THEN
      RAISE EXCEPTION 'Outlet catalog item "%" is not active/orderable for location "%".', v_catalog_item_id, p_location_id;
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._validate_requisition_draft_line(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._validate_requisition_draft_line(JSONB, TEXT) FROM anon;

CREATE OR REPLACE FUNCTION public.save_requisition_draft(
  p_location_id TEXT,
  p_notes TEXT DEFAULT '',
  p_line_items JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_draft_id TEXT;
  v_line JSONB;
  v_line_count INTEGER := 0;
  v_total NUMERIC := 0;
  v_now TIMESTAMPTZ := now();
BEGIN
  v_user_id := public._assert_requisition_draft_access(p_location_id);

  PERFORM pg_advisory_xact_lock(
    hashtext('requisition_draft:' || p_location_id || ':' || v_user_id::text)
  );

  IF jsonb_typeof(p_line_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_line_items must be a JSON array.';
  END IF;

  SELECT COUNT(*)
  INTO v_line_count
  FROM jsonb_array_elements(p_line_items);

  IF v_line_count <= 0 THEN
    RAISE EXCEPTION 'Cannot save a draft with no line items.';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_line_items)
  LOOP
    PERFORM public._validate_requisition_draft_line(v_line, p_location_id);
    v_total := v_total + round(
      COALESCE(NULLIF(v_line->>'quantity_requested', '')::NUMERIC, 0)
      * COALESCE(NULLIF(v_line->>'unit_price', '')::NUMERIC, 0),
      2
    );
  END LOOP;

  SELECT id
  INTO v_draft_id
  FROM public.requisitions
  WHERE status = 'draft'
    AND location_id = p_location_id
    AND created_by = v_user_id
  ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
  LIMIT 1
  FOR UPDATE;

  IF v_draft_id IS NULL THEN
    v_draft_id := 'REQ-DRAFT-' || upper(substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 16));

    INSERT INTO public.requisitions (
      id,
      location_id,
      location,
      created_by,
      requestedby,
      status,
      notes,
      date,
      items,
      total_amount,
      lineitems,
      created_at,
      updated_at
    )
    VALUES (
      v_draft_id,
      p_location_id,
      p_location_id,
      v_user_id,
      v_user_id::TEXT,
      'draft',
      COALESCE(p_notes, ''),
      to_char(v_now AT TIME ZONE 'America/Toronto', 'Mon DD, YYYY'),
      v_line_count,
      round(v_total, 2),
      '[]'::JSONB,
      v_now,
      v_now
    );
  ELSE
    UPDATE public.requisitions
    SET
      notes = COALESCE(p_notes, ''),
      items = v_line_count,
      total_amount = round(v_total, 2),
      updated_at = v_now
    WHERE id = v_draft_id
      AND status = 'draft'
      AND location_id = p_location_id
      AND created_by = v_user_id;
  END IF;

  DELETE FROM public.requisition_items
  WHERE requisition_id = v_draft_id;

  INSERT INTO public.requisition_items (
    requisition_id,
    item_id,
    finished_good_id,
    catalog_item_id,
    source_type,
    supplier_snapshot,
    pack_qty_snapshot,
    item_name_snapshot,
    unit_snapshot,
    source_commissary_snapshot,
    quantity_requested,
    unit_price,
    line_total,
    quantity_approved,
    quantity_fulfilled
  )
  SELECT
    v_draft_id,
    NULLIF(btrim(src.line->>'item_id'), ''),
    NULLIF(btrim(src.line->>'finished_good_id'), ''),
    NULLIF(btrim(src.line->>'catalog_item_id'), ''),
    COALESCE(NULLIF(btrim(src.line->>'source_type'), ''), 'hq_supplied'),
    NULLIF(src.line->>'supplier_snapshot', ''),
    COALESCE(NULLIF(src.line->>'pack_qty_snapshot', '')::NUMERIC, 1),
    NULLIF(src.line->>'item_name_snapshot', ''),
    NULLIF(src.line->>'unit_snapshot', ''),
    NULLIF(src.line->>'source_commissary_snapshot', ''),
    COALESCE(NULLIF(src.line->>'quantity_requested', '')::NUMERIC, 0),
    COALESCE(NULLIF(src.line->>'unit_price', '')::NUMERIC, 0),
    round(
      COALESCE(NULLIF(src.line->>'quantity_requested', '')::NUMERIC, 0)
      * COALESCE(NULLIF(src.line->>'unit_price', '')::NUMERIC, 0),
      2
    ),
    NULL,
    NULL
  FROM jsonb_array_elements(p_line_items) AS src(line);

  RETURN jsonb_build_object(
    'success', true,
    'requisition_id', v_draft_id,
    'status', 'draft',
    'items', v_line_count,
    'total_amount', round(v_total, 2)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_requisition_draft(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_requisition_draft(TEXT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_requisition_draft(TEXT, TEXT, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_requisition_draft(
  p_requisition_id TEXT,
  p_location_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_req RECORD;
  v_line RECORD;
  v_line_count INTEGER := 0;
  v_total NUMERIC := 0;
  v_now TIMESTAMPTZ := now();
BEGIN
  v_user_id := public._assert_requisition_draft_access(p_location_id);

  IF p_requisition_id IS NULL OR btrim(p_requisition_id) = '' THEN
    RAISE EXCEPTION 'Draft requisition id is required.';
  END IF;

  SELECT *
  INTO v_req
  FROM public.requisitions
  WHERE id = p_requisition_id
    AND status = 'draft'
    AND location_id = p_location_id
    AND created_by = v_user_id
  FOR UPDATE;

  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Active draft requisition not found.';
  END IF;

  FOR v_line IN
    SELECT *
    FROM public.requisition_items
    WHERE requisition_id = p_requisition_id
    ORDER BY created_at ASC
  LOOP
    PERFORM public._validate_requisition_draft_line(jsonb_build_object(
      'item_id', v_line.item_id,
      'finished_good_id', v_line.finished_good_id,
      'catalog_item_id', v_line.catalog_item_id,
      'source_type', v_line.source_type,
      'item_name_snapshot', v_line.item_name_snapshot,
      'unit_snapshot', v_line.unit_snapshot,
      'pack_qty_snapshot', v_line.pack_qty_snapshot,
      'quantity_requested', v_line.quantity_requested,
      'unit_price', COALESCE(v_line.unit_price, 0)
    ), p_location_id);
    v_line_count := v_line_count + 1;
    v_total := v_total + round(COALESCE(v_line.quantity_requested, 0) * COALESCE(v_line.unit_price, 0), 2);
  END LOOP;

  IF v_line_count <= 0 THEN
    RAISE EXCEPTION 'Cannot submit a draft with no line items.';
  END IF;

  UPDATE public.requisitions
  SET
    status = 'submitted',
    items = v_line_count,
    total_amount = round(v_total, 2),
    updated_at = v_now
  WHERE id = p_requisition_id
    AND status = 'draft'
    AND location_id = p_location_id
    AND created_by = v_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'requisition_id', p_requisition_id,
    'status', 'submitted',
    'items', v_line_count,
    'total_amount', round(v_total, 2)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_requisition_draft(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_requisition_draft(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_requisition_draft(TEXT, TEXT) TO authenticated;
