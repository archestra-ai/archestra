-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The sync source table is new and empty; its ownership foreign key cannot reject existing rows. The unique index covers only the new task type, so no existing tasks can conflict.
CREATE TABLE "guardrails_deployment" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openappa_github_sync" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"ref" text,
	"path" text NOT NULL,
	"interval" text,
	"github_pat_id" uuid,
	"github_app_config_id" uuid,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"content" text,
	"source_commit" text,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text
);
--> statement-breakpoint
ALTER TABLE "openappa_github_sync" ADD CONSTRAINT "openappa_github_sync_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_openappa_github_sync_single_flight_idx" ON "tasks" USING btree (("payload" ->> 'organizationId')) WHERE "tasks"."task_type" = 'openappa_github_sync' AND "tasks"."status" IN ('pending', 'processing');