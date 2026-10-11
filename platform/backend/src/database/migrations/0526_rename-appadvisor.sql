-- Keep the stable built-in identity and all conversation references.
UPDATE "agents"
SET "name" = 'APPAdvisor'
WHERE "built_in" = true
  AND "built_in_agent_config"->>'name' = 'openappa-configuration-agent';
--> statement-breakpoint
UPDATE "tools"
SET "name" = 'agent__appadvisor',
    "description" = 'Delegate task to agent: APPAdvisor'
WHERE "delegate_to_agent_id" IN (
  SELECT "id" FROM "agents"
  WHERE "built_in" = true
    AND "built_in_agent_config"->>'name' = 'openappa-configuration-agent'
);
