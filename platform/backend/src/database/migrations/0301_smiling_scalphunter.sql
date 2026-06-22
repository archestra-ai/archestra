ALTER TABLE "models" ADD COLUMN "cache_read_price_per_token" numeric(20, 12);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "cache_write_price_per_token" numeric(20, 12);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "custom_price_per_million_cache_read" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "custom_price_per_million_cache_write" numeric(10, 2);