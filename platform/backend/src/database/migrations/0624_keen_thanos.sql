-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Intentional 1.5 breaking change, like the org-trio migration it reverses (both land within the 1.5 release candidates): org_trio_pending_normal_tier, which only that migration's startup check read, is dropped after its stashed normal tiers are copied into auto_routing_tiers. The auto_routing_tiers foreign keys target a table created empty in this migration, so validation scans no existing rows. ON DELETE CASCADE intentionally removes a tier with its organization, key or model. The new agents, conversations and organization columns are constant-default booleans. Older application pods read the dropped table at startup, so stop application processes for the upgrade.
CREATE TABLE "auto_routing_tiers" (
	"organization_id" text NOT NULL,
	"tier" text NOT NULL,
	"provider_api_key_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	CONSTRAINT "auto_routing_tiers_organization_id_tier_pk" PRIMARY KEY("organization_id","tier")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_model" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "auto_model" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_auto_model" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_routing_tiers" ADD CONSTRAINT "auto_routing_tiers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_routing_tiers" ADD CONSTRAINT "auto_routing_tiers_provider_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("provider_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_routing_tiers" ADD CONSTRAINT "auto_routing_tiers_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Auto routing gets its own tiers again instead of the organization's default
-- model trio, which stays what forked subagents and built-in tasks run on.
-- Organizations that configured auto routing (enabled, or a budget set) keep
-- routing across the models they route across today. A normal tier the
-- org-trio migration stashed and never moved is the one they routed across.
-- Each tier is paired with an organization key that serves its model: the
-- default key first, then the primary one, then the oldest.
WITH "configured" AS (
  SELECT
    a."organization_id",
    o."default_fast_model_id" AS "fast",
    COALESCE(
      CASE WHEN NOT p."moved" THEN p."normal_model_id"::uuid END,
      o."default_model_id"
    ) AS "normal",
    o."default_smart_model_id" AS "smart",
    CASE WHEN NOT p."moved" THEN p."api_key_id"::uuid END AS "stashed_key",
    o."default_llm_api_key_id" AS "default_key"
  FROM "agents" AS a
  JOIN "organization" AS o ON o."id" = a."organization_id"
  LEFT JOIN "org_trio_pending_normal_tier" AS p
    ON p."organization_id" = a."organization_id"
  WHERE a."agent_type" = 'llm_proxy'
    AND a."is_default" = true
    AND a."deleted_at" IS NULL
    AND (a."auto_routing_enabled" OR a."auto_routing_budget_usd_per_day" IS NOT NULL)
), "wanted" AS (
  SELECT "organization_id", 'fast' AS "tier", "fast" AS "model_id", NULL::uuid AS "stashed_key", "default_key" FROM "configured" WHERE "fast" IS NOT NULL
  UNION ALL
  SELECT "organization_id", 'normal', "normal", "stashed_key", "default_key" FROM "configured" WHERE "normal" IS NOT NULL
  UNION ALL
  SELECT "organization_id", 'smart', "smart", NULL::uuid, "default_key" FROM "configured" WHERE "smart" IS NOT NULL
)
INSERT INTO "auto_routing_tiers" ("organization_id", "tier", "provider_api_key_id", "model_id")
SELECT DISTINCT ON (w."organization_id", w."tier")
  w."organization_id", w."tier", k."id", w."model_id"
FROM "wanted" AS w
JOIN "api_key_models" AS akm ON akm."model_id" = w."model_id"
JOIN "chat_api_keys" AS k
  ON k."id" = akm."api_key_id"
  AND k."organization_id" = w."organization_id"
  AND k."user_id" IS NULL
ORDER BY
  w."organization_id",
  w."tier",
  (k."id" = w."stashed_key") DESC NULLS LAST,
  (k."id" = w."default_key") DESC NULLS LAST,
  k."is_primary" DESC,
  k."created_at",
  k."id";--> statement-breakpoint
-- Fail closed: an enabled organization missing a tier (no organization key
-- serves its model) stops auto routing until an admin sets its tiers.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT a."id" AS "agent_id", a."organization_id"
    FROM "agents" AS a
    WHERE a."agent_type" = 'llm_proxy'
      AND a."is_default" = true
      AND a."deleted_at" IS NULL
      AND a."auto_routing_enabled"
      AND (SELECT count(*) FROM "auto_routing_tiers" AS t WHERE t."organization_id" = a."organization_id") < 3
  LOOP
    UPDATE "agents" SET "auto_routing_enabled" = false WHERE "id" = r."agent_id";
    RAISE NOTICE 'auto_routing_tiers: auto routing disabled for organization % (a tier has no organization key serving its model); set its tiers and re-enable',
      r."organization_id";
  END LOOP;
END $$;--> statement-breakpoint
-- Turning auto routing on used to route every chat and agent on the
-- organization default; that is now the organization default being "auto".
UPDATE "organization" AS o
SET "default_auto_model" = true
FROM "agents" AS a
WHERE a."organization_id" = o."id"
  AND a."agent_type" = 'llm_proxy'
  AND a."is_default" = true
  AND a."deleted_at" IS NULL
  AND a."auto_routing_enabled";--> statement-breakpoint
DROP TABLE "org_trio_pending_normal_tier" CASCADE;
