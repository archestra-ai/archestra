ALTER TABLE "agents" ADD COLUMN "entra_agent_identity_id" text;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "credential_client_id" text;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "credential_client_type" varchar(32);