ALTER TABLE "mcp_server" ADD COLUMN "installation_status" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "installation_error" text;