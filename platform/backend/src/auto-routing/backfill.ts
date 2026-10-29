import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AUTO_ROUTING_BACKFILL_SCORER_CALLS,
  isLogContentNotStored,
} from "@archestra/shared";
import { Semaphore } from "@/agents/chatops/utils";
import config from "@/config";
import { withDbTransaction } from "@/database";
import logger from "@/logging";
import AutoRoutingDispatchModel from "@/models/auto-routing-dispatch";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import { isSessionMainTurn } from "@/models/interaction";
import RoutingBackfillModel, {
  type BackfillLease,
} from "@/models/routing-backfill";
import RoutingHistoryModel, {
  type OpeningRow,
  type SampleProgress,
} from "@/models/routing-history";
import { HISTORY_MS } from "@/models/routing-usage";
import { ApiError } from "@/types";
import type {
  AutoRoutingSettings,
  RoutingBackfill,
  RoutingHistorySession,
} from "@/types/auto-routing";
import type {
  AutoRoutingBackfillResponse,
  AutoRoutingScoreBackfillBody,
} from "@/types/auto-routing-api";
import { firstUserText } from "./first-user-text";
import { fitReadiness } from "./fit";
import { activeSourceVersion, decisionFeatures, preRunSource } from "./signals";
import { type JevSessionReading, scorerState } from "./signals/jev-session";
import { SignalSourceError } from "./signals/types";

/**
 * The least one scorer call reserves of the ceiling; calls reserve the most
 * any call has cost once that is higher, and cost their reservation when Jev
 * reports no cost.
 */
const SCORER_CALL_RESERVATION_USD = 0.001;
const DEFAULT_BACKFILL_SESSIONS = 3000;

/**
 * Starts a free scan of the organization's past interactions, retiring a
 * scan that still waits to be scored. Refused while a backfill runs.
 */
export async function startBackfillScan(
  organizationId: string,
  startedBy: string | null,
): Promise<RoutingBackfill> {
  const cutoff = new Date();
  const backfill = await withDbTransaction(async (tx) => {
    await RoutingBackfillModel.supersedeWaiting(organizationId, tx);
    return RoutingBackfillModel.createScan(
      {
        organizationId,
        cutoff,
        windowStart: new Date(cutoff.getTime() - HISTORY_MS),
        startedBy,
      },
      tx,
    );
  });
  if (!backfill) throw new ApiError(409, BUSY_MESSAGE);
  await enqueueRun();
  return backfill;
}

/** Scans once on the first enable; later scans are an admin's call. */
export async function scanOnFirstEnable(organizationId: string) {
  if (await RoutingBackfillModel.findLatest(organizationId)) return;
  await startBackfillScan(organizationId, null).catch((error: unknown) => {
    if (error instanceof ApiError && error.statusCode === 409) return;
    throw error;
  });
}

/**
 * Starts scoring the deterministic sample of the scan the admin was offered,
 * with the scorer version they were offered: in place when the scan waits for
 * it, else as a new backfill over its stored sessions (a re-score after a
 * scorer change). Refused when either is no longer what an offer would name.
 */
export async function startBackfillScoring(
  organizationId: string,
  startedBy: string | null,
  body: AutoRoutingScoreBackfillBody,
): Promise<RoutingBackfill> {
  if ((await activeSourceVersion()).id !== body.scorerVersionId) {
    throw new ApiError(409, STALE_OFFER_MESSAGE);
  }
  if ((await scorerState(organizationId)) === "no_jev_key") {
    throw new ApiError(400, NO_JEV_KEY_MESSAGE);
  }
  const params = {
    organizationId,
    scorerVersionId: body.scorerVersionId,
    maxSessions: body.maxSessions,
    maxCostUsd: body.maxCostUsd,
    startedBy,
  };
  const latest = await RoutingBackfillModel.findLatest(organizationId);
  if (latest?.status === "running") throw new ApiError(409, BUSY_MESSAGE);
  const started =
    latest?.status === "scanned"
      ? await RoutingBackfillModel.startScore({
          id: body.backfillId,
          ...params,
        })
      : await withDbTransaction((tx) =>
          RoutingBackfillModel.createRescore(
            { scanId: body.backfillId, ...params },
            tx,
          ),
        );
  if (!started) throw new ApiError(409, STALE_OFFER_MESSAGE);
  await enqueueRun();
  return started;
}

/** Cancels the active backfill; scores already committed stay. */
export async function cancelBackfill(organizationId: string): Promise<void> {
  const cancelled = await RoutingBackfillModel.cancel(organizationId);
  if (!cancelled) throw new ApiError(404, "No backfill is running");
  if (cancelled.scannedAt === null) {
    await RoutingHistoryModel.deleteBackfillSessions(cancelled.id);
  }
}

export async function describeBackfill(
  organizationId: string,
): Promise<AutoRoutingBackfillResponse> {
  const [latest, scan, scorer, settings] = await Promise.all([
    RoutingBackfillModel.findLatest(organizationId),
    RoutingBackfillModel.findLatestScanned(organizationId),
    activeSourceVersion(),
    AutoRoutingSettingsModel.find(organizationId),
  ]);
  const offerable = latest?.status === "running" ? null : scan;
  const scanned = offerable && (await scanSample(offerable, scorer.id));
  const progress =
    latest?.phase === "score"
      ? await scoringProgress(latest)
      : latest?.id === offerable?.id
        ? (scanned?.progress ?? null)
        : null;
  return {
    backfill: latest && {
      id: latest.id,
      status: latest.status,
      phase: latest.phase,
      windowStart: latest.windowStart,
      cutoff: latest.cutoff,
      eligibleSessions: latest.populationSessions,
      eligibleTokens: latest.populationTokens,
      breakdown: latest.breakdown,
      scorerCurrent: latest.scorerVersionId
        ? latest.scorerVersionId === scorer.id
        : null,
      maxSessions: latest.maxSessions,
      maxCostUsd: latest.maxCostUsd === null ? null : Number(latest.maxCostUsd),
      spentCostUsd: Number(latest.spentCostUsd),
      progress,
      error: latest.error,
      completedAt: latest.completedAt,
      ...(await fitState(latest, settings)),
    },
    scoreOffer:
      offerable && scanned
        ? scoreOffer({
            scan: offerable,
            scorerVersionId: scorer.id,
            scanned,
            latest,
          })
        : null,
  };
}

/**
 * Claims one running backfill and works it for up to the time budget. One
 * left unfinished releases its lease and queues the next run.
 */
export async function runBackfill(params?: {
  timeBudgetMs?: number;
}): Promise<void> {
  if (!config.autoRouting.enabled) return;
  const backfill = await RoutingBackfillModel.claimNext({
    owner: WORKER_ID,
    leaseTtlSeconds: LEASE_TTL_SECONDS,
  });
  if (!backfill) return;
  const lease = { id: backfill.id, epoch: backfill.leaseEpoch };
  const deadline = Date.now() + (params?.timeBudgetMs ?? RUN_TIME_BUDGET_MS);
  try {
    const finished =
      backfill.phase === "scan"
        ? await scan(backfill, lease, deadline)
        : await score(backfill, lease, deadline);
    if (!finished && (await RoutingBackfillModel.release(lease))) {
      await enqueueRun();
    }
  } catch (error) {
    logger.warn(
      { err: error, backfillId: backfill.id },
      "[AutoRouting] Backfill run failed; it resumes from its last commit",
    );
    const failed = await RoutingBackfillModel.recordFailure({
      lease,
      error: error instanceof Error ? error.message : String(error),
      maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    });
    if (failed && backfill.scannedAt === null) {
      await RoutingHistoryModel.deleteBackfillSessions(backfill.id);
    }
  }
}

// === Internal ===

const BUSY_MESSAGE =
  "A backfill is already running for this organization; wait for it or cancel it.";
const NO_JEV_KEY_MESSAGE =
  "No Jev API key is configured for this organization; add one on the Model Providers page before scoring.";
const STALE_OFFER_MESSAGE =
  "The past sessions or the session scorer changed since this offer was shown; review the new offer.";
const WORKER_ID = `${hostname()}#${process.pid}`;
const RUN_TIME_BUDGET_MS = 45_000;
const LEASE_TTL_SECONDS = 120;
const MAX_CONSECUTIVE_FAILURES = 10;
const SCAN_BATCH_SIZE = 1_000;
/** Rest this many times a scan batch's duration after it, so the scan reads a fraction of the time. */
const SCAN_THROTTLE_RATIO = 4;
/** Sessions taken per scoring round; the semaphore bounds the calls in flight. */
const SCORE_BATCH_SIZE = 8;
const SCORER_TIMEOUT_MS = 10_000;
/** Scorer calls in flight across every backfill of this process. */
const scorerCalls = new Semaphore(AUTO_ROUTING_BACKFILL_SCORER_CALLS);
/** Calls a backfill may make per sampled session, retries of failed calls included. */
const ATTEMPTS_PER_SESSION = 1.2;

async function enqueueRun(): Promise<void> {
  try {
    await AutoRoutingDispatchModel.enqueueBackfillRun();
  } catch (error) {
    logger.warn(
      { err: error },
      "[AutoRouting] Could not enqueue a backfill run; the dispatcher resumes it",
    );
  }
}

function sampleOf(backfill: RoutingBackfill, maxSessions: number) {
  return {
    organizationId: backfill.organizationId,
    windowStart: backfill.windowStart,
    cutoff: backfill.cutoff,
    maxSessions,
  };
}

/** How much of a scoring run's own sample its scorer has read. */
async function scoringProgress(
  backfill: RoutingBackfill,
): Promise<SampleProgress | null> {
  if (!backfill.scorerVersionId || !backfill.maxSessions) return null;
  return RoutingHistoryModel.sampleProgress({
    ...sampleOf(backfill, backfill.maxSessions),
    scorerVersionId: backfill.scorerVersionId,
  });
}

/** The sample a score of `scan` would take, and how much of it `scorerVersionId` already read. */
async function scanSample(scan: RoutingBackfill, scorerVersionId: string) {
  const sessions = Math.min(scan.populationSessions, DEFAULT_BACKFILL_SESSIONS);
  return {
    sessions,
    progress: await RoutingHistoryModel.sampleProgress({
      ...sampleOf(scan, sessions),
      scorerVersionId,
    }),
  };
}

function scoreOffer(params: {
  scan: RoutingBackfill;
  scorerVersionId: string;
  scanned: { sessions: number; progress: SampleProgress };
  latest: RoutingBackfill | null;
}): AutoRoutingBackfillResponse["scoreOffer"] {
  const { scan, scorerVersionId, latest } = params;
  const { sessions, progress: done } = params.scanned;
  const remaining = sessions - attempted(done);
  if (remaining <= 0) return null;
  const estimatedCostUsd = remaining * SCORER_CALL_RESERVATION_USD;
  return {
    backfillId: scan.id,
    scorerVersionId,
    windowStart: scan.windowStart,
    cutoff: scan.cutoff,
    sessions,
    remaining,
    estimatedCostUsd,
    suggestedMaxCostUsd: Math.max(1, Math.ceil(estimatedCostUsd * 125) / 100),
    rescore:
      latest?.phase === "score" && latest.scorerVersionId !== scorerVersionId,
  };
}

/** Whether the fit the backfill's completion requested is still to come, or why it will not run. */
async function fitState(
  backfill: RoutingBackfill,
  settings: AutoRoutingSettings | null,
): Promise<{ awaitingFit: boolean; fitBlockedReason: string | null }> {
  if (
    backfill.fitGeneration === null ||
    settings === null ||
    settings.plannedGeneration >= backfill.fitGeneration
  ) {
    return { awaitingFit: false, fitBlockedReason: null };
  }
  const readiness = await fitReadiness(settings);
  switch (readiness.kind) {
    case "ready":
      return { awaitingFit: true, fitBlockedReason: null };
    case "blocked":
      return { awaitingFit: false, fitBlockedReason: readiness.reason };
  }
}

function attempted(progress: SampleProgress): number {
  return progress.scored + progress.noText + progress.failed;
}

/** Returns true once the scan finished (or the lease was lost); false when the time budget ran out. */
async function scan(
  backfill: RoutingBackfill,
  lease: BackfillLease,
  deadline: number,
): Promise<boolean> {
  const profiles = await RoutingHistoryModel.profileIds(backfill);
  const resumeAt = backfill.cursorProfileId;
  let batches = 0;
  for (const profileId of profiles) {
    if (resumeAt && profileId < resumeAt) continue;
    let after =
      profileId === resumeAt && backfill.cursorCreatedAt && backfill.cursorId
        ? { createdAt: backfill.cursorCreatedAt, id: backfill.cursorId }
        : null;
    for (;;) {
      // At least one batch per claim, so every run makes progress.
      if (batches++ > 0 && Date.now() >= deadline) return false;
      const started = Date.now();
      const rows = await RoutingHistoryModel.readScanBatch({
        profileId,
        windowStart: backfill.windowStart,
        cutoff: backfill.cutoff,
        after,
        limit: SCAN_BATCH_SIZE,
      });
      if (rows.length === 0) break;
      const last = rows[rows.length - 1];
      const cursor = { createdAt: last.createdAtText, id: last.id };
      const owned = await withDbTransaction(async (tx) => {
        if (!(await RoutingBackfillModel.lockOwned(lease, tx))) return false;
        await RoutingHistoryModel.upsertSessions(
          {
            organizationId: backfill.organizationId,
            backfillId: backfill.id,
            rows,
          },
          tx,
        );
        await RoutingBackfillModel.advanceScan(
          {
            lease,
            cursor: { profileId, ...cursor },
            leaseTtlSeconds: LEASE_TTL_SECONDS,
          },
          tx,
        );
        return true;
      });
      if (!owned) return true;
      after = cursor;
      if (rows.length < SCAN_BATCH_SIZE) break;
      // Reading in proportion to how long the batch took keeps the scan a
      // fraction of the database's time, and backs off when it is busy.
      const pause = (Date.now() - started) * SCAN_THROTTLE_RATIO;
      if (Date.now() + pause >= deadline) return false;
      await sleep(pause);
    }
  }
  await withDbTransaction(async (tx) => {
    if (!(await RoutingBackfillModel.lockOwned(lease, tx))) return;
    const population = await RoutingHistoryModel.finishScan(backfill, tx);
    await RoutingBackfillModel.finishScan({ lease, population }, tx);
  });
  logger.info(
    { backfillId: backfill.id, organizationId: backfill.organizationId },
    "[AutoRouting] Backfill scan finished",
  );
  return true;
}

type ScoreOutcome =
  | "continue"
  /** Cancelled, superseded or reclaimed by another worker. */
  | "lost"
  | "ceiling"
  | "attempts"
  | "no_credentials";

/** Why a run stops early, in the order they are reported. */
const STOP_MESSAGES = {
  lost: null,
  no_credentials: "No Jev API key is configured for the organization.",
  ceiling: "Stopped at the spending limit.",
  attempts: "Stopped after too many failed scorer calls.",
} as const satisfies Record<Exclude<ScoreOutcome, "continue">, string | null>;

async function score(
  backfill: RoutingBackfill,
  lease: BackfillLease,
  deadline: number,
): Promise<boolean> {
  const { scorerVersionId, maxSessions } = backfill;
  if (!scorerVersionId || !maxSessions) {
    throw new Error(`Backfill ${backfill.id} is scoring without a sample`);
  }
  const maxAttempts = Math.ceil(maxSessions * ATTEMPTS_PER_SESSION);
  // At least one round per claim, so every run makes progress.
  do {
    if ((await activeSourceVersion()).id !== scorerVersionId) {
      await RoutingBackfillModel.finish(lease, { status: "superseded" });
      return true;
    }
    const batch = await RoutingHistoryModel.nextToScore({
      ...sampleOf(backfill, maxSessions),
      scorerVersionId,
      limit: SCORE_BATCH_SIZE,
    });
    if (batch.length === 0) {
      await complete(backfill, lease);
      return true;
    }
    // Settled, not raced: a failure surfaces only once every call of the
    // round has been accounted for.
    const settled = await Promise.allSettled(
      batch.map((session) =>
        scoreSession({
          backfill,
          lease,
          scorerVersionId,
          maxAttempts,
          session,
        }),
      ),
    );
    const failure = settled.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    const outcomes = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    // The round's other calls committed first, so a stop keeps what they scored.
    const stop = (
      Object.keys(STOP_MESSAGES) as (keyof typeof STOP_MESSAGES)[]
    ).find((outcome) => outcomes.includes(outcome));
    switch (stop) {
      case undefined:
        break;
      case "lost":
        return true;
      case "no_credentials":
        await RoutingBackfillModel.finish(lease, {
          status: "failed",
          error: STOP_MESSAGES[stop],
        });
        return true;
      case "ceiling":
      case "attempts":
        await complete(backfill, lease, STOP_MESSAGES[stop]);
        return true;
    }
    await RoutingBackfillModel.renew(lease, LEASE_TTL_SECONDS);
  } while (Date.now() < deadline);
  return false;
}

/**
 * Done, possibly stopped short (`error`), in one commit with the generation
 * bump that makes the next fit read the new history and keeps a fit already
 * running from standing in for it. The dispatcher fits any generation above
 * the planned one, so the enqueue here only saves its wait.
 */
async function complete(
  backfill: RoutingBackfill,
  lease: BackfillLease,
  error?: string,
) {
  const finished = await withDbTransaction(async (tx) => {
    if (!(await RoutingBackfillModel.lockOwned(lease, tx))) return false;
    if (backfill.scorerVersionId) {
      await RoutingHistoryModel.failExhausted(
        {
          organizationId: backfill.organizationId,
          scorerVersionId: backfill.scorerVersionId,
        },
        tx,
      );
    }
    const fitGeneration = await AutoRoutingSettingsModel.bumpGeneration(
      backfill.organizationId,
      tx,
    );
    return RoutingBackfillModel.finish(
      lease,
      { status: "done", error, fitGeneration },
      tx,
    );
  });
  if (!finished) return;
  await AutoRoutingDispatchModel.enqueueFits([backfill.organizationId]).catch(
    (enqueueError: unknown) =>
      logger.warn(
        { err: enqueueError, backfillId: backfill.id },
        "[AutoRouting] Could not enqueue the fit after a backfill; the dispatcher runs it",
      ),
  );
  logger.info(
    { backfillId: backfill.id, organizationId: backfill.organizationId },
    "[AutoRouting] Backfill scoring finished",
  );
}

async function scoreSession(params: {
  backfill: RoutingBackfill;
  lease: BackfillLease;
  scorerVersionId: string;
  maxAttempts: number;
  session: RoutingHistorySession;
}): Promise<ScoreOutcome> {
  const { backfill, lease, scorerVersionId, session } = params;
  const text = openingText(await findOpening(session));
  if (text === null) {
    await withDbTransaction(async (tx) => {
      if (!(await RoutingBackfillModel.lockOwned(lease, tx))) return;
      await RoutingHistoryModel.recordScore(
        {
          historySessionId: session.id,
          scorerVersionId,
          status: "no_text",
          features: null,
          scorerCost: null,
        },
        tx,
      );
    });
    return "continue";
  }
  // Copied before the paid call, so all a reading needs afterwards is the
  // short commit that settles the call.
  await RoutingHistoryModel.copyUsage(session);

  const input = { firstUserText: text, client: session.client };
  // Reserved once a call slot is free, so a backfill cancelled meanwhile
  // makes no further calls.
  await scorerCalls.acquire();
  let reading: Reading;
  let stored: boolean;
  try {
    const key = { historySessionId: session.id, scorerVersionId };
    // The session's attempt is counted with the reservation, so however the
    // reading's commit fails the session is paid a bounded number of times.
    const reservation = await withDbTransaction(async (tx) => {
      const reserved = await RoutingBackfillModel.reserve(
        {
          lease,
          minAmount: SCORER_CALL_RESERVATION_USD,
          maxAttempts: params.maxAttempts,
        },
        tx,
      );
      if (
        reserved.kind === "reserved" &&
        !(await RoutingHistoryModel.takeAttempt(key, tx))
      ) {
        throw new Error(`History session ${session.id} has no attempt left`);
      }
      return reserved;
    });
    if (reservation.kind !== "reserved") return reservation.kind;
    let reserved = reservation.amount;
    reading = await preRunSource
      .read(input, {
        organizationId: backfill.organizationId,
        timeoutMs: SCORER_TIMEOUT_MS,
      })
      .then(
        (value): Reading => ({ kind: "read", value }),
        (error: unknown): Reading =>
          error instanceof SignalSourceError
            ? { kind: "error", error }
            : { kind: "unexpected", error },
      );
    const spent = ((): number => {
      switch (reading.kind) {
        case "read":
          return reading.value.costUsd ?? reserved;
        case "error":
          // No key: nothing was sent.
          return reading.error.reason === "no_credentials" ? 0 : reserved;
        case "unexpected":
          return reserved;
      }
    })();
    if (spent > reserved) {
      await RoutingBackfillModel.raiseReservation({
        lease,
        by: spent - reserved,
      });
      reserved = spent;
    }
    // One commit: if it fails, the next claim books the reservation as spent.
    stored = await withDbTransaction(async (tx) => {
      await RoutingBackfillModel.settle({ lease, reserved, spent }, tx);
      if (!(await RoutingBackfillModel.lockOwned(lease, tx))) return false;
      if (
        reading.kind === "error" &&
        reading.error.reason === "no_credentials"
      ) {
        await RoutingHistoryModel.refundAttempt(key, tx);
      }
      const status = readingStatus(reading);
      if (status) {
        await RoutingHistoryModel.recordScore(
          {
            ...key,
            status,
            features:
              reading.kind === "read"
                ? decisionFeatures({
                    version: scorerVersionId,
                    reading: reading.value,
                    input,
                  })
                : null,
            scorerCost: reading.kind === "read" ? reading.value.costUsd : null,
          },
          tx,
        );
      }
      return true;
    });
  } finally {
    // Released only once the call is settled, so the calls in flight are
    // the only spend the ceiling has not seen.
    scorerCalls.release();
  }
  switch (reading.kind) {
    case "unexpected":
      throw reading.error;
    case "error":
      logger.warn(
        {
          backfillId: backfill.id,
          reason: reading.error.reason,
          status: reading.error.status,
        },
        "[AutoRouting] Backfill scorer call failed",
      );
      if (reading.error.reason === "no_credentials") return "no_credentials";
  }
  return stored ? "continue" : "lost";
}

/** What a reading stores; null leaves the session to be read again. */
function readingStatus(reading: Reading): "scored" | "failed" | null {
  switch (reading.kind) {
    case "read":
      return "scored";
    case "error":
      return reading.error.reason === "invalid_response" ? "failed" : null;
    case "unexpected":
      return null;
  }
}

/**
 * The session's opening: its first main turn, as the sessions list picks
 * one, read page by page until found or the session ends. A slow page fails
 * the run, which retries the session.
 */
async function findOpening(
  session: RoutingHistorySession,
): Promise<OpeningRow | null> {
  let after: OpeningRow | null = null;
  for (;;) {
    const page = await RoutingHistoryModel.openingRows(session, after);
    const opening = page.rows.find((row) => isSessionMainTurn(row));
    if (opening) return opening;
    if (page.last) return null;
    after = page.rows[page.rows.length - 1];
  }
}

type Reading =
  | { kind: "read"; value: JevSessionReading }
  | { kind: "error"; error: SignalSourceError }
  | { kind: "unexpected"; error: unknown };

/**
 * The text of the session's opening, decoded by its own request shape. Null
 * when there is none or the server cannot read it — its content was withheld
 * or is end-to-end encrypted, or the row stores only the suffix of a
 * conversation that started earlier.
 */
function openingText(opening: OpeningRow | null): string | null {
  if (
    !opening ||
    opening.encrypted ||
    opening.parentId !== null ||
    isLogContentNotStored(opening.request)
  ) {
    return null;
  }
  return firstUserText(
    opening.apiShape === "responses" ? "responses" : "chat_completions",
    opening.request,
  );
}
