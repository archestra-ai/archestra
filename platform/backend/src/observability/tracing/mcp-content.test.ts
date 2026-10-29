import { vi } from "vitest";

// Content capture is read once at import, so it is switched on here.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    observability: { otel: { captureContent: true } },
  }),
);

import { type TracerProvider, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import config from "@/config";
import { afterAll, afterEach, beforeAll, expect, test } from "@/test";
import {
  EVENT_GENAI_CONTENT_INPUT,
  EVENT_GENAI_CONTENT_OUTPUT,
} from "./attributes";
import { startActiveMcpSpan } from "./mcp";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let originalProvider: TracerProvider;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  originalProvider = trace.getTracerProvider();
  trace.disable();
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  exporter.reset();
  config.logs.contentMode = "full";
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  trace.setGlobalTracerProvider(originalProvider);
});

test("Metadata only keeps tool arguments and results out of spans", async ({
  makeAgent,
}) => {
  config.logs.contentMode = "metadata_only";
  const agent = await makeAgent();

  await callTool(agent);

  const [span] = exporter.getFinishedSpans();
  expect(span.attributes["gen_ai.tool.name"]).toBe("gmail__send_email");
  expect(span.events.map((event) => event.name)).toEqual([]);
});

test("Full content still records them when capture is on", async ({
  makeAgent,
}) => {
  const agent = await makeAgent();

  await callTool(agent);

  const [span] = exporter.getFinishedSpans();
  expect(span.events.map((event) => event.name)).toEqual([
    EVENT_GENAI_CONTENT_INPUT,
    EVENT_GENAI_CONTENT_OUTPUT,
  ]);
});

// === Internal helpers ===

function callTool(agent: { id: string; name: string }) {
  return startActiveMcpSpan({
    toolName: "gmail__send_email",
    mcpServerName: "gmail",
    agent,
    toolArgs: { body: "the private email" },
    callback: async () => ({ content: "sent" }),
  });
}
