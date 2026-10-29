ALTER TABLE "mcp_tool_calls" ADD COLUMN "tool_name" varchar(255);--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "is_error" boolean;