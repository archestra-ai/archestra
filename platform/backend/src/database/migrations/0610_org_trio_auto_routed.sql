-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Intentional 1.5 breaking schema removal: agents.fast_model_id, agents.smart_model_id and the agents.auto_routing_{fast,normal,smart}_model_id columns (added during the 1.5 release candidates) are dropped with their indexes and foreign keys, because tiers now come from the organization's default model trio, which the statements below fill from the auto-routing tiers first. Older application pods read these columns, so stop application processes for the upgrade. The new auto_routed columns are constant-default; their checks are added NOT VALID and validated separately.
-- Auto routing now routes across the organization's default model trio, so
-- each organization's auto-routing tiers move into it. The tiers win over the
-- trio: they are the models auto routing actually sends traffic to.
-- Fast and smart are copied as they are.
UPDATE "organization" AS o
SET
  "default_fast_model_id" = COALESCE(a."auto_routing_fast_model_id", o."default_fast_model_id"),
  "default_smart_model_id" = COALESCE(a."auto_routing_smart_model_id", o."default_smart_model_id")
FROM "agents" AS a
WHERE a."organization_id" = o."id"
  AND a."agent_type" = 'llm_proxy'
  AND a."is_default" = true
  AND a."deleted_at" IS NULL
  AND (a."auto_routing_fast_model_id" IS NOT NULL OR a."auto_routing_smart_model_id" IS NOT NULL);--> statement-breakpoint
-- The default model is paired with a key. A normal tier that changes it moves
-- only with an organization-shared key linked to it (the current default key
-- first, then the primary one, then the oldest) and only while no Agent
-- Runtime agent inherits the default; otherwise the organization keeps its
-- default model and key. Personal keys are never promoted.
UPDATE "organization" AS o
SET
  "default_model_id" = t."normal_model_id",
  "default_llm_api_key_id" = t."api_key_id"
FROM (
  SELECT DISTINCT ON (a."organization_id")
    a."organization_id",
    a."auto_routing_normal_model_id" AS "normal_model_id",
    k."id" AS "api_key_id"
  FROM "agents" AS a
  JOIN "organization" AS org ON org."id" = a."organization_id"
  JOIN "api_key_models" AS akm ON akm."model_id" = a."auto_routing_normal_model_id"
  JOIN "chat_api_keys" AS k
    ON k."id" = akm."api_key_id"
    AND k."organization_id" = a."organization_id"
    AND k."user_id" IS NULL
  WHERE a."agent_type" = 'llm_proxy'
    AND a."is_default" = true
    AND a."deleted_at" IS NULL
    AND a."auto_routing_normal_model_id" IS NOT NULL
    AND a."auto_routing_normal_model_id" IS DISTINCT FROM org."default_model_id"
    -- Agent Runtime agents inheriting the default model were checked against
    -- it; another model could break them, so the default stays.
    AND NOT EXISTS (
      SELECT 1 FROM "agents" AS r
      WHERE r."organization_id" = a."organization_id"
        AND r."runtime" IS NOT NULL
        AND r."llm_api_key_id" IS NULL
        AND r."model_id" IS NULL
        AND r."deleted_at" IS NULL
    )
  ORDER BY
    a."organization_id",
    (k."id" = org."default_llm_api_key_id") DESC NULLS LAST,
    k."is_primary" DESC,
    k."created_at",
    k."id"
) AS t
WHERE o."id" = t."organization_id";--> statement-breakpoint
-- Fail closed: an enabled organization whose trio is not exactly the tiers it
-- routed across (a normal tier left behind for want of a shared key, or a
-- missing tier) stops auto routing until an admin sets its trio. Every normal
-- tier left behind is reported before its column is dropped.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT
      a."id" AS "agent_id",
      a."organization_id",
      a."auto_routing_enabled" AS "enabled",
      a."auto_routing_normal_model_id" AS "routed_normal",
      o."default_model_id" AS "trio_normal",
      (o."default_fast_model_id" IS NULL
        OR o."default_model_id" IS NULL
        OR o."default_smart_model_id" IS NULL) AS "incomplete"
    FROM "agents" AS a
    JOIN "organization" AS o ON o."id" = a."organization_id"
    WHERE a."agent_type" = 'llm_proxy'
      AND a."is_default" = true
      AND a."deleted_at" IS NULL
      AND (
        (a."auto_routing_normal_model_id" IS NOT NULL
          AND a."auto_routing_normal_model_id" IS DISTINCT FROM o."default_model_id")
        OR (a."auto_routing_enabled" AND (
          o."default_fast_model_id" IS NULL
          OR o."default_model_id" IS NULL
          OR o."default_smart_model_id" IS NULL))
      )
  LOOP
    IF r."routed_normal" IS NOT NULL AND r."routed_normal" IS DISTINCT FROM r."trio_normal" THEN
      RAISE NOTICE 'org_trio_auto_routed: organization % kept default model % instead of auto-routing normal tier % (no organization-shared key serves it, or an Agent Runtime agent inherits the default model)',
        r."organization_id", r."trio_normal", r."routed_normal";
    END IF;
    IF r."enabled" THEN
      UPDATE "agents" SET "auto_routing_enabled" = false WHERE "id" = r."agent_id";
      RAISE NOTICE 'org_trio_auto_routed: auto routing disabled for organization % (incomplete trio: %); set its default model trio and re-enable',
        r."organization_id", r."incomplete";
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_fast_model_id_models_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_smart_model_id_models_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_auto_routing_fast_model_id_models_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_auto_routing_normal_model_id_models_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_auto_routing_smart_model_id_models_id_fk";
--> statement-breakpoint
DROP INDEX "agents_fast_model_id_idx";--> statement-breakpoint
DROP INDEX "agents_smart_model_id_idx";--> statement-breakpoint
DROP INDEX "agents_auto_routing_fast_model_id_idx";--> statement-breakpoint
DROP INDEX "agents_auto_routing_normal_model_id_idx";--> statement-breakpoint
DROP INDEX "agents_auto_routing_smart_model_id_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_routed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "auto_routed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "fast_model_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "smart_model_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_fast_model_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_normal_model_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_smart_model_id";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_auto_routed_model_pool_check" CHECK (NOT ("agents"."auto_routed" AND "agents"."model_pool_id" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_auto_routed_model_pool_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_auto_routed_model_pool_check" CHECK (NOT ("conversations"."auto_routed" AND "conversations"."model_pool_id" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_auto_routed_model_pool_check";