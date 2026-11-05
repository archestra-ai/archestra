-- Cost statistics read every billing receipt in a time window. Receipts
-- outlive log retention, so without an index on created_at each read scans
-- the whole table, and the table only grows.
--
-- interaction_billing gets a row on every settled LLM request, so the index
-- is built CONCURRENTLY, which blocks no writes (see 0609 for the pattern):
-- 1. drizzle-kit runs every pending migration in one transaction, where
--    CONCURRENTLY is refused. The COMMIT commits the migrations before this
--    one, and each statement after it runs on its own.
-- 2. A concurrent build waits for older transactions but blocks no one, so it
--    gets a longer lock_timeout than the migration Job's 5 s. RESET restores
--    the Job's value.
-- 3. A failed concurrent build leaves an invalid index, which IF NOT EXISTS
--    would keep. The DO block then fails the migration, and
--    scripts/migrate-with-lock.mjs drops such leftovers before the rerun.
-- 4. The closing BEGIN gives the migrations after this one their transaction
--    back; drizzle-kit commits it.
COMMIT;--> statement-breakpoint
SET lock_timeout = '5min';--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "interaction_billing_created_at_idx" ON "interaction_billing" USING btree ("created_at");--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname = 'interaction_billing_created_at_idx'
      AND c.relnamespace = 'public'::regnamespace
      AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'Index build did not finish: interaction_billing_created_at_idx. Rerun the migration.';
  END IF;
END $$;--> statement-breakpoint
RESET lock_timeout;--> statement-breakpoint
BEGIN;
