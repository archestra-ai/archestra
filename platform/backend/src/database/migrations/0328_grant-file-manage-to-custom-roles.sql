-- Custom SQL migration file, put your code below! --

-- Backfill the new `file` RBAC resource into custom roles that have
-- `sandbox:execute`. The persistent file-store tools (search_files, read_file,
-- save_file, edit_file, delete_file) moved from `sandbox:execute` to the new
-- `file:manage` permission, so roles that could use them before keep that
-- access. Custom roles store a frozen JSON permission snapshot; predefined
-- roles pick the permission up from code. Roles that already define a `file`
-- entry are left untouched.
-- LIKE checks keep this compatible with PGlite (no jsonb `?` operator).
UPDATE "organization_role"
SET "permission" = jsonb_set(
  "permission"::jsonb, '{file}', '["manage"]'::jsonb
)::text
WHERE "permission"::text LIKE '%"sandbox"%'
  AND ("permission"::jsonb -> 'sandbox')::text LIKE '%"execute"%'
  AND NOT "permission"::text LIKE '%"file"%';
