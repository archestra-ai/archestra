import { describe, expect, it } from "vitest";
import {
  aggregate,
  bootstrapUncertainty,
  documentsWithin,
  normalizeForEvidence,
  type ReturnedChunk,
  scoreQuery,
} from "./metrics";
import type { GoldenQuery, QueryResult } from "./schema";

const chunk = (doc: string, index: number, content = ""): ReturnedChunk => ({
  doc,
  ref: `${doc}#${index}`,
  content,
});

const golden = (expected: GoldenQuery["expected"], id = "q"): GoldenQuery => ({
  id,
  query: "question",
  expected,
  tags: [],
  component: "text-embedding",
  requires: ["text-embedding"],
  expectAtK: 10,
  source: "hand",
});

describe("documentsWithin", () => {
  it("collapses chunks to documents by first occurrence within the first k chunks", () => {
    const returned = [
      chunk("a", 1),
      chunk("a", 2),
      chunk("b", 0),
      chunk("a", 3),
      chunk("c", 0),
    ];
    expect(documentsWithin(returned, 2)).toEqual(["a"]);
    expect(documentsWithin(returned, 3)).toEqual(["a", "b"]);
    expect(documentsWithin(returned, 10)).toEqual(["a", "b", "c"]);
  });
});

describe("scoreQuery", () => {
  it("computes hit@k over chunk ranks and the reciprocal rank of the first matching chunk", () => {
    const returned = [
      chunk("x", 0),
      chunk("x", 1),
      chunk("gold", 4),
      chunk("y", 0),
    ];
    const { metrics, firstRank } = scoreQuery(
      golden([{ doc: "gold" }]),
      returned,
      [1, 3, 5],
    );
    expect(firstRank).toEqual({ gold: 3 });
    expect(metrics.hit).toEqual({ "1": 0, "3": 1, "5": 1 });
    expect(metrics.recall).toEqual({ "1": 0, "3": 1, "5": 1 });
    expect(metrics.reciprocalRank).toBeCloseTo(1 / 3);
    // No evidence on the golden row → evidence is "not applicable", not 0.
    expect(metrics.evidence).toEqual({ "1": null, "3": null, "5": null });
  });

  it("scores an absent document as a miss with reciprocal rank 0", () => {
    const { metrics, firstRank } = scoreQuery(
      golden([{ doc: "gold" }]),
      [chunk("x", 0)],
      [1, 10],
    );
    expect(firstRank).toEqual({ gold: null });
    expect(metrics.hit).toEqual({ "1": 0, "10": 0 });
    expect(metrics.reciprocalRank).toBe(0);
  });

  it("uses partial recall for multi-document queries while hit@k stays binary", () => {
    const returned = [
      chunk("a", 0),
      chunk("z", 0),
      chunk("z", 1),
      chunk("b", 0),
    ];
    const { metrics } = scoreQuery(
      golden([{ doc: "a" }, { doc: "b" }, { doc: "c" }]),
      returned,
      [1, 4],
    );
    expect(metrics.hit).toEqual({ "1": 1, "4": 1 });
    expect(metrics.recall["1"]).toBeCloseTo(1 / 3);
    expect(metrics.recall["4"]).toBeCloseTo(2 / 3);
    expect(metrics.reciprocalRank).toBe(1);
  });

  it("credits evidence only when it appears in a chunk of the expected document within k", () => {
    const returned = [
      chunk(
        "other",
        0,
        "The radius is `ARCHESTRA_KNOWLEDGE_BASE_CONTEXT_EXPANSION_RADIUS`.",
      ),
      chunk("gold", 0, "Unrelated text."),
      chunk(
        "gold",
        1,
        "Set **ARCHESTRA_KNOWLEDGE_BASE_CONTEXT_EXPANSION_RADIUS** to widen.",
      ),
    ];
    const { metrics } = scoreQuery(
      golden([
        {
          doc: "gold",
          evidence: ["archestra_knowledge_base_context_expansion_radius"],
        },
      ]),
      returned,
      [1, 2, 3],
    );
    // rank 1 has the phrase but belongs to the wrong document; rank 2 is the
    // right document without the phrase; rank 3 is the right document with it.
    expect(metrics.evidence).toEqual({ "1": 0, "2": 0, "3": 1 });
    expect(metrics.hit).toEqual({ "1": 0, "2": 1, "3": 1 });
  });

  it("requires every declared evidence string in all-evidence mode", () => {
    const query: GoldenQuery = {
      ...golden([{ doc: "gold", evidence: ["first fact", "second fact"] }]),
      evidenceMode: "all",
    };
    const partial = scoreQuery(
      query,
      [chunk("gold", 0, "first fact only")],
      [1],
    );
    const complete = scoreQuery(
      query,
      [chunk("gold", 0, "first fact and second fact")],
      [1],
    );
    expect(partial.metrics.evidence["1"]).toBe(0);
    expect(complete.metrics.evidence["1"]).toBe(1);
  });

  it("keeps no-answer forced retrieval out of answerable quality aggregates", () => {
    const answerable = scoreQuery(
      golden([{ doc: "gold" }]),
      [chunk("gold", 0)],
      [1],
    );
    const noAnswer = scoreQuery(
      {
        ...golden([]),
        answerability: "no-answer",
        gateMode: "metric-only",
      },
      [chunk("forced", 0)],
      [1],
    );
    const aggregates = aggregate(
      [
        {
          metrics: answerable.metrics,
          returned: [chunk("gold", 0)],
          answerability: "answerable",
        },
        {
          metrics: noAnswer.metrics,
          returned: [chunk("forced", 0)],
          answerability: "no-answer",
        },
      ],
      [1],
    );
    expect(aggregates["hit@1"]).toBe(1);
    expect(aggregates.mrr).toBe(1);
    expect(aggregates.noAnswerForcedRetrievalRate).toBe(1);
  });

  it("normalises markdown emphasis, case and whitespace before matching evidence", () => {
    expect(normalizeForEvidence("Set  **Foo_Bar** to `1`")).toBe(
      "set foobar to 1",
    );
  });

  it("computes graded ranking quality and explicit negative exposure", () => {
    const query: GoldenQuery = {
      ...golden([{ doc: "high" }, { doc: "relevant" }]),
      judgments: [
        { doc: "high", relevance: 3 },
        { doc: "relevant", relevance: 1 },
        { doc: "forbidden", relevance: 0 },
      ],
      forbidden: ["forbidden"],
    };
    const { metrics } = scoreQuery(
      query,
      [chunk("high", 0), chunk("forbidden", 0), chunk("relevant", 0)],
      [3],
    );
    expect(metrics.precision?.["3"]).toBeCloseTo(2 / 3);
    expect(metrics.averagePrecision?.["3"]).toBeCloseTo(5 / 6);
    expect(metrics.ndcg?.["3"]).toBeCloseTo(7.5 / (7 + 1 / Math.log2(3)));
    expect(metrics.negativeHit?.["3"]).toBe(1);
    expect(metrics.firstForbiddenRank).toBe(2);
  });

  it("deduplicates documents for new metrics without changing legacy chunk ranks", () => {
    const { metrics } = scoreQuery(
      golden([{ doc: "gold" }]),
      [
        chunk("duplicate", 0),
        chunk("duplicate", 1),
        chunk("duplicate", 2),
        chunk("gold", 0),
      ],
      [2],
    );
    expect(metrics.hit["2"]).toBe(0);
    expect(metrics.precision?.["2"]).toBe(0.5);
    expect(metrics.ndcg?.["2"]).toBeCloseTo(1 / Math.log2(3));
  });

  it("produces deterministic bootstrap intervals", () => {
    const metrics = scoreQuery(
      golden([{ doc: "a" }]),
      [chunk("a", 0)],
      [5],
    ).metrics;
    const results = [
      { id: "a", metrics, returned: [{ doc: "a", ref: "a#0" }] },
      { id: "b", metrics, returned: [{ doc: "a", ref: "a#0" }] },
    ] as QueryResult[];
    expect(
      bootstrapUncertainty({ results, seed: "suite", samples: 100 }),
    ).toEqual(bootstrapUncertainty({ results, seed: "suite", samples: 100 }));
  });
});

describe("aggregate", () => {
  it("macro-averages hit/recall/MRR and averages evidence only over queries that carry evidence", () => {
    const a = scoreQuery(
      golden([{ doc: "a", evidence: ["needle"] }], "a"),
      [chunk("a", 0, "a needle here")],
      [1],
    );
    const b = scoreQuery(golden([{ doc: "b" }], "b"), [chunk("x", 0)], [1]);
    const aggregates = aggregate(
      [
        { metrics: a.metrics, returned: [chunk("a", 0)] },
        { metrics: b.metrics, returned: [] },
      ],
      [1],
    );
    expect(aggregates.queries).toBe(2);
    expect(aggregates["hit@1"]).toBeCloseTo(0.5);
    expect(aggregates.mrr).toBeCloseTo(0.5);
    expect(aggregates["evidence@1"]).toBe(1);
    expect(aggregates.queriesWithEvidence).toBe(1);
    expect(aggregates.meanReturned).toBeCloseTo(0.5);
  });
});
