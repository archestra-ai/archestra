import { assess, plan as fitPlan } from "@archestra/router-rs";
import { z } from "zod";
import logger from "@/logging";
import RoutingBackfillModel from "@/models/routing-backfill";
import RoutingPlanModel from "@/models/routing-plan";
import RoutingUsageModel from "@/models/routing-usage";
import type { RoutingPlan } from "@/types/auto-routing";
import type {
  AutoRoutingDiagnostics,
  AutoRoutingSizeFit,
} from "@/types/auto-routing-api";
import {
  CodedErrorSchema,
  cheapestBudget,
  type FitHistory,
  fitAdmission,
  planInput,
  readFitHistory,
} from "./fit";
import { routerFeatures } from "./signals";
import { type RouterTierSet, TIER_NAMES } from "./tiers";

/**
 * The current fit history, read at the active plan's scorer version and
 * tiers, re-solved at `budgetUsdPerDay` (the plan's budget by default) and
 * read back per displayed session; publishes nothing. Diagnostics admit
 * apart from simulations so browsing budgets never starves them.
 */
export function diagnoseAutoRouting(
  organizationId: string,
  budgetUsdPerDay: number | undefined,
): Promise<AutoRoutingDiagnostics> {
  return diagnosticsAdmission(organizationId, () =>
    diagnose(organizationId, budgetUsdPerDay),
  );
}

// === Internal ===

const MAX_DIAGNOSTICS = 2;
const diagnosticsAdmission = fitAdmission("diagnostic", MAX_DIAGNOSTICS);

const MAX_POINTS = 5000;
/** Each client's earliest share of sessions the out-of-sample size model is fitted on. */
const TRAIN_SHARE = 0.7;
/** A fit run only for its size model must never be infeasible. */
const UNBOUNDED_BUDGET_USD_PER_DAY = 1e12;
/** Low-discrepancy uniforms for the tie draw: stable, and close to q of a tie cohort upgrades. */
const GOLDEN_RATIO_CONJUGATE = (Math.sqrt(5) - 1) / 2;
const BASIS_TTL_MS = 5 * 60 * 1000;
const MAX_BASES = 16;
/**
 * Usage is stamped at its transaction's start, so a row committed after a
 * build may predate it; rows older than this are left to the TTL.
 */
const USAGE_COMMIT_SLACK_MS = 60 * 1000;

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

/** Everything diagnostics read that no budget changes. */
type Basis = {
  history: FitHistory;
  /** The displayed sessions, a deterministic spread over the sample. */
  display: {
    index: number;
    features: Features;
    realizedTokens: number;
    predictedTokens: number | null;
  }[];
  sizeFit: AutoRoutingSizeFit;
};

type Holdout =
  | { status: "ok"; predictions: (number | null)[] }
  | { status: "no_holdout" | "failed" };

/** Per organization, least recently used first. */
const bases = new Map<
  string,
  { identity: string; usageSince: Date; expiresAt: number; basis: Basis }
>();

async function diagnose(
  organizationId: string,
  requestedBudget: number | undefined,
): Promise<AutoRoutingDiagnostics> {
  const active = await RoutingPlanModel.findActive(organizationId);
  if (!active) return { status: "cold_start" };
  const tiers = StoredTierSetSchema.parse(active.tiersFingerprint);
  const basis = await cachedBasis(active, tiers);
  if (basis.history.sample.length === 0) return { status: "cold_start" };

  const savedBudgetUsdPerDay = Number(active.budgetUsdPerDay);
  const budgetUsdPerDay = requestedBudget ?? savedBudgetUsdPerDay;
  const solved = await solve(basis.history, tiers, budgetUsdPerDay);
  if (solved.kind === "infeasible") {
    return {
      status: "infeasible",
      budgetUsdPerDay,
      savedBudgetUsdPerDay,
      minBudgetUsdPerDay: Math.ceil(solved.cheapest * 100) / 100,
    };
  }
  const plan = SolvedPlanSchema.parse(JSON.parse(solved.planJson));
  const routed = assessSessions(
    solved.planJson,
    basis.display.map((d) => d.features),
  );
  const { q } = plan.policy;

  return {
    status: "ready",
    budgetUsdPerDay,
    savedBudgetUsdPerDay,
    lamStar: plan.policy.lam_star,
    q,
    tierSessionShare: plan.summary.tier_session_share,
    sizeFit: basis.sizeFit,
    sessions: basis.display.map((d, k) => ({
      tierNeeded: d.features.tier_needed,
      pLong: d.features.p_long,
      realizedTokens: d.realizedTokens,
      predictedTokens: d.predictedTokens,
      usdPerToken: routed[k].usd_per_token,
      tier: TIER_NAMES[drawTier(routed[k], q, d.index)],
    })),
  };
}

/** The basis of the active plan, rebuilt once its history may have changed or its entry expired. */
async function cachedBasis(
  active: RoutingPlan,
  tiers: RouterTierSet,
): Promise<Basis> {
  const { organizationId } = active;
  const now = Date.now();
  const cached = bases.get(organizationId);
  bases.delete(organizationId);
  let entry = cached && cached.expiresAt > now ? cached : undefined;
  if (
    !entry ||
    (await basisIdentity(active, entry.usageSince)) !== entry.identity
  ) {
    const usageSince = new Date(now - USAGE_COMMIT_SLACK_MS);
    entry = {
      identity: await basisIdentity(active, usageSince),
      usageSince,
      expiresAt: now + BASIS_TTL_MS,
      basis: await buildBasis(active, tiers),
    };
  }
  bases.set(organizationId, entry);
  for (const key of bases.keys()) {
    if (bases.size <= MAX_BASES) break;
    bases.delete(key);
  }
  return entry.basis;
}

/** What a basis was built from: the plan, the organization's usage since `usageSince`, and its latest backfill. */
async function basisIdentity(
  active: RoutingPlan,
  usageSince: Date,
): Promise<string> {
  const [usageAt, backfill] = await Promise.all([
    RoutingUsageModel.findLatestCreatedAt(active.organizationId, usageSince),
    RoutingBackfillModel.findLatest(active.organizationId),
  ]);
  return JSON.stringify([
    active.id,
    active.scorerVersionId,
    usageAt?.getTime() ?? null,
    backfill?.id ?? null,
    backfill?.updatedAt.getTime() ?? null,
  ]);
}

async function buildBasis(
  active: RoutingPlan,
  tiers: RouterTierSet,
): Promise<Basis> {
  const history = await readFitHistory({
    organizationId: active.organizationId,
    scorerVersionId: active.scorerVersionId,
    inputWatermark: active.inputWatermark,
    longContextThreshold: tiers.long_context_threshold,
  });
  const features = history.sample.map((row) => routerFeatures(row.features));
  const realized = history.sample.map(realizedTokens);
  const holdout = await predictOutOfSample(history, tiers, features);
  const display = pointIndices(features.length).map((index) => ({
    index,
    features: features[index],
    realizedTokens: realized[index],
    predictedTokens:
      holdout.status === "ok" ? holdout.predictions[index] : null,
  }));
  return {
    history,
    display,
    sizeFit: summarizeSizeFit(holdout, realized, display),
  };
}

function summarizeSizeFit(
  holdout: Holdout,
  realized: number[],
  display: Basis["display"],
): AutoRoutingSizeFit {
  if (holdout.status !== "ok") return { status: holdout.status };
  const tested = holdout.predictions.flatMap((p, i) =>
    p === null ? [] : [{ predicted: p, realized: realized[i] }],
  );
  const shown = display.flatMap((d) =>
    d.predictedTokens === null
      ? []
      : [d.predictedTokens > 0 && d.realizedTokens > 0],
  );
  const plotted = shown.filter(Boolean).length;
  return {
    status: "ok",
    testSessions: tested.length,
    plotted,
    excluded: shown.length - plotted,
    spearman: spearman(
      tested.map((t) => t.predicted),
      tested.map((t) => t.realized),
    ),
    medianRealizedOverPredicted: median(
      tested.flatMap((t) =>
        t.predicted > 0 ? [t.realized / t.predicted] : [],
      ),
    ),
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
 * its earliest `TRAIN_SHARE`; null for the training sessions.
 */
async function predictOutOfSample(
  history: FitHistory,
  tiers: RouterTierSet,
  features: Features[],
): Promise<Holdout> {
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
  const train = history.sample.filter((_, i) => !test.has(i));
  if (train.length === 0 || test.size === 0) return { status: "no_holdout" };
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
    const predictions: (number | null)[] = features.map(() => null);
    order.forEach((i, k) => {
      predictions[i] = assessed[k].predicted_tokens;
    });
    return { status: "ok", predictions };
  } catch (error) {
    const coded = CodedErrorSchema.safeParse(error);
    if (!coded.success) throw error;
    logger.warn(coded.data, "[AutoRouting] Out-of-sample size fit failed");
    return { status: "failed" };
  }
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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
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
