-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The four routing tables are created empty in this migration, so their foreign keys, unique indexes and indexes scan no existing rows and CONCURRENTLY is unnecessary. ON DELETE CASCADE intentionally removes an organization's routing history with the organization, and a decision with its routed model. The agents and models changes add nullable or constant-default columns only; their new foreign keys and check are added NOT VALID and validated against small tables whose new columns are all null. The new tables and columns are additive and ignored by older releases.
CREATE TABLE "routing_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"session_key" text NOT NULL,
	"segment" integer DEFAULT 0 NOT NULL,
	"tier_index" smallint NOT NULL,
	"model_id" uuid NOT NULL,
	"propensity" double precision NOT NULL,
	"u" double precision NOT NULL,
	"plan_id" uuid,
	"reason" text NOT NULL,
	"scorer_version_id" uuid,
	"features" jsonb,
	"scorer_cost" numeric(13, 10),
	"features_schema_version" integer NOT NULL,
	"core_version" text NOT NULL,
	"plan_format_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_decisions_reason_check" CHECK ("routing_decisions"."reason" IN ('planned', 'cold_start', 'scorer_error', 'plan_stale')),
	CONSTRAINT "routing_decisions_plan_id_check" CHECK (("routing_decisions"."plan_id" IS NULL) = ("routing_decisions"."reason" IN ('cold_start', 'plan_stale'))),
	CONSTRAINT "routing_decisions_scorer_error_features_check" CHECK ("routing_decisions"."reason" <> 'scorer_error' OR "routing_decisions"."features" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "routing_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"generation" bigint NOT NULL,
	"input_watermark" timestamp with time zone NOT NULL,
	"tiers_fingerprint" jsonb NOT NULL,
	"budget_usd_per_day" numeric(12, 2) NOT NULL,
	"scorer_version_id" uuid NOT NULL,
	"core_version" text NOT NULL,
	"plan_format_version" integer NOT NULL,
	"plan" jsonb,
	"summary" jsonb,
	"diagnostics" jsonb,
	"status" text NOT NULL,
	"error" text,
	CONSTRAINT "routing_plans_status_check" CHECK ("routing_plans"."status" IN ('active', 'superseded', 'failed', 'cold_start')),
	CONSTRAINT "routing_plans_trigger_check" CHECK ("routing_plans"."trigger" IN ('nightly', 'settings', 'manual', 'scorer_change')),
	CONSTRAINT "routing_plans_plan_check" CHECK (("routing_plans"."plan" IS NOT NULL) = ("routing_plans"."status" IN ('active', 'superseded'))),
	CONSTRAINT "routing_plans_error_check" CHECK ("routing_plans"."status" <> 'failed' OR "routing_plans"."error" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "routing_scorer_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"model" text NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_scorer_versions_spec_hash_unique" UNIQUE("spec_hash")
);
--> statement-breakpoint
CREATE TABLE "routing_usage" (
	"interaction_id" uuid PRIMARY KEY NOT NULL,
	"decision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"input" bigint NOT NULL,
	"cache_read" bigint NOT NULL,
	"cache_write" bigint NOT NULL,
	"cache_write_1h" bigint NOT NULL,
	"output" bigint NOT NULL,
	"estimated" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_routing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_routing_budget_usd_per_day" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_routing_fast_model_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_routing_normal_model_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_routing_smart_model_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_routing_scorer_version_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_routing_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "auto_routing_planned_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "long_context_threshold" integer;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "long_context_price_per_million_input" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "long_context_price_per_million_output" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "long_context_price_per_million_cache_read" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "long_context_price_per_million_cache_write" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_scorer_version_id_routing_scorer_versions_id_fk" FOREIGN KEY ("scorer_version_id") REFERENCES "public"."routing_scorer_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_plans" ADD CONSTRAINT "routing_plans_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_plans" ADD CONSTRAINT "routing_plans_scorer_version_id_routing_scorer_versions_id_fk" FOREIGN KEY ("scorer_version_id") REFERENCES "public"."routing_scorer_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routing_decisions_org_session_segment_uidx" ON "routing_decisions" USING btree ("organization_id","session_key","segment");--> statement-breakpoint
CREATE INDEX "routing_decisions_created_at_idx" ON "routing_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_plans_one_active_per_org_uidx" ON "routing_plans" USING btree ("organization_id") WHERE "routing_plans"."status" = 'active';--> statement-breakpoint
CREATE INDEX "routing_plans_org_created_at_idx" ON "routing_plans" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "routing_usage_decision_id_idx" ON "routing_usage" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "routing_usage_created_at_idx" ON "routing_usage" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_auto_routing_fast_model_id_models_id_fk" FOREIGN KEY ("auto_routing_fast_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_auto_routing_fast_model_id_models_id_fk";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_auto_routing_normal_model_id_models_id_fk" FOREIGN KEY ("auto_routing_normal_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_auto_routing_normal_model_id_models_id_fk";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_auto_routing_smart_model_id_models_id_fk" FOREIGN KEY ("auto_routing_smart_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_auto_routing_smart_model_id_models_id_fk";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_auto_routing_scorer_version_id_routing_scorer_versions_id_fk" FOREIGN KEY ("auto_routing_scorer_version_id") REFERENCES "public"."routing_scorer_versions"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_auto_routing_scorer_version_id_routing_scorer_versions_id_fk";--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_long_context_pricing_check" CHECK (num_nonnulls("models"."long_context_threshold", "models"."long_context_price_per_million_input", "models"."long_context_price_per_million_output", "models"."long_context_price_per_million_cache_read", "models"."long_context_price_per_million_cache_write") IN (0, 5) AND ("models"."long_context_threshold" IS NULL OR "models"."long_context_threshold" > 0)) NOT VALID;--> statement-breakpoint
ALTER TABLE "models" VALIDATE CONSTRAINT "models_long_context_pricing_check";--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "routing_plans"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config();
