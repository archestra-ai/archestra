-- Unassign "Chat Assistant" agent from the "Default Team"
-- The Chat Assistant is an internal agent that should not be scoped to any team.
DELETE FROM "agent_team"
WHERE agent_id IN (
  SELECT id FROM "agents"
  WHERE name = 'Chat Assistant' AND agent_type = 'agent'
)
AND team_id IN (
  SELECT id FROM "team"
  WHERE name = 'Default Team'
);
