-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Preserve the built-in Editor's existing model-catalog authority. This is
-- distinct from role composition: unrelated action/scope pairs stay separate.
WITH policies AS (
  SELECT organization_id, grants,
    jsonb_build_object('subject', jsonb_build_object('type', 'role', 'id', 'editor'),
      'actions', (SELECT jsonb_agg(DISTINCT action ORDER BY action)
        FROM (SELECT jsonb_array_elements_text('["manage-permissions", "read", "update", "use"]'::jsonb) AS action
          UNION ALL
          SELECT jsonb_array_elements_text(g->'actions') FROM jsonb_array_elements(grants) g
          WHERE g->'subject'->>'type' = 'role' AND g->'subject'->>'id' = 'editor') actions)) AS editor_grant
  FROM resource_permission_policies WHERE resource = 'llmModel' AND scope = '*'
), merged AS (
  SELECT organization_id,
    (SELECT jsonb_agg(g ORDER BY g->'subject'->>'type', g->'subject'->>'id')
     FROM (SELECT value AS g FROM jsonb_array_elements(grants)
           WHERE NOT (value->'subject'->>'type' = 'role' AND value->'subject'->>'id' = 'editor')
           UNION ALL SELECT editor_grant) entries) AS grants
  FROM policies
)
UPDATE resource_permission_policies p SET grants = merged.grants,
  revision = p.revision + 1, updated_at = now()
FROM merged WHERE p.organization_id = merged.organization_id
  AND p.resource = 'llmModel' AND p.scope = '*' AND p.grants IS DISTINCT FROM merged.grants;
--> statement-breakpoint
-- 0464 already captured these flags as complete scoped grants. Retire the
-- obsolete role actions without changing unrelated permissions or role IDs.
WITH converted AS (
  SELECT r.id, COALESCE((
    SELECT jsonb_object_agg(resource, CASE
      WHEN resource IN ('agent', 'mcpGateway', 'mcpRegistry', 'skill', 'app') THEN
        COALESCE((SELECT jsonb_agg(action ORDER BY ordinal)
          FROM jsonb_array_elements(actions) WITH ORDINALITY AS items(action, ordinal)
          WHERE action NOT IN ('"admin"'::jsonb, '"team-admin"'::jsonb)), '[]'::jsonb)
      ELSE actions END)
    FROM jsonb_each(r.permission::jsonb) AS resources(resource, actions)
  ), '{}'::jsonb) AS permission
  FROM organization_role r
)
UPDATE organization_role r SET permission = converted.permission::text, updated_at = now()
FROM converted WHERE r.id = converted.id AND r.permission::jsonb IS DISTINCT FROM converted.permission;
