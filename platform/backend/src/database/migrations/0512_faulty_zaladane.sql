-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=widening integer to bigint keeps every value, and older code reads both types through Drizzle as numbers; limit_model_usage holds one row per limit and model, so the rewrite is brief.
ALTER TABLE "limit_model_usage" ALTER COLUMN "current_usage_tokens_in" SET DATA TYPE bigint, ALTER COLUMN "current_usage_tokens_out" SET DATA TYPE bigint;
