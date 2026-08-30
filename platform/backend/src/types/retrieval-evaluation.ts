import {
  BM25_B_MAX,
  BM25_B_MIN,
  BM25_K1_MAX,
  BM25_K1_MIN,
  ContextualRetrievalModeSchema,
} from "@archestra/shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import {
  CapabilityStateSchema,
  EvalCapabilitySchema,
  KNOWLEDGE_EVALUATION_COMPONENTS,
  KnowledgeEvaluationComponentSchema,
  RunArtifactSchema,
} from "@/knowledge-base/evaluation/schema";

export type { KnowledgeEvaluationComponent } from "@/knowledge-base/evaluation/schema";

export const RetrievalEvaluationRunStatusSchema = z.enum([
  "queued",
  "running",
  "cancel_requested",
  "cancelled",
  "completed",
  "degraded",
  "blocked",
  "failed",
]);
export type RetrievalEvaluationRunStatus = z.infer<
  typeof RetrievalEvaluationRunStatusSchema
>;

export const RetrievalEvaluationRunStageSchema = z.enum([
  "queued",
  "preparing",
  "ingesting",
  "ranking",
  "querying",
  "cleanup",
  "completed",
]);
export type RetrievalEvaluationRunStage = z.infer<
  typeof RetrievalEvaluationRunStageSchema
>;

export const RetrievalEvaluationSettingsOverridesSchema = z
  .object({
    embedding: z
      .object({
        chatApiKeyId: z.string().uuid(),
        model: z.string().trim().min(1).max(256),
      })
      .strict()
      .optional(),
    reranker: z
      .object({
        chatApiKeyId: z.string().uuid(),
        model: z.string().trim().min(1).max(256),
      })
      .strict()
      .optional(),
    ocr: z
      .object({
        chatApiKeyId: z.string().uuid(),
        model: z.string().trim().min(1).max(256),
      })
      .strict()
      .optional(),
    bm25K1: z.number().finite().min(BM25_K1_MIN).max(BM25_K1_MAX).optional(),
    bm25B: z.number().finite().min(BM25_B_MIN).max(BM25_B_MAX).optional(),
    contextualRetrievalMode: ContextualRetrievalModeSchema.optional(),
  })
  .strict();
export type RetrievalEvaluationSettingsOverrides = z.infer<
  typeof RetrievalEvaluationSettingsOverridesSchema
>;

export const SelectRetrievalEvaluationRunSchema = createSelectSchema(
  schema.retrievalEvaluationRunsTable,
  {
    status: RetrievalEvaluationRunStatusSchema,
    stage: RetrievalEvaluationRunStageSchema,
    selectedComponents: z.array(KnowledgeEvaluationComponentSchema),
    settingsOverrides: RetrievalEvaluationSettingsOverridesSchema,
    componentFingerprints: z.record(z.string(), z.string()),
    artifact: RunArtifactSchema.nullable(),
  },
);
export const SelectRetrievalEvaluationRunSummarySchema =
  SelectRetrievalEvaluationRunSchema.omit({ artifact: true });
export const InsertRetrievalEvaluationRunSchema = createInsertSchema(
  schema.retrievalEvaluationRunsTable,
  {
    status: RetrievalEvaluationRunStatusSchema.optional(),
    stage: RetrievalEvaluationRunStageSchema.optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateRetrievalEvaluationRunSchema = createUpdateSchema(
  schema.retrievalEvaluationRunsTable,
  {
    status: RetrievalEvaluationRunStatusSchema.optional(),
    stage: RetrievalEvaluationRunStageSchema.optional(),
    artifact: RunArtifactSchema.nullable().optional(),
  },
);

export const StartRetrievalEvaluationSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    queryLimit: z.number().int().min(1).max(100).default(10),
    components: z
      .array(KnowledgeEvaluationComponentSchema)
      .min(1)
      .default([...KNOWLEDGE_EVALUATION_COMPONENTS]),
    settingsOverrides: RetrievalEvaluationSettingsOverridesSchema.default({}),
  })
  .strict();

export const RetrievalEvaluationCapabilitiesSchema = z.object({
  corpusDigest: z.string(),
  goldenDigest: z.string(),
  totalQueries: z.number().int().nonnegative(),
  applicableQueries: z.number().int().nonnegative(),
  capabilities: z.record(z.string(), CapabilityStateSchema),
  components: z.array(
    z.object({
      id: KnowledgeEvaluationComponentSchema,
      label: z.string(),
      description: z.string(),
      mode: z.enum(["offline", "online"]),
      status: z.enum(["active", "disabled", "unavailable"]),
      detail: z.string(),
      currentFingerprint: z.string(),
      selectedByDefault: z.boolean(),
      changedSinceLastEvaluation: z.boolean(),
      lastEvaluatedAt: z.string().datetime().nullable(),
      lastRunId: z.string().uuid().nullable(),
      scenarioIds: z.array(z.string()),
    }),
  ),
  scenarios: z.array(
    z.object({
      id: z.string(),
      query: z.string(),
      expected: z.array(z.string()),
      component: KnowledgeEvaluationComponentSchema,
      tags: z.array(z.string()),
      category: z.string(),
      language: z.string(),
      difficulty: z.enum(["easy", "medium", "hard"]),
      answerability: z.enum(["answerable", "no-answer"]),
      gateMode: z.enum(["pass-fail", "metric-only"]),
      forbidden: z.array(z.string()),
      judgments: z.array(
        z.object({
          doc: z.string(),
          relevance: z.number().int().min(0).max(3),
        }),
      ),
      requires: z.array(EvalCapabilitySchema),
      expectAtK: z.number().int().positive(),
      applicable: z.boolean(),
      reasons: z.array(z.string()),
    }),
  ),
});

export type RetrievalEvaluationRun = z.infer<
  typeof SelectRetrievalEvaluationRunSchema
>;
export type RetrievalEvaluationRunSummary = z.infer<
  typeof SelectRetrievalEvaluationRunSummarySchema
>;
export type InsertRetrievalEvaluationRun = z.infer<
  typeof InsertRetrievalEvaluationRunSchema
>;
export type UpdateRetrievalEvaluationRun = z.infer<
  typeof UpdateRetrievalEvaluationRunSchema
>;
