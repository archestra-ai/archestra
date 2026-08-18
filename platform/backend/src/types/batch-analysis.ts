import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { ResourceVisibilityScopeSchema } from "@/types/visibility";

// ===== Column configuration =====

/**
 * How a column's answer should come back. Deliberately generic: these are output
 * shapes, not domain concepts. `exact_quote` means "return the supporting span
 * verbatim rather than a paraphrase" — useful anywhere the wording itself is the
 * answer, and the only format that constrains the model's phrasing.
 */
export const BatchAnalysisColumnFormatSchema = z.enum([
  "text",
  "boolean",
  "date",
  "number",
  "list",
  "exact_quote",
]);
export type BatchAnalysisColumnFormat = z.infer<
  typeof BatchAnalysisColumnFormatSchema
>;

/**
 * A column is a prompt plus an output format, and nothing else. Domain-specific
 * column libraries belong in skill packs, never in this schema — the engine
 * stays horizontal.
 */
export const BatchAnalysisColumnSchema = z.object({
  /** Stable identifier, unique within an analysis. Cells reference this. */
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9][a-z0-9_]*$/,
      "Column key must be lowercase alphanumeric with underscores",
    ),
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(4000),
  format: BatchAnalysisColumnFormatSchema,
  /**
   * Ask the model to also triage this column's answer into a colored flag
   * (see BatchAnalysisCellFlagSchema). Optional so existing analyses and
   * columns that are pure extraction stay untouched.
   */
  flag: z.boolean().optional(),
});
export type BatchAnalysisColumn = z.infer<typeof BatchAnalysisColumnSchema>;

export const BatchAnalysisColumnsSchema = z
  .array(BatchAnalysisColumnSchema)
  .min(1)
  .max(50)
  .refine(
    (columns) => new Set(columns.map((c) => c.key)).size === columns.length,
    { message: "Column keys must be unique within an analysis" },
  );

// ===== Row sources =====

/**
 * What a row points at. Opaque on purpose: the runner resolves a source to text
 * through a registry, so adding a new source type (a warehouse row, a repo, a
 * ticket) is a new variant here plus a resolver — not a schema migration and not
 * a change to the runner.
 */
export const BatchAnalysisRowSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("kb_document"),
    documentId: z.string().uuid(),
  }),
  /**
   * Literal text supplied by the caller. Carries no ACL of its own — the
   * creator already had the text — so it is the source type used by tests and
   * by callers that have already resolved content themselves.
   */
  z.object({
    type: z.literal("inline_text"),
    text: z.string(),
  }),
  /**
   * A document in the knowledge file repository (`kb_files`). Uploading files
   * is the primary way rows are added, and referencing the repository row —
   * rather than copying its text inline — is what keeps the source viewable
   * and re-extractable after the analysis is created.
   */
  z.object({
    type: z.literal("kb_file"),
    fileId: z.string().uuid(),
  }),
]);
export type BatchAnalysisRowSource = z.infer<
  typeof BatchAnalysisRowSourceSchema
>;

export const BatchAnalysisRowSourceTypeSchema = z.enum([
  "kb_document",
  "inline_text",
  "kb_file",
]);
export type BatchAnalysisRowSourceType = z.infer<
  typeof BatchAnalysisRowSourceTypeSchema
>;

// ===== Cells =====

/**
 * `pending` — queued, not yet attempted.
 * `generating` — a worker is currently producing it.
 * `done` — has content; skipped on resume.
 * `error` — attempted and failed; retryable individually.
 *
 * This column is what makes a run resumable and a single cell retryable, so it
 * is the load-bearing part of the whole design.
 */
export const BatchAnalysisCellStatusSchema = z.enum([
  "pending",
  "generating",
  "done",
  "error",
]);
export type BatchAnalysisCellStatus = z.infer<
  typeof BatchAnalysisCellStatusSchema
>;

/**
 * Model-assigned triage flag for columns that opt in (`column.flag`):
 * `green` = standard / favourable, `yellow` = needs attention,
 * `red` = problematic / unfavourable, `grey` = neutral or not found.
 */
export const BatchAnalysisCellFlagSchema = z.enum([
  "green",
  "grey",
  "yellow",
  "red",
]);
export type BatchAnalysisCellFlag = z.infer<typeof BatchAnalysisCellFlagSchema>;

/**
 * A supporting span lifted verbatim from the row's source text. Quote-only by
 * design: chunk-level positional metadata (page, offsets) does not exist in the
 * corpus today, so promising a location we cannot produce would be a lie.
 */
export const BatchAnalysisCitationSchema = z.object({
  quote: z.string().min(1),
});
export type BatchAnalysisCitation = z.infer<typeof BatchAnalysisCitationSchema>;

// ===== Runs =====

export const BatchAnalysisRunStatusSchema = z.enum([
  "running",
  "success",
  "completed_with_errors",
  "failed",
  "cancelled",
]);
export type BatchAnalysisRunStatus = z.infer<
  typeof BatchAnalysisRunStatusSchema
>;

// ===== Table-derived schemas =====

export const SelectBatchAnalysisSchema = createSelectSchema(
  schema.batchAnalysesTable,
  {
    columns: BatchAnalysisColumnsSchema,
    scope: ResourceVisibilityScopeSchema,
  },
);
export const InsertBatchAnalysisSchema = createInsertSchema(
  schema.batchAnalysesTable,
  {
    columns: BatchAnalysisColumnsSchema,
    scope: ResourceVisibilityScopeSchema.optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateBatchAnalysisSchema = createUpdateSchema(
  schema.batchAnalysesTable,
  {
    columns: BatchAnalysisColumnsSchema,
    scope: ResourceVisibilityScopeSchema.optional(),
  },
).pick({ name: true, columns: true, agentId: true, scope: true });

export type BatchAnalysis = z.infer<typeof SelectBatchAnalysisSchema>;
export type InsertBatchAnalysis = z.infer<typeof InsertBatchAnalysisSchema>;
export type UpdateBatchAnalysis = z.infer<typeof UpdateBatchAnalysisSchema>;

export const SelectBatchAnalysisRunSchema = createSelectSchema(
  schema.batchAnalysisRunsTable,
  { status: BatchAnalysisRunStatusSchema },
);
export type BatchAnalysisRun = z.infer<typeof SelectBatchAnalysisRunSchema>;

export const SelectBatchAnalysisRowSchema = createSelectSchema(
  schema.batchAnalysisRowsTable,
  {
    source: BatchAnalysisRowSourceSchema,
    sourceType: BatchAnalysisRowSourceTypeSchema,
  },
);
export type BatchAnalysisRow = z.infer<typeof SelectBatchAnalysisRowSchema>;

export const SelectBatchAnalysisCellSchema = createSelectSchema(
  schema.batchAnalysisCellsTable,
  {
    status: BatchAnalysisCellStatusSchema,
    citations: z.array(BatchAnalysisCitationSchema).nullable(),
    flag: BatchAnalysisCellFlagSchema.nullable(),
  },
);
export type BatchAnalysisCell = z.infer<typeof SelectBatchAnalysisCellSchema>;

/**
 * Cell as the detail endpoint returns it: the reviewer's display name resolved
 * server-side so the UI never has to look up raw user ids. Null when the cell
 * is unverified or the reviewer's account no longer exists.
 */
export const BatchAnalysisCellWithVerifierSchema =
  SelectBatchAnalysisCellSchema.extend({
    verifiedByName: z.string().nullable(),
  });
export type BatchAnalysisCellWithVerifier = z.infer<
  typeof BatchAnalysisCellWithVerifierSchema
>;
