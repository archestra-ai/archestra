-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Two log resources change, and every custom role keeps what it could see.
--
-- `guardrailsYell` becomes `guardrailsLog`, which now also covers the
-- Guardrails consults `log` used to. A role's `guardrailsLog` is the union of
-- its `guardrailsYell` and its `log` actions (`read` for its own sessions,
-- `admin` for everyone's), and the `guardrailsYell` key goes.
--
-- Client connections get their own `clientConnection`. The connection log and
-- Adoption needed `log:admin` with `member:read`, so a role holding both gets
-- `clientConnection` `read` and `admin`. A role with `log:read` gets
-- `clientConnection:read`, its own clients' events, as the built-in roles do.
--
-- `log` itself is unchanged: it still governs the LLM and MCP logs.
WITH source AS (
  SELECT role.id, role.permission::jsonb AS permission
  FROM organization_role AS role
  WHERE role.permission::jsonb ?| ARRAY['guardrailsYell', 'log']
),
actions AS (
  SELECT source.id,
    source.permission,
    (
      SELECT COALESCE(jsonb_agg(DISTINCT action ORDER BY action), '[]'::jsonb)
      FROM (
        SELECT jsonb_array_elements_text(granted) AS action
        FROM (
          SELECT source.permission->resource.name AS granted
          FROM unnest(ARRAY['guardrailsYell', 'guardrailsLog', 'log'])
            AS resource(name)
        ) resources
        WHERE jsonb_typeof(granted) = 'array'
      ) granted_actions
      WHERE action IN ('read', 'admin')
    ) AS guardrails_log,
    (
      SELECT COALESCE(jsonb_agg(DISTINCT action ORDER BY action), '[]'::jsonb)
      FROM (
        SELECT jsonb_array_elements_text(source.permission->'clientConnection')
          AS action
        WHERE jsonb_typeof(source.permission->'clientConnection') = 'array'
        UNION ALL
        SELECT 'read'
        WHERE jsonb_typeof(source.permission->'log') = 'array'
          AND source.permission->'log' ? 'read'
        UNION ALL
        SELECT unnest(ARRAY['read', 'admin'])
        WHERE jsonb_typeof(source.permission->'log') = 'array'
          AND source.permission->'log' ? 'admin'
          AND jsonb_typeof(source.permission->'member') = 'array'
          AND source.permission->'member' ? 'read'
      ) granted_actions
      WHERE action IN ('read', 'admin')
    ) AS client_connection
  FROM source
),
mapped AS (
  SELECT actions.id,
    actions.permission AS before,
    (actions.permission - 'guardrailsYell')
      || CASE
        WHEN actions.guardrails_log <> '[]'::jsonb
          THEN jsonb_build_object('guardrailsLog', actions.guardrails_log)
        ELSE '{}'::jsonb
      END
      || CASE
        WHEN actions.client_connection <> '[]'::jsonb
          THEN jsonb_build_object('clientConnection', actions.client_connection)
        ELSE '{}'::jsonb
      END AS permission
  FROM actions
)
UPDATE organization_role AS role
SET permission = mapped.permission::text,
  updated_at = now()
FROM mapped
WHERE role.id = mapped.id
  AND mapped.before IS DISTINCT FROM mapped.permission;
