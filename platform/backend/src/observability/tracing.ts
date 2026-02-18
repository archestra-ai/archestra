import { FastifyOtelInstrumentation } from "@fastify/otel";
import type { Context } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import * as Sentry from "@sentry/node";
import {
  SentryPropagator,
  SentrySampler,
  SentrySpanProcessor,
} from "@sentry/opentelemetry";
import config from "@/config";
import logger from "@/logging";
import sentryClient from "@/sentry";

const {
  api: { name, version },
  observability: {
    otel: {
      traceExporter: traceExporterConfig,
      logExporter: logExporterConfig,
      verboseTracing,
    },
    sentry: { enabled: sentryEnabled },
  },
} = config;

/**
 * Whether to enable infrastructure auto-instrumentations (HTTP, pg, DNS, net).
 *
 * When Sentry is configured, auto-instrumentations are always enabled so Sentry
 * receives full traces for internal debugging. A FilteringSpanProcessor ensures
 * only GenAI/MCP spans reach the customer-facing OTLP endpoint.
 *
 * When Sentry is not configured, auto-instrumentations are only enabled if
 * ARCHESTRA_OTEL_VERBOSE_TRACING=true.
 */
const enableAutoInstrumentations = sentryEnabled || verboseTracing;

// Configure the OTLP exporter to send traces to the OpenTelemetry Collector
const traceExporter = new OTLPTraceExporter(traceExporterConfig);

// Configure the OTLP exporter to send logs to the OpenTelemetry Collector
const logExporter = new OTLPLogExporter(logExporterConfig);

// Create a resource with service information
const resource = defaultResource().merge(
  resourceFromAttributes({
    [ATTR_SERVICE_NAME]: name,
    [ATTR_SERVICE_VERSION]: version,
  }),
);

/**
 * A SpanProcessor that filters spans before forwarding to a delegate processor.
 * Only forwards spans that have a `route.category` attribute, which identifies
 * Archestra's GenAI/MCP spans (set in startActiveLlmSpan / startActiveMcpSpan).
 *
 * This keeps the customer-facing OTLP pipeline clean (only agent observability
 * spans) while Sentry receives the full unfiltered trace via its own processor.
 */
class AgentSpanFilterProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (span.attributes["route.category"]) {
      this.delegate.onEnd(span);
    }
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }
}

// Build the OTLP span processor — filtered when Sentry is enabled
const otlpBatchProcessor = new BatchSpanProcessor(traceExporter);
const otlpProcessor: SpanProcessor =
  sentryEnabled && !verboseTracing
    ? new AgentSpanFilterProcessor(otlpBatchProcessor)
    : otlpBatchProcessor;

// Create span processors array
const spanProcessors: SpanProcessor[] = [otlpProcessor];

// Add Sentry span processor if Sentry is enabled (receives ALL spans, unfiltered)
if (sentryEnabled) {
  spanProcessors.push(new SentrySpanProcessor());
}

// Initialize the OpenTelemetry SDK with auto-instrumentations
const sdk = new NodeSDK({
  resource,
  /**
   * IMPORTANT: We DON'T set `traceExporter` here because we're using custom `spanProcessors`.
   *
   * When you provide `traceExporter` to NodeSDK, it automatically wraps it in a
   * BatchSpanProcessor internally. However, when you also provide `spanProcessors`,
   * NodeSDK will ignore the `traceExporter` and only use the processors in `spanProcessors`.
   *
   * Since we need to send traces to BOTH Sentry and our OTLP endpoint, we manually
   * create our span processors array below:
   * 1. BatchSpanProcessor with OTLPTraceExporter - sends traces to our telemetry backend
   *    (wrapped in AgentSpanFilterProcessor when Sentry is enabled, so customers only
   *    see GenAI/MCP spans)
   * 2. SentrySpanProcessor (when enabled) - sends ALL traces to Sentry for internal debugging
   *
   * This ensures traces are sent to both destinations simultaneously.
   */
  instrumentations: [
    /**
     * Fastify instrumentation creates HTTP server spans for every route.
     * When Sentry is enabled, it instruments Fastify automatically so we skip this.
     * https://docs.sentry.io/platforms/javascript/guides/fastify/migration/v7-to-v8/v8-opentelemetry/
     */
    ...(!sentryEnabled && enableAutoInstrumentations
      ? [
          new FastifyOtelInstrumentation({
            registerOnInitialization: true,
            ignorePaths: (opts) => {
              return opts.url.startsWith(config.observability.metrics.endpoint);
            },
          }),
        ]
      : []),
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": {
        enabled: enableAutoInstrumentations,
      },
      "@opentelemetry/instrumentation-undici": {
        enabled: enableAutoInstrumentations,
      },
      "@opentelemetry/instrumentation-pg": {
        enabled: enableAutoInstrumentations,
      },
      "@opentelemetry/instrumentation-dns": {
        enabled: enableAutoInstrumentations,
      },
      "@opentelemetry/instrumentation-net": {
        enabled: enableAutoInstrumentations,
      },
      "@opentelemetry/instrumentation-fs": {
        enabled: false, // File system operations are always noise
      },
      "@opentelemetry/instrumentation-pino": {
        enabled: false, // We handle log-trace correlation and OTEL log sending manually in logging.ts
      },
    }),
  ],
  /**
   * If Sentry is configured, add Sentry components for proper integration
   */
  contextManager: sentryEnabled ? new Sentry.SentryContextManager() : undefined,
  sampler:
    sentryEnabled && sentryClient ? new SentrySampler(sentryClient) : undefined,
  textMapPropagator: sentryEnabled ? new SentryPropagator() : undefined,
  // Use multiple span processors to send traces to both Sentry and OTLP endpoints
  spanProcessors,
  // Export pino logs (with trace context) to the OTLP endpoint
  logRecordProcessors: [new BatchLogRecordProcessor(logExporter)],
});

// Start the SDK
sdk.start();

// Log telemetry configuration details
logger.info(
  {
    sentryEnabled,
    verboseTracing,
    enableAutoInstrumentations,
    otlpFiltering: sentryEnabled && !verboseTracing,
    otlpTraceEndpoint: traceExporterConfig.url,
    otlpLogEndpoint: logExporterConfig.url,
    spanProcessorCount: spanProcessors.length,
    processors: spanProcessors.map((p) => p.constructor.name),
  },
  "OpenTelemetry SDK initialized with trace and log pipelines",
);

// Validate Sentry + OpenTelemetry integration if Sentry is configured
if (sentryClient) {
  try {
    Sentry.validateOpenTelemetrySetup();
    logger.info("Sentry + OpenTelemetry integration validated successfully");
  } catch (error) {
    logger.warn({ error }, "Sentry + OpenTelemetry validation warning");
  }
}

// Gracefully shutdown the SDK on process exit
process.on("SIGTERM", () => {
  sdk
    .shutdown()
    .then(() => logger.info("Tracing terminated"))
    .catch((error) => logger.error("Error terminating tracing", error))
    .finally(() => process.exit(0));
});

export default sdk;
