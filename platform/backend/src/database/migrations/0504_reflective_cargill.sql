ALTER TABLE "agents" ALTER COLUMN "tool_exposure_mode" SET DEFAULT 'search_and_run_only';
--> statement-breakpoint
-- Enable progressive loading for existing Manual-mode agents and MCP gateways.
-- All mode already requires search/run dispatch; LLM proxies do not use this setting.
UPDATE "agents"
SET "tool_exposure_mode" = 'search_and_run_only'
WHERE "agent_type" IN ('agent', 'mcp_gateway')
  AND "access_all_tools" = false
  AND "tool_exposure_mode" = 'full';
