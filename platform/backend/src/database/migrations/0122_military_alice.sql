-- Migration: Merge prompts into agents with agent_type enum
-- This migration converts prompts to internal agents and uses delegation tools via agent_tools

-- ============================================================================
-- PHASE 1: SCHEMA CHANGES
-- ============================================================================

-- 1.0 Create agent_type enum
CREATE TYPE "public"."agent_type" AS ENUM('mcp_gateway', 'agent');

--> statement-breakpoint

-- 1.1 Add columns to agents table
ALTER TABLE "agents" ADD COLUMN "organization_id" text;
ALTER TABLE "agents" ADD COLUMN "agent_type" "public"."agent_type" NOT NULL DEFAULT 'mcp_gateway';
ALTER TABLE "agents" ADD COLUMN "system_prompt" text;
ALTER TABLE "agents" ADD COLUMN "user_prompt" text;
ALTER TABLE "agents" ADD COLUMN "prompt_version" integer DEFAULT 1;
ALTER TABLE "agents" ADD COLUMN "prompt_history" jsonb DEFAULT '[]'::jsonb;
ALTER TABLE "agents" ADD COLUMN "allowed_chatops" jsonb DEFAULT '[]'::jsonb;
-- Incoming email fields (from main branch - previously on prompts table)
ALTER TABLE "agents" ADD COLUMN "incoming_email_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "agents" ADD COLUMN "incoming_email_security_mode" text NOT NULL DEFAULT 'private';
ALTER TABLE "agents" ADD COLUMN "incoming_email_allowed_domain" text;

--> statement-breakpoint

-- 1.2 Add delegation column to tools table
ALTER TABLE "tools" ADD COLUMN "delegate_to_agent_id" uuid;
ALTER TABLE "tools" ADD CONSTRAINT "tools_delegate_to_agent_id_agents_id_fk"
  FOREIGN KEY ("delegate_to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;

--> statement-breakpoint

-- 1.3 Add agent_id to chatops_channel_binding table
ALTER TABLE "chatops_channel_binding" ADD COLUMN "agent_id" uuid;
ALTER TABLE "chatops_channel_binding" ADD CONSTRAINT "chatops_channel_binding_agent_id_agents_id_fk"
  FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "chatops_channel_binding_agent_id_idx" ON "chatops_channel_binding" USING btree ("agent_id");

--> statement-breakpoint

-- ============================================================================
-- PHASE 2: DATA MIGRATION
-- ============================================================================

-- 2.1 Backfill organization_id on existing agents (profiles) from first organization
-- These are the MCP gateway profiles that existed before this migration
UPDATE "agents" SET "organization_id" = (
  SELECT "id" FROM "organization" LIMIT 1
) WHERE "organization_id" IS NULL;

--> statement-breakpoint

-- 2.2 INSERT new agents from prompts (prompts become their own agents)
-- Each prompt becomes a NEW agent with agent_type='agent'
-- We use the prompt's ID as the new agent's ID to preserve relationships
-- If a prompt has the same name as an existing agent, append " (Agent)" suffix
INSERT INTO "agents" (
  "id",
  "organization_id",
  "name",
  "agent_type",
  "system_prompt",
  "user_prompt",
  "prompt_version",
  "prompt_history",
  "allowed_chatops",
  "incoming_email_enabled",
  "incoming_email_security_mode",
  "incoming_email_allowed_domain",
  "created_at",
  "updated_at"
)
SELECT
  p."id",                    -- Use prompt ID as agent ID
  p."organization_id",
  CASE
    WHEN EXISTS (
      SELECT 1 FROM "agents" a
      WHERE a."organization_id" = p."organization_id"
      AND a."name" = p."name"
    )
    THEN p."name" || ' (Agent)'
    ELSE p."name"
  END,                       -- Handle name conflicts
  'agent',                   -- Mark as internal agent
  p."system_prompt",
  p."user_prompt",
  p."version",
  p."history",
  p."allowed_chatops",
  p."incoming_email_enabled",
  p."incoming_email_security_mode",
  p."incoming_email_allowed_domain",
  p."created_at",
  p."updated_at"
FROM "prompts" p
ON CONFLICT ("id") DO NOTHING;

--> statement-breakpoint

-- 2.3 Copy agent_tools from profile to the new agent
-- Each prompt referenced a profile (via profile_id), copy that profile's tool assignments
INSERT INTO "agent_tools" (
  "id",
  "agent_id",
  "tool_id",
  "response_modifier_template",
  "credential_source_mcp_server_id",
  "execution_source_mcp_server_id",
  "use_dynamic_team_credential",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  p."id",                                    -- The prompt ID (now the new agent ID)
  at."tool_id",
  at."response_modifier_template",
  at."credential_source_mcp_server_id",
  at."execution_source_mcp_server_id",
  at."use_dynamic_team_credential",
  NOW(),
  NOW()
FROM "prompts" p
JOIN "agent_tools" at ON at."agent_id" = p."agent_id"  -- Copy from the profile (agent_id references the profile)
ON CONFLICT ("agent_id", "tool_id") DO NOTHING;

--> statement-breakpoint

-- 2.4 Migrate prompt_agents to agent_tools with delegation tools
-- prompt_agents linked prompts to other prompts for delegation
-- Now we create delegation tools where the target is the prompt ID (which is now an agent ID)
-- IMPORTANT: Only create delegation tools for agents (type='agent'), NOT for profiles (type='mcp_gateway')

-- Step 0: Clean up any orphan delegation tools from previous migration attempts
-- These are tools with 'agent__' prefix but no delegate_to_agent_id set
DELETE FROM "tools" WHERE "name" LIKE 'agent__%' AND "delegate_to_agent_id" IS NULL;

--> statement-breakpoint

-- Step 1: Create delegation tools for each unique target prompt (now agent)
-- Only create if the target was successfully converted to an agent (agent_type='agent')
INSERT INTO "tools" ("id", "name", "description", "delegate_to_agent_id", "created_at", "updated_at", "parameters")
SELECT
  gen_random_uuid(),
  'agent__' || LOWER(REGEXP_REPLACE(target_agent."name", '[^a-zA-Z0-9]+', '_', 'g')),
  'Delegate task to agent: ' || target_agent."name",
  target_agent."id",
  NOW(),
  NOW(),
  '{"type": "object", "properties": {"message": {"type": "string", "description": "The task or message to send to the agent"}}, "required": ["message"]}'::jsonb
FROM (
  SELECT DISTINCT p."id"
  FROM "prompt_agents" pa
  JOIN "prompts" p ON pa."agent_prompt_id" = p."id"
) target_prompt
JOIN "agents" target_agent ON target_agent."id" = target_prompt."id" AND target_agent."agent_type" = 'agent'
WHERE NOT EXISTS (
  SELECT 1 FROM "tools" t WHERE t."delegate_to_agent_id" = target_agent."id"
);

--> statement-breakpoint

-- Step 2: Create agent_tools assignments for delegation tools
-- Only assign to agents (type='agent'), NOT to profiles (type='mcp_gateway')
INSERT INTO "agent_tools" ("id", "agent_id", "tool_id", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  source_agent."id",
  t."id",
  NOW(),
  NOW()
FROM "prompt_agents" pa
JOIN "prompts" source_prompt ON pa."prompt_id" = source_prompt."id"
JOIN "prompts" target_prompt ON pa."agent_prompt_id" = target_prompt."id"
JOIN "agents" source_agent ON source_agent."id" = source_prompt."id" AND source_agent."agent_type" = 'agent'
JOIN "tools" t ON t."delegate_to_agent_id" = target_prompt."id"
ON CONFLICT ("agent_id", "tool_id") DO NOTHING;

--> statement-breakpoint

-- 2.5 Migrate chatops_channel_binding: set agent_id = prompt_id
-- Since prompt ID = new agent ID, we can copy directly
UPDATE "chatops_channel_binding" SET "agent_id" = "prompt_id"
WHERE "agent_id" IS NULL AND "prompt_id" IS NOT NULL;

--> statement-breakpoint

-- 2.6 Update conversations: set agent_id to prompt_id where prompt exists
-- Since prompt ID = new agent ID, conversations should point to the new agent
UPDATE "conversations" SET "agent_id" = "prompt_id"
WHERE "prompt_id" IS NOT NULL;

--> statement-breakpoint

-- ============================================================================
-- PHASE 3: Add NOT NULL constraint to organization_id (after data backfill)
-- ============================================================================

-- Create a default organization if none exists (for fresh/test databases)
INSERT INTO "organization" ("id", "name", "slug", "created_at")
SELECT gen_random_uuid(), 'Default Organization', 'default-org', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "organization" LIMIT 1);

--> statement-breakpoint

-- Set a fallback for any remaining null organization_id
UPDATE "agents" SET "organization_id" = (
  SELECT "id" FROM "organization" LIMIT 1
) WHERE "organization_id" IS NULL;

--> statement-breakpoint

-- Now make organization_id NOT NULL
ALTER TABLE "agents" ALTER COLUMN "organization_id" SET NOT NULL;

--> statement-breakpoint

-- ============================================================================
-- PHASE 4: Create indexes for new columns
-- ============================================================================

CREATE INDEX "agents_organization_id_idx" ON "agents" USING btree ("organization_id");
CREATE INDEX "agents_agent_type_idx" ON "agents" USING btree ("agent_type");
CREATE INDEX "tools_delegate_to_agent_id_idx" ON "tools" USING btree ("delegate_to_agent_id");
