import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { beforeEach, vi } from "vitest";
import { useMswServer } from "@/test/msw";

// Per-call scripting for the OpenAI embeddings wire endpoint. Each `run_command`
// dequeues the next response; an `error` entry serves a wire-level OpenAI error
// with `x-should-retry: false` so the SDK surfaces it without its own internal
// retries (the embedder does its own app-level retry loop).
type EmbeddingResponseSpec =
  | { kind: "ok"; embeddings: number[][] }
  | { kind: "error"; status: number };

const embeddingRequests: Array<{
  model: string;
  input: string[];
  dimensions?: number;
}> = [];
const responseQueue: EmbeddingResponseSpec[] = [];
const bedrockEmbeddingRequests: string[] = [];
const bedrockTransientFailures = new Map<string, number>();

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

    const next = responseQueue.shift();
    if (next?.kind === "error") {
      return HttpResponse.json(
        { error: { message: "embedding failure", type: "server_error" } },
        { status: next.status, headers: { "x-should-retry": "false" } },
      );
    }

    const embeddings = next?.embeddings ?? body.input.map(() => []);
    return HttpResponse.json({
      object: "list",
      data: embeddings.map((embedding, index) => ({
        object: "embedding",
        embedding: encodeEmbedding(embedding),
        index,
      })),
      model: body.model,
      usage: { prompt_tokens: 10, total_tokens: 10 },
    });
  },
);

const bedrockEmbeddingHandler = http.post(
  "https://bedrock-runtime.us-east-1.amazonaws.com/model/:modelId/invoke",
  async ({ request }) => {
    const body = (await request.json()) as { inputText?: string };
    const input = body.inputText ?? "";
    bedrockEmbeddingRequests.push(input);
    const transientFailuresRemaining = bedrockTransientFailures.get(input) ?? 0;
    if (transientFailuresRemaining > 0) {
      bedrockTransientFailures.set(input, transientFailuresRemaining - 1);
      return HttpResponse.json(
        { message: "temporary outage" },
        { status: 503 },
      );
    }
    if (input.includes("bad chunk")) {
      return HttpResponse.json(
        { message: "deterministic bad input" },
        { status: 400 },
      );
    }
    return HttpResponse.json({
      embedding: Array.from({ length: 1024 }, () => 0.1),
      inputTextTokenCount: 2,
    });
  },
);

const mockGetDefaultOrgEmbeddingConfig = vi.hoisted(() => vi.fn());
vi.mock("./kb-llm-client", () => ({
  getDefaultOrgEmbeddingConfig: mockGetDefaultOrgEmbeddingConfig,
}));

import db, { schema } from "@/database";
import { KbChunkModel, KbDocumentModel } from "@/models";
import { describe, expect, test } from "@/test";

// Import after mocks are set up
import { embeddingService } from "./embedder";

function makeFakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (seed + i) * 0.001);
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

function makeEmbeddingContext() {
  return {
    apiKey: "test-key",
    baseUrl: null,
    model: "text-embedding-3-small" as const,
    dimensions: 1536,
    provider: "openai" as const,
    inputModalities: null,
    acceptedImageMimeTypes: null,
  };
}

describe("EmbeddingService", () => {
  useMswServer(embeddingHandler, bedrockEmbeddingHandler);

  beforeEach(() => {
    embeddingRequests.length = 0;
    bedrockEmbeddingRequests.length = 0;
    bedrockTransientFailures.clear();
    responseQueue.length = 0;
  });

  test("persists successful Bedrock fan-out results and fails only the affected document", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    mockGetDefaultOrgEmbeddingConfig.mockResolvedValue({
      organizationId: org.id,
      config: {
        apiKey: "test-key",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        model: "amazon.titan-embed-image-v1",
        dimensions: 1024,
        provider: "bedrock",
        inputModalities: ["text", "image"],
        acceptedImageMimeTypes: ["image/png", "image/jpeg"],
      },
    });

    const good = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Good",
      content: "good",
      contentHash: "partial-bedrock-good",
      embeddingStatus: "pending",
    });
    const bad = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Bad",
      content: "bad",
      contentHash: "partial-bedrock-bad",
      embeddingStatus: "pending",
    });
    await KbChunkModel.insertMany([
      { documentId: good.id, content: "good chunk", chunkIndex: 0 },
      { documentId: bad.id, content: "bad chunk", chunkIndex: 0 },
    ]);

    const outcome = await embeddingService.processDocuments([good.id, bad.id]);

    expect(outcome.failedDocumentCount).toBe(1);
    expect((await KbDocumentModel.findById(good.id))?.embeddingStatus).toBe(
      "completed",
    );
    expect((await KbDocumentModel.findById(bad.id))?.embeddingStatus).toBe(
      "failed",
    );
    expect(bedrockEmbeddingRequests).toHaveLength(2);
  });

  test("retries only transiently failed Bedrock inputs without replaying successes", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);
    mockGetDefaultOrgEmbeddingConfig.mockResolvedValue({
      organizationId: org.id,
      config: {
        apiKey: "test-key",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        model: "amazon.titan-embed-image-v1",
        dimensions: 1024,
        provider: "bedrock",
        inputModalities: ["text", "image"],
        acceptedImageMimeTypes: ["image/png", "image/jpeg"],
      },
    });

    const good = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Good",
      content: "good",
      contentHash: "retry-bedrock-good",
      embeddingStatus: "pending",
    });
    const flaky = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Flaky",
      content: "flaky",
      contentHash: "retry-bedrock-flaky",
      embeddingStatus: "pending",
    });
    await KbChunkModel.insertMany([
      { documentId: good.id, content: "good retry chunk", chunkIndex: 0 },
      { documentId: flaky.id, content: "flaky retry chunk", chunkIndex: 0 },
    ]);
    bedrockTransientFailures.set("flaky retry chunk", 1);

    const outcome = await embeddingService.processDocuments([
      good.id,
      flaky.id,
    ]);

    expect(outcome.failedDocumentCount).toBe(0);
    expect(
      bedrockEmbeddingRequests.filter((input) => input === "good retry chunk"),
    ).toHaveLength(1);
    expect(
      bedrockEmbeddingRequests.filter((input) => input === "flaky retry chunk"),
    ).toHaveLength(2);
  });

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
    responseQueue.push({ kind: "ok", embeddings: [emb0, emb1] });

    await embeddingService.processDocument(doc.id, makeEmbeddingContext());

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("completed");
    expect(updated?.chunkCount).toBe(2);

    const chunks = await KbChunkModel.findByDocument(doc.id);
    expect(chunks[0].embedding).toHaveLength(1536);
    expect(chunks[1].embedding).toHaveLength(1536);
    // Verify first few values survive the round-trip through vector column
    expect(chunks[0].embedding?.[0]).toBeCloseTo(emb0[0], 4);
    expect(chunks[1].embedding?.[0]).toBeCloseTo(emb1[0], 4);

    expect(embeddingRequests).toEqual([
      {
        model: "text-embedding-3-small",
        input: ["Chunk one content", "Chunk two content"],
        dimensions: 1536,
      },
    ]);
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

    // 400 is non-retryable, so the embedder fails the document after one call.
    responseQueue.push({ kind: "error", status: 400 });

    await embeddingService.processDocument(doc.id, makeEmbeddingContext());

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("failed");
  });

  test("no chunks marks document as failed with chunkCount 0", async ({
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

    await embeddingService.processDocument(doc.id, makeEmbeddingContext());

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("failed");
    expect(updated?.chunkCount).toBe(0);
    expect(embeddingRequests).toHaveLength(0);
  });

  test("a zero-chunk batch is counted and names the document", async ({
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
      title: "Unchunkable Guide",
      content: "Content but no chunks",
      contentHash: "hash-zero-chunk-batch",
      embeddingStatus: "pending",
    });

    const outcome = await embeddingService.processDocuments([doc.id]);

    expect(outcome).toMatchObject({
      failedDocumentCount: 1,
      skippedImageChunkCount: 0,
    });
    expect(outcome.errorMessage).toContain("Unchunkable Guide");
    expect(outcome.errorMessage).toContain(doc.id);
    expect(embeddingRequests).toHaveLength(0);
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

    await embeddingService.processDocument(doc.id, makeEmbeddingContext());

    expect(embeddingRequests).toHaveLength(0);
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

    // First call fails with a retryable 429, second succeeds.
    responseQueue.push(
      { kind: "error", status: 429 },
      { kind: "ok", embeddings: [emb] },
    );

    await embeddingService.processDocument(doc.id, makeEmbeddingContext());

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("completed");
    expect(embeddingRequests).toHaveLength(2);
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

    // Fail all 3 attempts with retryable 500s.
    responseQueue.push(
      { kind: "error", status: 500 },
      { kind: "error", status: 500 },
      { kind: "error", status: 500 },
    );

    await embeddingService.processDocument(doc.id, makeEmbeddingContext());

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("failed");
    expect(embeddingRequests).toHaveLength(3);
  });

  test("processDocuments batches chunks from multiple documents into single API call", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    mockGetDefaultOrgEmbeddingConfig.mockResolvedValue({
      organizationId: org.id,
      config: makeEmbeddingContext(),
    });

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
    responseQueue.push({ kind: "ok", embeddings: [emb0, emb1, emb2] });

    await embeddingService.processDocuments([doc1.id, doc2.id]);

    // Only 1 OpenAI API call for all 3 chunks
    expect(embeddingRequests).toHaveLength(1);
    expect(embeddingRequests[0]).toEqual({
      model: "text-embedding-3-small",
      input: ["Doc1 Chunk A", "Doc1 Chunk B", "Doc2 Chunk A"],
      dimensions: 1536,
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

  test("processDocuments resets docs to pending when no embedding config", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    // No embedding config available
    mockGetDefaultOrgEmbeddingConfig.mockResolvedValue(null);

    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "No Config Doc",
      content: "Content",
      contentHash: "hash-noconfig",
      embeddingStatus: "pending",
    });

    await KbChunkModel.insertMany([
      { documentId: doc.id, content: "Chunk", chunkIndex: 0 },
    ]);

    await embeddingService.processDocuments([doc.id]);

    // Document should be reset to pending (not failed, not completed)
    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("pending");

    // No OpenAI API call should have been made
    expect(embeddingRequests).toHaveLength(0);
  });

  test("processDocuments marks only affected documents as failed on partial API failure", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    mockGetDefaultOrgEmbeddingConfig.mockResolvedValue({
      organizationId: org.id,
      config: makeEmbeddingContext(),
    });

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
    // doc2 has no chunks → should fail visibly with chunkCount 0

    responseQueue.push({ kind: "error", status: 400 });

    const outcome = await embeddingService.processDocuments([doc1.id, doc2.id]);

    const updated1 = await KbDocumentModel.findById(doc1.id);
    expect(updated1?.embeddingStatus).toBe("failed");

    // doc2 had no chunks, so it is part of the surfaced batch failure.
    const updated2 = await KbDocumentModel.findById(doc2.id);
    expect(updated2?.embeddingStatus).toBe("failed");
    expect(updated2?.chunkCount).toBe(0);
    expect(outcome.failedDocumentCount).toBe(2);
    expect(outcome.errorMessage).toContain("No Chunks Doc");
    expect(outcome.errorMessage).toContain("could not be reached");
  });

  test("attributes a single-document embed to that document's connector", async ({
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
      title: "Single Doc",
      content: "Content",
      contentHash: "hash-single-attributed",
      embeddingStatus: "pending",
    });
    await KbChunkModel.insertMany([
      { documentId: doc.id, content: "Chunk", chunkIndex: 0 },
    ]);
    responseQueue.push({ kind: "ok", embeddings: [makeFakeEmbedding(1)] });

    await embeddingService.processDocument(doc.id, makeEmbeddingContext());

    const [interaction] = await waitForKbInteractions(1);
    expect(interaction.connectorId).toBe(connector.id);
  });

  test("attributes the embedding interaction to the document's connector", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    mockGetDefaultOrgEmbeddingConfig.mockResolvedValue({
      organizationId: org.id,
      config: makeEmbeddingContext(),
    });

    const doc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Attributed Doc",
      content: "Content",
      contentHash: "hash-attributed",
      embeddingStatus: "pending",
    });
    await KbChunkModel.insertMany([
      { documentId: doc.id, content: "Chunk", chunkIndex: 0 },
    ]);
    responseQueue.push({ kind: "ok", embeddings: [makeFakeEmbedding(1)] });

    await embeddingService.processDocuments([doc.id]);

    const [interaction] = await waitForKbInteractions(1);
    expect(interaction.connectorId).toBe(connector.id);
  });

  test("leaves the connector unattributed when one batch spans several connectors", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connectorA = await makeKnowledgeBaseConnector(kb.id, org.id);
    const connectorB = await makeKnowledgeBaseConnector(kb.id, org.id);

    mockGetDefaultOrgEmbeddingConfig.mockResolvedValue({
      organizationId: org.id,
      config: makeEmbeddingContext(),
    });

    const docA = await KbDocumentModel.create({
      connectorId: connectorA.id,
      organizationId: org.id,
      title: "Doc A",
      content: "Content A",
      contentHash: "hash-mixed-a",
      embeddingStatus: "pending",
    });
    const docB = await KbDocumentModel.create({
      connectorId: connectorB.id,
      organizationId: org.id,
      title: "Doc B",
      content: "Content B",
      contentHash: "hash-mixed-b",
      embeddingStatus: "pending",
    });
    await KbChunkModel.insertMany([
      { documentId: docA.id, content: "Chunk A", chunkIndex: 0 },
      { documentId: docB.id, content: "Chunk B", chunkIndex: 0 },
    ]);
    responseQueue.push({
      kind: "ok",
      embeddings: [makeFakeEmbedding(1), makeFakeEmbedding(2)],
    });

    // The stalled-embedding recovery sweep batches documents across connectors,
    // so a single API call — one interaction row — has no one connector to name.
    await embeddingService.processDocuments([docA.id, docB.id]);

    expect(embeddingRequests).toHaveLength(1);
    const [interaction] = await waitForKbInteractions(1);
    expect(interaction.connectorId).toBeNull();
  });

  test("processDocument skips image chunks the model can't embed and still completes", async ({
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
      title: "Mixed Doc",
      content: "Text with an inline image",
      contentHash: "hash-skip-single",
      embeddingStatus: "pending",
    });
    await KbChunkModel.insertMany([
      { documentId: doc.id, content: "Text chunk", chunkIndex: 0 },
      {
        documentId: doc.id,
        content: "data:image/png;base64,aW1hZ2U=",
        chunkIndex: 1,
      },
    ]);

    responseQueue.push({ kind: "ok", embeddings: [makeFakeEmbedding(1)] });

    // makeEmbeddingContext resolves inputModalities: null — image support
    // unknown, so the image chunk must be skipped, not sent to a rejection.
    await embeddingService.processDocument(doc.id, makeEmbeddingContext());

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("completed");

    expect(embeddingRequests).toHaveLength(1);
    expect(embeddingRequests[0].input).toEqual(["Text chunk"]);

    const chunks = await KbChunkModel.findByDocument(doc.id);
    const textChunk = chunks.find((c) => c.chunkIndex === 0);
    const imageChunk = chunks.find((c) => c.chunkIndex === 1);
    expect(textChunk?.embedding).toHaveLength(1536);
    expect(imageChunk?.embedding).toBeNull();
  });

  test("processDocument skips image formats outside the model's accepted list", async ({
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
      title: "Animated Doc",
      content: "Text with an inline GIF",
      contentHash: "hash-skip-format",
      embeddingStatus: "pending",
    });
    await KbChunkModel.insertMany([
      { documentId: doc.id, content: "Text chunk", chunkIndex: 0 },
      {
        documentId: doc.id,
        content: "data:image/gif;base64,Z2lm",
        chunkIndex: 1,
      },
    ]);

    responseQueue.push({ kind: "ok", embeddings: [makeFakeEmbedding(1)] });

    // Image modality is allowed, but the model takes JPEG/PNG only — the GIF
    // chunk is skipped instead of sent to a certain provider rejection.
    await embeddingService.processDocument(doc.id, {
      ...makeEmbeddingContext(),
      inputModalities: ["text", "image"],
      acceptedImageMimeTypes: ["image/jpeg", "image/png"],
    });

    const updated = await KbDocumentModel.findById(doc.id);
    expect(updated?.embeddingStatus).toBe("completed");

    expect(embeddingRequests).toHaveLength(1);
    expect(embeddingRequests[0].input).toEqual(["Text chunk"]);

    const chunks = await KbChunkModel.findByDocument(doc.id);
    const gifChunk = chunks.find((c) => c.chunkIndex === 1);
    expect(gifChunk?.embedding).toBeNull();
  });

  test("processDocuments completes a media document with zero embedded chunks and surfaces the skip count", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

    mockGetDefaultOrgEmbeddingConfig.mockResolvedValue({
      organizationId: org.id,
      config: makeEmbeddingContext(),
    });

    // A media document is a single image chunk (ingested when a previous
    // configuration allowed images).
    const mediaDoc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Screenshot",
      content: "data:image/png;base64,aW1hZ2U=",
      contentHash: "hash-skip-media",
      embeddingStatus: "pending",
    });
    const textDoc = await KbDocumentModel.create({
      connectorId: connector.id,
      organizationId: org.id,
      title: "Notes",
      content: "Notes content",
      contentHash: "hash-skip-text",
      embeddingStatus: "pending",
    });
    await KbChunkModel.insertMany([
      {
        documentId: mediaDoc.id,
        content: "data:image/png;base64,aW1hZ2U=",
        chunkIndex: 0,
      },
      { documentId: textDoc.id, content: "Notes chunk", chunkIndex: 0 },
    ]);

    responseQueue.push({ kind: "ok", embeddings: [makeFakeEmbedding(1)] });

    const outcome = await embeddingService.processDocuments([
      mediaDoc.id,
      textDoc.id,
    ]);

    // Neither document fails; the skip is reported, not swallowed into logs.
    expect(outcome.failedDocumentCount).toBe(0);
    expect(outcome.skippedImageChunkCount).toBe(1);

    const updatedMedia = await KbDocumentModel.findById(mediaDoc.id);
    expect(updatedMedia?.embeddingStatus).toBe("completed");
    const updatedText = await KbDocumentModel.findById(textDoc.id);
    expect(updatedText?.embeddingStatus).toBe("completed");

    expect(embeddingRequests).toHaveLength(1);
    expect(embeddingRequests[0].input).toEqual(["Notes chunk"]);
  });
});
