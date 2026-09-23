ALTER TABLE "knowledge_base_connectors" ADD COLUMN "sync_permissions_from_source" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Connector permission sync gets its own switch. It used to be one value of
-- `visibility`, which also carried the retired org/team audience. Idempotent.
UPDATE "knowledge_base_connectors"
SET "sync_permissions_from_source" = true
WHERE "visibility" = 'auto-sync-permissions'
  AND "sync_permissions_from_source" = false;--> statement-breakpoint
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
WHERE setup."llm_proxy_id" = retired."old_id";--> statement-breakpoint
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
ON CONFLICT DO NOTHING;--> statement-breakpoint
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
WHERE interaction."profile_id" = retired."old_id";--> statement-breakpoint
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
WHERE org."connection_default_llm_proxy_id" = retired."old_id";--> statement-breakpoint
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
  AND policy."scope" = retired."old_id"::text;--> statement-breakpoint
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
