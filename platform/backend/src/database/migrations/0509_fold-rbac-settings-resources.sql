-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- The per-area settings resources (agent, LLM, MCP, skills, knowledge and
-- OpenAPPA settings), agent triggers and site notifications fold into
-- `organizationSettings`; the code sandbox and its file store run under
-- `agent:read`; and
-- inviting people is part of `member:create`. Custom roles drop the retired
-- keys rather than gaining `organizationSettings`, which would hand a role
-- that could only change, say, LLM settings control over authentication and
-- appearance too. Their stored `invitation` grant is recomputed from
-- `member:create`, because Better Auth still checks it when inviting. The
-- agent picker, provider settings and expandable tool calls become one
-- `chatFullView` toggle, granted to a role that had any of the three so no one
-- loses part of the chat they could see.
WITH rewritten AS (
  SELECT id,
    CASE
      WHEN stripped->'member' ? 'create'
      THEN stripped || '{"invitation": ["create", "cancel"]}'::jsonb
      ELSE stripped
    END
    || CASE
      WHEN had_chat_view THEN '{"chatFullView": ["enable"]}'::jsonb
      ELSE '{}'::jsonb
    END AS permission
  FROM (
    SELECT id,
      (
        permission::jsonb->'chatFullView' ? 'enable'
        OR permission::jsonb->'chatAgentPicker' ? 'enable'
        OR permission::jsonb->'chatProviderSettings' ? 'enable'
        OR permission::jsonb->'chatExpandToolCalls' ? 'enable'
      ) AS had_chat_view,
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
        'invitation',
        'chatFullView',
        'chatAgentPicker',
        'chatProviderSettings',
        'chatExpandToolCalls',
        'file'
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
