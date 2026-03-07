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
--   tool + policy -> toolPolicy (union of both action arrays)
--
-- Cleanup:
--   organization -> removed (internal to better-auth)
--
-- Note: Uses text LIKE checks instead of jsonb ? operator for PGlite compatibility.
-- Key matching uses '"key":' pattern (with colon) to match exact JSON keys and
-- avoid substring collisions (e.g. "limit" vs "llmLimit").

-- Step 1: Rename "interaction" to "log"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'interaction') || jsonb_build_object('log', "permission"::jsonb->'interaction')
)::text
WHERE "permission"::text LIKE '%"interaction":%';

-- Step 2: Rename "internalMcpCatalog" to "mcpRegistry"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'internalMcpCatalog') || jsonb_build_object('mcpRegistry', "permission"::jsonb->'internalMcpCatalog')
)::text
WHERE "permission"::text LIKE '%"internalMcpCatalog":%';

-- Step 3: Rename "conversation" to "chat"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'conversation') || jsonb_build_object('chat', "permission"::jsonb->'conversation')
)::text
WHERE "permission"::text LIKE '%"conversation":%';

-- Step 4: Merge "mcpToolCall" into "log"
-- For roles that have mcpToolCall but no log, add log with ["read"]
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'mcpToolCall') || jsonb_build_object('log', '["read"]'::jsonb)
)::text
WHERE "permission"::text LIKE '%"mcpToolCall":%'
  AND NOT "permission"::text LIKE '%"log":%';

-- For roles that have both mcpToolCall and log, union actions into log
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'mcpToolCall') || jsonb_build_object(
    'log',
    (
      SELECT jsonb_agg(DISTINCT val)
      FROM (
        SELECT jsonb_array_elements_text("permission"::jsonb->'log') AS val
        UNION
        SELECT jsonb_array_elements_text("permission"::jsonb->'mcpToolCall') AS val
      ) combined
    )
  )
)::text
WHERE "permission"::text LIKE '%"mcpToolCall":%'
  AND "permission"::text LIKE '%"log":%';

-- Step 5: Rename "chatSettings" to "llmProvider"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'chatSettings') || jsonb_build_object('llmProvider', "permission"::jsonb->'chatSettings')
)::text
WHERE "permission"::text LIKE '%"chatSettings":%';

-- Step 6: Rename "llmModels" to "llmProvider" (for roles without chatSettings)
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'llmModels') || jsonb_build_object('llmProvider', "permission"::jsonb->'llmModels')
)::text
WHERE "permission"::text LIKE '%"llmModels":%'
  AND NOT "permission"::text LIKE '%"llmProvider":%';

-- Step 7: Union "llmModels" into "llmProvider" for roles that have both (had both old keys)
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'llmModels') || jsonb_build_object(
    'llmProvider',
    (
      SELECT jsonb_agg(DISTINCT val)
      FROM (
        SELECT jsonb_array_elements_text("permission"::jsonb->'llmProvider') AS val
        UNION
        SELECT jsonb_array_elements_text("permission"::jsonb->'llmModels') AS val
      ) combined
    )
  )
)::text
WHERE "permission"::text LIKE '%"llmModels":%'
  AND "permission"::text LIKE '%"llmProvider":%';

-- Step 8: Rename "mcpServer" to "mcpServerInstallation"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'mcpServer') || jsonb_build_object('mcpServerInstallation', "permission"::jsonb->'mcpServer')
)::text
WHERE "permission"::text LIKE '%"mcpServer":%'
  AND NOT "permission"::text LIKE '%"mcpServerInstallation":%';

-- Step 9: Rename "limit" to "llmLimit"
-- Uses '"limit":' pattern (with colon) to match the exact JSON key and avoid
-- matching "llmLimit" or "llmLimits" as substrings.
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'limit') || jsonb_build_object('llmLimit', "permission"::jsonb->'limit')
)::text
WHERE "permission"::text LIKE '%"limit":%'
  AND NOT "permission"::text LIKE '%"llmLimit":%';

-- Step 10: Merge "tool" + "policy" into "toolPolicy" (union of action arrays)
-- For roles that have both "tool" and "policy", combine actions from both via
-- SELECT DISTINCT to produce a deduplicated union array.
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'tool' - 'policy') || jsonb_build_object(
    'toolPolicy',
    (
      SELECT jsonb_agg(DISTINCT val)
      FROM (
        SELECT jsonb_array_elements_text("permission"::jsonb->'tool') AS val
        UNION
        SELECT jsonb_array_elements_text("permission"::jsonb->'policy') AS val
      ) combined
    )
  )
)::text
WHERE "permission"::text LIKE '%"tool":%'
  AND "permission"::text LIKE '%"policy":%'
  AND NOT "permission"::text LIKE '%"toolPolicy":%';

-- Step 10b: Rename "tool" to "toolPolicy" (for roles with only "tool", no "policy")
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'tool') || jsonb_build_object('toolPolicy', "permission"::jsonb->'tool')
)::text
WHERE "permission"::text LIKE '%"tool":%'
  AND NOT "permission"::text LIKE '%"toolPolicy":%'
  AND NOT "permission"::text LIKE '%"policy":%';

-- Step 11: Merge "policy" into "toolPolicy" (for roles without "tool")
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'policy') || jsonb_build_object('toolPolicy', "permission"::jsonb->'policy')
)::text
WHERE "permission"::text LIKE '%"policy":%'
  AND NOT "permission"::text LIKE '%"toolPolicy":%';

-- Step 12: Rename "llmCosts" to "llmCost"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'llmCosts') || jsonb_build_object('llmCost', "permission"::jsonb->'llmCosts')
)::text
WHERE "permission"::text LIKE '%"llmCosts":%';

-- Step 13a: Rename "llmLimits" to "llmLimit" (when llmLimit does not yet exist)
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'llmLimits') || jsonb_build_object('llmLimit', "permission"::jsonb->'llmLimits')
)::text
WHERE "permission"::text LIKE '%"llmLimits":%'
  AND NOT "permission"::text LIKE '%"llmLimit":%';

-- Step 13b: Union "llmLimits" into "llmLimit" (when llmLimit already exists from step 9)
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'llmLimits') || jsonb_build_object(
    'llmLimit',
    (
      SELECT jsonb_agg(DISTINCT val)
      FROM (
        SELECT jsonb_array_elements_text("permission"::jsonb->'llmLimit') AS val
        UNION
        SELECT jsonb_array_elements_text("permission"::jsonb->'llmLimits') AS val
      ) combined
    )
  )
)::text
WHERE "permission"::text LIKE '%"llmLimits":%'
  AND "permission"::text LIKE '%"llmLimit":%';

-- Step 14a: Rename "llmProviders" to "llmProvider" (when llmProvider does not yet exist)
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'llmProviders') || jsonb_build_object('llmProvider', "permission"::jsonb->'llmProviders')
)::text
WHERE "permission"::text LIKE '%"llmProviders":%'
  AND NOT "permission"::text LIKE '%"llmProvider":%';

-- Step 14b: Union "llmProviders" into "llmProvider" (when llmProvider already exists from step 5)
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'llmProviders') || jsonb_build_object(
    'llmProvider',
    (
      SELECT jsonb_agg(DISTINCT val)
      FROM (
        SELECT jsonb_array_elements_text("permission"::jsonb->'llmProvider') AS val
        UNION
        SELECT jsonb_array_elements_text("permission"::jsonb->'llmProviders') AS val
      ) combined
    )
  )
)::text
WHERE "permission"::text LIKE '%"llmProviders":%'
  AND "permission"::text LIKE '%"llmProvider":%';

-- Step 15: Rename "secrets" to "secret"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'secrets') || jsonb_build_object('secret', "permission"::jsonb->'secrets')
)::text
WHERE "permission"::text LIKE '%"secrets":%';

-- Step 16: Rename "agentTriggers" to "agentTrigger"
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'agentTriggers') || jsonb_build_object('agentTrigger', "permission"::jsonb->'agentTriggers')
)::text
WHERE "permission"::text LIKE '%"agentTriggers":%';

-- Step 17: Remove "organization" from custom roles (now internal to better-auth)
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'organization')::text
WHERE "permission"::text LIKE '%"organization":%';
