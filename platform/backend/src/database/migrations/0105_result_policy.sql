-- Migration: Refactor trusted_data_policies to tool-level with compound conditions
--
-- Changes:
-- 1. trusted_data_policies: agent_tool_id → tool_id, attributePath/operator/value → conditions JSONB
-- 2. agent_tools: remove tool_result_treatment (migrated to policies)

-- STEP 1: Add new columns (idempotent - check if they exist first)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trusted_data_policies' AND column_name = 'tool_id'
  ) THEN
    ALTER TABLE "trusted_data_policies" ADD COLUMN "tool_id" uuid;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trusted_data_policies' AND column_name = 'conditions'
  ) THEN
    ALTER TABLE "trusted_data_policies" ADD COLUMN "conditions" jsonb NOT NULL DEFAULT '[]';
  END IF;
END $$;

-- STEP 2: Migrate existing policies (convert attributePath/operator/value to conditions array)
-- Only run if old columns still exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trusted_data_policies' AND column_name = 'agent_tool_id'
  ) THEN
    -- Update all policies with tool_id and conditions
    UPDATE "trusted_data_policies" tdp
    SET
      "tool_id" = at."tool_id",
      "conditions" = jsonb_build_array(
        jsonb_build_object(
          'key', tdp."attribute_path",
          'operator', tdp."operator",
          'value', tdp."value"
        )
      )
    FROM "agent_tools" at
    WHERE tdp."agent_tool_id" = at."id"
      AND tdp."tool_id" IS NULL;

    -- Delete duplicates, keeping only the first encountered (by created_at) per unique combination
    DELETE FROM "trusted_data_policies"
    WHERE "id" NOT IN (
      SELECT DISTINCT ON ("tool_id", "conditions", "action")
        "id"
      FROM "trusted_data_policies"
      WHERE "tool_id" IS NOT NULL
      ORDER BY "tool_id", "conditions", "action", "created_at"
    ) AND "tool_id" IS NOT NULL;
  END IF;
END $$;

-- STEP 3: Allow NULL in old columns so we can insert new rows before dropping them
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trusted_data_policies' AND column_name = 'agent_tool_id'
  ) THEN
    ALTER TABLE "trusted_data_policies"
      ALTER COLUMN "agent_tool_id" DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trusted_data_policies' AND column_name = 'attribute_path'
  ) THEN
    ALTER TABLE "trusted_data_policies"
      ALTER COLUMN "attribute_path" DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trusted_data_policies' AND column_name = 'operator'
  ) THEN
    ALTER TABLE "trusted_data_policies"
      ALTER COLUMN "operator" DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trusted_data_policies' AND column_name = 'value'
  ) THEN
    ALTER TABLE "trusted_data_policies"
      ALTER COLUMN "value" DROP NOT NULL;
  END IF;
END $$;

-- Make description nullable
ALTER TABLE "trusted_data_policies" ALTER COLUMN "description" DROP NOT NULL;

-- STEP 4: Migrate tool_result_treatment from agent_tools to default policies
-- Creates policies with empty conditions (applies to all results for that tool)
-- Skip rows where tool_result_treatment is NULL (no explicit setting)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_tools' AND column_name = 'tool_result_treatment'
  ) THEN
    INSERT INTO "trusted_data_policies" ("tool_id", "conditions", "action")
    SELECT DISTINCT ON (at."tool_id")
      at."tool_id",
      '[]'::jsonb,
      CASE at."tool_result_treatment"
        WHEN 'trusted' THEN 'mark_as_trusted'
        WHEN 'sanitize_with_dual_llm' THEN 'sanitize_with_dual_llm'
        ELSE 'mark_as_untrusted'
      END
    FROM "agent_tools" at
    WHERE at."tool_id" IS NOT NULL
      AND at."tool_result_treatment" IS NOT NULL
      AND NOT EXISTS (
        -- Don't create if tool already has a policy with empty conditions
        SELECT 1 FROM "trusted_data_policies" tdp2
        WHERE tdp2."tool_id" = at."tool_id" AND tdp2."conditions" = '[]'::jsonb
      )
    ORDER BY at."tool_id", at."created_at";
  END IF;
END $$;

-- STEP 5: Add FK constraint and make tool_id NOT NULL
DO $$
BEGIN
  -- Delete any policies that don't have a tool_id (orphaned data)
  DELETE FROM "trusted_data_policies" WHERE "tool_id" IS NULL;

  -- Make tool_id NOT NULL
  ALTER TABLE "trusted_data_policies"
    ALTER COLUMN "tool_id" SET NOT NULL;

  -- Add FK constraint if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'trusted_data_policies_tool_id_tools_id_fk'
  ) THEN
    ALTER TABLE "trusted_data_policies"
      ADD CONSTRAINT "trusted_data_policies_tool_id_tools_id_fk"
        FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- STEP 6: Drop old FK constraint and columns from trusted_data_policies
DO $$
BEGIN
  -- Drop old FK constraint if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'trusted_data_policies_agent_tool_id_agent_tools_id_fk'
  ) THEN
    ALTER TABLE "trusted_data_policies"
      DROP CONSTRAINT "trusted_data_policies_agent_tool_id_agent_tools_id_fk";
  END IF;

  -- Drop old columns if they exist
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trusted_data_policies' AND column_name = 'agent_tool_id'
  ) THEN
    ALTER TABLE "trusted_data_policies" DROP COLUMN "agent_tool_id";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trusted_data_policies' AND column_name = 'attribute_path'
  ) THEN
    ALTER TABLE "trusted_data_policies" DROP COLUMN "attribute_path";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trusted_data_policies' AND column_name = 'operator'
  ) THEN
    ALTER TABLE "trusted_data_policies" DROP COLUMN "operator";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trusted_data_policies' AND column_name = 'value'
  ) THEN
    ALTER TABLE "trusted_data_policies" DROP COLUMN "value";
  END IF;
END $$;

-- STEP 7: Drop tool_result_treatment from agent_tools
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_tools' AND column_name = 'tool_result_treatment'
  ) THEN
    ALTER TABLE "agent_tools" DROP COLUMN "tool_result_treatment";
  END IF;
END $$;
