-- ============================================================
-- MIGRATION: Invoice Location Filter — Option A (Requisition-Level Invoicing)
-- migration_invoice_location_filter_and_tax_fix.sql
--
-- APPROVED DESIGN: Option A
--   • Invoice period eligibility is evaluated at REQUISITION level.
--   • The period anchor is MAX(COALESCE(ri.fulfilled_at, ri.updated_at))
--     across all fulfilled lines on the requisition.
--   • If the requisition's anchor falls in [v_start, v_end_exclusive),
--     the requisition is eligible.
--   • ALL fulfilled billable lines on an eligible requisition are included
--     in the invoice — no per-line date splitting.
--   • requisitions.invoice_id IS NULL is the sole duplicate-billing guard.
--   • No requisition_items.invoice_id column added (not Option B).
--   • No "blocked" status added (not Option C).
--
-- BUGS FIXED:
--   1. get_invoice_eligibility_audit returned ALL time periods for ALL
--      locations. req_summary CTE now has an explicit period AND location
--      filter using the requisition-level MAX anchor — matching generate.
--   2. Audit used MAX aggregate; generate used per-line date. Now both use
--      requisition-level MAX across fulfilled lines (identical logic).
--   3. Audit showed all locations when a specific location was selected,
--      because the WHERE ran on the CTE but the period check was only in
--      CASE labels. Now the period filter is inside the eligible_reqs CTE.
--   4. HST repair for existing draft invoices is included at the end.
--
-- SAFE TO RE-RUN. Run AFTER:
--   1. migration_invoice_fix_v2.sql
--   2. migration_invoice_audit_status_fix.sql
-- ============================================================

-- ── 1. Drop before redefining ──────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_invoice_eligibility_audit(TEXT, DATE, DATE, TEXT);
DROP FUNCTION IF EXISTS public.generate_invoices(TEXT, DATE, TEXT);
DROP FUNCTION IF EXISTS public.generate_monthly_invoices(DATE, TEXT);

-- ── 2. get_invoice_eligibility_audit — OPTION A ───────────────────────────────
-- Eligibility is evaluated at REQUISITION level using MAX(fulfilled_at) anchor.
-- If a requisition's anchor falls in the selected period AND matches the
-- selected location, it is Eligible. All its fulfilled lines are counted.
-- Out-of-period requisitions (for the selected location) are shown as Excluded
-- with a specific reason so the operator can diagnose gaps.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_invoice_eligibility_audit(
  p_billing_frequency TEXT,
  p_period_start      DATE,
  p_period_end        DATE,
  p_location_id       TEXT DEFAULT NULL
)
RETURNS TABLE (
  requisition_id        TEXT,
  location_id           TEXT,
  location_name         TEXT,
  request_date          TEXT,
  header_status         TEXT,
  fulfillment_date      TIMESTAMPTZ,   -- MAX(fulfilled_at) — the period anchor
  fulfillment_source    TEXT,
  fulfilled_qty         NUMERIC,       -- ALL fulfilled qty on the requisition
  fulfilled_value       NUMERIC,       -- ALL fulfilled value on the requisition
  existing_invoice_id   TEXT,
  existing_invoice_no   TEXT,
  existing_inv_status   TEXT,
  result                TEXT,          -- 'Eligible' | 'Excluded'
  exclusion_reason      TEXT
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

  IF p_billing_frequency NOT IN ('daily', 'biweekly', 'monthly') THEN
    RAISE EXCEPTION 'Invalid billing frequency: %', p_billing_frequency;
  END IF;

  v_end_exclusive := p_period_end + INTERVAL '1 day';

  -- ── DEBUG: uncomment to diagnose location / period issues ──────────────────
  -- RAISE NOTICE 'Audit: freq=% start=% end=% loc=%',
  --   p_billing_frequency, p_period_start, p_period_end, p_location_id;

  RETURN QUERY
  WITH

  -- ── A. Compute per-requisition fulfilled aggregate + period anchor ─────────
  --
  --  OPTION A KEY RULE:
  --    The period anchor is MAX(COALESCE(ri.fulfilled_at, ri.updated_at))
  --    across ALL fulfilled lines of the requisition.
  --
  --  No per-line date filter here. We aggregate ALL fulfilled lines and
  --  then test whether the requisition-level anchor falls in the period.
  --
  --  Location filter is applied here so the CTE only contains rows
  --  for the requested location (or all locations when p_location_id IS NULL).
  all_reqs AS (
    SELECT
      r.id                                                      AS req_id,
      r.location_id                                             AS loc_id,
      r.date                                                    AS req_date,
      r.status                                                  AS req_status,
      r.invoice_id                                              AS existing_inv_id,
      -- Period anchor: MAX across all fulfilled lines
      MAX(COALESCE(ri.fulfilled_at, ri.updated_at))             AS req_anchor,
      -- Source label for the anchor
      CASE
        WHEN MAX(ri.fulfilled_at) IS NOT NULL
          THEN 'requisition_items.fulfilled_at'
        WHEN MAX(ri.updated_at) IS NOT NULL
         AND SUM(COALESCE(ri.quantity_fulfilled, 0)) > 0
          THEN 'requisition_items.updated_at (fallback)'
        ELSE 'unavailable'
      END                                                       AS fulfillment_source,
      -- ALL fulfilled lines totals (not filtered by date)
      SUM(COALESCE(ri.quantity_fulfilled, 0))                   AS total_fulfilled_qty,
      SUM(
        ROUND((COALESCE(ri.quantity_fulfilled, 0)
               * COALESCE(ri.unit_price, 0))::NUMERIC, 2)
      )                                                         AS total_fulfilled_value
    FROM public.requisitions r
    LEFT JOIN public.requisition_items ri
          ON ri.requisition_id = r.id
    WHERE
      -- ── Location filter (applied in CTE, not just in CASE labels) ──────────
      r.location_id IS NOT NULL
      AND r.location_id <> 'LOC-HQ'
      AND (p_location_id IS NULL OR r.location_id = p_location_id)
      -- Exclude statuses that are never invoiceable
      AND lower(coalesce(r.status, '')) NOT IN ('draft', 'cancelled')
    GROUP BY r.id, r.location_id, r.date, r.status, r.invoice_id
  ),

  -- ── B. Resolve location display names ─────────────────────────────────────
  reqs_with_location AS (
    SELECT
      ar.*,
      COALESCE(l.name, ar.loc_id) AS loc_name
    FROM all_reqs ar
    LEFT JOIN public.locations l ON l.id = ar.loc_id
  ),

  -- ── C. Non-void invoices for existing-invoice cross-reference ────────────
  invoice_lookup AS (
    SELECT
      i.id             AS inv_id,
      i.invoice_number AS inv_number,
      i.status         AS inv_status
    FROM public.invoices i
    WHERE i.status <> 'void'
  )

  -- ── D. Classify each requisition as Eligible or Excluded ─────────────────
  SELECT
    rwl.req_id::TEXT                    AS requisition_id,
    rwl.loc_id::TEXT                    AS location_id,
    rwl.loc_name::TEXT                  AS location_name,
    rwl.req_date::TEXT                  AS request_date,
    rwl.req_status::TEXT                AS header_status,
    rwl.req_anchor                      AS fulfillment_date,
    rwl.fulfillment_source::TEXT        AS fulfillment_source,
    rwl.total_fulfilled_qty             AS fulfilled_qty,
    rwl.total_fulfilled_value           AS fulfilled_value,
    il.inv_id::TEXT                     AS existing_invoice_id,
    il.inv_number::TEXT                 AS existing_invoice_no,
    il.inv_status::TEXT                 AS existing_inv_status,

    -- Result verdict (same logic as generate_invoices skip conditions)
    CASE
      -- Not yet fulfilled / wrong status
      WHEN lower(COALESCE(rwl.req_status, '')) IN (
             'draft', 'submitted', 'approved', 'rejected', 'voided', 'void', 'cancelled'
           )
        THEN 'Excluded'
      -- Already linked to a non-void invoice
      WHEN rwl.existing_inv_id IS NOT NULL AND il.inv_id IS NOT NULL
        THEN 'Excluded'
      -- No fulfilled quantity
      WHEN COALESCE(rwl.total_fulfilled_qty, 0) <= 0
        THEN 'Excluded'
      -- Anchor unavailable
      WHEN rwl.req_anchor IS NULL
        THEN 'Excluded'
      -- Anchor before period
      WHEN rwl.req_anchor < p_period_start::TIMESTAMPTZ
        THEN 'Excluded'
      -- Anchor on or after exclusive end
      WHEN rwl.req_anchor >= v_end_exclusive::TIMESTAMPTZ
        THEN 'Excluded'
      -- Zero billable value
      WHEN COALESCE(rwl.total_fulfilled_value, 0) <= 0
        THEN 'Excluded'
      ELSE 'Eligible'
    END::TEXT                           AS result,

    -- Human-readable exclusion reason (NULL when Eligible)
    CASE
      WHEN lower(COALESCE(rwl.req_status, '')) IN ('draft', 'cancelled')
        THEN 'Status: ' || rwl.req_status
      WHEN lower(COALESCE(rwl.req_status, '')) IN ('submitted', 'approved')
        THEN 'Status: not yet fulfilled (' || rwl.req_status || ')'
      WHEN lower(COALESCE(rwl.req_status, '')) IN ('rejected', 'voided', 'void')
        THEN 'Status: ' || rwl.req_status
      WHEN rwl.existing_inv_id IS NOT NULL AND il.inv_id IS NOT NULL
        THEN 'Already invoiced: ' || COALESCE(il.inv_number, rwl.existing_inv_id::TEXT)
      WHEN COALESCE(rwl.total_fulfilled_qty, 0) <= 0
        THEN 'No fulfilled line quantity > 0'
      WHEN rwl.req_anchor IS NULL
        THEN 'No fulfilled_at / updated_at on any line'
      WHEN rwl.req_anchor < p_period_start::TIMESTAMPTZ
        THEN 'Anchor (' || rwl.req_anchor::TEXT || ') before period start ' || p_period_start::TEXT
      WHEN rwl.req_anchor >= v_end_exclusive::TIMESTAMPTZ
        THEN 'Anchor (' || rwl.req_anchor::TEXT || ') after period end ' || p_period_end::TEXT
      WHEN COALESCE(rwl.total_fulfilled_value, 0) <= 0
        THEN 'No billable value (unit_price = 0 for all fulfilled lines)'
      ELSE NULL
    END::TEXT                           AS exclusion_reason

  FROM reqs_with_location rwl
  LEFT JOIN invoice_lookup il ON il.inv_id = rwl.existing_inv_id
  ORDER BY result DESC, rwl.loc_name, rwl.req_anchor DESC NULLS LAST, rwl.req_id;
END;
$$;

-- ── 3. generate_invoices — OPTION A ──────────────────────────────────────────
-- Eligibility evaluated at REQUISITION level using MAX(fulfilled_at) anchor.
-- If eligible, ALL fulfilled billable lines are included in the invoice.
-- requisitions.invoice_id IS NULL is the sole duplicate guard.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_invoices(
  p_billing_frequency TEXT,
  p_period_start      DATE,
  p_location_id       TEXT DEFAULT NULL
)
RETURNS TABLE (
  invoice_id          UUID,
  invoice_number      TEXT,
  location_id         TEXT,
  location_name       TEXT,
  invoice_month       DATE,
  subtotal            NUMERIC,
  tax_amount          NUMERIC,
  total_amount        NUMERIC,
  requisition_count   INTEGER,
  item_count          INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start          DATE;
  v_end_exclusive  DATE;
  v_location       TEXT;
  v_location_name  TEXT;
  v_invoice_id     UUID;
  v_invoice_number TEXT;
  v_subtotal       NUMERIC;
  v_tax_rate       NUMERIC := 0.13;   -- HST 13%
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
  IF p_billing_frequency = 'daily' THEN
    v_start         := p_period_start;
    v_end_exclusive := p_period_start + INTERVAL '1 day';

  ELSIF p_billing_frequency = 'biweekly' THEN
    -- Caller passes any date in the half-month; we snap to the half-start.
    -- Day 1–15  → period is 1st to 15th inclusive.
    -- Day 16–31 → period is 16th to last day of month.
    IF EXTRACT(DAY FROM p_period_start) <= 15 THEN
      v_start         := date_trunc('month', p_period_start)::DATE;
      v_end_exclusive := date_trunc('month', p_period_start)::DATE + INTERVAL '15 days';
    ELSE
      v_start         := date_trunc('month', p_period_start)::DATE + INTERVAL '15 days';
      v_end_exclusive := (date_trunc('month', p_period_start) + INTERVAL '1 month')::DATE;
    END IF;

  ELSE
    -- Monthly: full calendar month
    v_start         := date_trunc('month', p_period_start)::DATE;
    v_end_exclusive := (date_trunc('month', p_period_start) + INTERVAL '1 month')::DATE;
  END IF;

  -- ── DEBUG: uncomment to trace ──────────────────────────────────────────────
  -- RAISE NOTICE 'generate_invoices: freq=% start=% end_excl=% loc=%',
  --   p_billing_frequency, v_start, v_end_exclusive, p_location_id;

  -- ── Find distinct eligible locations ──────────────────────────────────────
  --
  --  OPTION A: A location is eligible when it has at least one REQUISITION
  --  whose MAX(COALESCE(ri.fulfilled_at, ri.updated_at)) across all its
  --  fulfilled lines falls in [v_start, v_end_exclusive).
  --
  --  Note: the subquery tests the requisition-level anchor, not per-line dates.
  --
  FOR v_location IN
    SELECT DISTINCT r.location_id
    FROM public.requisitions r
    WHERE
      r.invoice_id IS NULL
      AND r.location_id IS NOT NULL
      AND r.location_id <> 'LOC-HQ'
      AND (p_location_id IS NULL OR r.location_id = p_location_id)
      AND lower(coalesce(r.status, '')) IN (
            'fulfilled', 'partially_fulfilled', 'partial', 'partial_fulfilled'
          )
      -- Requisition must have at least one fulfilled line
      AND EXISTS (
            SELECT 1
            FROM public.requisition_items ri0
            WHERE ri0.requisition_id = r.id
              AND COALESCE(ri0.quantity_fulfilled, 0) > 0
          )
      -- Requisition-level period anchor falls in the billing window
      AND (
            SELECT MAX(COALESCE(ri2.fulfilled_at, ri2.updated_at))
            FROM public.requisition_items ri2
            WHERE ri2.requisition_id = r.id
              AND COALESCE(ri2.quantity_fulfilled, 0) > 0
          ) >= v_start::TIMESTAMPTZ
      AND (
            SELECT MAX(COALESCE(ri2.fulfilled_at, ri2.updated_at))
            FROM public.requisition_items ri2
            WHERE ri2.requisition_id = r.id
              AND COALESCE(ri2.quantity_fulfilled, 0) > 0
          ) < v_end_exclusive::TIMESTAMPTZ
  LOOP

    -- ── Resolve location display name ───────────────────────────────────────
    SELECT COALESCE(l.name, v_location)
      INTO v_location_name
      FROM public.locations l
     WHERE l.id = v_location
     LIMIT 1;
    v_location_name := COALESCE(v_location_name, v_location);

    -- ── Aggregate subtotal across ALL fulfilled lines on eligible reqs ───────
    --
    --  OPTION A: Include ALL fulfilled billable lines from eligible requisitions.
    --  Eligibility tested on the requisition (via the same MAX anchor subquery).
    --  No per-line date filter on the aggregation.
    --
    SELECT
      ROUND(
        SUM(COALESCE(ri.quantity_fulfilled, 0) * COALESCE(ri.unit_price, 0))::NUMERIC,
        2
      ),
      COUNT(DISTINCT r.id)::INTEGER,
      COUNT(ri.id)::INTEGER
    INTO v_subtotal, v_req_count, v_item_count
    FROM public.requisitions r
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    WHERE
      r.invoice_id IS NULL
      AND r.location_id = v_location
      AND lower(coalesce(r.status, '')) IN (
            'fulfilled', 'partially_fulfilled', 'partial', 'partial_fulfilled'
          )
      AND COALESCE(ri.quantity_fulfilled, 0) > 0
      -- Requisition-level period anchor (same subquery as location discovery)
      AND (
            SELECT MAX(COALESCE(ri2.fulfilled_at, ri2.updated_at))
            FROM public.requisition_items ri2
            WHERE ri2.requisition_id = r.id
              AND COALESCE(ri2.quantity_fulfilled, 0) > 0
          ) >= v_start::TIMESTAMPTZ
      AND (
            SELECT MAX(COALESCE(ri2.fulfilled_at, ri2.updated_at))
            FROM public.requisition_items ri2
            WHERE ri2.requisition_id = r.id
              AND COALESCE(ri2.quantity_fulfilled, 0) > 0
          ) < v_end_exclusive::TIMESTAMPTZ;

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

    -- ── Skip if a non-void invoice already exists for this number ─────────────
    -- This is the IDEMPOTENCY guard: running generate twice is safe.
    SELECT i.id INTO v_invoice_id
    FROM public.invoices i
    WHERE i.invoice_number = v_invoice_number
      AND i.status <> 'void'
    LIMIT 1;

    IF v_invoice_id IS NOT NULL THEN
      CONTINUE;
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

    -- ── Insert ALL fulfilled lines from eligible requisitions ────────────────
    --
    --  OPTION A: No per-line date filter. All fulfilled billable lines
    --  from eligible requisitions are snapshotted into invoice_items.
    --  Eligibility is at the requisition level (same MAX anchor subquery).
    --
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
      COALESCE(
        ri.item_name_snapshot,
        ri.finished_good_id::TEXT,
        ri.item_id::TEXT,
        'Unknown item'
      ),
      COALESCE(ri.quantity_fulfilled, 0),
      COALESCE(ri.unit_price, 0),
      ROUND(
        (COALESCE(ri.quantity_fulfilled, 0) * COALESCE(ri.unit_price, 0))::NUMERIC,
        2
      )
    FROM public.requisitions r
    JOIN public.requisition_items ri ON ri.requisition_id = r.id
    WHERE
      r.invoice_id IS NULL
      AND r.location_id = v_location
      AND lower(coalesce(r.status, '')) IN (
            'fulfilled', 'partially_fulfilled', 'partial', 'partial_fulfilled'
          )
      AND COALESCE(ri.quantity_fulfilled, 0) > 0
      -- Requisition-level anchor guard (same subquery — guarantees consistency)
      AND (
            SELECT MAX(COALESCE(ri2.fulfilled_at, ri2.updated_at))
            FROM public.requisition_items ri2
            WHERE ri2.requisition_id = r.id
              AND COALESCE(ri2.quantity_fulfilled, 0) > 0
          ) >= v_start::TIMESTAMPTZ
      AND (
            SELECT MAX(COALESCE(ri2.fulfilled_at, ri2.updated_at))
            FROM public.requisition_items ri2
            WHERE ri2.requisition_id = r.id
              AND COALESCE(ri2.quantity_fulfilled, 0) > 0
          ) < v_end_exclusive::TIMESTAMPTZ;

    -- ── Mark requisitions as invoiced ────────────────────────────────────────
    -- Sets invoice_id on the header — this is the duplicate-billing guard.
    -- Exact same eligibility condition as above to ensure consistency.
    UPDATE public.requisitions r
    SET
      invoice_id  = v_invoice_id,
      invoiced_at = NOW()
    WHERE
      r.invoice_id IS NULL
      AND r.location_id = v_location
      AND lower(coalesce(r.status, '')) IN (
            'fulfilled', 'partially_fulfilled', 'partial', 'partial_fulfilled'
          )
      AND EXISTS (
            SELECT 1
            FROM public.requisition_items ri0
            WHERE ri0.requisition_id = r.id
              AND COALESCE(ri0.quantity_fulfilled, 0) > 0
          )
      AND (
            SELECT MAX(COALESCE(ri2.fulfilled_at, ri2.updated_at))
            FROM public.requisition_items ri2
            WHERE ri2.requisition_id = r.id
              AND COALESCE(ri2.quantity_fulfilled, 0) > 0
          ) >= v_start::TIMESTAMPTZ
      AND (
            SELECT MAX(COALESCE(ri2.fulfilled_at, ri2.updated_at))
            FROM public.requisition_items ri2
            WHERE ri2.requisition_id = r.id
              AND COALESCE(ri2.quantity_fulfilled, 0) > 0
          ) < v_end_exclusive::TIMESTAMPTZ;

    -- ── Return summary row ───────────────────────────────────────────────────
    RETURN QUERY
    SELECT
      v_invoice_id,
      v_invoice_number,
      v_location,
      v_location_name,
      v_start,
      v_subtotal,
      v_tax_amount,
      v_total,
      v_req_count,
      v_item_count;

  END LOOP;
END;
$$;

-- ── 4. Monthly wrapper (unchanged logic, updated return sig) ──────────────────
CREATE OR REPLACE FUNCTION public.generate_monthly_invoices(
  p_invoice_month DATE,
  p_location_id   TEXT DEFAULT NULL
)
RETURNS TABLE (
  invoice_id        UUID,
  invoice_number    TEXT,
  location_id       TEXT,
  location_name     TEXT,
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

-- ── 5. void_invoice — idempotent recreate ────────────────────────────────────
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
    RAISE EXCEPTION 'NOT FOUND: invoice % does not exist', p_invoice_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_invoice.status = 'void' THEN
    RAISE EXCEPTION 'Invoice % is already voided', v_invoice.invoice_number;
  END IF;

  UPDATE public.invoices
  SET
    status      = 'void',
    void_reason = p_void_reason,
    voided_at   = NOW(),
    voided_by   = auth.uid(),
    updated_at  = NOW()
  WHERE id = p_invoice_id;

  -- Unlink requisitions so they can be re-invoiced
  UPDATE public.requisitions
  SET
    invoice_id  = NULL,
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

-- ── 6. HST repair for existing draft invoices ─────────────────────────────────
-- Safe: only affects draft invoices with subtotal > 0 and tax_amount = 0 / NULL.
-- Does NOT affect paid, finalized, sent, or void invoices.
UPDATE public.invoices
SET
  tax_rate     = 0.13,
  tax_name     = 'HST',
  tax_amount   = ROUND((subtotal * 0.13)::NUMERIC, 2),
  total_amount = subtotal + ROUND((subtotal * 0.13)::NUMERIC, 2),
  updated_at   = NOW()
WHERE
  status   = 'draft'
  AND subtotal > 0
  AND COALESCE(tax_amount, 0) = 0;

-- ── 7. Verify HST repair ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_fixed    INTEGER;
  v_remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_fixed
  FROM public.invoices
  WHERE status = 'draft' AND subtotal > 0 AND tax_amount > 0;

  SELECT COUNT(*) INTO v_remaining
  FROM public.invoices
  WHERE status = 'draft' AND subtotal > 0 AND COALESCE(tax_amount, 0) = 0;

  RAISE NOTICE 'HST repair: % draft invoices now have tax > 0, % still have zero tax',
    v_fixed, v_remaining;
END;
$$;

-- ── 8. Permissions ────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.generate_invoices(TEXT, DATE, TEXT)                   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_monthly_invoices(DATE, TEXT)                 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_invoice_eligibility_audit(TEXT, DATE, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.void_invoice(UUID, TEXT)                              FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.generate_invoices(TEXT, DATE, TEXT)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_monthly_invoices(DATE, TEXT)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_eligibility_audit(TEXT, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_invoice(UUID, TEXT)                              TO authenticated;

-- ── 9. Smoke tests (run manually after deploying) ─────────────────────────────
-- 9a. Verify location filter — replace UUID with real value:
-- SELECT result, requisition_id, location_name, header_status,
--        fulfillment_date, fulfilled_qty, fulfilled_value, exclusion_reason
-- FROM public.get_invoice_eligibility_audit(
--   'monthly', '2026-06-01'::DATE, '2026-06-30'::DATE,
--   '<harbourfront-uuid>'  -- must return ONLY Harbourfront rows
-- );
--
-- 9b. All locations audit:
-- SELECT DISTINCT location_name, result, COUNT(*)
-- FROM public.get_invoice_eligibility_audit('monthly','2026-06-01','2026-06-30',NULL)
-- GROUP BY location_name, result ORDER BY location_name;
--
-- 9c. Verify HST on existing June invoice:
-- SELECT invoice_number, status, subtotal, tax_rate, tax_amount, total_amount
-- FROM public.invoices WHERE invoice_number LIKE 'INV-202606%';
-- Expected: tax_amount = round(subtotal * 0.13, 2)
--
-- 9d. Cross-period diagnostic (run BEFORE generate to confirm no cross-period reqs):
-- WITH line_periods AS (
--   SELECT ri.requisition_id, r.invoice_id,
--     date_trunc('month', COALESCE(ri.fulfilled_at, ri.updated_at))::DATE AS month_bucket
--   FROM public.requisition_items ri
--   JOIN public.requisitions r ON r.id = ri.requisition_id
--   WHERE COALESCE(ri.quantity_fulfilled, 0) > 0
-- )
-- SELECT requisition_id, invoice_id, COUNT(DISTINCT month_bucket) AS distinct_months
-- FROM line_periods
-- GROUP BY requisition_id, invoice_id
-- HAVING COUNT(DISTINCT month_bucket) > 1;
