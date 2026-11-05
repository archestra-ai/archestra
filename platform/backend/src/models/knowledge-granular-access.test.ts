// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import db from "@/database";
import { indexFilesIntoKnowledgeBase } from "@/knowledge-base/file-upload/index-file";
import { knowledgeSourceAccessControlService } from "@/knowledge-base/source-access-control";
import { ResourcePermissions } from "@/services/resource-permissions";
import { expect, test } from "@/test";
import type { AclEntry } from "@/types";
import KbChunkModel from "./kb-chunk";
import KbDocumentModel from "./kb-document";
import KbFileModel from "./kb-file";
import KnowledgeBaseModel from "./knowledge-base";
import KnowledgeBaseConnectorModel from "./knowledge-base-connector";
import ManagedOauthClientModel from "./managed-oauth-client";
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

test("uploaded file grants follow the knowledge base it sits in and include OAuth client grants", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeKnowledgeBase,
}) => {
  const org = await makeOrganization();
  const admin = await makeUser();
  const recipient = await makeUser();
  const outsider = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });
  await makeMember(recipient.id, org.id, { role: "member" });
  await makeMember(outsider.id, org.id, { role: "member" });

  const { oauthClient } = await ManagedOauthClientModel.create({
    organizationId: org.id,
    authorId: admin.id,
    name: "Portal client",
    grantType: "client_credentials",
    scopes: ["mcp"],
    allowedGatewayIds: [],
  });

  const kb = await makeKnowledgeBase(org.id, { access: "personal" });
  const file = await KbFileModel.create({
    organizationId: org.id,
    uploadedBy: admin.id,
    filename: "runbook.txt",
    directoryId: null,
    mimeType: "text/plain",
    sizeBytes: 7,
    contentHash: "runbook",
    data: Buffer.from("runbook"),
    initialPermissionGrants: [],
  });

  const indexed = await indexFilesIntoKnowledgeBase({
    organizationId: org.id,
    knowledgeBaseId: kb.id,
    fileIds: [file.id],
  });
  expect(indexed.indexed).toBe(1);

  const [connector] = await KnowledgeBaseConnectorModel.findByKnowledgeBaseId(
    kb.id,
    { canReadAll: true },
  );
  const document = await KbDocumentModel.findBySourceId({
    connectorId: connector.id,
    sourceId: file.id,
  });
  expect(document).not.toBeNull();
  if (!document) throw new Error("Expected indexed document");

  // Initially only the uploader has Can use on the file; recipient and OAuth client cannot read it.
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: document.id,
      organizationId: org.id,
      userAcl: ["org:*", `principal:${recipient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: document.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();

  // Granting Can use on the knowledge base to recipient and oauthClient updates chunk ACLs and live access.
  const kbPolicy = await ResourcePermissionPolicyModel.find({
    organizationId: org.id,
    resource: "knowledgeBase",
    scope: kb.id,
  });
  await ResourcePermissions.updatePolicy({
    organizationId: org.id,
    userId: admin.id,
    resource: "knowledgeBase",
    scope: kb.id,
    revision: kbPolicy?.revision ?? 0,
    grants: [
      {
        subject: { type: "user", id: recipient.id },
        actions: ["read", "use"],
      },
      {
        subject: { type: "oauthClient", id: oauthClient.id },
        actions: ["read", "use"],
      },
    ],
  });

  const chunks = await KbChunkModel.findByDocument(document.id);
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.acl).toContain(`user_email:${recipient.email}`);
    expect(chunk.acl).toContain(`oauth_client:${oauthClient.id}`);
  }

  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: document.id,
      organizationId: org.id,
      userAcl: ["org:*", `principal:${recipient.id}`],
      bypassAcl: false,
    }),
  ).toMatchObject({ id: document.id });
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: document.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toMatchObject({ id: document.id });
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: document.id,
      organizationId: org.id,
      userAcl: ["org:*", `principal:${outsider.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();

  // Revoking knowledge base grants removes access immediately.
  const updatedKbPolicy = await ResourcePermissionPolicyModel.find({
    organizationId: org.id,
    resource: "knowledgeBase",
    scope: kb.id,
  });
  await ResourcePermissions.updatePolicy({
    organizationId: org.id,
    userId: admin.id,
    resource: "knowledgeBase",
    scope: kb.id,
    revision: updatedKbPolicy?.revision ?? 0,
    grants: [],
  });

  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: document.id,
      organizationId: org.id,
      userAcl: ["org:*", `principal:${recipient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();
  // Removing the file's indexed document from the knowledge base (or moving it
  // to a different knowledge base) immediately revokes the OAuth client's
  // inherited grant from the original knowledge base.
  const regrantPolicy = await ResourcePermissionPolicyModel.find({
    organizationId: org.id,
    resource: "knowledgeBase",
    scope: kb.id,
  });
  await ResourcePermissions.updatePolicy({
    organizationId: org.id,
    userId: admin.id,
    resource: "knowledgeBase",
    scope: kb.id,
    revision: regrantPolicy?.revision ?? 0,
    grants: [
      {
        subject: { type: "oauthClient", id: oauthClient.id },
        actions: ["read", "use"],
      },
    ],
  });
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: document.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toMatchObject({ id: document.id });

  const privateTargetKb = await makeKnowledgeBase(org.id, {
    access: "personal",
  });
  await indexFilesIntoKnowledgeBase({
    organizationId: org.id,
    knowledgeBaseId: privateTargetKb.id,
    fileIds: [file.id],
  });
  await KbDocumentModel.delete(document.id);
  const [targetConnector] =
    await KnowledgeBaseConnectorModel.findByKnowledgeBaseId(
      privateTargetKb.id,
      { canReadAll: true },
    );
  const movedDocument = await KbDocumentModel.findBySourceId({
    connectorId: targetConnector.id,
    sourceId: file.id,
  });
  expect(movedDocument).not.toBeNull();
  if (!movedDocument) throw new Error("Expected moved document");
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: document.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: movedDocument.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();

  // Wildcard knowledgeBase or knowledgeFile policy updates refresh document ACLs across the organization.
  const wildcardKbPolicy = await ResourcePermissionPolicyModel.find({
    organizationId: org.id,
    resource: "knowledgeBase",
    scope: "*",
  });
  await ResourcePermissions.updatePolicy({
    organizationId: org.id,
    userId: admin.id,
    resource: "knowledgeBase",
    scope: "*",
    revision: wildcardKbPolicy?.revision ?? 0,
    grants: [
      ...(wildcardKbPolicy?.grants ?? []),
      {
        subject: { type: "oauthClient", id: oauthClient.id },
        actions: ["read", "use"],
      },
    ],
  });
  const movedChunksAfterWildcard = await KbChunkModel.findByDocument(
    movedDocument.id,
  );
  expect(
    movedChunksAfterWildcard.every((chunk) =>
      chunk.acl.includes(`oauth_client:${oauthClient.id}`),
    ),
  ).toBe(true);
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: movedDocument.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toMatchObject({ id: movedDocument.id });
});

test("connectors attached to a knowledge base inherit Can use from the knowledge base and propagate OAuth client upstream ACLs through the client creator", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeKnowledgeBase,
  makeKnowledgeBaseConnector,
}) => {
  const org = await makeOrganization();
  const admin = await makeUser();
  const recipient = await makeUser();
  const outsider = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });
  await makeMember(recipient.id, org.id, { role: "member" });
  await makeMember(outsider.id, org.id, { role: "member" });

  const { oauthClient } = await ManagedOauthClientModel.create({
    organizationId: org.id,
    authorId: admin.id,
    name: "Inherited connector client",
    grantType: "client_credentials",
    scopes: ["mcp"],
    allowedGatewayIds: [],
  });

  const kb = await makeKnowledgeBase(org.id, { access: "personal" });
  const manualConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
    access: "personal",
    syncPermissionsFromSource: false,
  });
  const upstreamConnector = await makeKnowledgeBaseConnector(kb.id, org.id, {
    access: "personal",
    syncPermissionsFromSource: true,
  });

  const manualDoc = await KbDocumentModel.create({
    organizationId: org.id,
    connectorId: manualConnector.id,
    title: "Manual doc",
    content: "manual",
    contentHash: "manual",
    acl: [],
  });
  const ownerUpstreamDoc = await KbDocumentModel.create({
    organizationId: org.id,
    connectorId: upstreamConnector.id,
    title: "Owner upstream doc",
    content: "owner-upstream",
    contentHash: "owner-upstream",
    acl: [`user_email:${admin.email}`],
  });
  const outsiderUpstreamDoc = await KbDocumentModel.create({
    organizationId: org.id,
    connectorId: upstreamConnector.id,
    title: "Outsider upstream doc",
    content: "outsider-upstream",
    contentHash: "outsider-upstream",
    acl: [`user_email:${outsider.email}`],
  });

  // Before the KB is shared, neither recipient nor oauthClient can access the documents.
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: manualDoc.id,
      organizationId: org.id,
      userAcl: ["org:*", `principal:${recipient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: manualDoc.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: ownerUpstreamDoc.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();

  // Grant Can use ONLY on the knowledge base (not on the connectors directly).
  const kbPolicy = await ResourcePermissionPolicyModel.find({
    organizationId: org.id,
    resource: "knowledgeBase",
    scope: kb.id,
  });
  await ResourcePermissions.updatePolicy({
    organizationId: org.id,
    userId: admin.id,
    resource: "knowledgeBase",
    scope: kb.id,
    revision: kbPolicy?.revision ?? 0,
    grants: [
      {
        subject: { type: "user", id: recipient.id },
        actions: ["read", "use"],
      },
      {
        subject: { type: "oauthClient", id: oauthClient.id },
        actions: ["read", "use"],
      },
    ],
  });

  // Both recipient and oauthClient can now read manualDoc via the inherited KB grant.
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: manualDoc.id,
      organizationId: org.id,
      userAcl: ["org:*", `principal:${recipient.id}`],
      bypassAcl: false,
    }),
  ).toMatchObject({ id: manualDoc.id });
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: manualDoc.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toMatchObject({ id: manualDoc.id });

  // On the permission-sync connector, oauthClient propagates upstream ACLs through its creator (admin),
  // matching ownerUpstreamDoc while blocking outsiderUpstreamDoc.
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: ownerUpstreamDoc.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toMatchObject({ id: ownerUpstreamDoc.id });
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: outsiderUpstreamDoc.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();

  // Unassigning a connector from the knowledge base immediately revokes its inherited KB grant.
  await KnowledgeBaseConnectorModel.unassignFromKnowledgeBase(
    manualConnector.id,
    kb.id,
  );
  await KnowledgeBaseConnectorModel.unassignFromKnowledgeBase(
    upstreamConnector.id,
    kb.id,
  );
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: manualDoc.id,
      organizationId: org.id,
      userAcl: ["org:*", `principal:${recipient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: manualDoc.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();
  expect(
    await KbDocumentModel.findByIdForAcl({
      documentId: ownerUpstreamDoc.id,
      organizationId: org.id,
      userAcl: ["org:*", `oauth_client:${oauthClient.id}`],
      bypassAcl: false,
    }),
  ).toBeNull();
});
