ALTER TABLE "model_pool_members" ADD COLUMN "retry_settings" jsonb;--> statement-breakpoint
ALTER TABLE "model_pools" ADD COLUMN "retry_settings" jsonb;