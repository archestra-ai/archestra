import { vi } from "vitest";

const mockEmbeddingsCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    object: "list",
    data: [{ object: "embedding", embedding: [], index: 0 }],
    model: "text-embedding-3-small",
    usage: { prompt_tokens: 5, total_tokens: 5 },
  }),
);

vi.mock("openai", () => {
  class MockOpenAI {
    embeddings = { create: mockEmbeddingsCreate };
  }
  return { default: MockOpenAI };
});

const mockRerank = vi.hoisted(() =>
  vi.fn().mockImplementation(({ chunks }: { chunks: unknown[] }) => chunks),
);

vi.mock("./reranker", () => ({
  default: mockRerank,
}));

const mockResolveEmbeddingConfig = vi.hoisted(() => vi.fn());
vi.mock("./kb-llm-client", () => ({
  resolveEmbeddingConfig: mockResolveEmbeddingConfig,
}));

vi.mock("@/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/config")>();
  return {
    ...original,
    default: {
      ...original.default,
      kb: {
        hybridSearchEnabled: true,
      },
    },
  };
});

import OpenAI from "openai";
import { KbChunkModel, KbDocumentModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import { describe, expect, test } from "@/test";

import { queryService } from "./query";

function makeFakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.cos(seed + i * 0.01));
}

function setupEmbeddingConfig() {
  const client = new OpenAI({ apiKey: "test-key" });
  mockResolveEmbeddingConfig.mockResolvedValue({
    client,
    model: "text-embedding-3-small",
    dimensions: 1536,
  });
}

describe("QueryService", () => {
  test("returns ranked results with citations", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();

    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
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
      object: "list",
      data: [{ object: "embedding", embedding: queryEmb, index: 0 }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
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
      connectorType: "jira",
    });
    // First result should have higher score (closer embedding)
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);

    expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: "TypeScript",
      dimensions: 1536,
    });
  });

  test("returns empty array when no chunks exist", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();

    const queryEmb = makeFakeEmbedding(1);
    mockEmbeddingsCreate.mockResolvedValueOnce({
      object: "list",
      data: [{ object: "embedding", embedding: queryEmb, index: 0 }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "anything",
      userAcl: ["org:*"],
    });

    expect(results).toEqual([]);
  });

  test("returns empty array when chunks have no embeddings", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();

    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
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
      object: "list",
      data: [{ object: "embedding", embedding: queryEmb, index: 0 }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "test",
      userAcl: ["org:*"],
    });

    expect(results).toEqual([]);
  });

  test("respects limit parameter", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();

    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
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
      object: "list",
      data: [{ object: "embedding", embedding: queryEmb, index: 0 }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "test",
      userAcl: ["org:*"],
      limit: 2,
    });

    expect(results).toHaveLength(2);
  });

  test("hybrid search merges vector and full-text results without duplicates", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();

    const vectorOnly: VectorSearchResult = {
      id: "vec-1",
      content: "Vector only result",
      chunkIndex: 0,
      documentId: "doc-1",
      title: "Doc 1",
      sourceUrl: null,
      metadata: null,
      connectorType: null,
      score: 0.9,
    };

    const fullTextOnly: VectorSearchResult = {
      id: "ft-1",
      content: "Full text only result",
      chunkIndex: 1,
      documentId: "doc-2",
      title: "Doc 2",
      sourceUrl: null,
      metadata: null,
      connectorType: null,
      score: 5.0,
    };

    const sharedResult: VectorSearchResult = {
      id: "shared-1",
      content: "Shared result from both",
      chunkIndex: 0,
      documentId: "doc-3",
      title: "Doc 3",
      sourceUrl: "https://example.com",
      metadata: null,
      connectorType: null,
      score: 0.8,
    };

    const vectorSearchSpy = vi
      .spyOn(KbChunkModel, "vectorSearch")
      .mockResolvedValueOnce([vectorOnly, sharedResult]);

    const fullTextSearchSpy = vi
      .spyOn(KbChunkModel, "fullTextSearch")
      .mockResolvedValueOnce([fullTextOnly, { ...sharedResult, score: 3.0 }]);

    mockEmbeddingsCreate.mockResolvedValueOnce({
      object: "list",
      data: [
        { object: "embedding", embedding: makeFakeEmbedding(1), index: 0 },
      ],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "test query",
      userAcl: ["org:*"],
    });

    // shared-1 appears in both lists → should rank highest via RRF
    expect(results[0].content).toBe("Shared result from both");
    // No duplicates
    const ids = results.map((r) => r.citation.documentId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(results).toHaveLength(3);

    vectorSearchSpy.mockRestore();
    fullTextSearchSpy.mockRestore();
  });

  test("falls back gracefully when full-text returns no results", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();

    const vectorResult: VectorSearchResult = {
      id: "vec-1",
      content: "Semantic match",
      chunkIndex: 0,
      documentId: "doc-1",
      title: "Doc 1",
      sourceUrl: null,
      metadata: null,
      connectorType: null,
      score: 0.85,
    };

    const vectorSearchSpy = vi
      .spyOn(KbChunkModel, "vectorSearch")
      .mockResolvedValueOnce([vectorResult]);

    const fullTextSearchSpy = vi
      .spyOn(KbChunkModel, "fullTextSearch")
      .mockResolvedValueOnce([]);

    mockEmbeddingsCreate.mockResolvedValueOnce({
      object: "list",
      data: [
        { object: "embedding", embedding: makeFakeEmbedding(1), index: 0 },
      ],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "semantic meaning only",
      userAcl: ["org:*"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Semantic match");

    vectorSearchSpy.mockRestore();
    fullTextSearchSpy.mockRestore();
  });

  test("calls reranker after fusion", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();

    const chunk1: VectorSearchResult = {
      id: "r-1",
      content: "First result",
      chunkIndex: 0,
      documentId: "doc-1",
      title: "Doc 1",
      sourceUrl: null,
      metadata: null,
      connectorType: null,
      score: 0.9,
    };

    const chunk2: VectorSearchResult = {
      id: "r-2",
      content: "Second result",
      chunkIndex: 1,
      documentId: "doc-2",
      title: "Doc 2",
      sourceUrl: null,
      metadata: null,
      connectorType: null,
      score: 0.7,
    };

    const vectorSearchSpy = vi
      .spyOn(KbChunkModel, "vectorSearch")
      .mockResolvedValueOnce([chunk1, chunk2]);

    const fullTextSearchSpy = vi
      .spyOn(KbChunkModel, "fullTextSearch")
      .mockResolvedValueOnce([chunk2, chunk1]);

    mockEmbeddingsCreate.mockResolvedValueOnce({
      object: "list",
      data: [
        { object: "embedding", embedding: makeFakeEmbedding(1), index: 0 },
      ],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    // Reranker reverses the order
    mockRerank.mockResolvedValueOnce([chunk2, chunk1]);

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "test query",
      userAcl: ["org:*"],
      limit: 2,
    });

    expect(mockRerank).toHaveBeenCalledWith({
      queryText: "test query",
      chunks: expect.any(Array),
      organizationId: org.id,
    });
    expect(results[0].content).toBe("Second result");
    expect(results[1].content).toBe("First result");

    vectorSearchSpy.mockRestore();
    fullTextSearchSpy.mockRestore();
  });

  test("returns empty array when no embedding config", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    // No embedding config available
    mockResolveEmbeddingConfig.mockResolvedValueOnce(null);

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "test",
      userAcl: ["org:*"],
    });

    expect(results).toEqual([]);
    // Should not attempt to create embeddings
    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
  });
});
