import { z } from "zod";
import { formatCurrency } from "@/lib/utils/format-currency";

// router-core plan documents travel as untyped JSON; these mirror the Rust
// structs (plan.rs) at plan format version 5.

const TierTriple = z.tuple([z.number(), z.number(), z.number()]);

const PlanSummarySchema = z.object({
  sessions_per_day: z.number(),
  tokens_per_day: z.number(),
  expected_spend: z.number(),
  value_size_weighted: z.number(),
  tier_session_share: TierTriple,
  tier_token_share: TierTriple,
  /** Quality against USD/day of budget, ascending in spend. */
  frontier: z.array(z.object({ spend: z.number(), value: z.number() })).min(1),
});
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

/**
 * What a round extra budget, about a quarter of the plan's spend, buys:
 * read off the plan's frontier, so it never exceeds what the tiers can give.
 * Null for a plan that spends nothing.
 */
export function extraBudgetGain(
  summary: PlanSummary,
): { extraUsdPerDay: number; points: number } | null {
  const { frontier, expected_spend } = summary;
  if (expected_spend <= 0) return null;
  const extraUsdPerDay = roundDownToOneTwoFive(
    expected_spend * EXTRA_BUDGET_SHARE,
  );
  const gain =
    valueAt(frontier, expected_spend + extraUsdPerDay) -
    valueAt(frontier, expected_spend);
  return { extraUsdPerDay, points: gain * 100 };
}

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

/** The usage window an active plan was fitted on, which the backend stores in its diagnostics. */
const FittedHistorySchema = z.object({
  history: z.object({
    sessions: z.number(),
    /** Of `sessions`, the ones scored from the interaction log; absent before backfill. */
    past_sessions: z.number().default(0),
    last_created_at: z.string().nullable(),
  }),
});
export type FittedHistory = z.infer<typeof FittedHistorySchema>["history"];

export function parseFittedHistory(document: unknown): FittedHistory | null {
  return FittedHistorySchema.safeParse(document).data?.history ?? null;
}

const ROUTER_ERROR = /^(ARCHESTRA_ROUTER_[A-Z_]+): (.*)$/;
const CHEAPEST_ROUTING = /cheapest routing costs (\S+) USD\/day/;

const ROUTER_ERROR_MESSAGES: Record<string, string> = {
  ARCHESTRA_ROUTER_EMPTY_HISTORY: "There is no usable session history yet.",
  ARCHESTRA_ROUTER_BASELINE_SOURCE_MISSING:
    "The session history is incomplete; the next fit retries.",
  ARCHESTRA_ROUTER_FIT_FAILED:
    "The usage model could not be fitted on this history; the next fit retries.",
  ARCHESTRA_ROUTER_INVALID_INPUT:
    "The tier prices or the budget cannot be used for routing.",
};

/** A stored fit error in words, with the router's code (when it has one) as detail. */
export function describeFitError(error: string): {
  message: string;
  code: string | null;
} {
  const [, code, detail] = ROUTER_ERROR.exec(error) ?? [];
  if (!code) return { message: error, code: null };
  const cheapest = CHEAPEST_ROUTING.exec(detail)?.[1];
  if (code === "ARCHESTRA_ROUTER_INFEASIBLE" && cheapest) {
    const minimum = Math.ceil(Number(cheapest) * 100) / 100;
    return {
      message: `Budget too low for these models: the cheapest routing costs ${formatCurrency(minimum)}/day.`,
      code,
    };
  }
  return { message: ROUTER_ERROR_MESSAGES[code] ?? detail, code };
}

const EXTRA_BUDGET_SHARE = 0.25;

type FrontierPoint = PlanSummary["frontier"][number];

/** Linear interpolation between the frontier's points, held flat past either end. */
function valueAt(frontier: FrontierPoint[], spend: number): number {
  const next = frontier.findIndex((point) => point.spend >= spend);
  if (next === -1) return frontier[frontier.length - 1].value;
  if (next === 0) return frontier[0].value;
  const a = frontier[next - 1];
  const b = frontier[next];
  return (
    a.value + ((b.value - a.value) * (spend - a.spend)) / (b.spend - a.spend)
  );
}

/** The largest 1, 2 or 5 × 10ⁿ not above `amount` (8.03 → 5, 10.2 → 10). */
function roundDownToOneTwoFive(amount: number): number {
  let magnitude = 10 ** Math.floor(Math.log10(amount));
  // Math.log10(1000) is 2.9999999999999996
  if (amount / magnitude >= 10) magnitude *= 10;
  const leading = amount / magnitude;
  const step = leading >= 5 ? 5 : leading >= 2 ? 2 : 1;
  return step * magnitude;
}
