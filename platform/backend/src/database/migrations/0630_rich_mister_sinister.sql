-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Intentional breaking change while auto routing is in alpha: an organization gets any number of auto routers, so the one router's settings move off its LLM proxy agent row into auto_routers, and tiers, plans and decisions are re-keyed by router. The boolean opt-in columns on agents, conversations and organization become router ids, backfilled before the old columns are dropped. auto_routers and auto_router_virtual_api_keys are created here and hold at most a row per organization at validation time. auto_routing_tiers and routing_plans hold a few rows per organization; routing_decisions holds one row per routed session segment since auto routing shipped, so its backfill, NOT NULL, foreign key and index builds are brief. Cascades are intended: deleting a router removes its tiers, plans, decisions and key assignments. Older application pods read the dropped columns, so stop application processes for the upgrade.
-- An organization had one auto router, configured on its LLM Proxy row. It
-- may now have several, each a row of auto_routers with its own tiers, plans
-- and decisions. The router an organization already has becomes "auto".
CREATE TABLE "auto_routers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"budget_usd_per_day" numeric(12, 2),
	"budget_preset" text,
	"scorer_api_key_id" uuid,
	"scorer_model" text NOT NULL,
	"scorer_version_id" uuid,
	"generation" bigint DEFAULT 0 NOT NULL,
	"planned_generation" bigint DEFAULT 0 NOT NULL,
	"uses_past_sessions" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_router_virtual_api_keys" (
	"router_id" uuid NOT NULL,
	"virtual_api_key_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auto_router_virtual_api_keys_pk" PRIMARY KEY("router_id","virtual_api_key_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_router_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "auto_router_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_auto_router_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "auto_routing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_routing_tiers" ADD COLUMN "router_id" uuid;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD COLUMN "router_id" uuid;--> statement-breakpoint
ALTER TABLE "routing_plans" ADD COLUMN "router_id" uuid;--> statement-breakpoint
-- One "auto" router per organization that configured or used auto routing,
-- with the settings of its LLM Proxy row. It keeps learning from the
-- organization's scored past sessions; routers created later start cold.
INSERT INTO "auto_routers" (
	"organization_id", "name", "budget_usd_per_day", "budget_preset",
	"scorer_model", "scorer_version_id", "generation", "planned_generation",
	"uses_past_sessions"
)
SELECT
	o."id", 'auto', a."auto_routing_budget_usd_per_day", a."auto_routing_budget_preset",
	'jev-1.13.0', a."auto_routing_scorer_version_id",
	COALESCE(a."auto_routing_generation", 0), COALESCE(a."auto_routing_planned_generation", 0),
	true
FROM "organization" AS o
LEFT JOIN "agents" AS a
	ON a."organization_id" = o."id"
	AND a."agent_type" = 'llm_proxy'
	AND a."is_default" = true
	AND a."deleted_at" IS NULL
WHERE COALESCE(a."auto_routing_enabled", false)
	OR a."auto_routing_budget_usd_per_day" IS NOT NULL
	OR a."auto_routing_budget_preset" IS NOT NULL
	OR EXISTS (SELECT 1 FROM "auto_routing_tiers" AS t WHERE t."organization_id" = o."id")
	OR EXISTS (SELECT 1 FROM "routing_plans" AS p WHERE p."organization_id" = o."id")
	OR EXISTS (SELECT 1 FROM "routing_decisions" AS d WHERE d."organization_id" = o."id")
	OR EXISTS (SELECT 1 FROM "routing_backfills" AS b WHERE b."organization_id" = o."id");--> statement-breakpoint
-- The switch that turned the one router on is now the organization's switch
-- for all of them.
UPDATE "organization" AS o
SET "auto_routing_enabled" = true
FROM "agents" AS a
WHERE a."organization_id" = o."id"
	AND a."agent_type" = 'llm_proxy'
	AND a."is_default" = true
	AND a."deleted_at" IS NULL
	AND a."auto_routing_enabled";--> statement-breakpoint
UPDATE "auto_routing_tiers" AS t SET "router_id" = r."id"
FROM "auto_routers" AS r WHERE r."organization_id" = t."organization_id";--> statement-breakpoint
UPDATE "routing_plans" AS p SET "router_id" = r."id"
FROM "auto_routers" AS r WHERE r."organization_id" = p."organization_id";--> statement-breakpoint
UPDATE "routing_decisions" AS d SET "router_id" = r."id"
FROM "auto_routers" AS r WHERE r."organization_id" = d."organization_id";--> statement-breakpoint
UPDATE "agents" AS a SET "auto_router_id" = r."id"
FROM "auto_routers" AS r WHERE r."organization_id" = a."organization_id" AND a."auto_model";--> statement-breakpoint
UPDATE "conversations" AS c SET "auto_router_id" = r."id"
FROM "auto_routers" AS r WHERE r."organization_id" = c."organization_id" AND c."auto_model";--> statement-breakpoint
UPDATE "organization" AS o SET "default_auto_router_id" = r."id"
FROM "auto_routers" AS r WHERE r."organization_id" = o."id" AND o."default_auto_model";--> statement-breakpoint
-- A virtual key got "auto" when its provider keys reached all three tiers; it
-- now needs the router assigned to it. Assign "auto" to the standard keys
-- that reach every tier's provider, or take every provider added later.
INSERT INTO "auto_router_virtual_api_keys" ("router_id", "virtual_api_key_id")
SELECT r."id", k."id"
FROM "auto_routers" AS r
JOIN "virtual_api_keys" AS k
	ON k."organization_id" = r."organization_id" AND k."key_type" = 'standard'
WHERE (SELECT count(*) FROM "auto_routing_tiers" AS t WHERE t."router_id" = r."id") = 3
	AND (
		k."include_future_providers"
		OR NOT EXISTS (
			SELECT 1
			FROM "auto_routing_tiers" AS t
			JOIN "chat_api_keys" AS tier_key ON tier_key."id" = t."provider_api_key_id"
			WHERE t."router_id" = r."id"
				AND NOT EXISTS (
					SELECT 1 FROM "virtual_api_key_provider_api_key" AS m
					WHERE m."virtual_api_key_id" = k."id"
						AND m."provider" = tier_key."provider"
				)
		)
	);--> statement-breakpoint
ALTER TABLE "auto_routing_tiers" ALTER COLUMN "router_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_decisions" ALTER COLUMN "router_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_plans" ALTER COLUMN "router_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_auto_routing_scorer_version_id_routing_scorer_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "auto_routing_tiers" DROP CONSTRAINT "auto_routing_tiers_organization_id_organization_id_fk";
--> statement-breakpoint
DROP INDEX "routing_decisions_org_session_segment_uidx";--> statement-breakpoint
DROP INDEX "routing_decisions_org_plan_idx";--> statement-breakpoint
DROP INDEX "routing_plans_one_active_per_org_uidx";--> statement-breakpoint
DROP INDEX "routing_plans_org_created_at_idx";--> statement-breakpoint
DROP INDEX "tasks_auto_routing_fit_single_flight_idx";--> statement-breakpoint
-- Fits queued by organization cannot be run by router; the dispatcher
-- enqueues them again within a minute.
DELETE FROM "tasks" WHERE "task_type" = 'auto_routing_fit' AND "status" = 'pending';--> statement-breakpoint
ALTER TABLE "auto_routing_tiers" DROP CONSTRAINT "auto_routing_tiers_organization_id_tier_pk";--> statement-breakpoint
ALTER TABLE "auto_routing_tiers" ADD CONSTRAINT "auto_routing_tiers_router_id_tier_pk" PRIMARY KEY("router_id","tier");--> statement-breakpoint
ALTER TABLE "auto_router_virtual_api_keys" ADD CONSTRAINT "auto_router_virtual_api_keys_router_id_auto_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."auto_routers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_router_virtual_api_keys" ADD CONSTRAINT "auto_router_virtual_api_keys_virtual_api_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("virtual_api_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_routers" ADD CONSTRAINT "auto_routers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_routers" ADD CONSTRAINT "auto_routers_scorer_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("scorer_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_routers" ADD CONSTRAINT "auto_routers_scorer_version_id_routing_scorer_versions_id_fk" FOREIGN KEY ("scorer_version_id") REFERENCES "public"."routing_scorer_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auto_router_virtual_api_keys_virtual_api_key_id_idx" ON "auto_router_virtual_api_keys" USING btree ("virtual_api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auto_routers_org_name_uidx" ON "auto_routers" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "auto_routers_one_past_sessions_per_org_uidx" ON "auto_routers" USING btree ("organization_id") WHERE "auto_routers"."uses_past_sessions";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_auto_router_id_auto_routers_id_fk" FOREIGN KEY ("auto_router_id") REFERENCES "public"."auto_routers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_routing_tiers" ADD CONSTRAINT "auto_routing_tiers_router_id_auto_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."auto_routers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_auto_router_id_auto_routers_id_fk" FOREIGN KEY ("auto_router_id") REFERENCES "public"."auto_routers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The organization's default router; the schema cannot declare it (circular import).
ALTER TABLE "organization" ADD CONSTRAINT "organization_default_auto_router_id_auto_routers_id_fk" FOREIGN KEY ("default_auto_router_id") REFERENCES "public"."auto_routers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_router_id_auto_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."auto_routers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_plans" ADD CONSTRAINT "routing_plans_router_id_auto_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."auto_routers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auto_routing_tiers_provider_api_key_id_idx" ON "auto_routing_tiers" USING btree ("provider_api_key_id");--> statement-breakpoint
CREATE INDEX "auto_routing_tiers_model_id_idx" ON "auto_routing_tiers" USING btree ("model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_decisions_router_session_segment_uidx" ON "routing_decisions" USING btree ("router_id","session_key","segment");--> statement-breakpoint
CREATE INDEX "routing_decisions_org_session_idx" ON "routing_decisions" USING btree ("organization_id","session_key");--> statement-breakpoint
CREATE INDEX "routing_decisions_plan_idx" ON "routing_decisions" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_plans_one_active_per_router_uidx" ON "routing_plans" USING btree ("router_id") WHERE "routing_plans"."status" = 'active';--> statement-breakpoint
CREATE INDEX "routing_plans_router_created_at_idx" ON "routing_plans" USING btree ("router_id","created_at");--> statement-breakpoint
CREATE INDEX "routing_plans_organization_id_idx" ON "routing_plans" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_auto_routing_fit_single_flight_idx" ON "tasks" USING btree (("payload" ->> 'routerId')) WHERE "tasks"."task_type" = 'auto_routing_fit' AND "tasks"."status" IN ('pending', 'processing');--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_model";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_enabled";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_budget_usd_per_day";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_budget_preset";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_scorer_version_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_generation";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "auto_routing_planned_generation";--> statement-breakpoint
ALTER TABLE "auto_routing_tiers" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "auto_model";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "default_auto_model";
