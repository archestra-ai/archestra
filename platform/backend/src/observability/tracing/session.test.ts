import { context, type TracerProvider, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { startActiveChatSpan } from "./chat";
import { startActiveLlmSpan } from "./llm";
import { startActiveMcpSpan } from "./mcp";
import { traceOpenappaDispatch } from "./openappa";
import { SessionIdGenerator, sessionTraceId } from "./session";
import { SessionOperationLogProcessor } from "./session-logs";

const exporter = new InMemorySpanExporter();
const logExporter = new InMemoryLogRecordExporter();
const logProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
});
const processor = new SimpleSpanProcessor(exporter);
const provider = new NodeSDK({
  autoDetectResources: false,
  idGenerator: new SessionIdGenerator(),
  spanProcessors: [processor, new SessionOperationLogProcessor()],
});
let original: TracerProvider;
beforeAll(() => {
  original = trace.getTracerProvider();
  trace.disable();
  context.disable();
  provider.start();

  logs.disable();
  logs.setGlobalLoggerProvider(logProvider);
});
afterEach(() => {
  exporter.reset();
  logExporter.reset();
});
afterAll(async () => {
  await provider.shutdown();
  await logProvider.shutdown();
  trace.disable();
  trace.setGlobalTracerProvider(original);
  logs.disable();
  context.disable();
});

test("resumed turns and external inference share the session trace while nested operations keep real parents", async () => {
  const sessionId = "session-resumed";
  const run = () =>
    startActiveChatSpan({
      sessionId,
      agentId: "agent-a",
      agentName: "Test agent",
      callback: async () => {
        await startActiveLlmSpan({
          sessionId,
          operationName: "chat",
          provider: "openai",
          model: "test-model",
          stream: false,
          callback: async () => {
            await Promise.resolve();
            return traceOpenappaDispatch(sessionId, "tool_call", async () => ({
              decision: "allow_call",
            }));
          },
        });
        await startActiveMcpSpan({
          sessionId,
          agent: { id: "agent-a", name: "Test agent" },
          toolName: "test_read",
          mcpServerName: "test",
          callback: async () => "ok",
        });
      },
    });
  await run();
  await run();
  await startActiveLlmSpan({
    sessionId,
    operationName: "chat",
    provider: "openai",
    model: "external-model",
    stream: false,
    callback: async () => {},
  });
  await processor.forceFlush();
  await logProvider.forceFlush();
  const spans = exporter.getFinishedSpans();
  expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(
    new Set([sessionTraceId(sessionId)]),
  );
  expect(new Set(spans.map((s) => s.spanContext().spanId)).size).toBe(
    spans.length,
  );
  const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
  for (const span of spans)
    if (span.parentSpanContext)
      expect(byId.has(span.parentSpanContext.spanId)).toBe(true);
  const hooks = spans.filter((s) => s.name === "guardrails tool_call");
  expect(hooks).toHaveLength(2);
  for (const hook of hooks)
    expect(byId.get(hook.parentSpanContext?.spanId ?? "")?.name).toBe(
      "chat test-model",
    );
  const records = logExporter
    .getFinishedLogRecords()
    .filter((r) => r.attributes.event_name === "archestra.session.operation");
  expect(records).toHaveLength(spans.length);
  expect(
    records.every((r) => r.spanContext?.traceId === sessionTraceId(sessionId)),
  ).toBe(true);
});

test("parallel sessions and nested utility sessions stay isolated; sessionless calls retain normal IDs", async () => {
  await Promise.all(
    ["one", "two"].map((sessionId) =>
      startActiveChatSpan({
        sessionId,
        agentId: "test",
        agentName: "Test",
        callback: async () => {
          await Promise.resolve();
          await startActiveLlmSpan({
            sessionId: `utility-${sessionId}`,
            operationName: "chat",
            provider: "openai",
            model: "utility",
            stream: false,
            callback: async () => {},
          });
        },
      }),
    ),
  );
  const span = trace.getTracer("test").startSpan("sessionless");
  span.end();
  const spans = exporter.getFinishedSpans();
  expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(5);
  expect(
    spans
      .filter((s) => s.name === "chat utility")
      .every((s) => !s.parentSpanContext),
  ).toBe(true);
});

test("failed hooks preserve the error while exported spans and logs omit policy content", async () => {
  await expect(
    traceOpenappaDispatch("session-error", "tool_call", async () => {
      throw new Error("private-policy-payload");
    }),
  ).rejects.toThrow("private-policy-payload");
  await logProvider.forceFlush();
  expect(exporter.getFinishedSpans()[0].status.code).toBe(2);
  expect(
    JSON.stringify(
      exporter.getFinishedSpans().map((s) => ({
        attributes: s.attributes,
        status: s.status,
        events: s.events,
      })),
    ),
  ).not.toContain("private-policy-payload");
  expect(JSON.stringify(logExporter.getFinishedLogRecords())).not.toContain(
    "private-policy-payload",
  );
});
