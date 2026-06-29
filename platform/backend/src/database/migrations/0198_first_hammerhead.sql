ALTER TABLE "agent_tools" ADD COLUMN "mcp_server_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "credential_resolution_mode" text DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "enterprise_managed_config" jsonb;--> statement-breakpoint
UPDATE "agent_tools"
SET "credential_resolution_mode" = 'dynamic'
WHERE "use_dynamic_team_credential" = true;--> statement-breakpoint
UPDATE "agent_tools"
SET "mcp_server_id" = COALESCE(
  "execution_source_mcp_server_id",
  "credential_source_mcp_server_id"
);--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "credential_source_mcp_server_id";--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "execution_source_mcp_server_id";--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "use_dynamic_team_credential";
