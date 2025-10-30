ALTER TABLE "internal_mcp_catalog" ALTER COLUMN "server_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ALTER COLUMN "catalog_id" SET NOT NULL;