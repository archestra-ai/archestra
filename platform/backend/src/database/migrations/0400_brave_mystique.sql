ALTER TABLE "content_encryption_state" ADD COLUMN "mcp_tool_calls_cursor_id" uuid;--> statement-breakpoint
-- Deployments that enabled content encryption before this release have a
-- completed sweep recorded; clearing the flag (cursors stay put) makes the
-- background sweep resume and encrypt historical mcp_tool_calls rows without
-- operator action. No-op where encryption was never enabled.
UPDATE "content_encryption_state" SET "completed_at" = NULL WHERE "completed_at" IS NOT NULL;
