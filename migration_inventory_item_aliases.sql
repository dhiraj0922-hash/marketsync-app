-- Inventory Item Aliases
-- Safe, additive identity layer for recipe traceability across legacy/location
-- scoped inventory rows. This does not merge, archive, delete, or modify
-- inventory_items or recipes.

CREATE TABLE IF NOT EXISTS public.inventory_item_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_inventory_item_id text NOT NULL,
  alias_inventory_item_id text NOT NULL,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_item_aliases_distinct
    CHECK (canonical_inventory_item_id <> alias_inventory_item_id),
  CONSTRAINT inventory_item_aliases_unique
    UNIQUE (canonical_inventory_item_id, alias_inventory_item_id),
  CONSTRAINT inventory_item_aliases_alias_unique
    UNIQUE (alias_inventory_item_id),
  CONSTRAINT inventory_item_aliases_canonical_fkey
    FOREIGN KEY (canonical_inventory_item_id)
    REFERENCES public.inventory_items(id)
    ON DELETE CASCADE
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_item_aliases_alias_unique'
      AND conrelid = 'public.inventory_item_aliases'::regclass
  ) THEN
    ALTER TABLE public.inventory_item_aliases
      ADD CONSTRAINT inventory_item_aliases_alias_unique
      UNIQUE (alias_inventory_item_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_item_aliases_canonical_fkey'
      AND conrelid = 'public.inventory_item_aliases'::regclass
  ) THEN
    ALTER TABLE public.inventory_item_aliases
      ADD CONSTRAINT inventory_item_aliases_canonical_fkey
      FOREIGN KEY (canonical_inventory_item_id)
      REFERENCES public.inventory_items(id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_item_aliases_canonical
  ON public.inventory_item_aliases(canonical_inventory_item_id);

CREATE INDEX IF NOT EXISTS idx_inventory_item_aliases_alias
  ON public.inventory_item_aliases(alias_inventory_item_id);

COMMENT ON TABLE public.inventory_item_aliases IS
  'Explicit HQ-approved aliases between inventory item row IDs/shared IDs for recipe usage traceability. Does not merge inventory rows.';

COMMENT ON COLUMN public.inventory_item_aliases.canonical_inventory_item_id IS
  'The current inventory_items.id chosen as the canonical ingredient identity for traceability.';

COMMENT ON COLUMN public.inventory_item_aliases.alias_inventory_item_id IS
  'An approved legacy/shared/location inventory ID that should count as the same canonical ingredient in recipe usage tracking. Intentionally no FK so orphaned historical recipe inventory IDs remain supported.';

ALTER TABLE public.inventory_item_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Inventory Item Aliases: Read by Ops" ON public.inventory_item_aliases;
DROP POLICY IF EXISTS "Inventory Item Aliases: Manage by HQ Master" ON public.inventory_item_aliases;

CREATE POLICY "Inventory Item Aliases: Read by Ops"
  ON public.inventory_item_aliases
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.is_active = true
        AND up.role IN ('hq_admin', 'hq_master', 'hq_ops')
    )
  );

CREATE POLICY "Inventory Item Aliases: Manage by HQ Master"
  ON public.inventory_item_aliases
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.is_active = true
        AND up.role IN ('hq_admin', 'hq_master')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.user_id = auth.uid()
        AND up.is_active = true
        AND up.role IN ('hq_admin', 'hq_master')
    )
  );
