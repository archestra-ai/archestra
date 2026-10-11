-- Soft-delete personal MCP gateways whose author's account was deleted
-- without going through user cleanup. `agents.author_id` is `set null`, and
-- the delete route refuses personal gateways, so these rows could not be
-- removed any other way.
UPDATE agents
SET deleted_at = now()
WHERE deleted_at IS NULL
  AND agent_type = 'mcp_gateway'
  AND is_personal_gateway = true
  AND author_id IS NULL;--> statement-breakpoint
-- SPDX-SnippetBegin
-- SPDX-SnippetCopyrightText: 2026 Archestra Inc.
-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Personal gateways can no longer be shared: keep only the owner's own grant
-- on each one's policy.
UPDATE resource_permission_policies AS policy
SET grants = COALESCE(
    (
      SELECT jsonb_agg(grant_entry)
      FROM jsonb_array_elements(policy.grants) AS grant_entry
      WHERE grant_entry->'subject'->>'type' = 'user'
        AND grant_entry->'subject'->>'id' = agent.author_id
    ),
    '[]'::jsonb
  ),
  legacy_organization_audience = false,
  revision = policy.revision + 1,
  updated_at = now()
FROM agents AS agent
WHERE policy.resource = 'mcpGateway'
  AND policy.scope = agent.id::text
  AND policy.organization_id = agent.organization_id
  AND agent.is_personal_gateway = true
  AND (
    policy.legacy_organization_audience = true
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(policy.grants) AS grant_entry
      WHERE grant_entry->'subject'->>'type' <> 'user'
        OR grant_entry->'subject'->>'id' IS DISTINCT FROM agent.author_id
    )
  );
-- SPDX-SnippetEnd
