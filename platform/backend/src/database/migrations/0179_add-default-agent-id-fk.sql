-- Add FK constraint on organization.default_agent_id → agents.id with ON DELETE SET NULL
ALTER TABLE "organization"
  ADD CONSTRAINT "organization_default_agent_id_agents_id_fk"
  FOREIGN KEY ("default_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
