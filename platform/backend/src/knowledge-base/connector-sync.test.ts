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
    { content: "chunk 1", chunkIndex: 0 },
    { content: "chunk 2", chunkIndex: 1 },
  ]),
);
vi.mock("./chunker", () => ({
  chunkDocument: mockChunkDocument,
}));

import { createHash } from "node:crypto";
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

  test("executeSync throws when connector not found", async () => {
    await expect(
      connectorSyncService.executeSync("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("Connector not found");
  });

  test("executeSync throws when connector not assigned to any KB", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // Create connector directly without KB assignment
    const connector = await KnowledgeBaseConnectorModel.create({
      organizationId: org.id,
      name: "Orphan Connector",
      connectorType: "jira",
      config: {
        type: "jira",
        jiraBaseUrl: "https://test.atlassian.net",
        isCloud: true,
        projectKey: "TEST",
      },
    });

    await expect(
      connectorSyncService.executeSync(connector.id),
    ).rejects.toThrow("not assigned to any knowledge base");
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
  });

  test("executeSync creates chunks for new documents", async ({
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
      { id: "ext-1", title: "Doc 1", content: "Content for chunking" },
    ]);
    mockGetConnector.mockReturnValue(mockImpl);

    await connectorSyncService.executeSync(connector.id);

    // Verify chunkDocument was called
    expect(mockChunkDocument).toHaveBeenCalledWith({
      title: "Doc 1",
      content: "Content for chunking",
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
  });
});
