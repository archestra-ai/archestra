import { vi } from "vitest";

const mockEmbeddingsCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: [{ embedding: [] }],
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

import { queryService } from "./query";

function makeFakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.cos(seed + i * 0.01));
}

describe("QueryService", () => {
  test("returns ranked results with citations", async ({
    makeOrganization,
    makeKnowledgeBase,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);

    const doc = await KbDocumentModel.create({
      knowledgeBaseId: kb.id,
      organizationId: org.id,
      sourceType: "api",
      title: "Test Document",
      content: "Some content",
      contentHash: "hash-query-1",
      sourceUrl: "https://example.com/doc",
      embeddingStatus: "completed",
    });

    const emb0 = makeFakeEmbedding(1);
    const emb1 = makeFakeEmbedding(2);

    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "First chunk about TypeScript",
        chunkIndex: 0,
      },
      {
        documentId: doc.id,
        content: "Second chunk about JavaScript",
        chunkIndex: 1,
      },
    ]);

    // Embed the chunks
    const chunks = await KbChunkModel.findByDocument(doc.id);
    await KbChunkModel.updateEmbeddings([
      { chunkId: chunks[0].id, embedding: emb0 },
      { chunkId: chunks[1].id, embedding: emb1 },
    ]);

    // Mock query embedding - similar to emb0
    const queryEmb = makeFakeEmbedding(1.1);
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: queryEmb }],
    });

    const results = await queryService.query({
      knowledgeBaseId: kb.id,
      queryText: "TypeScript",
      userAcl: ["org:*"],
    });

    expect(results.length).toBe(2);
    expect(results[0].content).toBe("First chunk about TypeScript");
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].chunkIndex).toBe(0);
    expect(results[0].citation).toEqual({
      title: "Test Document",
      sourceUrl: "https://example.com/doc",
      documentId: doc.id,
      connectorType: null,
    });
    // First result should have higher score (closer embedding)
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);

    expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: "TypeScript",
    });
  });

  test("returns empty array when no chunks exist", async ({
    makeOrganization,
    makeKnowledgeBase,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);

    const queryEmb = makeFakeEmbedding(1);
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: queryEmb }],
    });

    const results = await queryService.query({
      knowledgeBaseId: kb.id,
      queryText: "anything",
      userAcl: ["org:*"],
    });

    expect(results).toEqual([]);
  });

  test("returns empty array when chunks have no embeddings", async ({
    makeOrganization,
    makeKnowledgeBase,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);

    const doc = await KbDocumentModel.create({
      knowledgeBaseId: kb.id,
      organizationId: org.id,
      sourceType: "api",
      title: "Unembedded Doc",
      content: "Content",
      contentHash: "hash-query-2",
      embeddingStatus: "pending",
    });

    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "Chunk without embedding",
        chunkIndex: 0,
      },
    ]);

    const queryEmb = makeFakeEmbedding(1);
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: queryEmb }],
    });

    const results = await queryService.query({
      knowledgeBaseId: kb.id,
      queryText: "test",
      userAcl: ["org:*"],
    });

    expect(results).toEqual([]);
  });

  test("respects limit parameter", async ({
    makeOrganization,
    makeKnowledgeBase,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);

    const doc = await KbDocumentModel.create({
      knowledgeBaseId: kb.id,
      organizationId: org.id,
      sourceType: "api",
      title: "Multi Chunk Doc",
      content: "Content",
      contentHash: "hash-query-3",
      embeddingStatus: "completed",
    });

    // Insert 5 chunks with embeddings
    const chunkData = Array.from({ length: 5 }, (_, i) => ({
      documentId: doc.id,
      content: `Chunk ${i}`,
      chunkIndex: i,
    }));
    await KbChunkModel.insertMany(chunkData);

    const chunks = await KbChunkModel.findByDocument(doc.id);
    const updates = chunks.map((c, i) => ({
      chunkId: c.id,
      embedding: makeFakeEmbedding(i),
    }));
    await KbChunkModel.updateEmbeddings(updates);

    const queryEmb = makeFakeEmbedding(0);
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: queryEmb }],
    });

    const results = await queryService.query({
      knowledgeBaseId: kb.id,
      queryText: "test",
      userAcl: ["org:*"],
      limit: 2,
    });

    expect(results).toHaveLength(2);
  });
});
