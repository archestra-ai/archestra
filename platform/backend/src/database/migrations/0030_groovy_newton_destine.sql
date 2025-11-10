ALTER TABLE "internal_mcp_catalog" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "server_type" text;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "server_url" text;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "docs_url" text;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "user_config" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "oauth_config" jsonb;