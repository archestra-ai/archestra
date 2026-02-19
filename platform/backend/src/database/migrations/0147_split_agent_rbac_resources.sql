-- Custom SQL migration file, put your code below! --
-- Data migration: Add mcpGateway and llmProxy permissions to existing custom roles
-- wherever agent (or legacy profile) permissions exist.
-- This ensures backward compatibility when splitting the single "agent" RBAC resource
-- into three: agent, mcpGateway, llmProxy.

-- Step 1: Rename any remaining "profile" keys to "agent" (backward compat with older data)
-- Step 2: Copy "agent" permissions to "mcpGateway" and "llmProxy"
UPDATE "organization_role"
SET "permission" = jsonb_set(
  jsonb_set(
    CASE WHEN "permission" ? 'profile'
      THEN ("permission" - 'profile') || jsonb_build_object('agent', "permission"->'profile')
      ELSE "permission"
    END,
    '{mcpGateway}',
    COALESCE(
      CASE WHEN "permission" ? 'profile' THEN "permission"->'profile' ELSE NULL END,
      "permission"->'agent',
      '[]'::jsonb
    )
  ),
  '{llmProxy}',
  COALESCE(
    CASE WHEN "permission" ? 'profile' THEN "permission"->'profile' ELSE NULL END,
    "permission"->'agent',
    '[]'::jsonb
  )
)
WHERE "permission" ? 'agent' OR "permission" ? 'profile';
