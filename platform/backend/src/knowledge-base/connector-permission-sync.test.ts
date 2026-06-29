import { vi } from "vitest";

const mockGetConnector = vi.hoisted(() => vi.fn());
vi.mock("./connectors/registry", () => ({
  getConnector: mockGetConnector,
}));

const mockGetSecret = vi.hoisted(() => vi.fn());
vi.mock("@/secrets-manager", () => ({
  secretManager: () => ({
    getSecret: mockGetSecret,
  }),
}));

import db, { schema } from "@/database";
import {
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import { connectorSyncService } from "./connector-sync";

async function createSecret(): Promise<string> {
  const [secret] = await db
    .insert(schema.secretsTable)
    .values({ secret: { access_token: "test-secret" } })
    .returning();
  return secret.id;
}

function makeMockPermissionConnector(
  items: Array<{
    documentId: string;
    permissions: {
      isPublic: boolean;
      users: string[];
      groups: string[];
    };
  }>,
) {
  return {
    syncPermissions: vi.fn().mockImplementation(() =>
      (async function* () {
        for (const item of items) {
          yield item;
        }
      })(),
    ),
  };
}

function setupSecret(
  credentials = { email: "user@test.com", apiToken: "tok-123" },
) {
  mockGetSecret.mockResolvedValue({
    id: "secret-1",
    secret: credentials,
  });
}

describe("ConnectorPermissionSync", () => {
  test("skips sync if connector visibility is not auto-sync-permissions", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "public",
    });

    const result = await connectorSyncService.executePermissionSync(
      connector.id,
    );
    expect(result.status).toBe("skipped");
    expect(result.processed).toBe(0);
    expect(result.updated).toBe(0);
  });

  test("executePermissionSync updates ACL and chunks without changing contentHash or re-embedding", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
    });
    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    setupSecret();

    // Create org member user to resolve user email
    const user = await makeUser({ email: "user1@example.com" });
    await makeMember(user.id, org.id, { role: "member" });

    // Pre-create document and chunk with original ACL and content hash
    const content = "Doc 1 content";
    const contentHash = "original-content-hash";
    const existingDoc = await KbDocumentModel.create({
      organizationId: org.id,
      sourceId: "ext-1",
      connectorId: connector.id,
      title: "Doc 1",
      content,
      contentHash,
      embeddingStatus: "completed",
      acl: ["org:*"],
    });

    await KbChunkModel.insertMany([
      {
        documentId: existingDoc.id,
        content: "chunk 1",
        chunkIndex: 0,
        acl: ["org:*"],
      },
    ]);

    const mockImpl = makeMockPermissionConnector([
      {
        documentId: "ext-1",
        permissions: {
          isPublic: false,
          users: ["user1@example.com"],
          groups: [],
        },
      },
    ]);
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executePermissionSync(
      connector.id,
    );
    expect(result.status).toBe("success");
    expect(result.processed).toBe(1);
    expect(result.updated).toBe(1);

    // Verify document ACL updated but contentHash and embeddingStatus are intact
    const doc = await KbDocumentModel.findById(existingDoc.id);
    expect(doc?.acl).toEqual(["user_email:user1@example.com"]);
    expect(doc?.permissionSyncStatus).toBe("synced");
    expect(doc?.contentHash).toBe(contentHash);
    expect(doc?.embeddingStatus).toBe("completed");

    // Verify chunk ACL updated
    const chunks = await KbChunkModel.findByDocument(existingDoc.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].acl).toEqual(["user_email:user1@example.com"]);
  });

  test("executePermissionSync sets skipped_unresolvable and clears ACL (fail-closed) when unmapped groups are returned", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
    });
    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    setupSecret();

    // Pre-create document and chunk
    const existingDoc = await KbDocumentModel.create({
      organizationId: org.id,
      sourceId: "ext-1",
      connectorId: connector.id,
      title: "Doc 1",
      content: "Content",
      contentHash: "hash-123",
      embeddingStatus: "completed",
      acl: ["org:*"],
    });

    await KbChunkModel.insertMany([
      {
        documentId: existingDoc.id,
        content: "chunk 1",
        chunkIndex: 0,
        acl: ["org:*"],
      },
    ]);

    const mockImpl = makeMockPermissionConnector([
      {
        documentId: "ext-1",
        permissions: {
          isPublic: false,
          users: [],
          groups: ["unmapped-group"],
        },
      },
    ]);
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executePermissionSync(
      connector.id,
    );
    expect(result.status).toBe("success");
    expect(result.processed).toBe(1);
    expect(result.updated).toBe(1);

    const doc = await KbDocumentModel.findById(existingDoc.id);
    expect(doc?.acl).toEqual([]);
    expect(doc?.permissionSyncStatus).toBe("skipped_unresolvable");

    const chunks = await KbChunkModel.findByDocument(existingDoc.id);
    expect(chunks[0].acl).toEqual([]);
  });

  test("executePermissionSync sets skipped_unresolvable and clears ACL (fail-closed) for orphaned documents", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
    });
    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    setupSecret();

    // Pre-create two documents: doc-1 (will be returned) and doc-2 (orphaned)
    const doc1 = await KbDocumentModel.create({
      organizationId: org.id,
      sourceId: "ext-1",
      connectorId: connector.id,
      title: "Doc 1",
      content: "Content 1",
      contentHash: "hash-1",
      embeddingStatus: "completed",
      acl: [],
    });

    const doc2 = await KbDocumentModel.create({
      organizationId: org.id,
      sourceId: "ext-2",
      connectorId: connector.id,
      title: "Doc 2",
      content: "Content 2",
      contentHash: "hash-2",
      embeddingStatus: "completed",
      acl: ["org:*"],
    });

    await KbChunkModel.insertMany([
      {
        documentId: doc1.id,
        content: "chunk 1",
        chunkIndex: 0,
        acl: [],
      },
      {
        documentId: doc2.id,
        content: "chunk 2",
        chunkIndex: 0,
        acl: ["org:*"],
      },
    ]);

    // Only return ext-1 in syncPermissions
    const mockImpl = makeMockPermissionConnector([
      {
        documentId: "ext-1",
        permissions: {
          isPublic: true,
          users: [],
          groups: [],
        },
      },
    ]);
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executePermissionSync(
      connector.id,
    );
    expect(result.status).toBe("success");
    expect(result.processed).toBe(1);
    // Both doc-1 (publicly synced) and doc-2 (orphaned, cleared) are updated.
    expect(result.updated).toBe(2);

    // Verify doc-1 is successfully synced (public)
    const updatedDoc1 = await KbDocumentModel.findById(doc1.id);
    expect(updatedDoc1?.acl).toEqual(["org:*"]);
    expect(updatedDoc1?.permissionSyncStatus).toBe("synced");

    // Verify doc-2 is marked skipped_unresolvable and ACL is cleared
    const updatedDoc2 = await KbDocumentModel.findById(doc2.id);
    expect(updatedDoc2?.acl).toEqual([]);
    expect(updatedDoc2?.permissionSyncStatus).toBe("skipped_unresolvable");
    expect(updatedDoc2?.permissionSyncMetadata).toEqual(
      expect.objectContaining({
        error: "Document no longer returned by upstream permissions scan",
      }),
    );

    // Verify chunks ACLs
    const chunks1 = await KbChunkModel.findByDocument(doc1.id);
    expect(chunks1[0].acl).toEqual(["org:*"]);

    const chunks2 = await KbChunkModel.findByDocument(doc2.id);
    expect(chunks2[0].acl).toEqual([]);
  });
});
