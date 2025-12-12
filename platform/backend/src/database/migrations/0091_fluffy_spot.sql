-- Custom SQL migration file, put your code below! ---- Migration: Add team:admin to custom roles that have team:update
-- For any custom role that has team:update permission, add team:admin to grant
-- administrative access to teams they could previously update.

UPDATE organization_role
SET
  permission = jsonb_set(
    permission::jsonb,
    '{team}',
    (
      SELECT jsonb_agg(DISTINCT elem)
      FROM (
        SELECT jsonb_array_elements_text(permission::jsonb->'team') AS elem
        UNION
        SELECT 'admin'
      ) sub
    )
  )::text,
  updated_at = NOW()
WHERE
  permission::jsonb->'team' ? 'update'
  AND NOT (permission::jsonb->'team' ? 'admin');