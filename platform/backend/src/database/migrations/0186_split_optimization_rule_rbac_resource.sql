-- Data migration: remove stale RBAC resources and split optimization rules
-- into their own dedicated resource.
--
-- Why:
-- 1. "securitySettings" is no longer a valid RBAC resource. Leaving it in
--    custom-role JSON will break response schema validation because
--    PermissionsSchema rejects unknown keys.
-- 2. Optimization rules now use the dedicated "optimizationRule" resource
--    instead of incorrectly reusing llmProxy / llmLimit checks.
--
-- Backward compatibility:
-- - We preserve existing effective access by seeding optimizationRule from the
--   union of llmLimit and llmProxy actions when optimizationRule is not yet set.
--
-- Note: The "permission" column is text, so we cast to jsonb for manipulation.
-- Uses text LIKE checks instead of jsonb ? operator for PGlite compatibility.

-- Step 1: Remove stale "securitySettings" keys
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'securitySettings')::text
WHERE "permission"::text LIKE '%"securitySettings":%';

-- Step 2a: Seed "optimizationRule" from the union of llmLimit + llmProxy
-- when optimizationRule does not yet exist.
UPDATE "organization_role"
SET "permission" = (
  "permission"::jsonb || jsonb_build_object(
    'optimizationRule',
    (
      SELECT COALESCE(jsonb_agg(DISTINCT val), '[]'::jsonb)
      FROM (
        SELECT jsonb_array_elements_text("permission"::jsonb->'llmLimit') AS val
        WHERE "permission"::text LIKE '%"llmLimit":%'
        UNION
        SELECT jsonb_array_elements_text("permission"::jsonb->'llmProxy') AS val
        WHERE "permission"::text LIKE '%"llmProxy":%'
      ) combined
    )
  )
)::text
WHERE NOT "permission"::text LIKE '%"optimizationRule":%'
  AND (
    "permission"::text LIKE '%"llmLimit":%'
    OR "permission"::text LIKE '%"llmProxy":%'
  );

-- Step 2b: If optimizationRule already exists, union llmLimit into it.
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'optimizationRule') || jsonb_build_object(
    'optimizationRule',
    (
      SELECT jsonb_agg(DISTINCT val)
      FROM (
        SELECT jsonb_array_elements_text("permission"::jsonb->'optimizationRule') AS val
        UNION
        SELECT jsonb_array_elements_text("permission"::jsonb->'llmLimit') AS val
      ) combined
    )
  )
)::text
WHERE "permission"::text LIKE '%"optimizationRule":%'
  AND "permission"::text LIKE '%"llmLimit":%';

-- Step 2c: If optimizationRule already exists, union llmProxy into it.
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb - 'optimizationRule') || jsonb_build_object(
    'optimizationRule',
    (
      SELECT jsonb_agg(DISTINCT val)
      FROM (
        SELECT jsonb_array_elements_text("permission"::jsonb->'optimizationRule') AS val
        UNION
        SELECT jsonb_array_elements_text("permission"::jsonb->'llmProxy') AS val
      ) combined
    )
  )
)::text
WHERE "permission"::text LIKE '%"optimizationRule":%'
  AND "permission"::text LIKE '%"llmProxy":%';
