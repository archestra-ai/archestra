-- Personal MCP credentials are intentionally not configurable through custom
-- roles. Remove the short-lived permission key from any role snapshots created
-- while this change was under development.
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'credentialConnection')::text
WHERE COALESCE("permission", '') LIKE '%"credentialConnection"%';
