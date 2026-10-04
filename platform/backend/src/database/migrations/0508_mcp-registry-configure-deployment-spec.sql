-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- MCP registry deployment settings move behind their own
-- `configure-deployment-spec` action. New organizations give it to Admin and
-- Platform Admin on every entry; existing organizations get the same here.
-- Only those two predefined roles' Full access grants on `*` gain it: per-entry
-- Full access (a creator's automatic grant included) and custom roles stay
-- without it until someone grants it deliberately.
WITH updated AS (
  SELECT policy.organization_id, policy.resource, policy.scope,
    jsonb_agg(
      CASE
        WHEN grant_entry->'subject'->>'type' = 'role'
          AND grant_entry->'subject'->>'id' IN ('admin', 'platform_admin')
          AND grant_entry->'actions' ?& ARRAY['read', 'use', 'update', 'delete', 'manage-permissions']
          AND NOT grant_entry->'actions' ? 'configure-deployment-spec'
        THEN jsonb_set(
          grant_entry,
          '{actions}',
          (grant_entry->'actions') || '["configure-deployment-spec"]'::jsonb
        )
        ELSE grant_entry
      END
      ORDER BY ordinal
    ) AS grants
  FROM resource_permission_policies AS policy,
    jsonb_array_elements(policy.grants) WITH ORDINALITY AS entries(grant_entry, ordinal)
  WHERE policy.resource = 'mcpRegistry' AND policy.scope = '*'
  GROUP BY policy.organization_id, policy.resource, policy.scope
)
UPDATE resource_permission_policies AS policy
SET grants = updated.grants,
  revision = policy.revision + 1,
  updated_at = now()
FROM updated
WHERE policy.organization_id = updated.organization_id
  AND policy.resource = updated.resource
  AND policy.scope = updated.scope
  AND policy.grants IS DISTINCT FROM updated.grants;
