ALTER TABLE "limits" ADD COLUMN "cleanup_interval" varchar;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_user_limit_value" integer;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_user_limit_cleanup_interval" varchar DEFAULT '1h';