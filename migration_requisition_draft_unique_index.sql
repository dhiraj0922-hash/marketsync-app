CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  idx_one_active_draft_requisition_per_location_user
ON public.requisitions (location_id, created_by)
WHERE status = 'draft';
