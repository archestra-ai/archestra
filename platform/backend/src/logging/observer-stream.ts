import { type Logger, SeverityNumber } from "@opentelemetry/api-logs";
import type { DestinationStream } from "pino";

/** Parse the already-redacted Pino record once for both structured consumers. */
export function createLogObserverStream({
  logger,
  retain,
}: {
  logger: Pick<Logger, "emit">;
  retain: (record: Record<string, unknown>) => void;
}): DestinationStream {
  return {
    write(chunk) {
      try {
        const record = JSON.parse(
          typeof chunk === "string" ? chunk : String(chunk),
        );
        if (!record || typeof record !== "object" || Array.isArray(record))
          return;
        retain(record);
        const {
          time,
          msg,
          level,
          hostname: _hostname,
          pid: _pid,
          trace_id: _traceId,
          span_id: _spanId,
          trace_flags: _traceFlags,
          ...attributes
        } = record;
        const millis = typeof time === "number" ? time : Date.now();
        const timestamp: [number, number] = [
          Math.trunc(millis / 1000),
          (millis % 1000) * 1_000_000,
        ];
        logger.emit({
          timestamp,
          observedTimestamp: timestamp,
          severityNumber: severities[level] ?? SeverityNumber.INFO,
          severityText: levels[level] ?? "INFO",
          body: msg,
          attributes,
        });
      } catch {
        // Invalid records or a failing observer must never disrupt logging.
      }
    },
  };
}

const severities: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};
const levels: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};
