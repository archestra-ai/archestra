import { KbChunkModel, KbDocumentModel } from "@/models";
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

  test("allows org-wide knowledge sources for users with read access", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const knowledgeBase = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
    );

    const access =
      await knowledgeSourceAccessControlService.buildAccessControlContext({
        userId: user.id,
        organizationId: org.id,
      });

    expect(
      knowledgeSourceAccessControlService.canAccessKnowledgeBase(
        access,
        knowledgeBase,
      ),
    ).toBe(true);
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(access, connector),
    ).toBe(true);
  });

  test("blocks team-scoped knowledge sources when user is not in the team", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
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
      knowledgeSourceAccessControlService.canAccessKnowledgeBase(
        access,
        knowledgeBase,
      ),
    ).toBe(true);
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(access, connector),
    ).toBe(false);
  });

  test("blocks auto-sync-permissions connectors for non-admin members but keeps them queryable", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
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

  test("allows admins to manage auto-sync-permissions connectors (the role carries knowledgeSourceAutoSync by default)", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
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
        userId: admin.id,
        organizationId: org.id,
      });

    expect(
      knowledgeSourceAccessControlService.canAccessConnector(access, connector),
    ).toBe(true);
  });

  test("a custom role with knowledgeSourceAutoSync:read can access auto-sync connectors without knowledgeSource:admin", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: {
        knowledgeSource: ["read"],
        knowledgeSourceAutoSync: ["read"],
      },
    });
    await makeMember(user.id, org.id, { role: role.role });
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

    expect(access.canReadAll).toBe(false);
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(access, connector),
    ).toBe(true);
  });

  test("knowledgeSource:admin alone does NOT grant access to auto-sync connectors", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: { knowledgeSource: ["read", "admin"] },
    });
    await makeMember(user.id, org.id, { role: role.role });
    const knowledgeBase = await makeKnowledgeBase(org.id);
    const autoSyncConnector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
      {
        connectorType: "github",
        visibility: "auto-sync-permissions",
      },
    );
    const teamScopedConnector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      org.id,
      {
        visibility: "team-scoped",
        teamIds: [crypto.randomUUID()],
      },
    );

    const access =
      await knowledgeSourceAccessControlService.buildAccessControlContext({
        userId: user.id,
        organizationId: org.id,
      });

    // The view-all bypass still covers org-wide and team-scoped sources...
    expect(access.canReadAll).toBe(true);
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(
        access,
        teamScopedConnector,
      ),
    ).toBe(true);
    // ...but auto-sync surfaces expose upstream identities, so they require
    // the dedicated permission.
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(
        access,
        autoSyncConnector,
      ),
    ).toBe(false);
  });

  test("filterQueryableConnectors still excludes team-scoped connectors for non-members", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
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

  test("knowledgeSource:admin bypasses source visibility restrictions", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, admin.id);
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
        userId: admin.id,
        organizationId: org.id,
      });

    expect(access.canReadAll).toBe(true);
    expect(
      knowledgeSourceAccessControlService.canAccessKnowledgeBase(
        access,
        knowledgeBase,
      ),
    ).toBe(true);
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(access, connector),
    ).toBe(true);
  });

  test("builds connector document ACL from connector and assigned knowledge bases", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
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
    const org = await makeOrganization();
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
    const org = await makeOrganization();
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
        teamIds: [],
        connectorType: "github",
        permissions: {},
      }),
    ).toEqual([]);
    expect(
      buildDocumentAccessControlList({
        visibility: "auto-sync-permissions",
        teamIds: [],
        connectorType: "github",
      }),
    ).toEqual([]);
  });

  test("dedupes repeated principals", () => {
    const acl = buildDocumentAccessControlList({
      visibility: "auto-sync-permissions",
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
      teamIds: [],
      permissions: { users: ["a@example.com"], groups: ["eng"] },
    });

    expect(acl).toEqual(["user_email:a@example.com"]);
  });

  test("over-cap audience falls back to org:*", () => {
    const users = Array.from({ length: 1001 }, (_, i) => `u${i}@example.com`);
    const acl = buildDocumentAccessControlList({
      visibility: "auto-sync-permissions",
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
