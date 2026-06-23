-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=agents holds only a handful of rows, so the brief validating lock from a plain FK add (and the index build) is acceptable
ALTER TABLE "agents" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_environment_id_idx" ON "agents" USING btree ("environment_id");
