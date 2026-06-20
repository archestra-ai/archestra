ALTER TABLE "app_versions" ADD COLUMN "spec" jsonb;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "spec" jsonb;