-- AI Nutrition Estimate Audit Log
-- Dedicated table so recipe nutrition logging does not require changing ai_import_logs.

CREATE TABLE IF NOT EXISTS ai_nutrition_logs (
  id TEXT PRIMARY KEY,
  requested_by UUID NULL,
  recipe_name TEXT NULL,
  request_payload JSONB NULL,
  raw_ai_response JSONB NULL,
  parsed_result JSONB NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
