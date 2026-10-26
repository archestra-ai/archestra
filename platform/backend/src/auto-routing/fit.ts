import {
  coreVersion,
  plan as fitPlan,
  planFormatVersion,
} from "@archestra/router-rs";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingPlanModel from "@/models/routing-plan";
import RoutingUsageModel from "@/models/routing-usage";
import {
  type RouterDocument,
  RouterDocumentSchema,
  type RoutingFitOutcome,
  type RoutingPlan,
  type RoutingPlanTrigger,
  type RoutingPublishResult,
} from "@/types/auto-routing";
import type { AutoRoutingFitResult } from "@/types/auto-routing-api";
import { activeScorerVersion } from "./router";
import {
  loadTrio,
  type RouterTierSet,
  TierThresholdMismatchError,
  type Trio,
  tiersFingerprint,
} from "./tiers";

/** Everything a fit is computed from, read without the routing-plan lock. */
type FitInputs = {
  organizationId: string;
  trigger: RoutingPlanTrigger;
  generation: number;
  inputWatermark: Date;
  tiers: FitTiers;
  budgetUsdPerDay: string;
  scorerVersionId: string;
  history: FitHistoryRow[];
};

/** The trio as router-core prices it, or why it cannot be priced (recorded as a failed fit). */
type FitTiers =
  | { kind: "ok"; tiers: RouterTierSet }
  | { kind: "invalid"; error: string; fingerprint: RouterDocument };

/**
 * Reads a fit's inputs, first making this process's scorer version the
 * organization's (a change bumps the generation). Nothing else is locked:
 * publication rejects the fit when settings moved on meanwhile. Null when
 * auto routing is not (or no longer) fully configured for the organization.
 */
export async function prepareFit(
  organizationId: string,
  requestedTrigger?: RoutingPlanTrigger,
): Promise<FitInputs | null> {
  const scorerVersion = await activeScorerVersion();
  await AutoRoutingSettingsModel.activateScorerVersion(
    organizationId,
    scorerVersion.id,
  );
  const settings = await AutoRoutingSettingsModel.find(organizationId);
  if (!settings?.enabled || settings.budgetUsdPerDay === null) return null;
  const loaded = await loadTrio(settings);
  if (loaded.kind !== "ok") return null;
  const tiers = fitTiers(loaded.trio);
  const [latest] = await RoutingPlanModel.findHistory(organizationId, 1);
  const inputWatermark = new Date();
  const history =
    tiers.kind === "ok"
      ? await RoutingUsageModel.findFitHistory({
          organizationId,
          scorerVersionId: scorerVersion.id,
          inputWatermark,
          longContextThreshold: tiers.tiers.long_context_threshold,
        })
      : [];
  const trigger: RoutingPlanTrigger =
    requestedTrigger ??
    (latest && latest.plan.scorerVersionId !== scorerVersion.id
      ? "scorer_change"
      : settings.generation > settings.plannedGeneration
        ? "settings"
        : "nightly");
  return {
    organizationId,
    trigger,
    generation: settings.generation,
    inputWatermark,
    tiers,
    budgetUsdPerDay: settings.budgetUsdPerDay,
    scorerVersionId: scorerVersion.id,
    history,
  };
}

/** Fits a plan on `inputs` (or a cold start below the session minimum) and offers it to the publisher. */
export async function completeFit(
  inputs: FitInputs,
): Promise<RoutingPublishResult> {
  const fitted = await fit(inputs);
  return RoutingPlanModel.publish({
    organizationId: inputs.organizationId,
    trigger: inputs.trigger,
    generation: inputs.generation,
    inputWatermark: inputs.inputWatermark,
    tiersFingerprint:
      inputs.tiers.kind === "ok"
        ? inputs.tiers.tiers
        : inputs.tiers.fingerprint,
    budgetUsdPerDay: inputs.budgetUsdPerDay,
    scorerVersionId: inputs.scorerVersionId,
    ...fitted,
  });
}

/**
 * Fits and publishes in the caller's request, after its generation bump
 * committed. A fit rejected for newer settings refits on them; one rejected
 * for older usage than an accepted fit reports that fit, the newest outcome.
 * An unexpected error is reported as a failure without a plan; the generation
 * stays unplanned, so the dispatcher retries it. Null when auto routing is not
 * fully configured.
 */
export async function fitNow(
  organizationId: string,
  trigger: RoutingPlanTrigger,
): Promise<AutoRoutingFitResult | null> {
  try {
    for (let attempt = 0; attempt < INLINE_FIT_ATTEMPTS; attempt++) {
      const inputs = await prepareFit(organizationId, trigger);
      if (!inputs) return null;
      const published = await completeFit(inputs);
      if (published.kind === "recorded") return fitResult(published.plan);
      if (published.reason === "stale_watermark") break;
    }
    const latest = await RoutingPlanModel.findLatestOutcome(organizationId);
    return latest ? fitResult(latest) : { status: "cold_start", planId: null };
  } catch (error) {
    logger.error(
      { err: error, organizationId },
      "[AutoRouting] Plan fit threw",
    );
    return {
      status: "failed",
      planId: null,
      error: "The plan fit failed unexpectedly; it will be retried shortly.",
    };
  }
}

// === Internal ===

function fitResult(plan: RoutingPlan): AutoRoutingFitResult {
  switch (plan.status) {
    case "active":
      return { status: "active", planId: plan.id };
    case "cold_start":
      return { status: "cold_start", planId: plan.id };
    case "failed":
      return {
        status: "failed",
        planId: plan.id,
        error: plan.error ?? "The plan fit failed.",
      };
    case "superseded":
      throw new Error(`Newest plan ${plan.id} is superseded`);
  }
}

function fitTiers(trio: Trio): FitTiers {
  try {
    return { kind: "ok", tiers: tiersFingerprint(trio) };
  } catch (error) {
    if (!(error instanceof TierThresholdMismatchError)) throw error;
    return {
      kind: "invalid",
      error: error.message,
      fingerprint: {
        model_ids: trio.map((model) => model.id),
        long_context_thresholds: trio.map(
          (model) => model.longContextThreshold,
        ),
      },
    };
  }
}

type FitHistoryRow = Awaited<
  ReturnType<typeof RoutingUsageModel.findFitHistory>
>[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bounds refits when settings keep changing under an inline fit. */
const INLINE_FIT_ATTEMPTS = 3;

/** The part of router-core `Plan` the publisher records next to the plan itself. */
const RouterPlanSchema = z
  .object({
    versions: z.object({
      plan_format_version: z.number().int(),
      core_version: z.string(),
    }),
    summary: RouterDocumentSchema,
    diagnostics: RouterDocumentSchema,
  })
  .passthrough();

/** Codes router-rs puts on a rejected `plan`; anything else is a defect. */
const RouterFailureSchema = z.object({
  code: z.enum([
    "ARCHESTRA_ROUTER_INVALID_INPUT",
    "ARCHESTRA_ROUTER_EMPTY_HISTORY",
    "ARCHESTRA_ROUTER_BASELINE_SOURCE_MISSING",
    "ARCHESTRA_ROUTER_FIT_FAILED",
    "ARCHESTRA_ROUTER_INFEASIBLE",
  ]),
  message: z.string(),
});
const CodedErrorSchema = z.object({ code: z.string(), message: z.string() });

async function fit(inputs: FitInputs): Promise<{
  coreVersion: string;
  planFormatVersion: number;
  outcome: RoutingFitOutcome;
}> {
  const versions = {
    coreVersion: coreVersion(),
    planFormatVersion: planFormatVersion(),
  };
  if (inputs.tiers.kind === "invalid") {
    return {
      ...versions,
      outcome: {
        status: "failed",
        error: inputs.tiers.error,
        diagnostics: null,
      },
    };
  }
  const { tiers } = inputs.tiers;
  const sessions = inputs.history.length;
  const minSessions = config.autoRouting.minSessions;
  if (sessions < minSessions) {
    return {
      ...versions,
      outcome: {
        status: "cold_start",
        summary: null,
        diagnostics: { sessions, min_sessions: minSessions },
      },
    };
  }
  try {
    const plan = RouterPlanSchema.parse(
      JSON.parse(await fitPlan(JSON.stringify(planInput(inputs, tiers)))),
    );
    return {
      coreVersion: plan.versions.core_version,
      planFormatVersion: plan.versions.plan_format_version,
      outcome: {
        status: "active",
        plan,
        summary: plan.summary,
        diagnostics: plan.diagnostics,
      },
    };
  } catch (error) {
    const coded = CodedErrorSchema.safeParse(error);
    if (!coded.success) throw error;
    const expected = RouterFailureSchema.safeParse(error).success;
    const log = { organizationId: inputs.organizationId, ...coded.data };
    if (expected) logger.warn(log, "[AutoRouting] Plan fit failed");
    else logger.error(log, "[AutoRouting] Plan fit failed unexpectedly");
    return {
      ...versions,
      outcome: {
        status: "failed",
        error: `${coded.data.code}: ${coded.data.message}`,
        diagnostics: null,
      },
    };
  }
}

/**
 * router-core `PlanInput`. Volume is flat at the observed arrival rate:
 * sessions and tokens per day over the span the history covers (at least a
 * day, so a burst does not read as an extreme rate).
 */
function planInput(inputs: FitInputs, tiers: RouterTierSet) {
  const { history } = inputs;
  const created = history.map((row) => row.createdAt.getTime());
  const span =
    created.reduce((a, b) => Math.max(a, b)) -
    created.reduce((a, b) => Math.min(a, b));
  const days = Math.max(1, span / DAY_MS);
  const rows = history.map((row) => ({
    features: row.features,
    short: tokenCounts(row.short),
    long: tokenCounts(row.long),
    timestamp_ms: row.createdAt.getTime(),
  }));
  const tokens = rows.reduce(
    (sum, row) => sum + totalTokens(row.short) + totalTokens(row.long),
    0,
  );
  return {
    history: rows,
    tiers,
    budget: Number(inputs.budgetUsdPerDay),
    volume: {
      kind: "flat",
      sessions_per_day: history.length / days,
      tokens_per_day: tokens / days,
    },
    baseline_source: mostFrequentSource(history),
  };
}

/** Cache writes include the 1h ones. */
function tokenCounts(block: FitHistoryRow["short"]) {
  return {
    input: block.input,
    cache_read: block.cacheRead,
    cache_write: block.cacheWrite,
    output: block.output,
  };
}

function totalTokens(counts: ReturnType<typeof tokenCounts>): number {
  return counts.input + counts.cache_read + counts.cache_write + counts.output;
}

/**
 * The size model's reference client, and the one unknown clients route as:
 * the most frequent client (lexicographically first on ties), which always
 * occurs in history as router-core requires.
 */
function mostFrequentSource(history: FitHistoryRow[]): string {
  const counts = new Map<string, number>();
  for (const row of history) {
    counts.set(row.features.source, (counts.get(row.features.source) ?? 0) + 1);
  }
  const [[source]] = [...counts].sort(
    ([a, ca], [b, cb]) => cb - ca || a.localeCompare(b),
  );
  return source;
}
