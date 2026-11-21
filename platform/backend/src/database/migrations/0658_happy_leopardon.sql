-- drizzle-migration-linter: reason=llm_usage_hourly is a small aggregate table (tens of thousands of rows) written only by the llm_usage_rollup task; a plain CREATE INDEX briefly blocks that task and no request path.
-- Adoption reads LLM proxy traffic from the hourly usage rollup instead of
-- scanning `interactions`, and leaves out agent runs, so the rollup gains `run`
-- (`interactions.run_id` is set) as a key. `run_id` is set once when an
-- interaction is written, so the insert trigger already marks every hour that
-- needs it. Adding a nullable column is a catalog change on these aggregate
-- tables; no rewrite.
--
-- Hours rolled before this migration hold no `run`. Nothing is marked: the
-- llm_usage_rollup task refreshes them newest first once it has no other work,
-- without sending cost statistics to raw rows, and Adoption reads those hours
-- from raw rows until then. The partial index finds them.
ALTER TABLE "llm_usage_daily" ADD COLUMN "run" boolean;--> statement-breakpoint
ALTER TABLE "llm_usage_hourly" ADD COLUMN "run" boolean;--> statement-breakpoint
CREATE INDEX "llm_usage_hourly_run_unknown_idx" ON "llm_usage_hourly" USING btree ("hour") WHERE "llm_usage_hourly"."run" IS NULL;
