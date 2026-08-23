import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { beforeEach, vi } from "vitest";
import { useMswServer } from "@/test/msw";

// Query embeddings are scripted per test: each embedding call dequeues the next
// vector. Tests that mock the DB search layer don't care about the vector, so an
// empty queue falls back to a valid non-zero embedding.
const embeddingRequests: Array<{
  model: string;
  input: string[];
  dimensions?: number;
}> = [];
const embeddingQueue: number[][] = [];

// openai@6 requests base64 embeddings by default and decodes them client-side,
// so the wire payload must carry Float32Array bytes, not a JSON number array.
function encodeEmbedding(values: number[]): string {
  const floats = new Float32Array(values);
  return Buffer.from(
    floats.buffer,
    floats.byteOffset,
    floats.byteLength,
  ).toString("base64");
}

const embeddingHandler = http.post(
  "https://api.openai.com/v1/embeddings",
  async ({ request }) => {
    const body = (await request.json()) as {
      model: string;
      input: string[];
      dimensions?: number;
    };
    embeddingRequests.push({
      model: body.model,
      input: body.input,
      dimensions: body.dimensions,
    });

    const embedding = embeddingQueue.shift() ?? new Array(1536).fill(0.001);
    return HttpResponse.json({
      object: "list",
      data: [
        {
          object: "embedding",
          embedding: encodeEmbedding(embedding),
          index: 0,
        },
      ],
      model: body.model,
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
  },
);

const mockRerank = vi.hoisted(() =>
  vi.fn().mockImplementation(({ chunks }: { chunks: unknown[] }) => chunks),
);

vi.mock("./reranker", () => ({
  default: mockRerank,
}));

const mockResolveEmbeddingConfig = vi.hoisted(() => vi.fn());
vi.mock("./kb-llm-client", () => ({
  resolveEmbeddingConfig: mockResolveEmbeddingConfig,
  resolveRerankerConfig: vi.fn().mockResolvedValue(null),
}));

const mockExpandQuery = vi.hoisted(() => vi.fn());
vi.mock("./query-expansion", () => ({
  expandQuery: mockExpandQuery,
  KEYWORD_QUERY_HYBRID_ALPHA_WEIGHT: 4.0,
}));

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    kb: { hybridSearchEnabled: true },
  }),
);

import db, { schema } from "@/database";
import { KbChunkModel, KbDocumentModel, OrganizationModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import { describe, expect, test } from "@/test";

import { KnowledgeBaseSearchTimeoutError } from "./errors";
import {
  findEmbeddingDimensionMismatch,
  QueryService,
  queryService,
} from "./query";
import {
  type KnowledgeRetrievalBackend,
  knowledgeRetrievalBackend,
} from "./retrieval-backend";

function makeFakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.cos(seed + i * 0.01));
}

function setupEmbeddingConfig() {
  mockResolveEmbeddingConfig.mockResolvedValue({
    apiKey: "test-key",
    baseUrl: null,
    model: "text-embedding-3-small",
    dimensions: 1536,
    provider: "openai",
    inputModalities: null,
  });
}

function setupSingleQueryExpansion() {
  mockExpandQuery.mockImplementation(({ queryText }: { queryText: string }) =>
    Promise.resolve([{ queryText, weight: 1.0, type: "semantic" }]),
  );
}

/** Embedding interactions are recorded fire-and-forget, so poll for them. */
async function waitForKbInteractions(expectedCount: number) {
  const read = () =>
    db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.source, "knowledge:embedding"));

  await vi.waitFor(async () =>
    expect(await read()).toHaveLength(expectedCount),
  );
  return read();
}

describe("QueryService", () => {
  useMswServer(embeddingHandler);

  beforeEach(() => {
    embeddingRequests.length = 0;
    embeddingQueue.length = 0;
  });

  test("returns ranked results with citations", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();
    setupSingleQueryExpansion();

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
        acl: ["org:*"],
      },
      {
        documentId: doc.id,
        content: "Second chunk about JavaScript",
        chunkIndex: 1,
        acl: ["org:*"],
      },
    ]);

    // Embed the chunks
    const chunks = await KbChunkModel.findByDocument(doc.id);
    await KbChunkModel.updateEmbeddings(
      [
        { chunkId: chunks[0].id, embedding: emb0 },
        { chunkId: chunks[1].id, embedding: emb1 },
      ],
      1536,
    );

    // Query embedding - similar to emb0
    const queryEmb = makeFakeEmbedding(1.1);
    embeddingQueue.push(queryEmb);

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
      sourceId: null,
      connectorType: "jira",
    });
    // First result should have higher score (closer embedding)
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);

    expect(embeddingRequests[0]).toEqual({
      model: "text-embedding-3-small",
      input: ["TypeScript"],
      dimensions: 1536,
    });
  });

  test("an alternate backend preserves ACL scope, citations, and context expansion", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();
    setupSingleQueryExpansion();

    const visibleDocument = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      sourceId: "runbook-42",
      title: "Certificate rotation runbook",
      content: "Certificate inventory and rotation steps",
      contentHash: "alternate-backend-visible",
      sourceUrl: "https://docs.example.test/runbook-42",
      metadata: { section: "rotation" },
      embeddingStatus: "completed",
    });
    const restrictedDocument = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      sourceId: "restricted-42",
      title: "Restricted runbook",
      content: "Restricted result",
      contentHash: "alternate-backend-restricted",
      embeddingStatus: "completed",
    });
    const [visibleNeighbor, visibleChunk, restrictedChunk] =
      await KbChunkModel.insertMany([
        {
          documentId: visibleDocument.id,
          content: "Use the current certificate inventory.",
          chunkIndex: 0,
          acl: ["org:*"],
        },
        {
          documentId: visibleDocument.id,
          content: "The rotation starts after approval.",
          chunkIndex: 1,
          acl: ["org:*"],
        },
        {
          documentId: restrictedDocument.id,
          content: "Restricted result",
          chunkIndex: 0,
          acl: ["team:restricted"],
        },
      ]);

    const visibleHit: VectorSearchResult = {
      id: visibleChunk.id,
      content: "Forged external content",
      chunkIndex: 1,
      documentId: visibleDocument.id,
      sourceId: "forged-source",
      title: "Forged external title",
      sourceUrl: null,
      metadata: null,
      connectorType: null,
      score: 0.95,
    };
    const indexedRows: VectorSearchResult[] = [
      visibleHit,
      {
        ...visibleHit,
        id: restrictedChunk.id,
        documentId: restrictedDocument.id,
        content: "Restricted result",
        score: 0.9,
      },
    ];

    const alternateBackend: KnowledgeRetrievalBackend = {
      ...knowledgeRetrievalBackend,
      requiresResultVerification: true,
      // Deliberately return restricted and forged data. Archestra must treat
      // these as ranked ids only, then apply its own canonical access state.
      vectorSearch: async () => indexedRows,
      keywordSearch: async () => indexedRows,
      getTextSearchLanguages: async () => [],
      hasKeywordStatistics: async () => false,
      getPopulatedEmbeddingDimensions: async () => new Set([1536]),
      findNeighbors: async () => [
        {
          id: visibleNeighbor.id,
          documentId: visibleDocument.id,
          chunkIndex: 0,
          content: "Forged external neighbour content",
        },
        {
          id: restrictedChunk.id,
          documentId: restrictedDocument.id,
          chunkIndex: 0,
          content: "Restricted result",
        },
      ],
      isSearchTimeout: () => false,
    };
    const alternateQueryService = new QueryService(alternateBackend);

    embeddingQueue.push(makeFakeEmbedding(1));
    const results = await alternateQueryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "How do certificates rotate?",
      userAcl: ["org:*"],
      environmentId: null,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      content:
        "Use the current certificate inventory.\n\nThe rotation starts after approval.",
      chunkIndex: 1,
      metadata: { section: "rotation" },
      ref: `${visibleDocument.id}#1`,
      citation: {
        title: "Certificate rotation runbook",
        sourceUrl: "https://docs.example.test/runbook-42",
        documentId: visibleDocument.id,
        sourceId: "runbook-42",
        connectorType: "jira",
      },
    });
    expect(results[0].content).not.toContain("Forged external");
    expect(results[0].content).not.toContain("Restricted result");
  });

  test("returns a media chunk as a descriptor plus an out-of-band payload", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();
    setupSingleQueryExpansion();

    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "lobsters.webp",
      content: "# lobsters.webp",
      contentHash: "hash-query-media",
      sourceUrl: "https://example.com/lobsters.webp",
      embeddingStatus: "completed",
    });

    // A media document is stored as one chunk holding a base64 data URL.
    const payload = "UklGRgABBBBB";
    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: `data:image/webp;base64,${payload}`,
        chunkIndex: 0,
        acl: ["org:*"],
      },
    ]);
    const chunks = await KbChunkModel.findByDocument(doc.id);
    await KbChunkModel.updateEmbeddings(
      [{ chunkId: chunks[0].id, embedding: makeFakeEmbedding(1) }],
      1536,
    );
    embeddingQueue.push(makeFakeEmbedding(1.1));

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "show me man with lobsters",
      userAcl: ["org:*"],
    });

    expect(results).toHaveLength(1);
    // The model reads a short descriptor, never the base64 payload.
    expect(results[0].content).toBe("[image: lobsters.webp (image/webp)]");
    expect(results[0].content).not.toContain(payload);
    // The bytes ride out-of-band so a caller can attach them as an image.
    expect(results[0].media).toEqual({
      kind: "image",
      mimeType: "image/webp",
      data: payload,
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
    setupSingleQueryExpansion();

    embeddingQueue.push(makeFakeEmbedding(1));

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "anything",
      userAcl: ["org:*"],
    });

    expect(results).toEqual([]);
  });

  test("bypasses chunk ACL filtering when requested", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();
    setupSingleQueryExpansion();

    const alphaDoc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Alpha Doc",
      content: "Some content",
      contentHash: "hash-query-admin-alpha",
      embeddingStatus: "completed",
    });
    const betaDoc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Beta Doc",
      content: "Some content",
      contentHash: "hash-query-admin-beta",
      embeddingStatus: "completed",
    });

    await KbChunkModel.insertMany([
      {
        documentId: alphaDoc.id,
        content: "admin can read alpha",
        chunkIndex: 0,
        acl: ["team:alpha"],
      },
      {
        documentId: betaDoc.id,
        content: "admin can read beta",
        chunkIndex: 0,
        acl: ["team:beta"],
      },
    ]);

    embeddingQueue.push(makeFakeEmbedding(1));

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "admin read",
      userAcl: [],
      bypassAcl: true,
    });

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.citation.documentId).sort()).toEqual(
      [alphaDoc.id, betaDoc.id].sort(),
    );
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
    setupSingleQueryExpansion();

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

    embeddingQueue.push(makeFakeEmbedding(1));

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
    setupSingleQueryExpansion();

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
      acl: ["org:*"],
    }));
    await KbChunkModel.insertMany(chunkData);

    const chunks = await KbChunkModel.findByDocument(doc.id);
    const updates = chunks.map((c, i) => ({
      chunkId: c.id,
      embedding: makeFakeEmbedding(i),
    }));
    await KbChunkModel.updateEmbeddings(updates, 1536);

    embeddingQueue.push(makeFakeEmbedding(0));

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
    setupSingleQueryExpansion();

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

    embeddingQueue.push(makeFakeEmbedding(1));

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
    setupSingleQueryExpansion();

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

    embeddingQueue.push(makeFakeEmbedding(1));

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
    setupSingleQueryExpansion();

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

    embeddingQueue.push(makeFakeEmbedding(1));

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
      connectorId: connector.id,
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
    expect(embeddingRequests).toHaveLength(0);
  });

  test("multi-query expansion searches each query independently and merges", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();

    // Return multiple expanded queries
    mockExpandQuery.mockResolvedValueOnce([
      { queryText: "original query", weight: 0.5, type: "semantic" },
      { queryText: "rephrased query", weight: 1.3, type: "semantic" },
      { queryText: "keyword search", weight: 1.0, type: "keyword" },
    ]);

    const chunkA: VectorSearchResult = {
      id: "chunk-a",
      content: "Content A",
      chunkIndex: 0,
      documentId: "doc-a",
      title: "Doc A",
      sourceUrl: null,
      metadata: null,
      connectorType: null,
      score: 0.9,
    };

    const chunkB: VectorSearchResult = {
      id: "chunk-b",
      content: "Content B",
      chunkIndex: 0,
      documentId: "doc-b",
      title: "Doc B",
      sourceUrl: null,
      metadata: null,
      connectorType: null,
      score: 0.8,
    };

    const chunkC: VectorSearchResult = {
      id: "chunk-c",
      content: "Content C",
      chunkIndex: 0,
      documentId: "doc-c",
      title: "Doc C",
      sourceUrl: null,
      metadata: null,
      connectorType: null,
      score: 0.7,
    };

    // Each expanded query triggers vector + fulltext search
    // Query 1 (original): finds A and B
    // Query 2 (rephrased): finds B and C
    // Query 3 (keyword): finds A and C
    const vectorSearchSpy = vi
      .spyOn(KbChunkModel, "vectorSearch")
      .mockResolvedValueOnce([chunkA, chunkB])
      .mockResolvedValueOnce([chunkB, chunkC])
      .mockResolvedValueOnce([chunkA, chunkC]);

    const fullTextSearchSpy = vi
      .spyOn(KbChunkModel, "fullTextSearch")
      .mockResolvedValue([]);

    embeddingQueue.push(
      makeFakeEmbedding(1),
      makeFakeEmbedding(2),
      makeFakeEmbedding(3),
    );

    const results = await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "original query",
      userAcl: ["org:*"],
    });

    // All chunks should be present (merged from multiple queries)
    expect(results.length).toBeGreaterThanOrEqual(1);
    const contentSet = new Set(results.map((r) => r.content));
    // B appears in queries 1 and 2, A in 1 and 3, C in 2 and 3 — all should be present
    expect(
      contentSet.has("Content A") ||
        contentSet.has("Content B") ||
        contentSet.has("Content C"),
    ).toBe(true);

    // Verify multiple embedding calls were made (one per expanded query)
    expect(embeddingRequests).toHaveLength(3);

    // Verify reranker uses original query text
    expect(mockRerank).toHaveBeenCalledWith(
      expect.objectContaining({ queryText: "original query" }),
    );

    vectorSearchSpy.mockRestore();
    fullTextSearchSpy.mockRestore();
  });

  test("attributes the query embedding to the connector when the query targets one", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();
    setupSingleQueryExpansion();

    embeddingQueue.push(makeFakeEmbedding(1));

    await queryService.query({
      connectorIds: [connector.id],
      organizationId: org.id,
      queryText: "test query",
      userAcl: ["org:*"],
    });

    const [interaction] = await waitForKbInteractions(1);
    expect(interaction.connectorId).toBe(connector.id);
    expect(mockExpandQuery).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: connector.id }),
    );
  });

  test("leaves the query embedding unattributed when the query spans several connectors", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connectorA = await makeKnowledgeBaseConnector(kb.id, org.id);
    const connectorB = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();
    setupSingleQueryExpansion();

    embeddingQueue.push(makeFakeEmbedding(1));

    await queryService.query({
      connectorIds: [connectorA.id, connectorB.id],
      organizationId: org.id,
      queryText: "test query",
      userAcl: ["org:*"],
    });

    const [interaction] = await waitForKbInteractions(1);
    expect(interaction.connectorId).toBeNull();
  });

  // A statement-timeout cancellation is a process-boundary condition the PGlite
  // test database cannot produce, so these tests simulate it at the model
  // seam with the same error shape node-postgres raises (SQLSTATE 57014
  // wrapped by the ORM).
  function makeStatementTimeoutError(): Error {
    return Object.assign(new Error("Failed query: SELECT ..."), {
      cause: Object.assign(
        new Error("canceling statement due to statement timeout"),
        { code: "57014" },
      ),
    });
  }

  test("drops a lane cut by the statement timeout and serves the surviving lane", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();
    setupSingleQueryExpansion();

    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Timeout Survivor",
      content: "Some content",
      contentHash: "hash-lane-timeout-1",
      sourceUrl: null,
      embeddingStatus: "completed",
    });
    await KbChunkModel.insertMany([
      {
        documentId: doc.id,
        content: "Resilient chunk about TypeScript",
        chunkIndex: 0,
        acl: ["org:*"],
      },
    ]);

    const vectorSpy = vi
      .spyOn(KbChunkModel, "vectorSearch")
      .mockRejectedValue(makeStatementTimeoutError());
    try {
      embeddingQueue.push(makeFakeEmbedding(1));
      const results = await queryService.query({
        connectorIds: [connector.id],
        organizationId: org.id,
        queryText: "TypeScript",
        userAcl: ["org:*"],
      });

      // The keyword lane's hit still comes back even though the vector lane
      // burned its statement timeout.
      expect(results.map((r) => r.content)).toEqual([
        "Resilient chunk about TypeScript",
      ]);
    } finally {
      vectorSpy.mockRestore();
    }
  });

  test("fails with an actionable error when every search lane times out", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();
    setupSingleQueryExpansion();

    const vectorSpy = vi
      .spyOn(KbChunkModel, "vectorSearch")
      .mockRejectedValue(makeStatementTimeoutError());
    const fullTextSpy = vi
      .spyOn(KbChunkModel, "fullTextSearch")
      .mockRejectedValue(makeStatementTimeoutError());
    try {
      embeddingQueue.push(makeFakeEmbedding(1));
      await expect(
        queryService.query({
          connectorIds: [connector.id],
          organizationId: org.id,
          queryText: "TypeScript",
          userAcl: ["org:*"],
        }),
      ).rejects.toThrow(KnowledgeBaseSearchTimeoutError);
    } finally {
      vectorSpy.mockRestore();
      fullTextSpy.mockRestore();
    }
  });

  test("non-timeout search failures still propagate", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    setupEmbeddingConfig();
    setupSingleQueryExpansion();

    const vectorSpy = vi
      .spyOn(KbChunkModel, "vectorSearch")
      .mockRejectedValue(new Error("relation does not exist"));
    try {
      embeddingQueue.push(makeFakeEmbedding(1));
      await expect(
        queryService.query({
          connectorIds: [connector.id],
          organizationId: org.id,
          queryText: "TypeScript",
          userAcl: ["org:*"],
        }),
      ).rejects.toThrow("relation does not exist");
    } finally {
      vectorSpy.mockRestore();
    }
  });

  describe("keyword ranker selection", () => {
    async function seedEnglishCorpus(fixtures: {
      makeOrganization: () => Promise<{ id: string }>;
      makeKnowledgeBase: (orgId: string) => Promise<{ id: string }>;
      makeKnowledgeBaseConnector: (
        kbId: string,
        orgId: string,
      ) => Promise<{ id: string }>;
    }) {
      const org = await fixtures.makeOrganization();
      const kb = await fixtures.makeKnowledgeBase(org.id);
      const connector = await fixtures.makeKnowledgeBaseConnector(
        kb.id,
        org.id,
      );
      const doc = await KbDocumentModel.create({
        connectorId: connector.id,
        organizationId: org.id,
        title: "Runbook",
        content: "ingress timeout",
        contentHash: "h-ranker",
      });
      await KbChunkModel.insertMany([
        {
          documentId: doc.id,
          content: "kubernetes ingress timeout",
          chunkIndex: 0,
          acl: ["org:*"],
        },
      ]);
      setupEmbeddingConfig();
      setupSingleQueryExpansion();
      embeddingQueue.push(makeFakeEmbedding(7));
      return { org, connector };
    }

    test("passes the organization's BM25 tuning override to the keyword lane", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const { org, connector } = await seedEnglishCorpus({
        makeOrganization,
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      await OrganizationModel.patch(org.id, { kbBm25K1: 1.5, kbBm25B: 0.3 });
      await KbChunkModel.refreshBm25Stats();

      const fullTextSearchSpy = vi
        .spyOn(KbChunkModel, "fullTextSearch")
        .mockResolvedValueOnce([]);

      await queryService.query({
        connectorIds: [connector.id],
        organizationId: org.id,
        queryText: "ingress timeout",
        userAcl: ["org:*"],
      });

      expect(fullTextSearchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ bm25: { k1: 1.5, b: 0.3 } }),
      );
      fullTextSearchSpy.mockRestore();
    });

    test("ranks with BM25 at the deployment default tuning when the organization has none — no per-call argument, no setting", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const { org, connector } = await seedEnglishCorpus({
        makeOrganization,
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      await KbChunkModel.refreshBm25Stats();

      const fullTextSearchSpy = vi
        .spyOn(KbChunkModel, "fullTextSearch")
        .mockResolvedValueOnce([]);

      await queryService.query({
        connectorIds: [connector.id],
        organizationId: org.id,
        queryText: "ingress timeout",
        userAcl: ["org:*"],
      });

      // The real config's defaults (deep-merged by configModuleMock), i.e. the
      // Lucene constants — not undefined, which would rank with ts_rank.
      expect(fullTextSearchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ bm25: { k1: 1.2, b: 0.75 } }),
      );
      fullTextSearchSpy.mockRestore();
    });

    test("an empty connector in another language does not knock the query off BM25", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const { org, connector } = await seedEnglishCorpus({
        makeOrganization,
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      await KbChunkModel.refreshBm25Stats();
      // A connector created in a language nothing is indexed in — its language
      // joins the query's parse list, but `ts_stat` never produces statistics
      // for it, so blocking on it would disable BM25 for this knowledge base
      // permanently rather than until the next refresh.
      const kb = await makeKnowledgeBase(org.id);
      const emptyGermanConnector = await makeKnowledgeBaseConnector(
        kb.id,
        org.id,
        { ftsLanguage: "german" },
      );

      const fullTextSearchSpy = vi
        .spyOn(KbChunkModel, "fullTextSearch")
        .mockResolvedValueOnce([]);

      await queryService.query({
        connectorIds: [connector.id, emptyGermanConnector.id],
        organizationId: org.id,
        queryText: "ingress timeout",
        userAcl: ["org:*"],
      });

      expect(fullTextSearchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ bm25: { k1: 1.2, b: 0.75 } }),
      );
      fullTextSearchSpy.mockRestore();
    });

    test("stays on ts_rank until the BM25 statistics have been built", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const { org, connector } = await seedEnglishCorpus({
        makeOrganization,
        makeKnowledgeBase,
        makeKnowledgeBaseConnector,
      });
      // No refreshBm25Stats(): the scoring statement inner-joins the stats
      // tables, so an unguarded BM25 query here would return nothing at all.

      const fullTextSearchSpy = vi
        .spyOn(KbChunkModel, "fullTextSearch")
        .mockResolvedValueOnce([]);

      await queryService.query({
        connectorIds: [connector.id],
        organizationId: org.id,
        queryText: "ingress timeout",
        userAcl: ["org:*"],
      });

      expect(fullTextSearchSpy).toHaveBeenCalledTimes(1);
      expect(fullTextSearchSpy.mock.calls[0]?.[0].bm25).toBeUndefined();
      fullTextSearchSpy.mockRestore();
    });
  });
});

describe("findEmbeddingDimensionMismatch", () => {
  test("returns null when no documents are ingested (legitimate empty result)", () => {
    expect(findEmbeddingDimensionMismatch(new Set(), 1024)).toBeNull();
  });

  test("returns null when the configured dimension is present (a real no-match)", () => {
    expect(findEmbeddingDimensionMismatch(new Set([1024]), 1024)).toBeNull();
    expect(
      findEmbeddingDimensionMismatch(new Set([1024, 1536]), 1024),
    ).toBeNull();
  });

  test("reports a mismatch when documents exist only at other dimensions", () => {
    expect(findEmbeddingDimensionMismatch(new Set([1536]), 1024)).toEqual([
      1536,
    ]);
  });

  test("reports a mismatch for the mixed-connector case (any differing dimension)", () => {
    // Configured 768, but connectors were ingested at 1024 and 1536 — none match.
    expect(
      findEmbeddingDimensionMismatch(new Set([1024, 1536]), 768)?.sort(),
    ).toEqual([1024, 1536]);
  });
});
