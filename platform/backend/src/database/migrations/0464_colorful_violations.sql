-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
ALTER TABLE "resource_permission_policies" ADD COLUMN "legacy_sharing_migrated" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
-- Convert resource sharing to independent grants. Membership admin status is
-- deliberately absent: a team's grant applies to every member of that team.
-- Existing explicit grants are merged, not replaced. Deleted resources are
-- included so restoring a resource cannot discard its access policy.
WITH targets AS (
  SELECT a.organization_id, CASE WHEN a.agent_type = 'mcp_gateway' THEN 'mcpGateway' ELSE 'agent' END AS resource,
    a.id::text AS scope, a.scope::text AS visibility, a.author_id, a.id AS source_id
  FROM agents a WHERE a.agent_type IN ('agent', 'profile', 'mcp_gateway')
  UNION ALL
  SELECT s.organization_id, 'skill', s.id::text, s.scope, s.author_id, s.id FROM skills s
  UNION ALL
  SELECT o.id, 'mcpRegistry', c.id::text, c.scope::text, c.author_id, c.id
  FROM internal_mcp_catalog c
  JOIN organization o ON c.organization_id = o.id OR c.organization_id IS NULL
  WHERE c.id NOT IN ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')
    AND c.server_type <> 'app' AND c.parent_catalog_item_id IS NULL
  UNION ALL
  SELECT a.organization_id, 'app', a.id::text, c.scope::text, a.author_id, c.id
  FROM apps a JOIN mcp_server s ON s.id = a.mcp_server_id
  JOIN internal_mcp_catalog c ON c.id = s.catalog_id
  WHERE c.organization_id = a.organization_id OR c.organization_id IS NULL
  UNION ALL
  SELECT o.id, 'llmModel', m.id::text,
    CASE WHEN EXISTS (SELECT 1 FROM model_team mt WHERE mt.model_id = m.id) THEN 'team' ELSE 'org' END,
    NULL::text, m.id
  FROM models m CROSS JOIN organization o
), audience AS (
  SELECT t.organization_id, t.resource, t.scope, 'organization' AS subject_type, '*' AS subject_id,
    ARRAY['read', 'use']::text[] AS actions
  FROM targets t WHERE t.visibility = 'org'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'user', t.author_id,
    ARRAY['read', 'use', 'update', 'delete', 'manage-permissions']::text[]
  FROM targets t JOIN member m ON m.organization_id = t.organization_id AND m.user_id = t.author_id
  WHERE t.visibility = 'personal'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'team', at.team_id, ARRAY['read', 'use']::text[]
  FROM targets t JOIN agent_team at ON at.agent_id = t.source_id
  JOIN team tm ON tm.id = at.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource IN ('agent', 'mcpGateway') AND t.visibility = 'team'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'team', st.team_id, ARRAY['read', 'use']::text[]
  FROM targets t JOIN skill_team st ON st.skill_id = t.source_id
  JOIN team tm ON tm.id = st.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource = 'skill' AND t.visibility = 'team'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'team', ct.team_id,
    CASE WHEN ct.level = 'write' THEN ARRAY['read', 'use', 'update'] ELSE ARRAY['read', 'use'] END
  FROM targets t JOIN mcp_catalog_team ct ON ct.catalog_id = t.source_id
  JOIN team tm ON tm.id = ct.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource IN ('mcpRegistry', 'app') AND t.visibility = 'team'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'team', mt.team_id, ARRAY['read', 'use']::text[]
  FROM targets t JOIN model_team mt ON mt.model_id = t.source_id
  JOIN team tm ON tm.id = mt.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource = 'llmModel'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'user', au.user_id,
    CASE WHEN au.level = 'write' THEN ARRAY['read', 'use', 'update'] ELSE ARRAY['read', 'use'] END
  FROM targets t JOIN agent_user au ON au.agent_id = t.source_id
  JOIN member m ON m.user_id = au.user_id AND m.organization_id = t.organization_id
  WHERE t.resource IN ('agent', 'mcpGateway') AND t.visibility = 'personal'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'user', su.user_id,
    CASE WHEN su.level = 'write' THEN ARRAY['read', 'use', 'update'] ELSE ARRAY['read', 'use'] END
  FROM targets t JOIN skill_user su ON su.skill_id = t.source_id
  JOIN member m ON m.user_id = su.user_id AND m.organization_id = t.organization_id
  WHERE t.resource = 'skill' AND t.visibility = 'personal'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'user', cu.user_id,
    CASE WHEN cu.level = 'write' THEN ARRAY['read', 'use', 'update'] ELSE ARRAY['read', 'use'] END
  FROM targets t JOIN mcp_catalog_user cu ON cu.catalog_id = t.source_id
  JOIN member m ON m.user_id = cu.user_id AND m.organization_id = t.organization_id
  WHERE t.resource IN ('mcpRegistry', 'app') AND t.visibility = 'personal'
  UNION ALL
  -- Named model sharing historically grants discovery, not invocation.
  SELECT t.organization_id, t.resource, t.scope, 'user', mu.user_id, ARRAY['read']::text[]
  FROM targets t JOIN model_user mu ON mu.model_id = t.source_id
  JOIN member m ON m.user_id = mu.user_id AND m.organization_id = t.organization_id
  WHERE t.resource = 'llmModel'
), existing AS (
  SELECT p.organization_id, p.resource, p.scope,
    g->'subject'->>'type' AS subject_type, g->'subject'->>'id' AS subject_id,
    ARRAY(SELECT jsonb_array_elements_text(g->'actions')) AS actions
  FROM resource_permission_policies p CROSS JOIN LATERAL jsonb_array_elements(p.grants) g
  JOIN targets t ON t.organization_id = p.organization_id AND t.resource = p.resource AND t.scope = p.scope
), expanded AS (
  SELECT organization_id, resource, scope, subject_type, subject_id, unnest(actions) AS action
  FROM (SELECT * FROM audience UNION ALL SELECT * FROM existing) combined
), subjects AS (
  SELECT organization_id, resource, scope, subject_type, subject_id,
    jsonb_agg(DISTINCT action ORDER BY action) AS actions
  FROM expanded GROUP BY organization_id, resource, scope, subject_type, subject_id
), policies AS (
  SELECT t.organization_id, t.resource, t.scope,
    COALESCE(jsonb_agg(jsonb_build_object('subject', jsonb_build_object('type', s.subject_type, 'id', s.subject_id), 'actions', s.actions)
      ORDER BY s.subject_type, s.subject_id) FILTER (WHERE s.subject_id IS NOT NULL), '[]'::jsonb) AS grants
  FROM targets t LEFT JOIN subjects s USING (organization_id, resource, scope)
  GROUP BY t.organization_id, t.resource, t.scope
)
INSERT INTO resource_permission_policies (organization_id, resource, scope, grants, legacy_sharing_migrated)
SELECT organization_id, resource, scope, grants, true FROM policies
ON CONFLICT (organization_id, resource, scope) DO UPDATE
SET grants = EXCLUDED.grants, legacy_sharing_migrated = true, revision = resource_permission_policies.revision + 1, updated_at = now()
WHERE NOT resource_permission_policies.legacy_sharing_migrated OR resource_permission_policies.grants IS DISTINCT FROM EXCLUDED.grants;
--> statement-breakpoint
-- Convert existing organization-wide authority into complete action/scope
-- tuples. Custom roles retain their stable IDs when renamed. An elevated
-- scope flag alone does not manufacture CRUD actions that the role lacks.
WITH resources(resource) AS (
  VALUES ('agent'), ('mcpGateway'), ('mcpRegistry'), ('skill'), ('app'), ('llmModel')
), role_actions AS (
  SELECT o.id AS organization_id, r.resource, builtin.id AS subject_id,
    unnest(ARRAY['read', 'use', 'update', 'delete', 'manage-permissions']) AS action
  FROM organization o CROSS JOIN resources r
  CROSS JOIN (VALUES ('admin'), ('platform_admin')) builtin(id)
  UNION ALL
  SELECT roles.organization_id, r.resource, roles.id,
    expanded.action
  FROM organization_role roles CROSS JOIN resources r
  CROSS JOIN LATERAL (
    SELECT CASE WHEN action = 'read' THEN 'read' ELSE action END AS action
    FROM jsonb_array_elements_text(COALESCE(roles.permission::jsonb->r.resource, '[]'::jsonb)) action
    WHERE action IN ('read', 'update', 'delete')
    UNION
    SELECT 'use' WHERE COALESCE(roles.permission::jsonb->r.resource, '[]'::jsonb) ? 'read'
    UNION
    SELECT 'manage-permissions' WHERE COALESCE(roles.permission::jsonb->r.resource, '[]'::jsonb) ? 'update'
    UNION
    SELECT 'use' WHERE r.resource = 'llmModel' AND COALESCE(roles.permission::jsonb->r.resource, '[]'::jsonb) ? 'update'
  ) expanded
  WHERE CASE
    WHEN r.resource = 'mcpRegistry' THEN COALESCE(roles.permission::jsonb->'mcpServerInstallation', '[]'::jsonb) ? 'admin'
    WHEN r.resource = 'llmModel' THEN COALESCE(roles.permission::jsonb->'llmModel', '[]'::jsonb) ? 'update'
    ELSE COALESCE(roles.permission::jsonb->r.resource, '[]'::jsonb) ? 'admin'
  END
), entries AS (
  SELECT organization_id, resource, 'role' AS subject_type, subject_id, action FROM role_actions
  UNION ALL
  SELECT p.organization_id, p.resource, g->'subject'->>'type', g->'subject'->>'id', action
  FROM resource_permission_policies p CROSS JOIN LATERAL jsonb_array_elements(p.grants) g
  CROSS JOIN LATERAL jsonb_array_elements_text(g->'actions') action
  WHERE p.scope = '*' AND p.resource IN (SELECT resource FROM resources)
), subjects AS (
  SELECT organization_id, resource, subject_type, subject_id, jsonb_agg(DISTINCT action ORDER BY action) AS actions
  FROM entries GROUP BY organization_id, resource, subject_type, subject_id
), policies AS (
  SELECT organization_id, resource,
    jsonb_agg(jsonb_build_object('subject', jsonb_build_object('type', subject_type, 'id', subject_id), 'actions', actions)
      ORDER BY subject_type, subject_id) AS grants
  FROM subjects GROUP BY organization_id, resource
)
INSERT INTO resource_permission_policies (organization_id, resource, scope, grants, legacy_sharing_migrated)
SELECT organization_id, resource, '*', grants, true FROM policies
ON CONFLICT (organization_id, resource, scope) DO UPDATE
SET grants = EXCLUDED.grants, legacy_sharing_migrated = true, revision = resource_permission_policies.revision + 1, updated_at = now()
WHERE NOT resource_permission_policies.legacy_sharing_migrated OR resource_permission_policies.grants IS DISTINCT FROM EXCLUDED.grants;
--> statement-breakpoint
-- A resource-level team-admin flag becomes a relative scope, not a team
-- membership role. It applies only while the actor belongs to a team with a
-- direct grant to the object; removing that membership removes the access.
WITH resources(resource) AS (
  VALUES ('agent'), ('mcpGateway'), ('skill'), ('app')
), role_actions AS (
  SELECT o.id AS organization_id, r.resource, 'editor' AS subject_id,
    unnest(ARRAY['read', 'use', 'update', 'delete', 'manage-permissions']) AS action
  FROM organization o CROSS JOIN resources r
  UNION ALL
  SELECT roles.organization_id, r.resource, roles.id, expanded.action
  FROM organization_role roles CROSS JOIN resources r
  CROSS JOIN LATERAL (
    SELECT action FROM jsonb_array_elements_text(COALESCE(roles.permission::jsonb->r.resource, '[]'::jsonb)) action
    WHERE action IN ('read', 'update', 'delete')
    UNION
    SELECT 'use' WHERE COALESCE(roles.permission::jsonb->r.resource, '[]'::jsonb) ? 'read'
    UNION
    SELECT 'manage-permissions' WHERE COALESCE(roles.permission::jsonb->r.resource, '[]'::jsonb) ? 'update'
  ) expanded
  WHERE COALESCE(roles.permission::jsonb->r.resource, '[]'::jsonb) ? 'team-admin'
    AND NOT COALESCE(roles.permission::jsonb->r.resource, '[]'::jsonb) ? 'admin'
), entries AS (
  SELECT organization_id, resource, 'role' AS subject_type, subject_id, action FROM role_actions
  UNION ALL
  SELECT p.organization_id, p.resource, g->'subject'->>'type', g->'subject'->>'id', action
  FROM resource_permission_policies p CROSS JOIN LATERAL jsonb_array_elements(p.grants) g
  CROSS JOIN LATERAL jsonb_array_elements_text(g->'actions') action
  WHERE p.scope = 'teams:*' AND p.resource IN (SELECT resource FROM resources)
), subjects AS (
  SELECT organization_id, resource, subject_type, subject_id, jsonb_agg(DISTINCT action ORDER BY action) AS actions
  FROM entries GROUP BY organization_id, resource, subject_type, subject_id
), policies AS (
  SELECT organization_id, resource,
    jsonb_agg(jsonb_build_object('subject', jsonb_build_object('type', subject_type, 'id', subject_id), 'actions', actions)
      ORDER BY subject_type, subject_id) AS grants
  FROM subjects GROUP BY organization_id, resource
)
INSERT INTO resource_permission_policies (organization_id, resource, scope, grants, legacy_sharing_migrated)
SELECT organization_id, resource, 'teams:*', grants, true FROM policies
ON CONFLICT (organization_id, resource, scope) DO UPDATE
SET grants = EXCLUDED.grants, legacy_sharing_migrated = true, revision = resource_permission_policies.revision + 1, updated_at = now()
WHERE NOT resource_permission_policies.legacy_sharing_migrated OR resource_permission_policies.grants IS DISTINCT FROM EXCLUDED.grants;
