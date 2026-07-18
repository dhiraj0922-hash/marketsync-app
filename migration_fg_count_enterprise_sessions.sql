-- =============================================================================
-- Finished Goods Count Enterprise Sessions
-- Additive migration. Safe to run after migration_fg_count_sessions.sql.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.fg_count_sessions
  ADD COLUMN IF NOT EXISTS location_id TEXT NOT NULL DEFAULT 'LOC-HQ',
  ADD COLUMN IF NOT EXISTS location_name TEXT,
  ADD COLUMN IF NOT EXISTS business_date DATE,
  ADD COLUMN IF NOT EXISTS count_type TEXT NOT NULL DEFAULT 'Closing Count',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS counter_name TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_by_name TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by_name TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS posted_by_name TEXT,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_by_name TEXT,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by_name TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS total_items INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counted_items INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS variance_items INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expected_value NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS physical_value NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS variance_value NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gain_value NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loss_value NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS posted_movement_count INTEGER NOT NULL DEFAULT 0;

UPDATE public.fg_count_sessions
SET business_date = COALESCE(business_date, count_date),
    status = LOWER(COALESCE(status, 'draft')),
    location_id = COALESCE(NULLIF(location_id, ''), 'LOC-HQ')
WHERE business_date IS NULL OR status IS NULL OR location_id IS NULL;

ALTER TABLE public.fg_count_sessions
  ALTER COLUMN business_date SET DEFAULT CURRENT_DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fg_count_sessions_status_check'
      AND conrelid = 'public.fg_count_sessions'::regclass
  ) THEN
    ALTER TABLE public.fg_count_sessions
      ADD CONSTRAINT fg_count_sessions_status_check
      CHECK (status IN ('draft','submitted','approved','rejected','cancelled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fg_count_sessions_count_type_check'
      AND conrelid = 'public.fg_count_sessions'::regclass
  ) THEN
    ALTER TABLE public.fg_count_sessions
      ADD CONSTRAINT fg_count_sessions_count_type_check
      CHECK (count_type IN ('Opening Count','Closing Count','Weekly Count','Monthly Count','Cycle Count','Spot Audit'));
  END IF;
END $$;

ALTER TABLE public.fg_count_lines
  ADD COLUMN IF NOT EXISTS finished_good_id TEXT,
  ADD COLUMN IF NOT EXISTS sku_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS category_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS pack_size_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS pack_qty_snapshot NUMERIC,
  ADD COLUMN IF NOT EXISTS expected_qty NUMERIC,
  ADD COLUMN IF NOT EXISTS physical_qty_entered BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS making_cost_snapshot NUMERIC,
  ADD COLUMN IF NOT EXISTS expected_value NUMERIC,
  ADD COLUMN IF NOT EXISTS physical_value NUMERIC,
  ADD COLUMN IF NOT EXISTS last_count_date_snapshot DATE,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'uncounted',
  ADD COLUMN IF NOT EXISTS posted_movement_id BIGINT;

UPDATE public.fg_count_lines
SET finished_good_id = COALESCE(finished_good_id, item_id),
    expected_qty = COALESCE(expected_qty, system_qty),
    making_cost_snapshot = COALESCE(making_cost_snapshot, unit_cost),
    expected_value = COALESCE(expected_value, system_qty * unit_cost),
    physical_value = COALESCE(physical_value, physical_qty * unit_cost),
    physical_qty_entered = CASE WHEN physical_qty IS NOT NULL THEN TRUE ELSE physical_qty_entered END,
    status = CASE
      WHEN COALESCE(variance_qty, 0) > 0 THEN 'gain'
      WHEN COALESCE(variance_qty, 0) < 0 THEN 'loss'
      WHEN physical_qty IS NOT NULL THEN 'counted'
      ELSE 'uncounted'
    END
WHERE finished_good_id IS NULL
   OR expected_qty IS NULL
   OR making_cost_snapshot IS NULL
   OR expected_value IS NULL
   OR physical_value IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fg_count_lines_status_check'
      AND conrelid = 'public.fg_count_lines'::regclass
  ) THEN
    ALTER TABLE public.fg_count_lines
      ADD CONSTRAINT fg_count_lines_status_check
      CHECK (status IN ('uncounted','counted','gain','loss'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.fg_count_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES public.fg_count_sessions(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_name TEXT,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fg_count_sessions_location_date
  ON public.fg_count_sessions (location_id, business_date DESC, count_type, status);

CREATE INDEX IF NOT EXISTS idx_fg_count_sessions_status
  ON public.fg_count_sessions (status, business_date DESC);

CREATE INDEX IF NOT EXISTS idx_fg_count_lines_enterprise_session
  ON public.fg_count_lines (session_id, status, item_name);

CREATE INDEX IF NOT EXISTS idx_fg_count_audit_session
  ON public.fg_count_audit_log (session_id, created_at DESC);

-- Duplicate standard sessions are prevented in create_fg_count_session().
-- A unique index is intentionally not added here because legacy lightweight FG
-- count rows may already contain multiple rows for the same date/type after the
-- additive column backfill. The RPC returns "Open Existing / Create Additional"
-- behavior without risking migration failure on historical data.

CREATE OR REPLACE FUNCTION public._fg_count_assert_role(
  p_allow_approve BOOLEAN DEFAULT FALSE
) RETURNS TABLE(user_id UUID, role TEXT, display_name TEXT) AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role TEXT;
  v_name TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;

  SELECT LOWER(COALESCE(up.role, '')), COALESCE(up.name, au.email, v_user_id::TEXT)
  INTO v_role, v_name
  FROM auth.users au
  LEFT JOIN public.user_profiles up ON up.user_id = au.id
  WHERE au.id = v_user_id;

  IF p_allow_approve THEN
    IF v_role NOT IN ('hq_master','hq_admin','admin') THEN
      RAISE EXCEPTION 'Only HQ Admin can approve and post FG counts.';
    END IF;
  ELSE
    IF v_role NOT IN ('hq_master','hq_admin','admin','hq_ops','hq_fulfillment','location_manager') THEN
      RAISE EXCEPTION 'You are not allowed to manage FG count sessions.';
    END IF;
  END IF;

  RETURN QUERY SELECT v_user_id, v_role, v_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public._fg_count_recalculate_session(
  p_session_id TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE public.fg_count_sessions s
  SET total_items = COALESCE(x.total_items, 0),
      counted_items = COALESCE(x.counted_items, 0),
      variance_items = COALESCE(x.variance_items, 0),
      expected_value = COALESCE(x.expected_value, 0),
      physical_value = COALESCE(x.physical_value, 0),
      variance_value = COALESCE(x.variance_value, 0),
      gain_value = COALESCE(x.gain_value, 0),
      loss_value = COALESCE(x.loss_value, 0),
      updated_at = NOW()
  FROM (
    SELECT
      COUNT(*)::INTEGER AS total_items,
      COUNT(*) FILTER (WHERE physical_qty_entered)::INTEGER AS counted_items,
      COUNT(*) FILTER (WHERE physical_qty_entered AND COALESCE(variance_qty, 0) <> 0)::INTEGER AS variance_items,
      SUM(COALESCE(expected_value, COALESCE(expected_qty, system_qty, 0) * COALESCE(making_cost_snapshot, unit_cost, 0))) AS expected_value,
      SUM(CASE WHEN physical_qty_entered THEN COALESCE(physical_value, physical_qty * COALESCE(making_cost_snapshot, unit_cost, 0)) ELSE 0 END) AS physical_value,
      SUM(CASE WHEN physical_qty_entered THEN COALESCE(variance_value, variance_qty * COALESCE(making_cost_snapshot, unit_cost, 0)) ELSE 0 END) AS variance_value,
      SUM(CASE WHEN physical_qty_entered AND COALESCE(variance_value, 0) > 0 THEN variance_value ELSE 0 END) AS gain_value,
      SUM(CASE WHEN physical_qty_entered AND COALESCE(variance_value, 0) < 0 THEN ABS(variance_value) ELSE 0 END) AS loss_value
    FROM public.fg_count_lines
    WHERE session_id = p_session_id
  ) x
  WHERE s.id = p_session_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.create_fg_count_session(
  p_location_id TEXT,
  p_business_date DATE,
  p_session_name TEXT,
  p_count_type TEXT,
  p_notes TEXT DEFAULT NULL,
  p_counter_name TEXT DEFAULT NULL,
  p_create_additional BOOLEAN DEFAULT FALSE
) RETURNS JSONB AS $$
DECLARE
  v_auth RECORD;
  v_session_id TEXT := gen_random_uuid()::TEXT;
  v_existing public.fg_count_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_auth FROM public._fg_count_assert_role(FALSE) LIMIT 1;

  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'Business date is required.';
  END IF;
  IF p_count_type NOT IN ('Opening Count','Closing Count','Weekly Count','Monthly Count','Cycle Count','Spot Audit') THEN
    RAISE EXCEPTION 'Invalid count type.';
  END IF;

  SELECT *
  INTO v_existing
  FROM public.fg_count_sessions
  WHERE location_id = COALESCE(NULLIF(p_location_id, ''), 'LOC-HQ')
    AND business_date = p_business_date
    AND count_type = p_count_type
    AND status IN ('draft','submitted','approved')
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND AND NOT p_create_additional THEN
    RETURN jsonb_build_object(
      'success', false,
      'duplicate', true,
      'existing_session_id', v_existing.id,
      'message', 'A ' || p_count_type || ' already exists for this business date.'
    );
  END IF;

  INSERT INTO public.fg_count_sessions (
    id, count_date, business_date, session_name, location_id, location_name,
    count_type, status, notes, counter_name, counted_by, counted_by_name, created_by
  )
  VALUES (
    v_session_id, p_business_date, p_business_date,
    COALESCE(NULLIF(TRIM(p_session_name), ''), TO_CHAR(p_business_date, 'Mon DD') || ' ' || p_count_type),
    COALESCE(NULLIF(p_location_id, ''), 'LOC-HQ'),
    CASE WHEN COALESCE(NULLIF(p_location_id, ''), 'LOC-HQ') = 'LOC-HQ' THEN 'Head Office' ELSE p_location_id END,
    p_count_type, 'draft', p_notes, p_counter_name, v_auth.user_id, v_auth.display_name, v_auth.user_id
  );

  INSERT INTO public.fg_count_audit_log (session_id, action, actor_id, actor_name, metadata)
  VALUES (v_session_id, 'created', v_auth.user_id, v_auth.display_name, jsonb_build_object('business_date', p_business_date, 'count_type', p_count_type));

  INSERT INTO public.fg_count_lines (
    id, session_id, item_id, finished_good_id, item_name, sku_snapshot, category_snapshot,
    pack_size_snapshot, pack_qty_snapshot, unit, system_qty, expected_qty, physical_qty,
    physical_qty_entered, variance_qty, unit_cost, making_cost_snapshot, expected_value,
    physical_value, variance_value, last_count_date_snapshot, status
  )
  SELECT
    v_session_id || ':' || hq.id,
    v_session_id,
    hq.id,
    hq.id,
    hq.name,
    hq.id,
    hq.category,
    CONCAT(COALESCE(NULLIF(hq.pack_qty, 0), 1), ' ', COALESCE(hq.base_unit, 'ea')),
    COALESCE(NULLIF(hq.pack_qty, 0), 1),
    COALESCE(hq.base_unit, 'ea'),
    COALESCE(hq.instock, 0),
    COALESCE(hq.instock, 0),
    0,
    FALSE,
    0,
    COALESCE(hq.making_cost, 0),
    COALESCE(hq.making_cost, 0),
    COALESCE(hq.instock, 0) * COALESCE(hq.making_cost, 0),
    0,
    0,
    lc.last_count_date,
    'uncounted'
  FROM public.hq_sale_items hq
  LEFT JOIN (
    SELECT l.finished_good_id, MAX(s.business_date) AS last_count_date
    FROM public.fg_count_lines l
    JOIN public.fg_count_sessions s ON s.id = l.session_id
    WHERE s.status = 'approved'
    GROUP BY l.finished_good_id
  ) lc ON lc.finished_good_id = hq.id
  WHERE COALESCE(hq.is_active, TRUE) = TRUE
  ORDER BY hq.name;

  PERFORM public._fg_count_recalculate_session(v_session_id);

  RETURN jsonb_build_object('success', true, 'session_id', v_session_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.save_fg_count_session_draft(
  p_session_id TEXT,
  p_lines JSONB,
  p_notes TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_auth RECORD;
  v_session public.fg_count_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_auth FROM public._fg_count_assert_role(FALSE) LIMIT 1;

  SELECT * INTO v_session
  FROM public.fg_count_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'FG count session not found.'; END IF;
  IF v_session.status <> 'draft' THEN RAISE EXCEPTION 'Only draft FG count sessions can be edited.'; END IF;

  WITH src AS (
    SELECT
      line->>'item_id' AS item_id,
      NULLIF(line->>'physical_qty', '')::NUMERIC AS physical_qty,
      NULLIF(line->>'notes', '') AS notes
    FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) AS x(line)
  )
  UPDATE public.fg_count_lines l
  SET physical_qty = COALESCE(src.physical_qty, 0),
      physical_qty_entered = src.physical_qty IS NOT NULL,
      variance_qty = CASE WHEN src.physical_qty IS NULL THEN 0 ELSE src.physical_qty - COALESCE(l.expected_qty, l.system_qty, 0) END,
      physical_value = CASE WHEN src.physical_qty IS NULL THEN 0 ELSE src.physical_qty * COALESCE(l.making_cost_snapshot, l.unit_cost, 0) END,
      variance_value = CASE WHEN src.physical_qty IS NULL THEN 0 ELSE (src.physical_qty - COALESCE(l.expected_qty, l.system_qty, 0)) * COALESCE(l.making_cost_snapshot, l.unit_cost, 0) END,
      notes = src.notes,
      status = CASE
        WHEN src.physical_qty IS NULL THEN 'uncounted'
        WHEN src.physical_qty - COALESCE(l.expected_qty, l.system_qty, 0) > 0 THEN 'gain'
        WHEN src.physical_qty - COALESCE(l.expected_qty, l.system_qty, 0) < 0 THEN 'loss'
        ELSE 'counted'
      END,
      updated_at = NOW()
  FROM src
  WHERE l.session_id = p_session_id
    AND l.item_id = src.item_id;

  UPDATE public.fg_count_sessions
  SET notes = COALESCE(p_notes, notes),
      updated_at = NOW()
  WHERE id = p_session_id;

  PERFORM public._fg_count_recalculate_session(p_session_id);

  INSERT INTO public.fg_count_audit_log (session_id, action, actor_id, actor_name, metadata)
  VALUES (p_session_id, 'saved', v_auth.user_id, v_auth.display_name, jsonb_build_object('line_count', jsonb_array_length(COALESCE(p_lines, '[]'::jsonb))));

  RETURN jsonb_build_object('success', true, 'session_id', p_session_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.submit_fg_count_session(
  p_session_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_auth RECORD;
  v_session public.fg_count_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_auth FROM public._fg_count_assert_role(FALSE) LIMIT 1;

  SELECT * INTO v_session
  FROM public.fg_count_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'FG count session not found.'; END IF;
  IF v_session.status <> 'draft' THEN RAISE EXCEPTION 'Only draft FG count sessions can be submitted.'; END IF;

  PERFORM public._fg_count_recalculate_session(p_session_id);

  UPDATE public.fg_count_sessions
  SET status = 'submitted',
      submitted_by = v_auth.user_id,
      submitted_by_name = v_auth.display_name,
      submitted_at = NOW(),
      updated_at = NOW()
  WHERE id = p_session_id;

  INSERT INTO public.fg_count_audit_log (session_id, action, actor_id, actor_name)
  VALUES (p_session_id, 'submitted', v_auth.user_id, v_auth.display_name);

  RETURN jsonb_build_object('success', true, 'session_id', p_session_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

CREATE OR REPLACE FUNCTION public.approve_and_post_fg_count_session(
  p_session_id TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_auth RECORD;
  v_session public.fg_count_sessions%ROWTYPE;
  v_base_id BIGINT;
  v_inserted_count INTEGER := 0;
BEGIN
  SELECT * INTO v_auth FROM public._fg_count_assert_role(TRUE) LIMIT 1;

  SELECT * INTO v_session
  FROM public.fg_count_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'FG count session not found.'; END IF;
  IF v_session.status <> 'submitted' THEN RAISE EXCEPTION 'Only submitted FG count sessions can be approved.'; END IF;
  IF v_session.posted_at IS NOT NULL THEN RAISE EXCEPTION 'This FG count session has already been posted.'; END IF;

  PERFORM public._fg_count_recalculate_session(p_session_id);

  LOCK TABLE public.inventory_movements IN EXCLUSIVE MODE;
  SELECT COALESCE(MAX(id), 0) INTO v_base_id FROM public.inventory_movements;

  WITH movement_source AS (
    SELECT
      l.id,
      l.item_id,
      l.variance_qty,
      ABS(l.variance_qty) AS movement_qty,
      COALESCE(l.making_cost_snapshot, l.unit_cost, 0) AS unit_cost,
      ROW_NUMBER() OVER (ORDER BY l.item_name, l.item_id) AS rn
    FROM public.fg_count_lines l
    WHERE l.session_id = p_session_id
      AND l.physical_qty_entered = TRUE
      AND COALESCE(l.variance_qty, 0) <> 0
  ),
  inserted AS (
    INSERT INTO public.inventory_movements (
      id, created_at, location_id, item_id, movement_type, quantity,
      unit_cost, total_cost, reference_type, reference_id, notes
    )
    SELECT
      v_base_id + rn,
      NOW(),
      v_session.location_id,
      item_id,
      CASE WHEN variance_qty > 0 THEN 'count_variance_gain' ELSE 'count_variance_loss' END,
      movement_qty,
      NULLIF(unit_cost, 0),
      movement_qty * unit_cost,
      'fg_count',
      p_session_id,
      jsonb_build_object(
        'kind', 'fg_count_session',
        'business_date', v_session.business_date,
        'session_name', v_session.session_name,
        'reason', p_reason,
        'expected_qty', NULL,
        'variance_qty', variance_qty
      )::TEXT
    FROM movement_source
    RETURNING id, item_id
  )
  UPDATE public.fg_count_lines l
  SET posted_movement_id = inserted.id
  FROM inserted
  WHERE l.session_id = p_session_id
    AND l.item_id = inserted.item_id;

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  UPDATE public.hq_sale_items hq
  SET instock = l.physical_qty,
      updated_at = NOW()
  FROM public.fg_count_lines l
  WHERE l.session_id = p_session_id
    AND l.physical_qty_entered = TRUE
    AND hq.id = l.item_id;

  UPDATE public.fg_count_sessions
  SET status = 'approved',
      approved_by = v_auth.user_id,
      approved_by_name = v_auth.display_name,
      approved_at = NOW(),
      posted_by = v_auth.user_id,
      posted_by_name = v_auth.display_name,
      posted_at = NOW(),
      posted_movement_count = v_inserted_count,
      updated_at = NOW()
  WHERE id = p_session_id;

  INSERT INTO public.fg_count_audit_log (session_id, action, actor_id, actor_name, reason, metadata)
  VALUES (p_session_id, 'approved_posted', v_auth.user_id, v_auth.display_name, p_reason, jsonb_build_object('movement_count', v_inserted_count));

  RETURN jsonb_build_object('success', true, 'session_id', p_session_id, 'movement_count', v_inserted_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public._fg_count_assert_role(BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._fg_count_recalculate_session(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_fg_count_session(TEXT, DATE, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_fg_count_session_draft(TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_fg_count_session(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_and_post_fg_count_session(TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_fg_count_session(TEXT, DATE, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_fg_count_session_draft(TEXT, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_fg_count_session(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_and_post_fg_count_session(TEXT, TEXT) TO authenticated;
