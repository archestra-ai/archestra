import { userHasPermission } from "@/auth/utils";
import {
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
  TeamModel,
} from "@/models";
import type {
  AclEntry,
  ConnectorDocument,
  KnowledgeBase,
  KnowledgeBaseConnector,
  KnowledgeSourceVisibility,
} from "@/types";

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
  teamIds: string[];
}

type DocumentPermissions = NonNullable<ConnectorDocument["permissions"]>;

/**
 * Build the ACL for a single document. Determines who can read the document
 * once it lands in `kb_documents` / `kb_chunks`.
 *
 * For `org-wide` and `team-scoped` visibility the ACL is fixed by the
 * connector settings — every document inherits the same entries.
 *
 * For `auto-sync-permissions` visibility the ACL is derived from the
 * `permissions` payload that the connector extracted from the upstream
 * source system. If the connector failed to fetch permissions for a given
 * document the ACL is empty, which means no caller will see it (fail closed).
 */
function buildDocumentAccessControlList(params: {
  visibility: KnowledgeSourceVisibility;
  teamIds: string[];
  permissions?: DocumentPermissions;
}): AclEntry[] {
  switch (params.visibility) {
    case "org-wide":
      return ["org:*"];
    case "team-scoped":
      return params.teamIds.map((id): AclEntry => `team:${id}`);
    case "auto-sync-permissions":
      return buildAutoSyncPermissionsAcl(params.permissions);
    default: {
      const exhaustive: never = params.visibility;
      return exhaustive;
    }
  }
}

function buildAutoSyncPermissionsAcl(
  permissions: DocumentPermissions | undefined,
): AclEntry[] {
  if (!permissions) {
    return [];
  }

  if (permissions.isPublic) {
    return ["org:*"];
  }

  const acl: AclEntry[] = [];
  const seen = new Set<string>();

  for (const rawEmail of permissions.users ?? []) {
    const email = normalizeEmail(rawEmail);
    if (!email) continue;
    const entry: AclEntry = `user_email:${email}`;
    if (seen.has(entry)) continue;
    seen.add(entry);
    acl.push(entry);
  }

  for (const rawGroup of permissions.groups ?? []) {
    const group = rawGroup?.trim();
    if (!group) continue;
    const entry: AclEntry = `group:${group}`;
    if (seen.has(entry)) continue;
    seen.add(entry);
    acl.push(entry);
  }

  return acl;
}

function normalizeEmail(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildUserAccessControlList(params: {
  userEmail: string;
  teamIds: string[];
}): AclEntry[] {
  const acl: AclEntry[] = ["org:*", `user_email:${params.userEmail}`];

  for (const teamId of params.teamIds) {
    acl.push(`team:${teamId}`);
  }

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

class KnowledgeSourceAccessControlService {
  async buildAccessControlContext(params: {
    userId: string;
    organizationId: string;
  }): Promise<KnowledgeSourceAccessControlContext> {
    const [canReadAll, teamIds] = await Promise.all([
      userHasPermission(
        params.userId,
        params.organizationId,
        "knowledgeSource",
        "admin",
      ),
      TeamModel.getUserTeamIds(params.userId),
    ]);

    return {
      canReadAll,
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

  filterConnectors(
    accessControl: KnowledgeSourceAccessControlContext,
    connectors: KnowledgeBaseConnector[],
  ) {
    return connectors.filter((connector) =>
      this.canAccessConnector(accessControl, connector),
    );
  }

  /**
   * Returns the ACL that should apply to *every* document ingested by this
   * connector. For `auto-sync-permissions` visibility there is no single
   * connector-wide ACL — callers must use {@link buildDocumentAccessControlListForDocument}
   * instead. Returning `null` here makes the misuse explicit at the type level.
   */
  buildConnectorDocumentAccessControlList(params: {
    connector: KnowledgeBaseConnector;
  }): AclEntry[] | null {
    if (params.connector.visibility === "auto-sync-permissions") {
      return null;
    }
    return buildDocumentAccessControlList({
      visibility: params.connector.visibility,
      teamIds: params.connector.teamIds,
    });
  }

  /**
   * Compute the ACL for a single connector document. Used by the sync pipeline
   * so connectors that participate in `auto-sync-permissions` can publish
   * per-document permissions while other connectors keep the flat connector-wide ACL.
   */
  buildDocumentAccessControlListForDocument(params: {
    connector: KnowledgeBaseConnector;
    permissions?: DocumentPermissions;
  }): AclEntry[] {
    return buildDocumentAccessControlList({
      visibility: params.connector.visibility,
      teamIds: params.connector.teamIds,
      permissions: params.permissions,
    });
  }

  /**
   * Re-apply the connector-wide ACL to every document/chunk owned by the
   * connector. This is the right thing to do after a visibility/team change
   * for `org-wide` and `team-scoped` connectors, where every document shares
   * a single ACL.
   *
   * Skips connectors using `auto-sync-permissions` — those documents carry
   * per-document ACLs sourced from the upstream system and would be
   * incorrectly flattened by a bulk update. The next sync run will refresh
   * them in place using the latest upstream permissions.
   */
  async refreshConnectorDocumentAccessControlLists(
    connectorId: string,
  ): Promise<void> {
    const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
    if (!connector) {
      return;
    }

    const acl = this.buildConnectorDocumentAccessControlList({ connector });
    if (acl === null) {
      return;
    }

    await Promise.all([
      KbDocumentModel.updateAclByConnector(connectorId, acl),
      KbChunkModel.updateAclByConnector(connectorId, acl),
    ]);
  }

  private canAccessSource(
    accessControl: KnowledgeSourceAccessControlContext,
    source: VisibilityScopedKnowledgeSource,
  ) {
    if (accessControl.canReadAll) {
      return true;
    }

    if (source.visibility !== "team-scoped") {
      return true;
    }

    return source.teamIds.some((teamId) =>
      accessControl.teamIds.includes(teamId),
    );
  }
}

export const knowledgeSourceAccessControlService =
  new KnowledgeSourceAccessControlService();

function haveSameTeamIds(current: string[], next: string[]) {
  if (current.length !== next.length) {
    return false;
  }

  const currentSorted = [...current].sort();
  const nextSorted = [...next].sort();

  return currentSorted.every((teamId, index) => teamId === nextSorted[index]);
}
