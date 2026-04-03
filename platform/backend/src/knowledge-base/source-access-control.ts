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
