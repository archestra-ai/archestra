-- Deleting a model enforces every foreign key that points at it, one lookup
-- per deleted model and column. These columns had no index, so each lookup
-- read the whole table (about 0.3 s per model on 133k agents and 300k
-- conversations), and the model cleanup after a provider key delete or a
-- subscription disconnect hit the statement timeout. Partial on the nullable
-- columns: most rows leave them empty.
--
-- drizzle-kit runs every pending migration in one transaction, so each index
-- would otherwise block writes to its table until the whole batch commits.
-- The COMMIT below (as in 0125) commits the migrations before this one. Each
-- CREATE INDEX then runs and commits on its own, and blocks writes to its
-- table only while it builds. The closing BEGIN gives the migrations after
-- this one their transaction back. If a build fails, the earlier migrations
-- and the indexes already built stay; this migration is not recorded, and the
-- rerun skips the indexes that exist (IF NOT EXISTS).
-- To avoid even the short block on a very large deployment, build the
-- indexes concurrently before the upgrade, for example:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_model_id_idx"
--     ON "conversations" USING btree ("model_id") WHERE "model_id" IS NOT NULL;
COMMIT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_model_id_idx" ON "agents" USING btree ("model_id") WHERE "agents"."model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_fast_model_id_idx" ON "agents" USING btree ("fast_model_id") WHERE "agents"."fast_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_smart_model_id_idx" ON "agents" USING btree ("smart_model_id") WHERE "agents"."smart_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_auto_routing_fast_model_id_idx" ON "agents" USING btree ("auto_routing_fast_model_id") WHERE "agents"."auto_routing_fast_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_auto_routing_normal_model_id_idx" ON "agents" USING btree ("auto_routing_normal_model_id") WHERE "agents"."auto_routing_normal_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_auto_routing_smart_model_id_idx" ON "agents" USING btree ("auto_routing_smart_model_id") WHERE "agents"."auto_routing_smart_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_model_id_idx" ON "conversations" USING btree ("model_id") WHERE "conversations"."model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_default_model_id_idx" ON "member" USING btree ("default_model_id") WHERE "member"."default_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routing_decisions_model_id_idx" ON "routing_decisions" USING btree ("model_id");--> statement-breakpoint
BEGIN;
