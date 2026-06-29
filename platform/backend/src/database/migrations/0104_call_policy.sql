-- Migration: Refactor tool_invocation_policies to tool-level with compound conditions
--
-- Changes:
-- 1. tool_invocation_policies: agent_tool_id → tool_id, argumentName/operator/value → conditions JSONB
-- 2. agent_tools: remove allow_usage_when_untrusted_data_is_present (migrated to policies)

-- STEP 1: Add new columns (before dropping anything)
ALTER TABLE "tool_invocation_policies"
  ADD COLUMN "tool_id" uuid,
  ADD COLUMN "conditions" jsonb NOT NULL DEFAULT '[]';

-- STEP 2: Migrate existing policies (deduplicated - first encountered per tool/conditions/action)
-- First, update all policies with tool_id and conditions
UPDATE "tool_invocation_policies" tip
SET
  "tool_id" = at."tool_id",
  "conditions" = jsonb_build_array(
    jsonb_build_object(
      'key', tip."argument_name",
      'operator', tip."operator",
      'value', tip."value"
    )
  )
FROM "agent_tools" at
WHERE tip."agent_tool_id" = at."id";

-- Then delete duplicates, keeping only the first encountered (by created_at) per unique combination
DELETE FROM "tool_invocation_policies"
WHERE "id" NOT IN (
  SELECT DISTINCT ON ("tool_id", "conditions", "action")
    "id"
  FROM "tool_invocation_policies"
  ORDER BY "tool_id", "conditions", "action", "created_at"
);

-- Allow NULL in old columns so we can insert new rows before dropping them
ALTER TABLE "tool_invocation_policies"
  ALTER COLUMN "agent_tool_id" DROP NOT NULL,
  ALTER COLUMN "argument_name" DROP NOT NULL,
  ALTER COLUMN "operator" DROP NOT NULL,
  ALTER COLUMN "value" DROP NOT NULL;

-- STEP 3: Migrate allow_usage_when_untrusted_data_is_present from agent_tools
-- Creates policies with empty conditions (applies to all calls for that tool)
-- Skip rows where allow_usage_when_untrusted_data_is_present is NULL (no explicit setting)
INSERT INTO "tool_invocation_policies" ("tool_id", "conditions", "action")
SELECT DISTINCT ON (at."tool_id")
  at."tool_id",
  '[]'::jsonb,
  CASE
    WHEN at."allow_usage_when_untrusted_data_is_present" THEN 'allow_when_context_is_untrusted'
    ELSE 'block_when_context_is_untrusted'
  END
FROM "agent_tools" at
WHERE at."allow_usage_when_untrusted_data_is_present" IS NOT NULL
  AND NOT EXISTS (
    -- Don't create if tool already has a policy with empty conditions
    SELECT 1 FROM "tool_invocation_policies" tip2
    WHERE tip2."tool_id" = at."tool_id" AND tip2."conditions" = '[]'::jsonb
  )
ORDER BY at."tool_id", at."created_at";

-- STEP 4: Add FK constraint and make tool_id NOT NULL
ALTER TABLE "tool_invocation_policies"
  ALTER COLUMN "tool_id" SET NOT NULL;

ALTER TABLE "tool_invocation_policies"
  ADD CONSTRAINT "tool_invocation_policies_tool_id_tools_id_fk"
    FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE;

-- STEP 5: Drop old FK constraint and columns from tool_invocation_policies
ALTER TABLE "tool_invocation_policies"
  DROP CONSTRAINT "tool_invocation_policies_agent_tool_id_agent_tools_id_fk";

ALTER TABLE "tool_invocation_policies"
  DROP COLUMN "agent_tool_id",
  DROP COLUMN "argument_name",
  DROP COLUMN "operator",
  DROP COLUMN "value";

-- STEP 6: Drop allow_usage_when_untrusted_data_is_present from agent_tools
ALTER TABLE "agent_tools"
  DROP COLUMN "allow_usage_when_untrusted_data_is_present";
