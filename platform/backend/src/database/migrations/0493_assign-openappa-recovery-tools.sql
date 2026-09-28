-- Assign the recovery tools to every active user-configurable agent and MCP
-- gateway. Match by catalog and short name so branded tool names are included.
WITH recovery_tools AS (
  SELECT DISTINCT ON (regexp_replace("name", '^.*__', '')) "id"
  FROM "tools"
  WHERE "catalog_id" = '00000000-0000-4000-8000-000000000001'
    AND "agent_id" IS NULL
    AND "delegate_to_agent_id" IS NULL
    AND regexp_replace("name", '^.*__', '') IN (
      'get_remedy_plans', 'execute_remedy_plan', 'yell'
    )
  ORDER BY regexp_replace("name", '^.*__', ''), "created_at", "id"
)
INSERT INTO "agent_tools" ("agent_id", "tool_id")
SELECT a."id", t."id"
FROM "agents" a
CROSS JOIN recovery_tools t
WHERE a."deleted_at" IS NULL
  AND a."built_in_agent_config" IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Existing Auto-mode exclusions must not override the required assignment.
DELETE FROM "agent_excluded_tools" e
USING "tools" t
WHERE e."tool_id" = t."id"
  AND t."catalog_id" = '00000000-0000-4000-8000-000000000001'
  AND regexp_replace(t."name", '^.*__', '') IN (
    'get_remedy_plans', 'execute_remedy_plan', 'yell'
  );
