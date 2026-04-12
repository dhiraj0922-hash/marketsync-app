-- CSV Import History Fields Patch (Snake Case exactly following user constraints)

ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS filename TEXT;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS metrics JSONB DEFAULT '{}'::jsonb;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS created_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS updated_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS rollback_data JSONB DEFAULT '{}'::jsonb;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS failed_rows JSONB DEFAULT '[]'::jsonb;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS summary_payload JSONB DEFAULT '{}'::jsonb;

-- ─────────────────────────────────────────────────────────────────────────────
-- inventory_items extended columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purchasecost NUMERIC DEFAULT NULL;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS item_id TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS location_id TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS baseunit TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS itemtype TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS pricetrend TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS priceincrease BOOLEAN DEFAULT FALSE;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purchaseunits JSONB DEFAULT '[]'::jsonb;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS parlevel NUMERIC DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS instock NUMERIC DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplierid INTEGER;

-- ─────────────────────────────────────────────────────────────────────────────
-- orders extended columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ponumber TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS location_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deliverydate TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS createdby TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receivedby TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receivedat TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS suppliername TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS lineitems JSONB DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplierid INTEGER;

-- ─────────────────────────────────────────────────────────────────────────────
-- requisitions extended columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS location_id TEXT;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS requestedby TEXT;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS lineitems JSONB DEFAULT '[]'::jsonb;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS total NUMERIC DEFAULT 0;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS total_amount NUMERIC DEFAULT 0;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS created_by TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE: HQ Finished Goods → Franchise Requisition Architecture
--
-- hq_sale_items: dedicated table for HQ-produced finished goods that franchise
--   locations can requisition. Separate from inventory_items to keep raw
--   ingredient views clean. making_cost flows from linked recipe costing.
--   suggested_price is a generated column (making_cost × 1.20).
--   effective_price = COALESCE(manual_price, suggested_price) — computed in app.
--
-- recipes.sale_item_id: proper FK link replacing the loose outputItemId string.
--
-- requisition_items extensions:
--   finished_good_id: nullable FK to hq_sale_items (null = legacy raw mode).
--   item_name_snapshot: name at order time — survives future renames.
--   unit_snapshot: unit at order time.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. hq_sale_items ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hq_sale_items (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  description             TEXT,
  base_unit               TEXT NOT NULL DEFAULT 'ea',
  instock                 NUMERIC DEFAULT 0,
  par_level               NUMERIC DEFAULT 0,   -- low-stock threshold for status chip
  is_active               BOOLEAN DEFAULT TRUE,
  is_requisitionable      BOOLEAN DEFAULT TRUE,
  source_recipe_id        TEXT,                 -- FK added below (after recipes exists)
  source_recipe_yield_qty NUMERIC DEFAULT 1,    -- snapshot of recipe.yieldQty at link time
  making_cost             NUMERIC DEFAULT 0,    -- cost per base unit; auto-updated on recipe save
  making_cost_updated_at  TIMESTAMPTZ,
  -- suggested_price generated column: making_cost * 1.20
  -- Supabase requires Postgres 12+ for generated columns (all Supabase projects qualify)
  suggested_price         NUMERIC GENERATED ALWAYS AS (making_cost * 1.20) STORED,
  manual_price            NUMERIC DEFAULT NULL, -- HQ override; NULL = use suggested_price
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Add FK to recipes after both tables exist (safe with IF NOT EXISTS pattern)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'hq_sale_items_source_recipe_id_fkey'
  ) THEN
    ALTER TABLE hq_sale_items
      ADD CONSTRAINT hq_sale_items_source_recipe_id_fkey
      FOREIGN KEY (source_recipe_id) REFERENCES recipes(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE hq_sale_items DISABLE ROW LEVEL SECURITY;

-- 2. Link recipes to hq_sale_items ────────────────────────────────────────────
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS sale_item_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'recipes_sale_item_id_fkey'
  ) THEN
    ALTER TABLE recipes
      ADD CONSTRAINT recipes_sale_item_id_fkey
      FOREIGN KEY (sale_item_id) REFERENCES hq_sale_items(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Extend requisition_items ──────────────────────────────────────────────────
-- Create the table if it doesn't exist yet (fresh Supabase projects)
CREATE TABLE IF NOT EXISTS requisition_items (
  id                  SERIAL PRIMARY KEY,
  requisition_id      TEXT NOT NULL,
  item_id             TEXT,                          -- legacy raw-mode FK
  finished_good_id    TEXT,                          -- new FG-mode FK (nullable)
  item_name_snapshot  TEXT,                          -- name at order time
  unit_snapshot       TEXT,                          -- unit at order time
  quantity_requested  NUMERIC NOT NULL DEFAULT 0,
  quantity_approved   NUMERIC,
  quantity_fulfilled  NUMERIC,
  unit_price          NUMERIC,                       -- effective_price snapshot at order time
  line_total          NUMERIC,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns to existing requisition_items (idempotent)
ALTER TABLE requisition_items ADD COLUMN IF NOT EXISTS finished_good_id   TEXT;
ALTER TABLE requisition_items ADD COLUMN IF NOT EXISTS item_name_snapshot  TEXT;
ALTER TABLE requisition_items ADD COLUMN IF NOT EXISTS unit_snapshot       TEXT;
ALTER TABLE requisition_items ADD COLUMN IF NOT EXISTS unit_price          NUMERIC;
ALTER TABLE requisition_items ADD COLUMN IF NOT EXISTS line_total          NUMERIC;

-- Drop NOT NULL on item_id so FG-mode rows (finished_good_id set, item_id null) are valid.
-- On fresh tables the CREATE TABLE above already defines item_id as nullable.
-- On existing tables this is the missing piece that causes:
--   "null value in column item_id violates not-null constraint"
ALTER TABLE requisition_items ALTER COLUMN item_id DROP NOT NULL;

-- Add FKs (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'req_items_finished_good_fkey'
  ) THEN
    ALTER TABLE requisition_items
      ADD CONSTRAINT req_items_finished_good_fkey
      FOREIGN KEY (finished_good_id) REFERENCES hq_sale_items(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE requisition_items DISABLE ROW LEVEL SECURITY;

-- 4. Convenience view: effective_price pre-computed ───────────────────────────
-- Removes COALESCE from every query that needs the selling price.
CREATE OR REPLACE VIEW hq_sale_items_priced AS
SELECT
  *,
  COALESCE(manual_price, suggested_price) AS effective_price,
  CASE
    WHEN instock <= 0              THEN 'out_of_stock'
    WHEN instock <= par_level      THEN 'low_stock'
    ELSE                                'in_stock'
  END AS stock_status
FROM hq_sale_items;
