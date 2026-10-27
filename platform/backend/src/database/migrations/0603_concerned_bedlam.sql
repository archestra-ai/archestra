-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The eight routing tables are created empty in this migration, so their foreign keys, unique indexes and indexes scan no existing rows and CONCURRENTLY is unnecessary. ON DELETE CASCADE intentionally removes an organization's routing history and backfills with the organization, a decision with its routed model, and a history session's usage and scores with the session. The agents and models changes add nullable or constant-default columns only; their new foreign keys and check are added NOT VALID and validated against small tables whose new columns are all null. The new tables and columns are additive and ignored by older releases. auto_routing_fit is a new task type no released build enqueues, so no existing row can violate the tasks single-flight partial unique index and no older writer inserts into it.
CREATE TABLE "routing_backfills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"status" text NOT NULL,
	"phase" text NOT NULL,
	"cutoff" timestamp with time zone NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"scanned_at" timestamp with time zone,
	"scorer_version_id" uuid,
	"max_sessions" integer,
	"max_cost_usd" numeric(10, 4),
	"reserved_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"spent_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"call_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"population_sessions" integer DEFAULT 0 NOT NULL,
	"population_tokens" bigint DEFAULT 0 NOT NULL,
	"breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cursor_profile_id" uuid,
	"cursor_created_at" text,
	"cursor_id" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_epoch" bigint DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"error" text,
	"fit_generation" bigint,
	"started_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "routing_backfills_status_check" CHECK ("routing_backfills"."status" IN ('running', 'scanned', 'done', 'failed', 'cancelled', 'superseded')),
	CONSTRAINT "routing_backfills_phase_check" CHECK ("routing_backfills"."phase" IN ('scan', 'score')),
	CONSTRAINT "routing_backfills_score_check" CHECK ("routing_backfills"."phase" = 'scan' OR ("routing_backfills"."scorer_version_id" IS NOT NULL AND "routing_backfills"."max_sessions" IS NOT NULL AND "routing_backfills"."max_cost_usd" IS NOT NULL AND "routing_backfills"."scanned_at" IS NOT NULL))
);
--> statement-breakpoint
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
	"lambda" double precision,
	"expected_cost_usd" numeric(16, 10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_decisions_reason_check" CHECK ("routing_decisions"."reason" IN ('planned', 'cold_start', 'scorer_error', 'plan_stale')),
	CONSTRAINT "routing_decisions_plan_id_check" CHECK (("routing_decisions"."plan_id" IS NULL) = ("routing_decisions"."reason" IN ('cold_start', 'plan_stale'))),
	CONSTRAINT "routing_decisions_scorer_error_features_check" CHECK ("routing_decisions"."reason" <> 'scorer_error' OR "routing_decisions"."features" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "routing_history_scores" (
	"history_session_id" uuid NOT NULL,
	"scorer_version_id" uuid NOT NULL,
	"status" text NOT NULL,
	"features" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scorer_cost" numeric(13, 10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_history_scores_history_session_id_scorer_version_id_pk" PRIMARY KEY("history_session_id","scorer_version_id"),
	CONSTRAINT "routing_history_scores_status_check" CHECK ("routing_history_scores"."status" IN ('pending', 'scored', 'no_text', 'failed')),
	CONSTRAINT "routing_history_scores_features_check" CHECK (("routing_history_scores"."features" IS NOT NULL) = ("routing_history_scores"."status" = 'scored'))
);
--> statement-breakpoint
CREATE TABLE "routing_history_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"backfill_id" uuid NOT NULL,
	"session_key" text NOT NULL,
	"session_source" text NOT NULL,
	"api_shape" text NOT NULL,
	"client" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"interactions" integer NOT NULL,
	"total_tokens" bigint NOT NULL,
	"sample_rank" bigint NOT NULL,
	"first_interaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_history_usage" (
	"interaction_id" uuid PRIMARY KEY NOT NULL,
	"history_session_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"input" bigint NOT NULL,
	"cache_read" bigint NOT NULL,
	"cache_write" bigint NOT NULL,
	"cache_write_1h" bigint NOT NULL,
	"output" bigint NOT NULL
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
	CONSTRAINT "routing_plans_status_check" CHECK ("routing_plans"."status" IN ('active', 'superseded', 'failed', 'cold_start', 'rejected')),
	CONSTRAINT "routing_plans_trigger_check" CHECK ("routing_plans"."trigger" IN ('initial', 'nightly', 'settings', 'manual', 'scorer_change', 'backfill')),
	CONSTRAINT "routing_plans_plan_check" CHECK (("routing_plans"."plan" IS NOT NULL) = ("routing_plans"."status" IN ('active', 'superseded'))),
	CONSTRAINT "routing_plans_error_check" CHECK ("routing_plans"."status" NOT IN ('failed', 'rejected') OR "routing_plans"."error" IS NOT NULL)
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
ALTER TABLE "routing_backfills" ADD CONSTRAINT "routing_backfills_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_backfills" ADD CONSTRAINT "routing_backfills_scorer_version_id_routing_scorer_versions_id_fk" FOREIGN KEY ("scorer_version_id") REFERENCES "public"."routing_scorer_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_backfills" ADD CONSTRAINT "routing_backfills_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_scorer_version_id_routing_scorer_versions_id_fk" FOREIGN KEY ("scorer_version_id") REFERENCES "public"."routing_scorer_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_history_scores" ADD CONSTRAINT "routing_history_scores_history_session_id_routing_history_sessions_id_fk" FOREIGN KEY ("history_session_id") REFERENCES "public"."routing_history_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_history_scores" ADD CONSTRAINT "routing_history_scores_scorer_version_id_routing_scorer_versions_id_fk" FOREIGN KEY ("scorer_version_id") REFERENCES "public"."routing_scorer_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_history_sessions" ADD CONSTRAINT "routing_history_sessions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_history_sessions" ADD CONSTRAINT "routing_history_sessions_backfill_id_routing_backfills_id_fk" FOREIGN KEY ("backfill_id") REFERENCES "public"."routing_backfills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_history_usage" ADD CONSTRAINT "routing_history_usage_history_session_id_routing_history_sessions_id_fk" FOREIGN KEY ("history_session_id") REFERENCES "public"."routing_history_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_plans" ADD CONSTRAINT "routing_plans_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_plans" ADD CONSTRAINT "routing_plans_scorer_version_id_routing_scorer_versions_id_fk" FOREIGN KEY ("scorer_version_id") REFERENCES "public"."routing_scorer_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routing_backfills_one_active_per_org_uidx" ON "routing_backfills" USING btree ("organization_id") WHERE "routing_backfills"."status" IN ('running', 'scanned');--> statement-breakpoint
CREATE INDEX "routing_backfills_org_created_at_idx" ON "routing_backfills" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_decisions_org_session_segment_uidx" ON "routing_decisions" USING btree ("organization_id","session_key","segment");--> statement-breakpoint
CREATE INDEX "routing_decisions_created_at_idx" ON "routing_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "routing_decisions_org_plan_idx" ON "routing_decisions" USING btree ("organization_id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_history_sessions_org_session_uidx" ON "routing_history_sessions" USING btree ("organization_id","session_key");--> statement-breakpoint
CREATE INDEX "routing_history_sessions_org_rank_idx" ON "routing_history_sessions" USING btree ("organization_id","sample_rank");--> statement-breakpoint
CREATE INDEX "routing_history_sessions_backfill_idx" ON "routing_history_sessions" USING btree ("backfill_id");--> statement-breakpoint
CREATE INDEX "routing_history_usage_session_idx" ON "routing_history_usage" USING btree ("history_session_id");--> statement-breakpoint
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
CREATE UNIQUE INDEX "tasks_auto_routing_fit_single_flight_idx" ON "tasks" USING btree (("payload" ->> 'organizationId')) WHERE "tasks"."task_type" = 'auto_routing_fit' AND "tasks"."status" IN ('pending', 'processing');--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_long_context_pricing_check" CHECK (num_nonnulls("models"."long_context_threshold", "models"."long_context_price_per_million_input", "models"."long_context_price_per_million_output", "models"."long_context_price_per_million_cache_read", "models"."long_context_price_per_million_cache_write") IN (0, 5) AND ("models"."long_context_threshold" IS NULL OR "models"."long_context_threshold" > 0)) NOT VALID;--> statement-breakpoint
ALTER TABLE "models" VALIDATE CONSTRAINT "models_long_context_pricing_check";--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "routing_plans"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config();
