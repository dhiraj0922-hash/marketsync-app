-- migration_linked_recipe.sql
-- Run in Supabase SQL editor.
-- Adds an explicit linked_recipe_id column to inventory_items so that HQ can
-- directly map a Prep inventory item to its production recipe without relying
-- on fragile automatic detection (output_item_id / output_item_type / name match).
--
-- Usage: Production → Prep/Base tab → "Link Recipe" picker per prep item.

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS linked_recipe_id TEXT DEFAULT NULL;

COMMENT ON COLUMN inventory_items.linked_recipe_id IS
  'FK (by value) → recipes.id. Set by HQ in Production → Prep/Base to explicitly link a recipe for production execution.';
