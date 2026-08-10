-- Custom SQL migration file, put your code below! --

-- Collapse the built-in Advisor from one row per environment to a single
-- org-wide row (environment_id NULL). Delegation now carries an explicit
-- advisor exception across environment boundaries, so the per-environment
-- rows — and everything pointing at them — fold into one survivor per
-- organization.
--
-- Discriminator: built_in_agent_config->>'name' = 'advisor-agent'.
-- Survivor per org: the oldest LIVE advisor row with environment_id NULL.
-- Soft-deleted null-env residue exists in production (deleteEnvironment used
-- to soft-delete the environment's advisor AFTER the FK nulled its
-- environment_id), so every survivor lookup filters deleted_at IS NULL.
--
-- Order matters: promote a survivor where none exists, remap references to
-- it, then hard-delete the rest. Grants/exclusions pointing at already
-- soft-deleted advisors are inert today and are deliberately not
-- resurrected — they die with the delete. History references (interactions,
-- conversations, tool calls, A2A tasks) are remapped for ALL retired rows,
-- dead or alive: their environment attribution lives in their own
-- environment_id snapshot columns, which this migration never touches.

SET LOCAL statement_timeout = '10min';
--> statement-breakpoint

-- An org whose null-env advisor was soft-deleted (or somehow never seeded)
-- promotes its oldest live per-env advisor instead, so every org with any
-- live advisor ends this migration with exactly one live org-wide row.
UPDATE "agents" SET "environment_id" = NULL
WHERE "id" IN (
  SELECT DISTINCT ON ("organization_id") "id" FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL
    AND "environment_id" IS NOT NULL
    AND "organization_id" NOT IN (
      SELECT "organization_id" FROM "agents"
      WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
        AND "deleted_at" IS NULL
        AND "environment_id" IS NULL)
  ORDER BY "organization_id", "created_at", "id");
--> statement-breakpoint

-- Auto-mode "advisor off" state: repoint exclusions at the survivor. The PK
-- (agent_id, target_agent_id) absorbs agents that already exclude both rows.
WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
INSERT INTO "agent_excluded_subagents" ("agent_id", "target_agent_id")
SELECT e."agent_id", s."id"
FROM "agent_excluded_subagents" e
JOIN "agents" old ON old."id" = e."target_agent_id"
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."deleted_at" IS NULL
  AND old."id" <> s."id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Seeded advisors get their delegation tools row lazily, so a survivor may
-- not have one. Promote the oldest per-env advisor's tool instead of
-- synthesizing a row: the agent__<slug> name comes from slugify() in TS, and
-- every advisor tool row in the org already carries the correct name.
WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
),
promotable AS (
  SELECT DISTINCT ON (s."organization_id") t."id" AS tool_id, s."id" AS survivor_id
  FROM survivor s
  JOIN "agents" old ON old."organization_id" = s."organization_id"
    AND old."built_in_agent_config"->>'name' = 'advisor-agent'
    AND old."deleted_at" IS NULL
    AND old."id" <> s."id"
  JOIN "tools" t ON t."delegate_to_agent_id" = old."id"
  WHERE t."deleted_at" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "tools" st WHERE st."delegate_to_agent_id" = s."id")
  ORDER BY s."organization_id", t."created_at", t."id"
)
UPDATE "tools" SET "delegate_to_agent_id" = p."survivor_id"
FROM promotable p
WHERE "tools"."id" = p."tool_id";
--> statement-breakpoint

-- Custom-mode grants: give every agent granted a retired advisor's tool a
-- grant on the survivor's canonical tool. UNIQUE (agent_id, tool_id) absorbs
-- agents that somehow hold both. The retired grants themselves cascade away
-- with the delete below.
WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
),
canonical AS (
  SELECT DISTINCT ON (s."organization_id") s."organization_id", t."id" AS tool_id
  FROM survivor s
  JOIN "tools" t ON t."delegate_to_agent_id" = s."id"
  ORDER BY s."organization_id", t."created_at", t."id"
)
INSERT INTO "agent_tools" ("agent_id", "tool_id")
SELECT gr."agent_id", c."tool_id"
FROM "agent_tools" gr
JOIN "tools" old_tool ON old_tool."id" = gr."tool_id"
JOIN "agents" old ON old."id" = old_tool."delegate_to_agent_id"
JOIN canonical c ON c."organization_id" = old."organization_id"
WHERE old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."deleted_at" IS NULL
  AND old_tool."id" <> c."tool_id"
ON CONFLICT ("agent_id", "tool_id") DO NOTHING;
--> statement-breakpoint

-- History: keep past consultations attributable. environment_id snapshot
-- columns on these tables are untouched, so per-env history survives.
WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "interactions" i SET "profile_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE i."profile_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "conversations" c SET "agent_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE c."agent_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "mcp_tool_calls" m SET "agent_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE m."agent_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "a2a_task" t SET "agent_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE t."agent_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

-- Operational state that would otherwise CASCADE away with the retired rows.
-- Expected empty for advisors (the advisor is delegation-only); remapped
-- defensively. A unique-constraint collision here fails the migration loudly,
-- which beats silently destroying a configured binding.
WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "schedule_triggers" x SET "agent_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE x."agent_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "chatops_channel_binding" x SET "agent_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE x."agent_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "connection_setups" x SET "mcp_gateway_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE x."mcp_gateway_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "connection_setups" x SET "llm_proxy_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE x."llm_proxy_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "virtual_api_key_llm_proxy" x SET "llm_proxy_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE x."llm_proxy_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "hook_files" x SET "agent_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE x."agent_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "browser_tab_states" x SET "agent_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE x."agent_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "mcp_gateway_tasks" x SET "agent_id" = s."id"
FROM "agents" old
JOIN survivor s ON s."organization_id" = old."organization_id"
WHERE x."agent_id" = old."id"
  AND old."built_in_agent_config"->>'name' = 'advisor-agent'
  AND old."id" <> s."id";
--> statement-breakpoint

-- Retire every other advisor row, live or soft-deleted. CASCADE now only
-- reaches the retired rows' own delegation tools (and through them the stale
-- grants), exclusions, versions, and config-mirror junctions the survivor
-- already has. member/projects default_agent_id fall back via SET NULL.
WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
DELETE FROM "agents"
WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
  AND "id" NOT IN (SELECT "id" FROM survivor);
