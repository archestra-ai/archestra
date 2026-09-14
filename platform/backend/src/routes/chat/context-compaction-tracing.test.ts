import { randomUUID } from "node:crypto";
import { context, type TracerProvider, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  ATTR_ROUTE_CATEGORY,
  RouteCategory,
} from "@/observability/tracing/attributes";
import { startActiveChatSpan } from "@/observability/tracing/chat";
import { compactMessagesForChat } from "./context-compaction";

describe("context compaction tracing", () => {
  const exporter = new InMemorySpanExporter();
  let sdk: NodeSDK;
  let originalProvider: TracerProvider;

  beforeAll(() => {
    originalProvider = trace.getTracerProvider();
    trace.disable();
    sdk = new NodeSDK({
      autoDetectResources: false,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      logRecordProcessors: [],
    });
    sdk.start();
  });

  afterEach(() => exporter.reset());

  afterAll(async () => {
    await sdk.shutdown();
    trace.disable();
    context.disable();
    trace.setGlobalTracerProvider(originalProvider);
  });

  test.each([
    RouteCategory.CHAT,
    RouteCategory.A2A,
    RouteCategory.CHATOPS,
    RouteCategory.EMAIL,
  ])("preserves %s through an intermediate async span", async (routeCategory) => {
    await startActiveChatSpan({
      agentId: randomUUID(),
      agentName: "Test Agent",
      routeCategory,
      callback: () =>
        trace
          .getTracer("archestra")
          .startActiveSpan("intermediate", async (span) => {
            try {
              await Promise.resolve();
              const result = await compactMessagesForChat(compactionParams());
              expect(result.status).toBe("skipped");
            } finally {
              span.end();
            }
          }),
    });

    const spans = exporter.getFinishedSpans();
    const compaction = spans.find(
      (span) => span.name === "context_compaction auto",
    );
    const parent = spans.find((span) => span.name === "intermediate");
    expect(compaction?.attributes[ATTR_ROUTE_CATEGORY]).toBe(routeCategory);
    expect(compaction?.attributes["archestra.context_compaction.reason"]).toBe(
      "below_threshold",
    );
    expect(compaction?.parentSpanContext?.spanId).toBe(
      parent?.spanContext().spanId,
    );
    expect(compaction?.spanContext().traceId).toBe(
      parent?.spanContext().traceId,
    );
  });

  test("uses chat for standalone manual compaction after an email invocation", async () => {
    await startActiveChatSpan({
      agentId: randomUUID(),
      agentName: "Test Agent",
      routeCategory: RouteCategory.EMAIL,
      callback: async () => {},
    });
    await compactMessagesForChat({ ...compactionParams(), trigger: "manual" });

    const compaction = exporter
      .getFinishedSpans()
      .find((span) => span.name === "context_compaction manual");
    expect(compaction?.attributes[ATTR_ROUTE_CATEGORY]).toBe(
      RouteCategory.CHAT,
    );
    expect(compaction?.attributes["archestra.context_compaction.reason"]).toBe(
      "nothing_to_compact",
    );
  });
});

function compactionParams(): Parameters<typeof compactMessagesForChat>[0] {
  return {
    conversationId: randomUUID(),
    organizationId: randomUUID(),
    userId: randomUUID(),
    provider: "openai",
    selectedModel: "gpt-4o-mini",
    messages: [],
    trigger: "auto",
  };
}
