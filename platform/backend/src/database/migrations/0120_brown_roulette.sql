ALTER TABLE "mcp_server" ADD COLUMN "oauth_refresh_error" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "oauth_refresh_failed_at" timestamp;