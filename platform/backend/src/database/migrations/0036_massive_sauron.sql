CREATE TABLE "mcp_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"mcp_server_name" varchar(255) NOT NULL,
	"tool_call" jsonb NOT NULL,
	"tool_result" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_agent_id_idx" ON "mcp_tool_calls" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_created_at_idx" ON "mcp_tool_calls" USING btree ("created_at");