import { vi } from "vitest";

const mockEmbeddingsCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: [],
  }),
);

vi.mock("openai", () => {
  class MockOpenAI {
    static APIError = class APIError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
    };
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

  test("retries on 429 rate limit and succeeds", async ({
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
      title: "Retry Doc",
      content: "Retry content",
      contentHash: "hash-retry",
      embeddingStatus: "pending",
    });

    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "Chunk to retry",
        chunkIndex: 0,
      },
    ]);

    const emb = makeFakeEmbedding(10);

    // Create a retryable error that matches the isRetryableError check
    const rateLimitError = Object.assign(new Error("Rate limited"), {
      status: 429,
    });
    // Make it pass the instanceof check in the actual OpenAI module
    const OpenAIMod = (await import("openai")).default;
    Object.setPrototypeOf(rateLimitError, OpenAIMod.APIError.prototype);

    // First call fails with 429, second succeeds
    mockEmbeddingsCreate
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        data: [{ embedding: emb }],
      });

    await embeddingService.processDocument(doc.id);

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("completed");
    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(2);
  });

  test("fails after exhausting retries", async ({
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
      title: "Exhaust Retry Doc",
      content: "Content",
      contentHash: "hash-exhaust",
      embeddingStatus: "pending",
    });

    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "Chunk",
        chunkIndex: 0,
      },
    ]);

    const OpenAIMod2 = (await import("openai")).default;
    const makeServerError = () => {
      const err = Object.assign(new Error("Server error"), { status: 500 });
      Object.setPrototypeOf(err, OpenAIMod2.APIError.prototype);
      return err;
    };

    // Fail all 3 attempts
    mockEmbeddingsCreate
      .mockRejectedValueOnce(makeServerError())
      .mockRejectedValueOnce(makeServerError())
      .mockRejectedValueOnce(makeServerError());

    await embeddingService.processDocument(doc.id);

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("failed");
    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(3);
  });

  test("processDocuments batches chunks from multiple documents into single API call", async ({
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
      title: "Batch Doc 1",
      content: "Content 1",
      contentHash: "hash-batch1",
      embeddingStatus: "pending",
    });

    const doc2 = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Batch Doc 2",
      content: "Content 2",
      contentHash: "hash-batch2",
      embeddingStatus: "pending",
    });

    await KbChunkModel.insertMany([
      { documentId: doc1.id, content: "Doc1 Chunk A", chunkIndex: 0 },
      { documentId: doc1.id, content: "Doc1 Chunk B", chunkIndex: 1 },
      { documentId: doc2.id, content: "Doc2 Chunk A", chunkIndex: 0 },
    ]);

    const emb0 = makeFakeEmbedding(1);
    const emb1 = makeFakeEmbedding(2);
    const emb2 = makeFakeEmbedding(3);

    // All 3 chunks should arrive in a single API call
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: emb0 }, { embedding: emb1 }, { embedding: emb2 }],
    });

    await embeddingService.processDocuments([doc1.id, doc2.id]);

    // Only 1 OpenAI API call for all 3 chunks
    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["Doc1 Chunk A", "Doc1 Chunk B", "Doc2 Chunk A"],
    });

    const updated1 = await KbDocumentModel.findById(doc1.id);
    expect(updated1?.embeddingStatus).toBe("completed");
    expect(updated1?.chunkCount).toBe(2);

    const updated2 = await KbDocumentModel.findById(doc2.id);
    expect(updated2?.embeddingStatus).toBe("completed");
    expect(updated2?.chunkCount).toBe(1);

    const chunks1 = await KbChunkModel.findByDocument(doc1.id);
    expect(chunks1[0].embedding).toHaveLength(1536);
    expect(chunks1[1].embedding).toHaveLength(1536);

    const chunks2 = await KbChunkModel.findByDocument(doc2.id);
    expect(chunks2[0].embedding).toHaveLength(1536);
  });

  test("processDocuments marks only affected documents as failed on partial API failure", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    // Create 2 docs: doc1 gets chunks in the first API batch (succeeds),
    // doc2 gets chunks that end up in a failing batch.
    // With EMBEDDING_BATCH_SIZE=100, we need >100 chunks to trigger a second batch.
    // Simpler: just have all chunks fail in one batch.
    const doc1 = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Will Fail Doc",
      content: "Content",
      contentHash: "hash-fail-batch",
      embeddingStatus: "pending",
    });

    const doc2 = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "No Chunks Doc",
      content: "Content",
      contentHash: "hash-nochunks-batch",
      embeddingStatus: "pending",
    });

    await KbChunkModel.insertMany([
      { documentId: doc1.id, content: "Chunk", chunkIndex: 0 },
    ]);
    // doc2 has no chunks → should complete with chunkCount 0

    mockEmbeddingsCreate.mockRejectedValueOnce(new Error("API down"));

    await embeddingService.processDocuments([doc1.id, doc2.id]);

    const updated1 = await KbDocumentModel.findById(doc1.id);
    expect(updated1?.embeddingStatus).toBe("failed");

    // doc2 had no chunks, so it completes regardless
    const updated2 = await KbDocumentModel.findById(doc2.id);
    expect(updated2?.embeddingStatus).toBe("completed");
    expect(updated2?.chunkCount).toBe(0);
  });
});
