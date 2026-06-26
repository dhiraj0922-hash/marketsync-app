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
    -- updated_at is managed by Supabase moddatetime and changes automatically
    -- on every UPDATE — it is not an application-writable column and must
    -- not be blocked.
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
DECLARE
  v_col text;
BEGIN
  IF public.is_hq_fulfillment_profile() THEN
    -- updated_at is auto-stamped by Supabase moddatetime on every UPDATE.
    -- It must not be blocked or every hq_fulfillment write will be rejected.
    IF    NEW.id                    IS DISTINCT FROM OLD.id                    THEN v_col := 'id';
    ELSIF NEW.ticket_number         IS DISTINCT FROM OLD.ticket_number         THEN v_col := 'ticket_number';
    ELSIF NEW.requisition_id        IS DISTINCT FROM OLD.requisition_id        THEN v_col := 'requisition_id';
    ELSIF NEW.location_id           IS DISTINCT FROM OLD.location_id           THEN v_col := 'location_id';
    ELSIF NEW.stop_sequence         IS DISTINCT FROM OLD.stop_sequence         THEN v_col := 'stop_sequence';
    ELSIF NEW.destination_name      IS DISTINCT FROM OLD.destination_name      THEN v_col := 'destination_name';
    ELSIF NEW.destination_address   IS DISTINCT FROM OLD.destination_address   THEN v_col := 'destination_address';
    ELSIF NEW.destination_contact   IS DISTINCT FROM OLD.destination_contact   THEN v_col := 'destination_contact';
    ELSIF NEW.destination_phone     IS DISTINCT FROM OLD.destination_phone     THEN v_col := 'destination_phone';
    ELSIF NEW.estimated_arrival_time IS DISTINCT FROM OLD.estimated_arrival_time THEN v_col := 'estimated_arrival_time';
    ELSIF NEW.delivered_at          IS DISTINCT FROM OLD.delivered_at          THEN v_col := 'delivered_at';
    ELSIF NEW.received_by           IS DISTINCT FROM OLD.received_by           THEN v_col := 'received_by';
    ELSIF NEW.proof_photo_url       IS DISTINCT FROM OLD.proof_photo_url       THEN v_col := 'proof_photo_url';
    ELSIF NEW.signature_url         IS DISTINCT FROM OLD.signature_url         THEN v_col := 'signature_url';
    ELSIF NEW.notes                 IS DISTINCT FROM OLD.notes                 THEN v_col := 'notes';
    ELSIF NEW.created_by            IS DISTINCT FROM OLD.created_by            THEN v_col := 'created_by';
    ELSIF NEW.created_at            IS DISTINCT FROM OLD.created_at            THEN v_col := 'created_at';
    END IF;

    IF v_col IS NOT NULL THEN
      RAISE EXCEPTION
        'hq_fulfillment: unauthorized column change on delivery_tickets: "%%". '
        'Only status and delivery_run_id may be updated by this role.',
        v_col;
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

-- Requisition items update guard: hq_fulfillment can only update allocation / fulfillment columns.
CREATE OR REPLACE FUNCTION public.enforce_requisition_items_fulfillment_column_guards()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_col text;
BEGIN
  IF public.is_hq_fulfillment_profile() THEN
    -- updated_at is auto-stamped by Supabase moddatetime on every UPDATE.
    -- It must not be blocked or every hq_fulfillment write will be rejected.
    -- Allowed columns: allocated_qty, backorder_qty, quantity_fulfilled,
    --   fulfillment_note, fulfilled_by, fulfilled_at, updated_at (system-managed).
    IF    NEW.id                          IS DISTINCT FROM OLD.id                          THEN v_col := 'id';
    ELSIF NEW.requisition_id              IS DISTINCT FROM OLD.requisition_id              THEN v_col := 'requisition_id';
    ELSIF NEW.item_id                     IS DISTINCT FROM OLD.item_id                     THEN v_col := 'item_id';
    ELSIF NEW.finished_good_id            IS DISTINCT FROM OLD.finished_good_id            THEN v_col := 'finished_good_id';
    ELSIF NEW.catalog_item_id             IS DISTINCT FROM OLD.catalog_item_id             THEN v_col := 'catalog_item_id';
    ELSIF NEW.source_type                 IS DISTINCT FROM OLD.source_type                 THEN v_col := 'source_type';
    ELSIF NEW.supplier_snapshot           IS DISTINCT FROM OLD.supplier_snapshot           THEN v_col := 'supplier_snapshot';
    ELSIF NEW.pack_qty_snapshot           IS DISTINCT FROM OLD.pack_qty_snapshot           THEN v_col := 'pack_qty_snapshot';
    ELSIF NEW.item_name_snapshot          IS DISTINCT FROM OLD.item_name_snapshot          THEN v_col := 'item_name_snapshot';
    ELSIF NEW.unit_snapshot               IS DISTINCT FROM OLD.unit_snapshot               THEN v_col := 'unit_snapshot';
    ELSIF NEW.source_commissary_snapshot  IS DISTINCT FROM OLD.source_commissary_snapshot  THEN v_col := 'source_commissary_snapshot';
    ELSIF NEW.quantity_requested          IS DISTINCT FROM OLD.quantity_requested          THEN v_col := 'quantity_requested';
    ELSIF NEW.unit_price                  IS DISTINCT FROM OLD.unit_price                  THEN v_col := 'unit_price';
    ELSIF NEW.line_total                  IS DISTINCT FROM OLD.line_total                  THEN v_col := 'line_total';
    ELSIF NEW.created_at                  IS DISTINCT FROM OLD.created_at                  THEN v_col := 'created_at';
    END IF;

    IF v_col IS NOT NULL THEN
      RAISE EXCEPTION
        'hq_fulfillment: unauthorized column change on requisition_items: "%%". '
        'Only allocated_qty, backorder_qty, quantity_fulfilled, fulfillment_note, '
        'fulfilled_by, fulfilled_at may be updated by this role.',
        v_col;
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

-- ── 12. Add Approve / Reject audit columns to requisitions header ─────────────
-- SAFE: IF NOT EXISTS prevents failure when re-running the migration.
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS approved_by       uuid;
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS approved_at       timestamptz;
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS rejected_by       uuid;
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS rejected_at       timestamptz;
ALTER TABLE public.requisitions ADD COLUMN IF NOT EXISTS rejection_reason  text;

-- ── 13. Replace column-guard trigger for requisitions ─────────────────────────
-- Previous version only whitelisted `status`.
-- This version also whitelists the 5 new audit columns so that approve/reject
-- writes don't get blocked. All other columns remain protected.
CREATE OR REPLACE FUNCTION public.enforce_requisitions_fulfillment_column_guards()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_col text;
BEGIN
  IF public.is_hq_fulfillment_profile() THEN
    -- Fields that hq_fulfillment must NEVER touch.
    --
    -- updated_at: intentionally excluded — Supabase moddatetime auto-stamps it.
    -- total_amount: intentionally excluded — writeFulfilledAndRecalc() legitimately
    --   updates the fulfilled total on the requisitions header when completing
    --   fulfillment. Blocking it would prevent completeFulfillmentMovement().
    IF    NEW.id            IS DISTINCT FROM OLD.id            THEN v_col := 'id';
    ELSIF NEW.location      IS DISTINCT FROM OLD.location      THEN v_col := 'location';
    ELSIF NEW.requestedby   IS DISTINCT FROM OLD.requestedby   THEN v_col := 'requestedby';
    ELSIF NEW.date          IS DISTINCT FROM OLD.date          THEN v_col := 'date';
    ELSIF NEW.items         IS DISTINCT FROM OLD.items         THEN v_col := 'items';
    ELSIF NEW.notes         IS DISTINCT FROM OLD.notes         THEN v_col := 'notes';
    ELSIF NEW.lineitems     IS DISTINCT FROM OLD.lineitems     THEN v_col := 'lineitems';
    ELSIF NEW.created_at    IS DISTINCT FROM OLD.created_at    THEN v_col := 'created_at';
    ELSIF NEW.location_id   IS DISTINCT FROM OLD.location_id   THEN v_col := 'location_id';
    ELSIF NEW.created_by    IS DISTINCT FROM OLD.created_by    THEN v_col := 'created_by';
    END IF;

    IF v_col IS NOT NULL THEN
      RAISE EXCEPTION
        'hq_fulfillment: unauthorized column change on requisitions: "%%". '
        'Only status, approved_by, approved_at, rejected_by, rejected_at, '
        'rejection_reason may be updated by this role.',
        v_col;
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

-- ── 14. DB-level status-transition validation for hq_fulfillment ──────────────
-- Based on full codebase audit (2026-06-26):
--
-- STATUSES ACTUALLY WRITTEN TO requisitions.status:
--   'draft'             -- initial state / mock creation
--   'submitted'         -- outlet submits a requisition
--   'approved'          -- HQ approves; also written by finalizeRequisitionFulfillment
--                          when not all lines are fulfilled (stays approved).
--   'rejected'          -- HQ rejects (with mandatory rejection_reason)
--   'fulfilled'         -- completeFulfillmentMovement() and finalizeRequisitionFulfillment
--                          when all lines are fully fulfilled
--   'partial'           -- ONLY written by old saveRequisitions() bulk path used by
--                          hq_master/hq_ops; hq_fulfillment does NOT use this path
--   'backordered'       -- UI display filter only; not currently written by any JS path
--
-- STATUSES THAT ARE NOT WRITTEN TO requisitions.status:
--   'partially_fulfilled' -- only written to requisition_backorders.status (NOT the header)
--   'completed'           -- only used for delivery_run.status and vehicle logs
--   'pending'             -- only a UI read filter; not written
--
-- TRIGGER SCOPE:
--   Applies to hq_fulfillment only. hq_master / hq_ops / SECURITY DEFINER RPCs bypass.

CREATE OR REPLACE FUNCTION public.enforce_requisition_status_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_old text := lower(coalesce(OLD.status, ''));
  v_new text := lower(coalesce(NEW.status, ''));
BEGIN
  -- ── Bypass: only enforced for hq_fulfillment callers ──────────────────────
  -- hq_master, hq_ops, hq_admin bypass this trigger.
  -- SECURITY DEFINER RPCs (finalize_requisition_fulfillment_v3) also bypass
  -- because they run as the table owner role, not the calling user's role.
  IF NOT public.is_hq_fulfillment_profile() THEN
    RETURN NEW;
  END IF;

  -- ── No-op: status unchanged — always allow ────────────────────────────────
  -- finalizeRequisitionFulfillment writes approved→approved when not all done.
  IF v_new = v_old THEN
    RETURN NEW;
  END IF;

  -- ── APPROVE: submitted / pending / draft → approved ───────────────────────
  IF v_new = 'approved' AND v_old IN ('submitted', 'pending', 'draft') THEN
    RETURN NEW;
  END IF;

  -- ── REJECT: submitted / pending / draft → rejected ────────────────────────
  -- Mandatory rejection_reason enforced here AND in the application layer.
  IF v_new = 'rejected' AND v_old IN ('submitted', 'pending', 'draft') THEN
    IF coalesce(trim(NEW.rejection_reason), '') = '' THEN
      RAISE EXCEPTION 'rejection_reason is required when rejecting a requisition.';
    END IF;
    RETURN NEW;
  END IF;

  -- ── FULFILL: approved → fulfilled ─────────────────────────────────────────
  -- completeFulfillmentMovement() always transitions approved → fulfilled.
  -- Also accept from 'partial' and 'backordered' in case those statuses were
  -- written by hq_master flows before hq_fulfillment takes over.
  -- NOTE: 'partially_fulfilled' is NEVER written to requisitions.status;
  --       it is only written to requisition_backorders.status.
  IF v_new = 'fulfilled' AND v_old IN ('approved', 'partial', 'backordered') THEN
    RETURN NEW;
  END IF;

  -- ── BLOCK ALL OTHER TRANSITIONS ───────────────────────────────────────────
  RAISE EXCEPTION
    'hq_fulfillment: status transition from "%" to "%" is not permitted. '
    'Allowed: submitted/draft→approved, submitted/draft→rejected (requires reason), '
    'approved→fulfilled.',
    v_old, v_new;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_requisition_status_transitions ON public.requisitions;
CREATE TRIGGER trg_enforce_requisition_status_transitions
  BEFORE UPDATE OF status ON public.requisitions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_requisition_status_transitions();

-- ── 15. RLS for fg_count_sessions and fg_count_lines ─────────────────────────
-- The FG Count page uses these tables. hq_fulfillment must be able to
-- SELECT, INSERT, and UPDATE count records.

DO $$ BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'fg_count_sessions'
  ) THEN
    ALTER TABLE public.fg_count_sessions ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "FG Count Sessions: read by hq or fulfillment" ON public.fg_count_sessions;
    CREATE POLICY "FG Count Sessions: read by hq or fulfillment"
      ON public.fg_count_sessions FOR SELECT TO authenticated
      USING (public.is_hq_admin_profile() OR public.is_hq_fulfillment_profile());

    DROP POLICY IF EXISTS "FG Count Sessions: insert by hq or fulfillment" ON public.fg_count_sessions;
    CREATE POLICY "FG Count Sessions: insert by hq or fulfillment"
      ON public.fg_count_sessions FOR INSERT TO authenticated
      WITH CHECK (public.is_hq_admin_profile() OR public.is_hq_fulfillment_profile());

    DROP POLICY IF EXISTS "FG Count Sessions: update by hq or fulfillment" ON public.fg_count_sessions;
    CREATE POLICY "FG Count Sessions: update by hq or fulfillment"
      ON public.fg_count_sessions FOR UPDATE TO authenticated
      USING (public.is_hq_admin_profile() OR public.is_hq_fulfillment_profile())
      WITH CHECK (public.is_hq_admin_profile() OR public.is_hq_fulfillment_profile());
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'fg_count_lines'
  ) THEN
    ALTER TABLE public.fg_count_lines ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "FG Count Lines: read by hq or fulfillment" ON public.fg_count_lines;
    CREATE POLICY "FG Count Lines: read by hq or fulfillment"
      ON public.fg_count_lines FOR SELECT TO authenticated
      USING (public.is_hq_admin_profile() OR public.is_hq_fulfillment_profile());

    DROP POLICY IF EXISTS "FG Count Lines: insert by hq or fulfillment" ON public.fg_count_lines;
    CREATE POLICY "FG Count Lines: insert by hq or fulfillment"
      ON public.fg_count_lines FOR INSERT TO authenticated
      WITH CHECK (public.is_hq_admin_profile() OR public.is_hq_fulfillment_profile());

    DROP POLICY IF EXISTS "FG Count Lines: update by hq or fulfillment" ON public.fg_count_lines;
    CREATE POLICY "FG Count Lines: update by hq or fulfillment"
      ON public.fg_count_lines FOR UPDATE TO authenticated
      USING (public.is_hq_admin_profile() OR public.is_hq_fulfillment_profile())
      WITH CHECK (public.is_hq_admin_profile() OR public.is_hq_fulfillment_profile());
  END IF;
END $$;

-- hq_sale_items READ for FG Count page
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'hq_sale_items'
      AND policyname = 'HQ Sale Items: read by fulfillment'
  ) THEN
    CREATE POLICY "HQ Sale Items: read by fulfillment"
      ON public.hq_sale_items FOR SELECT TO authenticated
      USING (public.is_hq_admin_profile() OR public.is_hq_fulfillment_profile());
  END IF;
END $$;

-- ── 16. Delivery ticket run-assignment duplicate-prevention guard ──────────────
-- Prevents hq_fulfillment from overwriting an existing delivery_run_id without
-- first unassigning the ticket. hq_master / hq_ops are exempt.
CREATE OR REPLACE FUNCTION public.enforce_delivery_ticket_run_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT public.is_hq_fulfillment_profile() THEN
    RETURN NEW;
  END IF;

  -- Block reassignment: old run exists AND new run is different (not unassigning)
  IF NEW.delivery_run_id IS NOT NULL
     AND OLD.delivery_run_id IS NOT NULL
     AND NEW.delivery_run_id IS DISTINCT FROM OLD.delivery_run_id
  THEN
    RAISE EXCEPTION
      'Ticket is already assigned to run %. Unassign from the current run before reassigning.',
      OLD.delivery_run_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_delivery_ticket_run_assignment ON public.delivery_tickets;
CREATE TRIGGER trg_enforce_delivery_ticket_run_assignment
  BEFORE UPDATE OF delivery_run_id ON public.delivery_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_delivery_ticket_run_assignment();

-- ── 17. Post-migration verification queries ───────────────────────────────────
-- Run these in Supabase SQL Editor after applying the migration.
/*
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'requisitions'
  AND column_name IN ('approved_by','approved_at','rejected_by','rejected_at','rejection_reason')
ORDER BY column_name;

SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'public.requisitions'::regclass AND tgname LIKE 'trg_%'
ORDER BY tgname;

SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.delivery_tickets'::regclass
  AND tgname = 'trg_enforce_delivery_ticket_run_assignment';

SELECT user_id, email, role, is_active
FROM public.user_profiles WHERE role = 'hq_fulfillment';
*/
