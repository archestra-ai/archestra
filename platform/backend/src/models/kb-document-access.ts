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
    return userId
      ? ResourcePermissionSubjectModel.resolvePrincipals({
          userId,
          organizationId: params.organizationId,
        })
      : null;
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
    const tokens = params.userAcl.filter(
      (token) => !token.startsWith("principal:"),
    );
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
    const connectorContext = {
      organizationId: params.organizationId,
      resource: "knowledgeConnector" as const,
      scopeColumn: params.connectorId,
    };
    const principals = params.grantPrincipals;
    const access = (context: typeof fileContext | typeof connectorContext) =>
      principals
        ? ResourcePermissionPolicyModel.grantConditionForAny({
            ...context,
            principals,
            organizationColumn: params.organizationId,
            action: "use",
          })
        : ResourcePermissionPolicyModel.organizationAccessCondition({
            ...context,
            action: "use",
          });
    return sql`CASE
      WHEN EXISTS (SELECT 1 FROM kb_file_document permission_file WHERE permission_file.kb_document_id = ${params.documentId})
      THEN EXISTS (
        SELECT 1 FROM kb_file_document permission_file
        WHERE permission_file.kb_document_id = ${params.documentId}
          AND ${access(fileContext)}
      )
      WHEN EXISTS (SELECT 1 FROM knowledge_base_connectors permission_connector WHERE permission_connector.id = ${params.connectorId} AND permission_connector.sync_permissions_from_source)
        THEN ${upstream}
      ELSE ${access(connectorContext)}
    END`;
  }
}

function principalOf(userAcl: readonly string[]): string | undefined {
  return userAcl
    .find((token) => token.startsWith("principal:"))
    ?.slice("principal:".length);
}
