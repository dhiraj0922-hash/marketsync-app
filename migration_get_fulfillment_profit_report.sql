-- =============================================================================
-- MIGRATION: get_fulfillment_profit_report RPC
--
-- Calculates gross profit on HQ-to-location finished goods transfers.
--
-- Business model:
--   HQ produces finished goods (hq_sale_items) and fulfills franchise
--   location requisitions. Revenue = what the location was charged
--   (requisition_items.unit_price × quantity_fulfilled). COGS = ingredient
--   cost to produce that quantity (hq_sale_items.making_cost × quantity).
--
-- Tables joined:
--   requisition_items  ri  — line-level fulfillment record
--     .quantity_fulfilled  — units actually sent (must be > 0)
--     .unit_price          — effective_price snapshot at fulfillment time
--     .line_total          — pre-computed ri.unit_price × quantity_fulfilled
--     .finished_good_id    — FK → hq_sale_items.id (must not be NULL)
--     .requisition_id      — FK → requisitions.id
--     .created_at          — TIMESTAMPTZ used for date filtering + movement_date
--   requisitions       req — parent requisition (provides location_id)
--     .location_id         — FK to locations.id; source of truth for location scope
--   hq_sale_items      hq  — master finished good record (provides name + making_cost)
--     .name                — item_name
--     .making_cost         — cost per unit to produce (current snapshot)
--
-- Filters applied:
--   ri.quantity_fulfilled > 0          — only actual deliveries, not pending lines
--   ri.unit_price IS NOT NULL          — revenue must be known (pre-migration rows excluded)
--   ri.finished_good_id IS NOT NULL    — finished-good mode only (excludes raw transfers)
--
-- Margin calculation:
--   revenue    = fulfilled_value, line_total, or quantity_fulfilled × unit_price
--   cogs       = quantity_fulfilled × requisition_items.pack_qty_snapshot × hq_sale_items.making_cost
--   profit     = revenue − cogs
--   margin_pct = (profit / NULLIF(revenue, 0)) × 100
--                → NULL when revenue = 0 (avoids division-by-zero)
--
-- Date filter:
--   p_date_from / p_date_to are ISO date strings "YYYY-MM-DD" (inclusive).
--   Filtering on ri.created_at (TIMESTAMPTZ) — the most reliable timestamp;
--   requisitions.date is a user-entered TEXT field and may be inconsistent.
--
-- Safe to re-run — CREATE OR REPLACE is idempotent.
-- Does NOT modify any table or row.
-- Run in Supabase SQL Editor.
-- =============================================================================


CREATE OR REPLACE FUNCTION public.get_fulfillment_profit_report(
  p_location_id TEXT,    -- nullable: NULL → all locations
  p_date_from   TEXT,    -- ISO date "YYYY-MM-DD" (inclusive lower bound)
  p_date_to     TEXT     -- ISO date "YYYY-MM-DD" (inclusive upper bound)
)
RETURNS TABLE (
  movement_date TEXT,     -- YYYY-MM-DD of fulfillment (from ri.created_at)
  location_id   TEXT,     -- from requisitions.location_id
  item_name     TEXT,     -- from hq_sale_items.name
  qty           NUMERIC,  -- quantity_fulfilled
  unit_price    NUMERIC,  -- effective_price snapshot at fulfillment time
  revenue       NUMERIC,  -- qty × unit_price
  making_cost   NUMERIC,  -- hq_sale_items.making_cost (current per-unit cost)
  cogs          NUMERIC,  -- qty × making_cost
  profit        NUMERIC,  -- revenue − cogs
  margin_pct    NUMERIC   -- (profit / revenue) × 100; NULL when revenue = 0
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    -- Date of fulfillment as YYYY-MM-DD string for display
    TO_CHAR(ri.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')  AS movement_date,

    req.location_id,

    hq.name                                                   AS item_name,

    ri.quantity_fulfilled                                      AS qty,

    ri.unit_price,

    -- Revenue: use line_total when pre-computed (avoids floating-point drift),
    -- fall back to quantity × unit_price for rows where line_total was not stored.
    COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price)
                                                              AS revenue,

    hq.making_cost,

    -- COGS: use row-level pack snapshot, not live hq_sale_items.pack_qty.
    ri.quantity_fulfilled
      * COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)
      * COALESCE(hq.making_cost, 0)                           AS cogs,

    -- Profit: revenue minus production cost
    COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price)
      - (
          ri.quantity_fulfilled
          * COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)
          * COALESCE(hq.making_cost, 0)
        )                                                     AS profit,

    -- Margin %: NULL-safe — returns NULL rather than divide-by-zero when revenue = 0
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
        2  -- two decimal places
      )
    END                                                        AS margin_pct

  FROM public.requisition_items ri

  -- Parent requisition: provides location_id for scoping
  INNER JOIN public.requisitions req
          ON req.id = ri.requisition_id

  -- Finished good master: provides name and making_cost
  INNER JOIN public.hq_sale_items hq
          ON hq.id = ri.finished_good_id

  WHERE
    -- Only actual deliveries with known revenue and a finished-good link
    ri.quantity_fulfilled  > 0
    AND ri.unit_price      IS NOT NULL
    AND ri.finished_good_id IS NOT NULL

    -- Date range filter (inclusive): p_date_from/p_date_to are DATE strings
    AND ri.created_at >= p_date_from::DATE
    AND ri.created_at <  p_date_to::DATE + INTERVAL '1 day'

    -- Location filter: NULL → all locations
    AND (p_location_id IS NULL OR req.location_id = p_location_id)

  ORDER BY
    ri.created_at DESC,
    req.location_id,
    hq.name;
$$;


-- ── Permissions ───────────────────────────────────────────────────────────────

REVOKE ALL     ON FUNCTION public.get_fulfillment_profit_report(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_fulfillment_profit_report(TEXT, TEXT, TEXT) TO authenticated;


-- ── Verify ────────────────────────────────────────────────────────────────────

SELECT
  proname                              AS function_name,
  pg_get_function_arguments(oid)      AS arguments,
  prosecdef                           AS security_definer
FROM pg_proc
WHERE proname = 'get_fulfillment_profit_report'
  AND pronamespace = 'public'::regnamespace;


-- ── Smoke test: last 90 days, all locations ───────────────────────────────────
-- Returns rows if any finished-good requisitions have been fulfilled with
-- unit_price set. If empty, check requisition_items for rows where
-- finished_good_id IS NOT NULL AND quantity_fulfilled > 0 AND unit_price IS NOT NULL.

SELECT
  movement_date,
  location_id,
  item_name,
  qty,
  unit_price,
  revenue,
  making_cost,
  cogs,
  profit,
  margin_pct
FROM public.get_fulfillment_profit_report(
  NULL,                                           -- all locations
  (CURRENT_DATE - INTERVAL '90 days')::TEXT,      -- from
  CURRENT_DATE::TEXT                              -- to (today, inclusive)
)
ORDER BY movement_date DESC
LIMIT 20;


-- ── Diagnostic: check source data eligibility ─────────────────────────────────
-- Run this if the smoke test returns 0 rows. Shows how many rows would qualify
-- for the profit report before the date filter is applied.

SELECT
  COUNT(*)                                              AS total_ri_rows,
  COUNT(*) FILTER (WHERE ri.finished_good_id IS NOT NULL)
                                                        AS fg_mode_rows,
  COUNT(*) FILTER (WHERE ri.finished_good_id IS NOT NULL
                     AND ri.quantity_fulfilled > 0)     AS fulfilled_fg_rows,
  COUNT(*) FILTER (WHERE ri.finished_good_id IS NOT NULL
                     AND ri.quantity_fulfilled > 0
                     AND ri.unit_price IS NOT NULL)     AS profit_eligible_rows
FROM public.requisition_items ri;
