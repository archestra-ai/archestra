// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { sql } from "drizzle-orm";
import type { Transaction } from "@/database";

/** Runs after the older visibility/action conversion, in the same transaction. */
export default class OAuthClientUpgradeModel {
  static async run(tx: Transaction): Promise<void> {
    await tx.execute(
      sql`LOCK TABLE organization_role IN SHARE ROW EXCLUSIVE MODE`,
    );
    for (const statement of LEGACY_TOKEN_SCOPES.split(";").filter((value) =>
      value.trim(),
    ))
      await tx.execute(sql.raw(statement));
    await tx.execute(sql.raw(ROLE_UNION));
    await tx.execute(sql.raw(POLICY_UNION));
    await tx.execute(
      sql`DELETE FROM resource_permission_policies WHERE resource IN ('mcpOauthClient','llmOauthClient')`,
    );
    await tx.execute(sql`
      UPDATE oauth_client SET scopes = CASE
        WHEN scopes IS NULL THEN CASE metadata->>'type' WHEN 'mcp_oauth_client' THEN ARRAY['mcp','a2a'] ELSE ARRAY['llm:proxy'] END
        WHEN metadata->>'type' = 'mcp_oauth_client' AND 'mcp' = ANY(scopes) AND NOT 'a2a' = ANY(scopes) THEN array_append(scopes,'a2a')
        ELSE scopes END,
        metadata = metadata || '{"type":"managed_oauth_client"}'::jsonb
      WHERE metadata->>'type' IN ('mcp_oauth_client','llm_oauth_client')
    `);
  }
}
const ROLE_UNION = `WITH source AS (
  SELECT id, permission::jsonb AS p FROM organization_role
  WHERE permission::jsonb ?| ARRAY['mcpOauthClient', 'llmOauthClient']
), merged AS (
  SELECT id, p - ARRAY['mcpOauthClient', 'llmOauthClient', 'oauthClient'] AS rest,
    (SELECT COALESCE(jsonb_agg(action ORDER BY action), '[]'::jsonb)
     FROM (SELECT DISTINCT action FROM jsonb_array_elements_text(
       COALESCE(p->'mcpOauthClient', '[]'::jsonb) ||
       COALESCE(p->'llmOauthClient', '[]'::jsonb) ||
       COALESCE(p->'oauthClient', '[]'::jsonb)) a(action) WHERE action IN ('read','create')) unioned) AS actions
  FROM source
), rewritten AS (
  SELECT id, CASE WHEN jsonb_array_length(actions) = 0 THEN rest
    ELSE jsonb_set(rest, '{oauthClient}', actions) END AS permission FROM merged
)
UPDATE organization_role r SET permission = rewritten.permission::text,
  updated_at = now()
FROM rewritten WHERE r.id = rewritten.id
  AND r.permission::jsonb IS DISTINCT FROM rewritten.permission;

`;
const POLICY_UNION = `-- Include existing canonical documents only at scopes touched by old rows.
WITH touched AS (
  SELECT DISTINCT organization_id, scope FROM resource_permission_policies
  WHERE resource IN ('mcpOauthClient', 'llmOauthClient')
), source AS (
  SELECT p.* FROM resource_permission_policies p
  JOIN touched USING (organization_id, scope)
  WHERE resource IN ('mcpOauthClient', 'llmOauthClient', 'oauthClient')
), metadata AS (
  SELECT organization_id, scope, max(revision) + 1 AS revision,
    true AS migrated,
    bool_or(legacy_organization_audience) AS audience FROM source
  GROUP BY organization_id, scope
), entries AS (
  SELECT organization_id, scope, g->'subject'->>'type' AS subject_type,
    g->'subject'->>'id' AS subject_id, action
  FROM source CROSS JOIN LATERAL jsonb_array_elements(grants) g
  CROSS JOIN LATERAL jsonb_array_elements_text(g->'actions') a(action)
  WHERE action IN ('read','update','delete','manage-permissions')
), subjects AS (
  SELECT organization_id, scope, subject_type, subject_id,
    jsonb_agg(DISTINCT action ORDER BY action) AS actions FROM entries
  GROUP BY organization_id, scope, subject_type, subject_id
), documents AS (
  SELECT organization_id, scope,
    jsonb_agg(jsonb_build_object('subject', jsonb_build_object(
      'type', subject_type, 'id', subject_id), 'actions', actions)
      ORDER BY subject_type, subject_id) AS grants FROM subjects
  GROUP BY organization_id, scope
)
INSERT INTO resource_permission_policies
  (organization_id, resource, scope, grants, revision,
   legacy_sharing_migrated, legacy_organization_audience, updated_at)
SELECT m.organization_id, 'oauthClient', m.scope, COALESCE(d.grants, '[]'::jsonb),
  m.revision, m.migrated, m.audience, now() FROM metadata m
LEFT JOIN documents d USING (organization_id, scope)
ON CONFLICT (organization_id, resource, scope) DO UPDATE SET
  grants = EXCLUDED.grants, revision = EXCLUDED.revision,
  legacy_sharing_migrated = EXCLUDED.legacy_sharing_migrated,
  legacy_organization_audience = EXCLUDED.legacy_organization_audience,
  updated_at = EXCLUDED.updated_at;

`;

const LEGACY_TOKEN_SCOPES = `-- The old mcp scope also authorized A2A. Preserve only already-issued grants.
UPDATE oauth_access_token AS grant_row SET scopes = array_append(grant_row.scopes, 'a2a')
FROM oauth_client AS client
WHERE grant_row.client_id = client.client_id
  AND client.metadata->>'type' = 'mcp_oauth_client'
  AND 'mcp' = ANY(grant_row.scopes) AND NOT 'a2a' = ANY(grant_row.scopes);
UPDATE oauth_refresh_token AS grant_row SET scopes = array_append(grant_row.scopes, 'a2a')
FROM oauth_client AS client
WHERE grant_row.client_id = client.client_id
  AND client.metadata->>'type' = 'mcp_oauth_client'
  AND 'mcp' = ANY(grant_row.scopes) AND NOT 'a2a' = ANY(grant_row.scopes);
UPDATE oauth_consent AS grant_row SET scopes = array_append(grant_row.scopes, 'a2a')
FROM oauth_client AS client
WHERE grant_row.client_id = client.client_id
  AND client.metadata->>'type' = 'mcp_oauth_client'
  AND 'mcp' = ANY(grant_row.scopes) AND NOT 'a2a' = ANY(grant_row.scopes);
`;
