-- =============================================================================
-- MIGRATION: get_cogs_report RPC
--
-- Creates the Postgres function called by src/lib/reports.ts → getCogsReport().
--
-- Client call (reports.ts:61-65):
--   supabase.rpc("get_cogs_report", {
--     p_location_id : TEXT | null   → null = all locations
--     p_date_from   : TEXT          → ISO date "YYYY-MM-DD"
--     p_date_to     : TEXT          → ISO date "YYYY-MM-DD"
--   })
--
-- Client row mapping (reports.ts:72-79) — return columns MUST match exactly:
--   movement_date  TEXT           ← DATE cast to text (YYYY-MM-DD)
--   location_id    TEXT | null
--   item_id        TEXT | null
--   item_name      TEXT | null    ← joined from inventory_items
--   total_qty      NUMERIC        ← SUM(quantity)
--   cogs_value     NUMERIC        ← SUM(total_cost)
--
-- Movement types treated as cost-out (COGS):
--   production_consumption  — ingredients consumed during production runs
--   transfer_out            — stock transferred from HQ to a store (cost leaves HQ)
--   adjustment_out          — manual negative adjustments (waste, write-offs)
--
-- inventory_items join strategy:
--   inventory_movements.item_id stores the shared item identity, which can be
--   either a SKU string (item_id column on inventory_items) or a UUID (id column).
--   The LEFT JOIN covers both cases; item_name falls back to the raw item_id
--   string if no match is found (handles orphaned/deleted items gracefully).
--
-- Safe to re-run — CREATE OR REPLACE is idempotent.
-- Does NOT modify any table, column, or row.
-- Run in Supabase SQL Editor.
-- =============================================================================


CREATE OR REPLACE FUNCTION public.get_cogs_report(
  p_location_id TEXT,       -- nullable: NULL → all locations
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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    -- Date as YYYY-MM-DD text (matches the string format the client expects)
    TO_CHAR(im.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS movement_date,

    im.location_id,
    im.item_id,

    -- Item name: join inventory_items on both the SKU (item_id) and UUID (id)
    -- columns to handle both identity formats stored in inventory_movements.
    -- Falls back to the raw item_id string if no matching inventory row exists
    -- (covers deleted items or items created before the identity system was added).
    COALESCE(ii.name, im.item_id)                            AS item_name,

    SUM(im.quantity)                                         AS total_qty,
    SUM(im.total_cost)                                       AS cogs_value

  FROM public.inventory_movements im

  -- Cover both SKU-style (item_id column) and UUID-style (id column) identities
  LEFT JOIN public.inventory_items ii
         ON ii.item_id = im.item_id
         OR ii.id::TEXT = im.item_id

  WHERE
    -- Cost-out movement types only
    im.movement_type IN (
      'production_consumption',   -- ingredients consumed in production runs
      'transfer_out',             -- stock sent from HQ to a store
      'adjustment_out'            -- manual write-offs / waste
    )

    -- Date range filter (p_date_from and p_date_to are inclusive DATE boundaries)
    AND im.created_at >= p_date_from::DATE
    AND im.created_at <  p_date_to::DATE + INTERVAL '1 day'

    -- Location filter: NULL → all locations; non-null → exact match
    AND (p_location_id IS NULL OR im.location_id = p_location_id)

  GROUP BY
    TO_CHAR(im.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
    im.location_id,
    im.item_id,
    COALESCE(ii.name, im.item_id)

  ORDER BY
    movement_date DESC,
    im.location_id,
    item_name;
$$;

-- ── Permissions ───────────────────────────────────────────────────────────────
-- Only authenticated users may call this function.
-- The Reports page is already guarded by <HQOnlyGuard> in the UI, but the
-- function itself does not enforce role — it relies on the page-level guard
-- and the p_location_id filter. A future hardening pass can add an explicit
-- is_hq_admin_profile() check inside the WHERE clause if needed.

REVOKE ALL    ON FUNCTION public.get_cogs_report(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_cogs_report(TEXT, TEXT, TEXT) TO authenticated;


-- ── Verify ────────────────────────────────────────────────────────────────────

-- Should return one row with proname = 'get_cogs_report'
SELECT
  proname                              AS function_name,
  pg_get_function_arguments(oid)      AS arguments,
  prosecdef                           AS security_definer
FROM pg_proc
WHERE proname = 'get_cogs_report'
  AND pronamespace = 'public'::regnamespace;

-- Smoke test: call with all-location, last 90 days
-- Should return rows if any production_consumption, transfer_out,
-- or adjustment_out movements exist in that period.
-- Replace dates as needed.
SELECT *
FROM public.get_cogs_report(
  NULL,
  (CURRENT_DATE - INTERVAL '90 days')::TEXT,
  CURRENT_DATE::TEXT
)
ORDER BY movement_date DESC
LIMIT 20;
