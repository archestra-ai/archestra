import { z } from "zod";

// router-core plan documents travel as untyped JSON; these mirror the Rust
// structs (plan.rs) at plan format version 1.

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

const REJECTION_REASONS: Record<string, string> = {
  stale_generation: "Settings changed while the plan was fitting.",
  stale_scorer_version: "The scorer changed while the plan was fitting.",
  stale_watermark: "A plan fitted on newer usage was already published.",
};

/** Why a `rejected` fit lost at publication, from its stored reason. */
export function rejectionReason(error: string | null): string {
  return (error && REJECTION_REASONS[error]) ?? "Superseded by a newer fit.";
}
