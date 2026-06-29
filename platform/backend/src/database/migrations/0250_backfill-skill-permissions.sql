-- Custom SQL migration file, put your code below! --

-- Backfill the `skill` RBAC resource into custom roles created before it
-- existed. Custom roles store a frozen JSON permission snapshot, so the new
-- `skill` resource is absent and those roles lose all skill access. Mirror the
-- role's `agent` permissions onto `skill` (both resources share the same
-- action set). Roles with no `agent` permission are left untouched.
-- LIKE checks keep this compatible with PGlite (no jsonb `?` operator).
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{skill}', "permission"::jsonb->'agent'
)::text
WHERE "permission"::text LIKE '%"agent"%'
  AND NOT "permission"::text LIKE '%"skill"%';