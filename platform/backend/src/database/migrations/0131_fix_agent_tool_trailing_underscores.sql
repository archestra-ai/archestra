-- Fix: Trim trailing underscores from agent delegation tool names
-- Root cause: Migration 0122 used SQL REGEXP_REPLACE which doesn't trim trailing underscores,
-- but the TypeScript slugify() function does trim them. This mismatch causes tool invocation
-- to fail because the lookup re-slugifies the agent name and doesn't match the stored tool name.

-- Update tool names to remove trailing underscores from the slug portion
-- Pattern: 'agent__<slug>_' -> 'agent__<slug>'
UPDATE "tools"
SET
  "name" = REGEXP_REPLACE("name", '_+$', ''),
  "updated_at" = NOW()
WHERE "name" LIKE 'agent\_\_%' ESCAPE '\'
  AND "name" LIKE '%\_' ESCAPE '\';
