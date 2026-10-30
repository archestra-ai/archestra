-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Intentional 1.5 breaking schema removal: agents.fast_model_id, agents.smart_model_id and the agents.auto_routing_{fast,normal,smart}_model_id columns (added during the 1.5 release candidates) are dropped with their indexes and foreign keys, because tiers now come from the organization's default model trio, which the statements below fill from the auto-routing tiers first. Older application pods read these columns, so stop application processes for the upgrade.
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
-- first, then the primary one, then the oldest); otherwise the organization
-- keeps its default model and key. Personal keys are never promoted.
-- Agent Runtime agents inheriting the default model were checked against it,
-- so while one exists the move is stashed for the backend, which checks them
-- against the tier once at startup.
CREATE TABLE "org_trio_pending_normal_tier" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"normal_model_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"auto_routing_was_enabled" boolean NOT NULL,
	"expected_default_model_id" text,
	"expected_default_llm_api_key_id" text,
	"moved" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_trio_pending_normal_tier" ADD CONSTRAINT "org_trio_pending_normal_tier_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
WITH "candidate" AS (
  SELECT DISTINCT ON (a."organization_id")
    a."organization_id",
    a."auto_routing_normal_model_id" AS "normal_model_id",
    k."id" AS "api_key_id",
    a."auto_routing_enabled" AS "enabled",
    org."default_model_id" AS "expected_default_model_id",
    org."default_llm_api_key_id" AS "expected_default_llm_api_key_id",
    EXISTS (
      SELECT 1 FROM "agents" AS r
      WHERE r."organization_id" = a."organization_id"
        AND r."runtime" IS NOT NULL
        AND r."llm_api_key_id" IS NULL
        AND r."model_id" IS NULL
        AND r."deleted_at" IS NULL
    ) AS "runtime_inherits"
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
  ORDER BY
    a."organization_id",
    (k."id" = org."default_llm_api_key_id") DESC NULLS LAST,
    k."is_primary" DESC,
    k."created_at",
    k."id"
), "moved" AS (
  UPDATE "organization" AS o
  SET
    "default_model_id" = c."normal_model_id",
    "default_llm_api_key_id" = c."api_key_id"
  FROM "candidate" AS c
  WHERE o."id" = c."organization_id" AND NOT c."runtime_inherits"
)
INSERT INTO "org_trio_pending_normal_tier"
SELECT "organization_id", "normal_model_id", "api_key_id", "enabled",
  "expected_default_model_id", "expected_default_llm_api_key_id"
FROM "candidate"
WHERE "runtime_inherits";--> statement-breakpoint
-- Fail closed: an enabled organization whose trio is not exactly the tiers it
-- routed across (a normal tier left behind for want of a shared key, or a
-- missing tier) stops auto routing until an admin sets its trio, or until the
-- startup check moves a stashed tier. Every normal tier left behind is reported
-- before its column is dropped.
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
      RAISE NOTICE 'org_trio_auto_routed: organization % kept default model % instead of auto-routing normal tier % (no organization-shared key serves it, or it awaits the Agent Runtime check at startup)',
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
ALTER TABLE "agents" DROP COLUMN "fast_model_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "smart_model_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_fast_model_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_normal_model_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_smart_model_id";