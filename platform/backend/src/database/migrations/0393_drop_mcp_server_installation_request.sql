-- Remove the MCP server installation request feature.
--
-- The request list and detail pages were unreachable from the UI (nothing
-- linked to them), so the workflow could be started but never reviewed. The
-- routes, model, RBAC resource, and Archestra MCP tool are all removed in this
-- change; this migration drops the storage and the leftover permission.
--
-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The only code that reads this table (the
-- installation-request routes and their audit-log hooks) is deleted in this
-- same change, and those endpoints were already unreachable from the UI, so
-- there is no reader to strand during a rolling deploy. Splitting this into a
-- separate contract release would leave an orphan table whose feature no
-- longer exists in any supported version.
--
-- No CASCADE: nothing references this table. Its own two outbound FK
-- constraints to `user` (`requested_by`, `reviewed_by`) are dropped with it.
DROP TABLE "mcp_server_installation_request";--> statement-breakpoint
-- Strip the now-meaningless `mcpServerInstallationRequest` key from custom
-- roles (frozen JSON permission snapshots; predefined roles pick their
-- permissions up from code). Left in place it would render as an unknown
-- resource in the roles editor and count toward a role's granted permissions.
-- LIKE keeps this compatible with PGlite (no jsonb `?` operator).
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'mcpServerInstallationRequest')::text
WHERE COALESCE("permission", '') LIKE '%"mcpServerInstallationRequest"%';
