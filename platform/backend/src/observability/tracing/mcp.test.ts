import {
  context,
  SpanStatusCode,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { SESSION_ID_KEY } from "@/observability/request-context";
import { RouteCategory } from "./attributes";
import { recordBlockedToolSpans } from "./mcp";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let originalProvider: TracerProvider;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  originalProvider = trace.getTracerProvider();
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  exporter.reset();
});

afterAll(() => {
  provider.shutdown();
  // Restore original provider
  trace.setGlobalTracerProvider(originalProvider);
});

describe("recordBlockedToolSpans", () => {
  test("creates spans for each blocked tool call with correct attributes", () => {
    recordBlockedToolSpans({
      toolCallNames: ["github__list_repos", "slack__send_message"],
      blockedReason:
        "Tool invocation blocked: policy is configured to always block tool call",
      agent: { id: "agent-123", name: "test-agent" },
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);

    // First span - github tool
    const githubSpan = spans.find((s) => s.name.includes("github__list_repos"));
    expect(githubSpan).toBeDefined();
    expect(githubSpan?.name).toBe("execute_tool github__list_repos");
    expect(githubSpan?.attributes["route.category"]).toBe(
      RouteCategory.MCP_GATEWAY,
    );
    expect(githubSpan?.attributes["gen_ai.operation.name"]).toBe(
      "execute_tool",
    );
    expect(githubSpan?.attributes["gen_ai.tool.name"]).toBe(
      "github__list_repos",
    );
    expect(githubSpan?.attributes["gen_ai.tool.type"]).toBe("function");
    expect(githubSpan?.attributes["mcp.server.name"]).toBe("github");
    expect(githubSpan?.attributes["gen_ai.agent.id"]).toBe("agent-123");
    expect(githubSpan?.attributes["gen_ai.agent.name"]).toBe("test-agent");
    expect(githubSpan?.attributes["mcp.blocked"]).toBe(true);
    expect(githubSpan?.attributes["mcp.blocked_reason"]).toBe(
      "Tool invocation blocked: policy is configured to always block tool call",
    );
    expect(githubSpan?.status.code).toBe(SpanStatusCode.ERROR);

    // Second span - slack tool
    const slackSpan = spans.find((s) => s.name.includes("slack__send_message"));
    expect(slackSpan).toBeDefined();
    expect(slackSpan?.attributes["mcp.server.name"]).toBe("slack");
    expect(slackSpan?.attributes["mcp.blocked"]).toBe(true);
  });

  test("extracts mcp server name from tool name prefix", () => {
    recordBlockedToolSpans({
      toolCallNames: ["my_server__do_thing"],
      blockedReason: "blocked",
      agent: { id: "agent-1", name: "test" },
    });

    const spans = exporter.getFinishedSpans();
    expect(spans[0].attributes["mcp.server.name"]).toBe("my_server");
  });

  test("uses 'unknown' server name when tool name has no prefix", () => {
    recordBlockedToolSpans({
      toolCallNames: ["simple_tool"],
      blockedReason: "blocked",
      agent: { id: "agent-1", name: "test" },
    });

    const spans = exporter.getFinishedSpans();
    expect(spans[0].attributes["mcp.server.name"]).toBe("unknown");
  });

  test("sets optional attributes when provided", () => {
    recordBlockedToolSpans({
      toolCallNames: ["github__list_repos"],
      blockedReason: "blocked",
      agent: {
        id: "agent-1",
        name: "test",
        labels: [{ key: "env", value: "prod" }],
      },
      sessionId: "session-xyz",
      agentType: "agent",
      user: { id: "user-1", email: "test@test.com", name: "Test User" },
    });

    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.conversation.id"]).toBe("session-xyz");
    expect(span.attributes["archestra.agent.type"]).toBe("agent");
    expect(span.attributes["archestra.label.env"]).toBe("prod");
    expect(span.attributes["archestra.user.id"]).toBe("user-1");
    expect(span.attributes["archestra.user.email"]).toBe("test@test.com");
    expect(span.attributes["archestra.user.name"]).toBe("Test User");
  });

  test("creates no spans when toolCallNames is empty", () => {
    recordBlockedToolSpans({
      toolCallNames: [],
      blockedReason: "blocked",
      agent: { id: "agent-1", name: "test" },
    });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  test("inherits session ID into OTEL context", () => {
    const sessionId = "test-session-id";

    // Run within a context that has the session ID set
    const ctx = context.active().setValue(SESSION_ID_KEY, sessionId);
    context.with(ctx, () => {
      recordBlockedToolSpans({
        toolCallNames: ["github__list_repos"],
        blockedReason: "blocked",
        agent: { id: "agent-1", name: "test" },
        sessionId,
      });
    });

    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes["gen_ai.conversation.id"]).toBe(sessionId);
  });
});
