ALTER TABLE "interactions" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "cache_cost" numeric(13, 10);