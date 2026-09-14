ALTER TABLE "runtime_credential_connections" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Preserve one existing personal account per organization/user. Prefer an
-- unexpired connection, then the most recently updated one. Tokens stay in the
-- secrets backend; only their references and non-secret metadata move.
INSERT INTO "runtime_credential_connections"
  ("organization_id", "scope", "user_id", "credential_id", "secret_id", "metadata", "created_at", "updated_at")
SELECT DISTINCT ON ("organization_id", "user_id")
  "organization_id", 'personal', "user_id", 'claude-code:account', "secret_id", "metadata", "created_at", "updated_at"
FROM "user_credentials"
WHERE "key" LIKE 'claude-code-account:%'
ORDER BY "organization_id", "user_id",
  ("metadata"->>'expiresAt' IS NULL OR "metadata"->>'expiresAt' > to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) DESC,
  "updated_at" DESC, "id"
ON CONFLICT ("organization_id", "user_id", "credential_id") WHERE "scope" = 'personal' DO NOTHING;
--> statement-breakpoint
-- Detach legacy rows so deleting an Agent cannot remove the shared connection.
DELETE FROM "user_credentials" WHERE "key" LIKE 'claude-code-account:%';
