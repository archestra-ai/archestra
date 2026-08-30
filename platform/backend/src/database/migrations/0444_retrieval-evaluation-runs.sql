-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=retrieval_evaluation_runs is created empty in this migration, so its validating foreign keys and partial unique index cannot fail existing rows and its non-concurrent indexes cannot block production writes. ON DELETE CASCADE is intentional: evaluation history belongs to the organization and must not outlive it.
CREATE TABLE "retrieval_evaluation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"requested_by_user_id" text,
	"task_id" uuid,
	"name" text NOT NULL,
	"query_limit" integer DEFAULT 10 NOT NULL,
	"selected_components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"component_fingerprints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"progress_current" integer DEFAULT 0 NOT NULL,
	"progress_total" integer DEFAULT 0 NOT NULL,
	"progress_message" text,
	"fixture_knowledge_base_id" uuid,
	"fixture_connector_id" uuid,
	"bm25_refreshed" boolean DEFAULT false NOT NULL,
	"artifact" jsonb,
	"error" text,
	"cancellation_requested_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retrieval_evaluation_runs" ADD CONSTRAINT "retrieval_evaluation_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_evaluation_runs" ADD CONSTRAINT "retrieval_evaluation_runs_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_evaluation_runs" ADD CONSTRAINT "retrieval_evaluation_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retrieval_evaluation_runs_org_created_idx" ON "retrieval_evaluation_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "retrieval_evaluation_runs_task_idx" ON "retrieval_evaluation_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "retrieval_evaluation_runs_global_execution_idx" ON "retrieval_evaluation_runs" USING btree ("status","started_at") WHERE "retrieval_evaluation_runs"."status" IN ('running', 'cancel_requested');--> statement-breakpoint
CREATE UNIQUE INDEX "retrieval_evaluation_runs_one_active_per_org_idx" ON "retrieval_evaluation_runs" USING btree ("organization_id") WHERE "retrieval_evaluation_runs"."status" IN ('queued', 'running', 'cancel_requested');
