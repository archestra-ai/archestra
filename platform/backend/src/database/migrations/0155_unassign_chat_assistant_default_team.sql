-- Unassign the "Default Team" from the "Chat Assistant" agent.
-- With org-wide agents, the Chat Assistant no longer needs a default team assignment.
DELETE FROM agent_team
WHERE agent_id IN (
  SELECT id FROM agents WHERE name = 'Chat Assistant'
)
AND team_id IN (
  SELECT id FROM team WHERE name = 'Default Team'
);
