import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import * as embeddingClients from "@/knowledge-base/embedding-clients";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import OrganizationModel from "@/models/organization";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { compareRuns } from "./compare";
import {
  DEFAULT_CORPUS_PATH,
  DEFAULT_GOLDEN_PATH,
  digestFile,
  loadCorpus,
  loadGolden,
} from "./fixtures";
import { RetrievalEvaluationCancelledError, runInstance } from "./run";
import type { CorpusDocument, GoldenQuery } from "./schema";

const EMBEDDING_URL = "http://kb-eval.invalid/v1/embeddings";

describe("runInstance", () => {
  const server = useMswServer();

  test("uses the real ingest/query/BM25 path and cleans up its fixture", async ({
    makeOrganization,
  }) => {
    server.use(
      http.post(EMBEDDING_URL, async ({ request }) => {
        const body = (await request.json()) as {
          model: string;
          input: string[];
        };
        return HttpResponse.json({
          object: "list",
          data: body.input.map((_, index) => ({
            object: "embedding",
            embedding: encodeEmbedding(
              Array.from({ length: 768 }, (__, dimension) =>
                dimension === index ? 1 : 0.001,
              ),
            ),
            index,
          })),
          model: body.model,
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      }),
    );

    const organization = await makeOrganization();
    const apiKey = await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      name: "evaluation test Ollama",
      provider: "ollama",
      scope: "org",
      secretId: null,
      baseUrl: "http://kb-eval.invalid/v1",
      isPrimary: true,
    });
    await OrganizationModel.patch(organization.id, {
      embeddingChatApiKeyId: apiKey.id,
      embeddingModel: "nomic-embed-text",
      embeddingDimensions: 768,
    });

    const corpus: CorpusDocument[] = [
      {
        id: "runbook",
        title: "Rotation runbook",
        content:
          "Runbook EXACT-EVAL-4719 says to rotate the credential every 90 days.",
        kind: "text",
        requires: ["text-embedding"],
      },
      {
        id: "glossary",
        title: "Glossary",
        content: "A glossary of unrelated platform vocabulary.",
        kind: "text",
        requires: ["text-embedding"],
      },
    ];
    const golden: GoldenQuery[] = [
      {
        id: "identifier",
        query: "EXACT-EVAL-4719",
        expected: [{ doc: "runbook", evidence: ["every 90 days"] }],
        tags: ["bm25"],
        component: "keyword-ranking",
        requires: ["text-embedding", "hybrid-search", "bm25"],
        expectAtK: 3,
        source: "hand",
      },
    ];

    const artifact = await runInstance({
      organizationId: organization.id,
      name: "integration",
      queryLimit: 3,
      keepFixture: false,
      corpus,
      golden,
      corpusDigest: "corpus",
      goldenDigest: "golden",
    });

    expect(artifact.errors).toEqual([]);
    expect(
      artifact.queries
        .filter(
          (query) =>
            query.component === "keyword-ranking" &&
            query.gateMode !== "metric-only" &&
            !query.passed,
        )
        .map((query) => query.id),
    ).toEqual([]);
    expect(artifact.status).not.toBe("blocked");
    expect(artifact.ingest).toMatchObject({
      documents: 2,
      textDocuments: 2,
      imageDocuments: 0,
      ocrDocuments: 0,
    });
    expect(artifact.capabilities.bm25.status).toBe("active");
    expect(artifact.queries).toHaveLength(1);
    expect(artifact.queries[0].stages.keywordRanker).toBe("bm25");
    expect(artifact.queries[0].stages.expandedQueryCount).toBe(1);
    expect(artifact.queries[0].stages.reranker.status).toBe("disabled");
    expect(artifact.queries[0].firstRank.runbook).toBe(1);
    expect(artifact.queries[0].metrics.evidence["3"]).toBe(1);
    expect(artifact.cleanup).toEqual({
      kept: false,
      knowledgeBaseId: null,
      connectorId: null,
      completed: true,
    });
  });

  test("honors cooperative cancellation before starting provider work", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const onProgress = vi.fn();
    await expect(
      runInstance({
        organizationId: organization.id,
        queryLimit: 10,
        keepFixture: false,
        corpus: [],
        golden: [],
        corpusDigest: "corpus",
        goldenDigest: "golden",
        control: {
          shouldCancel: () => true,
          onProgress,
        },
      }),
    ).rejects.toBeInstanceOf(RetrievalEvaluationCancelledError);
    expect(onProgress).not.toHaveBeenCalled();
  });

  test("isolates an embedding-only run from keyword, expansion, reranking, and context stages", async ({
    makeOrganization,
  }) => {
    server.use(
      http.post(EMBEDDING_URL, async ({ request }) => {
        const body = (await request.json()) as {
          model: string;
          input: string[];
        };
        return HttpResponse.json({
          object: "list",
          data: body.input.map((_, index) => ({
            object: "embedding",
            embedding: encodeEmbedding(new Array(768).fill(index + 0.001)),
            index,
          })),
          model: body.model,
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      }),
    );
    const organization = await makeOrganization();
    const apiKey = await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      name: "embedding-only test",
      provider: "ollama",
      scope: "org",
      secretId: null,
      baseUrl: "http://kb-eval.invalid/v1",
      isPrimary: true,
    });
    await OrganizationModel.patch(organization.id, {
      embeddingChatApiKeyId: apiKey.id,
      embeddingModel: "nomic-embed-text",
      embeddingDimensions: 768,
    });
    const corpus: CorpusDocument[] = [
      {
        id: "asterline-canary",
        title: "Asterline Canary Operations",
        content:
          "Asterline automatically rolls back when the error rate exceeds four percent.",
        kind: "text",
        requires: [],
      },
    ];
    const golden: GoldenQuery[] = [
      {
        id: "text-semantic",
        query: "What makes Asterline roll back?",
        expected: [{ doc: "asterline-canary" }],
        tags: ["text"],
        component: "text-embedding",
        requires: ["text-embedding"],
        expectAtK: 5,
        source: "hand",
      },
    ];

    const artifact = await runInstance({
      organizationId: organization.id,
      queryLimit: 5,
      keepFixture: false,
      corpus,
      golden,
      corpusDigest: "corpus",
      goldenDigest: "golden",
      selectedComponents: ["text-embedding"],
    });

    expect(artifact.queries[0].stages).toMatchObject({
      expandedQueryCount: 1,
      keywordRanker: "disabled",
      contextExpanded: false,
      reranker: { status: "disabled" },
    });
  });

  test("runs offline-only components without any embedding or upstream call", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const embeddingSpy = vi.spyOn(embeddingClients, "callEmbedding");
    const options: Parameters<typeof runInstance>[0] = {
      organizationId: organization.id,
      name: "offline components",
      queryLimit: 10,
      keepFixture: false,
      corpus: loadCorpus(),
      golden: loadGolden(),
      corpusDigest: digestFile(DEFAULT_CORPUS_PATH),
      goldenDigest: digestFile(DEFAULT_GOLDEN_PATH),
      selectedComponents: ["chunking", "keyword-ranking", "context-expansion"],
    };
    const artifact = await runInstance(options);

    expect(embeddingSpy).not.toHaveBeenCalled();
    expect(artifact.errors).toEqual([]);
    expect(artifact.selection?.components).toEqual([
      "chunking",
      "keyword-ranking",
      "context-expansion",
    ]);
    expect(artifact.selection?.componentResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "chunking",
          mode: "offline",
          status: "passed",
        }),
        expect.objectContaining({
          component: "keyword-ranking",
          mode: "offline",
          status: "passed",
        }),
        expect.objectContaining({
          component: "context-expansion",
          mode: "offline",
          status: "passed",
        }),
      ]),
    );
    expect(
      artifact.queries.filter((query) => query.component === "keyword-ranking"),
    ).toHaveLength(6);
    const kepler = artifact.queries.find(
      (query) => query.id === "bm25-kepler-hard-negative",
    );
    expect(kepler?.metrics.firstForbiddenRank).toBeGreaterThan(1);
    expect(kepler?.metrics.negativeHit?.["1"]).toBe(0);
    expect(kepler?.metrics.negativeHit?.["5"]).toBe(1);
    expect(
      artifact.queries.find((query) => query.id === "bm25-multi-glacier")
        ?.metrics.recall["3"],
    ).toBe(1);
    expect(
      artifact.queries.find(
        (query) => query.id === "keyword-no-answer-control",
      ),
    ).toMatchObject({
      answerability: "no-answer",
      gateMode: "metric-only",
      returned: [],
    });
    expect(
      artifact.queries.filter(
        (query) => query.component === "context-expansion",
      ),
    ).toHaveLength(1);
    expect(
      artifact.queries
        .filter((query) => query.component === "keyword-ranking")
        .every((query) => query.stages.rankingScores !== undefined),
    ).toBe(true);

    await OrganizationModel.patch(organization.id, {
      kbBm25K1: 0.6,
      kbBm25B: 0.37,
    });
    const tunedArtifact = await runInstance({
      ...options,
      name: "tuned offline components",
    });
    const comparison = compareRuns(artifact, tunedArtifact);
    const bm25Queries = comparison.queries.filter(
      (query) => query.component === "keyword-ranking",
    );
    const legacyBm25Queries = bm25Queries.filter((query) =>
      ["bm25-term-saturation", "bm25-length-normalization"].includes(query.id),
    );
    expect(
      legacyBm25Queries.every((query) => query.a.bestRank === query.b.bestRank),
    ).toBe(true);
    expect(
      bm25Queries.some((query) => query.direction.scoreMargin !== "same"),
    ).toBe(true);
    expect(comparison.aggregates.meanScoreMargin?.delta).not.toBe(0);
    expect(embeddingSpy).not.toHaveBeenCalled();
  });
});

function encodeEmbedding(values: number[]): string {
  const floats = new Float32Array(values);
  return Buffer.from(
    floats.buffer,
    floats.byteOffset,
    floats.byteLength,
  ).toString("base64");
}
