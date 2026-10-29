import type { Logger } from "@opentelemetry/api-logs";
import type { DestinationStream } from "pino";
import { toOtelLogRecord } from "./otel-log-record";

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
        try {
          retain(record);
        } catch {
          // Retention and export are independent observers of the same record.
        }
        logger.emit(toOtelLogRecord(record));
      } catch {
        // Invalid records or a failing observer must never disrupt logging.
      }
    },
  };
}
