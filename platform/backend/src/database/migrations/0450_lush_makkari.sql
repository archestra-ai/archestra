-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=project_id is nullable, so adding it does not rewrite existing agent_runs rows; the validating foreign key sees only nulls at rollout, and the project index is required for project execution listings. agent_runs is a bounded task-session table, not the write-hot interactions path.
ALTER TABLE "agent_runs" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_project_id_idx" ON "agent_runs" USING btree ("project_id");
