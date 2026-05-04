-- Backfill mcp_server.cluster_id for existing rows where it is NULL.
-- Personal-scoped servers (owner_id set, team_id not set) prefer the
-- is_personal_default cluster, otherwise fall through to is_default.

UPDATE mcp_server
SET cluster_id = (
  SELECT id FROM cluster
  WHERE is_personal_default = true
  ORDER BY created_at ASC
  LIMIT 1
)
WHERE cluster_id IS NULL
  AND owner_id IS NOT NULL
  AND team_id IS NULL
  AND EXISTS (SELECT 1 FROM cluster WHERE is_personal_default = true);
--> statement-breakpoint
UPDATE mcp_server
SET cluster_id = (
  SELECT id FROM cluster WHERE is_default = true LIMIT 1
)
WHERE cluster_id IS NULL
  AND EXISTS (SELECT 1 FROM cluster WHERE is_default = true);
