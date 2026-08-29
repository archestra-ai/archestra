import { z } from "zod";

/**
 * Fixtures and artifacts for the in-platform retrieval evaluation harness.
 *
 * The runner never supplies retrieval settings or model credentials. It runs
 * inside a platform container and records the settings resolved from that
 * instance and the selected organization.
 */

export const EvalCapabilitySchema = z.enum([
  "text-embedding",
  "image-embedding",
  "ocr",
  "hybrid-search",
  "bm25",
  "reranker",
  "cross-encoder-reranker",
  "llm-reranker",
  "query-expansion",
  "contextual-retrieval",
  "context-expansion",
]);
export type EvalCapability = z.infer<typeof EvalCapabilitySchema>;

export const KnowledgeEvaluationComponentSchema = z.enum([
  "chunking",
  "text-embedding",
  "image-embedding",
  "keyword-ranking",
  "hybrid-retrieval",
  "reranking",
  "query-expansion",
  "contextual-retrieval",
  "context-expansion",
  "ocr",
]);
export type KnowledgeEvaluationComponent = z.infer<
  typeof KnowledgeEvaluationComponentSchema
>;
export const KNOWLEDGE_EVALUATION_COMPONENTS =
  KnowledgeEvaluationComponentSchema.options;
export const EVALUATION_POLICY_VERSION = 3;

export const CapabilityStateSchema = z.object({
  status: z.enum(["active", "disabled", "unavailable"]),
  detail: z.string().min(1),
});
export type CapabilityState = z.infer<typeof CapabilityStateSchema>;

/** One fixed corpus item. Binary assets are resolved only under fixtures/assets. */
export const CorpusDocumentSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    kind: z.enum(["text", "image", "ocr-pdf"]).default("text"),
    /** Text to ingest, or for OCR fixtures a verbatim substring the OCR output must contain. */
    content: z.string().optional(),
    /** Deterministic fixture expansion for a deliberately multi-chunk document. */
    repeat: z
      .object({
        marker: z.string().min(1),
        value: z.string().min(1),
        count: z.number().int().positive().max(20_000),
      })
      .optional(),
    /** Basename under fixtures/assets; paths and traversal are rejected by the loader. */
    asset: z.string().min(1).optional(),
    requires: z.array(EvalCapabilitySchema).default(["text-embedding"]),
    sourceUrl: z.string().url().optional(),
  })
  .superRefine((document, ctx) => {
    if (document.kind === "text" && !document.content?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "text documents require content",
      });
    }
    if (document.kind !== "text" && !document.asset) {
      ctx.addIssue({
        code: "custom",
        path: ["asset"],
        message: `${document.kind} documents require an asset`,
      });
    }
    if (document.kind === "ocr-pdf" && !document.content?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "OCR documents require expected transcribed text",
      });
    }
  });
export type CorpusDocument = z.infer<typeof CorpusDocumentSchema>;

/**
 * One golden query. A query runs only when every required capability is active
 * on this instance; otherwise it is preserved in the artifact as an explicit
 * skip with the capability reason.
 */
export const GoldenQuerySchema = z
  .object({
    id: z.string().min(1),
    query: z.string().min(1),
    expected: z.array(
      z.object({
        doc: z.string().min(1),
        evidence: z.array(z.string().min(1)).optional(),
      }),
    ),
    judgments: z
      .array(
        z.object({
          doc: z.string().min(1),
          relevance: z.number().int().min(0).max(3),
        }),
      )
      .optional(),
    forbidden: z.array(z.string().min(1)).optional(),
    answerability: z.enum(["answerable", "no-answer"]).optional(),
    gateMode: z.enum(["pass-fail", "metric-only"]).optional(),
    evidenceMode: z.enum(["any", "all"]).optional(),
    category: z.string().min(1).optional(),
    language: z.string().min(2).max(16).optional(),
    difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    tags: z.array(z.string().min(1)).default([]),
    component: KnowledgeEvaluationComponentSchema,
    requires: z.array(EvalCapabilitySchema).default(["text-embedding"]),
    /** The expectation gate for this scenario; metrics are still reported at every k. */
    expectAtK: z.number().int().positive().default(10),
    source: z.enum(["hand", "synthesized", "user-log"]).default("hand"),
    notes: z.string().optional(),
  })
  .superRefine((query, ctx) => {
    if (query.answerability === "answerable" && query.expected.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["expected"],
        message: "answerable queries require at least one expected document",
      });
    }
    if (query.answerability === "no-answer" && query.expected.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["expected"],
        message: "no-answer queries cannot declare expected documents",
      });
    }
    if (
      query.answerability === "no-answer" &&
      query.gateMode !== "metric-only"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["gateMode"],
        message:
          "no-answer queries must remain metric-only until retrieval supports abstention",
      });
    }
    const judgmentDocs = (query.judgments ?? []).map(
      (judgment) => judgment.doc,
    );
    if (new Set(judgmentDocs).size !== judgmentDocs.length) {
      ctx.addIssue({
        code: "custom",
        path: ["judgments"],
        message: "judgment document ids must be unique",
      });
    }
    const forbidden = new Set(query.forbidden ?? []);
    if (forbidden.size !== (query.forbidden ?? []).length) {
      ctx.addIssue({
        code: "custom",
        path: ["forbidden"],
        message: "forbidden document ids must be unique",
      });
    }
    const relevance = new Map(
      (query.judgments ?? []).map((judgment) => [
        judgment.doc,
        judgment.relevance,
      ]),
    );
    for (const expected of query.expected) {
      if (forbidden.has(expected.doc)) {
        ctx.addIssue({
          code: "custom",
          path: ["forbidden"],
          message: `${expected.doc} cannot be both expected and forbidden`,
        });
      }
      if (
        relevance.has(expected.doc) &&
        (relevance.get(expected.doc) ?? 0) <= 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["judgments"],
          message: `${expected.doc} must have a positive relevance grade`,
        });
      }
    }
    for (const doc of forbidden) {
      if ((relevance.get(doc) ?? 0) > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["judgments"],
          message: `${doc} cannot be both relevant and forbidden`,
        });
      }
    }
    if (
      query.answerability === "no-answer" &&
      [...relevance.values()].some((grade) => grade > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["judgments"],
        message: "no-answer queries cannot have positive relevance judgments",
      });
    }
  });
export type GoldenQuery = z.infer<typeof GoldenQuerySchema>;

export const RETRIEVAL_KS = [1, 3, 5, 10] as const;

export const QueryMetricsSchema = z.object({
  hit: z.record(z.string(), z.number()),
  recall: z.record(z.string(), z.number()),
  reciprocalRank: z.number(),
  evidence: z.record(z.string(), z.number().nullable()),
  precision: z.record(z.string(), z.number()).optional(),
  ndcg: z.record(z.string(), z.number().nullable()).optional(),
  averagePrecision: z.record(z.string(), z.number().nullable()).optional(),
  negativeHit: z.record(z.string(), z.number().nullable()).optional(),
  firstForbiddenRank: z.number().int().positive().nullable().optional(),
});
export type QueryMetrics = z.infer<typeof QueryMetricsSchema>;

export const RerankOutcomeSchema = z.object({
  status: z.enum(["disabled", "unavailable", "succeeded", "failed"]),
  kind: z.enum(["llm", "native-rerank"]).nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  changedOrder: z.boolean(),
  filteredCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type RerankOutcome = z.infer<typeof RerankOutcomeSchema>;

export const QueryResultSchema = z.object({
  id: z.string(),
  component: KnowledgeEvaluationComponentSchema.optional(),
  query: z.string(),
  tags: z.array(z.string()),
  category: z.string().optional(),
  language: z.string().optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  answerability: z.enum(["answerable", "no-answer"]).optional(),
  gateMode: z.enum(["pass-fail", "metric-only"]).optional(),
  requires: z.array(EvalCapabilitySchema),
  expectAtK: z.number().int().positive(),
  expected: z.array(z.string()),
  forbidden: z.array(z.string()).optional(),
  /** Returned chunks in product order: logical document id + citation ref. */
  returned: z.array(z.object({ doc: z.string(), ref: z.string() })),
  firstRank: z.record(z.string(), z.number().nullable()),
  latencyMs: z.number(),
  metrics: QueryMetricsSchema,
  passed: z.boolean(),
  stageFailures: z.array(z.string()),
  stages: z.object({
    expandedQueryCount: z.number().int().positive(),
    expandedQueryTypes: z.array(z.enum(["semantic", "keyword"])),
    keywordRanker: z.enum(["disabled", "ts_rank", "bm25"]),
    reranker: RerankOutcomeSchema,
    contextExpanded: z.boolean(),
    rankingScores: z
      .array(
        z.object({
          doc: z.string(),
          ref: z.string(),
          score: z.number(),
        }),
      )
      .optional(),
  }),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

export const SkippedQuerySchema = z.object({
  id: z.string(),
  component: KnowledgeEvaluationComponentSchema.optional(),
  query: z.string(),
  requires: z.array(EvalCapabilitySchema),
  reasons: z.array(z.string().min(1)).min(1),
});
export type SkippedQuery = z.infer<typeof SkippedQuerySchema>;

const ModelFingerprintSchema = z.object({
  provider: z.string(),
  model: z.string(),
});

export const RunArtifactSchema = z.object({
  schemaVersion: z.literal(2),
  status: z.enum(["completed", "degraded", "blocked"]),
  run: z.object({
    name: z.string(),
    organizationId: z.string().uuid(),
    queryLimit: z.number().int().positive(),
  }),
  fingerprint: z.object({
    platformVersion: z.string(),
    gitSha: z.string().nullable(),
    gitDirty: z.boolean().nullable(),
    corpusDigest: z.string(),
    goldenDigest: z.string(),
    effectiveConfig: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
    embedding: ModelFingerprintSchema.extend({
      dimensions: z.number().int().positive(),
      inputModalities: z.array(z.string()).nullable(),
    }).nullable(),
    reranker: ModelFingerprintSchema.extend({
      kind: z.enum(["llm", "native-rerank"]),
    }).nullable(),
    ocr: ModelFingerprintSchema.nullable(),
  }),
  capabilities: z.record(z.string(), CapabilityStateSchema),
  ingest: z.object({
    documents: z.number().int().nonnegative(),
    chunks: z.number().int().nonnegative(),
    textDocuments: z.number().int().nonnegative(),
    imageDocuments: z.number().int().nonnegative(),
    ocrDocuments: z.number().int().nonnegative(),
    contextualizedChunks: z.number().int().nonnegative(),
    wallMs: z.number().nonnegative(),
  }),
  queries: z.array(QueryResultSchema),
  skippedQueries: z.array(SkippedQuerySchema),
  aggregates: z.record(z.string(), z.number()),
  byTag: z.record(z.string(), z.record(z.string(), z.number())),
  bySegment: z
    .object({
      category: z.record(z.string(), z.record(z.string(), z.number())),
      language: z.record(z.string(), z.record(z.string(), z.number())),
      difficulty: z.record(z.string(), z.record(z.string(), z.number())),
    })
    .optional(),
  uncertainty: z
    .object({
      method: z.literal("deterministic-bootstrap"),
      confidenceLevel: z.literal(0.95),
      samples: z.number().int().positive(),
      seed: z.string(),
      metrics: z.record(
        z.string(),
        z.object({
          estimate: z.number(),
          lower: z.number(),
          upper: z.number(),
          n: z.number().int().nonnegative(),
        }),
      ),
    })
    .optional(),
  cleanup: z.object({
    kept: z.boolean(),
    knowledgeBaseId: z.string().uuid().nullable(),
    connectorId: z.string().uuid().nullable(),
    completed: z.boolean(),
  }),
  selection: z
    .object({
      components: z.array(KnowledgeEvaluationComponentSchema),
      componentFingerprints: z.record(z.string(), z.string()),
      componentResults: z.array(
        z.object({
          component: KnowledgeEvaluationComponentSchema,
          mode: z.enum(["offline", "online"]),
          status: z.enum(["passed", "failed", "skipped"]),
          detail: z.string(),
        }),
      ),
    })
    .optional(),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});
export type RunArtifact = z.infer<typeof RunArtifactSchema>;

const ComparisonSideSchema = z.object({
  bestRank: z.number().int().positive().nullable(),
  expectedScore: z.number().nullable(),
  scoreMargin: z.number().nullable(),
  returned: z.number().int().nonnegative(),
  hit: z.record(z.string(), z.number()),
  recall: z.record(z.string(), z.number()),
  reciprocalRank: z.number(),
  evidence: z.record(z.string(), z.number().nullable()),
  precision: z.record(z.string(), z.number()).optional(),
  ndcg: z.record(z.string(), z.number().nullable()).optional(),
  averagePrecision: z.record(z.string(), z.number().nullable()).optional(),
  negativeHit: z.record(z.string(), z.number().nullable()).optional(),
});

export const RetrievalEvaluationComparisonSchema = z.object({
  a: z.object({
    name: z.string(),
    warnings: z.array(z.string()),
    errors: z.array(z.string()),
  }),
  b: z.object({
    name: z.string(),
    warnings: z.array(z.string()),
    errors: z.array(z.string()),
  }),
  fingerprintMismatch: z.array(z.string()),
  fingerprintNotes: z.array(z.string()),
  configDiff: z.array(
    z.object({ key: z.string(), a: z.string(), b: z.string() }),
  ),
  singleExpected: z.boolean(),
  queries: z.array(
    z.object({
      id: z.string(),
      component: KnowledgeEvaluationComponentSchema.optional(),
      query: z.string(),
      tags: z.array(z.string()),
      expected: z.array(z.string()),
      gateMode: z.enum(["pass-fail", "metric-only"]).optional(),
      a: ComparisonSideSchema,
      b: ComparisonSideSchema,
      direction: z.record(
        z.string(),
        z.enum(["improved", "regressed", "same"]),
      ),
      returnedChanged: z.boolean(),
      changed: z.boolean(),
    }),
  ),
  tallies: z.record(
    z.string(),
    z.object({
      wins: z.number().int().nonnegative(),
      losses: z.number().int().nonnegative(),
      ties: z.number().int().nonnegative(),
    }),
  ),
  aggregates: z.record(
    z.string(),
    z.object({ a: z.number(), b: z.number(), delta: z.number() }),
  ),
  uncertainty: z
    .record(
      z.string(),
      z.object({
        estimate: z.number(),
        lower: z.number(),
        upper: z.number(),
        probabilityImproved: z.number().min(0).max(1),
        n: z.number().int().nonnegative(),
      }),
    )
    .default({}),
  aggregateScope: z.literal("paired-queries"),
  pairedQueryCount: z.number().int().nonnegative(),
  components: z.object({
    a: z.array(KnowledgeEvaluationComponentSchema),
    b: z.array(KnowledgeEvaluationComponentSchema),
    paired: z.array(KnowledgeEvaluationComponentSchema),
    onlyA: z.array(KnowledgeEvaluationComponentSchema),
    onlyB: z.array(KnowledgeEvaluationComponentSchema),
  }),
  componentResults: z.array(
    z.object({
      component: KnowledgeEvaluationComponentSchema,
      a: z
        .object({
          status: z.enum(["passed", "failed", "skipped"]),
          detail: z.string(),
        })
        .nullable(),
      b: z
        .object({
          status: z.enum(["passed", "failed", "skipped"]),
          detail: z.string(),
        })
        .nullable(),
      changed: z.boolean(),
    }),
  ),
  unpaired: z.object({
    onlyA: z.array(z.string()),
    onlyB: z.array(z.string()),
  }),
});
