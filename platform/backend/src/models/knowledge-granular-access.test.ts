// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import db from "@/database";
import { knowledgeSourceAccessControlService } from "@/knowledge-base/source-access-control";
import { expect, test } from "@/test";
import type { AclEntry } from "@/types";
import KbChunkModel from "./kb-chunk";
import KbDocumentModel from "./kb-document";
import KbFileModel from "./kb-file";
import KnowledgeBaseModel from "./knowledge-base";
import KnowledgeBaseConnectorModel from "./knowledge-base-connector";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

for (const resource of ["knowledgeFile", "knowledgeConnector"] as const) {
  test(`${resource}: grants and revocation govern indexed content without reindexing`, async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const recipient = await makeUser();
    const outsider = await makeUser();
    for (const user of [owner, recipient, outsider])
      await makeMember(user.id, org.id);
    const kb = await makeKnowledgeBase(org.id);
    // For a file, the file's own grants decide and the connector stays
    // private; for a connector, its grant is the one under test.
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      access:
        resource === "knowledgeConnector"
          ? { users: [recipient.id], preset: "use" }
          : "personal",
    });
    const grant = {
      subject: { type: "user" as const, id: recipient.id },
      actions: ["read" as const, "use" as const],
    };
    const file =
      resource === "knowledgeFile"
        ? await KbFileModel.create({
            organizationId: org.id,
            uploadedBy: owner.id,
            filename: "policy.txt",
            directoryId: null,
            mimeType: "text/plain",
            sizeBytes: 6,
            contentHash: "policy",
            data: Buffer.from("policy"),
            initialPermissionGrants: [grant],
          })
        : null;
    const scope = file?.id ?? connector.id;
    // Stale public tokens must not keep exposing a document after migration.
    const document = await KbDocumentModel.create({
      organizationId: org.id,
      connectorId: connector.id,
      title: "Policy",
      content: "policy",
      contentHash: "policy",
      acl: ["org:*"],
    });
    if (file)
      await KbFileModel.linkDocument({
        kbFileId: file.id,
        kbDocumentId: document.id,
      });
    await KbChunkModel.insertMany([
      {
        documentId: document.id,
        chunkIndex: 0,
        content: "policy",
        acl: ["org:*"],
      },
    ]);
    const userAcl = (id: string): AclEntry[] => ["org:*", `principal:${id}`];
    const readDocument = (id: string) =>
      KbDocumentModel.findByIdForAcl({
        documentId: document.id,
        organizationId: org.id,
        userAcl: userAcl(id),
        bypassAcl: false,
      });
    const neighbors = (id: string) =>
      KbChunkModel.findNeighbors({
        anchors: [{ documentId: document.id, chunkIndex: 1 }],
        radius: 1,
        userAcl: userAcl(id),
      });
    expect(await readDocument(recipient.id)).toMatchObject({ id: document.id });
    expect(await neighbors(recipient.id)).toHaveLength(1);
    expect(await readDocument(outsider.id)).toBeNull();
    expect(await neighbors(outsider.id)).toHaveLength(0);
    if (file) {
      const viewer = { userId: recipient.id, teamIds: [], canManageAll: false };
      expect(
        await KbFileModel.findById({
          id: file.id,
          organizationId: org.id,
          viewer,
        }),
      ).toMatchObject({ id: file.id });
      expect(
        (
          await KbFileModel.findPaginated({
            organizationId: org.id,
            viewer,
            limit: 10,
            offset: 0,
          })
        ).total,
      ).toBe(1);
    }
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource,
      scope,
    });
    await ResourcePermissionPolicyModel.replace({
      organizationId: org.id,
      resource,
      scope,
      revision: policy?.revision ?? 0,
      grants: [{ ...grant, actions: ["read"] }],
    });
    // Can view permits repository browsing, not using content in an agent answer.
    expect(await readDocument(recipient.id)).toBeNull();
    expect(await neighbors(recipient.id)).toHaveLength(0);
    const current = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource,
      scope,
    });
    await ResourcePermissionPolicyModel.replace({
      organizationId: org.id,
      resource,
      scope,
      revision: current?.revision ?? 0,
      grants: [],
    });
    expect(await readDocument(recipient.id)).toBeNull();
    if (file)
      expect(
        await KbFileModel.findById({
          id: file.id,
          organizationId: org.id,
          viewer: { userId: recipient.id, teamIds: [], canManageAll: false },
        }),
      ).toBeNull();
  });
}

test("knowledge listing and source checks honor grants to private objects and revoke stale organization visibility", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
}) => {
  const org = await makeOrganization();
  const recipient = await makeUser();
  const outsider = await makeUser();
  for (const user of [recipient, outsider]) await makeMember(user.id, org.id);
  const kb = await makeKnowledgeBase(org.id);
  const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
    access: { users: [recipient.id], preset: "use" },
  });
  await db.transaction((tx) =>
    ResourcePermissionPolicyModel.createInitial({
      tx,
      organizationId: org.id,
      resource: "knowledgeBase",
      scope: kb.id,
      authorId: null,
      grants: [
        {
          subject: { type: "user", id: recipient.id },
          actions: ["read", "use"],
        },
      ],
    }),
  );
  for (const user of [recipient, outsider]) {
    const access =
      await knowledgeSourceAccessControlService.buildAccessControlContext({
        organizationId: org.id,
        userId: user.id,
      });
    const expected = user.id === recipient.id;
    expect(
      knowledgeSourceAccessControlService.canAccessKnowledgeBase(access, kb),
    ).toBe(expected);
    expect(
      knowledgeSourceAccessControlService.canAccessConnector(access, connector),
    ).toBe(expected);
    const filters = {
      organizationId: org.id,
      viewerUserId: user.id,
      viewerTeamIds: [],
      canReadAll: false,
    };
    expect(await KnowledgeBaseModel.findByOrganization(filters)).toHaveLength(
      expected ? 1 : 0,
    );
    expect(await KnowledgeBaseModel.countByOrganization(filters)).toBe(
      expected ? 1 : 0,
    );
    expect(
      await KnowledgeBaseConnectorModel.findByOrganization(filters),
    ).toHaveLength(expected ? 1 : 0);
  }
});

test("source permission sync keeps its per-document restriction even when connector access is granted", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id);
  const kb = await makeKnowledgeBase(org.id);
  // The user holds full access to the connector itself.
  const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
    syncPermissionsFromSource: true,
    access: { users: [user.id], preset: "manage" },
  });
  const document = await KbDocumentModel.create({
    organizationId: org.id,
    connectorId: connector.id,
    title: "Restricted upstream",
    content: "restricted",
    contentHash: "restricted",
    acl: [],
  });
  const params = {
    documentId: document.id,
    organizationId: org.id,
    bypassAcl: false,
  };
  expect(
    await KbDocumentModel.findByIdForAcl({
      ...params,
      userAcl: ["org:*", `principal:${user.id}`],
    }),
  ).toBeNull();
  await KbDocumentModel.update(document.id, {
    acl: [`user_email:${user.email}`],
  });
  expect(
    await KbDocumentModel.findByIdForAcl({
      ...params,
      userAcl: [`user_email:${user.email}`, `principal:${user.id}`],
    }),
  ).toMatchObject({ id: document.id });
});
