// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import {
  KbChunkModel,
  KbContainerAclModel,
  KbDocumentModel,
  KbExternalUserGroupModel,
  KnowledgeBaseConnectorModel,
  TeamModel,
} from "@/models";
import * as metrics from "@/observability/metrics";
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
  canReadAll: boolean;
  canManageAutoSync: boolean;
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
  connectorType?: ConnectorType;
  permissions?: DocumentPermissions;
}): AclEntry[] {
  switch (params.visibility) {
    case "org-wide":
      return ["org:*"];
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    case "team-scoped":
      return params.teamIds.map((id): AclEntry => `team:${id}`);
    case "auto-sync-permissions":
      return buildAutoSyncDocumentAccessControlList({
        connectorType: params.connectorType,
        permissions: params.permissions,
      });
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

export const AUTO_SYNC_PERMISSIONS_DISABLED_ERROR =
  "Auto-sync permissions is a beta feature that is not enabled on this deployment (set ARCHESTRA_KNOWLEDGE_BASE_AUTO_SYNC_PERMISSIONS_ENABLED=true to enable it)";

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Runtime gate for the whole permission-sync family (scheduler, worker,
 * content-sync trigger, manual trigger): beta flag AND enterprise
 * knowledge-base tier. Enforced at runtime — not only when the visibility is
 * set — so a lapsed license makes existing auto-sync connectors go dormant
 * instead of continuing to sync ACLs.
 */
export function isAutoSyncPermissionsActive(): boolean {
  return (
    config.kb.autoSyncPermissionsEnabled &&
    enterpriseTier.isKnowledgeBaseActive()
  );
}

/**
 * Gate for selecting the `auto-sync-permissions` visibility on a connector —
 * every path that can set it (REST create/update and the MCP connector tools)
 * must pass: beta flag on, enterprise knowledge-base tier active, connector
 * type supports permission sync, and the caller holds the matching
 * `knowledgeSourceAutoSync` permission ("create" when creating a connector
 * with the visibility, "update" when switching an existing one into it).
 * By default only the Admin role carries these permissions.
 *
 * Returns the violation instead of throwing so MCP tool handlers can surface
 * the message (their catch-all deliberately genericizes thrown errors).
 */
export async function checkCanSetAutoSyncPermissionsVisibility(params: {
  userId: string;
  organizationId: string;
  connectorType: ConnectorType;
  action: "create" | "update";
}): Promise<ApiError | null> {
  if (!config.kb.autoSyncPermissionsEnabled) {
    return new ApiError(403, AUTO_SYNC_PERMISSIONS_DISABLED_ERROR);
  }
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
  return checkHasAutoSyncConnectorPermission(params);
}

/**
 * Whether the caller holds the given `knowledgeSourceAutoSync` action —
 * the permission family gating auto-sync-permissions connector management
 * (view/create/edit/delete), granted by default to the Admin role only.
 * Standalone (also the last step of `checkCanSetAutoSyncPermissionsVisibility`)
 * so mutations of a connector that ALREADY carries the auto-sync visibility
 * can enforce the action without re-running the transition-only gates.
 */
export async function checkHasAutoSyncConnectorPermission(params: {
  userId: string;
  organizationId: string;
  action: "create" | "update" | "delete";
}): Promise<ApiError | null> {
  const hasAutoSyncPermission = await userHasPermission(
    params.userId,
    params.organizationId,
    "knowledgeSourceAutoSync",
    params.action,
  );
  if (!hasAutoSyncPermission) {
    return new ApiError(
      403,
      `You do not have the "${params.action}" permission for auto-sync-permissions connectors`,
    );
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
    const [canReadAll, canManageAutoSync, teamIds] = await Promise.all([
      userHasPermission(
        params.userId,
        params.organizationId,
        "knowledgeSource",
        "admin",
      ),
      userHasPermission(
        params.userId,
        params.organizationId,
        "knowledgeSourceAutoSync",
        "read",
      ),
      TeamModel.getUserTeamIds(params.userId),
    ]);

    return {
      canReadAll,
      canManageAutoSync,
      teamIds,
    };
  }

  canAccessKnowledgeBase(
    _accessControl: KnowledgeSourceAccessControlContext,
    _knowledgeBase: KnowledgeBase,
  ) {
    // Knowledge bases are just collections of connectors now. Visibility is
    // enforced at the connector layer, so KB-level access is always allowed.
    return true;
  }

  canAccessConnector(
    accessControl: KnowledgeSourceAccessControlContext,
    connector: KnowledgeBaseConnector,
  ) {
    return this.canAccessSource(accessControl, connector);
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
    return connectors.filter((connector) =>
      this.canQuerySource(accessControl, connector),
    );
  }

  buildConnectorDocumentAccessControlList(params: {
    connector: KnowledgeBaseConnector;
  }): AclEntry[] {
    return buildDocumentAccessControlList({
      visibility: params.connector.visibility,
      teamIds: params.connector.teamIds,
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
    if (connector.visibility === "auto-sync-permissions") {
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
   * detail surfaces). Query reach is the separate, wider `canQuerySource`.
   */
  private canAccessSource(
    accessControl: KnowledgeSourceAccessControlContext,
    source: VisibilityScopedKnowledgeSource,
  ) {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Auto-sync-permissions connectors mirror upstream ACLs and expose
    // audience/membership details, so seeing them requires the dedicated
    // knowledgeSourceAutoSync permission (admin-only by default) — the
    // knowledgeSource:admin view-all bypass deliberately does NOT extend
    // here. Members still QUERY their documents (canQuerySource); the
    // per-chunk ACL decides what each user retrieves.
    if (source.visibility === "auto-sync-permissions") {
      return accessControl.canManageAutoSync;
    }
    // SPDX-SnippetEnd

    if (accessControl.canReadAll) {
      return true;
    }

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (source.visibility !== "team-scoped") {
      return true;
    }

    return source.teamIds.some((teamId) =>
      accessControl.teamIds.includes(teamId),
    );
    // SPDX-SnippetEnd
  }

  private canQuerySource(
    accessControl: KnowledgeSourceAccessControlContext,
    source: VisibilityScopedKnowledgeSource,
  ) {
    if (accessControl.canReadAll) {
      return true;
    }

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    if (source.visibility !== "team-scoped") {
      return true;
    }

    return source.teamIds.some((teamId) =>
      accessControl.teamIds.includes(teamId),
    );
    // SPDX-SnippetEnd
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
