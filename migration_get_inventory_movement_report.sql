-- =============================================================================
-- MIGRATION: get_inventory_movement_report RPC
--
-- Creates the Postgres function called by src/lib/reports.ts →
-- getInventoryMovementReport() → Movement Ledger tab on the Reports page.
--
-- Client call (reports.ts:133-139):
--   supabase.rpc("get_inventory_movement_report", {
--     p_location_id : TEXT | null        → null = all locations
--     p_item_id     : TEXT | null        → null = all items
--     p_date_from   : TEXT               → ISO-8601 timestamp  e.g. "2026-04-02T00:00:00Z"
--     p_date_to     : TEXT               → ISO-8601 timestamp  e.g. "2026-05-02T23:59:59Z"
--     p_bucket      : TEXT | null        → null = all buckets; otherwise a report_bucket value
--   })
--
-- NOTE: p_date_from/p_date_to are TIMESTAMPTZ strings, not DATE strings.
--       The client builds them as `${dateFrom}T00:00:00Z` / `${dateTo}T23:59:59Z`.
--       This differs from get_cogs_report which receives plain DATE strings.
--
-- Return columns (must match MovementRow in reports.ts:96-112 exactly):
--   id             BIGINT        → raw movement row id
--   created_at     TIMESTAMPTZ   → raw insert timestamp
--   movement_date  TEXT          → DATE portion "YYYY-MM-DD" for display
--   location_id    TEXT
--   item_id        TEXT
--   item_name      TEXT          → from inventory_items (nullable)
--   movement_type  TEXT          → raw value stored in inventory_movements
--   report_bucket  TEXT          → computed display bucket (see mapping below)
--   quantity       NUMERIC
--   unit_cost      NUMERIC
--   total_cost     NUMERIC       → always positive (absolute value)
--   signed_cost    NUMERIC       → positive for stock-in/gain, negative for stock-out/loss
--   reference_type TEXT
--   reference_id   TEXT
--   notes          TEXT
--
-- report_bucket mapping (movement_type → bucket):
--   purchase_in            → purchase_in
--   production_in          → production_in
--   transfer_in            → transfer_in
--   transfer_out           → transfer_out
--   adjustment_in          → adjustment_in
--   adjustment_out         → adjustment_out
--   production_consumption → cogs
--   count_variance_gain    → variance_gain
--   count_variance_loss    → variance_loss
--   return_out             → return_out
--   (anything else)        → other
--
-- signed_cost sign convention:
--   Inbound / gains  (purchase_in, production_in, transfer_in, adjustment_in,
--                     count_variance_gain)     → +total_cost  (stock value increases)
--   Outbound / losses (transfer_out, adjustment_out, production_consumption,
--                      count_variance_loss, return_out, other) → -total_cost
--
-- p_bucket filter applies to the COMPUTED report_bucket, not raw movement_type,
-- so the UI bucket picker works correctly without knowing raw type strings.
--
-- inventory_items join:
--   inventory_movements.item_id stores either the SKU string (inventory_items.item_id)
--   or a UUID (inventory_items.id). The LEFT JOIN covers both; item_name falls
--   back to the raw item_id string for deleted or legacy items.
--
-- Safe to re-run — CREATE OR REPLACE is idempotent.
-- Does NOT modify any table or row.
-- Run in Supabase SQL Editor.
-- =============================================================================


CREATE OR REPLACE FUNCTION public.get_inventory_movement_report(
  p_location_id TEXT,         -- nullable: NULL → all locations
  p_item_id     TEXT,         -- nullable: NULL → all items
  p_date_from   TEXT,         -- ISO-8601 timestamp "YYYY-MM-DDTHH:MM:SSZ"
  p_date_to     TEXT,         -- ISO-8601 timestamp "YYYY-MM-DDTHH:MM:SSZ" (inclusive)
  p_bucket      TEXT          -- nullable: NULL → all buckets; else filter by report_bucket
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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  WITH

  -- ── Step 1: Enrich each movement row with item_name and computed columns ──
  enriched AS (
    SELECT
      im.id,
      im.created_at,

      -- movement_date: UTC date as "YYYY-MM-DD" string for display
      TO_CHAR(im.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')  AS movement_date,

      im.location_id,
      im.item_id,

      -- item_name: join on SKU (item_id column) OR UUID (id column); fall back
      -- to raw item_id string for deleted / legacy items
      COALESCE(ii.name, im.item_id)                             AS item_name,

      im.movement_type,

      -- ── report_bucket: map raw movement_type to UI display bucket ──────────
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

      -- unit_cost: treat NULL as 0 for display (raw column is nullable)
      COALESCE(im.unit_cost,  0)                                 AS unit_cost,

      -- total_cost: always a positive absolute value for display
      ABS(COALESCE(im.total_cost, 0))                            AS total_cost,

      -- ── signed_cost: directional value for net movement calculation ────────
      --   Inbound / gains  → +ABS(total_cost)   (stock value increases)
      --   Outbound / losses → -ABS(total_cost)   (stock value decreases)
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
        ELSE                              -ABS(COALESCE(im.total_cost, 0))  -- 'other' treated as outbound
      END                                                        AS signed_cost,

      im.reference_type,
      im.reference_id,
      im.notes

    FROM public.inventory_movements im

    -- Cover SKU-style (item_id column) and UUID-style (id column) identities
    LEFT JOIN public.inventory_items ii
           ON ii.item_id = im.item_id
           OR ii.id::TEXT = im.item_id

    WHERE
      -- Date range: p_date_from and p_date_to are full ISO-8601 timestamps
      im.created_at >= p_date_from::TIMESTAMPTZ
      AND im.created_at <= p_date_to::TIMESTAMPTZ

      -- Location filter: NULL → all locations
      AND (p_location_id IS NULL OR im.location_id = p_location_id)

      -- Item filter: NULL → all items
      AND (p_item_id IS NULL OR im.item_id = p_item_id)
  )

  -- ── Step 2: Apply bucket filter on the computed report_bucket column ───────
  --   p_bucket is compared against the COMPUTED bucket (not raw movement_type)
  --   so that the UI bucket picker works correctly.
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
$$;


-- ── Permissions ───────────────────────────────────────────────────────────────
-- Only authenticated sessions may call this function.
-- The Reports page is gated by <HQOnlyGuard> at the UI level.

REVOKE ALL     ON FUNCTION public.get_inventory_movement_report(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_inventory_movement_report(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;


-- ── Verify function exists ────────────────────────────────────────────────────

SELECT
  proname                              AS function_name,
  pg_get_function_arguments(oid)      AS arguments,
  prosecdef                           AS security_definer
FROM pg_proc
WHERE proname = 'get_inventory_movement_report'
  AND pronamespace = 'public'::regnamespace;


-- ── Smoke test: last 90 days, all locations, all buckets ─────────────────────
-- Should return rows immediately — live data confirmed: 20 rows in table
-- including production_consumption, count_variance_gain, count_variance_loss.

SELECT
  id,
  movement_date,
  location_id,
  item_name,
  movement_type,
  report_bucket,
  quantity,
  unit_cost,
  total_cost,
  signed_cost,
  reference_type
FROM public.get_inventory_movement_report(
  NULL,                                                         -- all locations
  NULL,                                                         -- all items
  (NOW() - INTERVAL '90 days')::TEXT,                          -- from
  NOW()::TEXT,                                                  -- to
  NULL                                                          -- all buckets
)
ORDER BY id DESC
LIMIT 20;


-- ── Smoke test: filter to a specific bucket ───────────────────────────────────
-- Uncomment and replace the bucket value to test bucket filtering.
-- Valid values: purchase_in | production_in | transfer_in | transfer_out |
--               adjustment_in | adjustment_out | cogs | variance_gain |
--               variance_loss | return_out | other

-- SELECT *
-- FROM public.get_inventory_movement_report(
--   NULL,
--   NULL,
--   (NOW() - INTERVAL '90 days')::TEXT,
--   NOW()::TEXT,
--   'cogs'   -- ← change to any bucket value
-- );
