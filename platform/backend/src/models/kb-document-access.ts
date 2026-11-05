// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { type SQLWrapper, sql } from "drizzle-orm";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import ResourcePermissionSubjectModel, {
  type GrantPrincipal,
} from "./resource-permission-subject";

/** Live grant checks keep indexed content in sync with permission edits and revocations. */
export default class KbDocumentAccessModel {
  /**
   * The grant subjects of the caller a request ACL names, or null when it
   * names none. Resolve once per retrieval and pass the result to
   * {@link condition} for every stage of it.
   */
  static async resolvePrincipals(params: {
    userAcl: readonly string[];
    organizationId?: string;
  }): Promise<GrantPrincipal[] | null> {
    const userId = principalOf(params.userAcl);
    if (userId)
      return ResourcePermissionSubjectModel.resolvePrincipals({
        userId,
        organizationId: params.organizationId,
      });
    const oauthClientId = oauthClientOf(params.userAcl);
    if (oauthClientId) {
      const principal =
        await ResourcePermissionSubjectModel.resolveOauthClientPrincipal({
          oauthClientId,
          organizationId: params.organizationId,
        });
      return principal ? [principal] : [];
    }
    return null;
  }

  /** The caller's resolved principals, resolving them here only when absent. */
  static principalsFor(params: {
    userAcl: readonly string[];
    grantPrincipals?: GrantPrincipal[] | null;
  }): Promise<GrantPrincipal[] | null> {
    return params.grantPrincipals !== undefined
      ? Promise.resolve(params.grantPrincipals)
      : KbDocumentAccessModel.resolvePrincipals(params);
  }

  static condition(params: {
    userAcl: readonly string[];
    /** From {@link resolvePrincipals} for this same `userAcl`. */
    grantPrincipals: GrantPrincipal[] | null;
    documentId: SQLWrapper;
    connectorId: SQLWrapper;
    organizationId: SQLWrapper;
    acl: SQLWrapper;
  }) {
    // Identity is request context, not a stored ACL token. Excluding it from
    // overlap prevents a connector-supplied token from impersonating a grant.
    const inheritedUpstreamTokens =
      params.grantPrincipals?.flatMap(
        (principal) => principal.upstreamTokens ?? [],
      ) ?? [];
    const tokens = [
      ...new Set([
        ...params.userAcl.filter((token) => !token.startsWith("principal:")),
        ...inheritedUpstreamTokens,
      ]),
    ];
    const upstream = tokens.length
      ? sql`${params.acl} ?| ARRAY[${sql.join(
          tokens.map((token) => sql`${token}`),
          sql`, `,
        )}]`
      : sql`false`;
    const fileContext = {
      organizationId: params.organizationId,
      resource: "knowledgeFile" as const,
      scopeColumn: sql`permission_file.kb_file_id`,
    };
    const knowledgeBaseContext = {
      organizationId: params.organizationId,
      resource: "knowledgeBase" as const,
      scopeColumn: sql`permission_upload.knowledge_base_id`,
    };
    const assignedKnowledgeBaseContext = {
      organizationId: params.organizationId,
      resource: "knowledgeBase" as const,
      scopeColumn: sql`permission_assignment.knowledge_base_id`,
    };
    const connectorContext = {
      organizationId: params.organizationId,
      resource: "knowledgeConnector" as const,
      scopeColumn: params.connectorId,
    };
    const principals = params.grantPrincipals;
    const hasUserPrincipal = Boolean(principalOf(params.userAcl));
    const access = (
      context:
        | typeof fileContext
        | typeof knowledgeBaseContext
        | typeof assignedKnowledgeBaseContext
        | typeof connectorContext,
    ) =>
      principals
        ? hasUserPrincipal
          ? ResourcePermissionPolicyModel.grantConditionForAny({
              ...context,
              principals,
              organizationColumn: params.organizationId,
              action: "use",
            })
          : sql`(${ResourcePermissionPolicyModel.grantConditionForAny({
              ...context,
              principals,
              organizationColumn: params.organizationId,
              action: "use",
            })} OR ${ResourcePermissionPolicyModel.organizationAccessCondition({
              ...context,
              action: "use",
            })})`
        : ResourcePermissionPolicyModel.organizationAccessCondition({
            ...context,
            action: "use",
          });
    const connectorOrAssignedKnowledgeBaseAccess = sql`(
      ${access(connectorContext)}
      OR EXISTS (
        SELECT 1 FROM knowledge_base_connector_assignment permission_assignment
        INNER JOIN knowledge_bases permission_kb
          ON permission_kb.id = permission_assignment.knowledge_base_id
          AND permission_kb.deleted_at IS NULL
        WHERE permission_assignment.connector_id = ${params.connectorId}
          AND ${access(assignedKnowledgeBaseContext)}
      )
    )`;
    return sql`CASE
      WHEN EXISTS (SELECT 1 FROM kb_file_document permission_file WHERE permission_file.kb_document_id = ${params.documentId})
      THEN (
        EXISTS (
          SELECT 1 FROM kb_file_document permission_file
          WHERE permission_file.kb_document_id = ${params.documentId}
            AND ${access(fileContext)}
        )
        OR EXISTS (
          SELECT 1 FROM kb_upload_connector permission_upload
          INNER JOIN knowledge_bases permission_kb
            ON permission_kb.id = permission_upload.knowledge_base_id
            AND permission_kb.deleted_at IS NULL
          WHERE permission_upload.connector_id = ${params.connectorId}
            AND ${access(knowledgeBaseContext)}
        )
      )
      WHEN EXISTS (SELECT 1 FROM knowledge_base_connectors permission_connector WHERE permission_connector.id = ${params.connectorId} AND permission_connector.sync_permissions_from_source)
        THEN ${hasUserPrincipal ? upstream : sql`(${connectorOrAssignedKnowledgeBaseAccess} AND ${upstream})`}
      ELSE ${connectorOrAssignedKnowledgeBaseAccess}
    END`;
  }
}

function principalOf(userAcl: readonly string[]): string | undefined {
  return userAcl
    .find((token) => token.startsWith("principal:"))
    ?.slice("principal:".length);
}

function oauthClientOf(userAcl: readonly string[]): string | undefined {
  return userAcl
    .find((token) => token.startsWith("oauth_client:"))
    ?.slice("oauth_client:".length);
}
