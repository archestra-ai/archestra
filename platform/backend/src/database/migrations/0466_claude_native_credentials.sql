-- Preserve existing GitHub runtime connections and Agent bindings as a custom credential.
INSERT INTO "runtime_credential_definitions"
  ("organization_id", "key", "name", "description", "icon", "allow_personal", "allow_organization")
SELECT DISTINCT "organization_id", 'github', 'GitHub PAT',
  'A GitHub personal access token for repository access.', 'logo:github', true, false
FROM (
  SELECT "organization_id" FROM "runtime_credential_connections" WHERE "credential_id" = 'github'
  UNION
  SELECT "organization_id" FROM "agents"
  WHERE "runtime"->'credentials' @> '[{"credentialId":"github"}]'::jsonb
) AS "existing_github_usage"
ON CONFLICT ("organization_id", "key") DO NOTHING;
--> statement-breakpoint
-- Native sign-in replaces token declarations. Stored secrets are not copied or deleted.
UPDATE "agents"
SET "runtime" = jsonb_set("runtime", '{credentials}', COALESCE((
  SELECT jsonb_agg("declaration")
  FROM jsonb_array_elements("runtime"->'credentials') AS "declaration"
  WHERE "declaration"->>'key' <> 'CLAUDE_CODE_OAUTH_TOKEN'
), '[]'::jsonb))
WHERE "runtime"->'command'->>0 = 'archestra-claude-code'
AND "runtime"->'credentials' @> '[{"key":"CLAUDE_CODE_OAUTH_TOKEN"}]'::jsonb;
