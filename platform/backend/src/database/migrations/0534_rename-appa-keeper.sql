-- Keep the stable built-in identity and all conversation references.
UPDATE "agents"
SET "name" = 'APPA Keeper'
WHERE "built_in" = true
  AND "built_in_agent_config"->>'name' = 'openappa-configuration-agent';
--> statement-breakpoint
UPDATE "tools"
SET "name" = 'agent__appa_keeper',
    "description" = 'Delegate task to agent: APPA Keeper'
WHERE "delegate_to_agent_id" IN (
  SELECT "id" FROM "agents"
  WHERE "built_in" = true
    AND "built_in_agent_config"->>'name' = 'openappa-configuration-agent'
);
