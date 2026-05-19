-- FG Count Sessions
-- Lightweight additive tables for date/session count sheets.

CREATE TABLE IF NOT EXISTS public.fg_count_sessions (
  id TEXT PRIMARY KEY,
  count_date DATE NOT NULL,
  session_name TEXT,
  counted_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  counted_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.fg_count_lines (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES public.fg_count_sessions(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  item_name TEXT,
  unit TEXT,
  system_qty NUMERIC NOT NULL DEFAULT 0,
  physical_qty NUMERIC NOT NULL DEFAULT 0,
  variance_qty NUMERIC NOT NULL DEFAULT 0,
  unit_cost NUMERIC NOT NULL DEFAULT 0,
  variance_value NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_fg_count_sessions_date
  ON public.fg_count_sessions (count_date DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_fg_count_lines_session
  ON public.fg_count_lines (session_id);

ALTER TABLE public.fg_count_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.fg_count_lines DISABLE ROW LEVEL SECURITY;
