ALTER TABLE "agents" ADD COLUMN "progressive_subagent_loading" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- MCP gateways with progressive tool loading already kept their agents behind
-- search_tools/run_tool, so they keep doing that. Chat agents listed their
-- Manual subagents directly and stay that way.
UPDATE "agents"
SET "progressive_subagent_loading" = true
WHERE "agent_type" IN ('mcp_gateway', 'profile')
  AND "tool_exposure_mode" = 'search_and_run_only';
