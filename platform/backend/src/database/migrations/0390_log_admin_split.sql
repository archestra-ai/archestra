CREATE INDEX "mcp_tool_calls_user_id_idx" ON "mcp_tool_calls" USING btree ("user_id");--> statement-breakpoint
-- Backfill the new `log:admin` / `auditLog:admin` actions onto existing
-- custom roles (frozen JSON permission snapshots; predefined roles pick their
-- permissions up from code). `log:read` / `auditLog:read` previously showed
-- every user's records; they now show only the caller's own, with the new
-- `:admin` action granting the org-wide view. Granting `:admin` to roles
-- holding `:read` preserves their previous capability exactly; orgs that want
-- the own-only view remove it from the role. LIKE checks keep this
-- compatible with PGlite (no jsonb `?` operator).
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{log}',
  COALESCE("permission"::jsonb -> 'log', '[]'::jsonb) || '["admin"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'log')::text, '') LIKE '%"read"%'
  AND NOT COALESCE(("permission"::jsonb -> 'log')::text, '') LIKE '%"admin"%';
--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{auditLog}',
  COALESCE("permission"::jsonb -> 'auditLog', '[]'::jsonb) || '["admin"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'auditLog')::text, '') LIKE '%"read"%'
  AND NOT COALESCE(("permission"::jsonb -> 'auditLog')::text, '') LIKE '%"admin"%';
