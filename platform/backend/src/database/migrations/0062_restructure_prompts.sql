-- Migration: Restructure prompts table
-- Remove many-to-many relationship via agent_prompts, add direct agentId FK
-- Map type/content fields to userPrompt/systemPrompt

-- Step 1: Add new columns (nullable initially for data migration)
ALTER TABLE "prompts" ADD COLUMN "agent_id" uuid;
ALTER TABLE "prompts" ADD COLUMN "user_prompt" text;
ALTER TABLE "prompts" ADD COLUMN "system_prompt" text;

-- Step 2: Migrate data
-- For each active prompt with agent relationships, duplicate per agent
-- Map type='system' to system_prompt, type='regular' to user_prompt
INSERT INTO "prompts" ("id", "organization_id", "name", "agent_id", "user_prompt", "system_prompt", "created_at", "updated_at")
SELECT 
  gen_random_uuid() as "id",
  p."organization_id",
  p."name",
  ap."agent_id",
  CASE WHEN p."type" = 'regular' THEN p."content" ELSE NULL END as "user_prompt",
  CASE WHEN p."type" = 'system' THEN p."content" ELSE NULL END as "system_prompt",
  p."created_at",
  p."updated_at"
FROM "prompts" p
INNER JOIN "agent_prompts" ap ON p."id" = ap."prompt_id"
WHERE p."is_active" = true;

-- Step 3: Delete old prompt records (inactive + orphaned, including originals that were migrated)
DELETE FROM "prompts" WHERE "agent_id" IS NULL;

-- Step 4: Drop old columns
ALTER TABLE "prompts" DROP COLUMN "type";
ALTER TABLE "prompts" DROP COLUMN "content";
ALTER TABLE "prompts" DROP COLUMN "version";
ALTER TABLE "prompts" DROP COLUMN "parent_prompt_id";
ALTER TABLE "prompts" DROP COLUMN "is_active";
ALTER TABLE "prompts" DROP COLUMN "created_by";

-- Step 5: Add NOT NULL constraint and FK
ALTER TABLE "prompts" ALTER COLUMN "agent_id" SET NOT NULL;
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;

-- Step 6: Drop junction table
DROP TABLE "agent_prompts";

-- Step 7: Add promptId to conversations table (nullable - free chat has no prompt)
ALTER TABLE "conversations" ADD COLUMN "prompt_id" uuid;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_prompt_id_prompts_id_fk" 
  FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE set null ON UPDATE no action;

