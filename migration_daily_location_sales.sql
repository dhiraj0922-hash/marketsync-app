-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: Daily Location Sales and Gratuity tracking module
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Table 1: location_daily_sales ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.location_daily_sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id TEXT NOT NULL,
  sales_date DATE NOT NULL,
  pos_sales NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (pos_sales >= 0),
  uber_sales NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (uber_sales >= 0),
  online_sales NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (online_sales >= 0),
  catering_sales NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (catering_sales >= 0),
  skip_sales NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (skip_sales >= 0),
  doordash_sales NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (doordash_sales >= 0),
  notes TEXT NULL,
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add unique constraint to prevent duplicate rows for the same location and sales date
ALTER TABLE public.location_daily_sales
  DROP CONSTRAINT IF EXISTS location_daily_sales_unique_loc_date;

ALTER TABLE public.location_daily_sales
  ADD CONSTRAINT location_daily_sales_unique_loc_date UNIQUE (location_id, sales_date);

-- Enable RLS
ALTER TABLE public.location_daily_sales ENABLE ROW LEVEL SECURITY;

-- ── Table 2: location_sales_gratuity_settings ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.location_sales_gratuity_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pos_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (pos_percent >= 0 AND pos_percent <= 10.00),
  uber_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (uber_percent >= 0 AND uber_percent <= 10.00),
  online_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (online_percent >= 0 AND online_percent <= 10.00),
  catering_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (catering_percent >= 0 AND catering_percent <= 10.00),
  skip_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (skip_percent >= 0 AND skip_percent <= 10.00),
  doordash_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (doordash_percent >= 0 AND doordash_percent <= 10.00),
  updated_by UUID NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.location_sales_gratuity_settings ENABLE ROW LEVEL SECURITY;

-- ── RLS Policies for location_daily_sales ────────────────────────────────────
DROP POLICY IF EXISTS "hq_admin can perform all actions on daily sales" ON public.location_daily_sales;
CREATE POLICY "hq_admin can perform all actions on daily sales"
  ON public.location_daily_sales
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.role = 'hq_admin'
        AND up.is_active = true
    )
  );

DROP POLICY IF EXISTS "location_manager can perform all actions on own daily sales" ON public.location_daily_sales;
CREATE POLICY "location_manager can perform all actions on own daily sales"
  ON public.location_daily_sales
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.role = 'location_manager'
        AND up.is_active = true
        AND up.location_id = public.location_daily_sales.location_id
    )
  );

-- ── RLS Policies for location_sales_gratuity_settings ───────────────────────
DROP POLICY IF EXISTS "anyone can read gratuity settings" ON public.location_sales_gratuity_settings;
CREATE POLICY "anyone can read gratuity settings"
  ON public.location_sales_gratuity_settings
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "hq_admin can update gratuity settings" ON public.location_sales_gratuity_settings;
CREATE POLICY "hq_admin can update gratuity settings"
  ON public.location_sales_gratuity_settings
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.role = 'hq_admin'
        AND up.is_active = true
    )
  );

-- ── Seed initial single row of gratuity settings if empty ────────────────────
INSERT INTO public.location_sales_gratuity_settings (id, pos_percent, uber_percent, online_percent, catering_percent, skip_percent, doordash_percent)
VALUES ('00000000-0000-0000-0000-000000000000', 0.00, 0.00, 0.00, 0.00, 0.00, 0.00)
ON CONFLICT (id) DO NOTHING;
