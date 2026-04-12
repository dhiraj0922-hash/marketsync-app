-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: ai_import_logs
-- Run in Supabase SQL Editor. Safe to re-run — CREATE TABLE IF NOT EXISTS.
--
-- Stores every AI recipe import attempt for audit and debugging.
-- Includes raw AI response, parsed result, validation warnings,
-- and base64 image data URL for full auditability.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ai_import_logs (
  id              TEXT PRIMARY KEY,
  uploaded_by     TEXT,                         -- auth.uid() of the importing user
  image_data_url  TEXT,                         -- base64 data URL of uploaded image (audit)
  raw_ai_response JSONB,                        -- raw JSON returned by the AI model
  parsed_result   JSONB,                        -- normalized extraction result
  status          TEXT DEFAULT 'pending',       -- pending | complete | failed | reviewed
  validation_warnings JSONB DEFAULT '[]'::jsonb,-- warnings detected during normalization
  confirmed_rows  JSONB DEFAULT '[]'::jsonb,    -- rows the user confirmed (post-review)
  recipe_id       TEXT,                         -- set after user saves the recipe
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.ai_import_logs IS
  'Audit log for every AI recipe image import. Stores raw AI response, '
  'normalized extraction, and confirmed rows for debugging and traceability.';

-- Enable RLS — HQ admin only for audit log
ALTER TABLE public.ai_import_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "AI Import Logs: HQ Read/Write" ON public.ai_import_logs;

CREATE POLICY "AI Import Logs: HQ Read/Write"
  ON public.ai_import_logs
  FOR ALL
  TO authenticated
  USING  (public.is_hq_admin_profile())
  WITH CHECK (public.is_hq_admin_profile());

-- Verify
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'ai_import_logs'
ORDER BY ordinal_position;
