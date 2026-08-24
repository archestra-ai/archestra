import pino from "pino";
import { LOG_LEVEL } from "@/logging/log-level";
import { REDACTED_LOG_PATHS, serializeErrorBounded } from "@/logging/redaction";

/**
 * Creates a production logger with the safety settings every output stream
 * must share. Callers choose destinations and may add record context, but
 * cannot bypass redaction or bounded error serialization.
 */
export function createLogger({
  streams,
  mixin,
  level = LOG_LEVEL,
}: {
  streams: pino.StreamEntry[];
  mixin?: pino.LoggerOptions["mixin"];
  level?: pino.LoggerOptions["level"];
}): pino.Logger {
  return pino(
    {
      level,
      mixin,
      // Pod metadata already identifies the host in containerized runtimes.
      base: undefined,
      // Apply before fan-out so no destination sees credential-shaped fields.
      redact: { paths: REDACTED_LOG_PATHS, censor: "[Redacted]" },
      serializers: {
        err: serializeErrorBounded,
        error: serializeErrorBounded,
      },
    },
    pino.multistream(streams),
  );
}
