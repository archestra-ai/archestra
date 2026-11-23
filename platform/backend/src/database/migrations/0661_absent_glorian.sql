ALTER TABLE "organization" ADD COLUMN "first_run_setup_completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "telemetry_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- The first-run setup dialog is for new installations only: organizations
-- that already exist are marked as done so their admins are not asked.
UPDATE "organization" SET "first_run_setup_completed_at" = now() WHERE "first_run_setup_completed_at" IS NULL;
