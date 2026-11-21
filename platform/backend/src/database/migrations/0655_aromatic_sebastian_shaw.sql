-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- The Logs page counts LLM Proxy requests from the hourly usage rollup, so the
-- rollup gains what it filters by: the request `source` (Slack, Chat, a coding
-- client's turn kind) as a key, and `failed_requests` as a measure. Both are
-- set once when an interaction is written, so the insert trigger already
-- marks every hour that needs them. Adding a nullable column, or one with a
-- constant default, is a catalog change on these aggregate tables; no rewrite.
ALTER TABLE "llm_usage_daily" ADD COLUMN "source" varchar;--> statement-breakpoint
ALTER TABLE "llm_usage_daily" ADD COLUMN "failed_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage_hourly" ADD COLUMN "source" varchar;--> statement-breakpoint
ALTER TABLE "llm_usage_hourly" ADD COLUMN "failed_requests" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Hours rolled before this migration hold no source and no failures. Mark the
-- last four days for recompute, so the three days the Logs page reads come
-- back with them; the periodic llm_usage_rollup task recomputes each hour.
SELECT llm_usage_rollup_mark(ARRAY(
  SELECT DISTINCT hour FROM llm_usage_hourly
  WHERE hour >= date_trunc('hour', now() AT TIME ZONE 'UTC') - interval '96 hours'
));
--> statement-breakpoint
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
