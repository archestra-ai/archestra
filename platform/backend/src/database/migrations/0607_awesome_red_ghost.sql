ALTER TABLE "model_pools" ADD COLUMN "stream_timeout_seconds" integer;--> statement-breakpoint
ALTER TABLE "model_pools" ADD COLUMN "timeout_seconds" integer;--> statement-breakpoint
ALTER TABLE "model_pools" ADD COLUMN "cooldown_seconds" integer;