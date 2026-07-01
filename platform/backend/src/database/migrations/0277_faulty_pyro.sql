ALTER TABLE "environments" ADD COLUMN "validation_regex" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_environment_validation_regex" text;