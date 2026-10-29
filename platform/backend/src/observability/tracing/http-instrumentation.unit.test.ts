import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { SpanKind } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeEach, expect, test, vi } from "vitest";
import { getHttpInstrumentationConfig } from "./http-instrumentation";

beforeEach(() => {
  vi.stubEnv("OTEL_NODE_ENABLED_INSTRUMENTATIONS", "http");
  vi.stubEnv("OTEL_NODE_DISABLED_INSTRUMENTATIONS", "");
});

test("avoids duplicate inbound spans while preserving configured HTTP traces", async () => {
  const scenarios = [
    {
      name: "retains inbound and outbound traces in verbose mode alone",
      enabled: true,
      errorTrackingEnabled: false,
      serverSpans: 3,
      clientSpans: 3,
    },
    {
      name: "keeps outbound traces without duplicate inbound traces",
      enabled: true,
      errorTrackingEnabled: true,
      serverSpans: 0,
      clientSpans: 3,
    },
    {
      name: "leaves infrastructure tracing off when disabled",
      enabled: false,
      errorTrackingEnabled: false,
      serverSpans: 0,
      clientSpans: 0,
    },
  ];
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const instrumentations = getNodeAutoInstrumentations({
    "@opentelemetry/instrumentation-http": getHttpInstrumentationConfig(
      scenarios[0],
    ),
  });
  for (const instrumentation of instrumentations) {
    instrumentation.setTracerProvider(provider);
  }
  // Load after enabling instrumentation so the real HTTP boundary is patched.
  const http = createRequire(import.meta.url)(
    "node:http",
  ) as typeof import("node:http");
  const server = http.createServer((_request, response) => {
    response.end("ok");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    for (const scenario of scenarios) {
      exporter.reset();
      for (const instrumentation of instrumentations) {
        // Unpatch using the previous options before changing directions.
        instrumentation.disable();
        instrumentation.setConfig(getHttpInstrumentationConfig(scenario));
        if (scenario.enabled) instrumentation.enable();
      }
      for (const path of ["/ready", "/v1/mcp/example", "/api/example"]) {
        await new Promise<void>((resolve, reject) => {
          http
            .get(`http://127.0.0.1:${port}${path}`, (response) => {
              response.resume();
              response.once("end", resolve);
              response.once("error", reject);
            })
            .once("error", reject);
        });
      }
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(
        {
          server: spans.filter((span) => span.kind === SpanKind.SERVER).length,
          client: spans.filter((span) => span.kind === SpanKind.CLIENT).length,
        },
        scenario.name,
      ).toEqual({
        server: scenario.serverSpans,
        client: scenario.clientSpans,
      });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const instrumentation of instrumentations) instrumentation.disable();
    await provider.shutdown();
  }
});
