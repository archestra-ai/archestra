-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=app_id is a new nullable column (all existing rows null), so the FK validates trivially and the NOT NULL owner_type carries a default backfill.
ALTER TABLE "mcp_tool_calls" ADD COLUMN "owner_type" varchar(16) DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tool_calls_app_id_idx" ON "mcp_tool_calls" USING btree ("app_id");