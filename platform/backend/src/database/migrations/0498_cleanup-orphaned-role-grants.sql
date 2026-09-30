-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Role deletion now removes its grants transactionally. Repair references left
-- by older deletions, including organization-wide policies inherited by objects.
-- Custom roles use immutable IDs; never reconnect a grant by its display name
-- or identifier. Built-in roles have no organization_role row and stay valid.
-- Keep policy rows and migration markers even when no grants remain, so legacy
-- sharing conversion cannot recreate access. Bump only changed revisions to
-- invalidate editors opened before this cleanup.
UPDATE resource_permission_policies AS policy
SET grants = COALESCE((
  SELECT jsonb_agg(entry.value ORDER BY entry.position)
  FROM jsonb_array_elements(policy.grants) WITH ORDINALITY AS entry(value, position)
  WHERE entry.value->'subject'->>'type' <> 'role'
    OR entry.value->'subject'->>'id' IN ('admin', 'editor', 'member', 'platform_admin')
    OR EXISTS (
      SELECT 1 FROM organization_role AS role
      WHERE role.organization_id = policy.organization_id
        AND role.id = entry.value->'subject'->>'id'
    )
), '[]'::jsonb),
revision = policy.revision + 1,
updated_at = now()
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(policy.grants) AS entry(value)
  WHERE entry.value->'subject'->>'type' = 'role'
    AND entry.value->'subject'->>'id' NOT IN ('admin', 'editor', 'member', 'platform_admin')
    AND NOT EXISTS (
      SELECT 1 FROM organization_role AS role
      WHERE role.organization_id = policy.organization_id
        AND role.id = entry.value->'subject'->>'id'
    )
);
