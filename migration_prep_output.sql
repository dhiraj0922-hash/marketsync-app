-- migration_prep_output.sql
-- Adds output_item_id + output_item_type to recipes table.
-- output_item_id: references inventory_items.id (TEXT) — can be a prep or FG inventory row
-- output_item_type: 'prep' | 'finished_good' — controls production routing
-- Run this once against your Supabase project.

ALTER TABLE recipes ADD COLUMN IF NOT EXISTS output_item_id TEXT;
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS output_item_type TEXT DEFAULT 'finished_good';

-- Back-fill existing rows: anything already linked via outputItemId (from legacy JSONB paths)
-- is assumed to be a finished_good output (existing behaviour).
UPDATE recipes
SET output_item_type = 'finished_good'
WHERE output_item_type IS NULL;
