-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The bounded models catalog keeps eight integer digits and gains six fractional digits, preserving every stored value and NULL. Older readers already consume numeric strings. One ALTER rewrites the catalog once; lock_timeout bounds the wait for its exclusive lock. No interactions, billing receipts or frozen backfill prices are changed.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "custom_price_per_million_input" SET DATA TYPE numeric(16, 8),
  ALTER COLUMN "custom_price_per_million_output" SET DATA TYPE numeric(16, 8),
  ALTER COLUMN "custom_price_per_million_cache_read" SET DATA TYPE numeric(16, 8),
  ALTER COLUMN "custom_price_per_million_cache_write" SET DATA TYPE numeric(16, 8),
  ALTER COLUMN "long_context_price_per_million_input" SET DATA TYPE numeric(16, 8),
  ALTER COLUMN "long_context_price_per_million_output" SET DATA TYPE numeric(16, 8),
  ALTER COLUMN "long_context_price_per_million_cache_read" SET DATA TYPE numeric(16, 8),
  ALTER COLUMN "long_context_price_per_million_cache_write" SET DATA TYPE numeric(16, 8);
