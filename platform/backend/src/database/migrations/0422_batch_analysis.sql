-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=every flagged FOREIGN KEY and non-concurrent index targets a table created empty in this same file (batch_analyses, batch_analysis_rows, batch_analysis_cells, batch_analysis_runs, batch_analysis_team), so each constraint validates against zero rows and each index builds instantly; the pre-existing tables referenced (agents, team, user, kb_documents, kb_files) are only read for the FK check.
CREATE TABLE "batch_analysis_cells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"row_id" uuid NOT NULL,
	"column_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content" text,
	"citations" jsonb,
	"error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_analysis_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"label" text NOT NULL,
	"source_type" text NOT NULL,
	"source" jsonb NOT NULL,
	"sort_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"analysis_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"status" text NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"completed_rows" integer DEFAULT 0 NOT NULL,
	"total_cells" integer DEFAULT 0 NOT NULL,
	"done_cells" integer DEFAULT 0 NOT NULL,
	"errored_cells" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_analysis_team" (
	"batch_analysis_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "batch_analysis_team_batch_analysis_id_team_id_pk" PRIMARY KEY("batch_analysis_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "batch_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT 'personal' NOT NULL,
	"agent_id" uuid NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batch_analysis_cells" ADD CONSTRAINT "batch_analysis_cells_row_id_batch_analysis_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."batch_analysis_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_analysis_rows" ADD CONSTRAINT "batch_analysis_rows_analysis_id_batch_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."batch_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_analysis_runs" ADD CONSTRAINT "batch_analysis_runs_analysis_id_batch_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."batch_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_analysis_team" ADD CONSTRAINT "batch_analysis_team_batch_analysis_id_batch_analyses_id_fk" FOREIGN KEY ("batch_analysis_id") REFERENCES "public"."batch_analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_analysis_team" ADD CONSTRAINT "batch_analysis_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_analyses" ADD CONSTRAINT "batch_analyses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batch_analysis_cells_row_column_idx" ON "batch_analysis_cells" USING btree ("row_id","column_key");--> statement-breakpoint
CREATE INDEX "batch_analysis_cells_status_idx" ON "batch_analysis_cells" USING btree ("row_id","status");--> statement-breakpoint
CREATE INDEX "batch_analysis_rows_analysis_id_idx" ON "batch_analysis_rows" USING btree ("analysis_id","sort_index");--> statement-breakpoint
CREATE INDEX "batch_analysis_runs_analysis_id_idx" ON "batch_analysis_runs" USING btree ("analysis_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_analysis_runs_one_running_per_analysis_idx" ON "batch_analysis_runs" USING btree ("analysis_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "batch_analyses_org_id_idx" ON "batch_analyses" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "batch_analyses_scope_idx" ON "batch_analyses" USING btree ("scope");