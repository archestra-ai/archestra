-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=the unique index is dropped and recreated with the new tool_name column in the same transaction, and every external pin row is deleted in this migration (legacy group-pins cannot be attributed to a single tool), so the new uniqueness cannot fail on existing data. app_pins is written only by AppPinModel, which ships the matching conflict target in this same release.
DROP INDEX "app_pins_user_external_uidx";--> statement-breakpoint
ALTER TABLE "app_pins" ADD COLUMN "tool_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "app_pins_user_external_uidx" ON "app_pins" USING btree ("user_id","mcp_server_id","resource_uri","tool_name") WHERE "app_pins"."mcp_server_id" IS NOT NULL;--> statement-breakpoint
-- External pins are now identified per tool tile: several tools of one MCP
-- server commonly share a single ui:// resource, so a legacy
-- (user, install, resource) pin covered a whole group of tiles and cannot be
-- attributed to any single tool. Drop them; pins are per-user UI preferences
-- that are trivially re-created from the Apps page.
DELETE FROM "app_pins" WHERE "mcp_server_id" IS NOT NULL;
