-- Backfill the new `credentialConnection:use` action onto existing custom
-- roles (frozen JSON permission snapshots; predefined roles pick their
-- permissions up from code).
--
-- Seeing and using OTHER users' personal MCP connections used to ride along
-- with `mcpServerInstallation:admin`, which also grants full install
-- management. Acting through a colleague's connection is now its own
-- privilege: `credentialConnection:use` (which also covers seeing those
-- connections — visible and assignable are deliberately one grant). Granting
-- it to roles that already held `mcpServerInstallation:admin` preserves their
-- previous capability exactly; orgs that want the narrower posture remove it
-- from the role (the install-admin bypass still lets such roles SEE every
-- connection, matching pre-split behavior).
--
-- Roles WITHOUT `mcpServerInstallation:admin` are untouched: they could never
-- see other users' connections, so they gain nothing here.
--
-- LIKE checks keep this compatible with PGlite (no jsonb `?` operator).
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{credentialConnection}',
  COALESCE("permission"::jsonb -> 'credentialConnection', '[]'::jsonb)
    || '["use"]'::jsonb
)::text
WHERE COALESCE(("permission"::jsonb -> 'mcpServerInstallation')::text, '') LIKE '%"admin"%'
  AND NOT COALESCE(("permission"::jsonb -> 'credentialConnection')::text, '') LIKE '%"use"%';
