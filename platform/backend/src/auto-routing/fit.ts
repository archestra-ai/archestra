import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  coreVersion,
  plan as fitPlan,
  planFormatVersion,
} from "@archestra/router-rs";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import AutoRouterModel from "@/models/auto-router";
import ModelModel from "@/models/model";
import RoutingBackfillModel, {
  type ScanFrame,
} from "@/models/routing-backfill";
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
  type AutoRouter,
  type AutoRoutingBudgetPreset,
  type RouterDocument,
  RouterDocumentSchema,
  type RoutingFitOutcome,
  type RoutingPlan,
  type RoutingPlanTrigger,
  type RoutingPublishResult,
  type RoutingVolumeSource,
} from "@/types/auto-routing";
import type {
  AutoRoutingFitResult,
  AutoRoutingSimulateResponse,
  SimulatedTraffic,
} from "@/types/auto-routing-api";
import {
  activeSourceVersion,
  routerFeatures,
  scoresAsDefault,
} from "./signals";
import {
  fingerprintMatches,
  loadTrio,
  type RouterTierSet,
  type RouterTokenPrices,
  TierThresholdMismatchError,
  type Trio,
  tiersFingerprint,
} from "./tiers";

/** Everything a fit is computed from, read without the routing-plan lock. */
type FitInputs = {
  organizationId: string;
  routerId: string;
  trigger: RoutingPlanTrigger;
  generation: number;
  inputWatermark: Date;
  tiers: FitTiers;
  budget: FitBudget;
  scorerVersionId: string;
  history: FitHistory;
};

/** The budget a fit plans for: the custom one, or a preset it resolves on the usage it read. */
type FitBudget =
  | { kind: "usd"; usdPerDay: string }
  | { kind: "preset"; preset: AutoRoutingBudgetPreset };

/**
 * The share of sessions the end presets keep on their tier: Cost-efficient
 * spends the most that still leaves this share on the fast tier, Intelligence
 * the least that puts this share on the smart tier. Balanced spends halfway
 * between the two.
 */
const BUDGET_PRESET_TIER_SHARE = 2 / 3;

/** The trio as router-core prices it, or why it cannot be priced (recorded as a failed fit). */
type FitTiers =
  | { kind: "ok"; tiers: RouterTierSet }
  | { kind: "invalid"; error: string; fingerprint: RouterDocument };

/**
 * Reads a fit's inputs, first making this process's scorer version the
 * router's (a change bumps the generation). Nothing else is locked:
 * publication rejects the fit when settings moved on meanwhile. Null when
 * the router is gone or not (or no longer) fully configured.
 * @public — `runFit` runs it; exported so tests can interleave fits
 */
export async function prepareFit(
  routerId: string,
  requestedTrigger?: RoutingPlanTrigger,
  maxSessions?: number,
): Promise<FitInputs | null> {
  const router = await AutoRouterModel.find(routerId);
  if (!router) return null;
  const scorerVersion = await activeSourceVersion(router.scorerModel);
  await AutoRouterModel.activateScorerVersion(routerId, scorerVersion.id);
  const settings = await AutoRouterModel.find(routerId);
  return (
    settings &&
    readFitInputs({
      settings,
      scorerVersionId: scorerVersion.id,
      requestedTrigger,
      maxSessions,
    })
  );
}

/** Whether a fit would run on `settings`, or why none would. */
export async function fitReadiness(
  settings: AutoRouter,
): Promise<
  | { kind: "ready"; trio: Trio; budget: FitBudget }
  | { kind: "blocked"; reason: string }
> {
  if (!settings.enabled) {
    return { kind: "blocked", reason: "Auto routing is off." };
  }
  const budget: FitBudget | null = settings.budgetPreset
    ? { kind: "preset", preset: settings.budgetPreset }
    : settings.budgetUsdPerDay !== null
      ? { kind: "usd", usdPerDay: settings.budgetUsdPerDay }
      : null;
  if (!budget) {
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
      return { kind: "ready", trio: loaded.trio, budget };
  }
}

/**
 * The cheapest routing's USD/day when `settings` cannot be met on the current
 * usage, from a fit that publishes nothing; null when they can be, or no fit
 * would run on them. A preset is always met: it never resolves below the
 * cheapest routing. Checked as if routing were on, so a budget saved while
 * it is off is met once it is on. Admitted with the simulations under the
 * process-wide limit alone, so concurrent saves never refuse each other.
 */
export async function infeasibleBudget(
  settings: AutoRouter,
): Promise<number | null> {
  if (settings.budgetPreset) return null;
  return simulationAdmission(`budget check ${randomUUID()}`, async () => {
    const inputs = await readFitInputs({
      settings: { ...settings, enabled: true },
      scorerVersionId: (await activeSourceVersion(settings.scorerModel)).id,
      requestedTrigger: "settings",
    });
    if (!inputs) return null;
    const { outcome } = await fit(inputs);
    return outcome.status === "failed" ? cheapestBudget(outcome.error) : null;
  });
}

/**
 * What a fit at `budgetUsdPerDay`, or at the budget `budgetPreset` resolves
 * to, would plan: at an `expectedTrafficFactor` applied as a fit applies the
 * router's own, or with the fitted usage window's sessions and tokens per
 * day `volumeMultiplier` times what they were, in place of that factor.
 * Runs regardless of the enabled switch and publishes nothing. Each one reads
 * and fits the whole usage window, so a router runs one at a time and
 * the process at most `MAX_SIMULATIONS`; excess calls are refused with a 429.
 */
export function simulateFit(
  routerId: string,
  params: SimulateParams,
): Promise<AutoRoutingSimulateResponse> {
  return simulationAdmission(routerId, () => simulate(routerId, params));
}

/**
 * A pool admitting unpublished `kind` runs over the whole usage window: one
 * per router and `maxInFlight` per process; excess calls are refused
 * with a 429.
 */
export function fitAdmission(kind: string, maxInFlight: number) {
  const inFlight = new Set<string>();
  return async <T>(routerId: string, work: () => Promise<T>) => {
    if (inFlight.has(routerId)) {
      throw new ApiError(
        429,
        `A ${kind} is already running for this auto router; retry when it finishes.`,
      );
    }
    if (inFlight.size >= maxInFlight) {
      throw new ApiError(429, `Too many ${kind}s are running; retry shortly.`);
    }
    inFlight.add(routerId);
    try {
      return await work();
    } finally {
      inFlight.delete(routerId);
    }
  };
}

/**
 * Whether a fit started now would read exactly what `plan` was fitted on:
 * the same settings generation and scorer version, the same tier prices,
 * the same past-sessions frame and the same usage window.
 */
export async function fitInputsUnchanged(
  settings: AutoRouter,
  plan: RoutingPlan,
): Promise<boolean> {
  const scorerVersion = await activeSourceVersion(settings.scorerModel);
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
    router: settings,
    scorerVersionId: scorerVersion.id,
    inputWatermark: new Date(),
  });
  return (
    plan.historyFrameId === window.frameId &&
    isDeepStrictEqual(plan.diagnostics?.history, volumeDocument(window))
  );
}

/**
 * What a fit started at `inputWatermark` would read, without reading its
 * sessions: the cold-start progress, and what a refit would change.
 */
export async function readFitWindow(params: {
  router: FitScope;
  scorerVersionId: string;
  inputWatermark: Date;
  pastReads?: PastReads;
}): Promise<FitWindowSummary> {
  const [live, past] = await Promise.all([
    RoutingUsageModel.findFitVolume({
      ...params,
      routerId: params.router.id,
      minSessions: liveMinSessions(),
    }),
    readPastSessions({ ...params, longContextThreshold: null }, false),
  ]);
  return summarizeWindow(live, past, params.router);
}

/**
 * The organization's past-window reads, shared by the routers described in
 * one request at one watermark: every router reading past sessions reads the
 * same frames with the same scorer version.
 */
export type PastReads = {
  frames: Map<string, Promise<ScanFrame[]>>;
  snapshots: Map<string, Promise<PastWindow & { sample: HistoryFitRow[] }>>;
};

export function pastReads(): PastReads {
  return { frames: new Map(), snapshots: new Map() };
}

/**
 * A fit's past-sessions read as its plan recorded it, replayed as is: its
 * frame, volume source and whether past sessions counted stand whatever the
 * router's settings and the cold-start minimum are now.
 */
type RecordedPastRead = {
  frameId: string | null;
  volumeSource: RoutingVolumeSource;
  volumeFactor: number;
  countsPastSessions: boolean;
};

/** The read `plan` recorded; null for a plan recorded before plans stored it. */
export function recordedPastRead(plan: RoutingPlan): RecordedPastRead | null {
  if (plan.volumeSource === null) return null;
  const recorded = RecordedPastSchema.safeParse(plan.diagnostics?.history);
  return {
    frameId: plan.historyFrameId,
    volumeSource: plan.volumeSource,
    volumeFactor: Number(plan.volumeFactor ?? 1),
    countsPastSessions: (recorded.data?.past_sessions ?? 0) > 0,
  };
}

/**
 * Whether the router learns from the organization's past sessions: it is set
 * to, and its decision model has the scorer version that scores them.
 */
export function readsPastSessions(
  router: Pick<AutoRouter, "learnFromPastSessions" | "scorerModel">,
): boolean {
  return router.learnFromPastSessions && scoresAsDefault(router.scorerModel);
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
    routerId: inputs.routerId,
    trigger: inputs.trigger,
    generation: inputs.generation,
    inputWatermark: inputs.inputWatermark,
    tiersFingerprint:
      inputs.tiers.kind === "ok"
        ? inputs.tiers.tiers
        : inputs.tiers.fingerprint,
    scorerVersionId: inputs.scorerVersionId,
    historyFrameId: inputs.history.frameId,
    volumeFactor: inputs.history.volumeFactor,
    volumeSource: inputs.history.volumeSource,
    ...fitted,
  });
}

/** A finished fit: the inputs it read and what publication made of them. */
type FitRun = { inputs: FitInputs; published: RoutingPublishResult };

/**
 * What the fit learns from and sizes the plan for. A router starts on
 * `liveMinSessions()` sessions of its own, or on the configured minimum
 * counting the organization's scored past sessions once there are at least
 * `pastSessionsNeeded()` of them; past sessions join the fit only then, and
 * only until the router has the former, so the plan describes the traffic it
 * routes. `sessions` is what the cold-start minimum `minSessions` counts.
 * Volume is the live window's once it spans a week; before that, the
 * backfill population's, which estimates it from all eligible traffic, scaled
 * by `volumeFactor`. `frameId` is the scan whose past sessions it read, with
 * their unscaled population `pastVolume`.
 */
type FitWindowSummary = {
  sessions: number;
  minSessions: number;
  pastSessions: number;
  volume: FitVolume;
  volumeSource: RoutingVolumeSource;
  volumeFactor: number;
  frameId: string | null;
  pastVolume: FitVolume;
};

/** What a fit read for a scorer version: the cold-start progress and the volume it plans for. */
export type FitSessions = Pick<
  FitWindowSummary,
  | "sessions"
  | "minSessions"
  | "pastSessions"
  | "volumeSource"
  | "frameId"
  | "pastVolume"
> & { scorerVersionId: string };

/**
 * Prepares, fits and publishes; one fit at a time per router in this
 * process. A caller arriving while a fit runs waits for it and takes its run
 * when it read the caller's generation or a newer one; otherwise it runs the
 * next fit, which every caller still waiting shares. Null when the router is
 * not fully configured.
 * @public — `fitNow` runs it; exported so tests can fit without its retries
 */
export async function runFit(
  routerId: string,
  trigger?: RoutingPlanTrigger,
): Promise<FitRun | null> {
  let generation: number | undefined;
  for (;;) {
    const running = fitsInFlight.get(routerId);
    if (!running) {
      const flight = prepareAndComplete(routerId, trigger).finally(() =>
        fitsInFlight.delete(routerId),
      );
      fitsInFlight.set(routerId, flight);
      return flight;
    }
    generation ??= (await AutoRouterModel.find(routerId))?.generation ?? 0;
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
 * when the router is not fully configured.
 */
export async function fitNow(
  routerId: string,
  trigger?: RoutingPlanTrigger,
): Promise<{
  fit: AutoRoutingFitResult;
  sessions: FitSessions | null;
} | null> {
  let sessions: FitSessions | null = null;
  try {
    for (let attempt = 0; attempt < INLINE_FIT_ATTEMPTS; attempt++) {
      const run = await runFit(routerId, trigger);
      if (!run) return null;
      sessions = fitSessions(run.inputs);
      if (run.published.kind === "recorded")
        return { fit: fitResult(run.published.plan), sessions };
      if (run.published.reason === "stale_watermark") break;
    }
    // Another fit's outcome stands, so these inputs say nothing about it.
    const latest = await RoutingPlanModel.findLatestOutcome(routerId);
    return {
      fit: latest ? fitResult(latest) : { status: "cold_start", planId: null },
      sessions: null,
    };
  } catch (error) {
    logger.error({ err: error, routerId }, "[AutoRouting] Plan fit threw");
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

type SimulateParams = (
  | { volumeMultiplier: number; expectedTrafficFactor?: undefined }
  | { expectedTrafficFactor: number; volumeMultiplier?: undefined }
) &
  (
    | { budgetUsdPerDay: number; budgetPreset?: undefined }
    | { budgetPreset: AutoRoutingBudgetPreset; budgetUsdPerDay?: undefined }
  );

async function simulate(
  routerId: string,
  params: SimulateParams,
): Promise<AutoRoutingSimulateResponse> {
  const settings = await AutoRouterModel.find(routerId);
  const read =
    settings &&
    (await readFitInputs({
      settings: {
        ...settings,
        enabled: true,
        ...(params.budgetPreset
          ? { budgetPreset: params.budgetPreset }
          : {
              budgetPreset: null,
              budgetUsdPerDay: params.budgetUsdPerDay.toFixed(2),
            }),
        expectedTrafficFactor:
          params.expectedTrafficFactor ?? settings.expectedTrafficFactor,
      },
      scorerVersionId: (await activeSourceVersion(settings.scorerModel)).id,
      requestedTrigger: "manual",
    }));
  if (!read) {
    throw new ApiError(
      400,
      "Configure every tier model before simulating auto routing.",
    );
  }
  // A raw multiplier stands in for the factor the router's settings apply.
  const inputs =
    params.volumeMultiplier === undefined
      ? read
      : {
          ...read,
          history: { ...read.history, volumeFactor: params.volumeMultiplier },
        };
  const { outcome, budgetUsdPerDay } = await fit(inputs);
  switch (outcome.status) {
    case "active":
      if (!outcome.summary) throw new Error("An active fit has no summary");
      if (inputs.tiers.kind !== "ok" || budgetUsdPerDay === null)
        throw new Error("An active fit has unpriced tiers or no budget");
      return {
        status: "feasible",
        budgetUsdPerDay: Number(budgetUsdPerDay),
        summary: outcome.summary,
        tiersFingerprint: inputs.tiers.tiers,
        baseline: dailyVolume(inputs.history.volume),
      };
    case "cold_start":
      return {
        status: "cold_start",
        sessions: inputs.history.sessions,
        required: inputs.history.minSessions,
        pastSessions: inputs.history.pastSessions,
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

/**
 * Why a fit nobody requested runs: what moved since the router's last fit
 * outcome. Past sessions moved when the fit reads a frame and its last
 * recorded outcome, if any, read another; an outcome recorded before fits
 * stored their frame says nothing.
 */
async function scheduledTrigger(params: {
  settings: AutoRouter;
  scorerVersionId: string;
  frameId: string | null;
}): Promise<RoutingPlanTrigger> {
  const { settings, frameId } = params;
  const [[latest], lastOutcome] = await Promise.all([
    RoutingPlanModel.findHistory(settings.id, 1),
    RoutingPlanModel.findLatestOutcome(settings.id),
  ]);
  const latestScorerVersionId = latest?.plan.scorerVersionId ?? null;
  if (
    latestScorerVersionId !== null &&
    latestScorerVersionId !== params.scorerVersionId
  )
    return "scorer_change";
  const unplanned = settings.generation > settings.plannedGeneration;
  const frameMoved =
    frameId !== null &&
    (lastOutcome === null ||
      (lastOutcome.volumeSource !== null &&
        lastOutcome.historyFrameId !== frameId));
  if (unplanned && frameMoved) return "backfill";
  if (unplanned) return "settings";
  return latestScorerVersionId === null ? "initial" : "nightly";
}

async function readFitInputs(params: {
  settings: AutoRouter;
  scorerVersionId: string;
  requestedTrigger?: RoutingPlanTrigger;
  maxSessions?: number;
}): Promise<FitInputs | null> {
  const { settings, scorerVersionId } = params;
  const readiness = await fitReadiness(settings);
  if (readiness.kind !== "ready") return null;
  const tiers = fitTiers(readiness.trio);
  const inputWatermark = new Date();
  const history =
    tiers.kind === "ok"
      ? await readFitHistory(
          {
            router: settings,
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
      settings,
      scorerVersionId,
      frameId: history.frameId,
    }));
  return {
    organizationId: settings.organizationId,
    routerId: settings.id,
    trigger,
    generation: settings.generation,
    inputWatermark,
    tiers,
    budget: readiness.budget,
    scorerVersionId,
    history,
  };
}

const RecordedPastSchema = z.object({
  past_sessions: z.number(),
  tokens: z.number(),
  first_created_at: z.string().nullable(),
  last_created_at: z.string().nullable(),
});

/**
 * Whether `history` replays the past sessions `plan` recorded its fit read:
 * as many and, when they sized the plan, the same volume. The router's own
 * sessions settle usage after the fit, so they are not compared.
 */
export function matchesRecordedHistory(
  plan: RoutingPlan,
  history: FitWindowSummary,
): boolean {
  const recorded = RecordedPastSchema.safeParse(plan.diagnostics?.history);
  if (!recorded.success) return false;
  if (recorded.data.past_sessions !== history.pastSessions) return false;
  switch (history.volumeSource) {
    case "live":
      return true;
    case "history": {
      const { volume } = history;
      return (
        recorded.data.tokens === volume.tokens &&
        recorded.data.first_created_at ===
          (volume.firstCreatedAt?.toISOString() ?? null) &&
        recorded.data.last_created_at ===
          (volume.lastCreatedAt?.toISOString() ?? null)
      );
    }
  }
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
 * The router's live sessions and, for a router that reads them, the
 * organization's scored past sessions, each weighted by how many sessions of
 * its window it stands for. `recorded` replays a plan's read; by default the
 * fit chooses the frame and the volume source.
 */
export async function readFitHistory(
  params: {
    router: FitScope;
    scorerVersionId: string;
    inputWatermark: Date;
    longContextThreshold: number | null;
    recorded?: RecordedPastRead;
  },
  maxSessions?: number,
): Promise<FitHistory> {
  // Past sessions count only for a router short of its own minimum: their
  // sample is read once they do, else the frame's summary is enough.
  const sampled = params.recorded?.countsPastSessions === true;
  const [live, read] = await Promise.all([
    RoutingUsageModel.findFitHistory(
      {
        ...params,
        routerId: params.router.id,
        minSessions: liveMinSessions(),
      },
      maxSessions,
    ),
    readPastSessions(params, sampled),
  ]);
  const summarize = (past: PastSessions) =>
    summarizeWindow(live.volume, past, params.router, params.recorded);
  const counted = summarize(read);
  const past =
    sampled || counted.pastSessions === 0 || read.frame === null
      ? read
      : await readPastSnapshot(params, read.frame, true);
  const window = past === read ? counted : summarize(past);
  // The live sample is capped while its volume counts the whole window.
  const liveWeight =
    live.sample.length === 0 ? 1 : live.volume.sessions / live.sample.length;
  return {
    ...window,
    sample: [
      ...live.sample.map((row) => ({
        ...row,
        weight: liveWeight,
        past: false,
      })),
      ...(window.pastSessions === 0
        ? []
        : past.sample.map((row) => ({ ...row, past: true }))),
    ],
  };
}

/**
 * Which sessions a fit reads, and at what volume: the router's own, plus the
 * organization's past ones when it learns from them.
 */
type FitScope = Pick<
  AutoRouter,
  "id" | "organizationId" | "learnFromPastSessions" | "expectedTrafficFactor"
>;

type PastSessions = PastWindow & {
  frame: ScanFrame | null;
  sample: HistoryFitRow[];
};

type PastReadParams = {
  router: FitScope;
  scorerVersionId: string;
  inputWatermark: Date;
  longContextThreshold: number | null;
  recorded?: RecordedPastRead;
  pastReads?: PastReads;
};

/** `frame`'s past sessions in the window, shared through `pastReads` when the caller passes them. */
async function readPastSnapshot(
  params: PastReadParams,
  frame: ScanFrame,
  withSample: boolean,
): Promise<PastSessions> {
  const windowStart = new Date(params.inputWatermark.getTime() - HISTORY_MS);
  const key = [
    params.scorerVersionId,
    frame.id,
    windowStart.getTime(),
    params.longContextThreshold,
    withSample,
  ].join("|");
  const read =
    params.pastReads?.snapshots.get(key) ??
    RoutingHistoryModel.findFitSnapshot({
      organizationId: params.router.organizationId,
      scorerVersionId: params.scorerVersionId,
      longContextThreshold: params.longContextThreshold,
      frame,
      windowStart,
      withSample,
    });
  params.pastReads?.snapshots.set(key, read);
  return { frame, ...(await read) };
}

/**
 * The organization's past sessions, for a router that learns from them and
 * reads them with the scorer version that scores them. The frame is the one
 * with the most of its sample scored, the newest on a tie, among the latest
 * scan publications and the one the router's active plan read: a newer scan
 * takes over once scored as far, so a rescan never sets a warm router back.
 * A recorded read replays its frame regardless of the router's settings.
 */
async function readPastSessions(
  params: PastReadParams,
  withSample: boolean,
): Promise<PastSessions> {
  const none: PastSessions = {
    frame: null,
    scored: 0,
    population: EMPTY_HISTORY.volume,
    sample: [],
  };
  const { organizationId } = params.router;
  const reads = params.pastReads;
  const windowStart = new Date(params.inputWatermark.getTime() - HISTORY_MS);
  const snapshot = (frame: ScanFrame, sample: boolean) =>
    readPastSnapshot(params, frame, sample);
  if (params.recorded) {
    const { frameId } = params.recorded;
    const frame =
      frameId &&
      (await RoutingBackfillModel.findScanFrame(organizationId, frameId));
    return frame ? snapshot(frame, withSample) : none;
  }
  if (
    !params.router.learnFromPastSessions ||
    params.scorerVersionId !== (await activeSourceVersion()).id
  ) {
    return none;
  }
  const framesKey = `${organizationId}|${windowStart.getTime()}`;
  const latestFrames =
    reads?.frames.get(framesKey) ??
    RoutingBackfillModel.findScanFrames({
      organizationId,
      since: windowStart,
      limit: FIT_FRAME_CANDIDATES,
    });
  reads?.frames.set(framesKey, latestFrames);
  const [latest, incumbent] = await Promise.all([
    latestFrames,
    incumbentFrame(params.router),
  ]);
  const frames = [
    ...latest,
    ...(incumbent && !latest.some((frame) => frame.id === incumbent.id)
      ? [incumbent]
      : []),
  ].toSorted(
    (a, b) =>
      b.scannedAt.getTime() - a.scannedAt.getTime() || b.id.localeCompare(a.id),
  );
  const counted = await Promise.all(
    frames.map(async (frame) => ({
      frame,
      past: await snapshot(frame, false),
    })),
  );
  // Newest first, so a strictly larger prefix is needed to pick an older frame.
  const best = counted
    .filter(({ past }) => past.population.sessions > 0)
    .reduce<(typeof counted)[number] | null>(
      (chosen, candidate) =>
        chosen === null || candidate.past.scored > chosen.past.scored
          ? candidate
          : chosen,
      null,
    );
  if (best === null) return none;
  return withSample ? snapshot(best.frame, true) : best.past;
}

/** The still retained frame the router's active plan was fitted on. */
async function incumbentFrame(router: FitScope): Promise<ScanFrame | null> {
  const frameId = (await RoutingPlanModel.findActive(router.id))
    ?.historyFrameId;
  return frameId
    ? RoutingBackfillModel.findScanFrame(router.organizationId, frameId)
    : null;
}

function summarizeWindow(
  live: FitVolume,
  past: PastSessions,
  router: FitScope,
  recorded?: RecordedPastRead,
): FitWindowSummary {
  const span =
    (live.lastCreatedAt?.getTime() ?? 0) -
    (live.firstCreatedAt?.getTime() ?? 0);
  const volumeSource: RoutingVolumeSource =
    recorded?.volumeSource ??
    (span < LIVE_VOLUME_MIN_SPAN_MS && past.population.sessions > 0
      ? "history"
      : "live");
  const factor = recorded?.volumeFactor ?? router.expectedTrafficFactor;
  const liveMin = liveMinSessions();
  const countsPast =
    recorded?.countsPastSessions ??
    (live.sessions < liveMin && past.scored >= pastSessionsNeeded());
  const pastSessions = countsPast ? past.scored : 0;
  return {
    sessions: live.sessions + pastSessions,
    minSessions: pastSessions === 0 ? liveMin : config.autoRouting.minSessions,
    pastSessions,
    volume: volumeSource === "history" ? past.population : live,
    volumeSource,
    // The one place the factor is chosen: it scales past traffic only.
    volumeFactor: volumeSource === "history" ? factor : 1,
    frameId: past.frame?.id ?? null,
    pastVolume: past.population,
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
  routerId: string,
  trigger?: RoutingPlanTrigger,
): Promise<FitRun | null> {
  const inputs = await prepareFit(routerId, trigger);
  if (!inputs) return null;
  try {
    return { inputs, published: await completeFit(inputs) };
  } catch (error) {
    // Recorded, so the generation it read is planned rather than pending forever.
    logger.error(
      { err: error, routerId },
      "[AutoRouting] Plan fit failed unexpectedly",
    );
    const published = await publish(inputs, {
      coreVersion: coreVersion(),
      planFormatVersion: planFormatVersion(),
      budgetUsdPerDay: customBudget(inputs.budget),
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
  const { history } = inputs;
  return inputs.tiers.kind === "ok"
    ? {
        scorerVersionId: inputs.scorerVersionId,
        sessions: history.sessions,
        minSessions: history.minSessions,
        pastSessions: history.pastSessions,
        volumeSource: history.volumeSource,
        frameId: history.frameId,
        pastVolume: history.pastVolume,
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
        long_context_thresholds: trio.map((model) =>
          ModelModel.getLongContextThreshold(model),
        ),
      },
    };
  }
}

/** `past` when it is one of the organization's past sessions, not the router's own. */
type FitHistoryRow = HistoryFitRow & { past: boolean };
export type FitHistory = FitWindowSummary & { sample: FitHistoryRow[] };

const EMPTY_VOLUME: FitVolume = {
  sessions: 0,
  tokens: 0,
  firstCreatedAt: null,
  lastCreatedAt: null,
};

const EMPTY_HISTORY: FitHistory = {
  sample: [],
  sessions: 0,
  minSessions: 0,
  pastSessions: 0,
  volume: EMPTY_VOLUME,
  volumeSource: "live",
  volumeFactor: 1,
  frameId: null,
  pastVolume: EMPTY_VOLUME,
};

/** Scan publications a fit weighs against each other for the most scored sample. */
const FIT_FRAME_CANDIDATES = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Live auto traffic sizes the plan once its window spans this long. */
const LIVE_VOLUME_MIN_SPAN_MS = 7 * DAY_MS;
/** A router with this many sessions of its own is fitted on them alone. */
const LIVE_FIT_MIN_SESSIONS = 200;

/** Never above the configured minimum, which a deployment may lower. */
function liveMinSessions(): number {
  return Math.min(LIVE_FIT_MIN_SESSIONS, config.autoRouting.minSessions);
}

/**
 * Scored past sessions that start a router sooner than its own would: with
 * fewer, it reaches the minimum only once it has `liveMinSessions()` of its
 * own, which it starts on alone.
 */
export function pastSessionsNeeded(): number {
  return config.autoRouting.minSessions - liveMinSessions() + 1;
}

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

async function fit(inputs: FitInputs): Promise<{
  coreVersion: string;
  planFormatVersion: number;
  /** The budget planned for; a preset's only once a plan resolved it. */
  budgetUsdPerDay: string | null;
  outcome: RoutingFitOutcome;
}> {
  const versions = {
    coreVersion: coreVersion(),
    planFormatVersion: planFormatVersion(),
    budgetUsdPerDay: customBudget(inputs.budget),
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
  const { sessions, minSessions } = inputs.history;
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
    const planAt = routerPlanAt(planInput(inputs.history, tiers, 0));
    const { plan, budgetUsdPerDay } =
      inputs.budget.kind === "usd"
        ? {
            plan: await planAt(Number(inputs.budget.usdPerDay)),
            budgetUsdPerDay: inputs.budget.usdPerDay,
          }
        : await presetPlan(planAt, inputs.budget.preset);
    return {
      coreVersion: plan.versions.core_version,
      planFormatVersion: plan.versions.plan_format_version,
      budgetUsdPerDay,
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
    const log = { routerId: inputs.routerId, ...coded.data };
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

type RouterPlan = z.infer<typeof RouterPlanSchema>;
type PlanAt = (budgetUsdPerDay: number) => Promise<RouterPlan>;

/** Fits `input` at any budget; the history is serialized once for all of them. */
function routerPlanAt(input: ReturnType<typeof planInput>): PlanAt {
  const prefix = JSON.stringify({ ...input, budget: undefined }).slice(0, -1);
  return async (budgetUsdPerDay) =>
    RouterPlanSchema.parse(
      JSON.parse(await fitPlan(`${prefix},"budget":${budgetUsdPerDay}}`)),
    );
}

function customBudget(budget: FitBudget): string | null {
  return budget.kind === "usd" ? budget.usdPerDay : null;
}

const PlanSharesSchema = z
  .object({
    expected_spend: z.number(),
    tier_session_share: z.tuple([z.number(), z.number(), z.number()]),
  })
  .passthrough();

/** Above every daily spend a plan can reach: the most a budget column holds. */
const UNBOUNDED_BUDGET_USD_PER_DAY = 9_999_999_999.99;
/** Shares are compared with this slack so float noise never flips a test. */
const SHARE_TOLERANCE = 1e-9;

/**
 * The daily budget, in whole cents, `preset` resolves to on the fitted usage,
 * and the plan at it. Raising the budget only moves sessions to bigger tiers,
 * so the fast share falls and the smart share grows with it, between the
 * cheapest routing's spend and the best routing's; a bisection finds where
 * each crosses `BUDGET_PRESET_TIER_SHARE`, stopping within 0.5%.
 */
async function presetPlan(
  fitAt: PlanAt,
  preset: AutoRoutingBudgetPreset,
): Promise<{ plan: RouterPlan; budgetUsdPerDay: string }> {
  const plans = new Map<number, Promise<RouterPlan>>();
  const planAt = (cents: number) => {
    let plan = plans.get(cents);
    if (!plan) {
      plan = fitAt(cents / 100);
      plans.set(cents, plan);
    }
    return plan;
  };
  const share = async (cents: number, tier: number) =>
    PlanSharesSchema.parse((await planAt(cents)).summary).tier_session_share[
      tier
    ];
  const best = PlanSharesSchema.parse(
    (await fitAt(UNBOUNDED_BUDGET_USD_PER_DAY)).summary,
  );
  const cheapest = Math.max(1, Math.ceil((await cheapestSpend(fitAt)) * 100));
  const highest = Math.max(cheapest, Math.ceil(best.expected_spend * 100));
  const target = BUDGET_PRESET_TIER_SHARE - SHARE_TOLERANCE;
  const costEfficient = async () =>
    (
      await crossing(
        cheapest,
        highest,
        async (cents) => (await share(cents, 0)) >= target,
      )
    ).lastPassing;
  const intelligence = async () =>
    (
      await crossing(
        cheapest,
        highest,
        async (cents) => (await share(cents, 2)) < target,
      )
    ).firstFailing;
  const cents =
    preset === "cost_efficient"
      ? await costEfficient()
      : preset === "intelligence"
        ? await intelligence()
        : Math.round(((await costEfficient()) + (await intelligence())) / 2);
  return {
    plan: await planAt(cents),
    budgetUsdPerDay: (cents / 100).toFixed(2),
  };
}

/**
 * Where a test that holds up to some budget and fails beyond it flips within
 * [low, high] cents, bracketed to within 0.5%; both ends are `low` when it
 * already fails there and `high` when it still holds there.
 */
async function crossing(
  low: number,
  high: number,
  passes: (cents: number) => Promise<boolean>,
): Promise<{ lastPassing: number; firstFailing: number }> {
  if (!(await passes(low))) return { lastPassing: low, firstFailing: low };
  if (await passes(high)) return { lastPassing: high, firstFailing: high };
  while (high - low > Math.max(1, Math.floor(high / 200))) {
    const middle = Math.floor((low + high) / 2);
    if (await passes(middle)) low = middle;
    else high = middle;
  }
  return { lastPassing: low, firstFailing: high };
}

/** The cheapest routing's USD/day, read from the infeasibility of a zero budget. */
async function cheapestSpend(planAt: PlanAt): Promise<number> {
  try {
    await planAt(0);
    return 0;
  } catch (error) {
    const cheapest = infeasibleError(error);
    if (cheapest === null) throw error;
    return cheapest;
  }
}

function infeasibleError(error: unknown): number | null {
  const coded = CodedErrorSchema.safeParse(error);
  return coded.success
    ? cheapestBudget(`${coded.data.code}: ${coded.data.message}`)
    : null;
}

/**
 * The window's arrival rate: sessions and tokens per day over the span it
 * covers (at least a day, so a burst does not read as an extreme rate).
 */
export function dailyVolume(volume: FitVolume): SimulatedTraffic {
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
 * volume is flat at the whole window's arrival rate times `volumeFactor`.
 */
export function planInput(
  history: Pick<FitHistory, "sample" | "volume" | "volumeFactor">,
  tiers: RouterTierSet,
  budgetUsdPerDay: number,
) {
  const { sample, volume, volumeFactor } = history;
  const { sessionsPerDay, tokensPerDay } = dailyVolume(volume);
  return {
    history: sample.map((row) => ({
      features: routerFeatures(row.features),
      short: tokenCounts(row.short),
      long: tokenCounts(row.long),
      timestamp_ms: row.createdAt.getTime(),
      weight: row.weight,
    })),
    tiers: routerTiers(tiers, sample),
    budget: budgetUsdPerDay,
    volume: {
      kind: "flat",
      sessions_per_day: sessionsPerDay * volumeFactor,
      tokens_per_day: tokensPerDay * volumeFactor,
    },
    baseline_source: mostFrequentSource(sample),
  };
}

/**
 * router-core `TierSet`: it prices four token types, so each block's cache
 * writes cost the 5m and 1h rates blended by the sample's 1h share of them.
 * That is exact, since router-core prices a block by one token mix. Like
 * router-core, a block without writes takes the other block's, and a tier
 * without long prices bills long requests at its short ones.
 */
function routerTiers(tiers: RouterTierSet, sample: FitHistoryRow[]) {
  const share1h = (block: "short" | "long") => {
    let writes = 0;
    let writes1h = 0;
    for (const row of sample) {
      writes += row.weight * row[block].cacheWrite;
      writes1h += row.weight * row[block].cacheWrite1h;
    }
    return writes > 0 ? Math.min(writes1h / writes, 1) : null;
  };
  const short = share1h("short");
  const long = share1h("long");
  const blend = (usd: RouterTokenPrices, share: number) => ({
    input: usd.input,
    cache_read: usd.cache_read,
    cache_write: (1 - share) * usd.cache_write + share * usd.cache_write_1h,
    output: usd.output,
  });
  return {
    tiers: tiers.tiers.map((tier) => ({
      model_id: tier.model_id,
      short: blend(tier.short, short ?? long ?? 0),
      long:
        tiers.long_context_threshold === null
          ? null
          : blend(tier.long ?? tier.short, long ?? short ?? 0),
    })),
    long_context_threshold: tiers.long_context_threshold,
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
