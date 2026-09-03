import { Writable } from "node:stream";
import config from "@/config";
import logger from "@/logging";
import type { AgentRun } from "@/types";
import type { RunnerBackend } from "./backends";

export const RETAINED_LOG_BYTES = 1024 * 1024;

/**
 * Captures live runner output and replaces it with an authoritative snapshot
 * before the runtime is torn down.
 */
export class RunnerOutputCapture {
  private fullTranscript: FullTranscriptCapture;
  private retainedLogsValue = "";

  constructor(
    private readonly params: {
      backend: Pick<RunnerBackend, "streamOutput" | "snapshotOutput">;
      session: AgentRun;
      onTextDelta?: (delta: string) => void;
      maxTranscriptBytes?: number;
    },
  ) {
    this.fullTranscript = new FullTranscriptCapture(
      params.maxTranscriptBytes ??
        config.agentBackgroundExecution.transcriptMaxBytes,
    );
  }

  get transcript(): string {
    return this.fullTranscript.value ?? this.retainedLogsValue;
  }

  get completeTranscript(): string | null {
    return this.fullTranscript.value;
  }

  get observedTranscriptBytes(): number {
    return this.fullTranscript.observedBytes;
  }

  get retainedLogs(): string {
    return this.retainedLogsValue;
  }

  /** Follow output for live progress. A dropped stream does not end the run. */
  follow(abortSignal?: AbortSignal): Promise<void> {
    const destination = this.createDestination({
      onChunk: (chunk) => {
        this.appendLiveChunk(chunk);
      },
    });

    return new Promise<void>((resolve) => {
      destination.on("finish", resolve);
      destination.on("close", resolve);
      destination.on("error", resolve);
      this.params.backend
        .streamOutput({
          session: this.params.session,
          destination,
          abortSignal,
        })
        .catch((error) => {
          logger.warn(
            { error, sessionId: this.params.session.id },
            "Could not follow runner logs; the task continues without streamed output",
          );
          destination.destroy();
          resolve();
        });
    });
  }

  /**
   * Replace partial live output with the backend's complete retained snapshot.
   * The live capture remains as a fallback when the final read is unavailable.
   */
  async recoverSnapshot(abortSignal?: AbortSignal): Promise<void> {
    const snapshot = new FullTranscriptCapture(
      this.params.maxTranscriptBytes ??
        config.agentBackgroundExecution.transcriptMaxBytes,
    );
    let snapshotLogs = "";
    let receivedSnapshot = false;
    const destination = this.createDestination({
      onChunk: (chunk) => {
        receivedSnapshot = true;
        snapshot.append(chunk);
        snapshotLogs = retainLogTail(snapshotLogs, chunk);
      },
    });

    try {
      await this.params.backend.snapshotOutput({
        session: this.params.session,
        destination,
        abortSignal,
      });
    } catch (error) {
      logger.warn(
        { error, sessionId: this.params.session.id },
        "Could not recover the final runner output snapshot; retaining streamed output",
      );
      return;
    }

    if (!receivedSnapshot) return;
    this.fullTranscript = snapshot;
    this.retainedLogsValue = snapshotLogs;
  }

  private appendLiveChunk(chunk: string): void {
    this.fullTranscript.append(chunk);
    this.retainedLogsValue = retainLogTail(this.retainedLogsValue, chunk);
    this.params.onTextDelta?.(chunk);
  }

  private createDestination(params: {
    onChunk: (chunk: string) => void;
  }): Writable {
    return new Writable({
      write(chunk, _encoding, callback) {
        params.onChunk(chunk.toString("utf8"));
        callback();
      },
    });
  }
}

// ===================== internals =====================

function retainLogTail(current: string, chunk: string): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= RETAINED_LOG_BYTES) {
    return combined;
  }
  return Buffer.from(combined, "utf8")
    .subarray(-RETAINED_LOG_BYTES)
    .toString("utf8")
    .replace(/^\uFFFD/, "");
}

class FullTranscriptCapture {
  private chunks: string[] | null = [];
  observedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get value(): string | null {
    return this.chunks?.join("") ?? null;
  }

  append(chunk: string): void {
    this.observedBytes += Buffer.byteLength(chunk, "utf8");
    if (!this.chunks) return;
    if (this.observedBytes > this.maxBytes) {
      this.chunks = null;
      return;
    }
    this.chunks.push(chunk);
  }
}
