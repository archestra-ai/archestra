# Observability with OpenTelemetry and Jaeger

This project includes distributed tracing using OpenTelemetry and Jaeger for monitoring and debugging API requests.

## Overview

The observability stack consists of:

- **OpenTelemetry SDK**: Instruments the Fastify application to collect traces
- **OpenTelemetry Collector**: Receives traces from the application and forwards them to Jaeger
- **Jaeger**: Stores and visualizes distributed traces

## Architecture

```
[Fastify App] --traces--> [OTel Collector] --traces--> [Jaeger]
                                                           |
                                                   [Jaeger UI (Browser)]
```

## Quick Start

### Local Development with Tilt

When running the application with Tilt, the observability stack is automatically deployed:

```bash
tilt up
```

This will start:
- **Jaeger UI**: http://localhost:16686
- **OTel Collector**: Listening on ports 4317 (gRPC) and 4318 (HTTP)

### Viewing Traces

1. Open Jaeger UI at http://localhost:16686
2. Select "archestra" from the Service dropdown
3. Click "Find Traces" to see all traces
4. Click on any trace to see detailed span information

## Configuration

### Environment Variables

The OpenTelemetry exporter endpoint can be configured via environment variables:

```bash
# In your .env file
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

### Trace Collection

The application automatically collects traces for:

- **HTTP requests**: All incoming API requests to Fastify
- **Database queries**: PostgreSQL queries via auto-instrumentation
- **HTTP client requests**: Outgoing HTTP calls (e.g., to LLM providers)
- **Custom spans**: Can be added in application code (see below)

## Adding Custom Spans

To add custom tracing to your code:

```typescript
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("my-service");

async function myFunction() {
  return tracer.startActiveSpan("myFunction", async (span) => {
    try {
      // Your code here
      span.setAttribute("custom.attribute", "value");

      const result = await doSomething();

      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

## Troubleshooting

### No traces appearing in Jaeger

1. Check that the OTel Collector is running:
   ```bash
   kubectl get pods -n archestra-dev | grep otel-collector
   ```

2. Check the collector logs for errors:
   ```bash
   kubectl logs -n archestra-dev deployment/otel-collector -f
   ```

3. Verify the backend can reach the collector:
   ```bash
   curl http://localhost:4318/v1/traces
   ```

### Traces are incomplete

- Check that all services are instrumented correctly
- Verify that trace context is being propagated in HTTP headers
- Look for errors in the application logs

## Production Considerations

For production deployments:

1. **Storage**: Switch from in-memory to persistent storage (e.g., Elasticsearch, Cassandra)
2. **Sampling**: Configure sampling to reduce trace volume:
   ```typescript
   // In tracing.ts
   import { TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-node";

   const sdk = new NodeSDK({
     sampler: new TraceIdRatioBasedSampler(0.1), // Sample 10% of traces
     // ... other config
   });
   ```
3. **Security**: Add authentication to Jaeger UI
4. **Retention**: Configure trace retention policies
5. **Performance**: Monitor collector resource usage and scale as needed

## Resources

- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [@fastify/otel Plugin](https://github.com/fastify/fastify-otel)
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
