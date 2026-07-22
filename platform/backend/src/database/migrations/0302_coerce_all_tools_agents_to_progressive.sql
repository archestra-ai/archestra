-- All-tools agents must use the search/run dispatch surface for dynamic tool
-- access to work; "full" exposure is a dead state for them (run_tool is never
-- exposed). Backfill existing inconsistent rows to the progressive-loading mode,
-- matching the create/update invariant enforced in AgentModel.
UPDATE "agents"
SET "tool_exposure_mode" = 'search_and_run_only'
WHERE "access_all_tools" = true
  AND "tool_exposure_mode" = 'full';