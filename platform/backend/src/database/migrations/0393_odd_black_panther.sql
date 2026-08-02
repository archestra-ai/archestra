-- Partial indexes for the soft-delete retention sweep's find-deleted scans.
-- The existing partial indexes on these tables are gated `deleted_at IS NULL`
-- and cannot serve a find-deleted query. Created NON-concurrently because
-- drizzle-kit runs each migration inside a transaction, where CREATE INDEX
-- CONCURRENTLY is disallowed. These are all modest tables, so the build blocks
-- writers only briefly; on a LARGE existing deployment, build them out of band
-- FIRST so the statements no-op via IF NOT EXISTS:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "<name>" ON "<table>"
--     USING btree ("deleted_at") WHERE "deleted_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "agents_deleted_at_purge_idx" ON "agents" USING btree ("deleted_at") WHERE "agents"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apps_deleted_at_purge_idx" ON "apps" USING btree ("deleted_at") WHERE "apps"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_base_connectors_deleted_at_purge_idx" ON "knowledge_base_connectors" USING btree ("deleted_at") WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_bases_deleted_at_purge_idx" ON "knowledge_bases" USING btree ("deleted_at") WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_deleted_at_purge_idx" ON "projects" USING btree ("deleted_at") WHERE "projects"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_deleted_at_purge_idx" ON "skills" USING btree ("deleted_at") WHERE "skills"."deleted_at" IS NOT NULL;
