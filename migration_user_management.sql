-- ─────────────────────────────────────────────────────────────────────────────
-- MIGRATION: User Management support additions
--
-- Prerequisites: migration_phase1_roles.sql must already have been applied
--                (user_profiles table must exist).
--
-- Run these in Supabase SQL Editor in order.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Step 1: Add phone column to user_profiles ─────────────────────────────────
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS phone TEXT NULL;

COMMENT ON COLUMN public.user_profiles.phone IS
  'Optional phone number for the user. Used in the HQ User Management UI.';


-- ── Step 2: Create a view that safely surfaces auth.users.email ───────────────
-- user_profiles does not store email (it lives in auth.users).
-- This view joins them so the management UI can display email without
-- making raw auth.users queries from the client.
--
-- NOTE: auth.users is only accessible from service-role context.
-- This view must be created by a superuser or via Supabase SQL Editor.
--
CREATE OR REPLACE VIEW public.user_profiles_with_email AS
SELECT
  p.id,
  p.user_id,
  p.full_name,
  p.phone,
  p.role,
  p.location_id,
  p.is_active,
  p.created_at,
  p.updated_at,
  u.email
FROM public.user_profiles p
LEFT JOIN auth.users u ON u.id = p.user_id;

COMMENT ON VIEW public.user_profiles_with_email IS
  'Safe join of user_profiles + auth.users.email. Used by loadUserProfiles() in the HQ management UI.';


-- ── Step 3: RLS — HQ admins may SELECT from the view ─────────────────────────
-- (If RLS is enabled on the view, add a permissive policy for hq_admin)
-- If you are using the service-role key in the API routes, this is not needed.
-- Uncomment if you want to allow direct anon/authenticated reads by hq_admins:

-- ALTER VIEW public.user_profiles_with_email OWNER TO authenticated;
-- CREATE POLICY "hq_admin can read all profiles"
--   ON public.user_profiles
--   FOR SELECT
--   USING (
--     EXISTS (
--       SELECT 1 FROM public.user_profiles p2
--       WHERE p2.user_id = auth.uid()
--         AND p2.role = 'hq_admin'
--         AND p2.is_active = true
--     )
--   );


-- ── Step 4: Verify ────────────────────────────────────────────────────────────
-- Check the view returns rows with email:
SELECT id, full_name, email, role, location_id, is_active, phone
FROM public.user_profiles_with_email
ORDER BY created_at DESC
LIMIT 20;

-- Check phone column was added:
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'user_profiles'
  AND table_schema = 'public'
ORDER BY ordinal_position;
