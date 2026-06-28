ALTER TABLE "apps" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "apps_environment_id_idx" ON "apps" USING btree ("environment_id");