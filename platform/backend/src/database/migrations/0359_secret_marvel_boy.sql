ALTER TABLE "mcp_server" ADD COLUMN "reinstall_reason" text;--> statement-breakpoint
UPDATE "mcp_server" SET "reinstall_reason" = 'new-input' WHERE "reinstall_required" = true;
