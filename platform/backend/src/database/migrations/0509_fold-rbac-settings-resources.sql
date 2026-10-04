-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- The per-area settings resources (agent, LLM, MCP, skills, knowledge and
-- OpenAPPA settings), agent triggers and site notifications fold into
-- `organizationSettings`; the code sandbox runs under `agent:read`; and
-- inviting people is part of `member:create`. Custom roles drop the retired
-- keys rather than gaining `organizationSettings`, which would hand a role
-- that could only change, say, LLM settings control over authentication and
-- appearance too. Their stored `invitation` grant is recomputed from
-- `member:create`, because Better Auth still checks it when inviting.
WITH rewritten AS (
  SELECT id,
    CASE
      WHEN stripped->'member' ? 'create'
      THEN stripped || '{"invitation": ["create", "cancel"]}'::jsonb
      ELSE stripped
    END AS permission
  FROM (
    SELECT id,
      permission::jsonb - ARRAY[
        'agentSettings',
        'llmSettings',
        'mcpSettings',
        'skillsSettings',
        'knowledgeSettings',
        'openappaSettings',
        'agentTrigger',
        'siteNotification',
        'sandbox',
        'invitation'
      ] AS stripped
    FROM organization_role
  ) AS roles
)
UPDATE organization_role AS role
SET permission = rewritten.permission::text,
  updated_at = now()
FROM rewritten
WHERE role.id = rewritten.id
  AND role.permission::jsonb IS DISTINCT FROM rewritten.permission;
