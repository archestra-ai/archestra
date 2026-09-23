import {
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { buildGroupToken, normalizeEmail } from "./acl-tokens";
import {
  buildDocumentAccessControlList,
  buildUserAccessControlList,
  didKnowledgeSourceAclInputsChange,
  knowledgeSourceAccessControlService,
} from "./source-access-control";

describe("knowledgeSourceAccessControlService", () => {
  test("does not report ACL changes when visibility inputs are unchanged", () => {
    expect(
      didKnowledgeSourceAclInputsChange({
        current: {
          visibility: "team-scoped",
          teamIds: ["team-b", "team-a"],
        },
        updates: {
          visibility: "team-scoped",
          teamIds: ["team-a", "team-b"],
        },
      }),
    ).toBe(false);
  });

  test("reports ACL changes when visibility changes", () => {
    expect(
      didKnowledgeSourceAclInputsChange({
        current: {
          visibility: "org-wide",
          teamIds: [],
        },
        updates: {
          visibility: "team-scoped",
        },
      }),
    ).toBe(true);
  });

  test("reports ACL changes when team ids change", () => {
    expect(
      didKnowledgeSourceAclInputsChange({
        current: {
          visibility: "team-scoped",
          teamIds: ["team-a"],
        },
        updates: {
          teamIds: ["team-b"],
        },
      }),
    ).toBe(true);
  });

  test("a knowledge source is reached through its grants alone", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    // Organization-wide by the retired visibility field, and no policy.
    const knowledgeBase = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
    );
    const context = () =>
      knowledgeSourceAccessControlService.buildAccessControlContext({
        userId: user.id,
        organizationId: org.id,
      });

    let access = await context();
    expect(
      knowledgeSourceAccessControlService.canAccessKnowledgeBase(
        access,
        knowledgeBase,
      ),
    ).toBe(false);
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(access, connector),
    ).toBe(false);

    await ResourcePermissionPolicyModel.replace({
      organizationId: org.id,
      resource: "knowledgeConnector",
      scope: connector.id,
      revision: 0,
      grants: [
        { subject: { type: "user", id: user.id }, actions: ["read", "use"] },
      ],
    });
    access = await context();
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(access, connector),
    ).toBe(true);
    expect(
      knowledgeSourceAccessControlService.filterQueryableConnectors(access, [
        connector,
      ]),
    ).toEqual([connector]);
    expect(
      knowledgeSourceAccessControlService.canAccessKnowledgeBase(
        access,
        knowledgeBase,
      ),
    ).toBe(false);
  });

  test("blocks auto-sync-permissions connectors for non-admin members but keeps them queryable", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const knowledgeBase = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
      {
        connectorType: "github",
        visibility: "auto-sync-permissions",
      },
    );

    const access =
      await knowledgeSourceAccessControlService.buildAccessControlContext({
        userId: user.id,
        organizationId: org.id,
      });

    // Management surfaces need the knowledgeSourceAutoSync permission
    // (admin-only by default)...
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(access, connector),
    ).toBe(false);
    // ...but the member's queries still span the connector — the per-chunk
    // ACL is the enforcement there.
    expect(
      knowledgeSourceAccessControlService.filterQueryableConnectors(access, [
        connector,
      ]),
    ).toEqual([connector]);
  });

  test("managing a permission-sync connector takes the auto-sync permission on top of its read grant", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const knowledgeBase = await makeKnowledgeBase(org.id);
    const syncConnector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
      { connectorType: "github", syncPermissionsFromSource: true },
    );
    const plainConnector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
    );
    for (const connector of [syncConnector, plainConnector]) {
      await ResourcePermissionPolicyModel.replace({
        organizationId: org.id,
        resource: "knowledgeConnector",
        scope: connector.id,
        revision: 0,
        grants: [
          {
            subject: { type: "user", id: member.id },
            actions: ["read", "use"],
          },
          {
            subject: { type: "user", id: admin.id },
            actions: ["read", "use"],
          },
        ],
      });
    }
    const context = (userId: string) =>
      knowledgeSourceAccessControlService.buildAccessControlContext({
        userId,
        organizationId: org.id,
      });

    const memberAccess = await context(member.id);
    expect(memberAccess.canManageAutoSync).toBe(false);
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(
        memberAccess,
        syncConnector,
      ),
    ).toBe(false);
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(
        memberAccess,
        plainConnector,
      ),
    ).toBe(true);
    const memberList = await KnowledgeBaseConnectorModel.findByOrganization({
      organizationId: org.id,
      canReadAll: memberAccess.canReadAll,
      canManageAutoSync: memberAccess.canManageAutoSync,
      viewerTeamIds: memberAccess.teamIds,
      viewerUserId: member.id,
    });
    expect(memberList.map((connector) => connector.id)).toEqual([
      plainConnector.id,
    ]);
    // Queries still span the sync connector for the member.
    const memberQueryable =
      await KnowledgeBaseConnectorModel.findByOrganization({
        organizationId: org.id,
        canReadAll: memberAccess.canReadAll,
        viewerTeamIds: memberAccess.teamIds,
        viewerUserId: member.id,
        visibilityScope: "query",
      });
    expect(memberQueryable.map((connector) => connector.id).sort()).toEqual(
      [syncConnector.id, plainConnector.id].sort(),
    );

    const adminAccess = await context(admin.id);
    expect(adminAccess.canManageAutoSync).toBe(true);
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(
        adminAccess,
        syncConnector,
      ),
    ).toBe(true);
    const adminList = await KnowledgeBaseConnectorModel.findByOrganization({
      organizationId: org.id,
      canReadAll: adminAccess.canReadAll,
      canManageAutoSync: adminAccess.canManageAutoSync,
      viewerTeamIds: adminAccess.teamIds,
      viewerUserId: admin.id,
    });
    expect(adminList.map((connector) => connector.id).sort()).toEqual(
      [syncConnector.id, plainConnector.id].sort(),
    );
  });

  test("filterQueryableConnectors still excludes team-scoped connectors for non-members", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const team = await makeTeam(org.id, user.id);
    const knowledgeBase = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
      {
        visibility: "team-scoped",
        teamIds: [team.id],
      },
    );

    const access =
      await knowledgeSourceAccessControlService.buildAccessControlContext({
        userId: user.id,
        organizationId: org.id,
      });

    expect(
      knowledgeSourceAccessControlService.filterQueryableConnectors(access, [
        connector,
      ]),
    ).toEqual([]);
  });

  test("builds connector document ACL from connector and assigned knowledge bases", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const teamOwner = await makeUser();
    const connectorTeam = await makeTeam(org.id, teamOwner.id, {
      name: "Connector Team",
    });
    const knowledgeBase = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
      {
        visibility: "team-scoped",
        teamIds: [connectorTeam.id],
      },
    );

    const acl =
      knowledgeSourceAccessControlService.buildConnectorDocumentAccessControlList(
        {
          connector,
        },
      );

    expect(acl).toEqual([`team:${connectorTeam.id}`]);
  });

  test("refreshes connector document ACLs across documents and chunks", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const knowledgeBase = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
    );
    const document = await KbDocumentModel.create({
      organizationId: org.id,
      sourceId: "ext-1",
      connectorId: connector.id,
      title: "Doc 1",
      content: "content",
      contentHash: "hash-1",
      acl: [],
    });
    await KbChunkModel.insertMany([
      {
        documentId: document.id,
        content: "chunk 1",
        chunkIndex: 0,
        acl: [],
      },
    ]);

    await knowledgeSourceAccessControlService.refreshConnectorDocumentAccessControlLists(
      connector.id,
    );

    const refreshedDocument = await KbDocumentModel.findById(document.id);
    const refreshedChunks = await KbChunkModel.findByDocument(document.id);

    expect(refreshedDocument?.acl).toEqual(["org:*"]);
    expect(refreshedChunks[0]?.acl).toEqual(["org:*"]);
  });

  test("does not overwrite auto-sync connector document ACLs on refresh", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const knowledgeBase = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
      {
        visibility: "auto-sync-permissions",
      },
    );
    const document = await KbDocumentModel.create({
      organizationId: org.id,
      sourceId: "ext-1",
      connectorId: connector.id,
      title: "Doc 1",
      content: "content",
      contentHash: "hash-1",
      acl: ["user_email:owner@example.com"],
    });

    await knowledgeSourceAccessControlService.refreshConnectorDocumentAccessControlLists(
      connector.id,
    );

    // The permission-sync pass owns per-doc ACLs; the bulk refresh must no-op.
    const refreshed = await KbDocumentModel.findById(document.id);
    expect(refreshed?.acl).toEqual(["user_email:owner@example.com"]);
  });
});

describe("buildDocumentAccessControlList (auto-sync-permissions)", () => {
  test("builds public ∪ user ∪ group tokens and normalizes emails", () => {
    const acl = buildDocumentAccessControlList({
      visibility: "auto-sync-permissions",
      syncPermissionsFromSource: true,
      teamIds: [],
      connectorType: "github",
      permissions: {
        isPublic: true,
        users: ["Alice@Example.com", " bob@example.com "],
        groups: ["eng"],
      },
    });

    expect(acl).toEqual([
      "org:*",
      "user_email:alice@example.com",
      "user_email:bob@example.com",
      "group:github_eng",
    ]);
  });

  test("empty permissions ⇒ empty ACL (fail-closed)", () => {
    expect(
      buildDocumentAccessControlList({
        visibility: "auto-sync-permissions",
        syncPermissionsFromSource: true,
        teamIds: [],
        connectorType: "github",
        permissions: {},
      }),
    ).toEqual([]);
    expect(
      buildDocumentAccessControlList({
        visibility: "auto-sync-permissions",
        syncPermissionsFromSource: true,
        teamIds: [],
        connectorType: "github",
      }),
    ).toEqual([]);
  });

  test("dedupes repeated principals", () => {
    const acl = buildDocumentAccessControlList({
      visibility: "auto-sync-permissions",
      syncPermissionsFromSource: true,
      teamIds: [],
      connectorType: "jira",
      permissions: {
        users: ["a@example.com", "A@example.com"],
        groups: ["dev", "dev"],
      },
    });

    expect(acl).toEqual(["user_email:a@example.com", "group:jira_dev"]);
  });

  test("drops groups when connector type is unknown", () => {
    const acl = buildDocumentAccessControlList({
      visibility: "auto-sync-permissions",
      syncPermissionsFromSource: true,
      teamIds: [],
      permissions: { users: ["a@example.com"], groups: ["eng"] },
    });

    expect(acl).toEqual(["user_email:a@example.com"]);
  });

  test("over-cap audience falls back to org:*", () => {
    const users = Array.from({ length: 1001 }, (_, i) => `u${i}@example.com`);
    const acl = buildDocumentAccessControlList({
      visibility: "auto-sync-permissions",
      syncPermissionsFromSource: true,
      teamIds: [],
      connectorType: "github",
      permissions: { users },
    });

    expect(acl).toEqual(["org:*"]);
  });
});

describe("buildUserAccessControlList", () => {
  test("includes org, normalized user email, teams, and group tokens", () => {
    const acl = buildUserAccessControlList({
      userEmail: "  User@Example.com ",
      teamIds: ["team-a"],
      groupTokens: [
        buildGroupToken({ connectorType: "github", groupId: "eng" }),
      ],
    });

    expect(acl).toEqual([
      "org:*",
      "user_email:user@example.com",
      "team:team-a",
      "group:github_eng",
    ]);
  });
});

describe("acl-tokens helpers", () => {
  test("normalizeEmail case-folds and trims", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });

  test("buildGroupToken namespaces by connector type", () => {
    expect(
      buildGroupToken({ connectorType: "confluence", groupId: "42" }),
    ).toBe("group:confluence_42");
  });
});
