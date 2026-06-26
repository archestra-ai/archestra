-- Rename built-in Archestra tool: save_result → save_file
-- The tool's full name is persisted in tools.name (unique per catalog_id, name).
-- Startup seeding upserts built-in tools by name, so without this rename the
-- renamed code would insert a fresh save_file row and prune the old save_result
-- row, cascading away existing agent/conversation assignments. Renaming the row
-- in place keeps its id, so those assignments keep resolving. Runs before the
-- app seeds via the Helm pre-upgrade migration hook.
UPDATE "tools"
SET "name" = 'archestra__save_file'
WHERE "name" = 'archestra__save_result';
