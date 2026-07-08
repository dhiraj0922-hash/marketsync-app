-- ============================================================
-- PATCH: Fix "column reference status is ambiguous" in
--        get_invoice_eligibility_audit
--
-- Root cause:
--   RETURNS TABLE had a column named "status TEXT".
--   Inside the function body, the invoice_lookup CTE used bare
--   "status" (without table alias) in both SELECT and WHERE clauses.
--   PostgreSQL could not resolve whether "status" meant:
--     - the RETURNS TABLE output variable "status", OR
--     - the "invoices.status" column.
--   This caused: ERROR: column reference "status" is ambiguous.
--
-- Fix applied:
--   1. Renamed RETURNS TABLE output column: status → header_status
--   2. Fully qualified every "status" reference inside the function
--      using explicit table aliases (i.status, r.status, il.inv_status)
--   3. No logic changes. No writes. Auth unchanged.
--
-- Safe to re-run. Run AFTER migration_invoice_fix_v2.sql.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_invoice_eligibility_audit(TEXT, DATE, DATE, TEXT);

CREATE OR REPLACE FUNCTION public.get_invoice_eligibility_audit(
  p_billing_frequency TEXT,
  p_period_start      DATE,
  p_period_end        DATE,
  p_location_id       TEXT DEFAULT NULL
)
RETURNS TABLE (
  requisition_id      TEXT,
  location_id         TEXT,
  location_name       TEXT,
  request_date        TEXT,
  header_status       TEXT,   -- renamed from "status" to avoid ambiguity with invoices.status
  fulfillment_date    TIMESTAMPTZ,
  fulfillment_source  TEXT,
  fulfilled_qty       NUMERIC,
  fulfilled_value     NUMERIC,
  existing_invoice_id TEXT,
  existing_invoice_no TEXT,
  existing_inv_status TEXT,
  result              TEXT,
  exclusion_reason    TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_end_exclusive DATE;
BEGIN
  IF NOT public.is_hq_admin_profile() THEN
    RAISE EXCEPTION 'HQ admin access required';
  END IF;

  -- Exclusive upper bound = period_end + 1 day
  v_end_exclusive := p_period_end + INTERVAL '1 day';

  RETURN QUERY
  WITH req_summary AS (
    SELECT
      r.id                            AS req_id,
      r.location_id                   AS loc_id,
      COALESCE(l.name, r.location_id) AS loc_name,
      r.date                          AS req_date,
      r.status                        AS req_status,   -- qualified: r.status
      r.invoice_id                    AS existing_inv_id,
      MAX(COALESCE(ri.fulfilled_at, ri.updated_at)) AS best_fulfilled_at,
      CASE
        WHEN MAX(ri.fulfilled_at) IS NOT NULL
          THEN 'requisition_items.fulfilled_at'
        WHEN MAX(ri.updated_at) IS NOT NULL
         AND SUM(COALESCE(ri.quantity_fulfilled, 0)) > 0
          THEN 'requisition_items.updated_at (fallback)'
        ELSE 'unavailable'
      END                             AS fulfillment_source,
      SUM(COALESCE(ri.quantity_fulfilled, 0)) AS total_fulfilled_qty,
      SUM(
        ROUND((COALESCE(ri.quantity_fulfilled, 0) * COALESCE(ri.unit_price, 0))::NUMERIC, 2)
      )                               AS total_fulfilled_value,
      BOOL_OR(
        lower(COALESCE(ri.source_type, '')) = 'local_vendor'
        AND ri.finished_good_id IS NULL
      )                               AS has_local_vendor_lines,
      BOOL_OR(
        ri.finished_good_id IS NOT NULL
        OR lower(COALESCE(ri.source_type, '')) IN ('hq_supplied', '')
        OR ri.source_type IS NULL
      )                               AS has_hq_lines
    FROM public.requisitions r
    LEFT JOIN public.requisition_items ri ON ri.requisition_id = r.id
    LEFT JOIN public.locations l ON l.id = r.location_id
    WHERE r.location_id IS NOT NULL
      AND r.location_id <> 'LOC-HQ'
      AND (p_location_id IS NULL OR r.location_id = p_location_id)
      -- Qualified: r.status (not bare "status")
      AND lower(coalesce(r.status, '')) NOT IN ('draft', 'cancelled', 'rejected', 'voided', 'void')
    GROUP BY r.id, r.location_id, l.name, r.date, r.status, r.invoice_id
  ),
  invoice_lookup AS (
    -- Fully qualified: i.status — avoids collision with RETURNS TABLE "header_status"
    SELECT
      i.id             AS inv_id,
      i.invoice_number AS inv_number,
      i.status         AS inv_status   -- qualified: i.status
    FROM public.invoices i
    WHERE i.status <> 'void'           -- qualified: i.status
  )
  SELECT
    rs.req_id,
    rs.loc_id,
    rs.loc_name,
    rs.req_date,
    rs.req_status,         -- maps to RETURNS TABLE: header_status
    rs.best_fulfilled_at,
    rs.fulfillment_source,
    rs.total_fulfilled_qty,
    rs.total_fulfilled_value,
    il.inv_id::TEXT,
    il.inv_number,
    il.inv_status,
    -- Result verdict
    CASE
      WHEN lower(COALESCE(rs.req_status, '')) IN (
             'draft', 'submitted', 'approved', 'rejected', 'cancelled', 'voided', 'void'
           )
        THEN 'Excluded'
      WHEN COALESCE(rs.total_fulfilled_qty, 0) <= 0
        THEN 'Excluded'
      WHEN rs.best_fulfilled_at IS NULL
        THEN 'Excluded'
      WHEN rs.best_fulfilled_at < p_period_start::TIMESTAMPTZ
        OR  rs.best_fulfilled_at >= v_end_exclusive::TIMESTAMPTZ
        THEN 'Excluded'
      WHEN rs.existing_inv_id IS NOT NULL AND il.inv_id IS NOT NULL
        THEN 'Excluded'
      WHEN COALESCE(rs.total_fulfilled_value, 0) <= 0
        THEN 'Excluded'
      ELSE 'Eligible'
    END AS result,
    -- Exclusion reason (NULL if eligible)
    CASE
      WHEN lower(COALESCE(rs.req_status, '')) = 'draft'
        THEN 'Status: draft'
      WHEN lower(COALESCE(rs.req_status, '')) IN ('submitted', 'approved')
        THEN 'Status: not yet fulfilled (' || rs.req_status || ')'
      WHEN lower(COALESCE(rs.req_status, '')) IN ('rejected', 'cancelled', 'voided', 'void')
        THEN 'Status: ' || rs.req_status
      WHEN COALESCE(rs.total_fulfilled_qty, 0) <= 0
        THEN 'No fulfilled line quantity > 0'
      WHEN rs.best_fulfilled_at IS NULL
        THEN 'Fulfillment timestamp unavailable'
      WHEN rs.best_fulfilled_at < p_period_start::TIMESTAMPTZ
        THEN 'Fulfillment date before period start (' || rs.best_fulfilled_at::TEXT || ')'
      WHEN rs.best_fulfilled_at >= v_end_exclusive::TIMESTAMPTZ
        THEN 'Fulfillment date after period end (' || rs.best_fulfilled_at::TEXT || ')'
      WHEN rs.existing_inv_id IS NOT NULL AND il.inv_id IS NOT NULL
        THEN 'Already linked to invoice ' || COALESCE(il.inv_number, rs.existing_inv_id::TEXT)
      WHEN COALESCE(rs.total_fulfilled_value, 0) <= 0
        THEN 'No billable line value (unit_price is zero for all fulfilled lines)'
      ELSE NULL
    END AS exclusion_reason
  FROM req_summary rs
  LEFT JOIN invoice_lookup il ON il.inv_id = rs.existing_inv_id
  ORDER BY rs.loc_name, rs.best_fulfilled_at DESC NULLS LAST, rs.req_id;
END;
$$;

-- Permissions
REVOKE ALL  ON FUNCTION public.get_invoice_eligibility_audit(TEXT, DATE, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invoice_eligibility_audit(TEXT, DATE, DATE, TEXT) TO authenticated;

-- ── Smoke test (run manually after deploying) ─────────────────────────────────
-- Replace with real Harbourfront location_id:
-- SELECT *
-- FROM public.get_invoice_eligibility_audit(
--   'monthly',
--   '2026-06-01'::DATE,
--   '2026-06-30'::DATE,
--   null   -- or specific location_id
-- )
-- ORDER BY result, requisition_id;
