-- Data migration: Rename RBAC resources in custom role permissions.
--
-- Resource renames:
--   interaction -> log
--   internalMcpCatalog -> mcpRegistry
--   conversation -> chat
--   limit -> llmLimit
--   llmLimits -> llmLimit
--   llmCosts -> llmCost
--   llmProviders -> llmProvider
--   secrets -> secret
--   agentTriggers -> agentTrigger
--
-- Resource merges:
--   mcpToolCall -> log (only had "read" action)
--   llmModels + chatSettings -> llmProvider
--   mcpServer -> mcpServerInstallation
--   tool + policy -> toolPolicy
--
-- Cleanup:
--   organization -> removed (internal to better-auth)
--
-- Note: Uses text LIKE checks instead of jsonb ? operator for PGlite compatibility.

-- Step 1: Rename "interaction" to "log"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'interaction') || jsonb_build_object('log', "permission"::jsonb->'interaction')
)::text
WHERE "permission"::text LIKE '%"interaction"%';

-- Step 2: Rename "internalMcpCatalog" to "mcpRegistry"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'internalMcpCatalog') || jsonb_build_object('mcpRegistry', "permission"::jsonb->'internalMcpCatalog')
)::text
WHERE "permission"::text LIKE '%"internalMcpCatalog"%';

-- Step 3: Rename "conversation" to "chat"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'conversation') || jsonb_build_object('chat', "permission"::jsonb->'conversation')
)::text
WHERE "permission"::text LIKE '%"conversation"%';

-- Step 4: Merge mcpToolCall into log
-- For roles that have mcpToolCall but no log, add log with ["read"]
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'mcpToolCall') || jsonb_build_object('log', '["read"]'::jsonb)
)::text
WHERE "permission"::text LIKE '%"mcpToolCall"%'
  AND NOT "permission"::text LIKE '%"log"%';

-- For roles that have both mcpToolCall and log, just remove mcpToolCall
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'mcpToolCall')::text
WHERE "permission"::text LIKE '%"mcpToolCall"%'
  AND "permission"::text LIKE '%"log"%';

-- Step 5: Merge "llmModels" and "chatSettings" into "llmProvider"
-- Take the union of actions from both resources, then remove the old keys.
-- chatSettings typically has more actions, so use it as the base and merge llmModels actions.

-- First: For roles with chatSettings, rename to llmProvider
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'chatSettings') || jsonb_build_object('llmProvider', "permission"::jsonb->'chatSettings')
)::text
WHERE "permission"::text LIKE '%"chatSettings"%';

-- Then: For roles with llmModels but no llmProvider (had llmModels but not chatSettings), rename to llmProvider
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'llmModels') || jsonb_build_object('llmProvider', "permission"::jsonb->'llmModels')
)::text
WHERE "permission"::text LIKE '%"llmModels"%'
  AND NOT "permission"::text LIKE '%"llmProvider"%';

-- Finally: For roles with both llmModels and llmProvider (had both old keys), just remove llmModels
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'llmModels')::text
WHERE "permission"::text LIKE '%"llmModels"%'
  AND "permission"::text LIKE '%"llmProvider"%';

-- Step 8: Rename "mcpServer" to "mcpServerInstallation"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'mcpServer') || jsonb_build_object('mcpServerInstallation', "permission"::jsonb->'mcpServer')
)::text
WHERE "permission"::text LIKE '%"mcpServer"%'
  AND NOT "permission"::text LIKE '%"mcpServerInstallation"%';

-- Step 9: Rename "limit" to "llmLimit"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'limit') || jsonb_build_object('llmLimit', "permission"::jsonb->'limit')
)::text
WHERE "permission"::text LIKE '%"limit"%'
  AND NOT "permission"::text LIKE '%"llmLimit"%';

-- Step 10: Merge "tool" and "policy" into "toolPolicy"
-- For roles with both, take the union of actions
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'tool' - 'policy') || jsonb_build_object('toolPolicy', "permission"::jsonb->'tool')
)::text
WHERE "permission"::text LIKE '%"tool"%'
  AND NOT "permission"::text LIKE '%"toolPolicy"%';

UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'policy') || jsonb_build_object('toolPolicy', "permission"::jsonb->'policy')
)::text
WHERE "permission"::text LIKE '%"policy"%'
  AND NOT "permission"::text LIKE '%"toolPolicy"%';

-- Step 11: Rename "llmCosts" to "llmCost"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'llmCosts') || jsonb_build_object('llmCost', "permission"::jsonb->'llmCosts')
)::text
WHERE "permission"::text LIKE '%"llmCosts"%';

-- Step 12: Rename "llmLimits" to "llmLimit" (in case any were created between migrations)
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'llmLimits') || jsonb_build_object('llmLimit', "permission"::jsonb->'llmLimits')
)::text
WHERE "permission"::text LIKE '%"llmLimits"%'
  AND NOT "permission"::text LIKE '%"llmLimit"%';

-- Step 13: Rename "llmProviders" to "llmProvider" (in case any were created between migrations)
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'llmProviders') || jsonb_build_object('llmProvider', "permission"::jsonb->'llmProviders')
)::text
WHERE "permission"::text LIKE '%"llmProviders"%'
  AND NOT "permission"::text LIKE '%"llmProvider"%';

-- Step 14: Rename "secrets" to "secret"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'secrets') || jsonb_build_object('secret', "permission"::jsonb->'secrets')
)::text
WHERE "permission"::text LIKE '%"secrets"%';

-- Step 15: Rename "agentTriggers" to "agentTrigger"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'agentTriggers') || jsonb_build_object('agentTrigger', "permission"::jsonb->'agentTriggers')
)::text
WHERE "permission"::text LIKE '%"agentTriggers"%';

-- Step 16: Remove "organization" from custom roles (now internal to better-auth)
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'organization')::text
WHERE "permission"::text LIKE '%"organization"%';
