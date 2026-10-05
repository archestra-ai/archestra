-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Split OpenAPPA authority from the legacy tools, organization, and log resources.
-- Keep those resources: they still govern non-OpenAPPA endpoints. Map actions
-- independently so users composing multiple roles retain their effective access.
-- Read-only diagnostics see all yells and their own consults. Organization-wide
-- consult access comes only from the former log admin flag or an existing
-- organization-wide log grant for the custom role's immutable ID.
WITH mapped AS (
  SELECT role.id, role.permission::jsonb AS original,
    jsonb_build_object(
      'openappaPolicy', COALESCE((
        SELECT jsonb_agg(DISTINCT action ORDER BY action)
        FROM (
          SELECT jsonb_array_elements_text(COALESCE(role.permission::jsonb->'openappaPolicy', '[]'::jsonb)) AS action
          UNION ALL
          SELECT jsonb_array_elements_text(COALESCE(role.permission::jsonb->'toolPolicy', '[]'::jsonb))
        ) actions WHERE action IN ('read', 'update')
      ), '[]'::jsonb),
      'openappaSettings', COALESCE((
        SELECT jsonb_agg(DISTINCT action ORDER BY action)
        FROM (
          SELECT jsonb_array_elements_text(COALESCE(role.permission::jsonb->'openappaSettings', '[]'::jsonb)) AS action
          UNION ALL
          SELECT 'read' WHERE COALESCE(role.permission::jsonb->'toolPolicy', '[]'::jsonb) ? 'read'
          UNION ALL
          SELECT 'update' WHERE COALESCE(role.permission::jsonb->'organization', '[]'::jsonb) ? 'update'
        ) actions
      ), '[]'::jsonb),
      'openappaDiagnostics', COALESCE((
        SELECT jsonb_agg(DISTINCT action ORDER BY action)
        FROM (
          SELECT jsonb_array_elements_text(COALESCE(role.permission::jsonb->'openappaDiagnostics', '[]'::jsonb)) AS action
          UNION ALL
          SELECT 'read' WHERE COALESCE(role.permission::jsonb->'log', '[]'::jsonb) ? 'read'
          UNION ALL
          SELECT 'update' WHERE COALESCE(role.permission::jsonb->'toolPolicy', '[]'::jsonb) ? 'update'
          UNION ALL
          SELECT 'admin' WHERE COALESCE(role.permission::jsonb->'log', '[]'::jsonb) ? 'admin'
            OR EXISTS (
              SELECT 1 FROM resource_permission_policies AS policy,
                jsonb_array_elements(policy.grants) AS grant_entry
              WHERE policy.organization_id = role.organization_id
                AND policy.resource = 'log' AND policy.scope = '*'
                AND grant_entry->'actions' ? 'read'
                AND (
                  (grant_entry->'subject'->>'type' = 'role' AND grant_entry->'subject'->>'id' = role.id)
                  OR grant_entry->'subject'->>'type' = 'organization'
                )
            )
        ) actions
      ), '[]'::jsonb)
    ) AS additions
  FROM organization_role AS role
), merged AS (
  SELECT id, original || additions AS permission FROM mapped
)
UPDATE organization_role AS role
SET permission = merged.permission::text, updated_at = now()
FROM merged
WHERE role.id = merged.id AND role.permission::jsonb IS DISTINCT FROM merged.permission;
