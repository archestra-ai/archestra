ALTER TABLE "interactions" ADD COLUMN "incognito_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "incognito_conversation_id" uuid;