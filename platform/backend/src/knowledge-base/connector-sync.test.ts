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

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue("task-id-123"));
vi.mock("@/task-queue", () => ({
  taskQueueService: {
    enqueue: mockEnqueue,
  },
}));

const mockChunkDocument = vi.hoisted(() =>
  vi.fn().mockResolvedValue([
    {
      content: "chunk 1",
      chunkIndex: 0,
      metadataSuffixSemantic: null,
      metadataSuffixKeyword: null,
    },
    {
      content: "chunk 2",
      chunkIndex: 1,
      metadataSuffixSemantic: null,
      metadataSuffixKeyword: null,
    },
  ]),
);
vi.mock("./chunker", () => ({
  chunkDocument: mockChunkDocument,
}));

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  ConnectorRunModel,
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

function makeMockConnector(
  documents: Array<{
    id: string;
    title: string;
    content: string;
    sourceUrl?: string;
  }>,
  options?: { hasMore?: boolean },
) {
  return {
    estimateTotalItems: vi.fn().mockResolvedValue(documents.length),
    sync: vi.fn().mockImplementation(() =>
      (async function* () {
        yield {
          documents,
          checkpoint: { page: 1 },
          hasMore: options?.hasMore ?? false,
        };
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

describe("ConnectorSyncService", () => {
  test("executeSync processes documents from connector", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    setupSecret();
    const mockImpl = makeMockConnector([
      { id: "ext-1", title: "Doc 1", content: "Content of doc 1" },
      { id: "ext-2", title: "Doc 2", content: "Content of doc 2" },
    ]);
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executeSync(connector.id);

    expect(result.status).toBe("success");

    // Run stays "running" until batch_embedding tasks finalize it
    const run = await ConnectorRunModel.findById(result.runId);
    expect(run?.status).toBe("running");
    expect(run?.documentsProcessed).toBe(2);
    expect(run?.documentsIngested).toBe(2);
    expect(run?.totalBatches).toBe(1);

    // Connector stays "running" — the last batch_embedding task sets "success"
    const updated = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(updated?.lastSyncStatus).toBe("running");
  });

  test("sub-resource fallbacks stay warnings: a run that ingested every document is a success", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    setupSecret();
    // A connector that degraded gracefully mid-fetch (safeItemFetch fallback,
    // e.g. one issue's comments couldn't load) but still produced and ingested
    // every document. An admin has nothing to fix — the run must NOT read
    // "completed with errors"; the details live in the run logs.
    const mockImpl = {
      estimateTotalItems: vi.fn().mockResolvedValue(1),
      sync: vi.fn().mockImplementation(() =>
        (async function* () {
          yield {
            documents: [{ id: "ext-1", title: "Doc 1", content: "Content" }],
            failures: [
              { itemId: "ext-1", resource: "comments", error: "HTTP 403" },
            ],
            checkpoint: { page: 1 },
            hasMore: false,
          };
        })(),
      ),
    };
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executeSync(connector.id);

    expect(result.status).toBe("success");
    const run = await ConnectorRunModel.findById(result.runId);
    expect(run?.itemErrors).toBe(0);
    expect(run?.documentsIngested).toBe(1);
  });

  test("executeSync throws when connector not found", async () => {
    await expect(
      connectorSyncService.executeSync("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("Connector not found");
  });

  test("executeSync skips unchanged documents (same content hash)", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    // Pre-create a document with same content
    const content = "Content of doc 1";
    const contentHash = createHash("sha256").update(content).digest("hex");

    await KbDocumentModel.create({
      organizationId: org.id,
      sourceId: "ext-1",
      connectorId: connector.id,
      title: "Doc 1",
      content,
      contentHash,
    });
    const existingDoc = await KbDocumentModel.findBySourceId({
      connectorId: connector.id,
      sourceId: "ext-1",
    });

    if (!existingDoc) {
      expect.fail("Existing document not found");
      return;
    }

    await KbChunkModel.insertMany([
      { documentId: existingDoc.id, content: "chunk 1", chunkIndex: 0 },
    ]);

    setupSecret();
    const mockImpl = makeMockConnector([
      { id: "ext-1", title: "Doc 1", content },
    ]);
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executeSync(connector.id);

    expect(result.status).toBe("success");

    const run = await ConnectorRunModel.findById(result.runId);
    expect(run?.documentsProcessed).toBe(1);
    expect(run?.documentsIngested).toBe(0); // Skipped because unchanged
  });

  test("executeSync updates document when content hash changes", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    // Pre-create a document with OLD content
    const existingDoc = await KbDocumentModel.create({
      organizationId: org.id,
      sourceId: "ext-1",
      connectorId: connector.id,
      title: "Doc 1",
      content: "Old content",
      contentHash: "old-hash",
    });

    // Create some old chunks that should be replaced
    await KbChunkModel.insertMany([
      { documentId: existingDoc.id, content: "old chunk", chunkIndex: 0 },
    ]);

    setupSecret();
    const mockImpl = makeMockConnector([
      { id: "ext-1", title: "Doc 1 Updated", content: "New content" },
    ]);
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executeSync(connector.id);

    expect(result.status).toBe("success");

    const run = await ConnectorRunModel.findById(result.runId);
    expect(run?.documentsIngested).toBe(1);

    // Verify document was updated
    const doc = await KbDocumentModel.findById(existingDoc.id);
    expect(doc?.title).toBe("Doc 1 Updated");
    expect(doc?.content).toBe("New content");
    expect(doc?.embeddingStatus).toBe("pending");
    expect(doc?.acl).toEqual(["org:*"]);

    const chunks = await KbChunkModel.findByDocument(existingDoc.id);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.acl.includes("org:*"))).toBe(true);
  });

  test("auto-sync connector: content-sync creates documents fail-closed (acl=[])", async ({
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
    mockGetConnector.mockReturnValue(
      makeMockConnector([{ id: "ext-1", title: "Doc 1", content: "content" }]),
    );

    await connectorSyncService.executeSync(connector.id);

    const doc = await KbDocumentModel.findBySourceId({
      connectorId: connector.id,
      sourceId: "ext-1",
    });
    // The permission-sync pass owns ACLs; content-sync must fail-close on create.
    expect(doc?.acl).toEqual([]);
    const chunks = await KbChunkModel.findByDocument(doc?.id ?? "");
    expect(chunks.every((chunk) => chunk.acl.length === 0)).toBe(true);
  });

  test("auto-sync connector: content re-ingest copies the permission ACL forward", async ({
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

    // A document the permission-sync pass already tagged with a per-doc ACL.
    const existingDoc = await KbDocumentModel.create({
      organizationId: org.id,
      sourceId: "ext-1",
      connectorId: connector.id,
      title: "Doc 1",
      content: "Old content",
      contentHash: "old-hash",
      acl: ["user_email:alice@example.com"],
    });
    await KbChunkModel.insertMany([
      {
        documentId: existingDoc.id,
        content: "old chunk",
        chunkIndex: 0,
        acl: ["user_email:alice@example.com"],
      },
    ]);

    setupSecret();
    mockGetConnector.mockReturnValue(
      makeMockConnector([
        { id: "ext-1", title: "Doc 1 Updated", content: "New content" },
      ]),
    );

    await connectorSyncService.executeSync(connector.id);

    // Content changed, but the permission-pass ACL must be preserved, not
    // clobbered to the empty connector-level ACL.
    const doc = await KbDocumentModel.findById(existingDoc.id);
    expect(doc?.content).toBe("New content");
    expect(doc?.acl).toEqual(["user_email:alice@example.com"]);
    const chunks = await KbChunkModel.findByDocument(existingDoc.id);
    expect(
      chunks.every((chunk) =>
        chunk.acl.includes("user_email:alice@example.com"),
      ),
    ).toBe(true);
  });

  test("executeSync repairs unchanged documents that have no chunks", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    const content = "Content of doc 1";
    const contentHash = createHash("sha256").update(content).digest("hex");

    const existingDoc = await KbDocumentModel.create({
      organizationId: org.id,
      sourceId: "ext-1",
      connectorId: connector.id,
      title: "Doc 1",
      content,
      contentHash,
      embeddingStatus: "pending",
    });

    setupSecret();
    const mockImpl = makeMockConnector([
      { id: "ext-1", title: "Doc 1", content },
    ]);
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executeSync(connector.id);

    expect(result.status).toBe("success");

    const run = await ConnectorRunModel.findById(result.runId);
    expect(run?.documentsProcessed).toBe(1);
    expect(run?.documentsIngested).toBe(1);

    const repairedChunks = await KbChunkModel.findByDocument(existingDoc.id);
    expect(repairedChunks).toHaveLength(2);

    const repairedDoc = await KbDocumentModel.findById(existingDoc.id);
    expect(repairedDoc?.embeddingStatus).toBe("pending");
  });

  test("executeSync marks run as failed when sync generator throws", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    setupSecret();
    const mockImpl = {
      estimateTotalItems: vi.fn().mockResolvedValue(0),
      sync: vi.fn().mockImplementation(() =>
        (async function* () {
          yield* []; // biome: generator must contain yield
          throw new Error("Connection failed");
        })(),
      ),
    };
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executeSync(connector.id);

    expect(result.status).toBe("failed");

    const run = await ConnectorRunModel.findById(result.runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("Connection failed");

    const updated = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(updated?.lastSyncStatus).toBe("failed");
    expect(updated?.lastSyncError).toContain("Connection failed");
  });

  test("executeSync enqueues embedding tasks for ingested documents", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    setupSecret();
    const mockImpl = makeMockConnector([
      { id: "ext-1", title: "Doc 1", content: "Content" },
    ]);
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executeSync(connector.id);

    expect(result.status).toBe("success");

    // Verify embedding was enqueued as a task
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: "batch_embedding",
        payload: expect.objectContaining({
          connectorRunId: result.runId,
        }),
      }),
    );

    const run = await ConnectorRunModel.findById(result.runId);
    expect(run?.documentsIngested).toBe(1);
    expect(run?.totalBatches).toBe(1);
  });

  test("executeSync stops early when time budget exceeded", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    setupSecret();
    // Connector reports hasMore=true
    const mockImpl = makeMockConnector(
      [{ id: "ext-1", title: "Doc 1", content: "Content" }],
      { hasMore: true },
    );
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executeSync(connector.id, {
      maxDurationMs: 1, // Very short timeout — elapsed will exceed 0.9ms after DB ops
    });

    expect(result.status).toBe("partial");

    const run = await ConnectorRunModel.findById(result.runId);
    expect(run?.status).toBe("partial");

    const updatedConnector = await KnowledgeBaseConnectorModel.findById(
      connector.id,
    );
    expect(updatedConnector?.checkpoint).toEqual({ page: 1 });
  });

  test("executeSync strips NUL bytes from extracted text before persisting", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    setupSecret();
    // Binary text extraction (e.g. PDFs) can emit NUL bytes, which Postgres text
    // columns reject — without sanitization the whole document insert fails and
    // the document is lost as an item error.
    const mockImpl = makeMockConnector([
      {
        id: "ext-1",
        title: "Title\u0000With\u0000Nuls",
        content: "Before\u0000After\u0000End",
      },
    ]);
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executeSync(connector.id);

    expect(result.status).toBe("success");

    // Ingest succeeded (would be 0 ingested / 1 item error if the insert threw).
    const run = await ConnectorRunModel.findById(result.runId);
    expect(run?.documentsIngested).toBe(1);
    expect(run?.itemErrors).toBe(0);

    const doc = await KbDocumentModel.findBySourceId({
      connectorId: connector.id,
      sourceId: "ext-1",
    });
    expect(doc?.content).toBe("BeforeAfterEnd");
    expect(doc?.title).toBe("TitleWithNuls");
    expect(doc?.content).not.toContain("\u0000");
  });

  test("executeSync creates chunks for new documents", async ({
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
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "team-scoped",
      teamIds: [connectorTeam.id],
    });

    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });

    setupSecret();
    const mockImpl = makeMockConnector([
      { id: "ext-1", title: "Doc 1", content: "Content for chunking" },
    ]);
    mockGetConnector.mockReturnValue(mockImpl);

    await connectorSyncService.executeSync(connector.id);

    // Verify chunkDocument was called with document metadata (no connectorType)
    expect(mockChunkDocument).toHaveBeenCalledWith({
      title: "Doc 1",
      content: "Content for chunking",
      metadata: undefined,
    });

    // Verify chunks were stored
    const doc = await KbDocumentModel.findBySourceId({
      connectorId: connector.id,
      sourceId: "ext-1",
    });

    if (!doc) {
      expect.fail("Document not found");
      return;
    }

    const chunks = await KbChunkModel.findByDocument(doc.id);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe("chunk 1");
    expect(chunks[1].content).toBe("chunk 2");
    expect(doc.acl).toEqual([`team:${connectorTeam.id}`]);
    expect(chunks[0].acl).toEqual([`team:${connectorTeam.id}`]);
    expect(chunks[1].acl).toEqual([`team:${connectorTeam.id}`]);
  });

  test("stops before ingesting the next batch when the run is reclaimed mid-sync", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });
    setupSecret();

    // A connector that yields two batches; between them a reaper reclaims the run
    // (status -> partial, epoch bumped), simulating a lost lease mid-sync. The
    // batch-boundary lease check must then fence the second batch's writes.
    const mockImpl = {
      estimateTotalItems: vi.fn().mockResolvedValue(2),
      sync: vi.fn().mockImplementation(() =>
        (async function* () {
          yield {
            documents: [{ id: "doc-a", title: "A", content: "Body A" }],
            checkpoint: { page: 1 },
            hasMore: true,
          };
          await db.execute(sql`
            UPDATE connector_runs
            SET status = 'partial', lease_epoch = lease_epoch + 1
            WHERE connector_id = ${connector.id} AND status = 'running'
          `);
          yield {
            documents: [{ id: "doc-b", title: "B", content: "Body B" }],
            checkpoint: { page: 2 },
            hasMore: false,
          };
        })(),
      ),
    };
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executeSync(connector.id);

    expect(result.status).toBe("superseded");
    // Batch 1's document was ingested before the reclaim; batch 2's was fenced out.
    expect(
      await KbDocumentModel.findBySourceId({
        connectorId: connector.id,
        sourceId: "doc-a",
      }),
    ).not.toBeNull();
    expect(
      await KbDocumentModel.findBySourceId({
        connectorId: connector.id,
        sourceId: "doc-b",
      }),
    ).toBeNull();
  });

  test("re-reads visibility at ACL-write time: a mid-run flip to auto-sync fail-closes later docs", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    // Starts org-wide, so content-sync authors ["org:*"].
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "org-wide",
    });
    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });
    setupSecret();

    // Two batches; the connector's visibility flips to auto-sync between them
    // (an admin change mid-run). No ACL writer may trust a start-of-run snapshot,
    // so the second batch must be authored under the CURRENT (auto-sync) mode.
    const mockImpl = {
      supportsPermissionSync: false,
      estimateTotalItems: vi.fn().mockResolvedValue(2),
      sync: vi.fn().mockImplementation(() =>
        (async function* () {
          yield {
            documents: [{ id: "ext-1", title: "Doc 1", content: "c1" }],
            checkpoint: { page: 1 },
            hasMore: true,
          };
          await KnowledgeBaseConnectorModel.update(connector.id, {
            visibility: "auto-sync-permissions",
          });
          yield {
            documents: [{ id: "ext-2", title: "Doc 2", content: "c2" }],
            checkpoint: { page: 2 },
            hasMore: false,
          };
        })(),
      ),
    };
    mockGetConnector.mockReturnValue(mockImpl);

    await connectorSyncService.executeSync(connector.id);

    const doc1 = await KbDocumentModel.findBySourceId({
      connectorId: connector.id,
      sourceId: "ext-1",
    });
    const doc2 = await KbDocumentModel.findBySourceId({
      connectorId: connector.id,
      sourceId: "ext-2",
    });
    // Batch 1 authored under org-wide; batch 2's write-time re-read saw auto-sync
    // and became a no-op author → the doc is fail-closed ([]) for the permission
    // pass to tag, not left over-granted with ["org:*"].
    expect(doc1?.acl).toEqual(["org:*"]);
    expect(doc2?.acl).toEqual([]);
  });

  test("an ingest-free auto-sync sync (zero batches) still enqueues a permission pass on finalize", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const { default: config } = await import("@/config");
    config.kb.autoSyncPermissionsEnabled = true;
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const secretId = await createSecret();
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
    });
    await KnowledgeBaseConnectorModel.update(connector.id, { secretId });
    setupSecret();
    // Nothing to ingest: the run finalizes immediately (no embedding batches),
    // the path that previously skipped the trigger and stranded fail-closed
    // docs from an earlier interrupted sync until the next scheduled tick.
    const mockImpl = makeMockConnector([]);
    (mockImpl as { supportsPermissionSync?: boolean }).supportsPermissionSync =
      true;
    mockGetConnector.mockReturnValue(mockImpl);

    const result = await connectorSyncService.executeSync(connector.id);
    expect(result.status).toBe("success");

    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "permission_sync",
      payload: { connectorId: connector.id },
    });
  });
});
