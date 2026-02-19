-- Custom SQL migration file, put your code below! --
-- Data migration: Add mcpGateway and llmProxy permissions to existing custom roles
-- wherever agent (or legacy profile) permissions exist.
-- This ensures backward compatibility when splitting the single "agent" RBAC resource
-- into three: agent, mcpGateway, llmProxy.

-- Note: The "permission" column is text type, so we cast to jsonb for manipulation.
-- Uses text LIKE checks instead of jsonb ? operator for PGlite compatibility.

-- Step 1: Rename any remaining "profile" keys to "agent" (backward compat with older data)
-- Step 2: Copy "agent" permissions to "mcpGateway" and "llmProxy"
UPDATE "organization_role"
SET "permission" = jsonb_set(
  jsonb_set(
    CASE WHEN "permission"::text LIKE '%"profile"%'
      THEN ("permission"::jsonb - 'profile') || jsonb_build_object('agent', "permission"::jsonb->'profile')
      ELSE "permission"::jsonb
    END,
    '{mcpGateway}',
    COALESCE(
      CASE WHEN "permission"::text LIKE '%"profile"%' THEN "permission"::jsonb->'profile' ELSE NULL END,
      "permission"::jsonb->'agent',
      '[]'::jsonb
    )
  ),
  '{llmProxy}',
  COALESCE(
    CASE WHEN "permission"::text LIKE '%"profile"%' THEN "permission"::jsonb->'profile' ELSE NULL END,
    "permission"::jsonb->'agent',
    '[]'::jsonb
  )
)::text
WHERE "permission"::text LIKE '%"agent"%' OR "permission"::text LIKE '%"profile"%';

-- Step 3: Remove stale "prompt" keys (resource was removed)
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'prompt')::text
WHERE "permission"::text LIKE '%"prompt"%';
