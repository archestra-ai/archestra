import { Writable } from "node:stream";
import {
  isSpanContextValid,
  context as otelContext,
  trace,
} from "@opentelemetry/api";
import {
  logs,
  type Logger as OtelLogger,
  SeverityNumber,
} from "@opentelemetry/api-logs";
import pino from "pino";
import pretty from "pino-pretty";
import { getActiveSessionId } from "@/observability/request-context";

/**
 * Lazy-initialized pino logger using a Proxy.
 *
 * Why lazy: ensures the OpenTelemetry SDK has started and registered a real
 * global `LoggerProvider` before we create the pino instance and its OTEL
 * log-forwarding stream.
 *
 * Why manual OTEL integration (mixin + custom stream) instead of relying on
 * `@opentelemetry/instrumentation-pino`:
 *
 * The backend is bundled by tsdown to ESM (`server.mjs`). Static ESM imports
 * are hoisted and resolved before any module code runs — including `sdk.start()`.
 * The OTEL pino instrumentation patches the `pino()` constructor at
 * `sdk.start()` time, but it can't retroactively patch ESM modules that are
 * already loaded (that requires the `--import` flag). So we manually:
 *
 *   1. Inject trace context (`trace_id`, `span_id`, `trace_flags`) into every
 *      log record via pino's `mixin` option — visible in console output.
 *   2. Forward log records to the OTEL Logs API via a custom `Writable` stream
 *      combined with `pino.multistream` — sends logs to the OTLP collector.
 *
 * The OTEL Logs SDK automatically captures the active span context when
 * `otelLogger.emit()` is called, so logs are linked to traces without needing
 * to pass context explicitly.
 */

let _instance: pino.Logger | null = null;

function createLogger(): pino.Logger {
  const prettyStream = pretty({
    colorize: true,
    translateTime: "HH:MM:ss Z",
    ignore: "pid,hostname",
    singleLine: true,
  });

  return pino(
    {
      level: process.env.ARCHESTRA_LOGGING_LEVEL?.toLowerCase() || "info",
      mixin: injectTraceContext,
    },
    pino.multistream([
      { level: "trace", stream: prettyStream },
      { level: "trace", stream: createOtelLogStream() },
    ]),
  );
}

const logger: pino.Logger = new Proxy({} as pino.Logger, {
  get(_, prop) {
    if (!_instance) _instance = createLogger();
    const value = (_instance as unknown as Record<string | symbol, unknown>)[
      prop
    ];
    return typeof value === "function" ? value.bind(_instance) : value;
  },
});

export default logger;

// --- Internal helpers (trace context injection) ---

/**
 * Pino mixin that injects OpenTelemetry trace context into every log record.
 * Shows `trace_id`, `span_id`, and `trace_flags` in console/pretty output.
 */
function injectTraceContext(): Record<string, string> {
  const span = trace.getSpan(otelContext.active());
  if (!span) return {};

  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) return {};

  const result: Record<string, string> = {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: `0${spanContext.traceFlags.toString(16)}`,
  };

  const sessionId = getActiveSessionId();
  if (sessionId) {
    result.session_id = sessionId;
  }

  return result;
}

// --- Internal helpers (OTEL log stream) ---

/** Map pino log levels → OTEL severity numbers */
const PINO_TO_OTEL_SEVERITY: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};

/** Convert epoch milliseconds to `[seconds, nanoseconds]` HrTime tuple */
function millisToHrTime(millis: number): [number, number] {
  return [Math.trunc(millis / 1000), (millis % 1000) * 1_000_000];
}

/**
 * Create a writable stream that forwards pino log records to the OTEL Logs API.
 *
 * Mirrors `@opentelemetry/instrumentation-pino`'s `OTelPinoStream`:
 * - Parses JSON log records from pino
 * - Strips redundant fields (hostname, pid, trace context injected by mixin)
 * - Maps pino levels to OTEL severity numbers
 * - Emits records via the global OTEL LoggerProvider
 */
function createOtelLogStream(): Writable {
  const otelLogger: OtelLogger = logs.getLogger("pino");

  return new Writable({
    write(
      chunk: Buffer,
      _encoding: string,
      callback: (error?: Error | null) => void,
    ) {
      try {
        const record = JSON.parse(chunk.toString());
        const {
          time,
          msg,
          level,
          // Strip fields redundant with OTEL resource attributes
          hostname: _hostname,
          pid: _pid,
          // Strip trace context fields added by mixin (redundant — the OTEL SDK
          // captures the active span context automatically via `context.active()`)
          trace_id: _traceId,
          span_id: _spanId,
          trace_flags: _traceFlags,
          ...attributes
        } = record;

        const timestamp = millisToHrTime(
          typeof time === "number" ? time : Date.now(),
        );

        otelLogger.emit({
          timestamp,
          observedTimestamp: timestamp,
          severityNumber: PINO_TO_OTEL_SEVERITY[level] ?? SeverityNumber.INFO,
          severityText: pino.levels.labels[level] ?? "INFO",
          body: msg,
          attributes,
        });
      } catch {
        // Ignore JSON parse errors (shouldn't happen with standard pino output)
      }
      callback();
    },
  });
}
