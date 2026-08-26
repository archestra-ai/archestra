-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All flagged foreign keys, unique indexes, and non-concurrent indexes target the four eval_* tables created empty in this same migration, so no existing rows can fail validation and index builds block nothing. CASCADE only removes eval-owned child rows (cases/runs/results) with their parent suite/run; agent CASCADE mirrors schedule_triggers.
CREATE TABLE "eval_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suite_id" uuid NOT NULL,
	"name" text NOT NULL,
	"input" text NOT NULL,
	"assertions" jsonb NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_run_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"case_id" uuid,
	"case_name" text NOT NULL,
	"input" text NOT NULL,
	"assertions" jsonb NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"output_text" text,
	"finish_reason" text,
	"tool_calls" jsonb,
	"assertion_results" jsonb,
	"error" text,
	"session_id" text,
	"judge_session_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"duration_ms" integer,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"suite_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text,
	"created_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"agent_name_snapshot" text NOT NULL,
	"model_snapshot" text,
	"total_cases" integer DEFAULT 0 NOT NULL,
	"passed_cases" integer DEFAULT 0 NOT NULL,
	"failed_cases" integer DEFAULT 0 NOT NULL,
	"errored_cases" integer DEFAULT 0 NOT NULL,
	"canceled_cases" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_suites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_suite_id_eval_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_results" ADD CONSTRAINT "eval_run_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_run_results" ADD CONSTRAINT "eval_run_results_case_id_eval_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."eval_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_suite_id_eval_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."eval_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_suites" ADD CONSTRAINT "eval_suites_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_cases_suite_id_position_idx" ON "eval_cases" USING btree ("suite_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_run_results_run_id_case_id_idx" ON "eval_run_results" USING btree ("run_id","case_id");--> statement-breakpoint
CREATE INDEX "eval_run_results_run_id_position_idx" ON "eval_run_results" USING btree ("run_id","position");--> statement-breakpoint
CREATE INDEX "eval_runs_organization_id_created_at_idx" ON "eval_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_runs_suite_id_idx" ON "eval_runs" USING btree ("suite_id");--> statement-breakpoint
CREATE INDEX "eval_runs_agent_id_idx" ON "eval_runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "eval_suites_organization_id_idx" ON "eval_suites" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_suites_org_name_idx" ON "eval_suites" USING btree ("organization_id","name") WHERE "eval_suites"."deleted_at" IS NULL;