ALTER TABLE "agents" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_environment_id_environments_id_fk";--> statement-breakpoint
CREATE INDEX "agents_environment_id_idx" ON "agents" USING btree ("environment_id");