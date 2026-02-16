-- Rename RBAC resource "profile" to "agent" in custom role permissions
-- This aligns with the refactoring where the "Profile" concept was split into
-- Agents, MCP Gateways, and LLM Proxies (all stored in the agents table)
UPDATE "organization_role"
SET "permission" = REPLACE("permission"::text, '"profile"', '"agent"')::jsonb
WHERE "permission"::text LIKE '%"profile"%';