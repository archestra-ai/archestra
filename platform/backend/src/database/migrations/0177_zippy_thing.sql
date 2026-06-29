ALTER TABLE "organization" ADD COLUMN "default_agent_id" uuid;

-- FK constraint: auto-clear org default when the agent is deleted
ALTER TABLE "organization"
  ADD CONSTRAINT "organization_default_agent_id_agents_id_fk"
  FOREIGN KEY ("default_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;

-- Rename "appearance" RBAC resource to "appearanceSettings" in all custom roles
UPDATE "organization_role"
SET
  "permission" = REPLACE("permission"::text, '"appearance"', '"appearanceSettings"')::text,
  "updated_at" = NOW()
WHERE "permission"::text LIKE '%"appearance":%';
