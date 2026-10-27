import { assess, plan as fitPlan } from "@archestra/router-rs";
import { z } from "zod";
import logger from "@/logging";
import RoutingPlanModel from "@/models/routing-plan";
import type { AutoRoutingDiagnostics } from "@/types/auto-routing-api";
import {
  CodedErrorSchema,
  cheapestBudget,
  type FitHistory,
  planInput,
  readFitHistory,
  withFitAdmission,
} from "./fit";
import { routerFeatures } from "./signals";
import { type RouterTierSet, TIER_NAMES } from "./tiers";

/**
 * The active plan's fit sample re-solved at `budgetUsdPerDay` (its own budget
 * by default) and read back per session; publishes nothing. Admitted like a
 * simulation, as it fits the whole usage window twice.
 */
export function diagnoseAutoRouting(
  organizationId: string,
  budgetUsdPerDay: number | undefined,
): Promise<AutoRoutingDiagnostics> {
  return withFitAdmission(organizationId, () =>
    diagnose(organizationId, budgetUsdPerDay),
  );
}

// === Internal ===

const MAX_POINTS = 5000;
/** Each client's earliest share of sessions the out-of-sample size model is fitted on. */
const TRAIN_SHARE = 0.7;
/** A fit run only for its size model must never be infeasible. */
const UNBOUNDED_BUDGET_USD_PER_DAY = 1e12;
/** Low-discrepancy uniforms for the tie draw: stable, and close to q of a tie cohort upgrades. */
const GOLDEN_RATIO_CONJUGATE = (Math.sqrt(5) - 1) / 2;

const TierTripleSchema = z.tuple([z.number(), z.number(), z.number()]);
const TierIndexSchema = z.number().int().min(0).max(2);

const PricesSchema = z.object({
  input: z.number(),
  cache_read: z.number(),
  cache_write: z.number(),
  output: z.number(),
});
const StoredTierSetSchema = z.object({
  tiers: z.array(
    z.object({
      model_id: z.string(),
      short: PricesSchema,
      long: PricesSchema.nullable(),
    }),
  ),
  long_context_threshold: z.number().nullable(),
}) satisfies z.ZodType<RouterTierSet>;

const SolvedPlanSchema = z.object({
  policy: z.object({ lam_star: z.number(), q: z.number() }),
  summary: z.object({ tier_session_share: TierTripleSchema }),
});

const AssessmentsSchema = z.array(
  z.object({
    predicted_tokens: z.number(),
    usd_per_token: TierTripleSchema,
    base_tier: TierIndexSchema,
    tie_tier: TierIndexSchema.nullable(),
  }),
);
type Assessment = z.infer<typeof AssessmentsSchema>[number];
type Features = ReturnType<typeof routerFeatures>;
type Row = FitHistory["sample"][number];

async function diagnose(
  organizationId: string,
  requestedBudget: number | undefined,
): Promise<AutoRoutingDiagnostics> {
  const active = await RoutingPlanModel.findActive(organizationId);
  if (!active) return { status: "cold_start" };
  const tiers = StoredTierSetSchema.parse(active.tiersFingerprint);
  const history = await readFitHistory({
    organizationId,
    scorerVersionId: active.scorerVersionId,
    inputWatermark: active.inputWatermark,
    longContextThreshold: tiers.long_context_threshold,
  });
  if (history.sample.length === 0) return { status: "cold_start" };

  const savedBudgetUsdPerDay = Number(active.budgetUsdPerDay);
  const budgetUsdPerDay = requestedBudget ?? savedBudgetUsdPerDay;
  const solved = await solve(history, tiers, budgetUsdPerDay);
  if (solved.kind === "infeasible") {
    return {
      status: "infeasible",
      budgetUsdPerDay,
      savedBudgetUsdPerDay,
      minBudgetUsdPerDay: Math.ceil(solved.cheapest * 100) / 100,
    };
  }
  const plan = SolvedPlanSchema.parse(JSON.parse(solved.planJson));
  const features = history.sample.map((row) => routerFeatures(row.features));
  const routed = assessSessions(solved.planJson, features);
  const predicted = await predictOutOfSample(history, tiers, features);
  const realized = history.sample.map(realizedTokens);
  const tested = predicted.flatMap((p, i) =>
    p === null ? [] : [{ predicted: p, realized: realized[i] }],
  );
  const { q } = plan.policy;

  return {
    status: "ready",
    budgetUsdPerDay,
    savedBudgetUsdPerDay,
    lamStar: plan.policy.lam_star,
    q,
    usdPerToken: [0, 1, 2].map((tier) =>
      median(routed.map((a) => a.usd_per_token[tier])),
    ) as [number, number, number],
    tierSessionShare: plan.summary.tier_session_share,
    sizeFit: {
      testSessions: tested.length,
      spearman: spearman(
        tested.map((t) => t.predicted),
        tested.map((t) => t.realized),
      ),
      medianRealizedOverPredicted:
        tested.length === 0
          ? null
          : median(tested.map((t) => t.realized / t.predicted)),
    },
    sessions: pointIndices(features.length).map((i) => ({
      tierNeeded: features[i].tier_needed,
      pLong: features[i].p_long,
      realizedTokens: realized[i],
      predictedTokens: predicted[i],
      usdPerToken: routed[i].usd_per_token,
      tier: TIER_NAMES[drawTier(routed[i], q, i)],
    })),
  };
}

async function solve(
  history: Pick<FitHistory, "sample" | "volume">,
  tiers: RouterTierSet,
  budgetUsdPerDay: number,
): Promise<
  | { kind: "solved"; planJson: string }
  | { kind: "infeasible"; cheapest: number }
> {
  try {
    return {
      kind: "solved",
      planJson: await fitPlan(
        JSON.stringify(planInput(history, tiers, budgetUsdPerDay)),
      ),
    };
  } catch (error) {
    const coded = CodedErrorSchema.safeParse(error);
    const cheapest = coded.success
      ? cheapestBudget(`${coded.data.code}: ${coded.data.message}`)
      : null;
    if (cheapest === null) throw error;
    return { kind: "infeasible", cheapest };
  }
}

function assessSessions(planJson: string, features: Features[]): Assessment[] {
  return AssessmentsSchema.parse(
    JSON.parse(assess(planJson, JSON.stringify(features))),
  );
}

/**
 * Sizes of each client's latest sessions, predicted by a size model fitted on
 * its earliest `TRAIN_SHARE`; null for the training sessions, or for all when
 * that fit fails.
 */
async function predictOutOfSample(
  history: FitHistory,
  tiers: RouterTierSet,
  features: Features[],
): Promise<(number | null)[]> {
  const byClient = new Map<string, number[]>();
  features.forEach(({ source }, i) => {
    const indices = byClient.get(source) ?? [];
    indices.push(i);
    byClient.set(source, indices);
  });
  const test = new Set<number>();
  for (const indices of byClient.values()) {
    indices.sort(
      (a, b) =>
        history.sample[a].createdAt.getTime() -
        history.sample[b].createdAt.getTime(),
    );
    const trainSize = Math.round(indices.length * TRAIN_SHARE);
    for (const i of indices.slice(trainSize)) test.add(i);
  }
  const predictions: (number | null)[] = features.map(() => null);
  const train = history.sample.filter((_, i) => !test.has(i));
  if (train.length === 0 || test.size === 0) return predictions;
  try {
    const trained = await fitPlan(
      JSON.stringify(
        planInput(
          { sample: train, volume: history.volume },
          tiers,
          UNBOUNDED_BUDGET_USD_PER_DAY,
        ),
      ),
    );
    const order = [...test];
    const assessed = assessSessions(
      trained,
      order.map((i) => features[i]),
    );
    order.forEach((i, k) => {
      predictions[i] = assessed[k].predicted_tokens;
    });
  } catch (error) {
    const coded = CodedErrorSchema.safeParse(error);
    if (!coded.success) throw error;
    logger.warn(coded.data, "[AutoRouting] Out-of-sample size fit failed");
  }
  return predictions;
}

function drawTier(assessment: Assessment, q: number, index: number): number {
  const u = (index * GOLDEN_RATIO_CONJUGATE) % 1;
  return assessment.tie_tier !== null && u < q
    ? assessment.tie_tier
    : assessment.base_tier;
}

function realizedTokens(row: Row): number {
  const block = (b: Row["short"]) =>
    b.input + b.cacheRead + b.cacheWrite + b.output;
  return block(row.short) + block(row.long);
}

function pointIndices(n: number): number[] {
  const count = Math.min(n, MAX_POINTS);
  return Array.from({ length: count }, (_, k) => Math.floor((k * n) / count));
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Spearman's ρ with average ranks for ties; null when either side is constant. */
function spearman(x: number[], y: number[]): number | null {
  const rx = ranks(x);
  const ry = ranks(y);
  const mean = (x.length + 1) / 2;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (rx[i] - mean) * (ry[i] - mean);
    sxx += (rx[i] - mean) ** 2;
    syy += (ry[i] - mean) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

function ranks(values: number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const out = new Array<number>(values.length);
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (
      end + 1 < order.length &&
      values[order[end + 1]] === values[order[start]]
    ) {
      end++;
    }
    for (let k = start; k <= end; k++) out[order[k]] = (start + end) / 2 + 1;
    start = end + 1;
  }
  return out;
}
