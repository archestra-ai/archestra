-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign key column and referenced table are unchanged; only the on-delete behavior is updated, so every existing row already satisfies it and re-validation cannot fail. schedule_triggers is small (one row per scheduled task), so the brief lock is negligible.
ALTER TABLE "schedule_triggers" DROP CONSTRAINT "schedule_triggers_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD CONSTRAINT "schedule_triggers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;