-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The schedule_triggers.project_id FK targets the all-NULL column added in this same migration, so validation scans no existing rows and takes no blocking lock; the index is on that same just-added column. The add-validating-constraint / create-index rules do not apply here.
ALTER TABLE "conversations" ADD COLUMN "origin" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD CONSTRAINT "schedule_triggers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_triggers_project_id_idx" ON "schedule_triggers" USING btree ("project_id");