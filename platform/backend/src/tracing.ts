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

const {
  api: { name, version },
} = config;

// Configure the OTLP exporter to send traces to the OpenTelemetry Collector
const traceExporter = new OTLPTraceExporter({
  url:
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    "http://localhost:4318/v1/traces",
  headers: {},
});

// Create a resource with service information
const resource = defaultResource().merge(
  resourceFromAttributes({
    [ATTR_SERVICE_NAME]: name,
    [ATTR_SERVICE_VERSION]: version,
  }),
);

// Initialize the OpenTelemetry SDK with auto-instrumentations
const sdk = new NodeSDK({
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

// Gracefully shutdown the SDK on process exit
process.on("SIGTERM", () => {
  sdk
    .shutdown()
    .then(() => console.log("Tracing terminated"))
    .catch((error) => console.log("Error terminating tracing", error))
    .finally(() => process.exit(0));
});

export default sdk;
