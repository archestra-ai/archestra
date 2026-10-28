-- Deleting a model enforces every foreign key that points at it, once per
-- deleted model and column. These columns had no index, so each check read
-- the whole table, and the model cleanup after a provider key delete or a
-- subscription disconnect hit the statement timeout. Partial on the nullable
-- columns: most rows leave them empty.
--
-- agents and conversations are large and written all the time, so the
-- indexes are built CONCURRENTLY, which blocks no writes:
-- 1. drizzle-kit runs every pending migration in one transaction, where
--    CONCURRENTLY is refused. The COMMIT (as in 0125) commits the migrations
--    before this one, and each statement after it runs on its own.
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
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agents_model_id_idx" ON "agents" USING btree ("model_id") WHERE "agents"."model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agents_fast_model_id_idx" ON "agents" USING btree ("fast_model_id") WHERE "agents"."fast_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agents_smart_model_id_idx" ON "agents" USING btree ("smart_model_id") WHERE "agents"."smart_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agents_auto_routing_fast_model_id_idx" ON "agents" USING btree ("auto_routing_fast_model_id") WHERE "agents"."auto_routing_fast_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agents_auto_routing_normal_model_id_idx" ON "agents" USING btree ("auto_routing_normal_model_id") WHERE "agents"."auto_routing_normal_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agents_auto_routing_smart_model_id_idx" ON "agents" USING btree ("auto_routing_smart_model_id") WHERE "agents"."auto_routing_smart_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_model_id_idx" ON "conversations" USING btree ("model_id") WHERE "conversations"."model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "member_default_model_id_idx" ON "member" USING btree ("default_model_id") WHERE "member"."default_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "routing_decisions_model_id_idx" ON "routing_decisions" USING btree ("model_id");--> statement-breakpoint
DO $$
DECLARE
  unusable text;
BEGIN
  SELECT string_agg(wanted.name, ', ')
  INTO unusable
  FROM unnest(ARRAY[
    'agents_model_id_idx',
    'agents_fast_model_id_idx',
    'agents_smart_model_id_idx',
    'agents_auto_routing_fast_model_id_idx',
    'agents_auto_routing_normal_model_id_idx',
    'agents_auto_routing_smart_model_id_idx',
    'conversations_model_id_idx',
    'member_default_model_id_idx',
    'routing_decisions_model_id_idx'
  ]) AS wanted(name)
  LEFT JOIN pg_class c
    ON c.relname = wanted.name AND c.relnamespace = 'public'::regnamespace
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
  WHERE i.indexrelid IS NULL OR NOT i.indisvalid;
  IF unusable IS NOT NULL THEN
    RAISE EXCEPTION 'Index build did not finish: %. Rerun the migration.', unusable;
  END IF;
END $$;--> statement-breakpoint
RESET lock_timeout;--> statement-breakpoint
BEGIN;
