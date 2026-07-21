-- Custom SQL migration file, put your code below! --

-- The single `environment:deploy-to-restricted` permission was split into
-- per-resource `deploy-to-restricted` actions (agent, llmProxy, mcpGateway,
-- app, skill, knowledgeSource, mcpRegistry) so orgs can allow, say, LLM
-- proxies in a restricted environment while still gating MCP server deploys.
-- Custom roles store a frozen JSON permission snapshot, so any role holding
-- the old action is granted every new per-resource action (preserving its
-- previous capability exactly), then the legacy action is stripped from the
-- `environment` entry. Predefined roles pick their permissions up from code.
-- LIKE checks keep this compatible with PGlite (no jsonb `?` operator).

UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{agent}',
  COALESCE("permission"::jsonb -> 'agent', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'agent')::text, '') LIKE '%"deploy-to-restricted"%';

UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{llmProxy}',
  COALESCE("permission"::jsonb -> 'llmProxy', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'llmProxy')::text, '') LIKE '%"deploy-to-restricted"%';

UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{mcpGateway}',
  COALESCE("permission"::jsonb -> 'mcpGateway', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'mcpGateway')::text, '') LIKE '%"deploy-to-restricted"%';

UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{app}',
  COALESCE("permission"::jsonb -> 'app', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'app')::text, '') LIKE '%"deploy-to-restricted"%';

UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{skill}',
  COALESCE("permission"::jsonb -> 'skill', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'skill')::text, '') LIKE '%"deploy-to-restricted"%';

UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{knowledgeSource}',
  COALESCE("permission"::jsonb -> 'knowledgeSource', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'knowledgeSource')::text, '') LIKE '%"deploy-to-restricted"%';

UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{mcpRegistry}',
  COALESCE("permission"::jsonb -> 'mcpRegistry', '[]'::jsonb) || '["deploy-to-restricted"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'environment')::text, '') LIKE '%"deploy-to-restricted"%'
  AND NOT COALESCE(("permission"::jsonb -> 'mcpRegistry')::text, '') LIKE '%"deploy-to-restricted"%';

-- Strip the legacy action from `environment`, keeping any other actions
-- (i.e. "admin") the role holds. Runs last: the additive updates above key
-- off the legacy action still being present.
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
