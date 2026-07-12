-- =============================================================================
-- MIGRATION: Requisition HQ run date + fulfillment method/window
--
-- Additive only. Keeps legacy requisitions nullable and operational.
-- Does not change inventory, fulfillment, invoices, backorders, deliveries,
-- stock movements, or historical requisition records beyond adding nullable
-- header fields.
-- =============================================================================

ALTER TABLE public.requisitions
  ADD COLUMN IF NOT EXISTS hq_run_date DATE,
  ADD COLUMN IF NOT EXISTS fulfillment_method TEXT,
  ADD COLUMN IF NOT EXISTS fulfillment_window TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'requisitions_fulfillment_method_chk'
      AND conrelid = 'public.requisitions'::regclass
  ) THEN
    ALTER TABLE public.requisitions
      ADD CONSTRAINT requisitions_fulfillment_method_chk
      CHECK (
        fulfillment_method IS NULL
        OR fulfillment_method IN ('hq_delivery', 'store_pickup')
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'requisitions_fulfillment_window_chk'
      AND conrelid = 'public.requisitions'::regclass
  ) THEN
    ALTER TABLE public.requisitions
      ADD CONSTRAINT requisitions_fulfillment_window_chk
      CHECK (
        fulfillment_window IS NULL
        OR fulfillment_window IN (
          'morning',
          'afternoon',
          'evening',
          'next_hq_run',
          'asap_pickup'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'requisitions_method_window_chk'
      AND conrelid = 'public.requisitions'::regclass
  ) THEN
    ALTER TABLE public.requisitions
      ADD CONSTRAINT requisitions_method_window_chk
      CHECK (
        fulfillment_method IS NULL
        OR fulfillment_window IS NULL
        OR (
          fulfillment_method = 'hq_delivery'
          AND fulfillment_window IN ('morning', 'afternoon', 'evening', 'next_hq_run')
        )
        OR (
          fulfillment_method = 'store_pickup'
          AND fulfillment_window IN ('morning', 'afternoon', 'evening', 'asap_pickup')
        )
      ) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_requisitions_hq_run_date
  ON public.requisitions (hq_run_date);

CREATE INDEX IF NOT EXISTS idx_requisitions_hq_run_date_status
  ON public.requisitions (hq_run_date, status);

CREATE INDEX IF NOT EXISTS idx_requisitions_hq_run_date_location
  ON public.requisitions (hq_run_date, location_id);

CREATE INDEX IF NOT EXISTS idx_requisitions_method_window
  ON public.requisitions (fulfillment_method, fulfillment_window);

COMMENT ON COLUMN public.requisitions.hq_run_date IS
  'Operational HQ production/fulfillment run date. Nullable for legacy requisitions.';

COMMENT ON COLUMN public.requisitions.fulfillment_method IS
  'Operational fulfillment method: hq_delivery or store_pickup. Nullable for legacy requisitions.';

COMMENT ON COLUMN public.requisitions.fulfillment_window IS
  'Preferred delivery/pickup window. Valid values depend on fulfillment_method. Nullable for legacy requisitions.';
