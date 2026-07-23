-- Custom SQL migration file, put your code below! --

-- Backfill the new `project:share-org` action onto existing custom roles
-- (frozen JSON permission snapshots; predefined roles pick their permissions
-- up from code). Org-wide project sharing — and deleting/unsharing an
-- org-wide project — is now gated behind `project:share-org`; before, any
-- role with `project:update`/`project:delete` could do it through ownership.
-- Granting the new action to roles holding either preserves their previous
-- capability exactly; orgs that want to restrict org-wide sharing remove it
-- from the role. LIKE checks keep this compatible with PGlite (no jsonb `?`
-- operator).
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{project}',
  COALESCE("permission"::jsonb -> 'project', '[]'::jsonb) || '["share-org"]'::jsonb
)::text
WHERE (
  COALESCE(("permission"::jsonb -> 'project')::text, '') LIKE '%"update"%'
  OR COALESCE(("permission"::jsonb -> 'project')::text, '') LIKE '%"delete"%'
)
  AND NOT COALESCE(("permission"::jsonb -> 'project')::text, '') LIKE '%"share-org"%';
