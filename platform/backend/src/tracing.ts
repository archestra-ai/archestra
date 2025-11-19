import { FastifyOtelInstrumentation } from "@fastify/otel";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
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
    otel: { traceExporter: traceExporterConfig },
    sentry: { enabled: sentryEnabled },
  },
} = config;

// Configure the OTLP exporter to send traces to the OpenTelemetry Collector
const traceExporter = new OTLPTraceExporter(traceExporterConfig);

// Create a resource with service information
const resource = defaultResource().merge(
  resourceFromAttributes({
    [ATTR_SERVICE_NAME]: name,
    [ATTR_SERVICE_VERSION]: version,
  }),
);

// Create span processors array
// Always include the OTLP exporter for regular telemetry
const spanProcessors: SpanProcessor[] = [new BatchSpanProcessor(traceExporter)];

// Add Sentry span processor if Sentry is enabled
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
   * 2. SentrySpanProcessor (when enabled) - sends traces to Sentry
   *
   * This ensures traces are sent to both destinations simultaneously.
   */
  instrumentations: [
    /**
     * If Sentry is configured, we don't need to instrument Fastify
     * as Sentry already instruments Fastify automatically
     * https://docs.sentry.io/platforms/javascript/guides/fastify/migration/v7-to-v8/v8-opentelemetry/
     */
    ...(sentryEnabled
      ? []
      : [
          new FastifyOtelInstrumentation({
            registerOnInitialization: true,
            ignorePaths: (opts) => {
              return opts.url.startsWith(config.observability.metrics.endpoint);
            },
          }),
        ]),
    getNodeAutoInstrumentations({
      // Disable instrumentation for specific packages if needed
      "@opentelemetry/instrumentation-fs": {
        enabled: false, // File system operations can be noisy
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
});

// Start the SDK
sdk.start();

// Log telemetry configuration details
logger.info(
  {
    sentryEnabled,
    otlpEndpoint: traceExporterConfig.url,
    spanProcessorCount: spanProcessors.length,
    processors: spanProcessors.map((p) => p.constructor.name),
  },
  "OpenTelemetry SDK initialized with multiple span processors",
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
