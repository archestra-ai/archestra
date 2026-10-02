-- Retire the action without granting new delete authority. Preserve resource
-- keys, empty arrays, every other action, and the original action ordering.
UPDATE "organization_role" AS role
SET "permission" = (
  SELECT jsonb_object_agg(resource.key, COALESCE((
    SELECT jsonb_agg(action.value ORDER BY action.position)
    FROM jsonb_array_elements(resource.value) WITH ORDINALITY AS action(value, position)
    WHERE action.value <> '"manage-deleted"'::jsonb
  ), '[]'::jsonb))::text
  FROM jsonb_each(role."permission"::jsonb) AS resource
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_each(role."permission"::jsonb) AS resource
  WHERE resource.value @> '["manage-deleted"]'::jsonb
);
