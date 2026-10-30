import { type TracerProvider, trace } from "@opentelemetry/api";
import {
  AlwaysOffSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { startActiveLlmSpan } from "./llm";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let original: TracerProvider;
beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  original = trace.getTracerProvider();
  trace.disable();
  trace.setGlobalTracerProvider(provider);
});
afterEach(() => {
  exporter.reset();
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  trace.setGlobalTracerProvider(original);
});

test("exports both virtual-key identities without exposing credential values", async () => {
  await startActiveLlmSpan({
    operationName: "chat",
    provider: "openai",
    model: "gpt-4o",
    stream: false,
    authMethod: "virtual_key",
    virtualKeyId: "standard-key-id",
    passthroughVirtualKeyId: "identity-key-id",
    callback: async () => {},
  });
  const [span] = exporter.getFinishedSpans();
  expect(span.attributes).toMatchObject({
    "archestra.auth.method": "virtual_key",
    "archestra.virtual_key.id": "standard-key-id",
    "archestra.passthrough_virtual_key.id": "identity-key-id",
  });
});

test("encrypted request errors cannot export prompt text through span status", async () => {
  await expect(
    startActiveLlmSpan({
      operationName: "chat",
      provider: "openai",
      model: "gpt-4o",
      stream: true,
      suppressContent: true,
      callback: async () => {
        throw new Error("private prompt echoed by provider");
      },
    }),
  ).rejects.toThrow("private prompt");
  const [span] = exporter.getFinishedSpans();
  expect(span.status.code).toBe(2);
  expect(span.status.message).toBeUndefined();
  expect(
    JSON.stringify({ attributes: span.attributes, events: span.events }),
  ).not.toContain("private prompt");
});

test("exports OAuth application attribution with no virtual-key identity", async () => {
  await startActiveLlmSpan({
    operationName: "chat",
    provider: "openai",
    model: "gpt-4o",
    stream: true,
    authMethod: "oauth_client_credentials",
    authenticatedApp: {
      id: "app-id",
      name: "Build service",
      clientId: "client-id",
    },
    callback: async () => {},
  });
  const [span] = exporter.getFinishedSpans();
  expect(span.attributes).toMatchObject({
    "archestra.auth.method": "oauth_client_credentials",
    "archestra.app.id": "app-id",
    "archestra.app.name": "Build service",
  });
  expect(span.attributes["archestra.virtual_key.id"]).toBeUndefined();
});

test("unsampled spans propagate identity and execute the request without materializing content", async () => {
  const unsampled = new BasicTracerProvider({
    sampler: new AlwaysOffSampler(),
  });
  trace.disable();
  trace.setGlobalTracerProvider(unsampled);
  let called = false;
  try {
    const result = await startActiveLlmSpan({
      operationName: "chat",
      provider: "openai",
      model: "synthetic-model",
      stream: false,
      getPromptMessages: () => {
        throw new Error(
          "Content must not be materialized for an unsampled span",
        );
      },
      callback: async (span) => {
        called = true;
        expect(span.isRecording()).toBe(false);
        expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
        return "completed";
      },
    });
    expect(result).toBe("completed");
    expect(called).toBe(true);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  } finally {
    await unsampled.shutdown();
    trace.disable();
    trace.setGlobalTracerProvider(provider);
  }
});
