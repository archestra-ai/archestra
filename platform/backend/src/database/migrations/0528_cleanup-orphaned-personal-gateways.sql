-- Soft-delete personal MCP gateways whose author's account was deleted
-- without going through user cleanup. `agents.author_id` is `set null`, and
-- the delete route refuses personal gateways, so these rows could not be
-- removed any other way.
UPDATE agents
SET deleted_at = now()
WHERE deleted_at IS NULL
  AND agent_type = 'mcp_gateway'
  AND is_personal_gateway = true
  AND author_id IS NULL;
