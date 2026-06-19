-- ── 1. Update user_profiles role check constraint ──────────────────────────────
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_role_check 
  CHECK (role IN ('hq_admin', 'hq_ops', 'location_manager', 'driver', 'hq_fulfillment'));

-- ── 2. Add audit fields to requisition_items ──────────────────────────────────
ALTER TABLE public.requisition_items ADD COLUMN IF NOT EXISTS allocated_qty numeric NOT NULL DEFAULT 0;
ALTER TABLE public.requisition_items ADD COLUMN IF NOT EXISTS backorder_qty numeric NOT NULL DEFAULT 0;
ALTER TABLE public.requisition_items ADD COLUMN IF NOT EXISTS fulfillment_note text;
ALTER TABLE public.requisition_items ADD COLUMN IF NOT EXISTS fulfilled_by uuid;
ALTER TABLE public.requisition_items ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

-- ── 3. Create RLS helper function for hq_fulfillment ───────────────────────────
CREATE OR REPLACE FUNCTION public.is_hq_fulfillment_profile()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE user_id  = auth.uid()
      AND role     = 'hq_fulfillment'
      AND is_active = true
  );
$$;

REVOKE ALL ON FUNCTION public.is_hq_fulfillment_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_hq_fulfillment_profile() TO authenticated;

-- ── 4. Update Requisitions RLS Policy to allow hq_fulfillment ──────────────────
DROP POLICY IF EXISTS "Requisitions: Read by Role" ON public.requisitions;
CREATE POLICY "Requisitions: Read by Role"
  ON public.requisitions
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_hq_fulfillment_profile()
    OR
    public.is_location_manager_for(requisitions.location_id)
  );

-- ── 5. Update Inventory Items RLS Policy to allow hq_fulfillment ────────────────
DROP POLICY IF EXISTS "Inventory: Read by Role" ON public.inventory_items;
CREATE POLICY "Inventory: Read by Role"
  ON public.inventory_items
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_hq_fulfillment_profile()
    OR
    public.is_location_manager_for(inventory_items.location_id)
  );

-- ── 6. Update Counts RLS Policies to allow hq_fulfillment ─────────────────────
DROP POLICY IF EXISTS "Counts: Select by location" ON public.counts;
CREATE POLICY "Counts: Select by location"
  ON public.counts
  FOR SELECT
  TO authenticated
  USING (
    public.get_my_role() = 'hq_admin'
    OR
    public.get_my_role() = 'hq_fulfillment'
    OR
    counts.location_id = public.get_my_location_id()
  );

DROP POLICY IF EXISTS "Counts: Insert by location" ON public.counts;
CREATE POLICY "Counts: Insert by location"
  ON public.counts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.get_my_role() = 'hq_admin'
    OR
    public.get_my_role() = 'hq_fulfillment'
    OR
    counts.location_id = public.get_my_location_id()
  );

DROP POLICY IF EXISTS "Counts: Update by location" ON public.counts;
CREATE POLICY "Counts: Update by location"
  ON public.counts
  FOR UPDATE
  TO authenticated
  USING (
    public.get_my_role() = 'hq_admin'
    OR
    public.get_my_role() = 'hq_fulfillment'
    OR
    counts.location_id = public.get_my_location_id()
  )
  WITH CHECK (
    public.get_my_role() = 'hq_admin'
    OR
    public.get_my_role() = 'hq_fulfillment'
    OR
    counts.location_id = public.get_my_location_id()
  );
