-- Add server_type column as nullable first
ALTER TABLE "mcp_server" ADD COLUMN "server_type" text;

-- Update existing rows by deriving server_type from catalog_id
UPDATE "mcp_server"
SET "server_type" = "internal_mcp_catalog"."server_type"
FROM "internal_mcp_catalog"
WHERE "mcp_server"."catalog_id" = "internal_mcp_catalog"."id";

-- Make server_type NOT NULL after populating existing rows
ALTER TABLE "mcp_server" ALTER COLUMN "server_type" SET NOT NULL;