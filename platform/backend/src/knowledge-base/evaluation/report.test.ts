import { describe, expect, it } from "vitest";
import { renderRun } from "./report";
import type { RunArtifact } from "./schema";

describe("renderRun", () => {
  it("renders stronger ranking metrics and deterministic uncertainty", () => {
    const run = {
      schemaVersion: 2,
      status: "completed",
      run: {
        name: "stronger suite",
        organizationId: "00000000-0000-4000-8000-000000000001",
        queryLimit: 10,
      },
      fingerprint: {
        platformVersion: "test",
        gitSha: null,
        gitDirty: null,
        corpusDigest: "corpus",
        goldenDigest: "golden",
        effectiveConfig: {},
        embedding: null,
        reranker: null,
        ocr: null,
      },
      capabilities: {},
      ingest: {
        documents: 24,
        chunks: 24,
        textDocuments: 24,
        imageDocuments: 0,
        ocrDocuments: 0,
        contextualizedChunks: 0,
        wallMs: 1,
      },
      queries: [],
      skippedQueries: [],
      aggregates: {
        queries: 20,
        answerableQueries: 19,
        noAnswerQueries: 1,
        "hit@1": 0.5,
        "hit@3": 0.7,
        "hit@5": 0.8,
        "hit@10": 0.9,
        "recall@1": 0.4,
        "recall@3": 0.6,
        "recall@5": 0.7,
        "recall@10": 0.8,
        "precision@1": 0.5,
        "precision@3": 0.3,
        "precision@5": 0.2,
        "precision@10": 0.1,
        "ndcg@5": 0.75,
        "map@5": 0.7,
        "negativeHitRate@5": 0,
        noAnswerForcedRetrievalRate: 1,
        mrr: 0.8,
        queriesWithEvidence: 0,
        meanReturned: 5,
      },
      byTag: {},
      bySegment: {
        category: { "hard-negative": { queries: 2 } },
        language: { en: { queries: 20 } },
        difficulty: { hard: { queries: 2 } },
      },
      uncertainty: {
        method: "deterministic-bootstrap",
        confidenceLevel: 0.95,
        samples: 2000,
        seed: "suite",
        metrics: {
          "ndcg@5": { estimate: 0.75, lower: 0.5, upper: 0.9, n: 19 },
        },
      },
      cleanup: {
        kept: false,
        knowledgeBaseId: null,
        connectorId: null,
        completed: true,
      },
      warnings: [],
      errors: [],
    } as RunArtifact;

    const output = renderRun(run);
    expect(output).toContain("precision@5");
    expect(output).toContain("nDCG@5");
    expect(output).toContain("MAP@5");
    expect(output).toContain("negative-hit@5");
    expect(output).toContain("95% bootstrap intervals");
    expect(output).toContain("no-answer forced retrieval");
  });
});
