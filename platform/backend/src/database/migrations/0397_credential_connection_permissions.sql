-- Personal installations are exclusively late-bound to the caller. Remove any
-- existing static assignment or catalog default before enforcing that rule in
-- application validation.
UPDATE "agent_tools" AS "assignment"
SET
  "mcp_server_id" = NULL,
  "credential_resolution_mode" = 'dynamic',
  "updated_at" = NOW()
FROM "mcp_server" AS "server"
WHERE
  "assignment"."mcp_server_id" = "server"."id"
  AND "server"."scope" = 'personal';
--> statement-breakpoint
UPDATE "app_tools" AS "assignment"
SET
  "mcp_server_id" = NULL,
  "credential_resolution_mode" = 'dynamic',
  "updated_at" = NOW()
FROM "mcp_server" AS "server"
WHERE
  "assignment"."mcp_server_id" = "server"."id"
  AND "server"."scope" = 'personal';
--> statement-breakpoint
UPDATE "internal_mcp_catalog" AS "catalog"
SET
  "dynamic_connection_mcp_server_id" = NULL,
  "updated_at" = NOW()
FROM "mcp_server" AS "server"
WHERE
  "catalog"."dynamic_connection_mcp_server_id" = "server"."id"
  AND "server"."scope" = 'personal';
--> statement-breakpoint
-- Personal MCP credentials are intentionally not configurable through custom
-- roles. Remove the short-lived permission key from any role snapshots created
-- while this change was under development.
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'credentialConnection')::text
WHERE COALESCE("permission", '') LIKE '%"credentialConnection"%';
