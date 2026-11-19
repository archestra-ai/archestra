-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Who may put agents on an Agent Runtime, and change its settings on them,
-- moves from the `agent:configure-runtime` role action to `agentRuntime`
-- grants that can name one runtime. Every organization gets the policy on all
-- runtimes: Admin and Platform Admin hold Full access, as they do in a new
-- organization, and each custom role that held `agent:configure-runtime`
-- keeps the same reach as "Can use and configure" on every runtime. Editor
-- and Member never held the action, so they get nothing.
INSERT INTO resource_permission_policies
  (organization_id, resource, scope, grants, revision, legacy_sharing_migrated, updated_at)
SELECT organization.id, 'agentRuntime', '*',
  jsonb_build_array(
    jsonb_build_object(
      'subject', jsonb_build_object('type', 'role', 'id', 'admin'),
      'actions', jsonb_build_array('read', 'use', 'configure', 'manage-permissions')
    ),
    jsonb_build_object(
      'subject', jsonb_build_object('type', 'role', 'id', 'platform_admin'),
      'actions', jsonb_build_array('read', 'use', 'configure', 'manage-permissions')
    )
  ) || COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'subject', jsonb_build_object('type', 'role', 'id', role.id),
          'actions', jsonb_build_array('read', 'use', 'configure')
        )
        ORDER BY role.id
      )
      FROM organization_role AS role
      WHERE role.organization_id = organization.id
        AND COALESCE(role.permission::jsonb->'agent' ? 'configure-runtime', false)
    ),
    '[]'::jsonb
  ),
  1, true, now()
FROM organization
ON CONFLICT (organization_id, resource, scope) DO NOTHING;
--> statement-breakpoint
UPDATE organization_role AS role
SET permission = jsonb_set(
    role.permission::jsonb,
    '{agent}',
    (role.permission::jsonb->'agent') - 'configure-runtime'
  )::text,
  updated_at = now()
WHERE COALESCE(role.permission::jsonb->'agent' ? 'configure-runtime', false);
