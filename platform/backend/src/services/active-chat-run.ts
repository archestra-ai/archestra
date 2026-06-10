import type { UIMessageChunk } from "ai";
import config from "@/config";
import logger from "@/logging";
import ActiveChatRunModel from "@/models/chat-active-run";
import {
  type ActiveChatRunNotifier,
  createActiveChatRunNotifier,
} from "@/services/active-chat-run-notifier";
import type { ChatActiveRunStatus } from "@/types/chat-active-run";

const EVENT_FLUSH_INTERVAL_MS = 500;
const EVENT_BATCH_SIZE = 256;
const RUN_TOUCH_INTERVAL_MS = 30 * 1000;
const STALE_RUNNING_MS = 10 * 60 * 1000;
const TERMINAL_CLEANUP_INTERVAL_MS = 60 * 1000;
const ACTIVE_CHAT_RUN_TERMINAL_RETENTION_MS = 60 * 60 * 1000;
export const ACTIVE_CHAT_RUN_TERMINAL_REPLAY_GRACE_MS = 2 * 60 * 1000;

/**
 * @public - exported for testability
 */
export class ActiveChatRunService {
  private nextTerminalCleanupAt = 0;
  // Run ids this process created and believes may still be 'running'. Used to
  // fail only this pod's runs on graceful shutdown (no schema-level pod id).
  private readonly inFlightRunIds = new Set<string>();
  private isShuttingDown = false;

  constructor(
    private readonly notifier: ActiveChatRunNotifier,
    private readonly replayPollIntervalMs: number,
    private readonly stopPollIntervalMs: number,
  ) {}

  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  async createRun(params: {
    conversationId: string;
    userId: string;
    organizationId: string;
  }) {
    // Refuse new runs once shutdown started, so nothing is created after
    // failInFlightRuns() has already snapshotted this pod's runs to fail.
    if (this.isShuttingDown) {
      return null;
    }

    this.cleanupTerminalRunsIfNeeded(params.conversationId);

    const run = await ActiveChatRunModel.create(params);
    if (run) {
      return this.registerCreatedRun(run);
    }

    try {
      await ActiveChatRunModel.markStaleRunningAsFailed(STALE_RUNNING_MS);
    } catch (error) {
      logger.warn(
        { error, conversationId: params.conversationId },
        "Failed to mark stale active chat runs as failed",
      );
    }

    const retriedRun = await ActiveChatRunModel.create(params);
    return retriedRun ? this.registerCreatedRun(retriedRun) : null;
  }

  beginShutdown(): void {
    this.isShuttingDown = true;
  }

  // Single terminal-transition entry point so the in-flight set stays bounded.
  // Removes from the set only after the DB write resolves: if it throws, the id
  // is retained so failInFlightRuns()/the reaper still fail the run later.
  async markTerminal(params: {
    runId: string;
    status: Exclude<ChatActiveRunStatus, "running">;
    error?: string | null;
  }): Promise<void> {
    await ActiveChatRunModel.markTerminal(params);
    this.inFlightRunIds.delete(params.runId);
  }

  // Periodic safety net for runs orphaned by a hard kill (OOM/SIGKILL) that
  // never reached graceful shutdown. Graceful shutdown handles the common case.
  // Intentionally does not prune inFlightRunIds: a leftover id is a harmless
  // no-op for failInFlightRuns (it re-asserts status='running' in SQL), and the
  // set is fully cleared on shutdown.
  async reapStaleRuns(): Promise<void> {
    try {
      const reaped =
        await ActiveChatRunModel.markStaleRunningAsFailed(STALE_RUNNING_MS);
      if (reaped > 0) {
        logger.info({ reaped }, "Reaped stale active chat runs");
      }
    } catch (error) {
      logger.warn({ error }, "Failed to reap stale active chat runs");
    }
  }

  // Best-effort cleanup on graceful shutdown: fail this pod's still-running runs
  // so their conversations are not blocked until the stale reaper catches up.
  async failInFlightRuns(): Promise<number> {
    const ids = Array.from(this.inFlightRunIds);

    const failed = await ActiveChatRunModel.markRunningAsFailedByIds({
      ids,
      error: "Server shut down before the chat stream completed.",
    });

    // Remove only the snapshotted ids, and only after the write resolves
    // (mirrors markTerminal): on throw the ids are retained for the stale-run
    // reaper, and a run registered concurrently during the shutdown window is
    // left to its own registerCreatedRun/markTerminal rather than clobbered.
    for (const id of ids) {
      this.inFlightRunIds.delete(id);
    }

    if (failed > 0) {
      logger.info({ failed }, "Failed in-flight active chat runs on shutdown");
    }

    return failed;
  }

  async requestStop(params: {
    conversationId: string;
    organizationId: string;
  }) {
    const run = await ActiveChatRunModel.requestStop(params);
    if (run) {
      await this.notifyStop(run.id);
    }

    return run;
  }

  drainStreamToEvents(params: {
    runId: string;
    conversationId: string;
    stream: ReadableStream<UIMessageChunk>;
    getTerminalStatus: () => Promise<{
      status: "completed" | "failed" | "cancelled";
      error?: string | null;
    }>;
    abortController?: AbortController;
  }): void {
    void (async () => {
      const writer = new ActiveChatRunEventBatcher(params.runId, () =>
        this.notifyEvent(params.runId),
      );
      const reader = params.stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);

          // An error chunk is terminal for the client (the error renders and
          // the user can immediately retry/resend), but the row only flips to
          // `failed` once this drain completes — and a wedged upstream stream
          // can keep it `running` until the stale reaper, 409-blocking every
          // send in the meantime. Fail the run the moment the error event is
          // durably flushed: write-then-flush ordering guarantees a replaying
          // client can never observe the failed status without the error
          // event, and markTerminal's running-only guard makes the
          // end-of-stream terminal write below a no-op.
          if (value.type === "error") {
            await writer.flush();
            await this.markTerminal({
              runId: params.runId,
              status: "failed",
              error: value.errorText,
            });
            await this.notifyEvent(params.runId);
          }
        }

        await writer.flush();
        const terminal = await params.getTerminalStatus();
        await this.markTerminal({
          runId: params.runId,
          status: terminal.status,
          error: terminal.error,
        });
        await this.notifyEvent(params.runId);
      } catch (error) {
        if (!params.abortController?.signal.aborted) {
          params.abortController?.abort();
        }
        await reader.cancel().catch((cancelError) => {
          logger.warn(
            { cancelError, runId: params.runId },
            "Failed to cancel active chat run event reader after drain error",
          );
        });
        await writer.flush().catch((flushError) => {
          logger.error(
            { flushError, runId: params.runId },
            "Failed to flush active chat run events after drain error",
          );
        });
        await this.markTerminal({
          runId: params.runId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        await this.notifyEvent(params.runId);
      }
    })().catch((error) => {
      logger.error(
        { error, runId: params.runId, conversationId: params.conversationId },
        "Unexpected active chat run drain failure",
      );
    });
  }

  createReplayStream(runId: string): ReadableStream<UIMessageChunk> {
    let isCancelled = false;
    const notifier = this.notifier;
    const replayPollIntervalMs = this.replayPollIntervalMs;

    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        let lastSeq = 0;

        try {
          while (!isCancelled) {
            const events = await ActiveChatRunModel.readEventsAfter({
              runId,
              seq: lastSeq,
            });

            for (const event of events) {
              for (const payload of event.payloads) {
                controller.enqueue(payload);
              }
              lastSeq = event.seq;
            }

            const run = await ActiveChatRunModel.findById(runId);
            if (!run || run.status !== "running") {
              const finalEvents = await ActiveChatRunModel.readEventsAfter({
                runId,
                seq: lastSeq,
              });
              for (const event of finalEvents) {
                for (const payload of event.payloads) {
                  controller.enqueue(payload);
                }
                lastSeq = event.seq;
              }
              controller.close();
              return;
            }

            // LISTEN/NOTIFY normally wakes reconnecting clients as soon as new
            // events are written. The timeout is a fallback poll; in polling
            // compatibility mode it becomes the only wake-up mechanism.
            await notifier.waitForEvent({
              runId,
              timeoutMs: replayPollIntervalMs,
            });
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        isCancelled = true;
      },
    });
  }

  startStopPolling(params: {
    runId: string;
    conversationId: string;
    abortController: AbortController;
  }): () => void {
    let stopped = false;
    const waitController = new AbortController();

    void (async () => {
      while (!stopped && !params.abortController.signal.aborted) {
        // Default mode wakes this loop with Postgres LISTEN/NOTIFY. The timeout
        // is still a safety poll so missed notifications or broken listener
        // connections do not leave Stop requests undetected forever. In polling
        // compatibility mode, this wait always lasts until the interval expires,
        // so each running chat stream performs roughly one stop-check read per
        // interval.
        await this.notifier.waitForStop({
          runId: params.runId,
          timeoutMs: this.stopPollIntervalMs,
          abortSignal: waitController.signal,
        });

        if (stopped || params.abortController.signal.aborted) {
          return;
        }

        try {
          const run = await ActiveChatRunModel.findById(params.runId);
          if (run?.stopRequestedAt && !params.abortController.signal.aborted) {
            logger.info(
              { conversationId: params.conversationId, runId: params.runId },
              "Active chat run stop requested, aborting stream",
            );
            params.abortController.abort();
            return;
          }
        } catch (error) {
          logger.warn(
            { error, conversationId: params.conversationId },
            "Failed to poll active chat run stop flag",
          );
        }
      }
    })();

    return () => {
      stopped = true;
      waitController.abort();
    };
  }

  // Track a freshly created run, closing the window where shutdown began while
  // ActiveChatRunModel.create was awaiting: fail it now rather than orphan it.
  private async registerCreatedRun(
    run: NonNullable<Awaited<ReturnType<typeof ActiveChatRunModel.create>>>,
  ): Promise<typeof run | null> {
    this.inFlightRunIds.add(run.id);

    if (this.isShuttingDown) {
      await this.markTerminal({
        runId: run.id,
        status: "failed",
        error: "Server shut down before the chat stream completed.",
      });
      return null;
    }

    return run;
  }

  private async notifyEvent(runId: string): Promise<void> {
    await this.notifier.notifyEvent(runId).catch((error) => {
      logger.warn({ error, runId }, "Failed to notify active chat run event");
    });
  }

  private async notifyStop(runId: string): Promise<void> {
    await this.notifier.notifyStop(runId).catch((error) => {
      logger.warn({ error, runId }, "Failed to notify active chat run stop");
    });
  }

  private cleanupTerminalRunsIfNeeded(conversationId: string): void {
    const now = Date.now();
    if (now < this.nextTerminalCleanupAt) {
      return;
    }

    this.nextTerminalCleanupAt = now + TERMINAL_CLEANUP_INTERVAL_MS;
    void ActiveChatRunModel.deleteTerminalOlderThan(
      ACTIVE_CHAT_RUN_TERMINAL_RETENTION_MS,
    ).catch((error) => {
      logger.warn(
        { error, conversationId },
        "Failed to clean up old terminal chat runs",
      );
    });
  }
}

export const activeChatRunService = new ActiveChatRunService(
  createActiveChatRunNotifier(),
  config.chat.activeRun.replayPollIntervalMs,
  config.chat.activeRun.stopPollIntervalMs,
);

class ActiveChatRunEventBatcher {
  private nextSeq = 1;
  private pending: UIMessageChunk[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> = Promise.resolve();
  private lastRunTouchAt = 0;

  constructor(
    private readonly runId: string,
    private readonly onFlush: () => Promise<void>,
  ) {}

  async write(payload: UIMessageChunk): Promise<void> {
    this.pending.push(payload);

    if (this.pending.length >= EVENT_BATCH_SIZE) {
      await this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        void this.flush();
      }, EVENT_FLUSH_INTERVAL_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.pending.length === 0) {
      await this.flushPromise;
      return;
    }

    const payloads = compactReplayPayloads(this.pending);
    const seq = this.nextSeq;
    const touchRun = this.shouldTouchRun();
    this.pending = [];
    this.nextSeq += 1;

    this.flushPromise = this.flushPromise.then(() =>
      ActiveChatRunModel.appendEvents({
        runId: this.runId,
        seq,
        payloads,
        touchRun,
      }).then(() => this.onFlush()),
    );

    await this.flushPromise;
  }

  private shouldTouchRun(): boolean {
    const now = Date.now();
    if (
      this.lastRunTouchAt &&
      now - this.lastRunTouchAt < RUN_TOUCH_INTERVAL_MS
    ) {
      return false;
    }

    this.lastRunTouchAt = now;
    return true;
  }
}

function compactReplayPayloads(payloads: UIMessageChunk[]): UIMessageChunk[] {
  const compacted: UIMessageChunk[] = [];

  for (const payload of payloads) {
    const previous = compacted.at(-1);
    if (
      canMergeDeltaChunks(previous, payload) &&
      isMergeableDeltaChunk(payload)
    ) {
      previous.delta += payload.delta;
      continue;
    }

    compacted.push({ ...payload });
  }

  return compacted;
}

function canMergeDeltaChunks(
  previous: UIMessageChunk | undefined,
  current: UIMessageChunk,
): previous is MergeableDeltaChunk {
  return (
    isMergeableDeltaChunk(current) &&
    (previous?.type === "text-delta" || previous?.type === "reasoning-delta") &&
    previous.type === current.type &&
    previous.id === current.id &&
    !previous.providerMetadata &&
    !current.providerMetadata
  );
}

function isMergeableDeltaChunk(
  payload: UIMessageChunk,
): payload is MergeableDeltaChunk {
  return payload.type === "text-delta" || payload.type === "reasoning-delta";
}

type MergeableDeltaChunk = Extract<
  UIMessageChunk,
  { type: "text-delta" | "reasoning-delta" }
>;
