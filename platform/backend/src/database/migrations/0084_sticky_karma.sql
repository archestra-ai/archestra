-- BYOS (Bring Your Own Secrets): Create table for team-to-vault-folder mapping
CREATE TABLE "team_vault_folder" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"vault_path" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "team_vault_folder_team_id_unique" UNIQUE("team_id")
);
--> statement-breakpoint
-- BYOS: Add vault_path column to secrets for external vault references
ALTER TABLE "secret" ADD COLUMN "vault_path" varchar(512);--> statement-breakpoint
ALTER TABLE "team_vault_folder" ADD CONSTRAINT "team_vault_folder_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- MCP Server Teams: Convert many-to-many relationship to many-to-one
-- Each MCP server can now have at most one team (was: multiple teams via junction table)
ALTER TABLE "mcp_server" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Data migration: Preserve existing team assignments from junction table
-- For servers with multiple teams, keep the first team (by created_at), discard others
UPDATE "mcp_server" SET "team_id" = (
	SELECT "team_id" FROM "mcp_server_team"
	WHERE "mcp_server_team"."mcp_server_id" = "mcp_server"."id"
	ORDER BY "created_at" LIMIT 1
);--> statement-breakpoint
-- Drop the old many-to-many junction table (data has been migrated above)
ALTER TABLE "mcp_server_team" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "mcp_server_team" CASCADE;