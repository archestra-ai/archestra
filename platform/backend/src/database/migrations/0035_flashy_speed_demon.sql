ALTER TABLE "internal_mcp_catalog" ALTER COLUMN "server_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ALTER COLUMN "catalog_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "local_config" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "local_installation_status" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "local_installation_error" text;