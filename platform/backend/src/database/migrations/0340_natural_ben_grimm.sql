-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Recreate interactions_statistics_covering_idx to append billing_mode so the subscription-aware cost aggregations (SUM(cost) FILTER (WHERE billing_mode=...)) keep their index-only scan. Prod note: this is a non-concurrent index rebuild on a potentially large interactions table (schedule accordingly); ADD COLUMN ... DEFAULT is metadata-only in PG 11+.
DROP INDEX "interactions_statistics_covering_idx";--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "billing_mode" varchar DEFAULT 'metered' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD COLUMN "billing_mode" text DEFAULT 'metered' NOT NULL;--> statement-breakpoint
CREATE INDEX "interactions_statistics_covering_idx" ON "interactions" USING btree ("created_at","profile_id","model","input_tokens","output_tokens","cache_read_tokens","cost","baseline_cost","toon_cost_savings","cache_savings","billing_mode");