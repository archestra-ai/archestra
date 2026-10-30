ALTER TABLE "models" ADD COLUMN "synced_long_context_threshold" integer;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "synced_long_context_prompt_price_per_token" numeric(20, 12);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "synced_long_context_completion_price_per_token" numeric(20, 12);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "synced_long_context_cache_read_price_per_token" numeric(20, 12);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "synced_long_context_cache_write_price_per_token" numeric(20, 12);--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_synced_long_context_pricing_check" CHECK (("models"."synced_long_context_threshold" IS NULL AND num_nonnulls("models"."synced_long_context_prompt_price_per_token", "models"."synced_long_context_completion_price_per_token", "models"."synced_long_context_cache_read_price_per_token", "models"."synced_long_context_cache_write_price_per_token") = 0) OR ("models"."synced_long_context_threshold" IS NOT NULL AND "models"."synced_long_context_threshold" > 0 AND "models"."synced_long_context_prompt_price_per_token" IS NOT NULL AND "models"."synced_long_context_completion_price_per_token" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "models" VALIDATE CONSTRAINT "models_synced_long_context_pricing_check";
