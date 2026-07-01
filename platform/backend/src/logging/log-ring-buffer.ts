import { Writable } from "node:stream";

/**
 * A single retained log record, trimmed to the fields worth cross-referencing
 * alongside a captured backend exception (see `error-tracking.ts`).
 */
export type RetainedLogRecord = {
  /** Epoch milliseconds (pino `time`). */
  time: number;
  /** Pino numeric level (10=trace … 60=fatal). */
  level: number;
  /** Human-readable level label (e.g. "info", "error"). */
  levelLabel: string;
  /** Log message. */
  msg: string;
  /** OTEL trace id, when the record was emitted inside an active span. */
  traceId?: string;
  /** Archestra session id, when the record was emitted inside a session. */
  sessionId?: string;
};

const DEFAULT_CAPACITY = 250;
const MAX_MSG_LENGTH = 2000;

const PINO_LEVEL_LABELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

/**
 * Fixed-size, in-memory ring buffer of the most recent log records.
 *
 * PostHog error tracking shows a stack trace, but the log lines that led up to
 * a failure are just as useful for diagnosis. We keep a small rolling window of
 * recent logs here so the Fastify error handler can attach the lines preceding
 * an exception (scoped to the failing request's trace) directly onto the
 * captured `$exception` event — no separate log-ingestion pipeline required.
 *
 * The buffer is bounded (both in record count and per-message length) so it can
 * never grow without limit or retain large payloads.
 */
class LogRingBuffer {
  private readonly capacity: number;
  private readonly records: RetainedLogRecord[] = [];
  private nextIndex = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  /**
   * Pino multistream branch that parses each serialized JSON log record and
   * retains a trimmed copy. Parse/shape errors are ignored so logging is never
   * disrupted by buffering.
   */
  createStream(): Writable {
    return new Writable({
      write: (
        chunk: Buffer,
        _encoding: string,
        callback: (error?: Error | null) => void,
      ) => {
        this.ingest(chunk);
        callback();
      },
    });
  }

  /**
   * Return the most recent records (oldest → newest), optionally filtered to a
   * single trace or session so callers get only the lines relevant to one
   * request. `limit` caps how many of the matching records are returned.
   */
  getRecent(params: {
    traceId?: string;
    sessionId?: string;
    limit: number;
  }): RetainedLogRecord[] {
    const { traceId, sessionId, limit } = params;
    const ordered = this.orderedRecords();
    const matching = ordered.filter((record) => {
      if (traceId && record.traceId !== traceId) return false;
      if (sessionId && record.sessionId !== sessionId) return false;
      return true;
    });
    return matching.slice(-limit);
  }

  private ingest(chunk: Buffer): void {
    let record: unknown;
    try {
      record = JSON.parse(chunk.toString());
    } catch {
      return;
    }
    if (typeof record !== "object" || record === null) return;

    const { time, level, msg, trace_id, session_id } = record as Record<
      string,
      unknown
    >;
    if (typeof level !== "number") return;

    this.push({
      time: typeof time === "number" ? time : Date.now(),
      level,
      levelLabel: PINO_LEVEL_LABELS[level] ?? "info",
      msg: typeof msg === "string" ? msg.slice(0, MAX_MSG_LENGTH) : String(msg),
      traceId: typeof trace_id === "string" ? trace_id : undefined,
      sessionId: typeof session_id === "string" ? session_id : undefined,
    });
  }

  private push(record: RetainedLogRecord): void {
    if (this.records.length < this.capacity) {
      this.records.push(record);
    } else {
      this.records[this.nextIndex] = record;
    }
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
  }

  private orderedRecords(): RetainedLogRecord[] {
    if (this.records.length < this.capacity) {
      return [...this.records];
    }
    // Buffer is full and wraps at `nextIndex` (the oldest slot).
    return [
      ...this.records.slice(this.nextIndex),
      ...this.records.slice(0, this.nextIndex),
    ];
  }
}

export const logRingBuffer = new LogRingBuffer();
