-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=primary provider keys move from scope partitions to owner partitions and skill names from scope partitions to author partitions; no reader of the old partitions is left
DROP INDEX "chat_api_keys_primary_personal_unique";
--> statement-breakpoint
DROP INDEX "chat_api_keys_primary_team_unique";
--> statement-breakpoint
DROP INDEX "chat_api_keys_primary_org_unique";
--> statement-breakpoint
DROP INDEX "skills_org_personal_name_idx";
--> statement-breakpoint
DROP INDEX "skills_org_shared_name_idx";
--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "sync_permissions_from_source" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Primary provider keys are now partitioned by owner: one per provider for
-- each owner's own keys, and one per provider among the shared keys (no
-- owner). Before the new unique indexes, demote every primary that a partition
-- would hold twice. A shared key that was the organization primary wins, then
-- the oldest key. Idempotent.
UPDATE "chat_api_keys" api_key
SET "is_primary" = false
FROM (
  SELECT "id", row_number() OVER (
    PARTITION BY "organization_id", "provider", "user_id"
    ORDER BY ("scope" = 'org') DESC, "created_at", "id"
  ) AS "rank"
  FROM "chat_api_keys"
  WHERE "is_primary" = true
) ranked
WHERE api_key."id" = ranked."id"
  AND ranked."rank" > 1;
--> statement-breakpoint
-- Skill names become unique per (organization, author), where a skill a
-- service account wrote keys on the service account. Before the new index,
-- rename any live skill that would share its name with another skill of the
-- same author. That happens only where one author held a personal skill and
-- a shared skill of the same name. The shared skill keeps its name, because
-- links to it name no author. The other gets its id prefix appended.
-- Idempotent: a second run finds no clash.
UPDATE "skills" skill
SET "name" = left(ranked."name", 55) || '-' || left(skill."id"::text, 8)
FROM (
  SELECT "id", "name", row_number() OVER (
    PARTITION BY "organization_id",
      coalesce("author_id", "created_by_service_account_id"::text), "name"
    ORDER BY ("scope" <> 'personal') DESC, "created_at", "id"
  ) AS "rank"
  FROM "skills"
  WHERE "deleted_at" IS NULL
    AND coalesce("author_id", "created_by_service_account_id"::text) IS NOT NULL
) ranked
WHERE skill."id" = ranked."id"
  AND ranked."rank" > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_primary_owner_unique" ON "chat_api_keys" USING btree ("organization_id","provider","user_id") WHERE "chat_api_keys"."is_primary" = true AND "chat_api_keys"."user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_primary_shared_unique" ON "chat_api_keys" USING btree ("organization_id","provider") WHERE "chat_api_keys"."is_primary" = true AND "chat_api_keys"."user_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "skills_org_author_name_idx" ON "skills" USING btree ("organization_id",coalesce("author_id", "created_by_service_account_id"::text),"name") WHERE "skills"."deleted_at" IS NULL;
--> statement-breakpoint
-- Connector permission sync gets its own switch. It used to be one value of
-- `visibility`, which also carried the retired org/team audience. Idempotent.
UPDATE "knowledge_base_connectors"
SET "sync_permissions_from_source" = true
WHERE "visibility" = 'auto-sync-permissions'
  AND "sync_permissions_from_source" = false;
--> statement-breakpoint
-- Retire the old non-default LLM proxy rows. Every proxy request already
-- resolves to the organization's single default proxy, so these rows are
-- aliases. Per organization, and only where that organization has a live
-- default proxy, repoint everything that still names an old row to the
-- default, then delete the old rows. Nothing that references them is lost:
-- connection setups, virtual-key bindings (a binding the default already
-- holds is skipped, not duplicated), interaction attribution and the
-- organization's connection default all move first. `agent_tools`,
-- `agent_team` and `agent_labels` rows go with the old rows by cascade.
-- Idempotent: a second run finds no old rows.
UPDATE "connection_setups" setup
SET "llm_proxy_id" = retired."default_id"
FROM (
  SELECT old_proxy."id" AS "old_id", default_proxy."id" AS "default_id"
  FROM "agents" old_proxy
  JOIN "agents" default_proxy
    ON default_proxy."organization_id" = old_proxy."organization_id"
    AND default_proxy."agent_type" = 'llm_proxy'
    AND default_proxy."is_default" = true
    AND default_proxy."deleted_at" IS NULL
  WHERE old_proxy."agent_type" = 'llm_proxy'
    AND old_proxy."is_default" = false
) retired
WHERE setup."llm_proxy_id" = retired."old_id";
--> statement-breakpoint
INSERT INTO "virtual_api_key_llm_proxy" ("virtual_api_key_id", "llm_proxy_id", "created_at")
SELECT binding."virtual_api_key_id", retired."default_id", min(binding."created_at")
FROM "virtual_api_key_llm_proxy" binding
JOIN (
  SELECT old_proxy."id" AS "old_id", default_proxy."id" AS "default_id"
  FROM "agents" old_proxy
  JOIN "agents" default_proxy
    ON default_proxy."organization_id" = old_proxy."organization_id"
    AND default_proxy."agent_type" = 'llm_proxy'
    AND default_proxy."is_default" = true
    AND default_proxy."deleted_at" IS NULL
  WHERE old_proxy."agent_type" = 'llm_proxy'
    AND old_proxy."is_default" = false
) retired ON retired."old_id" = binding."llm_proxy_id"
GROUP BY binding."virtual_api_key_id", retired."default_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Row-level locks only, through the profile_id index; inserts keep flowing.
UPDATE "interactions" interaction
SET "profile_id" = retired."default_id"
FROM (
  SELECT old_proxy."id" AS "old_id", default_proxy."id" AS "default_id"
  FROM "agents" old_proxy
  JOIN "agents" default_proxy
    ON default_proxy."organization_id" = old_proxy."organization_id"
    AND default_proxy."agent_type" = 'llm_proxy'
    AND default_proxy."is_default" = true
    AND default_proxy."deleted_at" IS NULL
  WHERE old_proxy."agent_type" = 'llm_proxy'
    AND old_proxy."is_default" = false
) retired
WHERE interaction."profile_id" = retired."old_id";
--> statement-breakpoint
UPDATE "organization" org
SET "connection_default_llm_proxy_id" = retired."default_id"
FROM (
  SELECT old_proxy."id" AS "old_id", default_proxy."id" AS "default_id"
  FROM "agents" old_proxy
  JOIN "agents" default_proxy
    ON default_proxy."organization_id" = old_proxy."organization_id"
    AND default_proxy."agent_type" = 'llm_proxy'
    AND default_proxy."is_default" = true
    AND default_proxy."deleted_at" IS NULL
  WHERE old_proxy."agent_type" = 'llm_proxy'
    AND old_proxy."is_default" = false
) retired
WHERE org."connection_default_llm_proxy_id" = retired."old_id";
--> statement-breakpoint
DELETE FROM "resource_permission_policies" policy
USING (
  SELECT old_proxy."id" AS "old_id", default_proxy."id" AS "default_id"
  FROM "agents" old_proxy
  JOIN "agents" default_proxy
    ON default_proxy."organization_id" = old_proxy."organization_id"
    AND default_proxy."agent_type" = 'llm_proxy'
    AND default_proxy."is_default" = true
    AND default_proxy."deleted_at" IS NULL
  WHERE old_proxy."agent_type" = 'llm_proxy'
    AND old_proxy."is_default" = false
) retired
WHERE policy."resource" IN ('agent', 'mcpGateway')
  AND policy."scope" = retired."old_id"::text;
--> statement-breakpoint
DELETE FROM "agents" agent
USING (
  SELECT old_proxy."id" AS "old_id", default_proxy."id" AS "default_id"
  FROM "agents" old_proxy
  JOIN "agents" default_proxy
    ON default_proxy."organization_id" = old_proxy."organization_id"
    AND default_proxy."agent_type" = 'llm_proxy'
    AND default_proxy."is_default" = true
    AND default_proxy."deleted_at" IS NULL
  WHERE old_proxy."agent_type" = 'llm_proxy'
    AND old_proxy."is_default" = false
) retired
WHERE agent."id" = retired."old_id";
--> statement-breakpoint
-- An app's backing server takes its install scope from the app's own grants:
-- one shared install (`org`) when they grant read to the whole organization
-- or to a role, per-user installs (`personal`) otherwise. The server kept a
-- copy of the retired app scope. Idempotent.
UPDATE "mcp_server" backing_server
SET "scope" = derived."scope", "team_id" = NULL
FROM (
  SELECT app."mcp_server_id" AS "server_id",
    CASE WHEN EXISTS (
      SELECT 1
      FROM "resource_permission_policies" app_policy,
        jsonb_array_elements(app_policy."grants") app_grant
      WHERE app_policy."organization_id" = app."organization_id"
        AND app_policy."resource" = 'app'
        AND app_policy."scope" = app."id"::text
        AND (app_grant->'actions') ? 'read'
        AND app_grant->'subject'->>'type' IN ('organization', 'role')
    ) THEN 'org' ELSE 'personal' END AS "scope"
  FROM "apps" app
  WHERE app."mcp_server_id" IS NOT NULL
) derived
WHERE backing_server."id" = derived."server_id"
  AND backing_server."server_type" = 'app'
  AND (
    backing_server."scope" IS DISTINCT FROM derived."scope"
    OR backing_server."team_id" IS NOT NULL
  );
