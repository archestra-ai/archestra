import { hasScopedPermission, type ScopedPermission } from "@archestra/shared";
// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import {
  KbChunkModel,
  KbContainerAclModel,
  KbDocumentModel,
  KbExternalUserGroupModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ResourcePermissionSubjectModel, {
  type GrantPrincipal,
} from "@/models/resource-permission-subject";
import * as metrics from "@/observability/metrics";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  type AclEntry,
  ApiError,
  type ConnectorType,
  type DocumentPermissions,
  type KnowledgeBase,
  type KnowledgeBaseConnector,
  type KnowledgeSourceVisibility,
} from "@/types";

import { buildGroupToken, normalizeEmail } from "./acl-tokens";
import { getConnector } from "./connectors/registry";

/**
 * Upper bound on ACL entries per document. `kb_chunks.acl` is GIN-indexed and
 * every entry widens that index; a pathologically large explicit audience is
 * capped and over-approximated to `org:*` rather than materialize thousands of
 * `user_email:` / `group:` tokens per chunk. See `buildDocumentAccessControlList`.
 */
const MAX_DOCUMENT_ACL_ENTRIES = 1000;

type VisibilityScopedKnowledgeSource = {
  visibility: KnowledgeSourceVisibility;
  teamIds: string[];
};

type VisibilityScopedKnowledgeSourceUpdates = Partial<{
  visibility: KnowledgeSourceVisibility;
  teamIds: string[];
}>;

interface KnowledgeSourceAccessControlContext {
  organizationId?: string;
  grants?: ScopedPermission[];
  userId?: string;
  /** The caller's grant subjects, resolved once for the request's queries. */
  principal?: GrantPrincipal;
  canReadAll: boolean;
  teamIds: string[];
}

/**
 * @public — core ACL primitive of the permission-sync feature. Consumed by the
 * permission-sync pass and unit tests (outside knip's production view); exported
 * so both the pass and tests build a document's ACL through one authority.
 */
export function buildDocumentAccessControlList(params: {
  visibility: KnowledgeSourceVisibility;
  teamIds: string[];
  /** A permission-sync connector: the ACL comes from the upstream audience. */
  syncPermissionsFromSource?: boolean;
  connectorType?: ConnectorType;
  permissions?: DocumentPermissions;
}): AclEntry[] {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (params.syncPermissionsFromSource) {
    return buildAutoSyncDocumentAccessControlList({
      connectorType: params.connectorType,
      permissions: params.permissions,
    });
  }
  // SPDX-SnippetEnd
  switch (params.visibility) {
    case "org-wide":
      return ["org:*"];
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    case "team-scoped":
      return params.teamIds.map((id): AclEntry => `team:${id}`);
    case "auto-sync-permissions":
      // The mode is read from `syncPermissionsFromSource` above. A connector
      // whose visibility still says so without the switch set syncs nothing,
      // so its documents stay fail-closed.
      return [];
    // SPDX-SnippetEnd
  }
}

export function buildUserAccessControlList(params: {
  userEmail: string;
  teamIds: string[];
  /**
   * Namespaced `group:` tokens for the user's upstream group memberships,
   * resolved (local SQL, no upstream call) only when an in-scope connector is
   * `auto-sync-permissions`. See `KbExternalUserGroupModel.findGroupTokensForUser`.
   */
  groupTokens?: AclEntry[];
}): AclEntry[] {
  const acl: AclEntry[] = [
    "org:*",
    `user_email:${normalizeEmail(params.userEmail)}`,
  ];

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  for (const teamId of params.teamIds) {
    acl.push(`team:${teamId}`);
  }

  for (const token of params.groupTokens ?? []) {
    acl.push(token);
  }
  // SPDX-SnippetEnd

  return acl;
}

export function didKnowledgeSourceAclInputsChange(params: {
  current: VisibilityScopedKnowledgeSource;
  updates: VisibilityScopedKnowledgeSourceUpdates;
}): boolean {
  const nextVisibility = params.updates.visibility ?? params.current.visibility;
  const nextTeamIds = params.updates.teamIds ?? params.current.teamIds;

  return (
    nextVisibility !== params.current.visibility ||
    !haveSameTeamIds(params.current.teamIds, nextTeamIds)
  );
}

export function isTeamScopedWithoutTeams(params: {
  visibility: KnowledgeSourceVisibility;
  teamIds: string[];
}): boolean {
  return params.visibility === "team-scoped" && params.teamIds.length === 0;
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Runtime gate for the whole permission-sync family (scheduler, worker,
 * content-sync trigger, manual trigger): enterprise
 * knowledge-base tier. Enforced at runtime — not only when the visibility is
 * set — so a lapsed license makes existing auto-sync connectors go dormant
 * instead of continuing to sync ACLs.
 */
export function isAutoSyncPermissionsActive(): boolean {
  return enterpriseTier.isKnowledgeBaseActive();
}

/**
 * Gate for selecting the `auto-sync-permissions` visibility on a connector —
 * every path that can set it (REST create/update and the MCP connector tools)
 * must pass: enterprise knowledge-base tier active and connector type support.
 * The ordinary connector create/update permission is enforced at the route or
 * MCP tool boundary.
 *
 * Returns the violation instead of throwing so MCP tool handlers can surface
 * the message (their catch-all deliberately genericizes thrown errors).
 */
export async function checkCanSetAutoSyncPermissionsVisibility(params: {
  connectorType: ConnectorType;
}): Promise<ApiError | null> {
  if (!enterpriseTier.isKnowledgeBaseActive()) {
    return new ApiError(
      403,
      "Auto-sync-permissions connectors require an enterprise license",
    );
  }
  const unsupported = checkAutoSyncPermissionSyncSupported(
    params.connectorType,
  );
  if (unsupported) {
    return unsupported;
  }
  return null;
}

/**
 * Whether the connector type's implementation supports permission sync.
 * Standalone (also part of `checkCanSetAutoSyncPermissionsVisibility`) so
 * update paths can re-validate a connector that already carries the
 * auto-sync visibility without re-running the transition-only gates.
 */
export function checkAutoSyncPermissionSyncSupported(
  connectorType: ConnectorType,
): ApiError | null {
  if (!getConnector(connectorType).supportsPermissionSync) {
    return new ApiError(
      400,
      `Auto-sync permissions is not supported for ${connectorType} connectors`,
    );
  }
  return null;
}
// SPDX-SnippetEnd

class KnowledgeSourceAccessControlService {
  async buildAccessControlContext(params: {
    userId: string;
    organizationId: string;
  }): Promise<KnowledgeSourceAccessControlContext> {
    const principal =
      await ResourcePermissionSubjectModel.resolvePrincipal(params);
    const grants = await ResourcePermissions.resolveAll(principal);
    const canReadAll = hasScopedPermission({
      grants,
      required: {
        organizationId: params.organizationId,
        resource: "knowledgeBase",
        scope: "*",
        action: "update",
      },
    });

    return {
      userId: params.userId,
      organizationId: params.organizationId,
      principal,
      grants,
      canReadAll,
      teamIds: principal.subjects.flatMap((subject) =>
        subject.type === "team" ? [subject.id] : [],
      ),
    };
  }

  canAccessKnowledgeBase(
    accessControl: KnowledgeSourceAccessControlContext,
    knowledgeBase: KnowledgeBase,
  ) {
    return this.hasScopedAccess({
      accessControl,
      resource: "knowledgeBase",
      id: knowledgeBase.id,
      action: "read",
    });
  }

  canAccessConnector(
    accessControl: KnowledgeSourceAccessControlContext,
    connector: Pick<KnowledgeBaseConnector, "id" | "syncPermissionsFromSource">,
  ) {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Permission-sync connectors use the same management grants as other
    // connectors. Their documents still use upstream ACLs for queries.
    // SPDX-SnippetEnd
    return this.hasScopedAccess({
      accessControl,
      resource: "knowledgeConnector",
      id: connector.id,
      action: "read",
    });
  }

  canQueryKnowledgeBase(
    accessControl: KnowledgeSourceAccessControlContext,
    knowledgeBase: KnowledgeBase,
  ) {
    return this.hasScopedAccess({
      accessControl,
      resource: "knowledgeBase",
      id: knowledgeBase.id,
      action: "use",
    });
  }

  /**
   * For a caller with no user of its own: the knowledge bases or connectors
   * published to the organization at large for `action`.
   */
  async filterPublishedToOrganization<
    T extends { id: string; organizationId: string },
  >(params: {
    organizationId: string;
    resource: "knowledgeBase" | "knowledgeConnector";
    sources: T[];
    action: "read" | "use";
  }): Promise<T[]> {
    const published =
      await ResourcePermissionPolicyModel.findOrganizationWideScopes({
        organizationId: params.organizationId,
        resource: params.resource,
        scopes: params.sources.map((source) => source.id),
        action: params.action,
      });
    return params.sources.filter(
      (source) =>
        source.organizationId === params.organizationId &&
        published.has(source.id),
    );
  }

  filterKnowledgeBases(
    accessControl: KnowledgeSourceAccessControlContext,
    knowledgeBases: KnowledgeBase[],
  ) {
    return knowledgeBases.filter((knowledgeBase) =>
      this.canAccessKnowledgeBase(accessControl, knowledgeBase),
    );
  }

  /**
   * Whether the viewer's QUERIES may span this connector — a deliberately
   * wider notion than management visibility (`canAccessConnector`):
   * auto-sync-permissions connectors are queryable by everyone, because their
   * per-chunk ACLs (not connector visibility) are the real enforcement.
   */
  filterQueryableConnectors(
    accessControl: KnowledgeSourceAccessControlContext,
    connectors: KnowledgeBaseConnector[],
  ) {
    return connectors.filter(
      (connector) =>
        connector.syncPermissionsFromSource ||
        this.hasScopedAccess({
          accessControl,
          resource: "knowledgeConnector",
          id: connector.id,
          action: "use",
        }),
    );
  }

  buildConnectorDocumentAccessControlList(params: {
    connector: KnowledgeBaseConnector;
  }): AclEntry[] {
    return buildDocumentAccessControlList({
      visibility: params.connector.visibility,
      teamIds: params.connector.teamIds,
      syncPermissionsFromSource: params.connector.syncPermissionsFromSource,
    });
  }

  async refreshConnectorDocumentAccessControlLists(
    connectorId: string,
  ): Promise<void> {
    const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
    if (!connector) {
      return;
    }

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Auto-sync connectors own their per-document ACLs via the permission-sync
    // pass; never bulk-overwrite them with a single connector-level ACL. The
    // next scheduled (epoch-fenced) permission pass is the authoritative writer.
    if (connector.syncPermissionsFromSource) {
      return;
    }
    // SPDX-SnippetEnd

    const acl = this.buildConnectorDocumentAccessControlList({ connector });

    // Epoch-fenced: the connector was read (with its current `aclConfigEpoch`)
    // above, after the caller bumped the epoch on the visibility/teamIds change.
    // If another change bumps it again before these writes land, they no-op so
    // the newest config wins regardless of ordering.
    const aclConfigEpoch = connector.aclConfigEpoch;
    await Promise.all([
      KbDocumentModel.updateAclByConnector({
        connectorId,
        acl,
        aclConfigEpoch,
      }),
      KbChunkModel.updateAclByConnector({ connectorId, acl, aclConfigEpoch }),
    ]);
    // A connector that LEFT auto-sync no longer needs its container-audience
    // rows or its group-membership snapshot: the bulk overwrite above removed
    // every `container:` and `group:` token, so the rows grant nothing —
    // dropping them keeps admin views and the query-time token resolution
    // free of dead audiences. (A racing permission pass may re-insert some;
    // its doc-token writes are epoch-fenced no-ops, so those rows are inert
    // and cleaned up on the next switch or delete.)
    await Promise.all([
      KbContainerAclModel.deleteByConnector(connectorId),
      KbExternalUserGroupModel.deleteByConnector(connectorId),
    ]);
  }

  /**
   * MANAGEMENT visibility: whether the viewer may see/edit the source itself
   * (its config, documents, runs, overrides — everything behind the connector
   * detail surfaces), from the viewer's stored grants.
   */
  private hasScopedAccess(params: {
    accessControl: KnowledgeSourceAccessControlContext;
    resource: "knowledgeBase" | "knowledgeConnector";
    id: string;
    action: "read" | "use";
  }) {
    const { accessControl } = params;
    if (!accessControl.organizationId) return false;
    return hasScopedPermission({
      grants: accessControl.grants ?? [],
      required: {
        organizationId: accessControl.organizationId,
        resource: params.resource,
        scope: params.id,
        action: params.action,
      },
    });
  }
}

export const knowledgeSourceAccessControlService =
  new KnowledgeSourceAccessControlService();

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Build a document's ACL from its extracted upstream audience:
 * `org:*` (public) ∪ `user_email:<email>` ∪ `group:<connectorType>_<groupId>`.
 *
 * Empty permissions ⇒ empty ACL ⇒ fail-closed (only admins, who bypass the ACL,
 * can retrieve it). A pathologically large audience is over-approximated to
 * `org:*` rather than bloat every chunk's GIN-indexed `acl` array.
 */
function buildAutoSyncDocumentAccessControlList(params: {
  connectorType?: ConnectorType;
  permissions?: DocumentPermissions;
}): AclEntry[] {
  const permissions = params.permissions;
  if (!permissions) {
    return [];
  }

  const acl: AclEntry[] = [];
  if (permissions.isPublic) {
    acl.push("org:*");
  }
  for (const email of permissions.users ?? []) {
    acl.push(`user_email:${normalizeEmail(email)}`);
  }
  // Groups can only be namespaced when the connector type is known; without it
  // the token could collide across connectors, so groups are dropped (the
  // permission-sync pass always supplies it).
  if (params.connectorType) {
    for (const groupId of permissions.groups ?? []) {
      acl.push(
        buildGroupToken({ connectorType: params.connectorType, groupId }),
      );
    }
  } else if (permissions.groups?.length) {
    // Contract violation by the caller — fail-closed under-grant, but it must
    // be visible: group-granted readers silently lose access otherwise.
    logger.warn(
      { groups: permissions.groups.length },
      "Dropping group grants from a document ACL: no connector type supplied",
    );
  }

  const deduped = [...new Set(acl)];
  if (deduped.length > MAX_DOCUMENT_ACL_ENTRIES) {
    // Over-GRANT by design (the whole org can now read the document), so it
    // must leave an operational trail: a silently widened private document is
    // indistinguishable from a correctly-public one.
    logger.warn(
      {
        connectorType: params.connectorType,
        aclEntries: deduped.length,
        cap: MAX_DOCUMENT_ACL_ENTRIES,
      },
      "Document ACL exceeds the per-document cap; over-approximating to org-wide visibility",
    );
    if (params.connectorType) {
      metrics.rag.reportPermissionSyncAclOverApproximation(
        params.connectorType,
      );
    }
    return ["org:*"];
  }
  return deduped;
}
// SPDX-SnippetEnd

function haveSameTeamIds(current: string[], next: string[]) {
  if (current.length !== next.length) {
    return false;
  }

  const currentSorted = [...current].sort();
  const nextSorted = [...next].sort();

  return currentSorted.every((teamId, index) => teamId === nextSorted[index]);
}
