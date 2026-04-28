import type { UIMessageChunk } from "ai";
import logger from "@/logging";
import ActiveChatRunModel from "@/models/chat-active-run";

const EVENT_FLUSH_INTERVAL_MS = 100;
const EVENT_BATCH_SIZE = 16;
const REPLAY_POLL_INTERVAL_MS = 250;
const STOP_POLL_INTERVAL_MS = 500;
const STALE_RUNNING_MS = 10 * 60 * 1000;
export const ACTIVE_CHAT_RUN_TERMINAL_RETENTION_MS = 60 * 60 * 1000;
export const ACTIVE_CHAT_RUN_TERMINAL_REPLAY_GRACE_MS = 2 * 60 * 1000;

class ActiveChatRunService {
  async createRun(params: {
    conversationId: string;
    userId: string;
    organizationId: string;
  }) {
    try {
      await ActiveChatRunModel.markStaleRunningAsFailed(STALE_RUNNING_MS);
    } catch (error) {
      logger.warn(
        { error, conversationId: params.conversationId },
        "Failed to mark stale active chat runs as failed",
      );
    }

    void ActiveChatRunModel.deleteTerminalOlderThan(
      ACTIVE_CHAT_RUN_TERMINAL_RETENTION_MS,
    ).catch((error) => {
      logger.warn(
        { error, conversationId: params.conversationId },
        "Failed to clean up old terminal chat runs",
      );
    });

    return ActiveChatRunModel.create(params);
  }

  drainStreamToEvents(params: {
    runId: string;
    conversationId: string;
    stream: ReadableStream<UIMessageChunk>;
    getTerminalStatus: () => Promise<{
      status: "completed" | "failed" | "cancelled";
      error?: string | null;
    }>;
  }): void {
    void (async () => {
      const writer = new ActiveChatRunEventBatcher(params.runId);
      const reader = params.stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }

        await writer.flush();
        const terminal = await params.getTerminalStatus();
        await ActiveChatRunModel.markTerminal({
          runId: params.runId,
          status: terminal.status,
          error: terminal.error,
        });
      } catch (error) {
        await writer.flush().catch((flushError) => {
          logger.error(
            { flushError, runId: params.runId },
            "Failed to flush active chat run events after drain error",
          );
        });
        await ActiveChatRunModel.markTerminal({
          runId: params.runId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
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

            await sleep(REPLAY_POLL_INTERVAL_MS);
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
    const interval = setInterval(() => {
      ActiveChatRunModel.findById(params.runId)
        .then((run) => {
          if (run?.stopRequestedAt && !params.abortController.signal.aborted) {
            logger.info(
              { conversationId: params.conversationId, runId: params.runId },
              "Active chat run stop requested, aborting stream",
            );
            params.abortController.abort();
          }
        })
        .catch((error) => {
          logger.warn(
            { error, conversationId: params.conversationId },
            "Failed to poll active chat run stop flag",
          );
        });
    }, STOP_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }
}

class ActiveChatRunEventBatcher {
  private nextSeq = 1;
  private pending: UIMessageChunk[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> = Promise.resolve();

  constructor(private readonly runId: string) {}

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
    this.pending = [];
    this.nextSeq += 1;

    this.flushPromise = this.flushPromise.then(() =>
      ActiveChatRunModel.appendEvents({
        runId: this.runId,
        seq,
        payloads,
      }),
    );

    await this.flushPromise;
  }
}

export const activeChatRunService = new ActiveChatRunService();

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
