ALTER TABLE "mcp_server" ADD COLUMN "scope" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_server_scope_idx" ON "mcp_server" USING btree ("scope");--> statement-breakpoint
-- Set scope='team' where team_id is present; other rows keep the default 'personal'.
UPDATE "mcp_server" SET "scope" = 'team' WHERE "team_id" IS NOT NULL;