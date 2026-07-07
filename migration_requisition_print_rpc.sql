-- MIGRATION: get_requisition_for_print RPC
-- ─────────────────────────────────────────────────────────────────────────────
-- Purpose:
--   Provides a read-only, access-controlled RPC for the /requisitions/[id]/print
--   page.  The print route must NOT rely only on client-side role checks; this
--   function enforces authorization at the DB layer using auth.uid().
--
-- Authorization matrix:
--   hq_admin   (role = 'hq_admin' OR 'hq_master')  → any requisition
--   hq_ops     (role = 'hq_ops')                    → any requisition
--   hq_fulfillment (role = 'hq_fulfillment')         → any requisition, read-only
--   location_manager (role = 'location_manager')     → own location only AND status ≠ 'draft'
--   driver     → DENIED
--   anon       → DENIED
--   public     → DENIED
--
-- Returns:
--   Exactly the fields needed by the print document.
--   NEVER returns: unit_price, line_total, pack_price_snapshot, or any monetary field.
--
-- Guarantees:
--   SELECT only. No INSERTs, UPDATEs, DELETEs, or RPCs that mutate state.
--   SECURITY DEFINER so it can bypass RLS on requisition_items (which has
--   RLS DISABLED via migration.sql:162) while still enforcing app-level role logic.
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
  -- ── Step 1: Resolve caller identity ───────────────────────────────────────
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

  -- ── Step 2: Role check ─────────────────────────────────────────────────────
  -- driver is explicitly denied regardless of any other condition.
  IF v_role IN ('driver', 'delivery_driver') THEN
    RAISE EXCEPTION 'FORBIDDEN: drivers may not print requisitions' USING ERRCODE = '42501';
  END IF;

  -- Only allowed roles may proceed.
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
  SELECT r.id, r.location, r.location_id, r.requestedby,
         r.date, r.status, r.notes,
         r.approved_at, r.approved_by,
         r.fulfilled_at, r.fulfilled_by,
         r.created_at
    INTO v_req
    FROM public.requisitions r
   WHERE r.id = p_requisition_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT FOUND: requisition % does not exist', p_requisition_id
      USING ERRCODE = 'P0002';
  END IF;

  -- ── Step 4: Location-manager additional checks ────────────────────────────
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

  -- ── Step 5: Fetch line items (snapshot fields only, no pricing) ───────────
  SELECT jsonb_agg(
    jsonb_build_object(
      'id',                   ri.id,
      'item_id',              ri.item_id,
      'finished_good_id',     ri.finished_good_id,
      'catalog_item_id',      ri.catalog_item_id,
      'source_type',          ri.source_type,
      'item_name_snapshot',   ri.item_name_snapshot,
      'unit_snapshot',        ri.unit_snapshot,
      'pack_qty_snapshot',    ri.pack_qty_snapshot,
      'supplier_snapshot',    ri.supplier_snapshot,
      'source_commissary_snapshot', ri.source_commissary_snapshot,
      'quantity_requested',   ri.quantity_requested,
      'quantity_approved',    ri.quantity_approved,
      'quantity_fulfilled',   ri.quantity_fulfilled,
      'allocated_qty',        ri.allocated_qty,
      'backorder_qty',        ri.backorder_qty,
      'fulfillment_note',     ri.fulfillment_note
      -- unit_price / line_total are intentionally excluded
    )
    ORDER BY ri.created_at ASC, ri.id ASC
  )
  INTO v_items
  FROM public.requisition_items ri
  WHERE ri.requisition_id = p_requisition_id;

  -- ── Step 6: Assemble and return ───────────────────────────────────────────
  v_result := jsonb_build_object(
    'requisition', jsonb_build_object(
      'id',           v_req.id,
      'location',     v_req.location,
      'location_id',  v_req.location_id,
      'requestedby',  v_req.requestedby,
      'date',         v_req.date,
      'status',       v_req.status,
      'notes',        v_req.notes,
      'approved_at',  v_req.approved_at,
      'approved_by',  v_req.approved_by,
      'fulfilled_at', v_req.fulfilled_at,
      'fulfilled_by', v_req.fulfilled_by,
      'created_at',   v_req.created_at
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

-- ── 4. Smoke test query (run manually after deploying) ────────────────────────
-- SELECT public.get_requisition_for_print('REQ-XXXX');
-- Expected: JSON with requisition header + items array (no price fields).
