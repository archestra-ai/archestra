ALTER TABLE "conversations" DROP CONSTRAINT "conversations_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "interactions" DROP CONSTRAINT "interactions_profile_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" DROP CONSTRAINT "mcp_tool_calls_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_profile_id_agents_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;