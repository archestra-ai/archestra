import { ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import client from "prom-client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  getLlmProxyRequestTelemetry,
  LlmProxyRequestTelemetry,
} from "./llm-proxy-request";
import { initializeLlmProxyMetrics } from "./metrics/llm-proxy";

let exporter: InMemoryLogRecordExporter;
let provider: LoggerProvider;
beforeEach(() => {
  client.register.clear();
  initializeLlmProxyMetrics();
  logs.disable();
  exporter = new InMemoryLogRecordExporter();
  provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  logs.setGlobalLoggerProvider(provider);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await provider.shutdown();
  logs.disable();
  client.register.clear();
});

async function counts() {
  const metric = await (
    client.register.getSingleMetric("llm_proxy_request_duration_seconds") as
      | client.Histogram
      | undefined
  )?.get();
  return (
    metric?.values.filter((value) => value.metricName?.endsWith("_count")) ?? []
  );
}

test("router and provider completion count one request, with full duration and no attempt labels", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const request = {};
  const router = getLlmProxyRequestTelemetry({
    request,
    provider: "router",
    operation: "chat",
    stream: true,
  });
  now += 300;
  const handler = getLlmProxyRequestTelemetry({
    request,
    provider: "openai",
    operation: "chat",
    stream: true,
  });
  now += 2000;
  handler.finish({ statusCode: 200, headersSent: true, disconnected: false });
  router.finish({ statusCode: 200, headersSent: true, disconnected: false });
  expect(await counts()).toEqual([
    expect.objectContaining({
      value: 1,
      labels: {
        provider: "openai",
        operation: "chat",
        stream: "true",
        outcome: "success",
        error_origin: "none",
        status_code: "200",
      },
    }),
  ]);
  const metric = await (
    client.register.getSingleMetric("llm_proxy_request_duration_seconds") as
      | client.Histogram
      | undefined
  )?.get();
  expect(
    metric?.values.find((value) => value.metricName?.endsWith("_sum"))?.value,
  ).toBe(2.3);
  expect(exporter.getFinishedLogRecords()).toHaveLength(1);
});

test("a provider throttle after stream commitment keeps HTTP 200 and exports the failure independently of sampling", async () => {
  const telemetry = new LlmProxyRequestTelemetry({
    provider: "anthropic",
    operation: "chat",
    stream: true,
  });
  const spanContext = {
    traceId: "12345678901234567890123456789012",
    spanId: "1234567890123456",
    traceFlags: TraceFlags.NONE,
  };
  telemetry.setTraceContext(trace.setSpanContext(ROOT_CONTEXT, spanContext));
  telemetry.fail({ statusCode: 429, origin: "provider", outcome: "throttled" });
  telemetry.finish({ statusCode: 200, headersSent: true, disconnected: false });
  await provider.forceFlush();
  expect(await counts()).toEqual([
    expect.objectContaining({
      value: 1,
      labels: expect.objectContaining({
        status_code: "200",
        outcome: "throttled",
        error_origin: "provider",
      }),
    }),
  ]);
  const [record] = exporter.getFinishedLogRecords();
  expect(record.spanContext).toEqual(spanContext);
  expect(record.attributes).toMatchObject({
    "http.response.status_code": 200,
    "error.type": "429",
    "archestra.proxy.outcome": "throttled",
  });
});

test("preflight refusal exports without an LLM span and anonymous inputs cannot create metric dimensions", async () => {
  for (let i = 0; i < 10; i++) {
    const telemetry = new LlmProxyRequestTelemetry({
      provider: "router",
      operation: "chat",
      stream: false,
    });
    telemetry.finish({
      statusCode: 402,
      headersSent: false,
      disconnected: false,
    });
  }
  expect(await counts()).toEqual([
    expect.objectContaining({
      value: 10,
      labels: expect.objectContaining({
        provider: "router",
        status_code: "402",
        error_origin: "archestra",
        outcome: "denied",
      }),
    }),
  ]);
});

test("only allowlisted attribution reaches OTEL and model/consumer values do not multiply metric series", async () => {
  for (let i = 0; i < 2; i++) {
    const telemetry = new LlmProxyRequestTelemetry({
      provider: "openai",
      operation: "chat",
      stream: false,
    });
    Object.assign(telemetry.metadata, {
      model: `model-${i}`,
      userId: `user-${i}`,
      virtualKeyId: `key-id-${i}`,
      prompt: "private prompt",
      headers: { authorization: "secret credential" },
      email: "private@example.com",
    });
    telemetry.finish({
      statusCode: 200,
      headersSent: false,
      disconnected: false,
    });
  }
  expect(await counts()).toEqual([expect.objectContaining({ value: 2 })]);
  const records = exporter.getFinishedLogRecords();
  expect(records[0].attributes).toMatchObject({
    "gen_ai.request.model": "model-0",
    "archestra.user.id": "user-0",
    "archestra.virtual_key.id": "key-id-0",
  });
  expect(
    JSON.stringify(
      records.map((record) => ({
        body: record.body,
        attributes: record.attributes,
      })),
    ),
  ).not.toMatch(/private|secret credential|authorization/);
});

test("a normal incomplete terminal is distinct from a provider error", async () => {
  const telemetry = new LlmProxyRequestTelemetry({
    provider: "openai",
    operation: "chat",
    stream: true,
  });
  telemetry.markIncomplete();
  telemetry.finish({ statusCode: 200, headersSent: true, disconnected: false });
  expect(await counts()).toEqual([
    expect.objectContaining({
      value: 1,
      labels: expect.objectContaining({
        outcome: "incomplete",
        error_origin: "none",
        status_code: "200",
      }),
    }),
  ]);
  const [record] = exporter.getFinishedLogRecords();
  expect(record.attributes["error.type"]).toBeUndefined();
});

test("disconnect during failover supersedes the member failure", async () => {
  const telemetry = new LlmProxyRequestTelemetry({
    provider: "openai",
    operation: "chat",
    stream: true,
  });
  telemetry.fail({ statusCode: 429, origin: "provider", outcome: "throttled" });
  telemetry.finish({ statusCode: 200, headersSent: true, disconnected: true });
  expect(await counts()).toEqual([
    expect.objectContaining({
      value: 1,
      labels: expect.objectContaining({
        outcome: "cancelled",
        error_origin: "client",
      }),
    }),
  ]);
});

test("a server-aborted binary response retains the provider failure", async () => {
  const telemetry = new LlmProxyRequestTelemetry({
    provider: "openai",
    operation: "chat",
    stream: true,
  });
  telemetry.fail({ statusCode: 502, origin: "provider", outcome: "error" });
  telemetry.markServerAbort();
  telemetry.finish({ statusCode: 200, headersSent: true, disconnected: true });
  expect(await counts()).toEqual([
    expect.objectContaining({
      value: 1,
      labels: expect.objectContaining({
        outcome: "error",
        error_origin: "provider",
      }),
    }),
  ]);
});

test("a settlement failure supersedes an earlier policy denial", async () => {
  const telemetry = new LlmProxyRequestTelemetry({
    provider: "openai",
    operation: "chat",
    stream: true,
  });
  telemetry.fail({ statusCode: 403, origin: "archestra", outcome: "denied" });
  telemetry.fail({ statusCode: 503, origin: "archestra", outcome: "error" });
  telemetry.finish({ statusCode: 200, headersSent: true, disconnected: false });
  expect(await counts()).toEqual([
    expect.objectContaining({
      value: 1,
      labels: expect.objectContaining({ status_code: "200", outcome: "error" }),
    }),
  ]);
  expect(exporter.getFinishedLogRecords()[0].attributes["error.type"]).toBe(
    "503",
  );
});

test("export failures never alter request behavior and an unfinished disconnected stream is cancelled", async () => {
  vi.spyOn(logs, "getLogger").mockImplementation(() => {
    throw new Error("export unavailable");
  });
  const telemetry = new LlmProxyRequestTelemetry({
    provider: "openai",
    operation: "chat",
    stream: true,
  });
  expect(() =>
    telemetry.finish({
      statusCode: 200,
      headersSent: true,
      disconnected: true,
    }),
  ).not.toThrow();
  expect(await counts()).toEqual([
    expect.objectContaining({
      value: 1,
      labels: expect.objectContaining({
        outcome: "cancelled",
        error_origin: "client",
      }),
    }),
  ]);
});
