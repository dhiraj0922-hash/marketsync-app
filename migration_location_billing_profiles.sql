-- Create location billing profiles table
CREATE TABLE IF NOT EXISTS public.location_billing_profiles (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id            TEXT UNIQUE NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    legal_name             TEXT,
    incorporation_address  TEXT,
    billing_address        TEXT,
    billing_city           TEXT,
    billing_province       TEXT,
    billing_postal_code    TEXT,
    hst_number             TEXT,
    business_number        TEXT,
    billing_email          TEXT,
    invoice_contact_name   TEXT,
    
    -- Store physical details
    store_address          TEXT,
    store_city             TEXT,
    store_province         TEXT,
    store_postal_code      TEXT,
    store_phone            TEXT,
    store_manager_name     TEXT,
    
    created_at             TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at             TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Register update timestamp trigger
DROP TRIGGER IF EXISTS location_billing_profiles_set_updated_at ON public.location_billing_profiles;
CREATE TRIGGER location_billing_profiles_set_updated_at
  BEFORE UPDATE ON public.location_billing_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Enforce Row Level Security (RLS)
ALTER TABLE public.location_billing_profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies for clean runs
DROP POLICY IF EXISTS "Billing: HQ Admin Write" ON public.location_billing_profiles;
DROP POLICY IF EXISTS "Billing: Location Manager Read Own" ON public.location_billing_profiles;

-- RLS Policy 1: HQ admins can perform all CRUD actions
CREATE POLICY "Billing: HQ Admin Write"
  ON public.location_billing_profiles
  FOR ALL
  USING (public.is_hq_admin_profile())
  WITH CHECK (public.is_hq_admin_profile());

-- RLS Policy 2: Location Managers can read their own location billing profile
CREATE POLICY "Billing: Location Manager Read Own"
  ON public.location_billing_profiles
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.is_active = true
        AND up.location_id = location_billing_profiles.location_id
    )
  );
