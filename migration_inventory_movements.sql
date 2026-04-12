-- =============================================================================
-- PHASE 1: Inventory Movement Ledger
-- Run in Supabase SQL Editor. Safe to re-run — all additive / idempotent.
-- =============================================================================


-- ── 1. Add avg_cost to inventory_items if not present ─────────────────────────
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS avg_cost NUMERIC NOT NULL DEFAULT 0;


-- ── 2. Create inventory_movements ledger table ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id               TEXT        PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- What moved
  item_id          TEXT        NOT NULL,   -- inventory_items.item_id (shared identity)
  item_identity    TEXT,                   -- human-readable name snapshot
  -- Movement kind
  movement_type    TEXT        NOT NULL,   -- 'requisition_out' | 'requisition_in' | 'purchase_in' | 'adjustment' | etc.
  reference_type   TEXT,                   -- 'requisition' | 'purchase_order' | 'manual'
  reference_id     TEXT,                   -- requisition_id / po_id / etc.
  -- Locations
  from_location_id TEXT,
  to_location_id   TEXT,
  -- Quantity & cost
  quantity         NUMERIC     NOT NULL,
  unit             TEXT,
  unit_cost        NUMERIC     NOT NULL DEFAULT 0,
  total_cost       NUMERIC     NOT NULL DEFAULT 0,  -- quantity × unit_cost
  -- Metadata
  notes            TEXT,
  created_by       UUID        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Index for the most common query patterns
CREATE INDEX IF NOT EXISTS idx_inv_movements_item_id      ON public.inventory_movements (item_id);
CREATE INDEX IF NOT EXISTS idx_inv_movements_reference_id ON public.inventory_movements (reference_id);
CREATE INDEX IF NOT EXISTS idx_inv_movements_created_at   ON public.inventory_movements (created_at DESC);

-- RLS: disable for now (service-role inserts from storage.ts); enable with policies later
ALTER TABLE public.inventory_movements DISABLE ROW LEVEL SECURITY;


-- ── 3. Verify ─────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'inventory_movements'
ORDER BY ordinal_position;

SELECT column_name
FROM information_schema.columns
WHERE table_name = 'inventory_items' AND column_name = 'avg_cost';
