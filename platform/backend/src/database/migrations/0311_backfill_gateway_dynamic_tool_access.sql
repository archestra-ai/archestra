-- New agents now default to all-tools access (see AgentModel.create). Extend the
-- same behaviour to existing gateways by granting dynamic tool access to
-- mcp_gateway agents already running in progressive (search_and_run_only) mode.
--
-- This is an intentional access expansion: callers of these gateways can now
-- discover (via search_tools) and run (via run_tool) any tool they already have
-- catalog access to, not only the tools explicitly assigned to the gateway. It
-- does NOT change top-level tool exposure, so no currently-visible tool is
-- hidden. Gateways in "full" mode are intentionally left untouched: flipping
-- them would force them into search_and_run_only and hide their top-level tools,
-- which would be a breaking change.
UPDATE "agents"
SET "access_all_tools" = true
WHERE "agent_type" = 'mcp_gateway'
  AND "tool_exposure_mode" = 'search_and_run_only'
  AND "access_all_tools" = false
  AND "deleted_at" IS NULL;
