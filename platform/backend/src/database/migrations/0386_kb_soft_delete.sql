-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Each index is dropped and immediately recreated in this same migration as the partial (`deleted_at IS NULL`) equivalent, so no lookup loses its index. Both tables hold a handful of rows per organization (knowledge bases and their connectors are operator-created), so the non-concurrent rebuild is effectively instantaneous and takes no meaningful write lock.
DROP INDEX "knowledge_base_connectors_organization_id_idx";--> statement-breakpoint
DROP INDEX "knowledge_base_connectors_environment_id_idx";--> statement-breakpoint
DROP INDEX "knowledge_bases_organization_id_idx";--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE INDEX "knowledge_base_connectors_organization_id_idx" ON "knowledge_base_connectors" USING btree ("organization_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "knowledge_base_connectors_environment_id_idx" ON "knowledge_base_connectors" USING btree ("environment_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "knowledge_bases_organization_id_idx" ON "knowledge_bases" USING btree ("organization_id") WHERE deleted_at IS NULL;