import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { isLogContentNotStored } from "@archestra/shared";
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
  RoutingBackfill,
  RoutingHistorySession,
} from "@/types/auto-routing";
import type {
  AutoRoutingBackfillResponse,
  AutoRoutingScoreBackfillBody,
} from "@/types/auto-routing-api";
import { firstUserText } from "./first-user-text";
import { activeSourceVersion, decisionFeatures, preRunSource } from "./signals";
import type { JevSessionReading } from "./signals/jev-session";
import { SignalSourceError } from "./signals/types";

/** What one scorer call reserves of the ceiling, and costs when Jev reports no cost. */
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
 * Starts scoring the deterministic sample of the latest scan with the
 * running scorer version: in place when the scan waits for it, else as a new
 * backfill over the stored sessions (a re-score after a scorer change).
 */
export async function startBackfillScoring(
  organizationId: string,
  startedBy: string | null,
  body: AutoRoutingScoreBackfillBody,
): Promise<RoutingBackfill> {
  const scorerVersionId = (await activeSourceVersion()).id;
  const params = {
    scorerVersionId,
    maxSessions: body.maxSessions,
    maxCostUsd: body.maxCostUsd,
    startedBy,
  };
  const latest = await RoutingBackfillModel.findLatest(organizationId);
  if (latest?.status === "running") throw new ApiError(409, BUSY_MESSAGE);
  const started =
    latest?.status === "scanned"
      ? await RoutingBackfillModel.startScore({ id: latest.id, ...params })
      : await rescore(organizationId, params);
  if (!started) throw new ApiError(409, BUSY_MESSAGE);
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
  const [latest, scan, scorer] = await Promise.all([
    RoutingBackfillModel.findLatest(organizationId),
    RoutingBackfillModel.findLatestScanned(organizationId),
    activeSourceVersion(),
  ]);
  const progress =
    latest?.phase === "score" && latest.scorerVersionId && latest.maxSessions
      ? await RoutingHistoryModel.sampleProgress({
          ...sampleOf(latest, latest.maxSessions),
          scorerVersionId: latest.scorerVersionId,
        })
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
    },
    scoreOffer:
      latest?.status === "running" || !scan
        ? null
        : await scoreOffer(scan, scorer.id, latest),
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
const scorerCalls = new Semaphore(4);
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

async function rescore(
  organizationId: string,
  params: {
    scorerVersionId: string;
    maxSessions: number;
    maxCostUsd: number;
    startedBy: string | null;
  },
): Promise<RoutingBackfill | null> {
  const scan = await RoutingBackfillModel.findLatestScanned(organizationId);
  if (!scan) {
    throw new ApiError(409, "Find past sessions before scoring them.");
  }
  return withDbTransaction((tx) =>
    RoutingBackfillModel.createRescore({ scan, ...params }, tx),
  );
}

function sampleOf(backfill: RoutingBackfill, maxSessions: number) {
  return {
    organizationId: backfill.organizationId,
    windowStart: backfill.windowStart,
    cutoff: backfill.cutoff,
    maxSessions,
  };
}

async function scoreOffer(
  scan: RoutingBackfill,
  scorerVersionId: string,
  latest: RoutingBackfill | null,
): Promise<AutoRoutingBackfillResponse["scoreOffer"]> {
  const sessions = Math.min(scan.populationSessions, DEFAULT_BACKFILL_SESSIONS);
  const done = await RoutingHistoryModel.sampleProgress({
    ...sampleOf(scan, sessions),
    scorerVersionId,
  });
  const remaining = sessions - attempted(done);
  if (remaining <= 0) return null;
  const estimatedCostUsd = remaining * SCORER_CALL_RESERVATION_USD;
  return {
    sessions,
    remaining,
    estimatedCostUsd,
    suggestedMaxCostUsd: Math.max(1, Math.ceil(estimatedCostUsd * 125) / 100),
    rescore:
      latest?.phase === "score" && latest.scorerVersionId !== scorerVersionId,
  };
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
  const profiles = await RoutingHistoryModel.profileIds(
    backfill.organizationId,
  );
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
  ceiling: "Stopped at the cost ceiling.",
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
    const outcomes = await Promise.all(
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
 * Done, possibly stopped short (`error`). The generation bump makes the next
 * fit read the new history, and keeps a fit already running from standing in
 * for it.
 */
async function complete(
  backfill: RoutingBackfill,
  lease: BackfillLease,
  error?: string,
) {
  if (!(await RoutingBackfillModel.finish(lease, { status: "done", error })))
    return;
  await AutoRoutingSettingsModel.update(backfill.organizationId, {});
  await AutoRoutingDispatchModel.enqueueFits([backfill.organizationId]);
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
  const text = openingText(
    session,
    await RoutingHistoryModel.openingRows(session),
  );
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

  const input = { firstUserText: text, client: session.client };
  // Reserved once a call slot is free, so a backfill cancelled meanwhile
  // makes no further calls.
  await scorerCalls.acquire();
  let reading: Reading;
  try {
    const reserved = await RoutingBackfillModel.reserve({
      lease,
      amount: SCORER_CALL_RESERVATION_USD,
      maxAttempts: params.maxAttempts,
    });
    if (reserved !== "reserved") return reserved;
    reading = await preRunSource
      .read(input, {
        organizationId: backfill.organizationId,
        timeoutMs: SCORER_TIMEOUT_MS,
      })
      .then(
        (value) => ({ kind: "read" as const, value }),
        (error: unknown) => {
          if (!(error instanceof SignalSourceError)) throw error;
          return { kind: "error" as const, error };
        },
      );
  } finally {
    scorerCalls.release();
  }

  const spent = ((): number => {
    switch (reading.kind) {
      case "read":
        return reading.value.costUsd ?? SCORER_CALL_RESERVATION_USD;
      case "error":
        // No key: nothing was sent.
        return reading.error.reason === "no_credentials"
          ? 0
          : SCORER_CALL_RESERVATION_USD;
    }
  })();
  const settle = {
    id: backfill.id,
    reserved: SCORER_CALL_RESERVATION_USD,
    spent,
  };
  const stored = await withDbTransaction(async (tx) => {
    await RoutingBackfillModel.settle(settle, tx);
    if (!(await RoutingBackfillModel.lockOwned(lease, tx))) return false;
    if (reading.kind === "read") {
      await RoutingHistoryModel.copyUsage(session, tx);
      await RoutingHistoryModel.recordScore(
        {
          historySessionId: session.id,
          scorerVersionId,
          status: "scored",
          features: decisionFeatures({
            version: scorerVersionId,
            reading: reading.value,
            input,
          }),
          scorerCost: reading.value.costUsd,
        },
        tx,
      );
    } else if (reading.error.reason === "invalid_response") {
      await RoutingHistoryModel.recordScore(
        {
          historySessionId: session.id,
          scorerVersionId,
          status: "failed",
          features: null,
          scorerCost: null,
        },
        tx,
      );
    }
    return true;
  });
  if (!stored) return "lost";
  if (reading.kind === "error") {
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
  return "continue";
}

type Reading =
  | { kind: "read"; value: JevSessionReading }
  | { kind: "error"; error: SignalSourceError };

/**
 * The text of the session's opening: its first main turn, as the sessions
 * list picks one. Null when that turn has nothing the server can read — its
 * content was withheld or is end-to-end encrypted, or the row stores only
 * the suffix of a conversation that started earlier.
 */
function openingText(
  session: RoutingHistorySession,
  rows: OpeningRow[],
): string | null {
  const opening = rows.find((row) => isSessionMainTurn(row));
  if (
    !opening ||
    opening.encrypted ||
    opening.parentId !== null ||
    isLogContentNotStored(opening.request)
  ) {
    return null;
  }
  return firstUserText(
    session.apiShape === "responses" ? "responses" : "chat_completions",
    opening.request,
  );
}
