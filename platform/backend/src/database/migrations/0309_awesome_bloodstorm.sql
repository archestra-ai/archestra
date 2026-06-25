-- Custom SQL migration file, put your code below! --

-- Apps are being re-homed onto their backing internal_mcp_catalog as the single
-- source of truth for visibility + environment. Existing apps predate guaranteed
-- backing (most have none), so instead of backfilling we delete every app and its
-- related data; from here on apps are always created with backing. This
-- intentionally runs in every environment, including prod. Each statement is its
-- own breakpoint so the migrator runs them all (not just the first). Runs before
-- the schema migration, so app_team / apps.scope still exist here.

-- OAuth connector grants bound to app resources (text reference_id, no FK).
DELETE FROM "oauth_access_token" WHERE "reference_id" LIKE 'mcp-app-resource:%';--> statement-breakpoint
DELETE FROM "oauth_refresh_token" WHERE "reference_id" LIKE 'mcp-app-resource:%';--> statement-breakpoint
DELETE FROM "oauth_consent" WHERE "reference_id" LIKE 'mcp-app-resource:%';--> statement-breakpoint

-- app_versions.app_id is ON DELETE SET NULL, so remove version rows explicitly
-- (the app delete below would otherwise orphan them).
DELETE FROM "app_versions";--> statement-breakpoint

-- All apps. Cascades app_tools, app_data, app_render_diagnostics,
-- app_render_screenshots, and app_team rows (the next migration drops the
-- now-empty app_team table). mcp_tool_calls.app_id is ON DELETE SET NULL, so
-- audit history is retained with a null app reference.
DELETE FROM "apps";--> statement-breakpoint

-- Backing entities (serverType 'app'). Delete the catalog-team links first, then
-- servers (mcp_server.catalog_id is NOT NULL, so it must go before its catalog),
-- then the catalogs — whose delete cascades the backing tools (incl. the launch
-- tool) and, through them, their agent_tool assignments.
DELETE FROM "mcp_catalog_team" WHERE "catalog_id" IN (
  SELECT "id" FROM "internal_mcp_catalog" WHERE "server_type" = 'app'
);--> statement-breakpoint
DELETE FROM "mcp_server" WHERE "server_type" = 'app';--> statement-breakpoint
DELETE FROM "internal_mcp_catalog" WHERE "server_type" = 'app';
