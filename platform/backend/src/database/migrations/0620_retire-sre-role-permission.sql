-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Preserve access held by frozen custom roles with sre:read before removing
-- that retired RBAC resource. Both the agent and Kubernetes catalog now use
-- their own policies. Upgrade existing role grants, keeping other actions.
WITH legacy_roles AS (
  SELECT id, organization_id
  FROM organization_role
  WHERE COALESCE(permission::jsonb->'sre' ? 'read', false)
), rewritten AS (
  SELECT policy.organization_id, policy.resource, policy.scope,
    jsonb_agg(
      CASE
        WHEN grant_entry->'subject'->>'type' = 'role'
          AND EXISTS (
            SELECT 1 FROM legacy_roles AS role
            WHERE role.organization_id = policy.organization_id
              AND role.id = grant_entry->'subject'->>'id'
          )
        THEN jsonb_set(
          grant_entry,
          '{actions}',
          (
            SELECT jsonb_agg(action ORDER BY action)
            FROM (
              SELECT jsonb_array_elements_text(grant_entry->'actions') AS action
              UNION SELECT 'read'
              UNION SELECT 'use'
            ) AS actions
          )
        )
        ELSE grant_entry
      END ORDER BY ordinal
    ) AS grants
  FROM resource_permission_policies AS policy,
    jsonb_array_elements(policy.grants) WITH ORDINALITY AS entries(grant_entry, ordinal)
  WHERE (policy.resource, policy.scope) IN (
    ('mcpRegistry', '00000000-0000-4000-8000-000000000510'),
    ('agent', '00000000-0000-4000-8000-000000000512')
  )
  GROUP BY policy.organization_id, policy.resource, policy.scope
)
UPDATE resource_permission_policies AS policy
SET grants = rewritten.grants,
  revision = policy.revision + 1,
  updated_at = now()
FROM rewritten
WHERE policy.organization_id = rewritten.organization_id
  AND policy.resource = rewritten.resource
  AND policy.scope = rewritten.scope
  AND policy.grants IS DISTINCT FROM rewritten.grants;
--> statement-breakpoint
-- Include the Admin grant when either object has not been seeded yet. If it
-- already exists, preserve its policy and add only missing legacy roles.
WITH legacy_roles AS (
  SELECT id, organization_id
  FROM organization_role
  WHERE COALESCE(permission::jsonb->'sre' ? 'read', false)
), grants_by_org AS (
  SELECT organization_id,
    jsonb_agg(jsonb_build_object(
      'subject', jsonb_build_object('type', 'role', 'id', id),
      'actions', jsonb_build_array('read', 'use')
    ) ORDER BY id) AS grants
  FROM legacy_roles
  GROUP BY organization_id
)
INSERT INTO resource_permission_policies
  (organization_id, resource, scope, grants)
SELECT organization_id, target.resource, target.scope,
  jsonb_build_array(jsonb_build_object(
    'subject', jsonb_build_object('type', 'role', 'id', 'admin'),
    'actions', jsonb_build_array('read', 'use')
  )) || grants
FROM grants_by_org
CROSS JOIN (VALUES
  ('mcpRegistry', '00000000-0000-4000-8000-000000000510'),
  ('agent', '00000000-0000-4000-8000-000000000512')
) AS target(resource, scope)
-- Policies may precede their resource only if it already exists. Otherwise
-- startup's normal createInitial would collide with the pre-created policy.
WHERE (target.resource = 'agent' AND EXISTS (
    SELECT 1 FROM agents
    WHERE id = target.scope::uuid AND organization_id = grants_by_org.organization_id
  )) OR (target.resource = 'mcpRegistry' AND EXISTS (
    SELECT 1 FROM internal_mcp_catalog
    WHERE id = target.scope::uuid AND organization_id = grants_by_org.organization_id
  ))
ON CONFLICT (organization_id, resource, scope) DO UPDATE
SET grants = resource_permission_policies.grants || COALESCE((
    SELECT jsonb_agg(grant_entry)
    FROM jsonb_array_elements(EXCLUDED.grants) AS grant_entry
    WHERE grant_entry->'subject'->>'id' <> 'admin'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(resource_permission_policies.grants) AS existing
        WHERE existing->'subject' = grant_entry->'subject'
      )
  ), '[]'::jsonb),
  revision = resource_permission_policies.revision + 1,
  updated_at = now();
--> statement-breakpoint
UPDATE organization_role
SET permission = (permission::jsonb - 'sre')::text,
  updated_at = now()
WHERE permission::jsonb ? 'sre';
--> statement-breakpoint
-- Existing SRE rows keep their ID, conversations, tools and grants.
UPDATE agents
SET built_in_agent_config = '{"name":"sre-agent"}'::jsonb
WHERE id = '00000000-0000-4000-8000-000000000512'
  AND deleted_at IS NULL
  AND built_in_agent_config IS NULL;
