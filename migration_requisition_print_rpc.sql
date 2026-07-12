-- MIGRATION: get_requisition_for_print RPC  (v2 — patch for production)
-- ─────────────────────────────────────────────────────────────────────────────
-- Change from v1:
--   REMOVED r.fulfilled_at and r.fulfilled_by from the requisitions header
--   query and from the returned JSON.
--
--   Reason: public.requisitions does NOT have fulfilled_at / fulfilled_by
--   columns in production. Those columns exist only in migration_requisition_fulfilled_at.sql
--   which was never applied. Per-line quantity_fulfilled, backorder_qty, and
--   saved snapshots in requisition_items are sufficient for the pick list.
--
--   RETAINED: r.approved_at, r.approved_by — these DO exist (added by
--   migration_hq_fulfillment_role.sql which is deployed in production).
--
-- Authorization matrix:
--   hq_admin / hq_master / hq_master_admin / master_admin  → any requisition
--   hq_ops / hq_operations / hq_operations_staff           → any requisition
--   hq_fulfillment / hq_fulfillment_staff                  → any requisition, read-only
--   location_manager   → own location only AND status ≠ 'draft'
--   driver             → DENIED
--   anon / public      → DENIED
--
-- Returns: snapshot fields only.
-- NEVER returns: unit_price, line_total, total_amount, or any monetary field.
-- SELECT only. No INSERTs, UPDATEs, DELETEs, or mutating RPCs.
--
-- Safe to re-run (DROP IF EXISTS guarded).
-- Run in Supabase SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Drop old version if it exists ─────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_requisition_for_print(TEXT);

-- ── 2. Create function ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_requisition_for_print(p_requisition_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_caller_id   UUID;
  v_role        TEXT;
  v_location_id TEXT;
  v_req         RECORD;
  v_items       JSONB;
  v_result      JSONB;
BEGIN
  -- ── Step 1: Resolve caller via auth.uid() — no passed user ID is trusted ──
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED: not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT role, location_id
    INTO v_role, v_location_id
    FROM public.user_profiles
   WHERE user_id  = v_caller_id
     AND is_active = true
   LIMIT 1;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED: user profile not found or inactive' USING ERRCODE = '42501';
  END IF;

  -- ── Step 2: Role check — driver explicitly denied first ───────────────────
  IF v_role IN ('driver', 'delivery_driver') THEN
    RAISE EXCEPTION 'FORBIDDEN: drivers may not print requisitions' USING ERRCODE = '42501';
  END IF;

  -- Only the listed roles may proceed.
  IF v_role NOT IN (
    'hq_admin', 'hq_master', 'hq_master_admin', 'master_admin',
    'hq_ops', 'hq_operations', 'hq_operations_staff',
    'hq_fulfillment', 'hq_fulfillment_staff',
    'location_manager'
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN: role % is not permitted to print requisitions', v_role
      USING ERRCODE = '42501';
  END IF;

  -- ── Step 3: Fetch requisition header ──────────────────────────────────────
  -- NOTE: fulfilled_at / fulfilled_by are NOT selected — those columns do not
  -- exist on public.requisitions in production.
  -- approved_at / approved_by DO exist (migration_hq_fulfillment_role.sql).
  SELECT r.id,
         r.location,
         r.location_id,
         r.requestedby,
         r.date,
         r.hq_run_date,
         r.fulfillment_method,
         r.fulfillment_window,
         r.status,
         r.notes,
         r.approved_at,
         r.approved_by,
         r.created_at
    INTO v_req
    FROM public.requisitions r
   WHERE r.id = p_requisition_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT FOUND: requisition % does not exist', p_requisition_id
      USING ERRCODE = 'P0002';
  END IF;

  -- ── Step 4: location_manager additional checks ────────────────────────────
  IF v_role = 'location_manager' THEN
    -- Must be the manager for this requisition's location.
    IF v_req.location_id IS DISTINCT FROM v_location_id THEN
      RAISE EXCEPTION 'FORBIDDEN: location_manager may only print their own location''s requisitions'
        USING ERRCODE = '42501';
    END IF;

    -- Draft requisitions must not be printed by location managers.
    IF LOWER(COALESCE(v_req.status, '')) = 'draft' THEN
      RAISE EXCEPTION 'FORBIDDEN: draft requisitions cannot be printed'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ── Step 5: Fetch line items — snapshot fields only, no pricing ───────────
  SELECT jsonb_agg(
    jsonb_build_object(
      'id',                         ri.id,
      'item_id',                    ri.item_id,
      'finished_good_id',           ri.finished_good_id,
      'catalog_item_id',            ri.catalog_item_id,
      'source_type',                ri.source_type,
      'item_name_snapshot',         ri.item_name_snapshot,
      'unit_snapshot',              ri.unit_snapshot,
      'pack_qty_snapshot',          ri.pack_qty_snapshot,
      'supplier_snapshot',          ri.supplier_snapshot,
      'source_commissary_snapshot', ri.source_commissary_snapshot,
      'quantity_requested',         ri.quantity_requested,
      'quantity_approved',          ri.quantity_approved,
      'quantity_fulfilled',         ri.quantity_fulfilled,
      'allocated_qty',              ri.allocated_qty,
      'backorder_qty',              ri.backorder_qty,
      'fulfillment_note',           ri.fulfillment_note
      -- unit_price and line_total are intentionally excluded
    )
    ORDER BY ri.created_at ASC, ri.id ASC
  )
  INTO v_items
  FROM public.requisition_items ri
  WHERE ri.requisition_id = p_requisition_id;

  -- ── Step 6: Assemble and return ───────────────────────────────────────────
  -- NOTE: fulfilled_at / fulfilled_by are omitted from the JSON object.
  v_result := jsonb_build_object(
    'requisition', jsonb_build_object(
      'id',          v_req.id,
      'location',    v_req.location,
      'location_id', v_req.location_id,
      'requestedby', v_req.requestedby,
      'date',        v_req.date,
      'hq_run_date', v_req.hq_run_date,
      'fulfillment_method', v_req.fulfillment_method,
      'fulfillment_window', v_req.fulfillment_window,
      'status',      v_req.status,
      'notes',       v_req.notes,
      'approved_at', v_req.approved_at,
      'approved_by', v_req.approved_by,
      'created_at',  v_req.created_at
    ),
    'items', COALESCE(v_items, '[]'::jsonb)
  );

  RETURN v_result;
END;
$$;

-- ── 3. Lock down execution rights ────────────────────────────────────────────
REVOKE ALL  ON FUNCTION public.get_requisition_for_print(TEXT) FROM PUBLIC;
REVOKE ALL  ON FUNCTION public.get_requisition_for_print(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_requisition_for_print(TEXT) TO authenticated;

-- ── 4. Smoke test (run manually after deploying) ──────────────────────────────
-- Replace REQ-XXXX with a real requisition ID.
-- SELECT public.get_requisition_for_print('REQ-XXXX');
-- Expected: JSON with requisition header + items array.
-- Must NOT contain: unit_price, line_total, fulfilled_at, fulfilled_by.
