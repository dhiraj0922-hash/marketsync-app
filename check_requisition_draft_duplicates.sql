SELECT
  location_id,
  created_by,
  COUNT(*) AS draft_count,
  array_agg(id ORDER BY updated_at DESC) AS draft_ids
FROM public.requisitions
WHERE status = 'draft'
GROUP BY location_id, created_by
HAVING COUNT(*) > 1;
