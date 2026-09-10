-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The feature-flagged runtime now allows multiple turns per workspace. Move workload-name uniqueness to the new empty workspace table and retain a non-unique lookup index on agent_runs. Job-era writer compatibility is intentionally not retained. All other indexes target the new empty table.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
CREATE TABLE "agent_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"backend" text NOT NULL,
	"runtime_scope" text NOT NULL,
	"workload_name" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"active_task_id" uuid,
	"last_task_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"idle_at" timestamp,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
DROP INDEX "agent_runs_workload_name_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workspaces_workload_name_uidx" ON "agent_workspaces" USING btree ("workload_name");--> statement-breakpoint
CREATE INDEX "agent_workspaces_owner_idx" ON "agent_workspaces" USING btree ("organization_id","actor_kind","actor_id");--> statement-breakpoint
CREATE INDEX "agent_workspaces_expiry_idx" ON "agent_workspaces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_runs_workload_name_idx" ON "agent_runs" USING btree ("workload_name");