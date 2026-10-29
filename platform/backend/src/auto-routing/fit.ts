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
import RoutingBackfillModel from "@/models/routing-backfill";
import RoutingHistoryModel, {
  type HistoryFitRow,
  type PastWindow,
} from "@/models/routing-history";
import RoutingPlanModel from "@/models/routing-plan";
import RoutingUsageModel, {
  type FitVolume,
  HISTORY_MS,
} from "@/models/routing-usage";
import { ApiError } from "@/types";
import {
  type AutoRoutingSettings,
  type RouterDocument,
  RouterDocumentSchema,
  type RoutingFitOutcome,
  type RoutingPlan,
  type RoutingPlanTrigger,
  type RoutingPublishResult,
} from "@/types/auto-routing";
import type {
  AutoRoutingFitResult,
  AutoRoutingSimulateResponse,
  SimulatedTraffic,
} from "@/types/auto-routing-api";
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

/** Whether a fit would run on `settings`, or why none would. */
export async function fitReadiness(
  settings: AutoRoutingSettings,
): Promise<
  | { kind: "ready"; trio: Trio; budgetUsdPerDay: string }
  | { kind: "blocked"; reason: string }
> {
  if (!settings.enabled) {
    return { kind: "blocked", reason: "Auto routing is off." };
  }
  if (settings.budgetUsdPerDay === null) {
    return { kind: "blocked", reason: "No daily budget is set." };
  }
  const loaded = await loadTrio(settings);
  switch (loaded.kind) {
    case "missing":
      return {
        kind: "blocked",
        reason: `The ${loaded.tier} tier's model is no longer available.`,
      };
    case "ok":
      return {
        kind: "ready",
        trio: loaded.trio,
        budgetUsdPerDay: settings.budgetUsdPerDay,
      };
  }
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
  return outcome.status === "failed" ? cheapestBudget(outcome.error) : null;
}

/**
 * What a fit at `budgetUsdPerDay` would plan if the fitted usage window's
 * sessions and tokens per day were `volumeMultiplier` times what they were.
 * Runs regardless of the enabled switch and publishes nothing. Each one reads
 * and fits the whole usage window, so an organization runs one at a time and
 * the process at most `MAX_SIMULATIONS`; excess calls are refused with a 429.
 */
export function simulateFit(
  organizationId: string,
  params: { budgetUsdPerDay: number; volumeMultiplier: number },
): Promise<AutoRoutingSimulateResponse> {
  return simulationAdmission(organizationId, () =>
    simulate(organizationId, params),
  );
}

/**
 * A pool admitting unpublished `kind` runs over the whole usage window: one
 * per organization and `maxInFlight` per process; excess calls are refused
 * with a 429.
 */
export function fitAdmission(kind: string, maxInFlight: number) {
  const inFlight = new Set<string>();
  return async <T>(organizationId: string, work: () => Promise<T>) => {
    if (inFlight.has(organizationId)) {
      throw new ApiError(
        429,
        `A ${kind} is already running for this organization; retry when it finishes.`,
      );
    }
    if (inFlight.size >= maxInFlight) {
      throw new ApiError(429, `Too many ${kind}s are running; retry shortly.`);
    }
    inFlight.add(organizationId);
    try {
      return await work();
    } finally {
      inFlight.delete(organizationId);
    }
  };
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
    plan.planFormatVersion !== planFormatVersion() ||
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
  const window = await readFitWindow({
    organizationId,
    scorerVersionId: scorerVersion.id,
    inputWatermark: new Date(),
  });
  return isDeepStrictEqual(plan.diagnostics?.history, volumeDocument(window));
}

/**
 * What a fit started at `inputWatermark` would read, without reading its
 * sessions: the cold-start progress, and what a refit would change.
 */
export async function readFitWindow(params: {
  organizationId: string;
  scorerVersionId: string;
  inputWatermark: Date;
}): Promise<FitWindowSummary> {
  const [live, past] = await Promise.all([
    RoutingUsageModel.findFitVolume(params),
    readPastSessions({ ...params, longContextThreshold: null }, false),
  ]);
  return summarizeWindow(live, past);
}

/**
 * Fits a plan on `inputs` (or a cold start below the session minimum) and offers it to the publisher.
 * @public — `runFit` runs it; exported so tests can interleave fits
 */
export async function completeFit(
  inputs: FitInputs,
): Promise<RoutingPublishResult> {
  return publish(inputs, await fit(inputs));
}

function publish(
  inputs: FitInputs,
  fitted: Awaited<ReturnType<typeof fit>>,
): Promise<RoutingPublishResult> {
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

/**
 * What the fit learns from and sizes the plan for. `sessions` (live plus
 * scored past ones) is what the cold-start minimum counts. Volume is the
 * live window's once it spans a week; before that, the backfill
 * population's, which estimates it from all eligible traffic.
 */
type FitWindowSummary = {
  sessions: number;
  pastSessions: number;
  volume: FitVolume;
  volumeSource: "live" | "history";
};

/** How many sessions a fit read for a scorer version: the cold-start progress. */
export type FitSessions = { scorerVersionId: string; sessions: number };

/**
 * Prepares, fits and publishes; one fit at a time per organization in this
 * process. A caller arriving while a fit runs waits for it and takes its run
 * when it read the caller's generation or a newer one; otherwise it runs the
 * next fit, which every caller still waiting shares. Null when auto routing
 * is not fully configured.
 * @public — `fitNow` runs it; exported so tests can fit without its retries
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
 * An error that left no outcome recorded is reported as a failure without a
 * plan; the generation stays unplanned, so the dispatcher retries it. Null
 * when auto routing is not fully configured.
 */
export async function fitNow(
  organizationId: string,
  trigger?: RoutingPlanTrigger,
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

const MAX_SIMULATIONS = 4;
const simulationAdmission = fitAdmission("simulation", MAX_SIMULATIONS);

async function simulate(
  organizationId: string,
  params: { budgetUsdPerDay: number; volumeMultiplier: number },
): Promise<AutoRoutingSimulateResponse> {
  const settings = await AutoRoutingSettingsModel.find(organizationId);
  const inputs =
    settings &&
    (await readFitInputs({
      organizationId,
      settings: {
        ...settings,
        enabled: true,
        budgetUsdPerDay: params.budgetUsdPerDay.toFixed(2),
      },
      scorerVersionId: (await activeSourceVersion()).id,
      requestedTrigger: "manual",
    }));
  if (!inputs) {
    throw new ApiError(
      400,
      "Configure every tier model before simulating auto routing.",
    );
  }
  const { outcome } = await fit(inputs, params.volumeMultiplier);
  switch (outcome.status) {
    case "active":
      if (!outcome.summary) throw new Error("An active fit has no summary");
      if (inputs.tiers.kind !== "ok")
        throw new Error("An active fit has unpriced tiers");
      return {
        status: "feasible",
        summary: outcome.summary,
        tiersFingerprint: inputs.tiers.tiers,
        baseline: dailyVolume(inputs.history.volume),
      };
    case "cold_start":
      return {
        status: "cold_start",
        sessions: inputs.history.sessions,
        required: config.autoRouting.minSessions,
      };
    case "failed": {
      const cheapest = cheapestBudget(outcome.error);
      if (cheapest === null) throw new ApiError(400, outcome.error);
      return {
        status: "infeasible",
        minBudgetUsdPerDay: Math.ceil(cheapest * 100) / 100,
        baseline: dailyVolume(inputs.history.volume),
      };
    }
  }
}

/** Why a fit nobody requested runs: what moved since the organization's last fit outcome. */
async function scheduledTrigger(params: {
  organizationId: string;
  settings: AutoRoutingSettings;
  scorerVersionId: string;
  latestScorerVersionId: string | null;
}): Promise<RoutingPlanTrigger> {
  const { settings, latestScorerVersionId } = params;
  if (
    latestScorerVersionId !== null &&
    latestScorerVersionId !== params.scorerVersionId
  )
    return "scorer_change";
  const unplanned = settings.generation > settings.plannedGeneration;
  if (
    unplanned &&
    (await RoutingBackfillModel.bumpedGeneration(
      params.organizationId,
      settings.generation,
    ))
  )
    return "backfill";
  if (unplanned) return "settings";
  return latestScorerVersionId === null ? "initial" : "nightly";
}

async function readFitInputs(params: {
  organizationId: string;
  settings: AutoRoutingSettings;
  scorerVersionId: string;
  requestedTrigger?: RoutingPlanTrigger;
  maxSessions?: number;
}): Promise<FitInputs | null> {
  const { organizationId, settings, scorerVersionId } = params;
  const readiness = await fitReadiness(settings);
  if (readiness.kind !== "ready") return null;
  const tiers = fitTiers(readiness.trio);
  const [latest] = await RoutingPlanModel.findHistory(organizationId, 1);
  const inputWatermark = new Date();
  const history =
    tiers.kind === "ok"
      ? await readFitHistory(
          {
            organizationId,
            scorerVersionId,
            inputWatermark,
            longContextThreshold: tiers.tiers.long_context_threshold,
          },
          params.maxSessions,
        )
      : EMPTY_HISTORY;
  const trigger =
    params.requestedTrigger ??
    (await scheduledTrigger({
      organizationId,
      settings,
      scorerVersionId,
      latestScorerVersionId: latest?.plan.scorerVersionId ?? null,
    }));
  return {
    organizationId,
    trigger,
    generation: settings.generation,
    inputWatermark,
    tiers,
    budgetUsdPerDay: readiness.budgetUsdPerDay,
    scorerVersionId,
    history,
  };
}

/** The fitted window, stored with an active plan so a re-plan can tell whether usage moved. */
function volumeDocument(window: FitWindowSummary): RouterDocument {
  const { volume } = window;
  return {
    sessions: window.sessions,
    past_sessions: window.pastSessions,
    tokens: volume.tokens,
    first_created_at: volume.firstCreatedAt?.toISOString() ?? null,
    last_created_at: volume.lastCreatedAt?.toISOString() ?? null,
    volume_source: window.volumeSource,
  };
}

/**
 * Live auto sessions and scored past sessions, each weighted by how many
 * sessions of its window it stands for.
 */
export async function readFitHistory(
  params: {
    organizationId: string;
    scorerVersionId: string;
    inputWatermark: Date;
    longContextThreshold: number | null;
  },
  maxSessions?: number,
): Promise<FitHistory> {
  const [live, past] = await Promise.all([
    RoutingUsageModel.findFitHistory(params, maxSessions),
    readPastSessions(params, true),
  ]);
  // The live sample is capped while its volume counts the whole window.
  const liveWeight =
    live.sample.length === 0 ? 1 : live.volume.sessions / live.sample.length;
  return {
    ...summarizeWindow(live.volume, past),
    sample: [
      ...live.sample.map((row) => ({ ...row, weight: liveWeight })),
      ...past.sample,
    ],
  };
}

async function readPastSessions(
  params: {
    organizationId: string;
    scorerVersionId: string;
    inputWatermark: Date;
    longContextThreshold: number | null;
  },
  withSample: boolean,
): Promise<PastWindow & { sample: HistoryFitRow[] }> {
  const frame = await RoutingBackfillModel.findLatestScanned(
    params.organizationId,
  );
  if (!frame)
    return { scored: 0, population: EMPTY_HISTORY.volume, sample: [] };
  return RoutingHistoryModel.findFitSnapshot({
    ...params,
    frame,
    windowStart: new Date(params.inputWatermark.getTime() - HISTORY_MS),
    withSample,
  });
}

function summarizeWindow(live: FitVolume, past: PastWindow): FitWindowSummary {
  const span =
    (live.lastCreatedAt?.getTime() ?? 0) -
    (live.firstCreatedAt?.getTime() ?? 0);
  const fromHistory =
    span < LIVE_VOLUME_MIN_SPAN_MS && past.population.sessions > 0;
  return {
    sessions: live.sessions + past.scored,
    pastSessions: past.scored,
    volume: fromHistory ? past.population : live,
    volumeSource: fromHistory ? "history" : "live",
  };
}

const INFEASIBLE_ERROR =
  /^ARCHESTRA_ROUTER_INFEASIBLE: cheapest routing costs (\S+) USD\/day/;

/** The cheapest routing's USD/day when `error` is an infeasible-budget fit failure. */
export function cheapestBudget(error: string): number | null {
  const cheapest = INFEASIBLE_ERROR.exec(error)?.[1];
  return cheapest === undefined ? null : Number(cheapest);
}

const fitsInFlight = new Map<string, Promise<FitRun | null>>();

async function prepareAndComplete(
  organizationId: string,
  trigger?: RoutingPlanTrigger,
): Promise<FitRun | null> {
  const inputs = await prepareFit(organizationId, trigger);
  if (!inputs) return null;
  try {
    return { inputs, published: await completeFit(inputs) };
  } catch (error) {
    // Recorded, so the generation it read is planned rather than pending forever.
    logger.error(
      { err: error, organizationId },
      "[AutoRouting] Plan fit failed unexpectedly",
    );
    const published = await publish(inputs, {
      coreVersion: coreVersion(),
      planFormatVersion: planFormatVersion(),
      outcome: {
        status: "failed",
        error: "The plan fit failed unexpectedly.",
        diagnostics: null,
      },
    });
    return { inputs, published };
  }
}

/** Unknown when the tiers could not be priced: no history was read. */
function fitSessions(inputs: FitInputs): FitSessions | null {
  return inputs.tiers.kind === "ok"
    ? {
        scorerVersionId: inputs.scorerVersionId,
        sessions: inputs.history.sessions,
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

type FitHistoryRow = HistoryFitRow;
export type FitHistory = FitWindowSummary & { sample: FitHistoryRow[] };

const EMPTY_HISTORY: FitHistory = {
  sample: [],
  sessions: 0,
  pastSessions: 0,
  volume: {
    sessions: 0,
    tokens: 0,
    firstCreatedAt: null,
    lastCreatedAt: null,
  },
  volumeSource: "live",
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Live auto traffic sizes the plan once its window spans this long. */
const LIVE_VOLUME_MIN_SPAN_MS = 7 * DAY_MS;

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
export const CodedErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

async function fit(
  inputs: FitInputs,
  volumeMultiplier = 1,
): Promise<{
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
  const { sessions } = inputs.history;
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
      JSON.parse(
        await fitPlan(
          JSON.stringify(
            planInput(
              inputs.history,
              tiers,
              Number(inputs.budgetUsdPerDay),
              volumeMultiplier,
            ),
          ),
        ),
      ),
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
          history: volumeDocument(inputs.history),
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
 * The window's arrival rate: sessions and tokens per day over the span it
 * covers (at least a day, so a burst does not read as an extreme rate).
 */
function dailyVolume(volume: FitVolume): SimulatedTraffic {
  const span =
    (volume.lastCreatedAt?.getTime() ?? 0) -
    (volume.firstCreatedAt?.getTime() ?? 0);
  const days = Math.max(1, span / DAY_MS);
  return {
    sessionsPerDay: volume.sessions / days,
    tokensPerDay: volume.tokens / days,
  };
}

/**
 * router-core `PlanInput`: the per-session models fit on the sample, while
 * volume is flat at the whole window's arrival rate times `volumeMultiplier`.
 */
export function planInput(
  history: Pick<FitHistory, "sample" | "volume">,
  tiers: RouterTierSet,
  budgetUsdPerDay: number,
  volumeMultiplier = 1,
) {
  const { sample, volume } = history;
  const { sessionsPerDay, tokensPerDay } = dailyVolume(volume);
  return {
    history: sample.map((row) => ({
      features: routerFeatures(row.features),
      short: tokenCounts(row.short),
      long: tokenCounts(row.long),
      timestamp_ms: row.createdAt.getTime(),
      weight: row.weight,
    })),
    tiers,
    budget: budgetUsdPerDay,
    volume: {
      kind: "flat",
      sessions_per_day: sessionsPerDay * volumeMultiplier,
      tokens_per_day: tokensPerDay * volumeMultiplier,
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
