-- Migration: Restructure prompts table
-- Remove many-to-many relationship via agent_prompts, add direct agentId FK
-- Map type/content fields to userPrompt/systemPrompt

-- Step 1: Add new columns (nullable initially for data migration)
-- Use DO block to conditionally add columns only if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'prompts' AND column_name = 'agent_id') THEN
    ALTER TABLE "prompts" ADD COLUMN "agent_id" uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'prompts' AND column_name = 'user_prompt') THEN
    ALTER TABLE "prompts" ADD COLUMN "user_prompt" text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'prompts' AND column_name = 'system_prompt') THEN
    ALTER TABLE "prompts" ADD COLUMN "system_prompt" text;
  END IF;
END $$;

-- Step 2: Migrate data
-- For each active prompt with agent relationships, duplicate per agent
-- Map type='system' to system_prompt, type='regular' to user_prompt
-- Include all required columns (type, content, created_by) to satisfy NOT NULL constraints
-- Only migrate prompts that don't already have agent_id set (idempotent)
INSERT INTO "prompts" ("id", "organization_id", "name", "type", "content", "created_by", "agent_id", "user_prompt", "system_prompt", "version", "is_active", "created_at", "updated_at")
SELECT 
  gen_random_uuid() as "id",
  p."organization_id",
  p."name",
  p."type", -- Required: copy from original
  p."content", -- Required: copy from original
  p."created_by", -- Required: copy from original
  ap."agent_id",
  CASE WHEN p."type" = 'regular' THEN p."content" ELSE NULL END as "user_prompt",
  CASE WHEN p."type" = 'system' THEN p."content" ELSE NULL END as "system_prompt",
  1 as "version", -- Explicit default for migrated prompts
  true as "is_active", -- Explicit default for migrated prompts
  p."created_at",
  p."updated_at"
FROM "prompts" p
INNER JOIN "agent_prompts" ap ON p."id" = ap."prompt_id"
WHERE p."is_active" = true
  AND p."agent_id" IS NULL; -- Only migrate prompts that haven't been migrated yet

-- Step 3: Delete old prompt records (inactive + orphaned, including originals that were migrated)
DELETE FROM "prompts" WHERE "agent_id" IS NULL;

-- Step 4: Drop old columns (keep version, parent_prompt_id, is_active for versioning)
-- Conditionally drop columns only if they exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns 
             WHERE table_name = 'prompts' AND column_name = 'type') THEN
    ALTER TABLE "prompts" DROP COLUMN "type";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns 
             WHERE table_name = 'prompts' AND column_name = 'content') THEN
    ALTER TABLE "prompts" DROP COLUMN "content";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns 
             WHERE table_name = 'prompts' AND column_name = 'created_by') THEN
    ALTER TABLE "prompts" DROP COLUMN "created_by";
  END IF;
END $$;

-- Step 5: Add NOT NULL constraint and FK
DO $$
BEGIN
  -- Set NOT NULL constraint if not already set
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'prompts' 
      AND column_name = 'agent_id' 
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE "prompts" ALTER COLUMN "agent_id" SET NOT NULL;
  END IF;
  
  -- Add FK constraint if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'prompts_agent_id_agents_id_fk'
  ) THEN
    ALTER TABLE "prompts" ADD CONSTRAINT "prompts_agent_id_agents_id_fk" 
      FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

-- Step 6: Drop junction table (if it exists)
DROP TABLE IF EXISTS "agent_prompts";

-- Step 7: Add promptId to conversations table (nullable - free chat has no prompt)
DO $$
BEGIN
  -- Add column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'conversations' AND column_name = 'prompt_id'
  ) THEN
    ALTER TABLE "conversations" ADD COLUMN "prompt_id" uuid;
  END IF;
  
  -- Add FK constraint if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'conversations_prompt_id_prompts_id_fk'
  ) THEN
    ALTER TABLE "conversations" ADD CONSTRAINT "conversations_prompt_id_prompts_id_fk" 
      FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

