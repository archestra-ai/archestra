ALTER TABLE "limits" ADD COLUMN "cleanup_interval" varchar;--> statement-breakpoint
ALTER TABLE "limits" ADD COLUMN "is_default_user_limit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_user_limit_value" integer;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_user_limit_model" jsonb;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_user_limit_cleanup_interval" varchar;