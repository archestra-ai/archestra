// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { sql } from "drizzle-orm";
import config from "@/config";
import db, { type Transaction } from "@/database";
import logger from "@/logging";

/**
 * Convert the retired visibility fields into grants, and retire the role
 * actions the grants replace.
 *
 * This is deliberately NOT a deploy-time migration. A migration runs on every
 * deployment, including the ones that are not reading grants yet, and its last
 * step removes `admin` and `team-admin` from roles — the very actions the
 * retired code paths still authorize with. Stripping them under a deployment
 * that still answers from visibility fields would take admin authority away
 * with nothing to replace it, and would make the switch a one-way door.
 *
 * So the conversion runs at startup, only where the model is switched on, and
 * it is idempotent: every statement merges rather than replaces, and each one
 * writes only where the result differs from what is already stored. Running it
 * again after someone changed a visibility field picks that change up, which
 * is what makes turning the switch on later safe. Deleting the switch once the
 * model has shipped leaves an unconditional call, so an existing deployment
 * converts itself on its next start with nothing to operate.
 *
 * A grant added by hand survives, because the audience is merged into the
 * stored grants. A revocation made in the editor does not: the visibility
 * field it contradicts is still there, and a re-run reads it again.
 */
export async function runScopedResourcePermissionCutover(
  /** Join a caller's transaction, so a test can roll the whole thing back. */
  transaction?: Transaction,
): Promise<void> {
  const started = Date.now();
  const run = async (tx: Transaction) => {
    for (const statement of [
      ...SHARING_CONVERSION_STATEMENTS,
      ...ROLE_RETIREMENT_STATEMENTS,
    ])
      await tx.execute(statement);
  };
  if (transaction) await run(transaction);
  else await db.transaction(run);
  logger.info(
    { durationMs: Date.now() - started },
    "[ResourcePermissions] Scoped permission conversion applied",
  );
}

/**
 * The conversion in two halves, in the order they must run.
 *
 * The first rewrites sharing as grants; the second gives each role the grants
 * its retired `admin`/`team-admin` flags stood for and then removes the flags.
 * The halves are exported so a test can exercise one without the other; the
 * routine above always runs both, in this order.
 *
 * @public — read by resource-permissions-cutover.roles.test.ts
 */
export const SHARING_CONVERSION_STATEMENTS = [
  // ---------------------------------------------------------------------
  // convertResourceSharing
  // ---------------------------------------------------------------------
  sql.raw(`
-- Convert resource sharing to independent grants. Membership admin status is
-- deliberately absent: a team's grant applies to every member of that team.
-- Existing explicit grants are merged, not replaced. Deleted resources are
-- included so restoring a resource cannot discard its access policy.
--
-- Each object converts exactly once. A legacy_sharing_migrated flag on the
-- object's own policy is the statement "this object is governed by grants
-- now", so a later run leaves it alone: re-deriving from the retired columns
-- would undo every editor change, handing back access revoked there on the
-- next start. The organization-level statements below keep merging, because
-- they carry role authority rather than any one object's audience.
WITH candidates AS (
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
  UNION ALL
  -- A project with no share row is personal. A share naming individuals is
  -- still personal in shape: the owner keeps it and the named people are
  -- added below, exactly as a personally-owned agent shared by name is.
  SELECT p.organization_id, 'project', p.id::text,
    CASE ps.visibility WHEN 'organization' THEN 'org' WHEN 'team' THEN 'team' ELSE 'personal' END,
    p.user_id, p.id
  FROM projects p LEFT JOIN project_shares ps ON ps.project_id = p.id
  WHERE p.deleted_at IS NULL
  UNION ALL
  SELECT pl.organization_id, 'plugin', pl.id::text, pl.scope, pl.author_id, pl.id
  FROM plugins pl WHERE pl.deleted_at IS NULL
  UNION ALL
  SELECT v.organization_id, 'llmVirtualKey', v.id::text, v.scope, v.author_id, v.id
  FROM virtual_api_keys v
  UNION ALL
  SELECT k.organization_id, 'llmProviderApiKey', k.id::text, k.scope, k.user_id, k.id
  FROM chat_api_keys k
  UNION ALL
  -- Knowledge objects carry no author column, so a private one converts to an
  -- object only an administrator reaches. The documents inside keep their own
  -- ACLs: an auto-sync connector resolves access from external groups per
  -- document, which no static grant can express.
  SELECT kb.organization_id, 'knowledgeBase', kb.id::text,
    CASE kb.visibility WHEN 'org-wide' THEN 'org' WHEN 'team-scoped' THEN 'team' ELSE 'personal' END,
    NULL::text, kb.id
  FROM knowledge_bases kb WHERE kb.deleted_at IS NULL
  UNION ALL
  SELECT c.organization_id, 'knowledgeConnector', c.id::text,
    CASE c.visibility WHEN 'team-scoped' THEN 'team' ELSE 'org' END,
    NULL::text, c.id
  FROM knowledge_base_connectors c WHERE c.deleted_at IS NULL
  UNION ALL
  SELECT f.organization_id, 'knowledgeFile', f.id::text,
    CASE f.visibility WHEN 'org-wide' THEN 'org' WHEN 'team-scoped' THEN 'team' ELSE 'personal' END,
    f.uploaded_by, f.id
  FROM kb_files f
), targets AS (
  SELECT c.* FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1 FROM resource_permission_policies p
    WHERE p.organization_id = c.organization_id AND p.resource = c.resource
      AND p.scope = c.scope AND p.legacy_sharing_migrated
  )
), audience AS (
  -- Organization-wide visibility was only half of the old rule: a member whose
  -- role withheld the resource's read action never saw the object. Granting
  -- everyone would drop that half, so the audience becomes the roles that hold
  -- read. Every predefined role holds it for these six resources, so a
  -- deployment using only built-in roles keeps exactly the reach it had.
  SELECT t.organization_id, t.resource, t.scope, 'role' AS subject_type, reader.id AS subject_id,
    ARRAY['read', 'use']::text[] AS actions
  FROM targets t
  JOIN LATERAL (
    SELECT unnest(ARRAY['admin', 'platform_admin', 'editor', 'member']) AS id
    UNION
    SELECT roles.id FROM organization_role roles
    WHERE roles.organization_id = t.organization_id
      AND COALESCE(roles.permission::jsonb -> (CASE
        WHEN t.resource IN ('knowledgeBase', 'knowledgeConnector', 'knowledgeFile')
        THEN 'knowledgeSource' ELSE t.resource END), '[]'::jsonb) ? 'read'
  ) reader ON true
  WHERE t.visibility = 'org'
  UNION ALL
  -- The other half of that rule: seeing an object was role-gated, acting on
  -- one was not. Chatting with an agent, calling a gateway and invoking an
  -- unrestricted model all went through the object's own reach, never the
  -- caller's role, so a role shaped for chat and nothing else kept working.
  -- Granting only the readers here would end that on upgrade.
  SELECT t.organization_id, t.resource, t.scope, 'organization', '*', ARRAY['use']::text[]
  FROM targets t
  WHERE t.visibility = 'org' AND t.resource IN ('agent', 'mcpGateway', 'llmModel')
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
  UNION ALL
  -- A project's audience hangs off its share row rather than the project, so
  -- both junctions join back through project_shares.
  SELECT t.organization_id, t.resource, t.scope, 'team', pst.team_id, ARRAY['read', 'use']::text[]
  FROM targets t
  JOIN project_shares ps ON ps.project_id = t.source_id
  JOIN project_share_team pst ON pst.share_id = ps.id
  JOIN team tm ON tm.id = pst.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource = 'project'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'user', psu.user_id, ARRAY['read', 'use']::text[]
  FROM targets t
  JOIN project_shares ps ON ps.project_id = t.source_id
  JOIN project_share_user psu ON psu.share_id = ps.id
  JOIN member m ON m.user_id = psu.user_id AND m.organization_id = t.organization_id
  WHERE t.resource = 'project'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'team', pt.team_id, ARRAY['read', 'use']::text[]
  FROM targets t JOIN plugin_team pt ON pt.plugin_id = t.source_id
  JOIN team tm ON tm.id = pt.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource = 'plugin'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'user', pu.user_id, ARRAY['read', 'use']::text[]
  FROM targets t JOIN plugin_user pu ON pu.plugin_id = t.source_id
  JOIN member m ON m.user_id = pu.user_id AND m.organization_id = t.organization_id
  WHERE t.resource = 'plugin'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'team', vt.team_id, ARRAY['read', 'use']::text[]
  FROM targets t JOIN virtual_api_key_team vt ON vt.virtual_api_key_id = t.source_id
  JOIN team tm ON tm.id = vt.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource = 'llmVirtualKey'
  UNION ALL
  -- A provider key carries its own recipient columns rather than a junction.
  SELECT t.organization_id, t.resource, t.scope, 'team', k.team_id, ARRAY['read', 'use']::text[]
  FROM targets t JOIN chat_api_keys k ON k.id = t.source_id
  JOIN team tm ON tm.id = k.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource = 'llmProviderApiKey' AND k.team_id IS NOT NULL
  UNION ALL
  -- Knowledge keeps its teams as a jsonb array on the row itself.
  SELECT t.organization_id, t.resource, t.scope, 'team', member_team.value, ARRAY['read', 'use']::text[]
  FROM targets t JOIN knowledge_bases kb ON kb.id = t.source_id
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(kb.team_ids, '[]'::jsonb)) AS member_team(value)
  JOIN team tm ON tm.id = member_team.value AND tm.organization_id = t.organization_id
  WHERE t.resource = 'knowledgeBase'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'team', member_team.value, ARRAY['read', 'use']::text[]
  FROM targets t JOIN knowledge_base_connectors kc ON kc.id = t.source_id
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(kc.team_ids, '[]'::jsonb)) AS member_team(value)
  JOIN team tm ON tm.id = member_team.value AND tm.organization_id = t.organization_id
  WHERE t.resource = 'knowledgeConnector'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'team', ft.team_id, ARRAY['read', 'use']::text[]
  FROM targets t JOIN kb_file_team ft ON ft.kb_file_id = t.source_id
  JOIN team tm ON tm.id = ft.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource = 'knowledgeFile'
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
`),
  // ---------------------------------------------------------------------
  // convertOrganizationWideAuthority
  // ---------------------------------------------------------------------
  sql.raw(`
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
`),
  // ---------------------------------------------------------------------
  // convertTeamRelativeAuthority
  // ---------------------------------------------------------------------
  sql.raw(`
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
`),
];

/** @public — read by resource-permissions-cutover.roles.test.ts */
export const ROLE_RETIREMENT_STATEMENTS = [
  // ---------------------------------------------------------------------
  // mergeEditorModelAuthority
  // ---------------------------------------------------------------------
  sql.raw(`
-- Preserve the built-in Editor's existing model-catalog authority. This is
-- distinct from role composition: unrelated action/scope pairs stay separate.
WITH policies AS (
  SELECT organization_id, grants,
    jsonb_build_object('subject', jsonb_build_object('type', 'role', 'id', 'editor'),
      'actions', (SELECT jsonb_agg(DISTINCT action ORDER BY action)
        FROM (SELECT jsonb_array_elements_text('["manage-permissions", "read", "update", "use"]'::jsonb) AS action
          UNION ALL
          SELECT jsonb_array_elements_text(g->'actions') FROM jsonb_array_elements(grants) g
          WHERE g->'subject'->>'type' = 'role' AND g->'subject'->>'id' = 'editor') actions)) AS editor_grant
  FROM resource_permission_policies WHERE resource = 'llmModel' AND scope = '*'
), merged AS (
  SELECT organization_id,
    (SELECT jsonb_agg(g ORDER BY g->'subject'->>'type', g->'subject'->>'id')
     FROM (SELECT value AS g FROM jsonb_array_elements(grants)
           WHERE NOT (value->'subject'->>'type' = 'role' AND value->'subject'->>'id' = 'editor')
           UNION ALL SELECT editor_grant) entries) AS grants
  FROM policies
)
UPDATE resource_permission_policies p SET grants = merged.grants,
  revision = p.revision + 1, updated_at = now()
FROM merged WHERE p.organization_id = merged.organization_id
  AND p.resource = 'llmModel' AND p.scope = '*' AND p.grants IS DISTINCT FROM merged.grants;
`),
  // ---------------------------------------------------------------------
  // convertAdminActionsToResourceGrants
  // ---------------------------------------------------------------------
  sql.raw(`
-- An \`X:admin\` role action said "this role reaches every X, whoever owns
-- it". That is a grant at \`*\` scope, so it becomes one here before the
-- action is retired below.
--
-- Doing it this way fixes what the action could never do: a role permission
-- snapshot is frozen when the role is created, so a custom role made before
-- an action existed could never gain it. A grant is a row, and can be given
-- to any role at any time.
--
-- Two names do not survive the move. \`knowledgeSource:admin\` governed three
-- kinds of object, which are three grant namespaces, so it fans out to all
-- three. \`mcpServerInstallation:admin\` was authority over registry entries,
-- which already convert as \`mcpRegistry\`, so it folds into that.
WITH holders AS (
  SELECT o.id AS organization_id, source.role_action, grantee.id AS role_id
  FROM organization o
  CROSS JOIN (VALUES
    ('project'), ('plugin'), ('llmVirtualKey'), ('llmProviderApiKey'),
    ('knowledgeSource'), ('scheduledTask'), ('log'), ('auditLog'),
    ('mcpServerInstallation')
  ) AS source(role_action)
  JOIN LATERAL (
    -- The built-in roles keep their permissions in code, not in this table,
    -- so they are named rather than queried. Only \`admin\` held the two log
    -- actions; \`platform_admin\` held the rest alongside it.
    SELECT unnest(CASE WHEN source.role_action IN ('log', 'auditLog')
      THEN ARRAY['admin'] ELSE ARRAY['admin', 'platform_admin'] END) AS id
    UNION
    SELECT roles.id FROM organization_role roles
    WHERE roles.organization_id = o.id
      AND COALESCE(roles.permission::jsonb -> source.role_action, '[]'::jsonb) ? 'admin'
  ) grantee ON true
), targeted AS (
  SELECT h.organization_id, mapped.resource, h.role_id,
    -- Reading rows someone else created is all the two log actions ever did.
    CASE WHEN mapped.resource IN ('log', 'auditLog')
      THEN ARRAY['read']
      ELSE ARRAY['read', 'use', 'update', 'delete', 'manage-permissions'] END AS actions
  FROM holders h
  CROSS JOIN LATERAL (
    SELECT unnest(CASE h.role_action
      WHEN 'knowledgeSource' THEN ARRAY['knowledgeBase', 'knowledgeConnector', 'knowledgeFile']
      WHEN 'mcpServerInstallation' THEN ARRAY['mcpRegistry']
      ELSE ARRAY[h.role_action] END) AS resource
  ) mapped
), merged AS (
  SELECT t.organization_id, t.resource,
    jsonb_agg(jsonb_build_object(
      'subject', jsonb_build_object('type', 'role', 'id', t.role_id),
      'actions', to_jsonb(t.actions)
    ) ORDER BY t.role_id) AS grants
  FROM targeted t GROUP BY t.organization_id, t.resource
)
INSERT INTO resource_permission_policies
  (organization_id, resource, scope, grants, revision, legacy_sharing_migrated, updated_at)
SELECT m.organization_id, m.resource, '*', m.grants, 1, true, now()
FROM merged m
ON CONFLICT (organization_id, resource, scope) DO UPDATE SET
  -- Merge: a grant written by hand on this policy is not discarded, and a
  -- role already listed keeps the union of both action sets.
  grants = (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'subject', entry.subject, 'actions', entry.actions) ORDER BY entry.subject->>'id'), '[]'::jsonb)
    FROM (
      SELECT g->'subject' AS subject,
        jsonb_agg(DISTINCT action ORDER BY action) AS actions
      FROM (
        SELECT jsonb_array_elements(resource_permission_policies.grants) AS g
        UNION ALL
        SELECT jsonb_array_elements(EXCLUDED.grants)
      ) all_grants
      CROSS JOIN LATERAL jsonb_array_elements_text(g->'actions') AS action
      GROUP BY g->'subject'
    ) entry
  ),
  revision = resource_permission_policies.revision + 1,
  legacy_sharing_migrated = true,
  updated_at = now();
`),
  // ---------------------------------------------------------------------
  // retireConvertedRoleActions
  // ---------------------------------------------------------------------
  sql.raw(`
-- 0485 already captured these flags as complete scoped grants. Retire the
-- obsolete role actions without changing unrelated permissions or role IDs.
WITH converted AS (
  SELECT r.id, COALESCE((
    SELECT jsonb_object_agg(resource, CASE
      WHEN resource IN (
        'agent', 'mcpGateway', 'mcpRegistry', 'skill', 'app',
        'project', 'plugin', 'llmVirtualKey', 'llmProviderApiKey',
        'knowledgeSource', 'scheduledTask', 'log', 'auditLog',
        'mcpServerInstallation'
      ) THEN
        COALESCE((SELECT jsonb_agg(action ORDER BY ordinal)
          FROM jsonb_array_elements(actions) WITH ORDINALITY AS items(action, ordinal)
          WHERE action NOT IN ('"admin"'::jsonb, '"team-admin"'::jsonb)), '[]'::jsonb)
      ELSE actions END)
    FROM jsonb_each(r.permission::jsonb) AS resources(resource, actions)
  ), '{}'::jsonb) AS permission
  FROM organization_role r
)
UPDATE organization_role r SET permission = converted.permission::text, updated_at = now()
FROM converted WHERE r.id = converted.id AND r.permission::jsonb IS DISTINCT FROM converted.permission;
`),
];
