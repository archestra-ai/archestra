import { z } from "zod";

// router-core plan documents travel as untyped JSON; these mirror the Rust
// structs (plan.rs, fit.rs) at plan format version 1.

const TierTriple = z.tuple([z.number(), z.number(), z.number()]);

const PlanSummarySchema = z.object({
  sessions_per_day: z.number(),
  tokens_per_day: z.number(),
  expected_spend: z.number(),
  value_size_weighted: z.number(),
  tier_session_share: TierTriple,
  tier_token_share: TierTriple,
  value_per_usd: z.number(),
});
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

const HoldoutSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("evaluated"),
    sessions: z.number(),
    predicted_tokens: z.number(),
    realized_tokens: z.number(),
    spearman: z.number().nullable(),
  }),
  z.object({ status: z.literal("insufficient_history") }),
  z.object({ status: z.literal("fit_failed"), error: z.string() }),
]);
export type Holdout = z.infer<typeof HoldoutSchema>;

const PlanDiagnosticsSchema = z.object({ holdout: HoldoutSchema });

const ColdStartDiagnosticsSchema = z.object({
  sessions: z.number(),
  min_sessions: z.number(),
});

const PlanModelsSchema = z.object({
  size_model: z.object({
    kind: z.literal("poisson_glm"),
    baseline: z.string(),
    intercept: z.number(),
    source_effects: z.array(z.object({ source: z.string(), coef: z.number() })),
    p_long: z.number(),
  }),
  long_share: z.object({
    intercept: z.number(),
    log_size: z.number(),
    is_subagent: z.number(),
  }),
});
export type PlanModels = z.infer<typeof PlanModelsSchema>;

const TierRefSchema = z.object({ model_id: z.string() });

/** router-core `TierSet`: the plan's fitted tiers, fast to smart. */
const TiersFingerprintSchema = z.object({
  tiers: z.tuple([TierRefSchema, TierRefSchema, TierRefSchema]),
});

export function parseTierModelIds(
  document: unknown,
): readonly [string, string, string] | null {
  const tiers = TiersFingerprintSchema.safeParse(document).data?.tiers;
  return tiers
    ? [tiers[0].model_id, tiers[1].model_id, tiers[2].model_id]
    : null;
}

export function parsePlanSummary(document: unknown): PlanSummary | null {
  return PlanSummarySchema.safeParse(document).data ?? null;
}

export function parsePlanModels(document: unknown): PlanModels | null {
  return PlanModelsSchema.safeParse(document).data ?? null;
}

export function parseHoldout(document: unknown): Holdout | null {
  return PlanDiagnosticsSchema.safeParse(document).data?.holdout ?? null;
}

export function parseColdStartDiagnostics(document: unknown) {
  return ColdStartDiagnosticsSchema.safeParse(document).data ?? null;
}

/** The size model's log-scale is `tokens / 1e6`. */
export const SIZE_MODEL_TOKEN_SCALE = 1_000_000;

const REJECTION_REASONS: Record<string, string> = {
  stale_generation: "Settings changed while the plan was fitting.",
  stale_scorer_version: "The scorer changed while the plan was fitting.",
  stale_watermark: "A plan fitted on newer usage was already published.",
};

/** Why a `rejected` fit lost at publication, from its stored reason. */
export function rejectionReason(error: string | null): string {
  return (error && REJECTION_REASONS[error]) ?? "Superseded by a newer fit.";
}
