-- Rename "appearance" RBAC resource to "appearanceSettings" in all custom roles
UPDATE "organization_role"
SET
  "permission" = REPLACE("permission"::text, '"appearance"', '"appearanceSettings"')::text,
  "updated_at" = NOW()
WHERE "permission"::text LIKE '%"appearance"%';
