-- =============================================================================
-- MIGRATION: get_fulfillment_profit_report v2 — Fix COGS for packed FG items
--
-- Root cause fixed:
--   some quantity_fulfilled values are in PACKS (e.g. 3 packs of DOSA BATTER)
--   while others are base units/eaches (e.g. 5 Chocolate Lava Cakes)
--   making_cost is per BASE UNIT (e.g. $3.0593 / litre)
--   the row-level pack_qty_snapshot is the only safe multiplier
--
-- Old (wrong):
--   cogs = quantity_fulfilled × making_cost
--   e.g.  3 × $3.0593 = $9.18   ← should be $100.96
--
-- New (correct):
--   cogs = quantity_fulfilled × COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1) × making_cost
--   e.g.  3 × 11 × $3.0593 = $100.96   ✅
--
-- Additional improvements over v1:
--   • Adds location_name (LEFT JOIN locations) for better UI labelling
--   • Adds pack_qty column to output for audit transparency
--   • Keeps qty alias (not quantity_fulfilled) so frontend mapper is unchanged
--   • Keeps making_cost column so frontend mapper is unchanged
--   • Uses COALESCE(ri.fulfilled_value, ri.line_total, qty × unit_price) for revenue
--   • margin_pct returns NULL when revenue = 0 (avoids divide-by-zero;
--     frontend already handles null margin_pct correctly)
--   • Preserves original JOIN on finished_good_id (not item_id)
--   • No status filter on requisitions — only quality filter is quantity_fulfilled > 0
--
-- Safe to re-run — CREATE OR REPLACE is idempotent.
-- Does NOT modify any table or row.
-- Run in Supabase SQL Editor.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_fulfillment_profit_report(
  p_location_id TEXT DEFAULT NULL,   -- nullable: NULL → all locations
  p_date_from   TEXT DEFAULT NULL,   -- ISO date "YYYY-MM-DD" (inclusive lower bound)
  p_date_to     TEXT DEFAULT NULL    -- ISO date "YYYY-MM-DD" (inclusive upper bound)
)
RETURNS TABLE (
  movement_date TEXT,       -- YYYY-MM-DD of fulfillment (from ri.created_at)
  location_id   TEXT,       -- from requisitions.location_id
  location_name TEXT,       -- from locations.name (NEW — NULL if location not in table)
  item_name     TEXT,       -- from hq_sale_items.name
  qty           NUMERIC,    -- quantity_fulfilled (line quantity)
  unit_price    NUMERIC,    -- line price snapshot at fulfillment time
  revenue       NUMERIC,    -- prefers fulfilled_value, then line_total, then qty × unit_price
  making_cost   NUMERIC,    -- hq_sale_items.making_cost (per base unit)
  pack_qty      NUMERIC,    -- requisition_items.pack_qty_snapshot used as COGS multiplier
  cogs          NUMERIC,    -- qty × pack_qty_snapshot × making_cost
  profit        NUMERIC,    -- revenue − cogs
  margin_pct    NUMERIC     -- (profit / revenue) × 100; NULL when revenue = 0
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    -- Date of fulfillment as YYYY-MM-DD string
    TO_CHAR(ri.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')  AS movement_date,

    req.location_id,

    -- Human-readable location name (new — useful for "all locations" view)
    COALESCE(l.name, req.location_id)                         AS location_name,

    hq.name                                                    AS item_name,

    -- Qty is the fulfilled line quantity; pack_qty_snapshot defines its base multiplier.
    ri.quantity_fulfilled                                      AS qty,

    ri.unit_price,

    -- Revenue: prefer pre-computed line_total (avoids floating-point drift);
    -- fall back to qty × unit_price for rows where line_total was not stored.
    COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price)
                                                               AS revenue,

    -- Making cost per base unit (exposed for audit transparency)
    hq.making_cost,

    -- Pack qty snapshot: row-level base-unit multiplier captured at requisition time.
    COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)                AS pack_qty,

    -- ── COGS FIX ──────────────────────────────────────────────────────────────
    -- Use row snapshot, not live hq.pack_qty. Some FG lines are fulfilled as eaches.
    ri.quantity_fulfilled
      * COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)
      * COALESCE(hq.making_cost, 0)                            AS cogs,

    -- Profit: revenue minus full production cost
    COALESCE(ri.fulfilled_value, ri.line_total, ri.quantity_fulfilled * ri.unit_price)
      - (
          ri.quantity_fulfilled
          * COALESCE(NULLIF(ri.pack_qty_snapshot, 0), 1)
          * COALESCE(hq.making_cost, 0)
        )                                                       AS profit,

    -- Margin %: NULL-safe — returns NULL (not 0) when revenue = 0
    -- so the frontend can distinguish "no sale" from "zero margin".
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
    END                                                         AS margin_pct

  FROM public.requisition_items ri

  -- Parent requisition: provides location_id for scoping
  INNER JOIN public.requisitions req
          ON req.id = ri.requisition_id

  -- Location name for display (optional — rows still appear if location missing)
  LEFT JOIN public.locations l
         ON l.id = req.location_id

  -- Finished good master: provides name, making_cost, pack_qty
  -- MUST join on finished_good_id — that is the FK set for FG-mode requisition lines.
  -- Do NOT join on ri.item_id — that field is NULL for FG-mode lines.
  INNER JOIN public.hq_sale_items hq
          ON hq.id = ri.finished_good_id

  WHERE
    -- Only actual deliveries
    ri.quantity_fulfilled  > 0
    -- Revenue must be known (rows without unit_price are pre-migration legacy)
    AND ri.unit_price      IS NOT NULL
    -- Finished-good mode only (excludes raw inventory transfers)
    AND ri.finished_good_id IS NOT NULL

    -- Date range filter (inclusive): NULL params → no date restriction
    AND (p_date_from IS NULL OR ri.created_at >= p_date_from::DATE)
    AND (p_date_to   IS NULL OR ri.created_at <  p_date_to::DATE + INTERVAL '1 day')

    -- Location filter: NULL → all locations
    AND (p_location_id IS NULL OR req.location_id = p_location_id)

  ORDER BY
    ri.created_at DESC,
    req.location_id,
    hq.name;
$$;


-- ── Permissions ────────────────────────────────────────────────────────────────

REVOKE ALL     ON FUNCTION public.get_fulfillment_profit_report(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_fulfillment_profit_report(TEXT, TEXT, TEXT) TO authenticated;


-- ── Verify function registered ─────────────────────────────────────────────────

SELECT
  proname                              AS function_name,
  pg_get_function_arguments(oid)      AS arguments,
  prosecdef                           AS security_definer
FROM pg_proc
WHERE proname = 'get_fulfillment_profit_report'
  AND pronamespace = 'public'::regnamespace;


-- ── Smoke test: last 90 days, all locations ────────────────────────────────────
-- Should return non-zero COGS for any packed item (pack_qty > 1).
-- Compare cogs vs (qty * making_cost) to confirm the fix is active.

SELECT
  movement_date,
  location_name,
  item_name,
  qty,
  unit_price,
  revenue,
  making_cost,
  pack_qty,
  ROUND(qty * making_cost, 4)                  AS old_cogs_formula,   -- should be WRONG for packs
  cogs                                         AS new_cogs_formula,   -- should be correct
  profit,
  margin_pct
FROM public.get_fulfillment_profit_report(
  NULL,
  (CURRENT_DATE - INTERVAL '90 days')::TEXT,
  CURRENT_DATE::TEXT
)
ORDER BY movement_date DESC
LIMIT 20;


-- ── Diagnostic: verify source data eligibility ─────────────────────────────────

SELECT
  COUNT(*)                                               AS total_ri_rows,
  COUNT(*) FILTER (WHERE ri.finished_good_id IS NOT NULL)
                                                         AS fg_mode_rows,
  COUNT(*) FILTER (WHERE ri.finished_good_id IS NOT NULL
                     AND ri.quantity_fulfilled > 0)      AS fulfilled_fg_rows,
  COUNT(*) FILTER (WHERE ri.finished_good_id IS NOT NULL
                     AND ri.quantity_fulfilled > 0
                     AND ri.unit_price IS NOT NULL)      AS profit_eligible_rows
FROM public.requisition_items ri;
