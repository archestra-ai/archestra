-- Drop old constraints
ALTER TABLE "tools" DROP CONSTRAINT "tools_agent_id_name_unique";--> statement-breakpoint
ALTER TABLE "tools" DROP CONSTRAINT "tools_mcp_server_id_mcp_server_id_fk";
--> statement-breakpoint

-- Add new columns
ALTER TABLE "agent_tools" ADD COLUMN "execution_source_mcp_server_id" uuid;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "catalog_id" uuid;--> statement-breakpoint

-- Backfill catalog_id from mcp_server.catalog_id for existing tools
UPDATE "tools"
SET "catalog_id" = "mcp_server"."catalog_id"
FROM "mcp_server"
WHERE "tools"."mcp_server_id" = "mcp_server"."id"
AND "tools"."catalog_id" IS NULL;--> statement-breakpoint

-- Backfill execution_source_mcp_server_id from tools.mcp_server_id for existing agent-tool assignments
UPDATE "agent_tools"
SET "execution_source_mcp_server_id" = "tools"."mcp_server_id"
FROM "tools"
WHERE "agent_tools"."tool_id" = "tools"."id"
AND "tools"."mcp_server_id" IS NOT NULL
AND "agent_tools"."execution_source_mcp_server_id" IS NULL;--> statement-breakpoint

-- Add foreign key constraints
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_execution_source_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("execution_source_mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Add new unique constraint
ALTER TABLE "tools" ADD CONSTRAINT "tools_catalog_id_name_agent_id_unique" UNIQUE("catalog_id","name","agent_id");