import { Writable } from "node:stream";
import { AgentRunReadableTranscriptSchema } from "@archestra/shared";
import config from "@/config";
import logger from "@/logging";
import type { AgentRunRecord } from "@/types";
import type { AgentRuntimeBackendDriver } from "./backends";
import {
  AGENT_RUNTIME_READABLE_TRANSCRIPT_MAX_BYTES,
  AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_END,
  AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_START,
} from "./runtime-contract";

export const RETAINED_LOG_BYTES = 1024 * 1024;

/**
 * Captures live Agent Runtime output and replaces it with an authoritative snapshot
 * before the runtime is torn down.
 */
export class AgentRuntimeOutputCapture {
  private fullTranscript: FullTranscriptCapture;
  private liveProtocol: AgentRuntimeOutputProtocolParser;
  private retainedLogsValue = "";
  private readableTranscriptValue: string | null = null;

  constructor(
    private readonly params: {
      backend: Pick<
        AgentRuntimeBackendDriver,
        "streamOutput" | "snapshotOutput"
      >;
      session: AgentRunRecord;
      onTextDelta?: (delta: string) => void;
      maxTranscriptBytes?: number;
      throwOnStreamError?: boolean;
    },
  ) {
    this.fullTranscript = new FullTranscriptCapture(
      params.maxTranscriptBytes ?? config.agentRuntime.transcriptMaxBytes,
    );
    this.liveProtocol = new AgentRuntimeOutputProtocolParser();
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

  get readableTranscript(): string | null {
    return this.readableTranscriptValue;
  }

  /** Follow output for live progress. A dropped stream does not end the run. */
  follow(abortSignal?: AbortSignal, lines?: number): Promise<void> {
    const destination = this.createDestination({
      onChunk: (chunk) => {
        this.appendLiveChunk(chunk);
      },
      onFinal: () => this.finishLiveProtocol(),
    });

    return new Promise<void>((resolve, reject) => {
      destination.on("finish", resolve);
      destination.on("close", resolve);
      destination.on("error", resolve);
      this.params.backend
        .streamOutput({
          session: this.params.session,
          destination,
          lines,
          abortSignal,
        })
        .catch((error) => {
          if (this.params.throwOnStreamError) {
            reject(error);
            destination.destroy();
            return;
          }
          logger.warn(
            { error, sessionId: this.params.session.id },
            "Could not follow Agent Runtime logs; the task continues without streamed output",
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
      this.params.maxTranscriptBytes ?? config.agentRuntime.transcriptMaxBytes,
    );
    const protocol = new AgentRuntimeOutputProtocolParser();
    let snapshotLogs = "";
    let receivedSnapshot = false;
    const destination = this.createDestination({
      onChunk: (chunk) => {
        receivedSnapshot = true;
        const terminalChunk = protocol.append(chunk);
        snapshot.append(terminalChunk);
        snapshotLogs = retainLogTail(snapshotLogs, terminalChunk);
      },
      onFinal: () => {
        const terminalChunk = protocol.finish();
        snapshot.append(terminalChunk);
        snapshotLogs = retainLogTail(snapshotLogs, terminalChunk);
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
        "Could not recover the final Agent Runtime output snapshot; retaining streamed output",
      );
      return;
    }

    if (!receivedSnapshot) return;
    this.fullTranscript = snapshot;
    this.retainedLogsValue = snapshotLogs;
    this.readableTranscriptValue = protocol.readableTranscript;
  }

  private appendLiveChunk(chunk: string): void {
    this.appendLiveTerminalChunk(this.liveProtocol.append(chunk));
    this.readableTranscriptValue = this.liveProtocol.readableTranscript;
  }

  private createDestination(params: {
    onChunk: (chunk: string) => void;
    onFinal?: () => void;
  }): Writable {
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      params.onFinal?.();
    };
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        params.onChunk(chunk.toString("utf8"));
        callback();
      },
      final(callback) {
        finalize();
        callback();
      },
    });
    destination.on("close", finalize);
    return destination;
  }

  private appendLiveTerminalChunk(chunk: string): void {
    if (!chunk) return;
    this.fullTranscript.append(chunk);
    this.retainedLogsValue = retainLogTail(this.retainedLogsValue, chunk);
    this.params.onTextDelta?.(chunk);
  }

  private finishLiveProtocol(): void {
    this.appendLiveTerminalChunk(this.liveProtocol.finish());
    this.readableTranscriptValue = this.liveProtocol.readableTranscript;
  }
}

// ===================== internals =====================

class AgentRuntimeOutputProtocolParser {
  private mode: "terminal" | "readable" = "terminal";
  private pending = "";
  private encodedChunks: string[] | null = [];
  private encodedLength = 0;
  readableTranscript: string | null = null;

  append(chunk: string): string {
    this.pending += chunk;
    let terminal = "";

    while (this.pending) {
      const marker =
        this.mode === "terminal"
          ? AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_START
          : AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_END;
      const markerIndex = this.pending.indexOf(marker);
      if (markerIndex !== -1) {
        const beforeMarker = this.pending.slice(0, markerIndex);
        if (this.mode === "terminal") {
          terminal += beforeMarker;
          this.mode = "readable";
          this.encodedChunks = [];
          this.encodedLength = 0;
        } else {
          this.appendEncoded(beforeMarker);
          this.finishReadableTranscript();
          this.mode = "terminal";
        }
        this.pending = this.pending.slice(markerIndex + marker.length);
        continue;
      }

      const retainedSuffixLength = matchingMarkerPrefixLength(
        this.pending,
        marker,
      );
      const available = this.pending.slice(
        0,
        this.pending.length - retainedSuffixLength,
      );
      this.pending = this.pending.slice(
        this.pending.length - retainedSuffixLength,
      );
      if (this.mode === "terminal") terminal += available;
      else this.appendEncoded(available);
      break;
    }

    return terminal;
  }

  finish(): string {
    const terminal = this.mode === "terminal" ? this.pending : "";
    this.pending = "";
    return terminal;
  }

  private appendEncoded(value: string): void {
    this.encodedLength += value.length;
    if (
      this.encodedLength > MAX_READABLE_TRANSCRIPT_BASE64_BYTES ||
      !this.encodedChunks
    ) {
      this.encodedChunks = null;
      return;
    }
    this.encodedChunks.push(value);
  }

  private finishReadableTranscript(): void {
    if (!this.encodedChunks) return;
    const decoded = Buffer.from(this.encodedChunks.join(""), "base64").toString(
      "utf8",
    );
    if (
      Buffer.byteLength(decoded, "utf8") >
      AGENT_RUNTIME_READABLE_TRANSCRIPT_MAX_BYTES
    ) {
      return;
    }
    const parsed = AgentRunReadableTranscriptSchema.safeParse(
      parseJson(decoded),
    );
    if (parsed.success) {
      this.readableTranscript = JSON.stringify(parsed.data);
    }
  }
}

function matchingMarkerPrefixLength(value: string, marker: string): number {
  const maxLength = Math.min(value.length, marker.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const MAX_READABLE_TRANSCRIPT_BASE64_BYTES =
  Math.ceil(AGENT_RUNTIME_READABLE_TRANSCRIPT_MAX_BYTES / 3) * 4 + 4;

function retainLogTail(current: string, chunk: string): string {
  if (!chunk) return current;
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
    if (!chunk) return;
    this.observedBytes += Buffer.byteLength(chunk, "utf8");
    if (!this.chunks) return;
    if (this.observedBytes > this.maxBytes) {
      this.chunks = null;
      return;
    }
    this.chunks.push(chunk);
  }
}
