// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  isResourcePermissionPreset,
  type ResourcePermissionGrant,
  ScopedResourceSchema,
  widenToPreset,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import db, { type Transaction } from "@/database";
import logger from "@/logging";

/**
 * Convert the retired visibility fields into grants, and retire the role
 * actions the grants replace.
 *
 * This runs at startup after schema migrations so existing resources and role
 * authority convert together in one transaction. Each policy imports legacy
 * authority only once, merges any existing grants, and then becomes the source
 * of truth. Later permission edits, including revocations, survive restarts.
 */
export async function runScopedResourcePermissionCutover(
  /** Join a caller's transaction, so a test can roll the whole thing back. */
  transaction?: Transaction,
): Promise<void> {
  const started = Date.now();
  const run = async (tx: Transaction) => {
    // A rolling restart can overlap another startup or a permission save on
    // an already-running replica. Serialize policy writes before reading the
    // grants to merge, so an upsert cannot restore a concurrently revoked
    // grant from its earlier statement snapshot. Reads remain available.
    await tx.execute(
      sql`LOCK TABLE resource_permission_policies IN SHARE ROW EXCLUSIVE MODE`,
    );
    for (const statement of [
      ...SHARING_CONVERSION_STATEMENTS,
      SESSION_SHARING_CONVERSION,
      ...ROLE_RETIREMENT_STATEMENTS,
    ])
      await tx.execute(statement);
    await widenGrantsToPresets(tx);
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
 * its retired `admin` flags stood for and then removes obsolete role flags.
 * Existing team-relative authority is captured as individual object grants.
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
-- next start. Organization-level authority is likewise imported only once.
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
  UNION ALL
  SELECT pl.organization_id, 'plugin', pl.id::text, pl.scope, pl.author_id, pl.id
  FROM plugins pl
  UNION ALL
  SELECT v.organization_id, 'llmVirtualKey', v.id::text, v.scope, v.author_id, v.id
  FROM virtual_api_keys v
  UNION ALL
  SELECT k.organization_id, 'llmProviderApiKey', k.id::text, k.scope, k.user_id, k.id
  FROM chat_api_keys k
  UNION ALL
  -- An OAuth client keeps its owner and audience in its metadata, because the
  -- row belongs to the OAuth provider's table. Only the two kinds the platform
  -- registers convert; a client that registered itself (dynamic registration,
  -- a client metadata document) is nobody's to share. A row written before
  -- scoping existed has no scope and was visible organization-wide.
  SELECT o.id,
    CASE c.metadata->>'type' WHEN 'mcp_oauth_client' THEN 'mcpOauthClient' ELSE 'llmOauthClient' END,
    c.id, COALESCE(c.metadata->>'scope', 'org'), c.metadata->>'authorId', c.id::uuid
  FROM oauth_client c JOIN organization o ON o.id = c.metadata->>'organizationId'
  WHERE c.metadata->>'type' IN ('mcp_oauth_client', 'llm_oauth_client')
    AND c.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  UNION ALL
  -- Knowledge objects carry no author column, so a private one converts to an
  -- object only an administrator reaches. The documents inside keep their own
  -- ACLs: an auto-sync connector resolves access from external groups per
  -- document, which no static grant can express.
  SELECT kb.organization_id, 'knowledgeBase', kb.id::text,
    CASE kb.visibility WHEN 'org-wide' THEN 'org' WHEN 'team-scoped' THEN 'team' ELSE 'personal' END,
    NULL::text, kb.id
  FROM knowledge_bases kb
  UNION ALL
  SELECT c.organization_id, 'knowledgeConnector', c.id::text,
    CASE c.visibility WHEN 'team-scoped' THEN 'team' ELSE 'org' END,
    NULL::text, c.id
  FROM knowledge_base_connectors c
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
  -- Named people convert whenever the junction names them, whatever the scope
  -- column says. An object can be team-scoped and still shared with a named
  -- person; reading the scope here would silently drop that person. Changing
  -- scope cleared the other kind of sharing, so a row here is always live.
  SELECT t.organization_id, t.resource, t.scope, 'user', au.user_id,
    CASE WHEN au.level = 'write' THEN ARRAY['read', 'use', 'update'] ELSE ARRAY['read', 'use'] END
  FROM targets t JOIN agent_user au ON au.agent_id = t.source_id
  JOIN member m ON m.user_id = au.user_id AND m.organization_id = t.organization_id
  WHERE t.resource IN ('agent', 'mcpGateway')
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'user', su.user_id,
    CASE WHEN su.level = 'write' THEN ARRAY['read', 'use', 'update'] ELSE ARRAY['read', 'use'] END
  FROM targets t JOIN skill_user su ON su.skill_id = t.source_id
  JOIN member m ON m.user_id = su.user_id AND m.organization_id = t.organization_id
  WHERE t.resource = 'skill'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'user', cu.user_id,
    CASE WHEN cu.level = 'write' THEN ARRAY['read', 'use', 'update'] ELSE ARRAY['read', 'use'] END
  FROM targets t JOIN mcp_catalog_user cu ON cu.catalog_id = t.source_id
  JOIN member m ON m.user_id = cu.user_id AND m.organization_id = t.organization_id
  WHERE t.resource IN ('mcpRegistry', 'app')
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
  -- Team members could see a team's OAuth clients; managing one took the
  -- retired team-admin action, which the team-relative statement below turns
  -- into grants for the people who held it.
  SELECT t.organization_id, t.resource, t.scope, 'team', ct.team_id, ARRAY['read']::text[]
  FROM targets t JOIN oauth_client_team ct ON ct.oauth_client_id = t.source_id::text
  JOIN team tm ON tm.id = ct.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource IN ('mcpOauthClient', 'llmOauthClient') AND t.visibility = 'team'
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
    t.visibility = 'org' AS legacy_organization_audience,
    COALESCE(jsonb_agg(jsonb_build_object('subject', jsonb_build_object('type', s.subject_type, 'id', s.subject_id), 'actions', s.actions)
      ORDER BY s.subject_type, s.subject_id) FILTER (WHERE s.subject_id IS NOT NULL), '[]'::jsonb) AS grants
  FROM targets t LEFT JOIN subjects s USING (organization_id, resource, scope)
  GROUP BY t.organization_id, t.resource, t.scope, t.visibility
)
INSERT INTO resource_permission_policies (organization_id, resource, scope, grants, legacy_sharing_migrated, legacy_organization_audience)
SELECT organization_id, resource, scope, grants, true, legacy_organization_audience FROM policies
ON CONFLICT (organization_id, resource, scope) DO UPDATE
SET grants = EXCLUDED.grants, legacy_sharing_migrated = true,
  legacy_organization_audience = EXCLUDED.legacy_organization_audience,
  revision = resource_permission_policies.revision + 1, updated_at = now()
WHERE NOT resource_permission_policies.legacy_sharing_migrated OR resource_permission_policies.grants IS DISTINCT FROM EXCLUDED.grants;
`),
  // ---------------------------------------------------------------------
  // materializeTeamRelativeAuthority
  // ---------------------------------------------------------------------
  sql.raw(`
-- The retired selector was an intersection: a matching role/user/team grant
-- AND a direct share with one of that user's effective teams. Snapshot that
-- intersection as individual grants, never as a team/role grant or wildcard.
-- Service accounts have no team subjects in the old resolver, so none qualify.
WITH RECURSIVE effective_teams(organization_id, user_id, team_id) AS (
  SELECT m.organization_id, m.user_id, t.id
  FROM member m JOIN team_member tm ON tm.user_id = m.user_id
  JOIN team t ON t.id = tm.team_id AND t.organization_id = m.organization_id
  UNION
  SELECT et.organization_id, et.user_id, parent.id
  FROM effective_teams et JOIN team child ON child.id = et.team_id
  JOIN team parent ON parent.id = child.parent_team_id AND parent.organization_id = et.organization_id
), role_identifiers AS (
  SELECT m.organization_id, m.user_id, trim(identifier) AS identifier
  FROM member m CROSS JOIN LATERAL unnest(string_to_array(m.role, ',')) identifier
  UNION
  SELECT et.organization_id, et.user_id, identifier
  FROM effective_teams et JOIN team t ON t.id = et.team_id
  CROSS JOIN LATERAL unnest(t.roles) identifier
), subjects AS (
  SELECT organization_id, user_id, 'user' AS subject_type, user_id AS subject_id FROM member
  UNION
  SELECT organization_id, user_id, 'organization', '*' FROM member
  UNION
  SELECT organization_id, user_id, 'team', team_id FROM effective_teams
  UNION
  SELECT organization_id, user_id, 'role', identifier FROM role_identifiers
  WHERE identifier IN ('admin', 'platform_admin', 'editor', 'member')
  UNION
  SELECT r.organization_id, r.user_id, 'role', custom.id
  FROM role_identifiers r JOIN organization_role custom
    ON custom.organization_id = r.organization_id AND custom.role = r.identifier
), legacy_resources AS (
  SELECT o.id AS organization_id, r.resource
  -- The built-in editor held team-admin on these, OAuth clients included.
  FROM organization o CROSS JOIN (VALUES ('agent'), ('mcpGateway'), ('skill'), ('app'),
    ('mcpOauthClient'), ('llmOauthClient')) r(resource)
  WHERE NOT EXISTS (
    SELECT 1 FROM resource_permission_policies p
    WHERE p.organization_id = o.id AND p.resource = r.resource
      AND p.scope = 'teams:*' AND p.legacy_sharing_migrated
  ) AND (
    EXISTS (SELECT 1 FROM resource_permission_policies p
      WHERE p.organization_id = o.id AND p.resource = r.resource AND p.scope = 'teams:*')
    OR NOT EXISTS (SELECT 1 FROM resource_permission_policies p
      WHERE p.organization_id = o.id AND p.resource = r.resource AND p.scope = '*' AND p.legacy_sharing_migrated)
  )
), relative_entries AS (
  SELECT p.organization_id, p.resource, g->'subject'->>'type' AS subject_type,
    g->'subject'->>'id' AS subject_id, action
  FROM resource_permission_policies p CROSS JOIN LATERAL jsonb_array_elements(p.grants) g
  CROSS JOIN LATERAL jsonb_array_elements_text(g->'actions') action
  WHERE p.scope = 'teams:*'
  UNION
  SELECT r.organization_id, r.resource, 'role', 'editor', action
  FROM legacy_resources r
  CROSS JOIN unnest(ARRAY['read', 'use', 'update', 'delete', 'manage-permissions']) action
  UNION
  SELECT r.organization_id, r.resource, 'role', custom.id, action
  FROM legacy_resources r JOIN organization_role custom ON custom.organization_id = r.organization_id
  CROSS JOIN LATERAL (
    SELECT action FROM jsonb_array_elements_text(COALESCE(custom.permission::jsonb->r.resource, '[]'::jsonb)) action
    WHERE action IN ('read', 'update', 'delete')
    UNION SELECT 'use' WHERE COALESCE(custom.permission::jsonb->r.resource, '[]'::jsonb) ? 'read'
    UNION SELECT 'manage-permissions' WHERE COALESCE(custom.permission::jsonb->r.resource, '[]'::jsonb) ? 'update'
  ) actions
  WHERE COALESCE(custom.permission::jsonb->r.resource, '[]'::jsonb) ? 'team-admin'
    AND NOT COALESCE(custom.permission::jsonb->r.resource, '[]'::jsonb) ? 'admin'
), objects AS (
  -- Validate policy scopes against retained object rows. Deleted rows retain
  -- their policy for restoration; orphaned/foreign policy documents do not
  -- manufacture grants. Global models/catalog entries remain org-local here.
  SELECT organization_id, CASE WHEN agent_type = 'mcp_gateway' THEN 'mcpGateway' ELSE 'agent' END AS resource, id::text AS scope
  FROM agents WHERE agent_type IN ('agent', 'profile', 'mcp_gateway')
  UNION SELECT organization_id, 'skill', id::text FROM skills
  UNION SELECT o.id, 'mcpRegistry', c.id::text FROM internal_mcp_catalog c
    JOIN organization o ON c.organization_id = o.id OR c.organization_id IS NULL
    WHERE c.id NOT IN ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')
      AND c.server_type <> 'app' AND c.parent_catalog_item_id IS NULL
  UNION SELECT a.organization_id, 'app', a.id::text FROM apps a
    JOIN mcp_server s ON s.id = a.mcp_server_id JOIN internal_mcp_catalog c ON c.id = s.catalog_id
    WHERE c.organization_id = a.organization_id OR c.organization_id IS NULL
  UNION SELECT o.id, 'llmModel', m.id::text FROM models m CROSS JOIN organization o
  UNION SELECT organization_id, 'project', id::text FROM projects
  UNION SELECT organization_id, 'plugin', id::text FROM plugins
  UNION SELECT organization_id, 'llmVirtualKey', id::text FROM virtual_api_keys
  UNION SELECT organization_id, 'llmProviderApiKey', id::text FROM chat_api_keys
  UNION SELECT organization_id, 'knowledgeBase', id::text FROM knowledge_bases
  UNION SELECT organization_id, 'knowledgeConnector', id::text FROM knowledge_base_connectors
  UNION SELECT organization_id, 'knowledgeFile', id::text FROM kb_files
  UNION SELECT organization_id, 'environment', id::text FROM environments
  UNION SELECT organization_id, 'serviceAccount', id::text FROM service_accounts
  UNION SELECT metadata->>'organizationId',
    CASE metadata->>'type' WHEN 'mcp_oauth_client' THEN 'mcpOauthClient' ELSE 'llmOauthClient' END, id
  FROM oauth_client WHERE metadata->>'type' IN ('mcp_oauth_client', 'llm_oauth_client')
), anchored AS (
  SELECT DISTINCT p.organization_id, p.resource, p.scope, et.user_id
  FROM resource_permission_policies p JOIN objects o USING (organization_id, resource, scope)
  CROSS JOIN LATERAL jsonb_array_elements(p.grants) g
  JOIN effective_teams et ON et.organization_id = p.organization_id
    AND g->'subject'->>'type' = 'team' AND et.team_id = g->'subject'->>'id'
), materialized AS (
  SELECT DISTINCT a.organization_id, a.resource, a.scope, a.user_id, r.action
  FROM anchored a JOIN subjects s ON s.organization_id = a.organization_id AND s.user_id = a.user_id
  JOIN relative_entries r ON r.organization_id = a.organization_id AND r.resource = a.resource
    AND r.subject_type = s.subject_type AND r.subject_id = s.subject_id
), affected AS (
  SELECT DISTINCT organization_id, resource, scope FROM materialized
), entries AS (
  SELECT organization_id, resource, scope, 'user' AS subject_type, user_id AS subject_id, action FROM materialized
  UNION ALL
  SELECT p.organization_id, p.resource, p.scope, g->'subject'->>'type', g->'subject'->>'id', action
  FROM resource_permission_policies p JOIN affected USING (organization_id, resource, scope)
  CROSS JOIN LATERAL jsonb_array_elements(p.grants) g
  CROSS JOIN LATERAL jsonb_array_elements_text(g->'actions') action
), merged_subjects AS (
  SELECT organization_id, resource, scope, subject_type, subject_id, jsonb_agg(DISTINCT action ORDER BY action) AS actions
  FROM entries GROUP BY organization_id, resource, scope, subject_type, subject_id
), merged AS (
  SELECT organization_id, resource, scope,
    jsonb_agg(jsonb_build_object('subject', jsonb_build_object('type', subject_type, 'id', subject_id), 'actions', actions)
      ORDER BY subject_type, subject_id) AS grants
  FROM merged_subjects GROUP BY organization_id, resource, scope
)
UPDATE resource_permission_policies p SET grants = merged.grants,
  revision = p.revision + 1, updated_at = now()
FROM merged WHERE p.organization_id = merged.organization_id AND p.resource = merged.resource
  AND p.scope = merged.scope AND p.grants IS DISTINCT FROM merged.grants;
`),
  // Consuming the source policy and the wildcard migration marker make this
  // snapshot one-time. A later revocation cannot be restored at startup.
  sql`DELETE FROM resource_permission_policies WHERE scope = 'teams:*'`,
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
  WHERE NOT EXISTS (
    SELECT 1 FROM resource_permission_policies p
    WHERE p.organization_id = o.id AND p.resource = r.resource
      AND p.scope = '*' AND p.legacy_sharing_migrated
  )
  UNION ALL
  -- Editor's model-catalog authority also belongs in the first conversion.
  -- Re-adding it on every restart would undo an explicit wildcard revocation.
  SELECT o.id, 'llmModel', 'editor', action
  FROM organization o
  CROSS JOIN unnest(ARRAY['read', 'use', 'update', 'manage-permissions']) action
  WHERE NOT EXISTS (
    SELECT 1 FROM resource_permission_policies p
    WHERE p.organization_id = o.id AND p.resource = 'llmModel'
      AND p.scope = '*' AND p.legacy_sharing_migrated
  )
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
    UNION
    SELECT 'use' WHERE r.resource = 'mcpRegistry' AND COALESCE(roles.permission::jsonb->'mcpServerInstallation', '[]'::jsonb) ? 'create'
  ) expanded
  WHERE CASE
    WHEN r.resource = 'mcpRegistry' THEN COALESCE(roles.permission::jsonb->'mcpServerInstallation', '[]'::jsonb) ? 'admin'
    WHEN r.resource = 'llmModel' THEN COALESCE(roles.permission::jsonb->'llmModel', '[]'::jsonb) ? 'update'
    ELSE COALESCE(roles.permission::jsonb->r.resource, '[]'::jsonb) ? 'admin'
  END
  AND NOT EXISTS (
    SELECT 1 FROM resource_permission_policies p
    WHERE p.organization_id = roles.organization_id AND p.resource = r.resource
      AND p.scope = '*' AND p.legacy_sharing_migrated
  )
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
  // convertServiceAccountAuthority
  // ---------------------------------------------------------------------
  sql.raw(`
-- A service account is the one scoped resource with no audience of its own.
-- It has no scope column, no team junction and no named-user list: the
-- organization owns every one of them, and who could reach one was decided
-- entirely by the caller's \`serviceAccount\` role actions. So there is no
-- per-object visibility to convert, and this statement converts the role
-- actions instead — which is the same rule the organization-wide statements
-- above apply, one grant per role that holds the action, never a grant to
-- everyone.
--
-- Writing it at \`*\` rather than onto each account is a decision, not an
-- omission: DO NOT "complete" this by backfilling a policy per account.
--
-- Copying these role grants onto every account would put a row on each
-- account's Permissions tab that cannot be revoked there. Deleting it would
-- leave the identical \`*\` grant still deciding, so the account would carry on
-- answering to a role the tab has just been told to drop. That is a
-- correctness trap, not untidiness. At \`*\` the same rows show as inherited,
-- which is what they are, revocable at the one place that governs them, and a
-- per-object grant added in the editor layers on top.
--
-- Independently: \`*\` also covers accounts created after the upgrade, which a
-- per-object backfill cannot reach at all.
WITH role_actions AS (
  -- The built-in roles keep their permissions in code rather than in this
  -- table, so they are named. Only the two admin tiers carry any
  -- \`serviceAccount\` action; editor and member carry none.
  SELECT o.id AS organization_id, builtin.id AS subject_id,
    unnest(ARRAY['read', 'use', 'update', 'delete', 'manage-permissions']) AS action
  FROM organization o
  CROSS JOIN (VALUES ('admin'), ('platform_admin')) builtin(id)
  WHERE NOT EXISTS (
    SELECT 1 FROM resource_permission_policies p
    WHERE p.organization_id = o.id AND p.resource = 'serviceAccount'
      AND p.scope = '*' AND p.legacy_sharing_migrated
  )
  UNION ALL
  SELECT roles.organization_id, roles.id, expanded.action
  FROM organization_role roles
  CROSS JOIN LATERAL (
    SELECT action FROM jsonb_array_elements_text(
      COALESCE(roles.permission::jsonb->'serviceAccount', '[]'::jsonb)) action
    WHERE action IN ('read', 'update', 'delete')
    UNION
    SELECT 'use' WHERE COALESCE(roles.permission::jsonb->'serviceAccount', '[]'::jsonb) ? 'read'
    UNION
    SELECT 'manage-permissions' WHERE COALESCE(roles.permission::jsonb->'serviceAccount', '[]'::jsonb) ? 'update'
  ) expanded
  WHERE NOT EXISTS (
    SELECT 1 FROM resource_permission_policies p
    WHERE p.organization_id = roles.organization_id AND p.resource = 'serviceAccount'
      AND p.scope = '*' AND p.legacy_sharing_migrated
  )
), entries AS (
  -- Merged rather than replaced, so a grant written by hand in the editor
  -- survives a re-run, and compared against what is stored rather than written
  -- unconditionally, so a re-run that changes nothing does not raise the
  -- revision the editor holds while somebody is editing.
  SELECT organization_id, 'role' AS subject_type, subject_id, action FROM role_actions
  UNION ALL
  SELECT p.organization_id, g->'subject'->>'type', g->'subject'->>'id', action
  FROM resource_permission_policies p
  CROSS JOIN LATERAL jsonb_array_elements(p.grants) g
  CROSS JOIN LATERAL jsonb_array_elements_text(g->'actions') action
  WHERE p.resource = 'serviceAccount' AND p.scope = '*'
), subjects AS (
  SELECT organization_id, subject_type, subject_id,
    jsonb_agg(DISTINCT action ORDER BY action) AS actions
  FROM entries GROUP BY organization_id, subject_type, subject_id
), policies AS (
  SELECT organization_id,
    jsonb_agg(jsonb_build_object('subject', jsonb_build_object('type', subject_type, 'id', subject_id), 'actions', actions)
      ORDER BY subject_type, subject_id) AS grants
  FROM subjects GROUP BY organization_id
)
INSERT INTO resource_permission_policies (organization_id, resource, scope, grants, legacy_sharing_migrated)
SELECT organization_id, 'serviceAccount', '*', grants, true FROM policies
ON CONFLICT (organization_id, resource, scope) DO UPDATE
SET grants = EXCLUDED.grants, legacy_sharing_migrated = true, revision = resource_permission_policies.revision + 1, updated_at = now()
WHERE NOT resource_permission_policies.legacy_sharing_migrated OR resource_permission_policies.grants IS DISTINCT FROM EXCLUDED.grants;
`),
];

/** @public — read by resource-permissions-cutover.roles.test.ts */
export const ROLE_RETIREMENT_STATEMENTS = [
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
-- three. Registry authority was already converted above from the catalog
-- actions plus the installation admin flag; importing that flag again here
-- would manufacture actions a read-only catalog administrator never held.
WITH holders AS (
  SELECT o.id AS organization_id, source.role_action, grantee.id AS role_id
  FROM organization o
  CROSS JOIN (VALUES
    ('project'), ('plugin'), ('llmVirtualKey'), ('llmProviderApiKey'),
    ('knowledgeSource'), ('scheduledTask'), ('log'), ('auditLog'),
    ('mcpOauthClient'), ('llmOauthClient')
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
    -- Log viewers keep read-only access. The built-in admin also needs to
    -- delegate that access now that the old role action has been retired.
    ARRAY(
      SELECT action FROM unnest(CASE
        WHEN mapped.resource IN ('log', 'auditLog') AND h.role_id = 'admin'
          THEN ARRAY['read', 'manage-permissions']
        WHEN mapped.resource IN ('log', 'auditLog') THEN ARRAY['read']
        ELSE ARRAY['read', 'use', 'update', 'delete', 'manage-permissions'] END) action
      WHERE h.role_id IN ('admin', 'platform_admin') OR EXISTS (
        -- The old admin flag widened scope, while the ordinary role actions
        -- still gated CRUD. Preserve both halves for custom roles.
        SELECT 1 FROM organization_role roles
        WHERE roles.organization_id = h.organization_id AND roles.id = h.role_id
          AND COALESCE(roles.permission::jsonb->h.role_action, '[]'::jsonb)
            ? CASE action WHEN 'use' THEN 'read' WHEN 'manage-permissions' THEN 'update' ELSE action END
      )
    ) AS actions
  FROM holders h
  CROSS JOIN LATERAL (
    SELECT unnest(CASE h.role_action
      WHEN 'knowledgeSource' THEN ARRAY['knowledgeBase', 'knowledgeConnector', 'knowledgeFile']
      ELSE ARRAY[h.role_action] END) AS resource
  ) mapped
  WHERE NOT EXISTS (
    SELECT 1 FROM resource_permission_policies p
    WHERE p.organization_id = h.organization_id AND p.resource = mapped.resource
      AND p.scope = '*' AND p.legacy_sharing_migrated
  ) OR EXISTS (
    -- A custom role's old admin flag still needs converting on this first
    -- pass even if an earlier stage already created the wildcard policy.
    SELECT 1 FROM organization_role roles
    WHERE roles.organization_id = h.organization_id AND roles.id = h.role_id
      AND COALESCE(roles.permission::jsonb->h.role_action, '[]'::jsonb) ? 'admin'
  )
), entries AS (
  -- Merge: a grant written by hand on this policy is not discarded, and a
  -- role already listed keeps the union of both action sets. The merge
  -- happens here rather than in the conflict clause so the row that would be
  -- written can be compared with the row already stored. Merging inside
  -- a conflict clause writes unconditionally, and this statement runs at
  -- every start, so it raised the revision of every policy on every boot.
  -- The revision is the token the permissions editor holds while somebody
  -- edits, so each restart failed their save for no reason.
  SELECT organization_id, resource, 'role' AS subject_type, role_id AS subject_id,
    unnest(actions) AS action
  FROM targeted
  UNION ALL
  SELECT p.organization_id, p.resource, g->'subject'->>'type', g->'subject'->>'id', action
  FROM resource_permission_policies p
  CROSS JOIN LATERAL jsonb_array_elements(p.grants) g
  CROSS JOIN LATERAL jsonb_array_elements_text(g->'actions') action
  WHERE p.scope = '*'
    AND (p.organization_id, p.resource) IN (SELECT organization_id, resource FROM targeted)
), subjects AS (
  SELECT organization_id, resource, subject_type, subject_id,
    jsonb_agg(DISTINCT action ORDER BY action) AS actions
  FROM entries GROUP BY organization_id, resource, subject_type, subject_id
), merged AS (
  -- Ordered the same way as every other statement here. The two halves of the
  -- old merge disagreed on ordering, so the stored array could reshuffle
  -- between runs and read as a change even when the grants were identical.
  SELECT organization_id, resource,
    jsonb_agg(jsonb_build_object(
      'subject', jsonb_build_object('type', subject_type, 'id', subject_id),
      'actions', actions
    ) ORDER BY subject_type, subject_id) AS grants
  FROM subjects GROUP BY organization_id, resource
)
INSERT INTO resource_permission_policies
  (organization_id, resource, scope, grants, revision, legacy_sharing_migrated, updated_at)
SELECT m.organization_id, m.resource, '*', m.grants, 1, true, now()
FROM merged m
ON CONFLICT (organization_id, resource, scope) DO UPDATE SET
  grants = EXCLUDED.grants,
  revision = resource_permission_policies.revision + 1,
  legacy_sharing_migrated = true,
  updated_at = now()
WHERE NOT resource_permission_policies.legacy_sharing_migrated
  OR resource_permission_policies.grants IS DISTINCT FROM EXCLUDED.grants;
`),
  // Only the untouched, revision-one seed from the earlier cutover is
  // recognizable as an omission rather than a revocation. Customized or
  // subsequently edited policies are deliberately outside this repair.
  sql.raw(`
UPDATE resource_permission_policies SET
  grants = '[{"subject":{"type":"role","id":"admin"},"actions":["delete","manage-permissions","read","update","use"]},{"subject":{"type":"role","id":"editor"},"actions":["read","use"]},{"subject":{"type":"role","id":"platform_admin"},"actions":["delete","manage-permissions","read","update","use"]}]'::jsonb,
  revision = revision + 1, updated_at = now()
WHERE resource = 'environment' AND scope = '*' AND legacy_sharing_migrated AND revision = 1
  AND grants = '[{"subject":{"type":"role","id":"admin"},"actions":["read","use"]},{"subject":{"type":"role","id":"editor"},"actions":["read","use"]},{"subject":{"type":"role","id":"platform_admin"},"actions":["read","use"]}]'::jsonb;
`),
  // ---------------------------------------------------------------------
  // convertDeployToRestrictedToEnvironmentGrants
  // ---------------------------------------------------------------------
  sql.raw(`
-- Deploying into a restricted environment was six role actions — one per kind
-- of thing deployed — and not one of them could name an environment. It
-- becomes \`use\` on the environment instead, which is where the authority
-- always belonged: an environment is a place you deploy into.
--
-- The conversion grants it at \`*\`, because that is exactly the reach the
-- retired actions had: holding \`agent:deploy-to-restricted\` unlocked EVERY
-- restricted environment in the organization, never a named one. Nobody who
-- could deploy loses the ability. The one widening is a hand-authored role
-- that held a strict subset of the six: it could deploy some kinds of object
-- and not others, and that distinction does not survive the move. Every
-- built-in role is all-or-nothing (admin, platform_admin and editor held all
-- six; member held none), so a deployment on stock roles converts exactly.
--
-- Naming ONE environment is possible from here on, which the retired actions
-- could never express.
WITH holders AS (
  SELECT o.id AS organization_id, grantee.id AS role_id
  FROM organization o
  JOIN LATERAL (
    -- Built-in roles keep their permissions in code, not in this table.
    SELECT unnest(ARRAY['admin', 'platform_admin', 'editor']) AS id
    UNION
    SELECT roles.id FROM organization_role roles
    WHERE roles.organization_id = o.id
      AND EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'agent', 'skill', 'app', 'mcpGateway', 'mcpRegistry', 'knowledgeSource'
        ]) AS deployable(resource)
        WHERE COALESCE(roles.permission::jsonb -> deployable.resource, '[]'::jsonb)
          ? 'deploy-to-restricted'
      )
  ) grantee ON true
  WHERE NOT EXISTS (
    SELECT 1 FROM resource_permission_policies p
    WHERE p.organization_id = o.id AND p.resource = 'environment'
      AND p.scope = '*' AND p.legacy_sharing_migrated
  ) OR EXISTS (
    SELECT 1 FROM organization_role roles
    WHERE roles.organization_id = o.id AND roles.id = grantee.id
      AND EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'agent', 'skill', 'app', 'mcpGateway', 'mcpRegistry', 'knowledgeSource'
        ]) AS deployable(resource)
        WHERE COALESCE(roles.permission::jsonb->deployable.resource, '[]'::jsonb)
          ? 'deploy-to-restricted'
      )
  )
), entries AS (
  -- Merge rather than replace, and compare before writing: this runs at every
  -- start, and an unconditional write would raise the revision the permissions
  -- editor holds while somebody is editing.
  SELECT organization_id, 'role' AS subject_type, role_id AS subject_id,
    unnest(CASE WHEN role_id IN ('admin', 'platform_admin')
      THEN ARRAY['read', 'use', 'update', 'delete', 'manage-permissions']
      ELSE ARRAY['read', 'use'] END) AS action
  FROM holders
  UNION ALL
  SELECT p.organization_id, g->'subject'->>'type', g->'subject'->>'id', action
  FROM resource_permission_policies p
  CROSS JOIN LATERAL jsonb_array_elements(p.grants) g
  CROSS JOIN LATERAL jsonb_array_elements_text(g->'actions') action
  WHERE p.resource = 'environment' AND p.scope = '*'
), subjects AS (
  SELECT organization_id, subject_type, subject_id,
    jsonb_agg(DISTINCT action ORDER BY action) AS actions
  FROM entries GROUP BY organization_id, subject_type, subject_id
), merged AS (
  -- Ordered like every other statement here, so the stored array cannot
  -- reshuffle between runs and read as a change when nothing changed.
  SELECT organization_id,
    jsonb_agg(jsonb_build_object(
      'subject', jsonb_build_object('type', subject_type, 'id', subject_id),
      'actions', actions
    ) ORDER BY subject_type, subject_id) AS grants
  FROM subjects GROUP BY organization_id
)
INSERT INTO resource_permission_policies
  (organization_id, resource, scope, grants, revision, legacy_sharing_migrated, updated_at)
SELECT organization_id, 'environment', '*', grants, 1, true, now() FROM merged
ON CONFLICT (organization_id, resource, scope) DO UPDATE SET
  grants = EXCLUDED.grants,
  revision = resource_permission_policies.revision + 1,
  legacy_sharing_migrated = true,
  updated_at = now()
WHERE NOT resource_permission_policies.legacy_sharing_migrated
  OR resource_permission_policies.grants IS DISTINCT FROM EXCLUDED.grants;
`),
  // ---------------------------------------------------------------------
  // convertReadAllToConversationGrants
  // ---------------------------------------------------------------------
  sql.raw(`
-- \`project:read-all\` let a role read chats other members started inside a
-- project the reader could open. It becomes \`read\` on every chat, a grant at
-- \`*\` on \`conversation\`, which is consulted only for chats inside a
-- project the reader can open, so it reaches exactly what the action did.
-- The built-in admin and platform_admin roles held the action in code; a
-- custom role held it in its stored permissions. Editor and member never did.
WITH holders AS (
  SELECT o.id AS organization_id, builtin.id AS role_id
  FROM organization o CROSS JOIN (VALUES ('admin'), ('platform_admin')) builtin(id)
  WHERE NOT EXISTS (
    SELECT 1 FROM resource_permission_policies p
    WHERE p.organization_id = o.id AND p.resource = 'conversation'
      AND p.scope = '*' AND p.legacy_sharing_migrated
  )
  UNION
  SELECT roles.organization_id, roles.id FROM organization_role roles
  WHERE COALESCE(roles.permission::jsonb -> 'project', '[]'::jsonb) ? 'read-all'
), entries AS (
  -- Merge rather than replace, and compare before writing: this runs at every
  -- start, and an unconditional write would raise the revision the permissions
  -- editor holds while somebody is editing.
  -- The admin-tier roles also manage the grant, so they can still assign
  -- roles that carry it: delegating a grant takes managing it.
  SELECT organization_id, 'role' AS subject_type, role_id AS subject_id,
    unnest(CASE WHEN role_id IN ('admin', 'platform_admin')
      THEN ARRAY['read', 'manage-permissions'] ELSE ARRAY['read'] END) AS action
  FROM holders
  UNION ALL
  SELECT p.organization_id, g->'subject'->>'type', g->'subject'->>'id', action
  FROM resource_permission_policies p
  CROSS JOIN LATERAL jsonb_array_elements(p.grants) g
  CROSS JOIN LATERAL jsonb_array_elements_text(g->'actions') action
  WHERE p.resource = 'conversation' AND p.scope = '*'
    AND p.organization_id IN (SELECT organization_id FROM holders)
), subjects AS (
  SELECT organization_id, subject_type, subject_id,
    jsonb_agg(DISTINCT action ORDER BY action) AS actions
  FROM entries GROUP BY organization_id, subject_type, subject_id
), merged AS (
  SELECT organization_id,
    jsonb_agg(jsonb_build_object(
      'subject', jsonb_build_object('type', subject_type, 'id', subject_id),
      'actions', actions
    ) ORDER BY subject_type, subject_id) AS grants
  FROM subjects GROUP BY organization_id
)
INSERT INTO resource_permission_policies
  (organization_id, resource, scope, grants, revision, legacy_sharing_migrated, updated_at)
SELECT organization_id, 'conversation', '*', grants, 1, true, now() FROM merged
ON CONFLICT (organization_id, resource, scope) DO UPDATE SET
  grants = EXCLUDED.grants,
  revision = resource_permission_policies.revision + 1,
  legacy_sharing_migrated = true,
  updated_at = now()
WHERE NOT resource_permission_policies.legacy_sharing_migrated
  OR resource_permission_policies.grants IS DISTINCT FROM EXCLUDED.grants;
`),
  // ---------------------------------------------------------------------
  // retireConvertedRoleActions
  // ---------------------------------------------------------------------
  sql.raw(`
-- Earlier statements captured admin, deployment and project read-all
-- authority as scoped grants. Team-admin authority was captured as individual
-- object grants before these flags retire. \`project:share-org\` converts to
-- nothing: sharing a project with the organization is a grant written by
-- whoever manages the project's permissions, and its holders already hold
-- their project grants. Preserve unrelated permissions and role IDs.
WITH converted AS (
  SELECT r.id, COALESCE((
    SELECT jsonb_object_agg(resource, CASE
      WHEN resource IN (
        'agent', 'mcpGateway', 'mcpRegistry', 'skill', 'app',
        'project', 'plugin', 'llmVirtualKey', 'llmProviderApiKey',
        'knowledgeSource', 'scheduledTask', 'log', 'auditLog',
        'mcpServerInstallation', 'mcpOauthClient', 'llmOauthClient'
      ) THEN
        COALESCE((SELECT jsonb_agg(action ORDER BY ordinal)
          FROM jsonb_array_elements(actions) WITH ORDINALITY AS items(action, ordinal)
          WHERE action NOT IN (
            '"admin"'::jsonb, '"team-admin"'::jsonb, '"deploy-to-restricted"'::jsonb,
            '"read-all"'::jsonb, '"share-org"'::jsonb
          )), '[]'::jsonb)
      ELSE actions END)
    FROM jsonb_each(r.permission::jsonb) AS resources(resource, actions)
  ), '{}'::jsonb) AS permission
  FROM organization_role r
)
UPDATE organization_role r SET permission = converted.permission::text, updated_at = now()
FROM converted WHERE r.id = converted.id AND r.permission::jsonb IS DISTINCT FROM converted.permission;
`),
];

// Session shares grant output visibility, never the owner's credentials or write authority.
const SESSION_SHARING_CONVERSION = sql.raw(`
WITH targets AS (
  SELECT c.organization_id, 'conversation' AS resource, c.id::text AS scope,
    c.user_id AS owner_id, c.locked_chat AS locked, s.id AS share_id, s.visibility::text
  FROM conversations c LEFT JOIN conversation_shares s
    ON s.conversation_id = c.id AND s.organization_id = c.organization_id
  UNION ALL
  SELECT r.organization_id, 'agentRun', r.task_id::text, r.actor_user_id,
    false, s.id, s.visibility::text
  FROM agent_runs r LEFT JOIN agent_run_shares s
    ON s.task_id = r.task_id AND s.organization_id = r.organization_id
), pending AS (
  SELECT t.* FROM targets t WHERE NOT EXISTS (
    SELECT 1 FROM resource_permission_policies p
    WHERE p.organization_id = t.organization_id AND p.resource = t.resource
      AND p.scope = t.scope AND p.legacy_sharing_migrated
  )
), entries AS (
  SELECT t.organization_id, t.resource, t.scope, 'user' AS subject_type,
    t.owner_id AS subject_id, unnest(ARRAY['read', 'manage-permissions']) AS action
  FROM pending t WHERE t.owner_id IS NOT NULL
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'organization', '*', 'read'
  FROM pending t WHERE t.visibility = 'organization' AND NOT t.locked
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'team', st.team_id, 'read'
  FROM pending t JOIN conversation_share_team st ON st.share_id = t.share_id
    JOIN team tm ON tm.id = st.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource = 'conversation' AND t.visibility = 'team' AND NOT t.locked
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'user', su.user_id, 'read'
  FROM pending t JOIN conversation_share_user su ON su.share_id = t.share_id
  WHERE t.resource = 'conversation' AND t.visibility = 'user' AND NOT t.locked
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'team', st.team_id, 'read'
  FROM pending t JOIN agent_run_share_team st ON st.share_id = t.share_id
    JOIN team tm ON tm.id = st.team_id AND tm.organization_id = t.organization_id
  WHERE t.resource = 'agentRun' AND t.visibility = 'team'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope, 'user', su.user_id, 'read'
  FROM pending t JOIN agent_run_share_user su ON su.share_id = t.share_id
  WHERE t.resource = 'agentRun' AND t.visibility = 'user'
  UNION ALL
  SELECT t.organization_id, t.resource, t.scope,
    g->'subject'->>'type', g->'subject'->>'id', a
  FROM pending t JOIN resource_permission_policies p
    ON p.organization_id = t.organization_id AND p.resource = t.resource AND p.scope = t.scope,
    jsonb_array_elements(p.grants) g, jsonb_array_elements_text(g->'actions') a
), grouped AS (
  SELECT organization_id, resource, scope, subject_type, subject_id,
    jsonb_agg(DISTINCT action ORDER BY action) AS actions
  FROM entries GROUP BY organization_id, resource, scope, subject_type, subject_id
), policies AS (
  SELECT organization_id, resource, scope,
    jsonb_agg(jsonb_build_object('subject', jsonb_build_object('type', subject_type, 'id', subject_id), 'actions', actions)
      ORDER BY subject_type, subject_id) AS grants
  FROM grouped GROUP BY organization_id, resource, scope
)
INSERT INTO resource_permission_policies (organization_id, resource, scope, grants, legacy_sharing_migrated)
SELECT t.organization_id, t.resource, t.scope, coalesce(p.grants, '[]'::jsonb), true
FROM pending t LEFT JOIN policies p USING (organization_id, resource, scope)
ON CONFLICT (organization_id, resource, scope) DO UPDATE
-- Compare before writing, as every other statement here does. A row left
-- unmigrated by an earlier pass may already hold exactly these grants; it only
-- needs marking, and raising its revision would fail a save the permissions
-- editor is holding it for.
SET grants = EXCLUDED.grants, legacy_sharing_migrated = true,
  revision = CASE WHEN resource_permission_policies.grants IS DISTINCT FROM EXCLUDED.grants
    THEN resource_permission_policies.revision + 1
    ELSE resource_permission_policies.revision END,
  updated_at = CASE WHEN resource_permission_policies.grants IS DISTINCT FROM EXCLUDED.grants
    THEN now() ELSE resource_permission_policies.updated_at END
WHERE NOT resource_permission_policies.legacy_sharing_migrated
  OR resource_permission_policies.grants IS DISTINCT FROM EXCLUDED.grants;
`);

/**
 * The last pass: every grant becomes one preset of its resource.
 *
 * The conversion carries each legacy shape over exactly, and some of those
 * shapes sit between two presets. Each widens to the smaller preset that holds
 * it — `use` alone gains `read`, and a set with `manage-permissions` but not
 * `delete` gains `delete`. Only the policies that change are written, so a
 * second run writes nothing.
 *
 * @public — read by the cutover tests
 */
export async function widenGrantsToPresets(tx: Transaction): Promise<void> {
  const result = await tx.execute<{
    organization_id: string;
    resource: string;
    scope: string;
    grants: ResourcePermissionGrant[];
  }>(
    sql`SELECT organization_id, resource, scope, grants FROM resource_permission_policies`,
  );
  let widened = 0;
  for (const policy of result.rows) {
    const resource = ScopedResourceSchema.safeParse(policy.resource);
    if (!resource.success) continue;
    if (
      policy.grants.every((grant) =>
        isResourcePermissionPreset(grant.actions, resource.data),
      )
    )
      continue;
    const grants = policy.grants
      .map((grant) =>
        isResourcePermissionPreset(grant.actions, resource.data)
          ? grant
          : {
              ...grant,
              actions: widenToPreset(grant.actions, resource.data).sort(),
            },
      )
      .filter((grant) => grant.actions.length);
    await tx.execute(sql`
      UPDATE resource_permission_policies
      SET grants = ${JSON.stringify(grants)}::jsonb,
        revision = revision + 1, updated_at = now()
      WHERE organization_id = ${policy.organization_id}
        AND resource = ${policy.resource} AND scope = ${policy.scope}
    `);
    widened++;
  }
  if (widened)
    logger.info(
      { policies: widened },
      "[ResourcePermissions] Widened grants to the nearest permission preset",
    );
}
