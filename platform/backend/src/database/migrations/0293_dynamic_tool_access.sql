ALTER TABLE "agents" ADD COLUMN "access_all_tools" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "dynamic_connection_mcp_server_id" uuid;