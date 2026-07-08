-- ============================================================
-- MIGRATION: HQ Invoice System Fix
-- migration_invoice_fix_v2.sql
--
-- ROOT CAUSES FIXED:
--   1. generate_invoices used r.created_at to date-filter requisitions.
--      Must use MAX(ri.fulfilled_at) — the actual fulfillment timestamp.
--   2. Status check used IN ('fulfilled','partial') but finalize_v3
--      writes 'partially_fulfilled'. Now includes all valid fulfilled states.
--   3. Adds requisitions.fulfilled_at safely (guard: add only if absent).
--   4. Adds get_invoice_eligibility_audit() — HQ-admin diagnostic RPC.
--   5. Adds void_invoice() — controlled void with reason logging.
--   6. Adds HST/tax_rate support columns.
--   7. Adds location_name_snapshot to invoices for immutable PDF data.
--
-- SAFE TO RE-RUN: All DDL uses IF NOT EXISTS / DROP IF EXISTS / OR REPLACE.
-- Run in Supabase SQL Editor AFTER deploying new application code.
-- ============================================================

-- ── 0. Ensure pgcrypto is available ───────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Add fulfilled_at / fulfilled_by to requisitions (safe, idempotent) ─────
-- These may already exist if migration_requisition_fulfilled_at.sql was run.
ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS fulfilled_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulfilled_by  TEXT;

-- ── 2. Backfill requisitions.fulfilled_at from MAX(requisition_items.fulfilled_at) ─
-- Only fills rows that are fulfilled/partially_fulfilled and still have NULL fulfilled_at.
UPDATE public.requisitions r
SET fulfilled_at = sub.max_fulfilled_at
FROM (
  SELECT
    ri.requisition_id,
    MAX(ri.fulfilled_at) AS max_fulfilled_at
  FROM public.requisition_items ri
  WHERE ri.fulfilled_at IS NOT NULL
  GROUP BY ri.requisition_id
) sub
WHERE r.id            = sub.requisition_id
  AND sub.max_fulfilled_at IS NOT NULL
  AND r.fulfilled_at  IS NULL
  AND lower(coalesce(r.status, '')) IN (
    'fulfilled', 'partially_fulfilled', 'partial', 'partial_fulfilled',
    'backordered'
  );

-- ── 3. Secondary backfill: fall back to requisition_items.updated_at ──────────
-- For rows still missing fulfilled_at after step 2 (items may lack fulfilled_at).
UPDATE public.requisitions r
SET fulfilled_at = sub.max_updated_at
FROM (
  SELECT
    ri.requisition_id,
    MAX(ri.updated_at) AS max_updated_at
  FROM public.requisition_items ri
  WHERE ri.updated_at IS NOT NULL
    AND coalesce(ri.quantity_fulfilled, 0) > 0
  GROUP BY ri.requisition_id
) sub
WHERE r.id            = sub.requisition_id
  AND sub.max_updated_at IS NOT NULL
  AND r.fulfilled_at  IS NULL
  AND lower(coalesce(r.status, '')) IN (
    'fulfilled', 'partially_fulfilled', 'partial', 'partial_fulfilled',
    'backordered'
  );

-- ── 4. Verify backfill result ──────────────────────────────────────────────────
-- (Informational only — does not block execution)
DO $$
DECLARE
  v_total    INTEGER;
  v_filled   INTEGER;
  v_missing  INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM public.requisitions
  WHERE lower(coalesce(status,'')) IN ('fulfilled','partially_fulfilled','partial');

  SELECT COUNT(*) INTO v_filled
  FROM public.requisitions
  WHERE lower(coalesce(status,'')) IN ('fulfilled','partially_fulfilled','partial')
    AND fulfilled_at IS NOT NULL;

  v_missing := v_total - v_filled;

  RAISE NOTICE 'fulfilled_at backfill: % total fulfilled reqs, % have fulfilled_at, % still NULL',
    v_total, v_filled, v_missing;
END;
$$;

-- ── 5. Add HST / tax columns and location name snapshot to invoices ───────────
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS location_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS tax_rate               NUMERIC NOT NULL DEFAULT 0.13,
  ADD COLUMN IF NOT EXISTS tax_name               TEXT    NOT NULL DEFAULT 'HST',
  ADD COLUMN IF NOT EXISTS void_reason            TEXT,
  ADD COLUMN IF NOT EXISTS voided_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by              UUID;

-- ── 6. Drop and recreate the core generate_invoices RPC ──────────────────────
DROP FUNCTION IF EXISTS public.generate_invoices(TEXT, DATE, TEXT);

CREATE OR REPLACE FUNCTION public.generate_invoices(
  p_billing_frequency TEXT,
  p_period_start      DATE,
  p_location_id       TEXT DEFAULT NULL
)
RETURNS TABLE (
  invoice_id        UUID,
  invoice_number    TEXT,
  location_id       TEXT,
  invoice_month     DATE,
  subtotal          NUMERIC,
  tax_amount        NUMERIC,
  total_amount      NUMERIC,
  requisition_count INTEGER,
  item_count        INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start          DATE;
  v_end_exclusive  DATE;  -- exclusive upper bound for date comparisons
  v_location       TEXT;
  v_location_name  TEXT;
  v_invoice_id     UUID;
  v_invoice_number TEXT;
  v_subtotal       NUMERIC;
  v_tax_rate       NUMERIC := 0.13;  -- HST 13%
  v_tax_amount     NUMERIC;
  v_total          NUMERIC;
  v_req_count      INTEGER;
  v_item_count     INTEGER;
BEGIN
  -- ── Auth ──────────────────────────────────────────────────────────────────
  IF NOT public.is_hq_admin_profile() THEN
    RAISE EXCEPTION 'HQ admin access required';
  END IF;

  IF p_billing_frequency NOT IN ('daily', 'biweekly', 'monthly') THEN
    RAISE EXCEPTION 'Invalid billing frequency: %', p_billing_frequency;
  END IF;

  -- ── Compute billing window ────────────────────────────────────────────────
  -- v_end_exclusive is the first moment OUTSIDE the period (exclusive upper bound).
  IF p_billing_frequency = 'daily' THEN
    v_start         := p_period_start;
    v_end_exclusive := p_period_start + INTERVAL '1 day';
  ELSIF p_billing_frequency = 'biweekly' THEN
    -- Half-month periods: caller sends the period start (1st or 16th of month).
    -- End is determined by what the caller actually passes as p_period_start.
    -- We compute: if start day <= 15 → end = last day of first half (day 15);
    --             if start day >= 16 → end = last day of month.
    IF EXTRACT(DAY FROM p_period_start) <= 15 THEN
      v_start         := date_trunc('month', p_period_start)::date;
      v_end_exclusive := date_trunc('month', p_period_start)::date + INTERVAL '15 days';
    ELSE
      v_start         := date_trunc('month', p_period_start)::date + INTERVAL '15 days';
      v_end_exclusive := (date_trunc('month', p_period_start) + INTERVAL '1 month')::date;
    END IF;
  ELSE
    -- Monthly: always use full calendar month
    v_start         := date_trunc('month', p_period_start)::date;
    v_end_exclusive := (date_trunc('month', p_period_start) + INTERVAL '1 month')::date;
  END IF;

  -- ── Find eligible locations ───────────────────────────────────────────────
  -- KEY FIX: filter by MAX(ri.fulfilled_at) falling in the billing window,
  -- not by r.created_at.  Also added 'partially_fulfilled' to status list.
  FOR v_location IN
    SELECT DISTINCT r.location_id
    FROM public.requisitions r
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    WHERE r.invoice_id IS NULL
      AND r.location_id IS NOT NULL
      AND r.location_id <> 'LOC-HQ'
      AND (p_location_id IS NULL OR r.location_id = p_location_id)
      AND lower(coalesce(r.status, '')) IN (
            'fulfilled', 'partially_fulfilled', 'partial', 'partial_fulfilled'
          )
      AND coalesce(ri.quantity_fulfilled, 0) > 0
    GROUP BY r.location_id, r.id
    HAVING
      -- Use fulfilled_at when available; fall back to requisition_items.updated_at
      GREATEST(
        MAX(ri.fulfilled_at),
        MAX(ri.updated_at)
      ) >= v_start
      AND GREATEST(
        MAX(ri.fulfilled_at),
        MAX(ri.updated_at)
      ) < v_end_exclusive
  LOOP
    -- ── Resolve location display name ───────────────────────────────────────
    SELECT COALESCE(name, v_location)
      INTO v_location_name
      FROM public.locations
     WHERE id = v_location
     LIMIT 1;

    IF v_location_name IS NULL THEN
      v_location_name := v_location;
    END IF;

    -- ── Aggregate subtotal for this location ────────────────────────────────
    SELECT
      ROUND(SUM(COALESCE(ri.quantity_fulfilled, 0) * COALESCE(ri.unit_price, 0))::NUMERIC, 2),
      COUNT(DISTINCT r.id)::INTEGER,
      COUNT(ri.id)::INTEGER
    INTO v_subtotal, v_req_count, v_item_count
    FROM public.requisitions r
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    WHERE r.invoice_id IS NULL
      AND r.location_id = v_location
      AND lower(coalesce(r.status, '')) IN (
            'fulfilled', 'partially_fulfilled', 'partial', 'partial_fulfilled'
          )
      AND COALESCE(ri.quantity_fulfilled, 0) > 0
      AND (
        COALESCE(ri.fulfilled_at, ri.updated_at) >= v_start
        AND COALESCE(ri.fulfilled_at, ri.updated_at) < v_end_exclusive
      );

    IF COALESCE(v_subtotal, 0) <= 0 OR v_req_count = 0 THEN
      CONTINUE;
    END IF;

    -- ── Generate invoice number ──────────────────────────────────────────────
    IF p_billing_frequency = 'daily' THEN
      v_invoice_number :=
        'INV-D-' || to_char(v_start, 'YYYYMMDD') || '-' ||
        REGEXP_REPLACE(v_location, '[^A-Za-z0-9]+', '', 'g');
    ELSIF p_billing_frequency = 'biweekly' THEN
      v_invoice_number :=
        'INV-B-' || to_char(v_start, 'YYYYMMDD') || '-' ||
        REGEXP_REPLACE(v_location, '[^A-Za-z0-9]+', '', 'g');
    ELSE
      v_invoice_number :=
        'INV-' || to_char(v_start, 'YYYYMM') || '-' ||
        REGEXP_REPLACE(v_location, '[^A-Za-z0-9]+', '', 'g');
    END IF;

    -- ── Skip if active invoice already exists for this number ────────────────
    SELECT i.id INTO v_invoice_id
    FROM public.invoices i
    WHERE i.invoice_number = v_invoice_number
      AND i.status <> 'void'
    LIMIT 1;

    IF v_invoice_id IS NOT NULL THEN
      CONTINUE;  -- Already invoiced for this period
    END IF;

    -- ── Calculate HST ────────────────────────────────────────────────────────
    v_tax_amount := ROUND((v_subtotal * v_tax_rate)::NUMERIC, 2);
    v_total      := v_subtotal + v_tax_amount;

    -- ── Insert invoice header ────────────────────────────────────────────────
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
      v_location,
      v_location_name,
      v_start,
      'draft',
      v_subtotal,
      v_tax_rate,
      'HST',
      v_tax_amount,
      v_total,
      NOW(),
      auth.uid(),
      p_billing_frequency,
      v_start,
      (v_end_exclusive - INTERVAL '1 day')::DATE
    )
    RETURNING id INTO v_invoice_id;

    -- ── Insert invoice line item snapshots ───────────────────────────────────
    INSERT INTO public.invoice_items (
      invoice_id,
      requisition_id,
      requisition_item_id,
      item_id,
      item_name,
      quantity,
      unit_price,
      line_total
    )
    SELECT
      v_invoice_id,
      r.id,
      ri.id::TEXT,
      COALESCE(ri.finished_good_id::TEXT, ri.item_id::TEXT),
      COALESCE(ri.item_name_snapshot, ri.finished_good_id::TEXT, ri.item_id::TEXT, 'Unknown item'),
      COALESCE(ri.quantity_fulfilled, 0),
      COALESCE(ri.unit_price, 0),
      ROUND((COALESCE(ri.quantity_fulfilled, 0) * COALESCE(ri.unit_price, 0))::NUMERIC, 2)
    FROM public.requisitions r
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    WHERE r.invoice_id IS NULL
      AND r.location_id = v_location
      AND lower(coalesce(r.status, '')) IN (
            'fulfilled', 'partially_fulfilled', 'partial', 'partial_fulfilled'
          )
      AND COALESCE(ri.quantity_fulfilled, 0) > 0
      AND (
        COALESCE(ri.fulfilled_at, ri.updated_at) >= v_start
        AND COALESCE(ri.fulfilled_at, ri.updated_at) < v_end_exclusive
      );

    -- ── Mark requisitions as invoiced ────────────────────────────────────────
    UPDATE public.requisitions r
    SET invoice_id  = v_invoice_id,
        invoiced_at = NOW()
    WHERE r.invoice_id IS NULL
      AND r.location_id = v_location
      AND lower(coalesce(r.status, '')) IN (
            'fulfilled', 'partially_fulfilled', 'partial', 'partial_fulfilled'
          )
      AND EXISTS (
        SELECT 1
        FROM public.requisition_items ri
        WHERE ri.requisition_id = r.id
          AND COALESCE(ri.quantity_fulfilled, 0) > 0
          AND COALESCE(ri.fulfilled_at, ri.updated_at) >= v_start
          AND COALESCE(ri.fulfilled_at, ri.updated_at) < v_end_exclusive
      );

    -- ── Return summary row ───────────────────────────────────────────────────
    RETURN QUERY
    SELECT
      v_invoice_id,
      v_invoice_number,
      v_location,
      v_start,
      v_subtotal,
      v_tax_amount,
      v_total,
      v_req_count,
      v_item_count;
  END LOOP;
END;
$$;

-- ── 7. Recreate the monthly wrapper ──────────────────────────────────────────
DROP FUNCTION IF EXISTS public.generate_monthly_invoices(DATE, TEXT);

CREATE OR REPLACE FUNCTION public.generate_monthly_invoices(
  p_invoice_month DATE,
  p_location_id   TEXT DEFAULT NULL
)
RETURNS TABLE (
  invoice_id        UUID,
  invoice_number    TEXT,
  location_id       TEXT,
  invoice_month     DATE,
  subtotal          NUMERIC,
  tax_amount        NUMERIC,
  total_amount      NUMERIC,
  requisition_count INTEGER,
  item_count        INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM public.generate_invoices('monthly', p_invoice_month, p_location_id);
END;
$$;

-- ── 8. Eligibility Audit RPC ──────────────────────────────────────────────────
-- Returns a per-requisition eligibility verdict for diagnostics.
-- HQ admin only. No writes.
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
  status              TEXT,
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
      r.id                           AS req_id,
      r.location_id                  AS loc_id,
      COALESCE(l.name, r.location_id) AS loc_name,
      r.date                         AS req_date,
      r.status                       AS req_status,
      r.invoice_id                   AS existing_inv_id,
      -- Best available fulfillment timestamp
      MAX(COALESCE(ri.fulfilled_at, ri.updated_at)) AS best_fulfilled_at,
      CASE
        WHEN MAX(ri.fulfilled_at) IS NOT NULL THEN 'requisition_items.fulfilled_at'
        WHEN MAX(ri.updated_at)  IS NOT NULL
         AND SUM(COALESCE(ri.quantity_fulfilled, 0)) > 0 THEN 'requisition_items.updated_at (fallback)'
        ELSE 'unavailable'
      END                            AS fulfillment_source,
      SUM(COALESCE(ri.quantity_fulfilled, 0))  AS total_fulfilled_qty,
      SUM(
        ROUND((COALESCE(ri.quantity_fulfilled, 0) * COALESCE(ri.unit_price, 0))::NUMERIC, 2)
      )                              AS total_fulfilled_value,
      -- Is any item from a local vendor?
      BOOL_OR(
        lower(COALESCE(ri.source_type, '')) = 'local_vendor'
        AND ri.finished_good_id IS NULL
      )                              AS has_local_vendor_lines,
      -- Any HQ-supplied lines?
      BOOL_OR(
        ri.finished_good_id IS NOT NULL
        OR lower(COALESCE(ri.source_type, '')) IN ('hq_supplied', '')
        OR ri.source_type IS NULL
      )                              AS has_hq_lines
    FROM public.requisitions r
    LEFT JOIN public.requisition_items ri ON ri.requisition_id = r.id
    LEFT JOIN public.locations l ON l.id = r.location_id
    WHERE r.location_id IS NOT NULL
      AND r.location_id <> 'LOC-HQ'
      AND (p_location_id IS NULL OR r.location_id = p_location_id)
      AND lower(coalesce(r.status, '')) NOT IN ('draft', 'cancelled', 'rejected', 'voided', 'void')
    GROUP BY r.id, r.location_id, l.name, r.date, r.status, r.invoice_id
  ),
  invoice_lookup AS (
    SELECT id, invoice_number, status AS inv_status
    FROM public.invoices
    WHERE status <> 'void'
  )
  SELECT
    rs.req_id,
    rs.loc_id,
    rs.loc_name,
    rs.req_date,
    rs.req_status,
    rs.best_fulfilled_at,
    rs.fulfillment_source,
    rs.total_fulfilled_qty,
    rs.total_fulfilled_value,
    il.id::TEXT,
    il.invoice_number,
    il.inv_status,
    -- Compute result and exclusion reason
    CASE
      WHEN lower(COALESCE(rs.req_status, '')) IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled', 'voided', 'void')
        THEN 'Excluded'
      WHEN rs.total_fulfilled_qty <= 0
        THEN 'Excluded'
      WHEN rs.best_fulfilled_at IS NULL
        THEN 'Excluded'
      WHEN rs.best_fulfilled_at < p_period_start::TIMESTAMPTZ
        OR rs.best_fulfilled_at >= v_end_exclusive::TIMESTAMPTZ
        THEN 'Excluded'
      WHEN rs.existing_inv_id IS NOT NULL AND il.id IS NOT NULL
        THEN 'Excluded'
      WHEN rs.total_fulfilled_value <= 0
        THEN 'Excluded'
      ELSE 'Eligible'
    END AS result,
    CASE
      WHEN lower(COALESCE(rs.req_status, '')) IN ('draft')
        THEN 'Status: draft'
      WHEN lower(COALESCE(rs.req_status, '')) IN ('submitted','approved')
        THEN 'Status: not yet fulfilled (' || rs.req_status || ')'
      WHEN lower(COALESCE(rs.req_status, '')) IN ('rejected','cancelled','voided','void')
        THEN 'Status: ' || rs.req_status
      WHEN rs.total_fulfilled_qty <= 0
        THEN 'No fulfilled line quantity > 0'
      WHEN rs.best_fulfilled_at IS NULL
        THEN 'Fulfillment timestamp unavailable'
      WHEN rs.best_fulfilled_at < p_period_start::TIMESTAMPTZ
        THEN 'Fulfillment date before period start (' || rs.best_fulfilled_at::TEXT || ')'
      WHEN rs.best_fulfilled_at >= v_end_exclusive::TIMESTAMPTZ
        THEN 'Fulfillment date after period end (' || rs.best_fulfilled_at::TEXT || ')'
      WHEN rs.existing_inv_id IS NOT NULL AND il.id IS NOT NULL
        THEN 'Already linked to invoice ' || COALESCE(il.invoice_number, rs.existing_inv_id::TEXT)
      WHEN rs.total_fulfilled_value <= 0
        THEN 'No billable line value (unit_price is zero for all fulfilled lines)'
      ELSE NULL
    END AS exclusion_reason
  FROM req_summary rs
  LEFT JOIN invoice_lookup il ON il.id = rs.existing_inv_id
  ORDER BY rs.loc_name, rs.best_fulfilled_at DESC NULLS LAST, rs.req_id;
END;
$$;

-- ── 9. void_invoice RPC — controlled void with reason ─────────────────────────
DROP FUNCTION IF EXISTS public.void_invoice(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.void_invoice(
  p_invoice_id  UUID,
  p_void_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_invoice RECORD;
  v_caller  UUID;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED: not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_hq_admin_profile() THEN
    RAISE EXCEPTION 'FORBIDDEN: HQ admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT id, invoice_number, status, location_id
    INTO v_invoice
    FROM public.invoices
   WHERE id = p_invoice_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT FOUND: invoice % does not exist', p_invoice_id USING ERRCODE = 'P0002';
  END IF;

  IF v_invoice.status = 'void' THEN
    RAISE EXCEPTION 'Invoice % is already voided', v_invoice.invoice_number;
  END IF;

  -- Void the invoice
  UPDATE public.invoices
  SET status      = 'void',
      void_reason = p_void_reason,
      voided_at   = NOW(),
      voided_by   = v_caller,
      updated_at  = NOW()
  WHERE id = p_invoice_id;

  -- Unlink requisitions so they can be re-invoiced later
  UPDATE public.requisitions
  SET invoice_id  = NULL,
      invoiced_at = NULL
  WHERE invoice_id = p_invoice_id;

  RETURN jsonb_build_object(
    'success',        true,
    'invoice_id',     p_invoice_id,
    'invoice_number', v_invoice.invoice_number,
    'voided_at',      NOW()
  );
END;
$$;

-- ── 10. Permissions ────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.generate_invoices(TEXT, DATE, TEXT)              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_monthly_invoices(DATE, TEXT)            FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_invoice_eligibility_audit(TEXT, DATE, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.void_invoice(UUID, TEXT)                         FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.generate_invoices(TEXT, DATE, TEXT)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_monthly_invoices(DATE, TEXT)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_eligibility_audit(TEXT, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_invoice(UUID, TEXT)                         TO authenticated;

-- ── 11. Update RLS policies to cover all HQ roles ─────────────────────────────
-- Add policies for hq_ops, hq_fulfillment etc. who also need invoice read access.
-- is_hq_admin_profile() already covers hq_admin + hq_master (see roles.ts).
-- We extend read access to is_hq_management_profile() which includes hq_ops.

DO $$
BEGIN
  -- Only add expanded policy if is_hq_management_profile exists
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'is_hq_management_profile'
      AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) THEN
    -- Drop narrow read policy and replace with broader HQ management read
    DROP POLICY IF EXISTS "Invoices: HQ Admin Read"         ON public.invoices;
    DROP POLICY IF EXISTS "Invoices: HQ Management Read"    ON public.invoices;
    DROP POLICY IF EXISTS "Invoice Items: HQ Admin Read"    ON public.invoice_items;
    DROP POLICY IF EXISTS "Invoice Items: HQ Management Read" ON public.invoice_items;

    CREATE POLICY "Invoices: HQ Management Read"
      ON public.invoices
      FOR SELECT
      USING (public.is_hq_management_profile());

    CREATE POLICY "Invoice Items: HQ Management Read"
      ON public.invoice_items
      FOR SELECT
      USING (public.is_hq_management_profile());
  END IF;
END;
$$;

-- ── 12. Smoke test — verify the fix ───────────────────────────────────────────
-- Run these manually after deploying:
--
-- Test eligibility audit for June 2026 Monthly, Harbourfront:
-- SELECT * FROM public.get_invoice_eligibility_audit(
--   'monthly',
--   '2026-06-01',
--   '2026-06-30',
--   '<actual-harbourfront-location-id>'
-- );
--
-- Test invoice generation:
-- SELECT * FROM public.generate_invoices('monthly', '2026-06-01', '<harbourfront-location-id>');
--
-- Expected: at least one row returned with June fulfilled requisitions.
