import { userHasPermission } from "@/auth/utils";
import {
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
  TeamModel,
} from "@/models";
import type {
  AclEntry,
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

export interface KnowledgeSourceAccessControlContext {
  canReadAll: boolean;
  teamIds: string[];
}

export function buildDocumentAccessControlList(params: {
  visibility: KnowledgeSourceVisibility;
  teamIds: string[];
  permissions?: {
    users?: string[];
    groups?: string[];
    isPublic?: boolean;
  };
}): AclEntry[] {
  switch (params.visibility) {
    case "org-wide":
      return ["org:*"];
    case "team-scoped":
      return params.teamIds.map((id): AclEntry => `team:${id}`);
  }
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

    const acl = this.buildConnectorDocumentAccessControlList({ connector });

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
