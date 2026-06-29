UPDATE "agents"
SET "identity_provider_id" = NULL
WHERE "agent_type" = 'agent'
  AND "identity_provider_id" IS NOT NULL;
