-- Deleting a model enforces every foreign key that points at it, one lookup
-- per deleted model and column. These columns had no index, so each lookup
-- read the whole table (about 0.3 s per model on 133k agents and 300k
-- conversations), and the model cleanup after a provider key delete or a
-- subscription disconnect hit the statement timeout. Partial on the nullable
-- columns: most agents leave the tier and auto-routing columns empty.
-- Not CONCURRENTLY: migrations run in a transaction. On a large deployment,
-- build the indexes out of band first so these statements no-op through
-- IF NOT EXISTS, for example:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_model_id_idx"
--     ON "conversations" USING btree ("model_id") WHERE "model_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "agents_model_id_idx" ON "agents" USING btree ("model_id") WHERE "agents"."model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_fast_model_id_idx" ON "agents" USING btree ("fast_model_id") WHERE "agents"."fast_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_smart_model_id_idx" ON "agents" USING btree ("smart_model_id") WHERE "agents"."smart_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_auto_routing_fast_model_id_idx" ON "agents" USING btree ("auto_routing_fast_model_id") WHERE "agents"."auto_routing_fast_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_auto_routing_normal_model_id_idx" ON "agents" USING btree ("auto_routing_normal_model_id") WHERE "agents"."auto_routing_normal_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_auto_routing_smart_model_id_idx" ON "agents" USING btree ("auto_routing_smart_model_id") WHERE "agents"."auto_routing_smart_model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_model_id_idx" ON "conversations" USING btree ("model_id") WHERE "conversations"."model_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routing_decisions_model_id_idx" ON "routing_decisions" USING btree ("model_id");