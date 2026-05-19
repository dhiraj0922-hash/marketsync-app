-- AI Nutrition Estimation for Recipes
-- Additive nullable column; safe to run more than once.

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS nutrition_estimate JSONB DEFAULT NULL;
