import type { RumEventName } from "@archestra/shared";
import {
  type Logger as OtelLogger,
  SeverityNumber,
} from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import config from "@/config";
import logger from "@/logging";

interface RumEvent {
  name: RumEventName;
  /** Client-side epoch milliseconds at which the event happened. */
  timestampMs: number;
  sessionId: string;
  previousSessionId?: string;
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Exports product-usage (RUM) events received from the web client as OTLP log
 * records — the OTEL "events are log records with an event name" model — to
 * the customer-controlled collector configured via
 * ARCHESTRA_RUM_EXPORTER_OTLP_ENDPOINT.
 *
 * This is a pipeline of its own, separate from the tracing SDK's log pipeline:
 * that one carries this backend's logs to the deployment's observability
 * endpoint, this one carries browser usage events, potentially to a different
 * destination with different credentials. It is also the single audited place
 * where event attributes are shaped before leaving the deployment.
 */
class RumExporter {
  private loggerProvider: LoggerProvider | null = null;
  private otelLogger: OtelLogger | null = null;

  initialize() {
    const { enabled, logExporter } = config.observability.rum;
    if (!enabled || this.loggerProvider) {
      return;
    }
    // Boot-time enterprise gate, loud like data-retention's: an operator who
    // configured usage telemetry must not silently get none. Codegen boots
    // without a deployment's licensing env, so it is exempt.
    if (!config.enterpriseFeatures.core && !config.codegenMode) {
      throw new Error(
        "Real User Monitoring (ARCHESTRA_RUM_EXPORTER_OTLP_ENDPOINT) requires " +
          "an enterprise license. Unset the variable or contact sales@archestra.ai.",
      );
    }

    this.loggerProvider = new LoggerProvider({
      resource: defaultResource().merge(
        resourceFromAttributes({
          // RUM events describe the web client, not this backend process —
          // a distinct service.name lets customers separate the two streams.
          [ATTR_SERVICE_NAME]: `${config.api.name} Web`,
          [ATTR_SERVICE_VERSION]: config.api.version,
        }),
      ),
      processors: [
        new BatchLogRecordProcessor(
          new OTLPLogExporter(logExporter),
          config.observability.rum.batchProcessor,
        ),
      ],
    });
    this.otelLogger = this.loggerProvider.getLogger(
      "archestra-rum",
      config.api.version,
    );

    logger.info(
      { rumOtlpLogEndpoint: logExporter.url },
      "RUM export pipeline initialized",
    );
  }

  /**
   * Emit a batch of validated events on behalf of the given user. Returns the
   * number of accepted events (0 when the pipeline is disabled).
   */
  emit(events: RumEvent[], { userId }: { userId: string }): number {
    if (!this.otelLogger) {
      return 0;
    }

    const now = Date.now();
    for (const event of events) {
      this.otelLogger.emit({
        eventName: event.name,
        // The event name is also the body and an `event.name` attribute:
        // the top-level OTLP eventName field is newer than much of the
        // backend ecosystem (Loki 3.3 drops it, for example), and an empty
        // body renders as a blank line in log UIs. Redundant on modern
        // backends, decisive on older ones.
        body: event.name,
        timestamp: clampTimestamp(event.timestampMs, now),
        observedTimestamp: now,
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        attributes: {
          "event.name": event.name,
          ...mapAttributes(event, userId),
        },
      });
    }
    return events.length;
  }

  async shutdown() {
    const provider = this.loggerProvider;
    this.loggerProvider = null;
    this.otelLogger = null;
    await provider?.shutdown();
  }
}

export const rumExporter = new RumExporter();

// === Internal helpers ===

/**
 * Attribute keys forwarded verbatim because they are OTEL semantic
 * conventions; anything else the client sends is namespaced under
 * `archestra.` so a client can never spoof resource/identity attributes.
 */
const SEMCONV_PASSTHROUGH_ATTRIBUTE_KEYS = new Set([
  "url.path",
  "error.type",
  "http.request.method",
  "http.response.status_code",
  "browser.web_vital.name",
  "browser.web_vital.value",
  "browser.web_vital.rating",
]);

function mapAttributes(
  event: RumEvent,
  userId: string,
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    // OTEL session semantic conventions; the ids are minted client-side.
    "session.id": event.sessionId,
    // user.* semconv, but only the opaque internal id — never email or name.
    // The customer can join it to their IdP on their own side if they choose.
    "user.id": userId,
  };
  if (event.previousSessionId) {
    attributes["session.previous_id"] = event.previousSessionId;
  }
  for (const [key, value] of Object.entries(event.attributes ?? {})) {
    const mappedKey =
      SEMCONV_PASSTHROUGH_ATTRIBUTE_KEYS.has(key) ||
      key.startsWith("archestra.")
        ? key
        : `archestra.${key}`;
    attributes[mappedKey] = value;
  }
  return attributes;
}

// Client clocks drift and events are batched, so accept a bounded window of
// client time and fall back to server time outside it — a wildly wrong
// timestamp is worse for usage aggregation than a slightly late one.
const MAX_EVENT_AGE_MS = 60 * 60 * 1000;
const MAX_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1000;

function clampTimestamp(timestampMs: number, nowMs: number): number {
  if (
    timestampMs < nowMs - MAX_EVENT_AGE_MS ||
    timestampMs > nowMs + MAX_EVENT_FUTURE_SKEW_MS
  ) {
    return nowMs;
  }
  return timestampMs;
}
