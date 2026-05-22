-- migration_outlet_inventory.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Creates location_inventory_items: per-outlet stock control rows.
--
-- Design:
--   - HQ inventory_items (location_id = 'LOC-HQ') remain the master source.
--   - location_inventory_items stores ONLY outlet-specific fields.
--   - Outlet pages JOIN this table with HQ inventory_items on item_id to
--     display read-only master fields.
--   - Matching key: UNIQUE(item_id, location_id).
--
-- Run this once in Supabase SQL Editor.
-- All existing tables / pages are untouched.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Create table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.location_inventory_items (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         TEXT        NOT NULL,
  location_id     TEXT        NOT NULL,
  current_stock   NUMERIC     NOT NULL DEFAULT 0,
  physical_count  NUMERIC,
  min_on_hand     NUMERIC     NOT NULL DEFAULT 0,
  par_level       NUMERIC     NOT NULL DEFAULT 0,
  local_enabled   BOOLEAN     NOT NULL DEFAULT true,
  local_notes     TEXT,
  last_counted_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(item_id, location_id)
);

COMMENT ON TABLE public.location_inventory_items IS
  'Per-outlet inventory control rows. Master item data lives in inventory_items (location_id=LOC-HQ). '
  'This table stores only outlet-specific fields: stock, par, counts, notes, enabled flag.';

-- ── 2. updated_at trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_location_inventory_items_updated_at ON public.location_inventory_items;
CREATE TRIGGER set_location_inventory_items_updated_at
  BEFORE UPDATE ON public.location_inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 3. Backfill ───────────────────────────────────────────────────────────────
-- For every non-HQ inventory_items row that has a valid item_id,
-- create a corresponding location_inventory_items row carrying over
-- existing instock / parlevel values.
-- Rows that already exist (from a previous partial run) are skipped.
INSERT INTO public.location_inventory_items
  (item_id, location_id, current_stock, par_level, min_on_hand, local_enabled)
SELECT
  ii.item_id,
  ii.location_id,
  COALESCE(ii.instock, 0)   AS current_stock,
  COALESCE(ii.parlevel, 0)  AS par_level,
  0                         AS min_on_hand,
  true                      AS local_enabled
FROM public.inventory_items ii
WHERE
  ii.item_id     IS NOT NULL
  AND ii.location_id IS NOT NULL
  AND ii.location_id <> 'LOC-HQ'   -- HQ rows are the master, not outlets
ON CONFLICT (item_id, location_id) DO NOTHING;

-- ── 4. Enable RLS ────────────────────────────────────────────────────────────
ALTER TABLE public.location_inventory_items ENABLE ROW LEVEL SECURITY;

-- Drop stale policies if re-running this migration
DROP POLICY IF EXISTS "hq_admin can read all outlet inventory"           ON public.location_inventory_items;
DROP POLICY IF EXISTS "location_manager can read own outlet inventory"    ON public.location_inventory_items;
DROP POLICY IF EXISTS "location_manager can insert own outlet inventory"  ON public.location_inventory_items;
DROP POLICY IF EXISTS "location_manager can update own outlet inventory"  ON public.location_inventory_items;
DROP POLICY IF EXISTS "hq_admin can insert any outlet inventory"          ON public.location_inventory_items;
DROP POLICY IF EXISTS "hq_admin can update any outlet inventory"          ON public.location_inventory_items;

-- HQ admin: full read
CREATE POLICY "hq_admin can read all outlet inventory"
  ON public.location_inventory_items FOR SELECT
  USING ( public.get_my_role() = 'hq_admin' );

-- Location manager: read own location
CREATE POLICY "location_manager can read own outlet inventory"
  ON public.location_inventory_items FOR SELECT
  USING (
    public.get_my_role() = 'location_manager'
    AND location_id = public.get_my_location_id()
  );

-- Location manager: insert for own location
CREATE POLICY "location_manager can insert own outlet inventory"
  ON public.location_inventory_items FOR INSERT
  WITH CHECK (
    public.get_my_role() = 'location_manager'
    AND location_id = public.get_my_location_id()
  );

-- Location manager: update own location rows (outlet fields only — enforced at app level)
CREATE POLICY "location_manager can update own outlet inventory"
  ON public.location_inventory_items FOR UPDATE
  USING (
    public.get_my_role() = 'location_manager'
    AND location_id = public.get_my_location_id()
  );

-- HQ admin: insert/update any outlet (for admin correction mode, import)
CREATE POLICY "hq_admin can insert any outlet inventory"
  ON public.location_inventory_items FOR INSERT
  WITH CHECK ( public.get_my_role() = 'hq_admin' );

CREATE POLICY "hq_admin can update any outlet inventory"
  ON public.location_inventory_items FOR UPDATE
  USING ( public.get_my_role() = 'hq_admin' );

-- ── 5. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_loc_inv_items_location_id
  ON public.location_inventory_items(location_id);

CREATE INDEX IF NOT EXISTS idx_loc_inv_items_item_id
  ON public.location_inventory_items(item_id);
