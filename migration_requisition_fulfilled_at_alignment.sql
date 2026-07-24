-- ============================================================================
-- Phase 3: Requisition fulfilled_at revenue-date alignment
-- ============================================================================
-- Business rule:
--   Revenue date  = requisition_items.fulfilled_at
--   Revenue value = COALESCE(
--     requisition_items.fulfilled_value,
--     requisition_items.line_total,
--     requisition_items.quantity_fulfilled * requisition_items.unit_price
--   )
--
-- Safety:
--   This migration only fills missing requisition_items.fulfilled_at values for
--   already-fulfilled lines and replaces Profit Report RPC date filters.
--   It does not modify fulfilled_value, line_total, quantity_fulfilled,
--   unit_price, pack_qty_snapshot, making_cost, inventory, invoices, delivery
--   tickets, production, or requisition totals.

BEGIN;

-- ─── 1. Pre-migration audit, no mutation ─────────────────────────────────────

DO $$
DECLARE
  v_total_lines               BIGINT;
  v_total_revenue             NUMERIC;
  v_with_fulfilled_at_lines   BIGINT;
  v_missing_fulfilled_at_lines BIGINT;
  v_missing_fulfilled_at_revenue NUMERIC;
BEGIN
  SELECT
    COUNT(*)::BIGINT,
    ROUND(COALESCE(SUM(COALESCE(fulfilled_value, line_total, quantity_fulfilled * unit_price)), 0)::NUMERIC, 2),
    COUNT(*) FILTER (WHERE fulfilled_at IS NOT NULL)::BIGINT,
    COUNT(*) FILTER (WHERE fulfilled_at IS NULL)::BIGINT,
    ROUND(COALESCE(SUM(COALESCE(fulfilled_value, line_total, quantity_fulfilled * unit_price)) FILTER (WHERE fulfilled_at IS NULL), 0)::NUMERIC, 2)
  INTO
    v_total_lines,
    v_total_revenue,
    v_with_fulfilled_at_lines,
    v_missing_fulfilled_at_lines,
    v_missing_fulfilled_at_revenue
  FROM public.requisition_items
  WHERE COALESCE(quantity_fulfilled, 0) > 0;

  RAISE NOTICE 'PRE fulfilled lines: %, revenue: %, with fulfilled_at: %, missing fulfilled_at: %, missing revenue: %',
    v_total_lines,
    v_total_revenue,
    v_with_fulfilled_at_lines,
    v_missing_fulfilled_at_lines,
    v_missing_fulfilled_at_revenue;
END $$;

-- Existing fulfilled_at month buckets before fallback backfill.
DO $$
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT
      date_trunc('month', fulfilled_at)::date AS month,
      COUNT(*)::BIGINT AS lines,
      ROUND(COALESCE(SUM(COALESCE(fulfilled_value, line_total, quantity_fulfilled * unit_price)), 0)::NUMERIC, 2) AS revenue
    FROM public.requisition_items
    WHERE COALESCE(quantity_fulfilled, 0) > 0
      AND fulfilled_at IS NOT NULL
    GROUP BY 1
    ORDER BY 1 DESC
  LOOP
    RAISE NOTICE 'PRE month by fulfilled_at: %, lines: %, revenue: %', v_row.month, v_row.lines, v_row.revenue;
  END LOOP;
END $$;

-- Fallback month buckets preview before mutation.
DO $$
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT
      date_trunc('month', COALESCE(ri.fulfilled_at, r.fulfilled_at, ri.updated_at, r.updated_at, ri.created_at, r.created_at))::date AS month,
      COUNT(*)::BIGINT AS lines,
      ROUND(COALESCE(SUM(COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price)), 0)::NUMERIC, 2) AS revenue
    FROM public.requisition_items ri
    LEFT JOIN public.requisitions r ON r.id = ri.requisition_id
    WHERE COALESCE(ri.quantity_fulfilled, 0) > 0
    GROUP BY 1
    ORDER BY 1 DESC
  LOOP
    RAISE NOTICE 'PRE month by fallback date: %, lines: %, revenue: %', v_row.month, v_row.lines, v_row.revenue;
  END LOOP;
END $$;

-- ─── 2. Safe schema alignment and backfill ───────────────────────────────────

ALTER TABLE public.requisition_items
  ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.requisition_items'::regclass
      AND tgname = 'requisition_items_set_updated_at'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.requisition_items DISABLE TRIGGER requisition_items_set_updated_at;
  END IF;
END $$;

UPDATE public.requisition_items ri
SET fulfilled_at = COALESCE(
  ri.fulfilled_at,
  r.fulfilled_at,
  ri.updated_at,
  r.updated_at,
  ri.created_at,
  r.created_at
)
FROM public.requisitions r
WHERE r.id = ri.requisition_id
  AND COALESCE(ri.quantity_fulfilled, 0) > 0
  AND ri.fulfilled_at IS NULL
  AND COALESCE(r.fulfilled_at, ri.updated_at, r.updated_at, ri.created_at, r.created_at) IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.requisition_items'::regclass
      AND tgname = 'requisition_items_set_updated_at'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.requisition_items ENABLE TRIGGER requisition_items_set_updated_at;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_requisition_items_fulfilled_at
ON public.requisition_items (fulfilled_at);

CREATE INDEX IF NOT EXISTS idx_requisition_items_fulfilled_at_fg
ON public.requisition_items (fulfilled_at, finished_good_id)
WHERE quantity_fulfilled > 0;

-- ─── 3. Profit Report RPCs now use fulfilled_at as revenue date ───────────────

CREATE OR REPLACE FUNCTION public.get_fulfillment_profit_report(
  p_location_id TEXT DEFAULT NULL,
  p_date_from   TEXT DEFAULT NULL,
  p_date_to     TEXT DEFAULT NULL
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
  v_caller_role           TEXT;
  v_caller_location_id    TEXT;
  v_effective_location_id TEXT;
BEGIN
  SELECT up.role, up.location_id INTO v_caller_role, v_caller_location_id
  FROM public.user_profiles up
  WHERE up.user_id = auth.uid() AND up.is_active = true;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Access Denied: User profile not found or inactive.';
  END IF;

  IF v_caller_role = 'hq_admin' THEN
    v_effective_location_id := NULLIF(p_location_id, '');
  ELSIF v_caller_role = 'location_manager' THEN
    IF v_caller_location_id IS NULL THEN
      RAISE EXCEPTION 'Access Denied: No location assigned to this user profile.';
    END IF;

    IF NULLIF(p_location_id, '') IS NOT NULL AND NULLIF(p_location_id, '') <> v_caller_location_id THEN
      RAISE EXCEPTION 'Access Denied: You are not authorized to view reports for other locations.';
    END IF;

    v_effective_location_id := v_caller_location_id;
  ELSE
    RAISE EXCEPTION 'Access Denied: Unrecognized role %.', v_caller_role;
  END IF;

  RETURN QUERY
  SELECT
    TO_CHAR(ri.fulfilled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS movement_date,
    req.location_id,
    COALESCE(l.name, req.location_id) AS location_name,
    hq.name AS item_name,
    ri.quantity_fulfilled AS qty,
    ri.unit_price,
    COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price) AS revenue,
    hq.making_cost,
    COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1) AS pack_qty,
    ri.quantity_fulfilled
      * COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)
      * COALESCE(hq.making_cost, 0) AS cogs,
    COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price)
      - (
          ri.quantity_fulfilled
          * COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)
          * COALESCE(hq.making_cost, 0)
        ) AS profit,
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
          NULLIF(COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price), 0)
        ) * 100,
        2
      )
    END AS margin_pct
  FROM public.requisition_items ri
  INNER JOIN public.requisitions req ON req.id = ri.requisition_id
  LEFT JOIN public.locations l ON l.id = req.location_id
  INNER JOIN public.hq_sale_items hq ON hq.id = ri.finished_good_id
  WHERE
    ri.quantity_fulfilled > 0
    AND ri.unit_price IS NOT NULL
    AND ri.finished_good_id IS NOT NULL
    AND ri.fulfilled_at IS NOT NULL
    AND (p_date_from IS NULL OR ri.fulfilled_at >= p_date_from::DATE)
    AND (p_date_to IS NULL OR ri.fulfilled_at < p_date_to::DATE + INTERVAL '1 day')
    AND (v_effective_location_id IS NULL OR req.location_id = v_effective_location_id)
  ORDER BY
    ri.fulfilled_at DESC,
    req.location_id,
    hq.name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_fulfillment_profit_report(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_fulfillment_profit_report(TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_fulfillment_profit_report(TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_fulfillment_profit_report_summary(
  p_location_id TEXT DEFAULT NULL,
  p_date_from   TEXT DEFAULT NULL,
  p_date_to     TEXT DEFAULT NULL
)
RETURNS TABLE (
  total_lines   BIGINT,
  total_revenue NUMERIC,
  total_cogs    NUMERIC,
  gross_profit  NUMERIC,
  avg_margin    NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
#variable_conflict use_column
DECLARE
  v_caller_role           TEXT;
  v_caller_location_id    TEXT;
  v_effective_location_id TEXT;
BEGIN
  SELECT up.role, up.location_id INTO v_caller_role, v_caller_location_id
  FROM public.user_profiles up
  WHERE up.user_id = auth.uid() AND up.is_active = true;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Access Denied: User profile not found or inactive.';
  END IF;

  IF v_caller_role = 'hq_admin' THEN
    v_effective_location_id := NULLIF(p_location_id, '');
  ELSIF v_caller_role = 'location_manager' THEN
    IF v_caller_location_id IS NULL THEN
      RAISE EXCEPTION 'Access Denied: No location assigned to this user profile.';
    END IF;

    IF NULLIF(p_location_id, '') IS NOT NULL AND NULLIF(p_location_id, '') <> v_caller_location_id THEN
      RAISE EXCEPTION 'Access Denied: You are not authorized to view reports for other locations.';
    END IF;

    v_effective_location_id := v_caller_location_id;
  ELSE
    RAISE EXCEPTION 'Access Denied: Unrecognized role %.', v_caller_role;
  END IF;

  RETURN QUERY
  WITH eligible AS (
    SELECT
      COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price) AS revenue,
      ri.quantity_fulfilled
        * COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)
        * COALESCE(hq.making_cost, 0) AS cogs
    FROM public.requisition_items ri
    INNER JOIN public.requisitions req ON req.id = ri.requisition_id
    INNER JOIN public.hq_sale_items hq ON hq.id = ri.finished_good_id
    WHERE
      ri.quantity_fulfilled > 0
      AND ri.unit_price IS NOT NULL
      AND ri.finished_good_id IS NOT NULL
      AND ri.fulfilled_at IS NOT NULL
      AND (p_date_from IS NULL OR ri.fulfilled_at >= p_date_from::DATE)
      AND (p_date_to IS NULL OR ri.fulfilled_at < p_date_to::DATE + INTERVAL '1 day')
      AND (v_effective_location_id IS NULL OR req.location_id = v_effective_location_id)
  ),
  totals AS (
    SELECT
      COUNT(*)::BIGINT AS total_lines,
      COALESCE(SUM(revenue), 0)::NUMERIC AS total_revenue,
      COALESCE(SUM(cogs), 0)::NUMERIC AS total_cogs,
      COALESCE(SUM(revenue - cogs), 0)::NUMERIC AS gross_profit
    FROM eligible
  )
  SELECT
    totals.total_lines,
    totals.total_revenue,
    totals.total_cogs,
    totals.gross_profit,
    CASE
      WHEN totals.total_revenue > 0
        THEN ROUND((totals.gross_profit / totals.total_revenue) * 100, 2)
      ELSE NULL
    END AS avg_margin
  FROM totals;
END;
$$;

REVOKE ALL ON FUNCTION public.get_fulfillment_profit_report_summary(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_fulfillment_profit_report_summary(TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_fulfillment_profit_report_summary(TEXT, TEXT, TEXT) TO authenticated;

-- ─── 4. Post-migration audit ─────────────────────────────────────────────────

DO $$
DECLARE
  v_total_lines BIGINT;
  v_total_revenue NUMERIC;
  v_missing_fulfilled_at_lines BIGINT;
  v_missing_fulfilled_at_revenue NUMERIC;
BEGIN
  SELECT
    COUNT(*)::BIGINT,
    ROUND(COALESCE(SUM(COALESCE(fulfilled_value, line_total, quantity_fulfilled * unit_price)), 0)::NUMERIC, 2),
    COUNT(*) FILTER (WHERE fulfilled_at IS NULL)::BIGINT,
    ROUND(COALESCE(SUM(COALESCE(fulfilled_value, line_total, quantity_fulfilled * unit_price)) FILTER (WHERE fulfilled_at IS NULL), 0)::NUMERIC, 2)
  INTO
    v_total_lines,
    v_total_revenue,
    v_missing_fulfilled_at_lines,
    v_missing_fulfilled_at_revenue
  FROM public.requisition_items
  WHERE COALESCE(quantity_fulfilled, 0) > 0;

  RAISE NOTICE 'POST fulfilled lines: %, revenue: %, missing fulfilled_at: %, missing revenue: %',
    v_total_lines,
    v_total_revenue,
    v_missing_fulfilled_at_lines,
    v_missing_fulfilled_at_revenue;
END $$;

DO $$
DECLARE
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT
      date_trunc('month', fulfilled_at)::date AS month,
      COUNT(*)::BIGINT AS lines,
      ROUND(COALESCE(SUM(COALESCE(fulfilled_value, line_total, quantity_fulfilled * unit_price)), 0)::NUMERIC, 2) AS revenue
    FROM public.requisition_items
    WHERE COALESCE(quantity_fulfilled, 0) > 0
      AND fulfilled_at IS NOT NULL
    GROUP BY 1
    ORDER BY 1 DESC
  LOOP
    RAISE NOTICE 'POST month by fulfilled_at: %, lines: %, revenue: %', v_row.month, v_row.lines, v_row.revenue;
  END LOOP;
END $$;

COMMIT;

-- Manual validation queries:
--
-- A. Profit Report revenue by fulfilled_at:
-- SELECT
--   COUNT(*) AS lines,
--   SUM(COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price)) AS revenue
-- FROM public.requisition_items ri
-- WHERE ri.quantity_fulfilled > 0
--   AND ri.unit_price IS NOT NULL
--   AND ri.finished_good_id IS NOT NULL
--   AND ri.fulfilled_at >= DATE '2026-07-01'
--   AND ri.fulfilled_at < DATE '2026-07-20';
--
-- B. Missing fulfilled_at after backfill:
-- SELECT COUNT(*)
-- FROM public.requisition_items
-- WHERE quantity_fulfilled > 0
--   AND fulfilled_at IS NULL;
--
-- C. Rows with fulfilled_value missing:
-- SELECT COUNT(*)
-- FROM public.requisition_items
-- WHERE quantity_fulfilled > 0
--   AND fulfilled_value IS NULL;
--
-- D. Monthly revenue by fulfilled_at:
-- SELECT
--   DATE_TRUNC('month', fulfilled_at)::date AS month,
--   COUNT(*) AS lines,
--   ROUND(SUM(COALESCE(fulfilled_value, line_total, quantity_fulfilled * unit_price))::numeric, 2) AS revenue
-- FROM public.requisition_items
-- WHERE quantity_fulfilled > 0
--   AND fulfilled_at IS NOT NULL
-- GROUP BY 1
-- ORDER BY 1 DESC;
