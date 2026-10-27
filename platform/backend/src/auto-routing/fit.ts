import { isDeepStrictEqual } from "node:util";
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
import RoutingUsageModel, { type FitVolume } from "@/models/routing-usage";
import {
  type AutoRoutingSettings,
  type RouterDocument,
  RouterDocumentSchema,
  type RoutingFitOutcome,
  type RoutingPlan,
  type RoutingPlanTrigger,
  type RoutingPublishResult,
} from "@/types/auto-routing";
import type { AutoRoutingFitResult } from "@/types/auto-routing-api";
import { activeSourceVersion, routerFeatures } from "./signals";
import {
  fingerprintMatches,
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
  history: FitHistory;
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
 * @public — `runFit` runs it; exported so tests can interleave fits
 */
export async function prepareFit(
  organizationId: string,
  requestedTrigger?: RoutingPlanTrigger,
  maxSessions?: number,
): Promise<FitInputs | null> {
  const scorerVersion = await activeSourceVersion();
  await AutoRoutingSettingsModel.activateScorerVersion(
    organizationId,
    scorerVersion.id,
  );
  const settings = await AutoRoutingSettingsModel.find(organizationId);
  return (
    settings &&
    readFitInputs({
      organizationId,
      settings,
      scorerVersionId: scorerVersion.id,
      requestedTrigger,
      maxSessions,
    })
  );
}

/**
 * The cheapest routing's USD/day when `settings` cannot be met on the current
 * usage, from a fit that publishes nothing; null when they can be, or no fit
 * would run on them.
 */
export async function infeasibleBudget(
  organizationId: string,
  settings: AutoRoutingSettings,
): Promise<number | null> {
  const inputs = await readFitInputs({
    organizationId,
    settings,
    scorerVersionId: (await activeSourceVersion()).id,
    requestedTrigger: "settings",
  });
  if (!inputs) return null;
  const { outcome } = await fit(inputs);
  if (outcome.status !== "failed") return null;
  const cheapest = INFEASIBLE_ERROR.exec(outcome.error)?.[1];
  return cheapest === undefined ? null : Number(cheapest);
}

/**
 * Whether a fit started now would read exactly what `plan` was fitted on:
 * the same settings generation and scorer version, the same tier prices and
 * the same usage window.
 */
export async function fitInputsUnchanged(
  organizationId: string,
  settings: AutoRoutingSettings,
  plan: RoutingPlan,
): Promise<boolean> {
  const scorerVersion = await activeSourceVersion();
  if (
    plan.generation !== settings.generation ||
    plan.scorerVersionId !== scorerVersion.id ||
    settings.scorerVersionId !== scorerVersion.id
  ) {
    return false;
  }
  const loaded = await loadTrio(settings);
  if (
    loaded.kind !== "ok" ||
    !fingerprintMatches(plan.tiersFingerprint, loaded.trio)
  ) {
    return false;
  }
  const volume = await RoutingUsageModel.findFitVolume({
    organizationId,
    scorerVersionId: scorerVersion.id,
    inputWatermark: new Date(),
  });
  return isDeepStrictEqual(plan.diagnostics?.history, volumeDocument(volume));
}

/**
 * Fits a plan on `inputs` (or a cold start below the session minimum) and offers it to the publisher.
 * @public — `runFit` runs it; exported so tests can interleave fits
 */
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

/** A finished fit: the inputs it read and what publication made of them. */
type FitRun = { inputs: FitInputs; published: RoutingPublishResult };

/** How many sessions a fit read for a scorer version: the cold-start progress. */
export type FitSessions = { scorerVersionId: string; sessions: number };

/**
 * Prepares, fits and publishes; one fit at a time per organization in this
 * process. A caller arriving while a fit runs waits for it and takes its run
 * when it read the caller's generation or a newer one; otherwise it runs the
 * next fit, which every caller still waiting shares. Null when auto routing
 * is not fully configured.
 */
export async function runFit(
  organizationId: string,
  trigger?: RoutingPlanTrigger,
): Promise<FitRun | null> {
  let generation: number | undefined;
  for (;;) {
    const running = fitsInFlight.get(organizationId);
    if (!running) {
      const flight = prepareAndComplete(organizationId, trigger).finally(() =>
        fitsInFlight.delete(organizationId),
      );
      fitsInFlight.set(organizationId, flight);
      return flight;
    }
    generation ??=
      (await AutoRoutingSettingsModel.find(organizationId))?.generation ?? 0;
    const done = await running.catch(() => null);
    if (done && done.inputs.generation >= generation) return done;
  }
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
): Promise<{
  fit: AutoRoutingFitResult;
  sessions: FitSessions | null;
} | null> {
  let sessions: FitSessions | null = null;
  try {
    for (let attempt = 0; attempt < INLINE_FIT_ATTEMPTS; attempt++) {
      const run = await runFit(organizationId, trigger);
      if (!run) return null;
      sessions = fitSessions(run.inputs);
      if (run.published.kind === "recorded")
        return { fit: fitResult(run.published.plan), sessions };
      if (run.published.reason === "stale_watermark") break;
    }
    const latest = await RoutingPlanModel.findLatestOutcome(organizationId);
    return {
      fit: latest ? fitResult(latest) : { status: "cold_start", planId: null },
      sessions,
    };
  } catch (error) {
    logger.error(
      { err: error, organizationId },
      "[AutoRouting] Plan fit threw",
    );
    return {
      fit: {
        status: "failed",
        planId: null,
        error: "The plan fit failed unexpectedly; it will be retried shortly.",
      },
      sessions,
    };
  }
}

// === Internal ===

async function readFitInputs(params: {
  organizationId: string;
  settings: AutoRoutingSettings;
  scorerVersionId: string;
  requestedTrigger?: RoutingPlanTrigger;
  maxSessions?: number;
}): Promise<FitInputs | null> {
  const { organizationId, settings, scorerVersionId } = params;
  if (!settings.enabled || settings.budgetUsdPerDay === null) return null;
  const loaded = await loadTrio(settings);
  if (loaded.kind !== "ok") return null;
  const tiers = fitTiers(loaded.trio);
  const [latest] = await RoutingPlanModel.findHistory(organizationId, 1);
  const inputWatermark = new Date();
  const history =
    tiers.kind === "ok"
      ? await RoutingUsageModel.findFitHistory(
          {
            organizationId,
            scorerVersionId,
            inputWatermark,
            longContextThreshold: tiers.tiers.long_context_threshold,
          },
          params.maxSessions,
        )
      : EMPTY_HISTORY;
  const trigger: RoutingPlanTrigger =
    params.requestedTrigger ??
    (latest && latest.plan.scorerVersionId !== scorerVersionId
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
    scorerVersionId,
    history,
  };
}

/** The fitted usage window, stored with an active plan so a re-plan can tell whether usage moved. */
function volumeDocument(volume: FitVolume): RouterDocument {
  return {
    sessions: volume.sessions,
    tokens: volume.tokens,
    first_created_at: volume.firstCreatedAt?.toISOString() ?? null,
    last_created_at: volume.lastCreatedAt?.toISOString() ?? null,
  };
}

const INFEASIBLE_ERROR =
  /^ARCHESTRA_ROUTER_INFEASIBLE: cheapest routing costs (\S+) USD\/day/;

const fitsInFlight = new Map<string, Promise<FitRun | null>>();

async function prepareAndComplete(
  organizationId: string,
  trigger?: RoutingPlanTrigger,
): Promise<FitRun | null> {
  const inputs = await prepareFit(organizationId, trigger);
  return inputs && { inputs, published: await completeFit(inputs) };
}

/** Unknown when the tiers could not be priced: no history was read. */
function fitSessions(inputs: FitInputs): FitSessions | null {
  return inputs.tiers.kind === "ok"
    ? {
        scorerVersionId: inputs.scorerVersionId,
        sessions: inputs.history.volume.sessions,
      }
    : null;
}

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
    case "rejected":
      throw new Error(`Newest plan ${plan.id} is ${plan.status}`);
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

type FitHistory = Awaited<ReturnType<typeof RoutingUsageModel.findFitHistory>>;
type FitHistoryRow = FitHistory["sample"][number];

const EMPTY_HISTORY: FitHistory = {
  sample: [],
  volume: {
    sessions: 0,
    tokens: 0,
    firstCreatedAt: null,
    lastCreatedAt: null,
  },
};

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
  const sessions = inputs.history.volume.sessions;
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
        diagnostics: {
          ...plan.diagnostics,
          history: volumeDocument(inputs.history.volume),
        },
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
 * router-core `PlanInput`: the per-session models fit on the sample, while
 * volume is flat at the whole window's arrival rate: sessions and tokens per
 * day over the span it covers (at least a day, so a burst does not read as an
 * extreme rate).
 */
function planInput(inputs: FitInputs, tiers: RouterTierSet) {
  const { sample, volume } = inputs.history;
  const span =
    (volume.lastCreatedAt?.getTime() ?? 0) -
    (volume.firstCreatedAt?.getTime() ?? 0);
  const days = Math.max(1, span / DAY_MS);
  return {
    history: sample.map((row) => ({
      features: routerFeatures(row.features),
      short: tokenCounts(row.short),
      long: tokenCounts(row.long),
      timestamp_ms: row.createdAt.getTime(),
    })),
    tiers,
    budget: Number(inputs.budgetUsdPerDay),
    volume: {
      kind: "flat",
      sessions_per_day: volume.sessions / days,
      tokens_per_day: volume.tokens / days,
    },
    baseline_source: mostFrequentSource(sample),
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

/**
 * The size model's reference client, and the one unknown clients route as:
 * the most frequent client (lexicographically first on ties), which always
 * occurs in history as router-core requires.
 */
function mostFrequentSource(history: FitHistoryRow[]): string {
  const counts = new Map<string, number>();
  for (const row of history) {
    counts.set(row.features.client, (counts.get(row.features.client) ?? 0) + 1);
  }
  const [[source]] = [...counts].sort(
    ([a, ca], [b, cb]) => cb - ca || a.localeCompare(b),
  );
  return source;
}
