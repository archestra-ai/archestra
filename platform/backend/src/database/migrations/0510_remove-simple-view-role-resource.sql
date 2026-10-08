-- Simple View is no longer a role resource: the sidebar starts open and each
-- person's own open/collapse choice is remembered in their browser. Custom
-- roles drop the retired key.
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'simpleView')::text,
  "updated_at" = now()
WHERE "permission"::jsonb ? 'simpleView';
