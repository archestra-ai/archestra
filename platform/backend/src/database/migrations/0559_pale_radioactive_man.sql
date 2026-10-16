SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "duration_ms" integer;
