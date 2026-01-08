-- This adds a new global_tool_policy which is set to "restrictive" for existing entries,
-- but newly created orgs will get "permissive"
ALTER TABLE "organization" ADD COLUMN "global_tool_policy" varchar;--> statement-breakpoint
UPDATE "organization" SET "global_tool_policy" = 'restrictive' WHERE "global_tool_policy" IS NULL;--> statement-breakpoint
ALTER TABLE "organization" ALTER COLUMN "global_tool_policy" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ALTER COLUMN "global_tool_policy" SET DEFAULT 'permissive';
