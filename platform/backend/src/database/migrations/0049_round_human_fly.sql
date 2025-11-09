-- Make tool_call and tool_result nullable to support different request types
ALTER TABLE "mcp_tool_calls" ALTER COLUMN "tool_call" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ALTER COLUMN "tool_result" DROP NOT NULL;--> statement-breakpoint

-- Add method column as nullable first to allow data migration
ALTER TABLE "mcp_tool_calls" ADD COLUMN "method" varchar(255);--> statement-breakpoint

-- Migrate all existing rows to have method = 'tools/call'
UPDATE "mcp_tool_calls" SET "method" = 'tools/call' WHERE "method" IS NULL;--> statement-breakpoint

-- Now make method column NOT NULL
ALTER TABLE "mcp_tool_calls" ALTER COLUMN "method" SET NOT NULL;