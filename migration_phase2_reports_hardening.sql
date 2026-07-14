-- =================================================================================
-- MIGRATION: Phase 2 Reports RPC Backend Security Hardening (Pitched & Resolving Ambiguity)
--
-- This migration updates Stock Dharma's reporting functions to perform session-level
-- role and location scoping using auth.uid() and public.user_profiles.
--
-- Fixes "column reference location_id is ambiguous" by:
--  1. Adding `#variable_conflict use_column` to direct compiler resolution.
--  2. Fully qualifying all column selections and lookups (e.g. up.location_id).
--  3. Avoiding variable names that shadow or collide with returned TABLE columns.
--
-- Key Rules Enforced:
--  1. hq_admin: Can view all locations (p_location_id IS NULL or '') or any specific location.
--  2. location_manager:
--     - Forced strictly to their assigned user_profiles.location_id.
--     - If they pass NULL or '', their target location is silently forced to their location.
--     - If they try to request another location_id, an 'Access Denied' exception is raised.
--  3. Inactive/Unauthorized/No profile users: Query is cancelled with an 'Access Denied' exception.
--
-- Safe to execute multiple times (recreates functions using idempotent statements).
-- =================================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: get_cogs_report Hardening
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_cogs_report(
  p_location_id TEXT,       -- nullable: NULL or '' -> all locations (HQ only)
  p_date_from   TEXT,       -- ISO date "YYYY-MM-DD"
  p_date_to     TEXT        -- ISO date "YYYY-MM-DD" (inclusive)
)
RETURNS TABLE (
  movement_date  TEXT,
  location_id    TEXT,
  item_id        TEXT,
  item_name      TEXT,
  total_qty      NUMERIC,
  cogs_value     NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
#variable_conflict use_column
DECLARE
  v_caller_role            TEXT;
  v_caller_location_id     TEXT;
  v_effective_location_id  TEXT;
BEGIN
  -- 1. Identify the authenticated user with fully qualified columns
  SELECT up.role, up.location_id INTO v_caller_role, v_caller_location_id
  FROM public.user_profiles up
  WHERE up.user_id = auth.uid() AND up.is_active = true;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Access Denied: User profile not found or inactive.';
  END IF;

  -- 2. Scoping validation
  IF v_caller_role = 'hq_admin' THEN
    v_effective_location_id := NULLIF(p_location_id, '');
  ELSIF v_caller_role = 'location_manager' THEN
    IF v_caller_location_id IS NULL THEN
      RAISE EXCEPTION 'Access Denied: No location assigned to this user profile.';
    END IF;
    
    -- Check if trying to view another location or all locations
    IF NULLIF(p_location_id, '') IS NOT NULL AND NULLIF(p_location_id, '') <> v_caller_location_id THEN
      RAISE EXCEPTION 'Access Denied: You are not authorized to view reports for other locations.';
    END IF;
    
    v_effective_location_id := v_caller_location_id;
  ELSE
    RAISE EXCEPTION 'Access Denied: Unrecognized role %.', v_caller_role;
  END IF;

  -- 3. Return report query
  RETURN QUERY
  SELECT
    TO_CHAR(im.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS movement_date,
    im.location_id,
    im.item_id,
    COALESCE(ii.name, im.item_id)                            AS item_name,
    SUM(im.quantity)                                         AS total_qty,
    SUM(im.total_cost)                                       AS cogs_value
  FROM public.inventory_movements im
  LEFT JOIN public.inventory_items ii
         ON ii.item_id = im.item_id
         OR ii.id::TEXT = im.item_id
  WHERE
    im.movement_type IN (
      'production_consumption',   -- ingredients consumed in production runs
      'transfer_out',             -- stock sent from HQ to a store
      'adjustment_out'            -- manual write-offs / waste
    )
    AND im.created_at >= p_date_from::DATE
    AND im.created_at <  p_date_to::DATE + INTERVAL '1 day'
    AND (v_effective_location_id IS NULL OR im.location_id = v_effective_location_id)
  GROUP BY
    TO_CHAR(im.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
    im.location_id,
    im.item_id,
    COALESCE(ii.name, im.item_id)
  ORDER BY
    movement_date DESC,
    im.location_id,
    item_name;
END;
$$;

REVOKE ALL     ON FUNCTION public.get_cogs_report(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_cogs_report(TEXT, TEXT, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: get_inventory_movement_report Hardening
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_inventory_movement_report(
  p_location_id TEXT,         -- nullable: NULL or '' -> all locations (HQ only)
  p_item_id     TEXT,         -- nullable: NULL -> all items
  p_date_from   TEXT,         -- ISO-8601 timestamp "YYYY-MM-DDTHH:MM:SSZ"
  p_date_to     TEXT,         -- ISO-8601 timestamp "YYYY-MM-DDTHH:MM:SSZ" (inclusive)
  p_bucket      TEXT          -- nullable: NULL -> all buckets; else filter by report_bucket
)
RETURNS TABLE (
  id             BIGINT,
  created_at     TIMESTAMPTZ,
  movement_date  TEXT,
  location_id    TEXT,
  item_id        TEXT,
  item_name      TEXT,
  movement_type  TEXT,
  report_bucket  TEXT,
  quantity       NUMERIC,
  unit_cost      NUMERIC,
  total_cost     NUMERIC,
  signed_cost    NUMERIC,
  reference_type TEXT,
  reference_id   TEXT,
  notes          TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
#variable_conflict use_column
DECLARE
  v_caller_role            TEXT;
  v_caller_location_id     TEXT;
  v_effective_location_id  TEXT;
BEGIN
  -- 1. Identify the authenticated user with fully qualified columns
  SELECT up.role, up.location_id INTO v_caller_role, v_caller_location_id
  FROM public.user_profiles up
  WHERE up.user_id = auth.uid() AND up.is_active = true;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Access Denied: User profile not found or inactive.';
  END IF;

  -- 2. Scoping validation
  IF v_caller_role = 'hq_admin' THEN
    v_effective_location_id := NULLIF(p_location_id, '');
  ELSIF v_caller_role = 'location_manager' THEN
    IF v_caller_location_id IS NULL THEN
      RAISE EXCEPTION 'Access Denied: No location assigned to this user profile.';
    END IF;
    
    -- Check if trying to view another location or all locations
    IF NULLIF(p_location_id, '') IS NOT NULL AND NULLIF(p_location_id, '') <> v_caller_location_id THEN
      RAISE EXCEPTION 'Access Denied: You are not authorized to view reports for other locations.';
    END IF;
    
    v_effective_location_id := v_caller_location_id;
  ELSE
    RAISE EXCEPTION 'Access Denied: Unrecognized role %.', v_caller_role;
  END IF;

  -- 3. Return movement query
  RETURN QUERY
  WITH enriched AS (
    SELECT
      im.id,
      im.created_at,
      TO_CHAR(im.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')  AS movement_date,
      im.location_id,
      im.item_id,
      COALESCE(ii.name, im.item_id)                             AS item_name,
      im.movement_type,
      CASE im.movement_type
        WHEN 'purchase_in'            THEN 'purchase_in'
        WHEN 'production_in'          THEN 'production_in'
        WHEN 'transfer_in'            THEN 'transfer_in'
        WHEN 'transfer_out'           THEN 'transfer_out'
        WHEN 'adjustment_in'          THEN 'adjustment_in'
        WHEN 'adjustment_out'         THEN 'adjustment_out'
        WHEN 'production_consumption' THEN 'cogs'
        WHEN 'count_variance_gain'    THEN 'variance_gain'
        WHEN 'count_variance_loss'    THEN 'variance_loss'
        WHEN 'return_out'             THEN 'return_out'
        ELSE                               'other'
      END                                                        AS report_bucket,
      im.quantity,
      COALESCE(im.unit_cost,  0)                                 AS unit_cost,
      ABS(COALESCE(im.total_cost, 0))                            AS total_cost,
      CASE im.movement_type
        WHEN 'purchase_in'            THEN  ABS(COALESCE(im.total_cost, 0))
        WHEN 'production_in'          THEN  ABS(COALESCE(im.total_cost, 0))
        WHEN 'transfer_in'            THEN  ABS(COALESCE(im.total_cost, 0))
        WHEN 'adjustment_in'          THEN  ABS(COALESCE(im.total_cost, 0))
        WHEN 'count_variance_gain'    THEN  ABS(COALESCE(im.total_cost, 0))
        WHEN 'transfer_out'           THEN -ABS(COALESCE(im.total_cost, 0))
        WHEN 'adjustment_out'         THEN -ABS(COALESCE(im.total_cost, 0))
        WHEN 'production_consumption' THEN -ABS(COALESCE(im.total_cost, 0))
        WHEN 'count_variance_loss'    THEN -ABS(COALESCE(im.total_cost, 0))
        WHEN 'return_out'             THEN -ABS(COALESCE(im.total_cost, 0))
        ELSE                              -ABS(COALESCE(im.total_cost, 0))
      END                                                        AS signed_cost,
      im.reference_type,
      im.reference_id,
      im.notes
    FROM public.inventory_movements im
    LEFT JOIN public.inventory_items ii
           ON ii.item_id = im.item_id
           OR ii.id::TEXT = im.item_id
    WHERE
      im.created_at >= p_date_from::TIMESTAMPTZ
      AND im.created_at <= p_date_to::TIMESTAMPTZ
      AND (v_effective_location_id IS NULL OR im.location_id = v_effective_location_id)
      AND (p_item_id IS NULL OR im.item_id = p_item_id)
  )
  SELECT
    e.id,
    e.created_at,
    e.movement_date,
    e.location_id,
    e.item_id,
    e.item_name,
    e.movement_type,
    e.report_bucket,
    e.quantity,
    e.unit_cost,
    e.total_cost,
    e.signed_cost,
    e.reference_type,
    e.reference_id,
    e.notes
  FROM enriched e
  WHERE
    p_bucket IS NULL OR e.report_bucket = p_bucket
  ORDER BY
    e.created_at DESC,
    e.location_id,
    e.item_name;
END;
$$;

REVOKE ALL     ON FUNCTION public.get_inventory_movement_report(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_inventory_movement_report(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: get_fulfillment_profit_report Hardening
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_fulfillment_profit_report(
  p_location_id TEXT DEFAULT NULL,   -- nullable: NULL or '' -> all locations (HQ only)
  p_date_from   TEXT DEFAULT NULL,   -- ISO date "YYYY-MM-DD" (inclusive lower bound)
  p_date_to     TEXT DEFAULT NULL    -- ISO date "YYYY-MM-DD" (inclusive upper bound)
)
RETURNS TABLE (
  movement_date TEXT,
  location_id   TEXT,
  location_name TEXT,
  item_name     TEXT,
  qty           NUMERIC,
  unit_price    NUMERIC,
  revenue       NUMERIC,
  making_cost   NUMERIC,
  pack_qty      NUMERIC,
  cogs          NUMERIC,
  profit        NUMERIC,
  margin_pct    NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
#variable_conflict use_column
DECLARE
  v_caller_role            TEXT;
  v_caller_location_id     TEXT;
  v_effective_location_id  TEXT;
BEGIN
  -- 1. Identify the authenticated user with fully qualified columns
  SELECT up.role, up.location_id INTO v_caller_role, v_caller_location_id
  FROM public.user_profiles up
  WHERE up.user_id = auth.uid() AND up.is_active = true;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Access Denied: User profile not found or inactive.';
  END IF;

  -- 2. Scoping validation
  IF v_caller_role = 'hq_admin' THEN
    v_effective_location_id := NULLIF(p_location_id, '');
  ELSIF v_caller_role = 'location_manager' THEN
    IF v_caller_location_id IS NULL THEN
      RAISE EXCEPTION 'Access Denied: No location assigned to this user profile.';
    END IF;
    
    -- Check if trying to view another location or all locations
    IF NULLIF(p_location_id, '') IS NOT NULL AND NULLIF(p_location_id, '') <> v_caller_location_id THEN
      RAISE EXCEPTION 'Access Denied: You are not authorized to view reports for other locations.';
    END IF;
    
    v_effective_location_id := v_caller_location_id;
  ELSE
    RAISE EXCEPTION 'Access Denied: Unrecognized role %.', v_caller_role;
  END IF;

  -- 3. Return profit query
  RETURN QUERY
  SELECT
    TO_CHAR(ri.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')  AS movement_date,
    req.location_id,
    COALESCE(l.name, req.location_id)                         AS location_name,
    hq.name                                                    AS item_name,
    ri.quantity_fulfilled                                      AS qty,
    ri.unit_price,
    COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price) AS revenue,
    hq.making_cost,
    COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)                AS pack_qty,
    ri.quantity_fulfilled
      * COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)
      * COALESCE(hq.making_cost, 0)                            AS cogs,
    COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price)
      - (
          ri.quantity_fulfilled
          * COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)
          * COALESCE(hq.making_cost, 0)
        )                                                       AS profit,
    CASE
      WHEN COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price) = 0
        THEN NULL
      ELSE ROUND(
        (
          (
            COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price)
            - (
                ri.quantity_fulfilled
                * COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)
                * COALESCE(hq.making_cost, 0)
              )
          )
          /
          NULLIF(
            COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price),
            0
          )
        ) * 100,
        2
      )
    END                                                         AS margin_pct
  FROM public.requisition_items ri
  INNER JOIN public.requisitions req
          ON req.id = ri.requisition_id
  LEFT JOIN public.locations l
         ON l.id = req.location_id
  INNER JOIN public.hq_sale_items hq
          ON hq.id = ri.finished_good_id
  WHERE
    ri.quantity_fulfilled  > 0
    AND ri.unit_price      IS NOT NULL
    AND ri.finished_good_id IS NOT NULL
    AND (p_date_from IS NULL OR ri.created_at >= p_date_from::DATE)
    AND (p_date_to   IS NULL OR ri.created_at <  p_date_to::DATE + INTERVAL '1 day')
    AND (v_effective_location_id IS NULL OR req.location_id = v_effective_location_id)
  ORDER BY
    ri.created_at DESC,
    req.location_id,
    hq.name;
END;
$$;

REVOKE ALL     ON FUNCTION public.get_fulfillment_profit_report(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_fulfillment_profit_report(TEXT, TEXT, TEXT) TO authenticated;
