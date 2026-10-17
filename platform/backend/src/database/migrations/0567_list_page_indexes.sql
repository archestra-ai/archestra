-- Indexes for the first read of each list page. The agents indexes let the
-- agent list pick a page by name or creation time from the index alone.
-- Live and deleted agents have separate indexes because the list shows them
-- separately. The audit_logs index serves the Audit Logs resource picker:
-- the newest entry per resource.
-- Not CONCURRENTLY: migrations run in a transaction. Audit writes are
-- fire-and-forget, so the build delays log inserts, not user responses. The
-- audit_logs index builds in about 1 s per 256k rows. The agents table is
-- small and rarely written: its four indexes build in about 0.8 s at 66k rows.
CREATE INDEX "agents_org_name_live_idx" ON "agents" USING btree ("organization_id","name","id","agent_type","author_id","built_in","is_default") WHERE "agents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agents_org_name_deleted_idx" ON "agents" USING btree ("organization_id","name","id","agent_type","author_id","built_in","is_default") WHERE "agents"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agents_org_created_at_live_idx" ON "agents" USING btree ("organization_id","created_at","id") WHERE "agents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agents_org_created_at_deleted_idx" ON "agents" USING btree ("organization_id","created_at","id") WHERE "agents"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_org_resource_latest_idx" ON "audit_logs" USING btree ("organization_id","resource_type","resource_id","created_at" DESC NULLS LAST,"event_sequence" DESC NULLS LAST,"resource_name","actor_id") WHERE "audit_logs"."resource_id" IS NOT NULL;