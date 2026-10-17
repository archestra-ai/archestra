-- Indexes for the list pages' first reads. The agents ones let the agent list
-- pick a page by name or creation time per lifecycle bucket from the index
-- alone (live and deleted agents are listed separately). The audit_logs one
-- serves the Audit Logs resource picker's newest-entry-per-resource lookup.
-- Not CONCURRENTLY: migrations run in a transaction. Audit writes are
-- fire-and-forget, so a brief block delays log inserts, not user responses
-- (built in about 1 s per 256k audit rows locally). agents is small and
-- rarely written (the four indexes build in about 0.8 s at 66k agents).
CREATE INDEX "agents_org_name_live_idx" ON "agents" USING btree ("organization_id","name","id","agent_type","author_id","built_in","is_default") WHERE "agents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agents_org_name_deleted_idx" ON "agents" USING btree ("organization_id","name","id","agent_type","author_id","built_in","is_default") WHERE "agents"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agents_org_created_at_live_idx" ON "agents" USING btree ("organization_id","created_at","id") WHERE "agents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agents_org_created_at_deleted_idx" ON "agents" USING btree ("organization_id","created_at","id") WHERE "agents"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_org_resource_latest_idx" ON "audit_logs" USING btree ("organization_id","resource_type","resource_id","created_at" DESC NULLS LAST,"event_sequence" DESC NULLS LAST,"resource_name","actor_id") WHERE "audit_logs"."resource_id" IS NOT NULL;