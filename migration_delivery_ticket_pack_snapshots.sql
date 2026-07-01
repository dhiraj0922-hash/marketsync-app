-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: delivery_ticket_items — add pack breakdown snapshot columns
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Purpose:
--   Add warehouse packing information to delivery_ticket_items so that each
--   ticket carries a complete, self-contained packing list. All values are
--   snapshots captured at ticket-creation time, so historical tickets remain
--   accurate even if pack configuration changes later.
--
-- New columns:
--
--   pack_qty_snapshot   NUMERIC NULL
--     Quantity inside one pack at the time the ticket was created.
--     Examples: 750 (grams), 40 (pieces), 10 (litres), 5 (kg).
--     NULL means no pack configuration was available.
--
--   pack_unit_snapshot  TEXT NULL
--     The base unit of the quantity inside one pack.
--     Examples: g, kg, pcs, L, ea.
--     NULL when pack_qty_snapshot is NULL.
--
--   pack_label_snapshot TEXT NULL
--     Human-readable pack description captured at creation time.
--     Preserves the original wording (pack, tray, pail, bag, carton, case, etc.)
--     when available. Computed by the application from outlet_catalog_items or
--     hq_sale_items at ticket-creation time.
--     Examples: "750 g / pack", "40 pcs / pack", "10 L / pail", "5 kg / bag".
--     NULL when no pack information is available (loose items or missing config).
--
--   shipped_pack_count  NUMERIC NULL
--     Number of packs the warehouse must pull for this line.
--     Set only for FG / pack-based items where shipped_qty represents pack count.
--     NULL for loose / base-unit items (use shipped_base_qty directly).
--
--   shipped_base_qty    NUMERIC NULL
--     Total base quantity being shipped.
--     For pack-based items: shipped_pack_count × pack_qty_snapshot.
--     For loose items: equal to shipped_qty (same number, explicit for clarity).
--     NULL only if pack information is entirely missing.
--
-- Decision rules applied at ticket creation (in storage.ts):
--
--   A. Pack-based (pack_qty_snapshot IS NOT NULL AND pack_qty_snapshot > 1
--      AND the requisition line stored quantity in packs):
--        shipped_pack_count = shipped_qty          (packs)
--        shipped_base_qty   = shipped_qty × pack_qty_snapshot  (base units)
--
--   B. Loose / base-unit (pack_qty_snapshot IS NULL OR pack_qty_snapshot <= 1
--      OR the requisition line stored quantity in base units):
--        shipped_pack_count = NULL
--        shipped_base_qty   = shipped_qty          (base units, no multiplication)
--
--   C. Pack info missing:
--        All four columns NULL → UI shows
--        "Pack configuration missing — confirm quantity manually before dispatch."
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.delivery_ticket_items
  ADD COLUMN IF NOT EXISTS pack_qty_snapshot   NUMERIC   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pack_unit_snapshot  TEXT      DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pack_label_snapshot TEXT      DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shipped_pack_count  NUMERIC   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shipped_base_qty    NUMERIC   DEFAULT NULL;

COMMENT ON COLUMN public.delivery_ticket_items.pack_qty_snapshot IS
  'Snapshot: quantity inside one pack at ticket creation time. '
  'NULL = no pack configuration. Examples: 750 (g), 40 (pcs), 10 (L).';

COMMENT ON COLUMN public.delivery_ticket_items.pack_unit_snapshot IS
  'Snapshot: unit for pack_qty_snapshot. NULL when pack_qty_snapshot is NULL. '
  'Examples: g, kg, pcs, L, ea.';

COMMENT ON COLUMN public.delivery_ticket_items.pack_label_snapshot IS
  'Snapshot: human-readable pack description at ticket creation. '
  'Preserves original wording (pack, tray, pail, bag, carton, case). '
  'NULL for loose items or when pack configuration is unavailable. '
  'Examples: "750 g / pack", "40 pcs / pack", "10 L / pail".';

COMMENT ON COLUMN public.delivery_ticket_items.shipped_pack_count IS
  'Number of packs to pull for this line. '
  'Only set for pack-based items where shipped_qty is a pack count. '
  'NULL for loose/base-unit lines.';

COMMENT ON COLUMN public.delivery_ticket_items.shipped_base_qty IS
  'Total base quantity being shipped. '
  'Pack-based: shipped_pack_count × pack_qty_snapshot. '
  'Loose: equal to shipped_qty. '
  'NULL only when all pack information is missing.';
