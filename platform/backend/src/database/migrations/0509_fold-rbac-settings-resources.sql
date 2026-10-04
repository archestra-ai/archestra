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
-- `chat:full-view` action, granted to a role that had any of the three so no
-- one loses part of the chat they could see.
WITH stripped AS (
  SELECT id,
    (
      permission::jsonb->'chat' ? 'full-view'
      OR permission::jsonb->'chatFullView' ? 'enable'
      OR permission::jsonb->'chatAgentPicker' ? 'enable'
      OR permission::jsonb->'chatProviderSettings' ? 'enable'
      OR permission::jsonb->'chatExpandToolCalls' ? 'enable'
    ) AS had_full_chat,
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
    ] AS permission
  FROM organization_role
),
invited AS (
  SELECT id, had_full_chat,
    CASE
      WHEN permission->'member' ? 'create'
      THEN permission || '{"invitation": ["create", "cancel"]}'::jsonb
      ELSE permission
    END AS permission
  FROM stripped
),
rewritten AS (
  SELECT id,
    CASE
      WHEN had_full_chat
        AND NOT COALESCE(permission->'chat' ? 'full-view', false)
      THEN jsonb_set(
        permission,
        '{chat}',
        COALESCE(permission->'chat', '[]'::jsonb) || '["full-view"]'::jsonb
      )
      ELSE permission
    END AS permission
  FROM invited
)
UPDATE organization_role AS role
SET permission = rewritten.permission::text,
  updated_at = now()
FROM rewritten
WHERE role.id = rewritten.id
  AND role.permission::jsonb IS DISTINCT FROM rewritten.permission;
