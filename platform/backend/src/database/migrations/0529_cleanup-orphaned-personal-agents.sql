-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Soft-delete agents and MCP gateways whose author's account was deleted
-- before user cleanup covered them. `agents.author_id` is `set null`, so these
-- rows show as "Owner unavailable". Only rows no current member can read or
-- use go: a grant to a team, role or the organization keeps the row, and so
-- does a grant to a user who is still a member.
UPDATE agents AS agent
SET deleted_at = now()
WHERE agent.deleted_at IS NULL
  AND agent.author_id IS NULL
  AND agent.built_in = false
  AND agent.is_personal_gateway = false
  AND agent.agent_type IN ('agent', 'mcp_gateway')
  AND NOT EXISTS (
    SELECT 1
    FROM resource_permission_policies AS policy,
      jsonb_array_elements(policy.grants) AS grant_entry
    WHERE policy.organization_id = agent.organization_id
      AND policy.resource = CASE agent.agent_type
        WHEN 'mcp_gateway' THEN 'mcpGateway'
        ELSE 'agent'
      END
      AND policy.scope = agent.id::text
      AND ((grant_entry->'actions') ? 'read' OR (grant_entry->'actions') ? 'use')
      AND (
        grant_entry->'subject'->>'type' <> 'user'
        OR EXISTS (
          SELECT 1 FROM member AS recipient
          WHERE recipient.organization_id = agent.organization_id
            AND recipient.user_id = grant_entry->'subject'->>'id'
        )
      )
  );
