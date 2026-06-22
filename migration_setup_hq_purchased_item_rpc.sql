-- =============================================================================
-- migration_setup_hq_purchased_item_rpc.sql  (REVISED)
--
-- Creates public.setup_hq_purchased_item() — an atomic PostgreSQL function
-- that promotes one outlet_catalog_items row from local_vendor → hq_supplied
-- and activates the linked hq_sale_items row inside a single function call.
--
-- ATOMICITY
--   PostgreSQL wraps each function call that has not already started a
--   transaction in an implicit transaction.  Any RAISE EXCEPTION inside the
--   function body causes that implicit transaction to roll back in full.
--   Both UPDATE statements therefore either both commit or neither does.
--   This is NOT a SERIALIZABLE isolation level — it is the default READ
--   COMMITTED isolation, which is sufficient because both target rows are
--   locked with FOR UPDATE before any writes are made.
--
-- AUTHORIZATION
--   SECURITY DEFINER lets the function read user_profiles without triggering
--   RLS recursion.  The function itself enforces role restrictions by reading
--   the caller's role from user_profiles, matching the same pattern used by
--   finalize_requisition_fulfillment_v3.  Only hq_admin and hq_master may
--   perform this configuration action.  hq_ops, hq_fulfillment, driver, and
--   location_manager are all rejected.
--
-- SUPPLIER VALIDATION
--   p_source_commissary is normalized (lower-case, collapsed whitespace) and
--   matched against suppliers.normalized_name and suppliers.name_aliases[].
--   The matching supplier row must have fulfillment_model = 'hq_fulfillment_centre'.
--   Any other supplier — including unclassified — is rejected.
--
-- COLUMNS CONFIRMED IN LIVE DATABASE
--   hq_sale_items:         id, name, source_commissary, base_unit, pack_qty,
--                          manual_price, is_active, is_requisitionable,
--                          category, updated_at
--   outlet_catalog_items:  item_id, name, source_type, hq_sale_item_id,
--                          updated_at
--   suppliers:             id, name, normalized_name, name_aliases (TEXT[]),
--                          fulfillment_model
--   user_profiles:         user_id (UUID FK → auth.users.id), role TEXT,
--                          is_active BOOLEAN
--
-- HOW TO APPLY
--   Paste this entire file into the Supabase SQL Editor and click Run.
--   The RPC migration for the supplier foundation (migration_suppliers_foundation.sql)
--   must already be applied before this file is run.
--   Do NOT run until reviewed and approved by HQ admin.
-- =============================================================================


CREATE OR REPLACE FUNCTION public.setup_hq_purchased_item(
  p_hq_sale_item_id       TEXT,
  p_catalog_item_id       TEXT,
  p_name                  TEXT,
  p_source_commissary     TEXT,     -- display name; matched against suppliers table
  p_base_unit             TEXT,
  p_pack_qty              INTEGER,
  p_location_charge       NUMERIC,  -- manual_price charged to locations per pack
  p_is_active             BOOLEAN,
  p_is_requisitionable    BOOLEAN,
  p_category              TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid          UUID;
  v_caller_role         TEXT;
  v_supplier_id         INT;   -- resolved id for p_source_commissary
  v_catalog_supplier_id INT;   -- resolved id for v_catalog_item.supplier
  v_norm_input          TEXT;
  v_hq_item             hq_sale_items%ROWTYPE;
  v_catalog_item        outlet_catalog_items%ROWTYPE;
  v_conflict_id         TEXT;
BEGIN

  -- ── 1. AUTHORIZATION ────────────────────────────────────────────────────────
  --
  --    Read the calling user's UID from the JWT, then look up their role in
  --    user_profiles. This is the identical pattern used by
  --    finalize_requisition_fulfillment_v3.
  --
  --    Allowed:  hq_admin, hq_master
  --    Rejected: hq_ops (operational role, not configuration),
  --              hq_fulfillment (warehouse execution only),
  --              location_manager, driver, and any unrecognized role.

  v_caller_uid := auth.uid();

  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated. You must be signed in to perform this action.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT role INTO v_caller_role
  FROM public.user_profiles
  WHERE user_id   = v_caller_uid
    AND is_active = true
  LIMIT 1;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION
      'No active user profile found for caller %. Cannot authorize setup action.',
      v_caller_uid
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_caller_role NOT IN ('hq_admin', 'hq_master') THEN
    RAISE EXCEPTION
      'Permission denied: role "%" is not authorized to configure HQ Purchased Item mappings. '
      'Required role: hq_admin or hq_master.',
      v_caller_role
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- ── 2. INPUT VALIDATION (early, before any row locks) ──────────────────────

  IF p_hq_sale_item_id IS NULL OR trim(p_hq_sale_item_id) = '' THEN
    RAISE EXCEPTION 'p_hq_sale_item_id cannot be blank.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_catalog_item_id IS NULL OR trim(p_catalog_item_id) = '' THEN
    RAISE EXCEPTION 'p_catalog_item_id cannot be blank.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Item name cannot be blank.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_source_commissary IS NULL OR trim(p_source_commissary) = '' THEN
    RAISE EXCEPTION 'Supplier (source_commissary) cannot be blank.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_base_unit IS NULL OR trim(p_base_unit) = '' THEN
    RAISE EXCEPTION 'Base unit cannot be blank.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_pack_qty IS NULL OR p_pack_qty < 1 THEN
    RAISE EXCEPTION 'Pack quantity must be a whole number >= 1.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_location_charge IS NULL OR p_location_charge <= 0 THEN
    RAISE EXCEPTION 'Location charge (manual_price) must be greater than zero.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ── 3. SUPPLIER APPROVAL CHECK ──────────────────────────────────────────────
  --
  --    Normalize the supplied commissary name (trim, collapse spaces, lower-case)
  --    and match against:
  --      a) suppliers.normalized_name  (exact lower-case match)
  --      b) suppliers.name_aliases[]   (array containment)
  --
  --    The matched supplier row must have fulfillment_model = 'hq_fulfillment_centre'.
  --    Unclassified or local_vendor suppliers are rejected.

  v_norm_input := lower(regexp_replace(trim(p_source_commissary), '\s+', ' ', 'g'));

  SELECT id INTO v_supplier_id
  FROM public.suppliers
  WHERE fulfillment_model = 'hq_fulfillment_centre'
    AND (
      lower(regexp_replace(trim(normalized_name), '\s+', ' ', 'g')) = v_norm_input
      OR
      name_aliases @> ARRAY[v_norm_input]::TEXT[]
      OR
      lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = v_norm_input
    )
  LIMIT 1;

  IF v_supplier_id IS NULL THEN
    RAISE EXCEPTION
      'Supplier "%" is not configured as an HQ Fulfillment Centre supplier. '
      'Only suppliers with fulfillment_model = ''hq_fulfillment_centre'' may be used '
      'when setting up an HQ Purchased Item mapping. '
      'Update the supplier record in the Suppliers page first.',
      p_source_commissary
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── 4. LOCK AND VALIDATE THE HQ SALE ITEM ROW ──────────────────────────────
  --
  --    FOR UPDATE acquires a row-level lock, preventing any concurrent
  --    transaction from modifying this row until this function completes.

  SELECT * INTO v_hq_item
  FROM public.hq_sale_items
  WHERE id = p_hq_sale_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HQ Sale Item "%" not found. Cannot set up.', p_hq_sale_item_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ── 5. LOCK AND VALIDATE THE OUTLET CATALOG ITEM ROW ───────────────────────

  SELECT * INTO v_catalog_item
  FROM public.outlet_catalog_items
  WHERE item_id = p_catalog_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Catalog item "%" not found in outlet_catalog_items. Cannot set up.',
      p_catalog_item_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ── 6. BUSINESS RULE: catalog item supplier must match the selected HQ supplier ──
  --
  --    Resolve the catalog item's stored supplier field through the same
  --    three-way normalized lookup used in Step 3:
  --      a) suppliers.normalized_name
  --      b) suppliers.name_aliases[]
  --      c) normalized raw suppliers.name fallback
  --
  --    Both lookups must resolve to the same suppliers.id.
  --    This prevents an HQ admin from selecting a catalog item owned by
  --    supplier A while passing supplier B as p_source_commissary.
  --
  --    A NULL or blank catalog supplier field is treated as a non-match:
  --    the admin must correct the catalog record before setup can proceed.

  IF v_catalog_item.supplier IS NULL OR trim(v_catalog_item.supplier) = '' THEN
    RAISE EXCEPTION
      'Catalog item "%" (%) has no supplier recorded. '
      'Set the supplier on the catalog item before setting up HQ supply routing.',
      v_catalog_item.name, p_catalog_item_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_catalog_supplier_id
  FROM public.suppliers
  WHERE fulfillment_model = 'hq_fulfillment_centre'
    AND (
      lower(regexp_replace(trim(normalized_name), '\s+', ' ', 'g'))
        = lower(regexp_replace(trim(v_catalog_item.supplier), '\s+', ' ', 'g'))
      OR
      name_aliases @> ARRAY[
        lower(regexp_replace(trim(v_catalog_item.supplier), '\s+', ' ', 'g'))
      ]::TEXT[]
      OR
      lower(regexp_replace(trim(name), '\s+', ' ', 'g'))
        = lower(regexp_replace(trim(v_catalog_item.supplier), '\s+', ' ', 'g'))
    )
  LIMIT 1;

  IF v_catalog_supplier_id IS NULL OR v_catalog_supplier_id <> v_supplier_id THEN
    RAISE EXCEPTION
      'Supplier mismatch: catalog item "%" is recorded under supplier "%", '
      'but the selected HQ supplier is "%". '
      'These must be the same approved HQ Fulfillment Centre supplier. '
      'Select the correct approved supplier or correct the catalog supplier record first.',
      v_catalog_item.name,
      v_catalog_item.supplier,
      p_source_commissary
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── 7. BUSINESS RULE: catalog item must still be local_vendor ──────────────

  IF v_catalog_item.source_type <> 'local_vendor' THEN
    RAISE EXCEPTION
      'Catalog item "%" (%) has source_type = "%" — expected local_vendor. '
      'Setup aborted: this item may already be configured.',
      v_catalog_item.name, p_catalog_item_id, v_catalog_item.source_type
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── 8. BUSINESS RULE: catalog item must not already be linked ──────────────

  IF v_catalog_item.hq_sale_item_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Catalog item "%" (%) is already linked to HQ Sale Item "%". Setup aborted.',
      v_catalog_item.name, p_catalog_item_id, v_catalog_item.hq_sale_item_id
      USING ERRCODE = 'unique_violation';
  END IF;

  -- ── 9. BUSINESS RULE: HQ Sale Item must not be linked to a different catalog item ──

  SELECT item_id INTO v_conflict_id
  FROM public.outlet_catalog_items
  WHERE hq_sale_item_id = p_hq_sale_item_id
    AND item_id         <> p_catalog_item_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'HQ Sale Item "%" is already linked to catalog item "%". '
      'Each HQ Sale Item may only be linked to one catalog item. Setup aborted.',
      p_hq_sale_item_id, v_conflict_id
      USING ERRCODE = 'unique_violation';
  END IF;

  -- ── 10. UPDATE hq_sale_items ─────────────────────────────────────────────────
  --
  --    Fields written:  name, source_commissary, base_unit, pack_qty,
  --                     manual_price, is_active, is_requisitionable,
  --                     category (preserved if p_category is NULL), updated_at.
  --
  --    Fields NOT touched (guaranteed):
  --                     instock, making_cost, source_recipe_id,
  --                     source_recipe_yield_qty, suggested_price (generated),
  --                     par_level, created_at.

  UPDATE public.hq_sale_items SET
    name               = trim(p_name),
    source_commissary  = trim(p_source_commissary),
    base_unit          = trim(p_base_unit),
    pack_qty           = p_pack_qty,
    manual_price       = p_location_charge,
    is_active          = p_is_active,
    is_requisitionable = p_is_requisitionable,
    category           = CASE
                           WHEN p_category IS NOT NULL THEN p_category
                           ELSE category              -- preserve existing value
                         END,
    updated_at         = now()
  WHERE id = p_hq_sale_item_id;

  -- ── 11. UPDATE outlet_catalog_items ─────────────────────────────────────────
  --
  --     Only two columns change: source_type and hq_sale_item_id.
  --     Everything else (name, supplier, price, pack_qty, uom, category,
  --     ordering_enabled, is_active, scan_barcode, product_code, etc.)
  --     is preserved exactly as-is.

  UPDATE public.outlet_catalog_items SET
    source_type     = 'hq_supplied',
    hq_sale_item_id = p_hq_sale_item_id,
    updated_at      = now()
  WHERE item_id = p_catalog_item_id;

  -- ── 12. RETURN CONFIRMATION ──────────────────────────────────────────────────

  RETURN json_build_object(
    'ok',                 true,
    'hq_sale_item_id',    p_hq_sale_item_id,
    'catalog_item_id',    p_catalog_item_id,
    'name',               trim(p_name),
    'source_commissary',  trim(p_source_commissary),
    'base_unit',          trim(p_base_unit),
    'pack_qty',           p_pack_qty,
    'location_charge',    p_location_charge,
    'is_active',          p_is_active,
    'is_requisitionable', p_is_requisitionable,
    'performed_by_role',  v_caller_role
  );

  -- Any unhandled exception raised above or from the UPDATE statements causes
  -- PostgreSQL to roll back all writes made within this function call.
  -- No EXCEPTION block is needed to guarantee rollback — it is automatic.

END;
$$;


-- ── PERMISSIONS ────────────────────────────────────────────────────────────────
--
--  SECURITY DEFINER: runs as the function owner (postgres / service role).
--  This is required so the function can read user_profiles without RLS
--  recursion, and can write to hq_sale_items (which has RLS disabled) and
--  outlet_catalog_items under RLS.
--
--  EXECUTE is granted only to the authenticated role.  Unauthenticated
--  (anon) callers cannot call this function at all.
--
--  Authorization inside the function body (step 1) is the real guard:
--  any authenticated user who is not hq_admin or hq_master receives an
--  insufficient_privilege error before any row is touched.

REVOKE ALL ON FUNCTION public.setup_hq_purchased_item(
  TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, NUMERIC, BOOLEAN, BOOLEAN, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.setup_hq_purchased_item(
  TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, NUMERIC, BOOLEAN, BOOLEAN, TEXT
) TO authenticated;


-- ── POST-APPLY VERIFICATION ────────────────────────────────────────────────────
-- Run these queries immediately after applying to confirm the function exists
-- and permissions are correct.

-- SELECT proname, proargnames, prosecdef, proowner::regrole
-- FROM pg_proc
-- WHERE proname = 'setup_hq_purchased_item'
--   AND pronamespace = 'public'::regnamespace;

-- SELECT grantee, privilege_type
-- FROM information_schema.routine_privileges
-- WHERE routine_name   = 'setup_hq_purchased_item'
--   AND routine_schema = 'public';
