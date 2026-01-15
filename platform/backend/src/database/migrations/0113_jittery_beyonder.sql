-- STEP 1: Add new columns to tools table
ALTER TABLE "tools" ADD COLUMN "policies_auto_configured_at" timestamp;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "policies_auto_configuring_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "policies_auto_configured_reasoning" text;--> statement-breakpoint

-- STEP 2: Migrate data from agent_tools to tools (first encountered per tool_id)
UPDATE "tools" t
SET
  "policies_auto_configured_at" = at."policies_auto_configured_at",
  "policies_auto_configuring_started_at" = at."policies_auto_configuring_started_at",
  "policies_auto_configured_reasoning" = at."policies_auto_configured_reasoning"
FROM (
  SELECT DISTINCT ON ("tool_id")
    "tool_id",
    "policies_auto_configured_at",
    "policies_auto_configuring_started_at",
    "policies_auto_configured_reasoning"
  FROM "agent_tools"
  WHERE "policies_auto_configured_at" IS NOT NULL
  ORDER BY "tool_id", "created_at"
) at
WHERE t."id" = at."tool_id";--> statement-breakpoint

-- STEP 3: Drop old columns from agent_tools
ALTER TABLE "agent_tools" DROP COLUMN "policies_auto_configured_at";--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "policies_auto_configuring_started_at";--> statement-breakpoint
ALTER TABLE "agent_tools" DROP COLUMN "policies_auto_configured_reasoning";
