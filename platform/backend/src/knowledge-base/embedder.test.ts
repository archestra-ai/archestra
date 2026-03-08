import { vi } from "vitest";

const mockEmbeddingsCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: [],
  }),
);

vi.mock("openai", () => {
  class MockOpenAI {
    embeddings = { create: mockEmbeddingsCreate };
  }
  return { default: MockOpenAI };
});

vi.mock("@/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/config")>();
  return {
    ...original,
    default: {
      ...original.default,
      kb: { openaiApiKey: "test-api-key" },
    },
  };
});

import { KbChunkModel, KbDocumentModel } from "@/models";
import { describe, expect, test } from "@/test";

// Import after mocks are set up
import { embeddingService } from "./embedder";

function makeFakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (seed + i) * 0.001);
}

describe("EmbeddingService", () => {
  test("processes pending document — chunks get embeddings, status completed", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Test Doc",
      content: "Some content",
      contentHash: "hash1",
      embeddingStatus: "pending",
    });

    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "Chunk one content",
        chunkIndex: 0,
      },
      {
        documentId: doc.id,
        content: "Chunk two content",
        chunkIndex: 1,
      },
    ]);

    const emb0 = makeFakeEmbedding(1);
    const emb1 = makeFakeEmbedding(2);
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: emb0 }, { embedding: emb1 }],
    });

    await embeddingService.processDocument(doc.id);

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("completed");
    expect(updated?.chunkCount).toBe(2);

    const chunks = await KbChunkModel.findByDocument(doc.id);
    expect(chunks[0].embedding).toHaveLength(1536);
    expect(chunks[1].embedding).toHaveLength(1536);
    // Verify first few values survive the round-trip through vector column
    expect(chunks[0].embedding?.[0]).toBeCloseTo(emb0[0], 4);
    expect(chunks[1].embedding?.[0]).toBeCloseTo(emb1[0], 4);

    expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["Chunk one content", "Chunk two content"],
    });
  });

  test("OpenAI failure marks document as failed", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Fail Doc",
      content: "Content",
      contentHash: "hash2",
      embeddingStatus: "pending",
    });

    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "Some chunk",
        chunkIndex: 0,
      },
    ]);

    mockEmbeddingsCreate.mockRejectedValueOnce(new Error("API rate limited"));

    await embeddingService.processDocument(doc.id);

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("failed");
  });

  test("no chunks marks document as completed with chunkCount 0", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Empty Doc",
      content: "Content but no chunks",
      contentHash: "hash3",
      embeddingStatus: "pending",
    });

    await embeddingService.processDocument(doc.id);

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("completed");
    expect(updated?.chunkCount).toBe(0);
    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
  });

  test("already-completed document is skipped", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Done Doc",
      content: "Already done",
      contentHash: "hash4",
      embeddingStatus: "completed",
      chunkCount: 5,
    });

    await embeddingService.processDocument(doc.id);

    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
  });

  test("processPendingDocuments processes multiple documents", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    const doc1 = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Doc 1",
      content: "Content 1",
      contentHash: "hash5",
      embeddingStatus: "pending",
    });

    const doc2 = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Doc 2",
      content: "Content 2",
      contentHash: "hash6",
      embeddingStatus: "pending",
    });

    // Both docs have no chunks, so they'll complete with chunkCount 0
    await embeddingService.processPendingDocuments();

    const updated1 = await KbDocumentModel.findById(doc1.id);
    const updated2 = await KbDocumentModel.findById(doc2.id);
    expect(updated1?.embeddingStatus).toBe("completed");
    expect(updated2?.embeddingStatus).toBe("completed");
  });

  test("concurrency guard prevents double processing", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Slow Doc",
      content: "Slow content",
      contentHash: "hash7",
      embeddingStatus: "pending",
    });

    // Simulate slow processing by making the first call block
    let resolveFirst: (() => void) | undefined;
    const firstCallPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const originalFindPending = KbDocumentModel.findPending;
    let callCount = 0;
    vi.spyOn(KbDocumentModel, "findPending").mockImplementation(
      async (params) => {
        callCount++;
        if (callCount === 1) {
          await firstCallPromise;
        }
        return originalFindPending.call(KbDocumentModel, params);
      },
    );

    // Start first processing (will block on findPending)
    const first = embeddingService.processPendingDocuments();
    // Immediately start second processing — should be skipped due to guard
    const second = embeddingService.processPendingDocuments();

    // Unblock the first call
    resolveFirst?.();

    await Promise.all([first, second]);

    // findPending should only have been called once (the second call was skipped)
    expect(callCount).toBe(1);
  });
});
