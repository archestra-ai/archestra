import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import config from "@/config";
import logger from "@/logging";

const {
  api: { name, version },
} = config;

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry tracing with dynamic agent label keys
 * @param labelKeys Array of agent label keys to include as resource attributes
 */
export async function initializeTracing(labelKeys: string[]): Promise<void> {
  // If SDK is already initialized, shutdown and reinitialize
  if (sdk) {
    await sdk.shutdown();
  }

  // Configure the OTLP exporter to send traces to the OpenTelemetry Collector
  const traceExporter = new OTLPTraceExporter({
    url: config.observability.otel.otelExporterOtlpEndpoint,
    headers: {},
  });

  // Create resource attributes object with service info and agent label keys
  const resourceAttributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: name,
    [ATTR_SERVICE_VERSION]: version,
  };

  // Add agent label keys as resource attributes
  // We set them to empty strings initially - they will be populated per-span via context
  // for (const labelKey of labelKeys) {
  //   resourceAttributes[labelKey] = "";
  // }

  // Create a resource with service information and agent label keys
  const resource = defaultResource().merge(
    resourceFromAttributes(resourceAttributes),
  );

  // Initialize the OpenTelemetry SDK with auto-instrumentations
  sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable instrumentation for specific packages if needed
        "@opentelemetry/instrumentation-fs": {
          enabled: false, // File system operations can be noisy
        },
      }),
    ],
  });

  // Start the SDK
  sdk.start();

  logger.info(
    `Tracing initialized with ${labelKeys.length} agent label keys: ${labelKeys.join(", ")}`,
  );

  // Gracefully shutdown the SDK on process exit
  process.on("SIGTERM", () => {
    if (sdk) {
      sdk
        .shutdown()
        .then(() => logger.info("Tracing terminated"))
        .catch((error) => logger.error("Error terminating tracing", error))
        .finally(() => process.exit(0));
    }
  });
}

export function getTracingSDK(): NodeSDK | null {
  return sdk;
}
