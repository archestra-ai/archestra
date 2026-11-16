import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database/schema";
import { ScheduleTriggerRunStatusSchema } from "./schedule-trigger";
import {
  TunerCandidateSourceSchema,
  TunerEvidenceRefSchema,
  TunerFingerprintSchema,
  TunerKindSchema,
  TunerRunOutcomeSchema,
  TunerSeveritySchema,
  TunerSuggestedActionSchema,
  TunerSuggestionStatusSchema,
} from "./tuner";

export const SelectTunerSuggestionSchema = createSelectSchema(
  schema.tunerSuggestionsTable,
  {
    tunerKind: TunerKindSchema,
    fingerprint: TunerFingerprintSchema,
    source: TunerCandidateSourceSchema,
    severity: TunerSeveritySchema,
    status: TunerSuggestionStatusSchema,
    evidence: z.array(TunerEvidenceRefSchema),
    action: TunerSuggestedActionSchema,
  },
);
export type TunerSuggestion = z.infer<typeof SelectTunerSuggestionSchema>;

export const TunerSummarySchema = z.object({
  kind: TunerKindSchema,
  /** Whether this deployment can run the tuner (its built-in agent exists). */
  available: z.boolean(),
  trigger: z
    .object({
      id: z.string().uuid(),
      enabled: z.boolean(),
      cronExpression: z.string(),
      timezone: z.string(),
      actor: z
        .object({
          id: z.string(),
          name: z.string().nullable(),
          email: z.string().nullable(),
        })
        .nullable(),
      lastExecutedAt: z.date().nullable(),
    })
    .nullable(),
  lastRun: z
    .object({
      id: z.string().uuid(),
      status: ScheduleTriggerRunStatusSchema,
      /** Null until the run has scanned. */
      scan: z
        .object({
          outcome: TunerRunOutcomeSchema,
          candidateCount: z.number().int().nonnegative(),
        })
        .nullable(),
      createdAt: z.date(),
      completedAt: z.date().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type TunerSummary = z.infer<typeof TunerSummarySchema>;

export const ConfigureTunerRequestSchema = z.strictObject({
  enabled: z.boolean(),
  cronExpression: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
});
export type ConfigureTunerRequest = z.infer<typeof ConfigureTunerRequestSchema>;

export const ListTunerSuggestionsQuerySchema = z.object({
  kind: TunerKindSchema.optional(),
  status: z
    .union([TunerSuggestionStatusSchema, z.array(TunerSuggestionStatusSchema)])
    .optional()
    .transform((value) =>
      value === undefined ? undefined : Array.isArray(value) ? value : [value],
    ),
});

export const CloseTunerSuggestionRequestSchema = z.strictObject({
  comment: z.string().max(4000).nullish(),
});

export const RejectTunerSuggestionRequestSchema = z.strictObject({
  comment: z.string().min(1).max(4000),
});
