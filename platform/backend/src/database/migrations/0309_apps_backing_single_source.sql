-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Apps are re-homed onto their backing internal_mcp_catalog as the single source of truth; apps.scope, apps.environment_id, and the app_team table are intentionally dropped and apps.mcp_server_id added. The companion data migration deletes every pre-existing app, so there is no old code reading these columns to roll out around (beta feature, single deploy).
ALTER TABLE "app_team" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "app_team" CASCADE;--> statement-breakpoint
ALTER TABLE "apps" DROP CONSTRAINT "apps_environment_id_environments_id_fk";
--> statement-breakpoint
DROP INDEX "apps_scope_idx";--> statement-breakpoint
DROP INDEX "apps_environment_id_idx";--> statement-breakpoint
DROP INDEX "apps_org_personal_name_idx";--> statement-breakpoint
DROP INDEX "apps_org_shared_name_idx";--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "mcp_server_id" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "internal_mcp_catalog_app_personal_name_uidx" ON "internal_mcp_catalog" USING btree ("organization_id","author_id","name") WHERE "internal_mcp_catalog"."server_type" = 'app' AND "internal_mcp_catalog"."scope" = 'personal' AND "internal_mcp_catalog"."parent_catalog_item_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "internal_mcp_catalog_app_shared_name_uidx" ON "internal_mcp_catalog" USING btree ("organization_id","name") WHERE "internal_mcp_catalog"."server_type" = 'app' AND "internal_mcp_catalog"."scope" IN ('team', 'org') AND "internal_mcp_catalog"."parent_catalog_item_id" IS NULL;--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN "scope";--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN "environment_id";
