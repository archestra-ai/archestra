ALTER TABLE "mcp_server" ALTER COLUMN "catalog_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "deleted_at" timestamp;