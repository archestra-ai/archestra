ALTER TYPE "public"."agent_type" ADD VALUE 'profile' BEFORE 'mcp_gateway';--> statement-breakpoint
ALTER TYPE "public"."agent_type" ADD VALUE 'llm_proxy' BEFORE 'agent';--> statement-breakpoint
COMMIT;--> statement-breakpoint
-- Migrate existing mcp_gateway records to profile
UPDATE "agents" SET "agent_type" = 'profile' WHERE "agent_type" = 'mcp_gateway';