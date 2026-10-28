-- Deleting a model enforces every foreign key that points at it, one lookup
-- per deleted model and column. These columns had no index, so each lookup
-- read the whole table (about 0.3 s per model on 133k agents and 300k
-- conversations), and the model cleanup after a provider key delete or a
-- subscription disconnect hit the statement timeout. Partial on the nullable
-- columns: most agents leave the tier and auto-routing columns empty.
--
-- drizzle-kit runs every pending migration in one transaction, so without the
-- COMMIT below each index would block writes to its table until the whole
-- batch commits. The COMMIT ends that transaction (as in 0125), and each
-- statement after it runs and commits on its own: an index build blocks
-- writes to its table only while it runs. After a failure the migration is
-- not recorded; the rerun skips the indexes already built (IF NOT EXISTS).
-- To avoid even that short block on a large deployment, build the indexes out
-- of band first, for example:
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
CREATE INDEX IF NOT EXISTS "routing_decisions_model_id_idx" ON "routing_decisions" USING btree ("model_id");