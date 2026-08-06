ALTER TABLE "projects" ADD COLUMN "default_agent_id" uuid;--> statement-breakpoint
-- Added NOT VALID then validated separately, per the migration linter's
-- validation-lock rule. The column is new on this migration, so every existing
-- row is NULL and the validation scan cannot fail.
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_agent_id_agents_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "projects" VALIDATE CONSTRAINT "projects_default_agent_id_agents_id_fk";
