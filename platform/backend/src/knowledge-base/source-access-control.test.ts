import { KbChunkModel, KbDocumentModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
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
});
