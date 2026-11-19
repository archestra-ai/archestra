import pino from "pino";
import { parseLogContentMode } from "@/logging/content-mode";
import { LOG_LEVEL } from "@/logging/log-level";
import {
  REDACTED_LOG_PATHS,
  serializeErrorBounded,
  serializeErrorMetadata,
  withholdErrorContent,
  withholdLogArgument,
  withholdNestedErrorContent,
} from "@/logging/redaction";

/**
 * Creates a production logger with the safety settings every output stream
 * must share. Callers choose destinations and may add record context, but
 * cannot bypass redaction or bounded error serialization.
 */
export function createLogger({
  streams,
  mixin,
  level = LOG_LEVEL,
  contentMode = parseLogContentMode(process.env.ARCHESTRA_LOGS_CONTENT_MODE),
}: {
  contentMode?: "full" | "metadata_only";
  streams: pino.StreamEntry[];
  mixin?: pino.LoggerOptions["mixin"];
  level?: pino.LoggerOptions["level"];
}): pino.Logger {
  const logger = pino(
    {
      level,
      mixin,
      // Pod metadata already identifies the host in containerized runtimes.
      base: undefined,
      // Apply before fan-out so no destination sees credential-shaped fields.
      redact: { paths: REDACTED_LOG_PATHS, censor: "[Redacted]" },
      ...(contentMode === "metadata_only"
        ? {
            formatters: { log: withholdErrorContent },
            hooks: {
              logMethod(args, method) {
                // Pino otherwise uses Error.message as msg for logger.error(error).
                if (args[0] instanceof Error) {
                  args = [
                    { err: args[0] },
                    args[1] ?? "Application error",
                    ...args.slice(2),
                  ] as typeof args;
                } else if (
                  args.length === 1 &&
                  typeof args[0] === "object" &&
                  args[0] !== null &&
                  "err" in args[0]
                ) {
                  args = [args[0], "Application error"];
                }
                // The merging object goes through the log formatter. The
                // message and printf arguments do not, and call sites build
                // them from an error's text.
                args = args.map((arg, index) =>
                  index === 0 && typeof arg === "object" && arg !== null
                    ? arg
                    : withholdLogArgument(arg),
                ) as typeof args;
                method.apply(this, args);
              },
            },
          }
        : {}),
      serializers: {
        err:
          contentMode === "metadata_only"
            ? serializeErrorMetadata
            : serializeErrorBounded,
        error:
          contentMode === "metadata_only"
            ? serializeErrorMetadata
            : serializeErrorBounded,
      },
    },
    pino.multistream(streams),
  );
  if (contentMode === "metadata_only") {
    // Pino skips the log formatter for child bindings and resets the bindings
    // formatter for children. Children inherit this override.
    const { child } = logger;
    logger.child = function (this: typeof logger, bindings, options) {
      return child.call(this, withholdChildBindings(bindings), options);
    } as typeof child;
  }
  return logger;
}

// === Internal ===

/** The exact err/error keys still reach their serializers. */
function withholdChildBindings(bindings: pino.Bindings): pino.Bindings {
  return Object.fromEntries(
    Object.entries(bindings).map(([key, value]) => [
      key,
      key === "err" || key === "error"
        ? value
        : withholdNestedErrorContent(value),
    ]),
  );
}
