-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Reading Guardrails yells moves from `log` to its own `guardrailsYell`
-- resource, so seeing every yell no longer also opens every member's LLM and
-- MCP logs. A custom role keeps what it could see: `log:read` gains
-- `guardrailsYell:read` (its own yells), and `log:admin` gains
-- `guardrailsYell:admin` (every yell). The `log` actions stay, since they
-- still govern the LLM, MCP, and consult logs.
WITH mapped AS (
  SELECT role.id,
    jsonb_set(
      role.permission::jsonb,
      '{guardrailsYell}',
      (
        SELECT COALESCE(jsonb_agg(DISTINCT action ORDER BY action), '[]'::jsonb)
        FROM (
          SELECT jsonb_array_elements_text(
            COALESCE(role.permission::jsonb->'guardrailsYell', '[]'::jsonb)
          ) AS action
          UNION ALL
          SELECT jsonb_array_elements_text(role.permission::jsonb->'log')
        ) actions
        WHERE action IN ('read', 'admin')
      )
    ) AS permission
  FROM organization_role AS role
  WHERE jsonb_typeof(role.permission::jsonb->'log') = 'array'
    AND role.permission::jsonb->'log' ?| ARRAY['read', 'admin']
)
UPDATE organization_role AS role
SET permission = mapped.permission::text,
  updated_at = now()
FROM mapped
WHERE role.id = mapped.id
  AND role.permission::jsonb IS DISTINCT FROM mapped.permission;
