import { componentDefinition } from "./components";
import { aggregate, bootstrapPairedDelta } from "./metrics";
import type {
  KnowledgeEvaluationComponent,
  QueryResult,
  RunArtifact,
} from "./schema";
import { KNOWLEDGE_EVALUATION_COMPONENTS, RETRIEVAL_KS } from "./schema";

/**
 * Per-query comparison of two runs (A = before, B = after). The aggregate
 * delta is reported too, but the per-query rows are the point: an aggregate
 * hides the case where a change fixes five queries and breaks five others.
 */

export type Direction = "improved" | "regressed" | "same";

export interface Tally {
  wins: number;
  losses: number;
  ties: number;
}

export interface QuerySide {
  bestRank: number | null;
  expectedScore: number | null;
  scoreMargin: number | null;
  returned: number;
  hit: Record<string, number>;
  recall: Record<string, number>;
  reciprocalRank: number;
  evidence: Record<string, number | null>;
  precision?: Record<string, number>;
  ndcg?: Record<string, number | null>;
  averagePrecision?: Record<string, number | null>;
  negativeHit?: Record<string, number | null>;
}

export interface QueryDelta {
  id: string;
  component?: QueryResult["component"];
  query: string;
  tags: string[];
  expected: string[];
  gateMode?: QueryResult["gateMode"];
  a: QuerySide;
  b: QuerySide;
  /** Per metric name (`hit@5`, `mrr`, `evidence@10`, `recall@5` for multi-document queries, …). */
  direction: Record<string, Direction>;
  /** The number of returned chunks differs (a reranker floor, a timeout) — not a win or loss, but a change. */
  returnedChanged: boolean;
  changed: boolean;
}

export interface Comparison {
  a: { name: string; warnings: string[]; errors: string[] };
  b: { name: string; warnings: string[]; errors: string[] };
  /** Fixture fields that make the runs not directly comparable. */
  fingerprintMismatch: string[];
  /** Informational code/platform fingerprint differences. */
  fingerprintNotes: string[];
  configDiff: { key: string; a: string; b: string }[];
  /** Every paired query expects exactly one document (then recall@k ≡ hit@k and is not reported twice). */
  singleExpected: boolean;
  queries: QueryDelta[];
  tallies: Record<string, Tally>;
  aggregates: Record<string, { a: number; b: number; delta: number }>;
  uncertainty: Record<
    string,
    {
      estimate: number;
      lower: number;
      upper: number;
      probabilityImproved: number;
      n: number;
    }
  >;
  aggregateScope: "paired-queries";
  pairedQueryCount: number;
  components: {
    a: KnowledgeEvaluationComponent[];
    b: KnowledgeEvaluationComponent[];
    paired: KnowledgeEvaluationComponent[];
    onlyA: KnowledgeEvaluationComponent[];
    onlyB: KnowledgeEvaluationComponent[];
  };
  componentResults: Array<{
    component: KnowledgeEvaluationComponent;
    a: { status: "passed" | "failed" | "skipped"; detail: string } | null;
    b: { status: "passed" | "failed" | "skipped"; detail: string } | null;
    changed: boolean;
  }>;
  /** Query ids present in only one run. */
  unpaired: { onlyA: string[]; onlyB: string[] };
}

export function compareRuns(
  runA: RunArtifact,
  runB: RunArtifact,
  ks: readonly number[] = RETRIEVAL_KS,
): Comparison {
  const fingerprintMismatch = (
    ["corpusDigest", "goldenDigest"] as const
  ).filter((key) => runA.fingerprint[key] !== runB.fingerprint[key]);
  const fingerprintNotes: string[] = [];
  if (runA.fingerprint.gitSha !== runB.fingerprint.gitSha) {
    fingerprintNotes.push(
      `code revision differs: A=${runA.fingerprint.gitSha ?? "unknown"} B=${runB.fingerprint.gitSha ?? "unknown"}`,
    );
  }
  if (runA.fingerprint.platformVersion !== runB.fingerprint.platformVersion) {
    fingerprintNotes.push(
      `platform version differs: A=${runA.fingerprint.platformVersion} B=${runB.fingerprint.platformVersion}`,
    );
  }
  for (const [label, run] of [
    ["A", runA],
    ["B", runB],
  ] as const) {
    if (run.fingerprint.gitDirty) {
      fingerprintNotes.push(
        `${label} ran with uncommitted changes to tracked files (gitDirty)`,
      );
    }
  }
  const componentsA = selectedComponents(runA);
  const componentsB = selectedComponents(runB);
  const pairedComponents = componentsA.filter((component) =>
    componentsB.includes(component),
  );
  const componentResultsA = new Map(
    runA.selection?.componentResults.map((result) => [
      result.component,
      { status: result.status, detail: result.detail },
    ]) ?? [],
  );
  const componentResultsB = new Map(
    runB.selection?.componentResults.map((result) => [
      result.component,
      { status: result.status, detail: result.detail },
    ]) ?? [],
  );
  const componentResults = pairedComponents.map((component) => {
    const a = componentResultsA.get(component) ?? null;
    const b = componentResultsB.get(component) ?? null;
    return {
      component,
      a,
      b,
      changed: a?.status !== b?.status || a?.detail !== b?.detail,
    };
  });
  const configKeys = [
    ...new Set([
      ...Object.keys(runA.fingerprint.effectiveConfig),
      ...Object.keys(runB.fingerprint.effectiveConfig),
    ]),
  ]
    .sort()
    .filter((key) => !["embedding", "reranker", "ocr"].includes(key))
    .filter((key) => configKeyRelevant(key, pairedComponents));
  const configDiff = configKeys
    .map((key) => ({
      key,
      a: String(runA.fingerprint.effectiveConfig[key] ?? ""),
      b: String(runB.fingerprint.effectiveConfig[key] ?? ""),
    }))
    .filter((entry) => entry.a !== entry.b);
  if (
    pairedComponents.some(
      (component) => componentDefinition(component).mode === "online",
    )
  ) {
    addModelDiff(
      configDiff,
      "embedding",
      runA.fingerprint.embedding,
      runB.fingerprint.embedding,
    );
  }
  if (
    pairedComponents.some((component) =>
      ["reranking", "query-expansion", "contextual-retrieval"].includes(
        component,
      ),
    )
  ) {
    addModelDiff(
      configDiff,
      "reranker",
      runA.fingerprint.reranker,
      runB.fingerprint.reranker,
    );
  }
  if (pairedComponents.includes("ocr")) {
    addModelDiff(configDiff, "ocr", runA.fingerprint.ocr, runB.fingerprint.ocr);
  }
  if (
    pairedComponents.some((component) => component !== "chunking") &&
    runA.run.queryLimit !== runB.run.queryLimit
  ) {
    configDiff.push({
      key: "query.limit",
      a: String(runA.run.queryLimit),
      b: String(runB.run.queryLimit),
    });
  }

  const byIdB = new Map(runB.queries.map((query) => [query.id, query]));
  const idsA = new Set(runA.queries.map((query) => query.id));
  const names = metricNames(ks);
  const tallies: Record<string, Tally> = Object.fromEntries(
    names.map((name) => [name, { wins: 0, losses: 0, ties: 0 }]),
  );

  const queries: QueryDelta[] = [];
  for (const resultA of runA.queries) {
    const resultB = byIdB.get(resultA.id);
    if (!resultB) continue;
    const a = side(resultA);
    const b = side(resultB);
    const direction: Record<string, Direction> = {};
    for (const k of ks) {
      direction[`hit@${k}`] = directionOf(
        a.hit[String(k)] ?? 0,
        b.hit[String(k)] ?? 0,
      );
      if (resultA.expected.length > 1) {
        direction[`recall@${k}`] = directionOf(
          a.recall[String(k)] ?? 0,
          b.recall[String(k)] ?? 0,
        );
      }
      const evidenceA = a.evidence[String(k)];
      const evidenceB = b.evidence[String(k)];
      if (
        evidenceA !== null &&
        evidenceA !== undefined &&
        evidenceB !== null &&
        evidenceB !== undefined
      ) {
        direction[`evidence@${k}`] = directionOf(evidenceA, evidenceB);
      }
      direction[`precision@${k}`] = directionOf(
        a.precision?.[String(k)] ?? 0,
        b.precision?.[String(k)] ?? 0,
      );
      const ndcgA = a.ndcg?.[String(k)];
      const ndcgB = b.ndcg?.[String(k)];
      if (ndcgA != null && ndcgB != null) {
        direction[`ndcg@${k}`] = directionOf(ndcgA, ndcgB);
      }
      const apA = a.averagePrecision?.[String(k)];
      const apB = b.averagePrecision?.[String(k)];
      if (apA != null && apB != null) {
        direction[`map@${k}`] = directionOf(apA, apB);
      }
      const negativeA = a.negativeHit?.[String(k)];
      const negativeB = b.negativeHit?.[String(k)];
      if (negativeA != null && negativeB != null) {
        direction[`negativeHitRate@${k}`] = directionOfLower(
          negativeA,
          negativeB,
        );
      }
    }
    direction.mrr = directionOf(a.reciprocalRank, b.reciprocalRank);
    if (a.scoreMargin !== null && b.scoreMargin !== null) {
      direction.scoreMargin = directionOf(a.scoreMargin, b.scoreMargin);
    }
    for (const [name, value] of Object.entries(direction)) {
      let tally = tallies[name];
      if (!tally) {
        tally = { wins: 0, losses: 0, ties: 0 };
        tallies[name] = tally;
      }
      if (value === "improved") tally.wins += 1;
      else if (value === "regressed") tally.losses += 1;
      else tally.ties += 1;
    }
    const returnedChanged = a.returned !== b.returned;
    queries.push({
      id: resultA.id,
      component: resultA.component,
      query: resultA.query,
      tags: resultA.tags,
      expected: resultA.expected,
      gateMode: resultA.gateMode,
      a,
      b,
      direction,
      returnedChanged,
      changed:
        returnedChanged ||
        Object.values(direction).some((value) => value !== "same"),
    });
  }

  const pairedIds = new Set(queries.map((query) => query.id));
  const aggregateA = aggregate(
    runA.queries.filter((query) => pairedIds.has(query.id)),
  );
  const aggregateB = aggregate(
    runB.queries.filter((query) => pairedIds.has(query.id)),
  );
  const aggregates: Comparison["aggregates"] = {};
  for (const name of [
    ...names,
    ...ks.map((k) => `recall@${k}`),
    ...ks.map((k) => `precision@${k}`),
    ...ks.map((k) => `ndcg@${k}`),
    ...ks.map((k) => `map@${k}`),
    ...ks.map((k) => `negativeHitRate@${k}`),
    "meanReturned",
    "noAnswerForcedRetrievalRate",
    "noAnswerMeanReturned",
  ]) {
    const a = aggregateA[name];
    const b = aggregateB[name];
    if (a === undefined || b === undefined) continue;
    aggregates[name] = { a, b, delta: b - a };
  }
  const scorePairs = queries.filter(
    (query) => query.a.scoreMargin !== null && query.b.scoreMargin !== null,
  );
  if (scorePairs.length > 0) {
    const meanA =
      scorePairs.reduce((sum, query) => sum + (query.a.scoreMargin ?? 0), 0) /
      scorePairs.length;
    const meanB =
      scorePairs.reduce((sum, query) => sum + (query.b.scoreMargin ?? 0), 0) /
      scorePairs.length;
    aggregates.meanScoreMargin = {
      a: meanA,
      b: meanB,
      delta: meanB - meanA,
    };
  }
  const uncertainty: Comparison["uncertainty"] = {};
  const pairedMetrics: Record<string, Array<{ a: number; b: number }>> = {
    "hit@5": queries.map((query) => ({
      a: query.a.hit["5"] ?? 0,
      b: query.b.hit["5"] ?? 0,
    })),
    mrr: queries.map((query) => ({
      a: query.a.reciprocalRank,
      b: query.b.reciprocalRank,
    })),
    "precision@5": queries.map((query) => ({
      a: query.a.precision?.["5"] ?? 0,
      b: query.b.precision?.["5"] ?? 0,
    })),
    "ndcg@5": queries.flatMap((query) => {
      const a = query.a.ndcg?.["5"];
      const b = query.b.ndcg?.["5"];
      return a == null || b == null ? [] : [{ a, b }];
    }),
    "map@5": queries.flatMap((query) => {
      const a = query.a.averagePrecision?.["5"];
      const b = query.b.averagePrecision?.["5"];
      return a == null || b == null ? [] : [{ a, b }];
    }),
  };
  for (const [metric, pairs] of Object.entries(pairedMetrics)) {
    const interval = bootstrapPairedDelta({
      pairs,
      seed: `${runA.fingerprint.goldenDigest}:${runB.fingerprint.goldenDigest}:${metric}`,
    });
    if (interval) uncertainty[metric] = interval;
  }

  return {
    a: {
      name: runA.run.name,
      warnings: runA.warnings,
      errors: runA.errors,
    },
    b: {
      name: runB.run.name,
      warnings: runB.warnings,
      errors: runB.errors,
    },
    fingerprintMismatch,
    fingerprintNotes,
    configDiff,
    singleExpected: queries.every((query) => query.expected.length === 1),
    queries,
    tallies,
    aggregates,
    uncertainty,
    aggregateScope: "paired-queries",
    pairedQueryCount: queries.length,
    components: {
      a: componentsA,
      b: componentsB,
      paired: pairedComponents,
      onlyA: componentsA.filter(
        (component) => !componentsB.includes(component),
      ),
      onlyB: componentsB.filter(
        (component) => !componentsA.includes(component),
      ),
    },
    componentResults,
    unpaired: {
      onlyA: runA.queries
        .filter((query) => !byIdB.has(query.id))
        .map((query) => query.id),
      onlyB: runB.queries
        .filter((query) => !idsA.has(query.id))
        .map((query) => query.id),
    },
  };
}

function selectedComponents(run: RunArtifact): KnowledgeEvaluationComponent[] {
  if (run.selection) return run.selection.components;
  const inferred = [
    ...new Set(
      run.queries
        .map((query) => query.component)
        .filter((component): component is NonNullable<typeof component> =>
          Boolean(component),
        ),
    ),
  ];
  return inferred.length > 0 ? inferred : [...KNOWLEDGE_EVALUATION_COMPONENTS];
}

function configKeyRelevant(
  key: string,
  components: KnowledgeEvaluationComponent[],
): boolean {
  return components.some((component) =>
    COMPONENT_CONFIG_KEYS[component].includes(key),
  );
}

const COMPONENT_CONFIG_KEYS: Record<KnowledgeEvaluationComponent, string[]> = {
  chunking: ["chunkSizeTokens"],
  "text-embedding": ["embedding"],
  "image-embedding": ["embedding", "imageEmbedding"],
  "keyword-ranking": [
    "hybridSearchEnabled",
    "bm25K1",
    "bm25B",
    "bm25RecallCap",
  ],
  "hybrid-retrieval": [
    "embedding",
    "hybridSearchEnabled",
    "searchStatementTimeoutMillis",
  ],
  reranking: ["embedding", "reranker"],
  "query-expansion": ["embedding", "reranker"],
  "contextual-retrieval": [
    "embedding",
    "reranker",
    "contextualRetrievalEnabled",
    "contextualRetrievalMode",
  ],
  "context-expansion": ["contextExpansionRadius"],
  ocr: ["embedding", "ocr", "ocrMaxPagesPerDocument"],
};

function addModelDiff(
  target: { key: string; a: string; b: string }[],
  prefix: string,
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
): void {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
  if (keys.length === 0 && a === b) return;
  if (a === null || b === null) {
    target.push({
      key: prefix,
      a: a ? "configured" : "disabled",
      b: b ? "configured" : "disabled",
    });
    return;
  }
  const identityA = [a.provider, a.model].filter(Boolean).join("/");
  const identityB = [b.provider, b.model].filter(Boolean).join("/");
  if (identityA !== identityB) {
    target.push({
      key: `${prefix}.model`,
      a: identityA,
      b: identityB,
    });
  }
  for (const key of keys.filter(
    (candidate) => !["provider", "model"].includes(candidate),
  )) {
    const valueA = String(a[key] ?? "");
    const valueB = String(b[key] ?? "");
    if (valueA !== valueB) {
      target.push({ key: `${prefix}.${key}`, a: valueA, b: valueB });
    }
  }
}

// ===== Internal helpers =====

function side(result: QueryResult): QuerySide {
  const ranks = Object.values(result.firstRank).filter(
    (rank): rank is number => rank !== null,
  );
  const rankingScores = result.stages.rankingScores ?? [];
  const expected = new Set(result.expected);
  const expectedScores = rankingScores
    .filter((entry) => expected.has(entry.doc))
    .map((entry) => entry.score);
  const distractorScores = rankingScores
    .filter((entry) => !expected.has(entry.doc))
    .map((entry) => entry.score);
  const expectedScore =
    expectedScores.length > 0 ? Math.max(...expectedScores) : null;
  const distractorScore =
    distractorScores.length > 0 ? Math.max(...distractorScores) : null;
  return {
    bestRank: ranks.length === 0 ? null : Math.min(...ranks),
    expectedScore,
    scoreMargin:
      expectedScore !== null && distractorScore !== null
        ? expectedScore - distractorScore
        : null,
    returned: result.returned.length,
    hit: result.metrics.hit,
    recall: result.metrics.recall,
    reciprocalRank: result.metrics.reciprocalRank,
    evidence: result.metrics.evidence,
    precision: result.metrics.precision,
    ndcg: result.metrics.ndcg,
    averagePrecision: result.metrics.averagePrecision,
    negativeHit: result.metrics.negativeHit,
  };
}

function directionOf(a: number, b: number): Direction {
  if (b > a) return "improved";
  if (b < a) return "regressed";
  return "same";
}

function directionOfLower(a: number, b: number): Direction {
  return directionOf(-a, -b);
}

function metricNames(ks: readonly number[] = RETRIEVAL_KS): string[] {
  return [
    ...ks.map((k) => `hit@${k}`),
    "mrr",
    ...ks.map((k) => `evidence@${k}`),
    ...ks.map((k) => `precision@${k}`),
    ...ks.map((k) => `ndcg@${k}`),
    ...ks.map((k) => `map@${k}`),
    ...ks.map((k) => `negativeHitRate@${k}`),
  ];
}
