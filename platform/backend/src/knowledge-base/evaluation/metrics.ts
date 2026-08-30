import type { GoldenQuery, QueryMetrics, QueryResult } from "./schema";
import { RETRIEVAL_KS } from "./schema";

/**
 * Retrieval metrics over what the model actually receives: the ordered list of
 * returned chunks. `k` counts CHUNKS (the product's `limit`), and documents are
 * collapsed by first occurrence — never by `score`, which is a lane score that
 * does not order the fused list.
 *
 * - hit@k      1 if any expected document has a chunk within the first k
 * - recall@k   expected documents with a chunk within the first k / expected
 * - RR         1 / rank of the first chunk from any expected document (0 if none)
 * - evidence@k 1 if a chunk of an expected document within the first k contains
 *              one of that document's evidence strings; null when the query
 *              carries no evidence (not counted in the aggregate)
 *
 * With one expected document per query, hit@k and recall@k coincide — the
 * report says so instead of printing them as two signals.
 */

export interface ReturnedChunk {
  doc: string;
  ref: string;
  content: string;
}

/** Lowercase, drop markdown emphasis/backticks, collapse whitespace. @public — consumed by fixtures.test.ts */
export function normalizeForEvidence(text: string): string {
  return text.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

/** @public — consumed by metrics.test.ts */
export function documentsWithin(
  returned: ReturnedChunk[],
  k: number,
): string[] {
  const docs: string[] = [];
  for (const chunk of returned.slice(0, k)) {
    if (!docs.includes(chunk.doc)) docs.push(chunk.doc);
  }
  return docs;
}

export function scoreQuery(
  golden: GoldenQuery,
  returned: ReturnedChunk[],
  ks: readonly number[] = RETRIEVAL_KS,
): Pick<QueryResult, "metrics" | "firstRank"> {
  const expectedDocs = golden.expected.map((expected) => expected.doc);
  const relevance = new Map<string, number>(
    expectedDocs.map((doc) => [doc, 1] as const),
  );
  for (const judgment of golden.judgments ?? []) {
    relevance.set(judgment.doc, judgment.relevance);
  }
  const relevantDocs = [...relevance.entries()]
    .filter(([, grade]) => grade > 0)
    .map(([doc]) => doc);
  const firstRank: Record<string, number | null> = {};
  for (const doc of expectedDocs) {
    const index = returned.findIndex((chunk) => chunk.doc === doc);
    firstRank[doc] = index === -1 ? null : index + 1;
  }
  const bestRank = Object.values(firstRank)
    .filter((rank): rank is number => rank !== null)
    .reduce<number | null>(
      (best, rank) => (best === null || rank < best ? rank : best),
      null,
    );

  const evidenceByDoc = new Map<string, string[]>();
  for (const expected of golden.expected) {
    if (expected.evidence && expected.evidence.length > 0) {
      evidenceByDoc.set(
        expected.doc,
        expected.evidence.map(normalizeForEvidence),
      );
    }
  }

  const hit: Record<string, number> = {};
  const recall: Record<string, number> = {};
  const evidence: Record<string, number | null> = {};
  const precision: Record<string, number> = {};
  const ndcg: Record<string, number | null> = {};
  const averagePrecision: Record<string, number | null> = {};
  const negativeHit: Record<string, number | null> = {};
  const forbidden = new Set(golden.forbidden ?? []);
  const uniqueReturned = documentsWithin(returned, returned.length);
  const firstForbiddenIndex = uniqueReturned.findIndex((doc) =>
    forbidden.has(doc),
  );
  for (const k of ks) {
    const docs = documentsWithin(returned, k);
    const rankedDocuments = uniqueReturned.slice(0, k);
    const found = expectedDocs.filter((doc) => docs.includes(doc));
    hit[String(k)] = found.length > 0 ? 1 : 0;
    recall[String(k)] =
      expectedDocs.length === 0 ? 0 : found.length / expectedDocs.length;
    const relevantFound = rankedDocuments.filter((doc) =>
      relevantDocs.includes(doc),
    );
    precision[String(k)] = relevantFound.length / k;
    ndcg[String(k)] = normalizedDiscountedCumulativeGain({
      rankedDocs: rankedDocuments,
      relevance,
      k,
    });
    averagePrecision[String(k)] = averagePrecisionAtK({
      rankedDocs: rankedDocuments,
      relevantDocs,
      k,
    });
    negativeHit[String(k)] =
      forbidden.size === 0
        ? null
        : rankedDocuments.some((doc) => forbidden.has(doc))
          ? 1
          : 0;
    if (evidenceByDoc.size === 0) {
      evidence[String(k)] = null;
      continue;
    }
    const evidenceMatches = [...evidenceByDoc.entries()].flatMap(
      ([doc, needles]) =>
        needles.map((needle) =>
          returned.slice(0, k).some((chunk) => {
            if (chunk.doc !== doc) return false;
            return normalizeForEvidence(chunk.content).includes(needle);
          }),
        ),
    );
    const matched =
      golden.evidenceMode === "all"
        ? evidenceMatches.every(Boolean)
        : evidenceMatches.some(Boolean);
    evidence[String(k)] = matched ? 1 : 0;
  }

  const metrics: QueryMetrics = {
    hit,
    recall,
    reciprocalRank: bestRank === null ? 0 : 1 / bestRank,
    evidence,
    precision,
    ndcg,
    averagePrecision,
    negativeHit,
    firstForbiddenRank:
      firstForbiddenIndex === -1 ? null : firstForbiddenIndex + 1,
  };
  return { metrics, firstRank };
}

/** Macro-averaged metrics over a set of scored queries. */
export function aggregate(
  results: Pick<QueryResult, "metrics" | "returned" | "answerability">[],
  ks: readonly number[] = RETRIEVAL_KS,
): Record<string, number> {
  const answerable = results.filter(
    (result) => result.answerability !== "no-answer",
  );
  const noAnswer = results.filter(
    (result) => result.answerability === "no-answer",
  );
  const out: Record<string, number> = {
    queries: results.length,
    answerableQueries: answerable.length,
    noAnswerQueries: noAnswer.length,
  };
  for (const k of ks) {
    out[`hit@${k}`] = mean(
      answerable.map((r) => r.metrics.hit[String(k)] ?? 0),
    );
    out[`recall@${k}`] = mean(
      answerable.map((r) => r.metrics.recall[String(k)] ?? 0),
    );
    const withEvidence = answerable
      .map((r) => r.metrics.evidence[String(k)])
      .filter(
        (value): value is number => value !== null && value !== undefined,
      );
    if (withEvidence.length > 0) out[`evidence@${k}`] = mean(withEvidence);
    out[`precision@${k}`] = mean(
      answerable.map((r) => r.metrics.precision?.[String(k)] ?? 0),
    );
    const withNdcg = answerable
      .map((r) => r.metrics.ndcg?.[String(k)])
      .filter(
        (value): value is number => value !== null && value !== undefined,
      );
    if (withNdcg.length > 0) out[`ndcg@${k}`] = mean(withNdcg);
    const withAveragePrecision = answerable
      .map((r) => r.metrics.averagePrecision?.[String(k)])
      .filter(
        (value): value is number => value !== null && value !== undefined,
      );
    if (withAveragePrecision.length > 0) {
      out[`map@${k}`] = mean(withAveragePrecision);
    }
    const withNegatives = results
      .map((r) => r.metrics.negativeHit?.[String(k)])
      .filter(
        (value): value is number => value !== null && value !== undefined,
      );
    if (withNegatives.length > 0) {
      out[`negativeHitRate@${k}`] = mean(withNegatives);
    }
  }
  out.mrr = mean(answerable.map((r) => r.metrics.reciprocalRank));
  out.queriesWithEvidence = answerable.filter((r) =>
    Object.values(r.metrics.evidence).some((value) => value !== null),
  ).length;
  out.meanReturned = mean(results.map((r) => r.returned.length));
  if (noAnswer.length > 0) {
    out.noAnswerForcedRetrievalRate = mean(
      noAnswer.map((result) => (result.returned.length > 0 ? 1 : 0)),
    );
    out.noAnswerMeanReturned = mean(
      noAnswer.map((result) => result.returned.length),
    );
  }
  return out;
}

export function aggregateByTag(
  results: QueryResult[],
  ks: readonly number[] = RETRIEVAL_KS,
): Record<string, Record<string, number>> {
  const tags = [...new Set(results.flatMap((r) => r.tags))].sort();
  const out: Record<string, Record<string, number>> = {};
  for (const tag of tags) {
    out[tag] = aggregate(
      results.filter((r) => r.tags.includes(tag)),
      ks,
    );
  }
  return out;
}

export function aggregateBySegment(
  results: QueryResult[],
): RunArtifactSegments {
  return {
    category: aggregateByValue(
      results,
      (result) => result.category ?? "general",
    ),
    language: aggregateByValue(results, (result) => result.language ?? "en"),
    difficulty: aggregateByValue(
      results,
      (result) => result.difficulty ?? "medium",
    ),
  };
}

export function bootstrapUncertainty(params: {
  results: QueryResult[];
  seed: string;
  samples?: number;
}): {
  method: "deterministic-bootstrap";
  confidenceLevel: 0.95;
  samples: number;
  seed: string;
  metrics: Record<
    string,
    { estimate: number; lower: number; upper: number; n: number }
  >;
} {
  const samples = params.samples ?? 2_000;
  const answerable = params.results.filter(
    (result) => result.answerability !== "no-answer",
  );
  const metricValues: Record<string, number[]> = {
    "hit@5": answerable.map((result) => result.metrics.hit["5"] ?? 0),
    mrr: answerable.map((result) => result.metrics.reciprocalRank),
    "precision@5": answerable.map(
      (result) => result.metrics.precision?.["5"] ?? 0,
    ),
  };
  const ndcg = answerable
    .map((result) => result.metrics.ndcg?.["5"])
    .filter((value): value is number => value !== null && value !== undefined);
  if (ndcg.length > 0) metricValues["ndcg@5"] = ndcg;
  const ap = answerable
    .map((result) => result.metrics.averagePrecision?.["5"])
    .filter((value): value is number => value !== null && value !== undefined);
  if (ap.length > 0) metricValues["map@5"] = ap;

  const metrics: Record<
    string,
    { estimate: number; lower: number; upper: number; n: number }
  > = {};
  for (const [name, values] of Object.entries(metricValues)) {
    if (values.length === 0) continue;
    const rng = seededRandom(`${params.seed}:${name}`);
    const draws = Array.from({ length: samples }, () => {
      let total = 0;
      for (let index = 0; index < values.length; index += 1) {
        total += values[Math.floor(rng() * values.length)] ?? 0;
      }
      return total / values.length;
    }).sort((a, b) => a - b);
    metrics[name] = {
      estimate: mean(values),
      lower: percentile(draws, 0.025),
      upper: percentile(draws, 0.975),
      n: values.length,
    };
  }
  return {
    method: "deterministic-bootstrap",
    confidenceLevel: 0.95,
    samples,
    seed: params.seed,
    metrics,
  };
}

export function bootstrapPairedDelta(params: {
  pairs: Array<{ a: number; b: number }>;
  seed: string;
  samples?: number;
}): {
  estimate: number;
  lower: number;
  upper: number;
  probabilityImproved: number;
  n: number;
} | null {
  if (params.pairs.length === 0) return null;
  const samples = params.samples ?? 2_000;
  const deltas = params.pairs.map((pair) => pair.b - pair.a);
  const rng = seededRandom(params.seed);
  const draws = Array.from({ length: samples }, () => {
    let total = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      total += deltas[Math.floor(rng() * deltas.length)] ?? 0;
    }
    return total / deltas.length;
  }).sort((a, b) => a - b);
  return {
    estimate: mean(deltas),
    lower: percentile(draws, 0.025),
    upper: percentile(draws, 0.975),
    probabilityImproved:
      draws.filter((draw) => draw > 0).length / Math.max(draws.length, 1),
    n: deltas.length,
  };
}

// ===== Internal helpers =====

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

type RunArtifactSegments = {
  category: Record<string, Record<string, number>>;
  language: Record<string, Record<string, number>>;
  difficulty: Record<string, Record<string, number>>;
};

function aggregateByValue(
  results: QueryResult[],
  value: (result: QueryResult) => string,
): Record<string, Record<string, number>> {
  return Object.fromEntries(
    [...new Set(results.map(value))]
      .sort()
      .map((segment) => [
        segment,
        aggregate(results.filter((result) => value(result) === segment)),
      ]),
  );
}

function normalizedDiscountedCumulativeGain(params: {
  rankedDocs: string[];
  relevance: Map<string, number>;
  k: number;
}): number | null {
  const grades = [...params.relevance.values()].filter((grade) => grade > 0);
  if (grades.length === 0) return null;
  const dcg = params.rankedDocs
    .slice(0, params.k)
    .reduce(
      (total, doc, index) =>
        total +
        (2 ** (params.relevance.get(doc) ?? 0) - 1) / Math.log2(index + 2),
      0,
    );
  const ideal = grades
    .sort((a, b) => b - a)
    .slice(0, params.k)
    .reduce(
      (total, grade, index) => total + (2 ** grade - 1) / Math.log2(index + 2),
      0,
    );
  return ideal === 0 ? null : dcg / ideal;
}

function averagePrecisionAtK(params: {
  rankedDocs: string[];
  relevantDocs: string[];
  k: number;
}): number | null {
  if (params.relevantDocs.length === 0) return null;
  let relevantSeen = 0;
  let sum = 0;
  params.rankedDocs.slice(0, params.k).forEach((doc, index) => {
    if (!params.relevantDocs.includes(doc)) return;
    relevantSeen += 1;
    sum += relevantSeen / (index + 1);
  });
  return sum / Math.min(params.relevantDocs.length, params.k);
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  return (
    values[
      Math.min(values.length - 1, Math.floor(probability * values.length))
    ] ?? 0
  );
}
