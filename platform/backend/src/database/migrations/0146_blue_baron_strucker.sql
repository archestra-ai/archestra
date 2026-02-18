ALTER TABLE "agents" ALTER COLUMN "agent_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "agent_type" SET DEFAULT 'mcp_gateway';--> statement-breakpoint
DROP TYPE "public"."agent_type";