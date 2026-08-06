-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Soft-delete for MCP servers, catalogs, and tools: the archestra-tools name-uniqueness index is dropped and recreated in the same transaction with an additional `deleted_at IS NULL` predicate. Every existing row has deleted_at NULL, so the recreated index enforces exactly the uniqueness that held before (the predicate only relaxes uniqueness for soft-deleted rows, which do not exist yet) — no existing data can violate it and older writers see unchanged constraints. The index is partial (archestra-catalog tools only), so the transactional rebuild covers few rows and takes no meaningful lock time. Same pattern as 0380 (skills soft-delete).
DROP INDEX "tools_archestra_catalog_name_uidx";--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE INDEX "internal_mcp_catalog_deleted_at_idx" ON "internal_mcp_catalog" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "mcp_server_deleted_at_idx" ON "mcp_server" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "tools_deleted_at_idx" ON "tools" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tools_archestra_catalog_name_uidx" ON "tools" USING btree ("catalog_id","name") WHERE "tools"."catalog_id" = '00000000-0000-4000-8000-000000000001' and "tools"."agent_id" is null and "tools"."delegate_to_agent_id" is null and "tools"."deleted_at" is null;