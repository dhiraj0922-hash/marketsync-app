-- ── 1. Update user_profiles role check constraint ──────────────────────────────
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_role_check 
  CHECK (role IN ('hq_admin', 'hq_master', 'hq_ops', 'location_manager', 'driver', 'hq_fulfillment'));

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

-- ── 4. Update Requisitions RLS Policies to allow hq_fulfillment ──────────────────
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

DROP POLICY IF EXISTS "Requisitions: Update by Role" ON public.requisitions;
CREATE POLICY "Requisitions: Update by Role"
  ON public.requisitions
  FOR UPDATE
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_hq_fulfillment_profile()
    OR
    public.is_location_manager_for(requisitions.location_id)
  )
  WITH CHECK (
    public.is_hq_admin_profile()
    OR
    public.is_hq_fulfillment_profile()
    OR
    public.is_location_manager_for(requisitions.location_id)
  );

-- ── 5. Update Inventory Items RLS Policies to allow hq_fulfillment ────────────────
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

DROP POLICY IF EXISTS "Inventory: Write by Role" ON public.inventory_items;
CREATE POLICY "Inventory: Write by Role"
  ON public.inventory_items
  FOR ALL
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_location_manager_for(inventory_items.location_id)
  )
  WITH CHECK (
    public.is_hq_admin_profile()
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

-- ── 7. Update Delivery Runs SELECT Policy to allow hq_fulfillment ────────────────
DROP POLICY IF EXISTS "Delivery Runs: Read for Fulfillment" ON public.delivery_runs;
CREATE POLICY "Delivery Runs: Read for Fulfillment"
  ON public.delivery_runs
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_hq_fulfillment_profile()
  );

-- ── 8. Update Delivery Tickets RLS Policies to allow hq_fulfillment ────────────────
DROP POLICY IF EXISTS "Delivery Tickets: Read by Role" ON public.delivery_tickets;
CREATE POLICY "Delivery Tickets: Read by Role"
  ON public.delivery_tickets
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_hq_fulfillment_profile()
    OR
    public.is_location_manager_for(delivery_tickets.location_id)
  );

DROP POLICY IF EXISTS "Delivery Tickets: HQ fulfillment insert" ON public.delivery_tickets;
CREATE POLICY "Delivery Tickets: HQ fulfillment insert"
  ON public.delivery_tickets
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_hq_fulfillment_profile());

DROP POLICY IF EXISTS "Delivery Tickets: HQ fulfillment update" ON public.delivery_tickets;
CREATE POLICY "Delivery Tickets: HQ fulfillment update"
  ON public.delivery_tickets
  FOR UPDATE
  TO authenticated
  USING (public.is_hq_fulfillment_profile())
  WITH CHECK (public.is_hq_fulfillment_profile());

-- ── 9. Update Delivery Ticket Items RLS Policies to allow hq_fulfillment ───────────
DROP POLICY IF EXISTS "Delivery Ticket Items: Read by Role" ON public.delivery_ticket_items;
CREATE POLICY "Delivery Ticket Items: Read by Role"
  ON public.delivery_ticket_items
  FOR SELECT
  TO authenticated
  USING (
    public.is_hq_admin_profile()
    OR
    public.is_hq_fulfillment_profile()
    OR EXISTS (
      SELECT 1
      FROM public.delivery_tickets dt
      WHERE dt.id = delivery_ticket_items.delivery_ticket_id
        AND public.is_location_manager_for(dt.location_id)
    )
  );

DROP POLICY IF EXISTS "Delivery Ticket Items: HQ fulfillment insert" ON public.delivery_ticket_items;
CREATE POLICY "Delivery Ticket Items: HQ fulfillment insert"
  ON public.delivery_ticket_items
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_hq_fulfillment_profile());

DROP POLICY IF EXISTS "Delivery Ticket Items: HQ fulfillment update" ON public.delivery_ticket_items;
CREATE POLICY "Delivery Ticket Items: HQ fulfillment update"
  ON public.delivery_ticket_items
  FOR UPDATE
  TO authenticated
  USING (public.is_hq_fulfillment_profile())
  WITH CHECK (public.is_hq_fulfillment_profile());

-- ── 10. Security Definer Stock Transfer RPC ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.transfer_inventory_stock_definer(
  p_shared_item_id text,
  p_from_location_id text,
  p_to_location_id text,
  p_qty numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_from_row record;
  v_to_row record;
BEGIN
  -- 1. Authorization check
  IF NOT (
    public.is_hq_admin_profile()
    OR
    public.is_hq_fulfillment_profile()
    OR (
      public.is_location_manager_for(p_from_location_id)
      AND public.is_location_manager_for(p_to_location_id)
    )
  ) THEN
    RAISE EXCEPTION 'Unauthorized to transfer stock';
  END IF;

  -- 2. Fetch and lock from row
  SELECT * INTO v_from_row
  FROM public.inventory_items
  WHERE item_id = p_shared_item_id
    AND location_id = p_from_location_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source inventory item not found for item_id % at location %', p_shared_item_id, p_from_location_id;
  END IF;

  IF v_from_row.instock < p_qty THEN
    RAISE EXCEPTION 'Insufficient stock. Available: %, requested: %', v_from_row.instock, p_qty;
  END IF;

  -- 3. Deduct from source
  UPDATE public.inventory_items
  SET instock = instock - p_qty
  WHERE id = v_from_row.id;

  -- 4. Check if destination row exists
  SELECT * INTO v_to_row
  FROM public.inventory_items
  WHERE item_id = p_shared_item_id
    AND location_id = p_to_location_id
  FOR UPDATE;

  IF FOUND THEN
    -- Update existing dest row
    UPDATE public.inventory_items
    SET instock = instock + p_qty
    WHERE id = v_to_row.id;
  ELSE
    -- Insert new dest row using source fields as template
    INSERT INTO public.inventory_items (
      id, item_id, location_id, instock, name, category, itemtype, baseunit, unit, parlevel, cost, supplierid, pricetrend, priceincrease, purchaseunits
    ) VALUES (
      gen_random_uuid()::text, p_shared_item_id, p_to_location_id, p_qty,
      v_from_row.name, v_from_row.category, v_from_row.itemtype, v_from_row.baseunit, v_from_row.unit, v_from_row.parlevel, v_from_row.cost, v_from_row.supplierid, v_from_row.pricetrend, v_from_row.priceincrease, v_from_row.purchaseunits
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_inventory_stock_definer(text, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_inventory_stock_definer(text, text, text, numeric) TO authenticated;

-- ── 11. Column-Level Triggers for hq_fulfillment Updates ────────────────────────
-- Requisitions update guard: hq_fulfillment can only update status.
CREATE OR REPLACE FUNCTION public.enforce_requisitions_fulfillment_column_guards()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.is_hq_fulfillment_profile() THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR
       NEW.location IS DISTINCT FROM OLD.location OR
       NEW.requestedby IS DISTINCT FROM OLD.requestedby OR
       NEW.date IS DISTINCT FROM OLD.date OR
       NEW.items IS DISTINCT FROM OLD.items OR
       NEW.notes IS DISTINCT FROM OLD.notes OR
       NEW.lineitems IS DISTINCT FROM OLD.lineitems OR
       NEW.created_at IS DISTINCT FROM OLD.created_at OR
       NEW.location_id IS DISTINCT FROM OLD.location_id OR
       NEW.created_by IS DISTINCT FROM OLD.created_by OR
       NEW.updated_at IS DISTINCT FROM OLD.updated_at OR
       NEW.total_amount IS DISTINCT FROM OLD.total_amount
    THEN
      RAISE EXCEPTION 'hq_fulfillment role is only allowed to update the status column on requisitions.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_requisitions_fulfillment_column_guards ON public.requisitions;
CREATE TRIGGER trg_enforce_requisitions_fulfillment_column_guards
  BEFORE UPDATE ON public.requisitions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_requisitions_fulfillment_column_guards();

-- Delivery tickets update guard: hq_fulfillment can only update status or delivery_run_id.
CREATE OR REPLACE FUNCTION public.enforce_delivery_tickets_fulfillment_column_guards()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.is_hq_fulfillment_profile() THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR
       NEW.ticket_number IS DISTINCT FROM OLD.ticket_number OR
       NEW.requisition_id IS DISTINCT FROM OLD.requisition_id OR
       NEW.location_id IS DISTINCT FROM OLD.location_id OR
       NEW.stop_sequence IS DISTINCT FROM OLD.stop_sequence OR
       NEW.destination_name IS DISTINCT FROM OLD.destination_name OR
       NEW.destination_address IS DISTINCT FROM OLD.destination_address OR
       NEW.destination_contact IS DISTINCT FROM OLD.destination_contact OR
       NEW.destination_phone IS DISTINCT FROM OLD.destination_phone OR
       NEW.estimated_arrival_time IS DISTINCT FROM OLD.estimated_arrival_time OR
       NEW.delivered_at IS DISTINCT FROM OLD.delivered_at OR
       NEW.received_by IS DISTINCT FROM OLD.received_by OR
       NEW.proof_photo_url IS DISTINCT FROM OLD.proof_photo_url OR
       NEW.signature_url IS DISTINCT FROM OLD.signature_url OR
       NEW.notes IS DISTINCT FROM OLD.notes OR
       NEW.created_by IS DISTINCT FROM OLD.created_by OR
       NEW.created_at IS DISTINCT FROM OLD.created_at OR
       NEW.updated_at IS DISTINCT FROM OLD.updated_at
    THEN
      RAISE EXCEPTION 'hq_fulfillment role is only allowed to update status and delivery_run_id on delivery tickets.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_delivery_tickets_fulfillment_column_guards ON public.delivery_tickets;
CREATE TRIGGER trg_enforce_delivery_tickets_fulfillment_column_guards
  BEFORE UPDATE ON public.delivery_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_delivery_tickets_fulfillment_column_guards();

-- Requisition items update guard: hq_fulfillment can only update allocations / note columns.
CREATE OR REPLACE FUNCTION public.enforce_requisition_items_fulfillment_column_guards()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.is_hq_fulfillment_profile() THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR
       NEW.requisition_id IS DISTINCT FROM OLD.requisition_id OR
       NEW.item_id IS DISTINCT FROM OLD.item_id OR
       NEW.finished_good_id IS DISTINCT FROM OLD.finished_good_id OR
       NEW.catalog_item_id IS DISTINCT FROM OLD.catalog_item_id OR
       NEW.source_type IS DISTINCT FROM OLD.source_type OR
       NEW.supplier_snapshot IS DISTINCT FROM OLD.supplier_snapshot OR
       NEW.pack_qty_snapshot IS DISTINCT FROM OLD.pack_qty_snapshot OR
       NEW.item_name_snapshot IS DISTINCT FROM OLD.item_name_snapshot OR
       NEW.unit_snapshot IS DISTINCT FROM OLD.unit_snapshot OR
       NEW.source_commissary_snapshot IS DISTINCT FROM OLD.source_commissary_snapshot OR
       NEW.quantity_requested IS DISTINCT FROM OLD.quantity_requested OR
       NEW.unit_price IS DISTINCT FROM OLD.unit_price OR
       NEW.line_total IS DISTINCT FROM OLD.line_total OR
       NEW.created_at IS DISTINCT FROM OLD.created_at OR
       NEW.updated_at IS DISTINCT FROM OLD.updated_at
    THEN
      RAISE EXCEPTION 'hq_fulfillment role is only allowed to update allocated_qty, backorder_qty, quantity_fulfilled, fulfillment_note, fulfilled_by, and fulfilled_at columns.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_requisition_items_fulfillment_column_guards ON public.requisition_items;
CREATE TRIGGER trg_enforce_requisition_items_fulfillment_column_guards
  BEFORE UPDATE ON public.requisition_items
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_requisition_items_fulfillment_column_guards();
