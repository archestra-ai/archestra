ALTER TABLE "skills" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "skills_environment_id_idx" ON "skills" USING btree ("environment_id");