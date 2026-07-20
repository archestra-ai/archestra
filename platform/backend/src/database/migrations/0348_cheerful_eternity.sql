ALTER TABLE "skills" ADD COLUMN "github_sync_interval" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "github_sync_ref" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "github_app_config_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "last_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_github_app_config_id_github_app_configs_id_fk" FOREIGN KEY ("github_app_config_id") REFERENCES "public"."github_app_configs"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "skills" VALIDATE CONSTRAINT "skills_github_app_config_id_github_app_configs_id_fk";--> statement-breakpoint
CREATE INDEX "skills_github_sync_due_idx" ON "skills" USING btree ("last_synced_at") WHERE "skills"."github_sync_interval" is not null;