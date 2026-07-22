-- Custom SQL migration file, put your code below! --

-- Two related RBAC rewrites on custom roles (frozen JSON permission
-- snapshots; predefined roles pick their permissions up from code). LIKE
-- checks keep this compatible with PGlite (no jsonb `?` operator).
--
-- 1. The single `environment:deploy-to-restricted` permission was split into
--    per-resource `deploy-to-restricted` actions (agent, llmProxy,
--    mcpGateway, app, skill, knowledgeSource, mcpRegistry) so orgs can
--    allow, say, LLM proxies in a restricted environment while still gating
--    MCP server deploys. Roles holding the old action (and roles holding
--    `environment:admin`, which used to imply it) are granted every new
--    per-resource action, preserving their previous capability exactly.
--
-- 2. `environment:admin` was replaced with CRUD actions. Roles holding
--    `admin` get `create`/`update`/`delete`; every custom role gets `read`
--    (environments were previously viewable by everyone).

-- === 1a. Roles with the legacy environment:deploy-to-restricted action get
-- ===     every per-resource deploy-to-restricted action.
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{agent}',
  COALESCE("permission"::jsonb -> 'agent', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'agent')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{llmProxy}',
  COALESCE("permission"::jsonb -> 'llmProxy', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'llmProxy')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{mcpGateway}',
  COALESCE("permission"::jsonb -> 'mcpGateway', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'mcpGateway')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{app}',
  COALESCE("permission"::jsonb -> 'app', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'app')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{skill}',
  COALESCE("permission"::jsonb -> 'skill', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'skill')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{knowledgeSource}',
  COALESCE("permission"::jsonb -> 'knowledgeSource', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'knowledgeSource')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{mcpRegistry}',
  COALESCE("permission"::jsonb -> 'mcpRegistry', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'mcpRegistry')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
-- Strip the legacy deploy-to-restricted action from `environment`. Runs
-- before the environment:admin rewrites so the admin-keyed additions below
-- see the role's original `admin` marker, and after the additions above,
-- which key off the legacy action still being present.
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{environment}',
  (
    SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
    FROM jsonb_array_elements("permission"::jsonb -> 'environment') AS elem
    WHERE elem <> '"deploy-to-restricted"'::jsonb
  )
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
-- === 1b. Roles with environment:admin could deploy everything to restricted
-- ===     environments (the old checks treated admin as implying it), so they
-- ===     get every per-resource deploy-to-restricted action too.
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{agent}',
  COALESCE("permission"::jsonb -> 'agent', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"admin"%'
  AND NOT COALESCE(("permission"::jsonb -> 'agent')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{llmProxy}',
  COALESCE("permission"::jsonb -> 'llmProxy', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"admin"%'
  AND NOT COALESCE(("permission"::jsonb -> 'llmProxy')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{mcpGateway}',
  COALESCE("permission"::jsonb -> 'mcpGateway', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"admin"%'
  AND NOT COALESCE(("permission"::jsonb -> 'mcpGateway')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{app}',
  COALESCE("permission"::jsonb -> 'app', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"admin"%'
  AND NOT COALESCE(("permission"::jsonb -> 'app')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{skill}',
  COALESCE("permission"::jsonb -> 'skill', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"admin"%'
  AND NOT COALESCE(("permission"::jsonb -> 'skill')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{knowledgeSource}',
  COALESCE("permission"::jsonb -> 'knowledgeSource', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"admin"%'
  AND NOT COALESCE(("permission"::jsonb -> 'knowledgeSource')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{mcpRegistry}',
  COALESCE("permission"::jsonb -> 'mcpRegistry', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"admin"%'
  AND NOT COALESCE(("permission"::jsonb -> 'mcpRegistry')::text, '') LIKE '%"deploy-to-restricted"%';
--> statement-breakpoint
-- === 2. environment:admin -> create/update/delete (read is added to every
-- ===    custom role below), then the admin action is stripped.
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{environment}',
  COALESCE("permission"::jsonb -> 'environment', '[]'::jsonb) || '["create"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"admin"%'
  AND NOT COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"create"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{environment}',
  COALESCE("permission"::jsonb -> 'environment', '[]'::jsonb) || '["update"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"admin"%'
  AND NOT COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"update"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{environment}',
  COALESCE("permission"::jsonb -> 'environment', '[]'::jsonb) || '["delete"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"admin"%'
  AND NOT COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"delete"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{environment}',
  (
    SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
    FROM jsonb_array_elements("permission"::jsonb -> 'environment') AS elem
    WHERE elem <> '"admin"'::jsonb
  )
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"admin"%';
--> statement-breakpoint
-- Every custom role gets environment:read — environments were previously
-- listable by any member, so existing roles keep that visibility. Creates
-- the environment entry when the role has none.
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{environment}',
  COALESCE("permission"::jsonb -> 'environment', '[]'::jsonb) || '["read"]'::jsonb
)::text
WHERE NOT COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"read"%';
