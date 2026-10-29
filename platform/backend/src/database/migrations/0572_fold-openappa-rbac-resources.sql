-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- `openappaPolicy` is renamed `guardrailsPolicy`, with the same actions.
-- `openappaDiagnostics` folds into `log`: reading yells and your own consults
-- is `log:read`, and organization-wide consults are `log:admin`. A custom role
-- that could read diagnostics gains `log:read`, which adds only the holder's
-- own LLM and MCP logs. It does not gain `log:admin`, which would also open
-- every member's LLM and MCP logs; such a role keeps organization-wide consults
-- only if it already held `log:admin`.
WITH rewritten AS (
  SELECT id,
    (permission::jsonb - ARRAY['openappaPolicy', 'openappaDiagnostics'])
    || CASE
      WHEN permission::jsonb ? 'openappaPolicy'
      THEN jsonb_build_object('guardrailsPolicy', permission::jsonb->'openappaPolicy')
      ELSE '{}'::jsonb
    END
    || CASE
      WHEN COALESCE(permission::jsonb->'openappaDiagnostics' ? 'read', false)
        AND NOT COALESCE(permission::jsonb->'log' ? 'read', false)
      THEN jsonb_build_object(
        'log',
        COALESCE(permission::jsonb->'log', '[]'::jsonb) || '["read"]'::jsonb
      )
      ELSE '{}'::jsonb
    END AS permission
  FROM organization_role
  WHERE permission::jsonb ?| ARRAY['openappaPolicy', 'openappaDiagnostics']
)
UPDATE organization_role AS role
SET permission = rewritten.permission::text,
  updated_at = now()
FROM rewritten
WHERE role.id = rewritten.id
  AND role.permission::jsonb IS DISTINCT FROM rewritten.permission;
