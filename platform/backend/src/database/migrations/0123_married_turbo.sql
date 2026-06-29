-- Drop foreign key constraints first (before dropping the tables they reference)
ALTER TABLE "chatops_channel_binding" DROP CONSTRAINT IF EXISTS "chatops_channel_binding_prompt_id_prompts_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_prompt_id_prompts_id_fk";
--> statement-breakpoint
ALTER TABLE "tools" DROP CONSTRAINT IF EXISTS "tools_prompt_agent_id_prompt_agents_id_fk";
--> statement-breakpoint
-- Drop unique constraint on tools that includes prompt_agent_id
ALTER TABLE "tools" DROP CONSTRAINT IF EXISTS "tools_catalog_id_name_agent_id_prompt_agent_id_unique";
--> statement-breakpoint
-- Drop index on chatops_channel_binding
DROP INDEX IF EXISTS "chatops_channel_binding_prompt_id_idx";
--> statement-breakpoint
-- Drop columns that reference the tables being dropped
ALTER TABLE "chatops_channel_binding" DROP COLUMN IF EXISTS "prompt_id";
--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "prompt_id";
--> statement-breakpoint
ALTER TABLE "tools" DROP COLUMN IF EXISTS "prompt_agent_id";
--> statement-breakpoint
--> statement-breakpoint
-- Add new unique constraint for tools with delegate_to_agent_id
ALTER TABLE "tools" ADD CONSTRAINT "tools_catalog_id_name_agent_id_delegate_to_agent_id_unique" UNIQUE("catalog_id","name","agent_id","delegate_to_agent_id");
