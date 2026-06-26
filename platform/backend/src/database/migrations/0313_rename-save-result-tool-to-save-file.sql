-- Rename built-in Archestra tool: save_result → save_file
-- The tool's full name is persisted in tools.name (unique per catalog_id, name).
-- Startup seeding upserts built-in tools by name, so without this rename the
-- renamed code would insert a fresh save_file row and prune the old save_result
-- row, cascading away existing agent/conversation assignments. Renaming the row
-- in place keeps its id, so those assignments keep resolving. Runs before the
-- app seeds via the Helm pre-upgrade migration hook.
--
-- Scoped to the built-in Archestra catalog row only — exactly the predicate of
-- the tools_archestra_catalog_name_uidx partial unique index. An external MCP
-- server slugged "archestra" with a tool "save_result" would yield the same
-- archestra__save_result name in a different catalog/agent row, which this rename
-- must not touch.
UPDATE "tools"
SET "name" = 'archestra__save_file'
WHERE "name" = 'archestra__save_result'
  AND "catalog_id" = '00000000-0000-4000-8000-000000000001'
  AND "agent_id" IS NULL
  AND "delegate_to_agent_id" IS NULL;
