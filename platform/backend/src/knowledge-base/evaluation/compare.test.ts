import { describe, expect, it } from "vitest";
import { compareRuns } from "./compare";
import { aggregate, scoreQuery } from "./metrics";
import type { GoldenQuery, QueryResult, RunArtifact } from "./schema";

function result(
  id: string,
  expected: string,
  returnedDocs: string[],
  evidence?: { needle: string; contents: string[] },
): QueryResult {
  const golden: GoldenQuery = {
    id,
    query: `query ${id}`,
    expected: [
      { doc: expected, evidence: evidence ? [evidence.needle] : undefined },
    ],
    tags: ["t"],
    component: "text-embedding",
    requires: ["text-embedding"],
    expectAtK: 10,
    source: "hand",
  };
  const returned = returnedDocs.map((doc, index) => ({
    doc,
    ref: `${doc}#${index}`,
    content: evidence?.contents[index] ?? "",
  }));
  const { metrics, firstRank } = scoreQuery(golden, returned);
  return {
    id,
    query: golden.query,
    tags: golden.tags,
    requires: golden.requires,
    expectAtK: golden.expectAtK,
    expected: [expected],
    returned: returned.map(({ doc, ref }) => ({ doc, ref })),
    firstRank,
    latencyMs: 1,
    metrics,
    passed: true,
    stageFailures: [],
    stages: {
      expandedQueryCount: 1,
      expandedQueryTypes: ["semantic"],
      keywordRanker: "bm25",
      reranker: {
        status: "disabled",
        kind: null,
        provider: null,
        model: null,
        changedOrder: false,
        filteredCount: 0,
        error: null,
      },
      contextExpanded: false,
    },
  };
}

function artifact(
  name: string,
  queries: QueryResult[],
  overrides: Partial<RunArtifact["fingerprint"]> = {},
): RunArtifact {
  return {
    schemaVersion: 2,
    status: "completed",
    run: {
      name,
      organizationId: "00000000-0000-4000-8000-000000000001",
      queryLimit: 10,
    },
    fingerprint: {
      platformVersion: "1.0.0",
      gitSha: "abc",
      gitDirty: false,
      corpusDigest: "corpus",
      goldenDigest: "golden",
      effectiveConfig: { hybridSearchEnabled: true, chunkSizeTokens: 512 },
      embedding: {
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 768,
        inputModalities: ["text"],
      },
      reranker: null,
      ocr: null,
      ...overrides,
    },
    capabilities: {},
    ingest: {
      documents: 1,
      chunks: 1,
      textDocuments: 1,
      imageDocuments: 0,
      ocrDocuments: 0,
      contextualizedChunks: 0,
      wallMs: 1,
    },
    queries,
    skippedQueries: [],
    aggregates: aggregate(queries),
    byTag: {},
    cleanup: {
      kept: false,
      knowledgeBaseId: null,
      connectorId: null,
      completed: true,
    },
    warnings: [],
    errors: [],
  };
}

describe("compareRuns", () => {
  it("reports per-query direction, tallies and aggregate deltas", () => {
    const a = artifact("a", [
      result("q1", "gold", ["x", "gold"]),
      result("q2", "gold", ["gold"]),
      result("q3", "gold", ["x"]),
    ]);
    const b = artifact("b", [
      result("q1", "gold", ["gold"]),
      result("q2", "gold", ["x", "x", "gold"]),
      result("q3", "gold", ["x"]),
    ]);
    const comparison = compareRuns(a, b);
    expect(comparison.fingerprintMismatch).toEqual([]);
    expect(comparison.queries.map((query) => query.changed)).toEqual([
      true,
      true,
      false,
    ]);
    expect(comparison.queries[0].direction["hit@1"]).toBe("improved");
    expect(comparison.queries[1].direction["hit@1"]).toBe("regressed");
    expect(comparison.queries[0].direction["ndcg@5"]).toBe("improved");
    expect(comparison.queries[1].direction["ndcg@5"]).toBe("regressed");
    expect(comparison.queries[0].direction["precision@5"]).toBe("same");
    expect(comparison.tallies["hit@1"]).toEqual({
      wins: 1,
      losses: 1,
      ties: 1,
    });
    expect(comparison.uncertainty["hit@5"]).toMatchObject({
      estimate: 0,
      n: 3,
    });
    expect(comparison.uncertainty.mrr).toBeDefined();
  });

  it("tracks evidence only for rows that carry it", () => {
    const a = artifact("a", [
      result("q1", "gold", ["gold"], { needle: "answer", contents: ["no"] }),
      result("q2", "gold", ["gold"]),
    ]);
    const b = artifact("b", [
      result("q1", "gold", ["gold"], {
        needle: "answer",
        contents: ["the answer"],
      }),
      result("q2", "gold", ["gold"]),
    ]);
    const comparison = compareRuns(a, b);
    expect(comparison.queries[0].direction["evidence@10"]).toBe("improved");
    expect(comparison.queries[1].direction["evidence@10"]).toBeUndefined();
  });

  it("surfaces effective configuration and platform/model differences", () => {
    const a = artifact("a", [result("q1", "gold", ["gold"])]);
    const b = artifact("b", [result("q1", "gold", ["gold"])], {
      platformVersion: "2.0.0",
      gitSha: "def",
      gitDirty: true,
      effectiveConfig: { hybridSearchEnabled: false, chunkSizeTokens: 512 },
      embedding: {
        provider: "cohere",
        model: "embed-v4.0",
        dimensions: 1536,
        inputModalities: ["text", "image"],
      },
    });
    const comparison = compareRuns(a, b);
    expect(comparison.fingerprintNotes.join("\n")).toMatch(/platform version/);
    expect(comparison.fingerprintNotes.join("\n")).toMatch(/code revision/);
    expect(comparison.fingerprintNotes.join("\n")).toMatch(/uncommitted/);
    expect(comparison.configDiff).toEqual(
      expect.arrayContaining([
        { key: "hybridSearchEnabled", a: "true", b: "false" },
        {
          key: "embedding.model",
          a: "ollama/nomic-embed-text",
          b: "cohere/embed-v4.0",
        },
      ]),
    );
    expect(
      comparison.configDiff.some((entry) => entry.key === "embedding"),
    ).toBe(false);
  });

  it("flags fixture mismatches and unpaired queries", () => {
    const a = artifact("a", [result("q1", "gold", ["gold"])]);
    const b = artifact(
      "b",
      [result("q1", "gold", ["gold"]), result("q9", "gold", ["gold"])],
      { corpusDigest: "other-corpus" },
    );
    const comparison = compareRuns(a, b);
    expect(comparison.fingerprintMismatch).toEqual(["corpusDigest"]);
    expect(comparison.unpaired).toEqual({ onlyA: [], onlyB: ["q9"] });
  });

  it("compares aggregates only across selected overlap and reports missing components", () => {
    const before = artifact("before", [result("q1", "gold", ["x", "gold"])]);
    before.queries[0].component = "text-embedding";
    before.selection = {
      components: ["text-embedding"],
      componentFingerprints: { "text-embedding": "a" },
      componentResults: [
        {
          component: "text-embedding",
          mode: "online",
          status: "passed",
          detail: "passed",
        },
      ],
    };
    const newQuery = result("q2", "keyword", ["keyword"]);
    newQuery.component = "keyword-ranking";
    const after = artifact("after", [result("q1", "gold", ["gold"]), newQuery]);
    after.queries[0].component = "text-embedding";
    after.selection = {
      components: ["text-embedding", "keyword-ranking"],
      componentFingerprints: {
        "text-embedding": "a",
        "keyword-ranking": "b",
      },
      componentResults: [
        {
          component: "text-embedding",
          mode: "online",
          status: "failed",
          detail: "quality gate failed",
        },
      ],
    };
    after.fingerprint.effectiveConfig.hybridSearchEnabled = false;

    const comparison = compareRuns(before, after);
    expect(comparison.components).toEqual({
      a: ["text-embedding"],
      b: ["text-embedding", "keyword-ranking"],
      paired: ["text-embedding"],
      onlyA: [],
      onlyB: ["keyword-ranking"],
    });
    expect(comparison.pairedQueryCount).toBe(1);
    expect(comparison.componentResults).toEqual([
      {
        component: "text-embedding",
        a: { status: "passed", detail: "passed" },
        b: { status: "failed", detail: "quality gate failed" },
        changed: true,
      },
    ]);
    expect(comparison.aggregateScope).toBe("paired-queries");
    expect(comparison.unpaired.onlyB).toEqual(["q2"]);
    expect(comparison.configDiff).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "hybridSearchEnabled" }),
      ]),
    );
    expect(comparison.aggregates["hit@1"]).toEqual({
      a: 0,
      b: 1,
      delta: 1,
    });
  });

  it("reports BM25 score-margin changes when rank order is unchanged", () => {
    const beforeResult = result("q1", "gold", ["gold", "distractor"]);
    beforeResult.component = "keyword-ranking";
    beforeResult.stages.rankingScores = [
      { doc: "gold", ref: "gold#0", score: 1.2 },
      { doc: "distractor", ref: "distractor#0", score: 1 },
    ];
    const afterResult = result("q1", "gold", ["gold", "distractor"]);
    afterResult.component = "keyword-ranking";
    afterResult.stages.rankingScores = [
      { doc: "gold", ref: "gold#0", score: 1.5 },
      { doc: "distractor", ref: "distractor#0", score: 1 },
    ];
    const before = artifact("before", [beforeResult]);
    const after = artifact("after", [afterResult]);

    const comparison = compareRuns(before, after);

    expect(comparison.queries[0]).toMatchObject({
      changed: true,
      direction: {
        "hit@1": "same",
        mrr: "same",
        scoreMargin: "improved",
      },
      a: { expectedScore: 1.2 },
      b: { expectedScore: 1.5 },
    });
    expect(comparison.queries[0].a.scoreMargin).toBeCloseTo(0.2);
    expect(comparison.queries[0].b.scoreMargin).toBeCloseTo(0.5);
    expect(comparison.aggregates.meanScoreMargin?.a).toBeCloseTo(0.2);
    expect(comparison.aggregates.meanScoreMargin?.b).toBeCloseTo(0.5);
    expect(comparison.aggregates.meanScoreMargin?.delta).toBeCloseTo(0.3);
  });
});
