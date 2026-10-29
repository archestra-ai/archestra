-- Retire the removed built-in without deleting agent, tool, or usage history.
-- Keep its discriminator until all assignment cleanup has completed.
DELETE FROM "agent_tools"
WHERE "agent_id" IN (
  SELECT "id" FROM "agents" WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
) OR "tool_id" IN (
  SELECT "id" FROM "tools" WHERE "delegate_to_agent_id" IN (
    SELECT "id" FROM "agents" WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
  )
);
--> statement-breakpoint
DELETE FROM "agent_excluded_subagents"
WHERE "agent_id" IN (
  SELECT "id" FROM "agents" WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
) OR "target_agent_id" IN (
  SELECT "id" FROM "agents" WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
);
--> statement-breakpoint
UPDATE "tools" SET "deleted_at" = coalesce("deleted_at", now())
WHERE "delegate_to_agent_id" IN (
  SELECT "id" FROM "agents" WHERE "built_in_agent_config"->>'name' = 'advisor-agent'
);
--> statement-breakpoint
UPDATE "agents"
SET "deleted_at" = coalesce("deleted_at", now()), "built_in_agent_config" = NULL
WHERE "built_in_agent_config"->>'name' = 'advisor-agent';
