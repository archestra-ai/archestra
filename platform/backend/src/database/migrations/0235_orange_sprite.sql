ALTER TABLE "limits" ADD COLUMN "cleanup_interval" varchar;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_user_limit_type" varchar;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_user_limit_value" integer;