// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { type SQLWrapper, sql } from "drizzle-orm";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import ResourcePermissionSubjectModel from "./resource-permission-subject";

/** Live grant checks keep indexed content in sync with permission edits and revocations. */
export default class KbDocumentAccessModel {
  static async condition(params: {
    userAcl: readonly string[];
    documentId: SQLWrapper;
    connectorId: SQLWrapper;
    organizationId: SQLWrapper;
    acl: SQLWrapper;
  }) {
    // Identity is request context, not a stored ACL token. Excluding it from
    // overlap prevents a connector-supplied token from impersonating a grant.
    const principal = params.userAcl
      .find((token) => token.startsWith("principal:"))
      ?.slice("principal:".length);
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
    const principals = principal
      ? await ResourcePermissionSubjectModel.resolvePrincipals({
          userId: principal,
        })
      : null;
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
