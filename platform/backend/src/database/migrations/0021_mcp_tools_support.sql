-- Create agent_tools junction table for many-to-many agent-tool relationships
CREATE TABLE "agent_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tools_agent_id_tool_id_unique" UNIQUE("agent_id","tool_id")
);
--> statement-breakpoint
-- Add foreign key constraints for agent_tools
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Add source column to tools table (defaults to 'proxy' for existing tools)
ALTER TABLE "tools" ADD COLUMN "source" text DEFAULT 'proxy' NOT NULL;
--> statement-breakpoint
-- Add mcp_server_id column to tools table (nullable, for MCP server tools)
ALTER TABLE "tools" ADD COLUMN "mcp_server_id" uuid;
--> statement-breakpoint
-- Add foreign key constraint for mcp_server_id
ALTER TABLE "tools" ADD CONSTRAINT "tools_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Make agent_id nullable (will be null for MCP tools, set for proxy-sniffed tools)
ALTER TABLE "tools" ALTER COLUMN "agent_id" DROP NOT NULL;
