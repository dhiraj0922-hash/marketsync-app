-- =================================================================================
-- PHASE 4: SUPABASE ROW LEVEL SECURITY (RLS) POLICIES
-- Target Runtime: Supabase SQL Editor
--
-- DO NOT RUN IF SYSTEM_USERS TABLE IS DROPPED.
-- RUN THIS ENTIRE FILE AT ONCE.
-- =================================================================================

-- ========================================================
-- 1. SECURITY DEFINERS & TEMPORARY BOOTSTRAP OVERRIDE
-- ========================================================

-- TEMPORARY ADMIN BOOTSTRAP: 
-- This clearly hardcoded path ensures 'dhiraj0922@gmail.com' bypasses 
-- ALL restrictions until removed. Long-term mapping natively transitions
-- fully to the `system_users.role` logic mapping once proven safe.
CREATE OR REPLACE FUNCTION is_temp_admin()
RETURNS BOOLEAN AS $$
  SELECT (auth.jwt() ->> 'email') = 'dhiraj0922@gmail.com';
$$ LANGUAGE sql STABLE SECURITY DEFINER;


-- Look up a user's role from their system_users identity.
-- `SECURITY DEFINER` bypasses RLS dynamically, removing recursion traps while fetching.
CREATE OR REPLACE FUNCTION get_session_role()
RETURNS TEXT AS $$
  SELECT role FROM system_users WHERE email = (auth.jwt() ->> 'email') LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;


-- Look up locations array natively (Wait, Postgres handles JSONB safely).
CREATE OR REPLACE FUNCTION get_session_locations()
RETURNS JSONB AS $$
  SELECT assignedLocations FROM system_users WHERE email = (auth.jwt() ->> 'email') LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;


-- Helper Logic Constraints
CREATE OR REPLACE FUNCTION is_hq() RETURNS BOOLEAN AS $$
  SELECT get_session_role() IN ('HQ Admin', 'HQ Manager') OR is_temp_admin();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_finance() RETURNS BOOLEAN AS $$
  SELECT get_session_role() = 'Finance / Purchasing' OR is_temp_admin();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_kitchen() RETURNS BOOLEAN AS $$
  SELECT get_session_role() IN ('Kitchen Staff', 'HQ Admin', 'HQ Manager') OR is_temp_admin();
$$ LANGUAGE sql STABLE;


-- ========================================================
-- 2. ENABLE RLS
-- ========================================================

ALTER TABLE system_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;

-- ========================================================
-- 3. APPLY RULES: SYSTEM_USERS
-- ========================================================
-- Reads: Everyone can see all users (needed to route orders, view assignments, etc.)
CREATE POLICY "Users: Universal Read" ON system_users FOR SELECT USING (true);
-- Writes: Only HQ & Temporary Admin can edit users.
CREATE POLICY "Users: HQ Write" ON system_users FOR ALL USING (is_hq()) WITH CHECK (is_hq());

-- ========================================================
-- 4. APPLY RULES: LOCATIONS
-- ========================================================
-- Reads: Universal visibility.
CREATE POLICY "Locations: Universal Read" ON locations FOR SELECT USING (true);
-- Writes: Only HQ.
CREATE POLICY "Locations: HQ Write" ON locations FOR ALL USING (is_hq()) WITH CHECK (is_hq());

-- ========================================================
-- 5. APPLY RULES: SUPPLIERS
-- ========================================================
-- Reads: Everyone but Kitchen (Kitchen generally doesn't care about Vendor terms). 
CREATE POLICY "Suppliers: Operational Read" ON suppliers FOR SELECT USING (
  is_temp_admin() OR get_session_role() IN ('HQ Admin', 'HQ Manager', 'Location Manager', 'Finance / Purchasing')
);
-- Writes: HQ + Finance
CREATE POLICY "Suppliers: Operations Write" ON suppliers FOR ALL USING (
  is_temp_admin() OR is_hq() OR is_finance()
) WITH CHECK (
  is_temp_admin() OR is_hq() OR is_finance()
);

-- ========================================================
-- 6. APPLY RULES: INVENTORY ITEMS
-- ========================================================
CREATE POLICY "Inventory: Universal Read" ON inventory_items FOR SELECT USING (true);
CREATE POLICY "Inventory: Managed Write" ON inventory_items FOR ALL USING (
  is_temp_admin() OR is_hq() OR is_finance()
) WITH CHECK (
  is_temp_admin() OR is_hq() OR is_finance()
);

-- ========================================================
-- 7. APPLY RULES: RECIPES
-- ========================================================
CREATE POLICY "Recipes: Universal Read" ON recipes FOR SELECT USING (true);
CREATE POLICY "Recipes: Central Write" ON recipes FOR ALL USING (is_hq() OR is_temp_admin()) WITH CHECK (is_hq() OR is_temp_admin());

-- ========================================================
-- 8. APPLY RULES: PRODUCTION (PLANS + HISTORY)
-- ========================================================
-- Reads: Everyone involved in operation (Loc Mgrs read, Kitchen writes, HQ administers)
CREATE POLICY "Production Plans: Operational Read" ON production_plans FOR SELECT USING (true);
CREATE POLICY "Production Plans: Kitchen Write" ON production_plans FOR ALL USING (
  is_kitchen() OR is_temp_admin()
) WITH CHECK (
  is_kitchen() OR is_temp_admin()
);

CREATE POLICY "Production History: Operational Read" ON production_history FOR SELECT USING (true);
CREATE POLICY "Production History: Kitchen Write" ON production_history FOR ALL USING (
  is_kitchen() OR is_temp_admin()
) WITH CHECK (
  is_kitchen() OR is_temp_admin()
);

-- ========================================================
-- 9. APPLY RULES: REQUISITIONS
-- ========================================================
-- Location Managers should ideally only filter to their location logic, but on SELECT we'll
-- leave it open if the UI handles it OR restrict strictly using JSONB tracking.
-- Note: A simpler phase 1 approach allows HQ complete Write + Reads.
CREATE POLICY "Requisitions: Read Access" ON requisitions FOR SELECT USING (true);

-- Writes allowed by HQ, OR if the user is a Location Manager (they can create them natively).
CREATE POLICY "Requisitions: Location and HQ Write" ON requisitions FOR ALL USING (
  is_hq() OR is_temp_admin() OR get_session_role() = 'Location Manager'
) WITH CHECK (
  is_hq() OR is_temp_admin() OR get_session_role() = 'Location Manager'
);

-- ========================================================
-- 10. APPLY RULES: COUNTS (Audits)
-- ========================================================
CREATE POLICY "Counts: Read Access" ON counts FOR SELECT USING (
  is_temp_admin() OR is_hq() OR is_finance() OR get_session_role() = 'Location Manager'
);
CREATE POLICY "Counts: Location Write" ON counts FOR ALL USING (
  is_temp_admin() OR is_hq() OR get_session_role() = 'Location Manager'
) WITH CHECK (
  is_temp_admin() OR is_hq() OR get_session_role() = 'Location Manager'
);

-- ========================================================
-- 11. APPLY RULES: ORDERS (Purchasing)
-- ========================================================
CREATE POLICY "Orders: Operational Read" ON orders FOR SELECT USING (
  is_temp_admin() OR is_hq() OR is_finance() OR get_session_role() = 'Location Manager'
);
CREATE POLICY "Orders: Procurement Write" ON orders FOR ALL USING (
  is_temp_admin() OR is_hq() OR is_finance()
) WITH CHECK (
  is_temp_admin() OR is_hq() OR is_finance()
);

-- ========================================================
-- 12. APPLY RULES: LOGISTICS (Activity + Import Batches)
-- ========================================================
CREATE POLICY "Inventory Activity: ReadAccess" ON inventory_activity FOR SELECT USING (true);
CREATE POLICY "Inventory Activity: Log Access" ON inventory_activity FOR ALL USING (true) WITH CHECK (true);

-- Import batches are strictly backend Finance / Admin territory
CREATE POLICY "Import Batches: Private Full" ON import_batches FOR ALL USING (
  is_temp_admin() OR is_hq() OR is_finance()
) WITH CHECK (
  is_temp_admin() OR is_hq() OR is_finance()
);

-- =================================================================================
-- VERIFICATION END
-- =================================================================================
