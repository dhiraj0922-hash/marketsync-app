-- ─────────────────────────────────────────────────────────────────────────────
-- Menu Costing / Outlet Recipes module (Phase 1)
-- Additive only. Does not drop or modify existing tables.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. outlet_menu_costings table
CREATE TABLE IF NOT EXISTS public.outlet_menu_costings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id TEXT NOT NULL,
    item_name TEXT NOT NULL,
    category TEXT,
    selling_price NUMERIC NOT NULL DEFAULT 0,
    target_food_cost_percent NUMERIC NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'draft',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID
);

-- 2. outlet_menu_costing_components table
CREATE TABLE IF NOT EXISTS public.outlet_menu_costing_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    costing_id UUID NOT NULL REFERENCES public.outlet_menu_costings(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('finished_good','inventory_item')),
    source_item_id TEXT NOT NULL,
    item_name_snapshot TEXT,
    component_type TEXT NOT NULL DEFAULT 'main' CHECK (component_type IN ('main', 'packaging', 'garnish', 'finishing', 'other')),
    qty_used NUMERIC NOT NULL DEFAULT 0,
    unit TEXT,
    unit_cost_snapshot NUMERIC NOT NULL DEFAULT 0,
    line_cost NUMERIC NOT NULL DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Enable Row Level Security
ALTER TABLE public.outlet_menu_costings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outlet_menu_costing_components ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies for outlet_menu_costings
DROP POLICY IF EXISTS "hq_admin_all_costings" ON public.outlet_menu_costings;
CREATE POLICY "hq_admin_all_costings"
  ON public.outlet_menu_costings
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.role = 'hq_admin'
        AND up.is_active = true
    )
  );

DROP POLICY IF EXISTS "location_manager_all_costings" ON public.outlet_menu_costings;
CREATE POLICY "location_manager_all_costings"
  ON public.outlet_menu_costings
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.role = 'location_manager'
        AND up.is_active = true
        AND up.location_id = public.outlet_menu_costings.location_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.role = 'location_manager'
        AND up.is_active = true
        AND up.location_id = public.outlet_menu_costings.location_id
    )
  );

-- 5. RLS Policies for outlet_menu_costing_components
DROP POLICY IF EXISTS "hq_admin_all_components" ON public.outlet_menu_costing_components;
CREATE POLICY "hq_admin_all_components"
  ON public.outlet_menu_costing_components
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.role = 'hq_admin'
        AND up.is_active = true
    )
  );

DROP POLICY IF EXISTS "location_manager_all_components" ON public.outlet_menu_costing_components;
CREATE POLICY "location_manager_all_components"
  ON public.outlet_menu_costing_components
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.outlet_menu_costings mc
      JOIN public.user_profiles up ON up.location_id = mc.location_id
      WHERE mc.id = public.outlet_menu_costing_components.costing_id
        AND up.user_id = auth.uid()
        AND up.role = 'location_manager'
        AND up.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.outlet_menu_costings mc
      JOIN public.user_profiles up ON up.location_id = mc.location_id
      WHERE mc.id = public.outlet_menu_costing_components.costing_id
        AND up.user_id = auth.uid()
        AND up.role = 'location_manager'
        AND up.is_active = true
    )
  );
