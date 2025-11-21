ALTER TABLE "tool_invocation_policies" DROP CONSTRAINT "tool_invocation_policies_agent_tool_id_agent_tools_id_fk";
--> statement-breakpoint
ALTER TABLE "trusted_data_policies" DROP CONSTRAINT "trusted_data_policies_agent_tool_id_agent_tools_id_fk";
--> statement-breakpoint

-- Add tool_policy_id to tool_invocation_policies and trusted_data_policies
ALTER TABLE "tool_invocation_policies" ADD COLUMN "tool_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "trusted_data_policies" ADD COLUMN "tool_policy_id" uuid;--> statement-breakpoint


ALTER TABLE "tool_invocation_policies" ADD CONSTRAINT "tool_invocation_policies_tool_policy_id_tool_policies_id_fk" FOREIGN KEY ("tool_policy_id") REFERENCES "public"."tool_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "trusted_data_policies" ADD CONSTRAINT "trusted_data_policies_tool_policy_id_tool_policies_id_fk" FOREIGN KEY ("tool_policy_id") REFERENCES "public"."tool_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Backfill tool_policy_id from agent_tools.tool_policy_id using existing agent_tool_id links
UPDATE "tool_invocation_policies" tip
SET tool_policy_id = at.tool_policy_id
FROM "agent_tools" at
WHERE tip.agent_tool_id = at.id
  AND at.tool_policy_id IS NOT NULL;

UPDATE "trusted_data_policies" tdp
SET tool_policy_id = at.tool_policy_id
FROM "agent_tools" at
WHERE tdp.agent_tool_id = at.id
  AND at.tool_policy_id IS NOT NULL;

-- Enforce NOT NULL on tool_policy_id now that backfill is done
ALTER TABLE "tool_invocation_policies" ALTER COLUMN "tool_policy_id" SET NOT NULL;
ALTER TABLE "trusted_data_policies" ALTER COLUMN "tool_policy_id" SET NOT NULL;

-- Drop old agent_tool_id columns
ALTER TABLE "tool_invocation_policies" DROP COLUMN "agent_tool_id";--> statement-breakpoint
ALTER TABLE "trusted_data_policies" DROP COLUMN "agent_tool_id";
