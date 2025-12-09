-- Add team_id column to mcp_server table
ALTER TABLE "mcp_server" ADD COLUMN "team_id" text;--> statement-breakpoint

-- Migrate existing data: keep first team by created_at for each mcp_server
UPDATE "mcp_server"
SET "team_id" = (
  SELECT "team_id"
  FROM "mcp_server_team"
  WHERE "mcp_server_team"."mcp_server_id" = "mcp_server"."id"
  ORDER BY "created_at"
  LIMIT 1
);--> statement-breakpoint

-- Add foreign key constraint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Disable RLS and drop the junction table (no longer needed)
ALTER TABLE "mcp_server_team" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "mcp_server_team" CASCADE;
