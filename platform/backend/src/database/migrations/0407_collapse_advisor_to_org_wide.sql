-- Custom SQL migration file, put your code below! --

-- Collapse the built-in Advisor from one row per environment to a single
-- org-wide row (environment_id NULL). Delegation now carries an explicit
-- advisor exception across environment boundaries, so the per-environment
-- rows fold into one survivor per organization.
--
-- Discriminator: built_in_agent_config->>'name' = 'advisor-agent'.
-- Survivor per org: the oldest LIVE advisor row with environment_id NULL.
-- Soft-deleted null-env residue exists in production (deleteEnvironment used
-- to soft-delete the environment's advisor AFTER the FK nulled its
-- environment_id), so every survivor lookup filters deleted_at IS NULL.
--
-- The retired rows are SOFT-deleted, not removed: this runs as a pre-upgrade
-- hook while the previous release still serves the proxy, and hard-deleting a
-- row that an in-flight `interactions` insert references would block that
-- insert (FOR KEY SHARE) and then fail it (FK violation) mid-rollout. Soft
-- delete also keeps every past consultation attributed in place and is
-- reversible. Grants and exclusions are repointed at the survivor first so an
-- agent's "Consult the advisor" state survives the collapse; the retired
-- rows' own grants/history stay put, inert behind the notDeleted() filters
-- every read path already applies.

SET LOCAL statement_timeout = '120s';
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

-- The old per-environment advisors were each configured on their own — the
-- dialog told admins to "set a model on each one you want consulted". An org
-- that configured a named-environment advisor but left the Default (survivor)
-- one unset would fall back to the org default after the collapse. Adopt the
-- oldest configured sibling's model, key, and prompt onto an unconfigured
-- survivor first, so the collapse keeps a working advisor.
WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
),
donor AS (
  SELECT DISTINCT ON (s."id")
    s."id" AS survivor_id,
    old."model_id",
    old."llm_api_key_id",
    old."system_prompt"
  FROM survivor s
  JOIN "agents" surv ON surv."id" = s."id" AND surv."model_id" IS NULL
  JOIN "agents" old ON old."organization_id" = s."organization_id"
    AND old."built_in_agent_config"->>'name' = 'advisor-agent'
    AND old."deleted_at" IS NULL
    AND old."id" <> s."id"
    AND old."model_id" IS NOT NULL
  ORDER BY s."id", old."created_at", old."id"
)
UPDATE "agents" a SET
  "model_id" = d."model_id",
  "llm_api_key_id" = d."llm_api_key_id",
  "system_prompt" = d."system_prompt"
FROM donor d
WHERE a."id" = d."survivor_id";
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
-- not have an active one. Promote the oldest per-env advisor's live tool
-- instead of synthesizing a row: the agent__<slug> name comes from slugify()
-- in TS, and every advisor tool row in the org already carries it.
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
      SELECT 1 FROM "tools" st
      WHERE st."delegate_to_agent_id" = s."id" AND st."deleted_at" IS NULL)
  ORDER BY s."organization_id", t."created_at", t."id"
)
UPDATE "tools" SET "delegate_to_agent_id" = p."survivor_id"
FROM promotable p
WHERE "tools"."id" = p."tool_id";
--> statement-breakpoint

-- Custom-mode grants: give every agent granted a retired advisor's tool a
-- grant on the survivor's canonical (live) tool. UNIQUE (agent_id, tool_id)
-- absorbs agents that somehow hold both.
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
  JOIN "tools" t ON t."delegate_to_agent_id" = s."id" AND t."deleted_at" IS NULL
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

-- Retire every other advisor row by soft delete (live per-env rows; any
-- soft-deleted residue is already gone). notDeleted() filters keep them out
-- of every delegation surface, dispatch, and built-in lookup, while their
-- history stays attributed in place.
WITH survivor AS (
  SELECT DISTINCT ON ("organization_id") "id", "organization_id"
  FROM "agents"
  WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
    AND "deleted_at" IS NULL AND "environment_id" IS NULL
  ORDER BY "organization_id", "created_at", "id"
)
UPDATE "agents" SET "deleted_at" = now()
WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
  AND "deleted_at" IS NULL
  AND "id" NOT IN (SELECT "id" FROM survivor);
