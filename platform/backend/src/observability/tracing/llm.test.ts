import { type TracerProvider, trace } from "@opentelemetry/api";
import {
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
