/**
 * LLM Proxy Helpers Tests
 *
 * Unit tests for shared helper functions extracted from llm-proxy-handler.ts.
 */

import { ApiError, ArchestraInternalErrorCode } from "@archestra/shared";
import { context as otelContext } from "@opentelemetry/api";
import type { FastifyReply } from "fastify";
import { vi } from "vitest";
import { SESSION_ID_KEY } from "@/observability/request-context";
import { describe, expect, test } from "@/test";
import type { Agent, ToolCompressionStats } from "@/types";

// Mock prom-client (required by metrics)
vi.mock("prom-client", () => ({
  default: {
    Counter: class {
      inc = vi.fn();
    },
    Histogram: class {
      observe = vi.fn();
    },
    register: { removeSingleMetric: vi.fn() },
  },
}));

// Mock cost-optimization
const mockCalculateCost =
  vi.fn<
    (
      model: string,
      inputTokens: number | null | undefined,
      outputTokens: number | null | undefined,
      provider: string,
    ) => Promise<number | undefined>
  >();
const mockCalculateCacheCost =
  vi.fn<
    (
      model: string,
      provider: string,
      readTokens: number,
      writeTokens: number,
    ) => Promise<
      | { cacheCost: number; cacheSavings: number; cacheReadSavings: number }
      | undefined
    >
  >();
vi.mock("@/routes/proxy/utils/cost-optimization", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/routes/proxy/utils/cost-optimization")
    >();
  return {
    ...original,
    calculateCost: (...args: Parameters<typeof mockCalculateCost>) =>
      mockCalculateCost(...args),
    calculateCacheCost: (...args: Parameters<typeof mockCalculateCacheCost>) =>
      mockCalculateCacheCost(...args),
  };
});

// Mock tracing
const mockRecordBlockedToolSpans = vi.fn();
vi.mock("@/observability/tracing", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/observability/tracing")>();
  return {
    ...original,
    recordBlockedToolSpans: (...args: unknown[]) =>
      mockRecordBlockedToolSpans(...args),
  };
});

// Mock metrics
vi.mock("@/observability");

// Import after mocks
import { metrics } from "@/observability";
import { upstreamHttpError } from "./adapters/upstream-http-error";
import {
  buildInteractionRecord,
  calculateInteractionCosts,
  handleError,
  normalizeToolCallsForPolicy,
  planDispatchModeToolCallRewrites,
  recordBlockedToolCallMetrics,
  shouldForwardAnthropicBeta,
  toSpanUserInfo,
  withSessionContext,
} from "./llm-proxy-helpers";

// --------------------------------------------------------------------------
// toSpanUserInfo
// --------------------------------------------------------------------------
describe("toSpanUserInfo", () => {
  test("returns { id, email, name } for a valid user", () => {
    const user = { id: "u1", email: "a@b.com", name: "Alice" };
    expect(toSpanUserInfo(user)).toEqual({
      id: "u1",
      email: "a@b.com",
      name: "Alice",
    });
  });

  test.each([null, undefined])("returns null for %s input", (input) => {
    expect(toSpanUserInfo(input)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// planDispatchModeToolCallRewrites
// --------------------------------------------------------------------------
describe("planDispatchModeToolCallRewrites", () => {
  const DISPATCH_PAIR = new Set([
    "archestra__search_tools",
    "archestra__run_tool",
  ]);

  test("re-addresses a direct call to run_tool, preserving id and arguments", () => {
    const result = planDispatchModeToolCallRewrites({
      toolCalls: [
        {
          id: "call_1",
          name: "gh-developer-agent__pull_request_read",
          arguments: '{"pullNumber":7}',
        },
      ],
      enabledToolNames: DISPATCH_PAIR,
    });

    expect(result).toEqual([
      {
        id: "call_1",
        name: "archestra__run_tool",
        arguments: JSON.stringify({
          tool_name: "gh-developer-agent__pull_request_read",
          tool_args: { pullNumber: 7 },
        }),
      },
    ]);
  });

  test("rewrites only the direct calls in a mixed batch, keeping order", () => {
    const result = planDispatchModeToolCallRewrites({
      toolCalls: [
        {
          id: "a",
          name: "archestra__search_tools",
          arguments: '{"query":"pr"}',
        },
        { id: "b", name: "gh__read", arguments: "{}" },
      ],
      enabledToolNames: DISPATCH_PAIR,
    });

    expect(result?.map((call) => [call.id, call.name])).toEqual([
      ["a", "archestra__search_tools"],
      ["b", "archestra__run_tool"],
    ]);
  });

  // Two calls at the same tool is the shape the original report showed; both
  // must be repaired, not deduplicated — they carry different arguments.
  test("rewrites repeated calls at the same tool independently", () => {
    const result = planDispatchModeToolCallRewrites({
      toolCalls: [
        { id: "a", name: "gh__read", arguments: '{"n":1}' },
        { id: "b", name: "gh__read", arguments: '{"n":2}' },
      ],
      enabledToolNames: DISPATCH_PAIR,
    });

    expect(result).toHaveLength(2);
    expect(JSON.parse(result?.[0].arguments ?? "{}").tool_args).toEqual({
      n: 1,
    });
    expect(JSON.parse(result?.[1].arguments ?? "{}").tool_args).toEqual({
      n: 2,
    });
  });

  // `full` exposure: a tool missing from the list really is disabled there, and
  // run_tool is not the answer — the existing refusal must stand.
  test("returns null when the tool list carries no dispatch pair", () => {
    expect(
      planDispatchModeToolCallRewrites({
        toolCalls: [{ id: "a", name: "gh__read", arguments: "{}" }],
        enabledToolNames: new Set(["gh__write"]),
      }),
    ).toBeNull();
  });

  test("returns null when search_tools is present without run_tool", () => {
    expect(
      planDispatchModeToolCallRewrites({
        toolCalls: [{ id: "a", name: "gh__read", arguments: "{}" }],
        enabledToolNames: new Set(["archestra__search_tools"]),
      }),
    ).toBeNull();
  });

  test("returns null when every call is already directly callable", () => {
    expect(
      planDispatchModeToolCallRewrites({
        toolCalls: [
          { id: "a", name: "archestra__search_tools", arguments: "{}" },
        ],
        enabledToolNames: DISPATCH_PAIR,
      }),
    ).toBeNull();
  });

  test("does not wrap a genuine run_tool dispatch a second time", () => {
    expect(
      planDispatchModeToolCallRewrites({
        toolCalls: [
          {
            id: "a",
            name: "archestra__run_tool",
            arguments: '{"tool_name":"gh__read","tool_args":{}}',
          },
        ],
        enabledToolNames: DISPATCH_PAIR,
      }),
    ).toBeNull();
  });

  // `tool_args` has to be an object; anything else cannot be re-wrapped
  // faithfully, so the call is left for the existing steer rather than
  // dispatched in a shape the model did not ask for.
  test.each([
    ["unparsable arguments", "not json"],
    ["a JSON array", "[1,2]"],
    ["a JSON scalar", '"hello"'],
  ])("leaves a call with %s untouched", (_label, args) => {
    expect(
      planDispatchModeToolCallRewrites({
        toolCalls: [{ id: "a", name: "gh__read", arguments: args }],
        enabledToolNames: DISPATCH_PAIR,
      }),
    ).toBeNull();
  });

  // `run_tool` expands a bare Archestra short name to its built-in, so
  // dispatching one would run a different — and policy-bypassed — tool than the
  // model named. Refusing is the safe outcome.
  test("leaves a name that collides with an Archestra short name untouched", () => {
    expect(
      planDispatchModeToolCallRewrites({
        toolCalls: [
          {
            id: "a",
            name: "read_file",
            arguments: '{"file_path":"/etc/passwd"}',
          },
        ],
        enabledToolNames: DISPATCH_PAIR,
      }),
    ).toBeNull();
  });

  test("treats empty arguments as an empty object", () => {
    const result = planDispatchModeToolCallRewrites({
      toolCalls: [{ id: "a", name: "gh__read", arguments: "" }],
      enabledToolNames: DISPATCH_PAIR,
    });
    expect(JSON.parse(result?.[0].arguments ?? "{}")).toEqual({
      tool_name: "gh__read",
      tool_args: {},
    });
  });

  test("canonicalizes a client-decorated name before dispatching it", () => {
    const result = planDispatchModeToolCallRewrites({
      toolCalls: [{ id: "a", name: "mcp__gw__gh__read", arguments: "{}" }],
      enabledToolNames: DISPATCH_PAIR,
      canonicalizeToolName: (name) => name.replace("mcp__gw__", ""),
    });
    expect(JSON.parse(result?.[0].arguments ?? "{}").tool_name).toBe(
      "gh__read",
    );
  });

  // Regression: the app-authoring built-ins are hidden from the tool list under
  // `search_and_run_only` exactly like a third-party tool, so a direct call to
  // one needs the same repair. Exempting every built-in from the rewrite left
  // these calls neither repaired nor refused — they reached the caller as a
  // name it never declared and died there as an unknown-tool error.
  test.each([
    "archestra__read_app",
    "archestra__edit_app",
    "archestra__list_apps",
    "archestra__render_app",
  ])("re-addresses a direct call to %s through run_tool", (toolName) => {
    const result = planDispatchModeToolCallRewrites({
      toolCalls: [
        { id: "call_1", name: toolName, arguments: '{"appId":"a1"}' },
      ],
      enabledToolNames: DISPATCH_PAIR,
    });

    expect(result).toEqual([
      {
        id: "call_1",
        name: "archestra__run_tool",
        arguments: JSON.stringify({
          tool_name: toolName,
          tool_args: { appId: "a1" },
        }),
      },
    ]);
  });

  // The other half of the contract: built-ins that `filterExposedTools` keeps
  // top-level in every exposure mode are genuinely directly callable, so
  // wrapping them would add a pointless dispatch hop.
  test.each([
    "archestra__read_file",
    "archestra__run_command",
    "archestra__load_skill",
    "archestra__list_skills",
  ])("leaves the always-exposed built-in %s directly callable", (toolName) => {
    expect(
      planDispatchModeToolCallRewrites({
        toolCalls: [{ id: "a", name: toolName, arguments: "{}" }],
        enabledToolNames: DISPATCH_PAIR,
      }),
    ).toBeNull();
  });
});

// --------------------------------------------------------------------------
// normalizeToolCallsForPolicy
// --------------------------------------------------------------------------
describe("normalizeToolCallsForPolicy", () => {
  // Regression: an MCP client namespaces the gateway's tools with the alias it
  // was registered under, and that alias is free text typed at `claude mcp add`
  // time — so the gateway's own branded prefix ends up a segment deeper than
  // the decoration-stripping canonicalizer reaches, and a strict match misses
  // the wrapper. A missed wrapper is not a harmless miss: the dispatch is never
  // unwrapped, so policies are evaluated against a name that matches no `tools`
  // row and fail open instead of against the tool the call actually runs.
  test("unwraps a run_tool dispatch decorated with an alias the platform does not know", () => {
    const result = normalizeToolCallsForPolicy([
      {
        name: "mcp__some_local_alias__archestra__run_tool",
        arguments: JSON.stringify({
          tool_name: "github__create_or_update_file",
          tool_args: { path: "README.md" },
        }),
      },
    ]);

    expect(result[0].toolCallName).toBe("github__create_or_update_file");
    expect(result[0].isRunToolDispatchTarget).toBe(true);
    expect(JSON.parse(result[0].toolCallArgs)).toEqual({ path: "README.md" });
  });

  // The loosening must stay anchored on a prefix the branding recognizes as
  // ours: a third-party tool that happens to be called `run_tool` is an
  // ordinary tool, and treating it as the wrapper would hand policy evaluation
  // whatever that server put in `tool_name`.
  test("does not treat a third-party tool named run_tool as a dispatch", () => {
    const result = normalizeToolCallsForPolicy([
      {
        name: "mcp__some_local_alias__github__run_tool",
        arguments: JSON.stringify({ tool_name: "anything__at_all" }),
      },
    ]);

    expect(result[0].toolCallName).toBe(
      "mcp__some_local_alias__github__run_tool",
    );
    expect(result[0].isRunToolDispatchTarget).toBeUndefined();
  });

  test("passes through valid JSON string arguments", () => {
    const result = normalizeToolCallsForPolicy([
      { name: "tool1", arguments: '{"key":"value"}' },
    ]);
    expect(result).toEqual([
      { toolCallName: "tool1", toolCallArgs: '{"key":"value"}' },
    ]);
  });

  test("wraps invalid JSON string arguments in { raw: ... }", () => {
    const result = normalizeToolCallsForPolicy([
      { name: "tool1", arguments: "not valid json" },
    ]);
    expect(result).toEqual([
      {
        toolCallName: "tool1",
        toolCallArgs: JSON.stringify({ raw: "not valid json" }),
      },
    ]);
  });

  test("JSON.stringifies object arguments", () => {
    const result = normalizeToolCallsForPolicy([
      { name: "tool1", arguments: { key: "value" } },
    ]);
    expect(result).toEqual([
      { toolCallName: "tool1", toolCallArgs: '{"key":"value"}' },
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(normalizeToolCallsForPolicy([])).toEqual([]);
  });

  test("handles mixed string and object arguments", () => {
    const result = normalizeToolCallsForPolicy([
      { name: "a", arguments: '{"x":1}' },
      { name: "b", arguments: { y: 2 } },
      { name: "c", arguments: "broken" },
    ]);
    expect(result).toEqual([
      { toolCallName: "a", toolCallArgs: '{"x":1}' },
      { toolCallName: "b", toolCallArgs: '{"y":2}' },
      {
        toolCallName: "c",
        toolCallArgs: JSON.stringify({ raw: "broken" }),
      },
    ]);
  });

  test("unwraps a run_tool dispatch to the target tool it names", () => {
    const result = normalizeToolCallsForPolicy([
      {
        name: "archestra__run_tool",
        arguments: JSON.stringify({
          tool_name: "github__create_or_update_file",
          tool_args: { path: "README.md" },
        }),
      },
    ]);
    expect(result).toEqual([
      {
        toolCallName: "github__create_or_update_file",
        toolCallArgs: '{"path":"README.md"}',
        isRunToolDispatchTarget: true,
      },
    ]);
  });

  test("canonicalizes client-decorated names before dispatch resolution", () => {
    const canonicalize = (name: string) =>
      name.startsWith("mcp__gw__") ? name.slice("mcp__gw__".length) : name;
    const result = normalizeToolCallsForPolicy(
      [
        {
          name: "mcp__gw__archestra__run_tool",
          arguments: JSON.stringify({
            tool_name: "github__create_issue",
            tool_args: {},
          }),
        },
        { name: "mcp__gw__github__direct_tool", arguments: "{}" },
      ],
      canonicalize,
    );
    expect(result).toEqual([
      {
        toolCallName: "github__create_issue",
        toolCallArgs: "{}",
        isRunToolDispatchTarget: true,
      },
      { toolCallName: "github__direct_tool", toolCallArgs: "{}" },
    ]);
  });

  test("keeps an unresolvable run_tool dispatch under the wrapper name", () => {
    const result = normalizeToolCallsForPolicy([
      { name: "archestra__run_tool", arguments: '{"tool_args":{}}' },
    ]);
    expect(result).toEqual([
      { toolCallName: "archestra__run_tool", toolCallArgs: '{"tool_args":{}}' },
    ]);
  });
});

// --------------------------------------------------------------------------
// calculateInteractionCosts
// --------------------------------------------------------------------------
describe("calculateInteractionCosts", () => {
  test("prices the model actually used, once", async () => {
    mockCalculateCost.mockResolvedValue(0.0005);
    mockCalculateCacheCost.mockResolvedValue({
      cacheCost: 0.0001,
      cacheSavings: 0.0009,
      cacheReadSavings: 0.001,
    });

    const result = await calculateInteractionCosts({
      actualModel: "gpt-3.5-turbo",
      usage: { inputTokens: 100, outputTokens: 50 },
      providerName: "openai",
    });

    expect(result).toEqual({
      actualCost: 0.0005,
      cacheCost: 0.0001,
      cacheSavings: 0.0009,
      cacheReadSavings: 0.001,
    });
    expect(mockCalculateCost).toHaveBeenCalledTimes(1);
    expect(mockCalculateCost).toHaveBeenCalledWith(
      "gpt-3.5-turbo",
      100,
      50,
      "openai",
      {
        readTokens: 0,
        writeTokens: 0,
        write1hTokens: 0,
      },
    );
  });

  test("handles undefined costs (model not found)", async () => {
    mockCalculateCost.mockResolvedValue(undefined);
    mockCalculateCacheCost.mockResolvedValue(undefined);

    const result = await calculateInteractionCosts({
      actualModel: "unknown-model",
      usage: { inputTokens: 100, outputTokens: 50 },
      providerName: "openai",
    });

    expect(result).toEqual({
      actualCost: undefined,
      cacheCost: undefined,
      cacheSavings: undefined,
      cacheReadSavings: undefined,
    });
  });
});

// --------------------------------------------------------------------------
// buildInteractionRecord
// --------------------------------------------------------------------------
describe("buildInteractionRecord", () => {
  const baseParams = {
    agent: { id: "agent-1" } as unknown as Agent,
    externalAgentId: "ext-1",
    runId: "exec-1",
    userId: "user-1",
    sessionId: "session-1",
    sessionSource: "header" as const,
    providerType: "openai:chatCompletions" as const,
    request: { messages: [] },
    processedRequest: { messages: [], model: "gpt-4" },
    response: { id: "resp-1" },
    actualModel: "gpt-3.5-turbo",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
    },
    costs: {
      actualCost: 0.0005,
      cacheCost: 0.0002,
      cacheSavings: 0.0018,
    },
    toonStats: {
      tokensBefore: 500,
      tokensAfter: 300,
      costSavings: 0.00012,
      wasEffective: true,
      hadToolResults: true,
    } satisfies ToolCompressionStats,
    toonSkipReason: null,
    dualLlmAnalyses: [],
    billingMode: "metered" as const,
  };

  test("builds correct record with all fields", () => {
    const record = buildInteractionRecord({
      ...baseParams,
      unsafeContextBoundary: {
        kind: "tool_result",
        reason: "tool_result_marked_untrusted",
        toolCallId: "call-1",
        toolName: "read_email",
      },
    });

    expect(record.profileId).toBe("agent-1");
    expect(record.externalAgentId).toBe("ext-1");
    expect(record.runId).toBe("exec-1");
    expect(record.userId).toBe("user-1");
    expect(record.sessionId).toBe("session-1");
    expect(record.sessionSource).toBe("header");
    expect(record.type).toBe("openai:chatCompletions");
    expect(record.request).toEqual({ messages: [] });
    expect(record.processedRequest).toEqual({ messages: [], model: "gpt-4" });
    expect(record.response).toEqual({ id: "resp-1" });
    expect(record.model).toBe("gpt-3.5-turbo");
    // Nothing rewrites the model any more, so the baseline mirrors it.
    expect(record.baselineModel).toBe("gpt-3.5-turbo");
    expect(record.billingMode).toBe("metered");
    expect(record.inputTokens).toBe(100);
    expect(record.outputTokens).toBe(50);
    expect(record.toonTokensBefore).toBe(500);
    expect(record.toonTokensAfter).toBe(300);
    expect(record.toonSkipReason).toBeNull();
    expect(record.unsafeContextBoundary).toEqual({
      kind: "tool_result",
      reason: "tool_result_marked_untrusted",
      toolCallId: "call-1",
      toolName: "read_email",
    });
  });

  test("carries a subscription billing mode through to the record", () => {
    const record = buildInteractionRecord({
      ...baseParams,
      billingMode: "subscription",
    });

    expect(record.billingMode).toBe("subscription");
    // `cost` is unchanged — it remains the list-price estimate; billed spend is
    // derived downstream from billingMode, not by zeroing cost at write time.
    expect(record.cost).toBe("0.0005000000");
  });

  test("formats costs to 10 decimal places", () => {
    const record = buildInteractionRecord(baseParams);

    expect(record.cost).toBe("0.0005000000");
    expect(record.baselineCost).toBe("0.0005000000");
    expect(record.cacheCost).toBe("0.0002000000");
    expect(record.cacheSavings).toBe("0.0018000000");
    expect(record.cacheReadTokens).toBe(80);
    expect(record.cacheWriteTokens).toBe(20);
  });

  test("handles null costs → null strings", () => {
    const record = buildInteractionRecord({
      ...baseParams,
      costs: {
        actualCost: undefined,
        cacheCost: undefined,
        cacheSavings: undefined,
      },
    });

    expect(record.cost).toBeNull();
    expect(record.baselineCost).toBeNull();
    expect(record.cacheCost).toBeNull();
    expect(record.cacheSavings).toBeNull();
  });

  test("handles null toonCostSavings", () => {
    const record = buildInteractionRecord({
      ...baseParams,
      toonStats: {
        ...baseParams.toonStats,
        costSavings: 0,
      },
    });

    // 0 is falsy, so costSavings?.toFixed(10) returns "0.0000000000"
    expect(record.toonCostSavings).toBe("0.0000000000");
  });

  test("formats toonCostSavings to 10 decimal places", () => {
    const record = buildInteractionRecord(baseParams);
    expect(record.toonCostSavings).toBe("0.0001200000");
  });

  test("passes source through when provided, undefined otherwise", () => {
    expect(
      buildInteractionRecord({ ...baseParams, source: "chatops:slack" }).source,
    ).toBe("chatops:slack");
    expect(buildInteractionRecord(baseParams).source).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// recordBlockedToolCallMetrics
// --------------------------------------------------------------------------
describe("recordBlockedToolCallMetrics", () => {
  test("calls recordBlockedToolSpans with correct params", () => {
    const agent = {
      id: "agent-1",
      agentType: "llm_proxy",
    } as Agent;
    const user = { id: "u1", email: "a@b.com", name: "Alice" };

    recordBlockedToolCallMetrics({
      allToolCallNames: ["tool_a", "tool_b"],
      reason: "blocked_by_policy",
      agent,
      sessionId: "sess-1",
      resolvedUser: user,
      providerName: "openai",
      toolCallCount: 2,
      actualModel: "gpt-4",
      source: "api",
    });

    expect(mockRecordBlockedToolSpans).toHaveBeenCalledWith({
      toolCallNames: ["tool_a", "tool_b"],
      blockedReason: "blocked_by_policy",
      agent,
      sessionId: "sess-1",
      agentType: "llm_proxy",
      user: { id: "u1", email: "a@b.com", name: "Alice" },
    });
  });

  test("calls reportBlockedTools with correct params", () => {
    const agent = { id: "agent-1", agentType: null } as unknown as Agent;

    recordBlockedToolCallMetrics({
      allToolCallNames: ["tool_a"],
      reason: "restricted",
      agent,
      sessionId: null,
      resolvedUser: null,
      providerName: "anthropic",
      toolCallCount: 1,
      actualModel: "claude-3-opus",
      source: "api",
    });

    expect(vi.mocked(metrics.llm.reportBlockedTools)).toHaveBeenCalledWith(
      "anthropic",
      agent,
      1,
      "claude-3-opus",
      "api",
    );
  });

  test("passes toSpanUserInfo result for user (null case)", () => {
    const agent = { id: "agent-1", agentType: null } as unknown as Agent;

    recordBlockedToolCallMetrics({
      allToolCallNames: ["tool_a"],
      reason: "restricted",
      agent,
      sessionId: null,
      resolvedUser: null,
      providerName: "openai",
      toolCallCount: 1,
      actualModel: "gpt-4",
      source: "api",
    });

    expect(mockRecordBlockedToolSpans).toHaveBeenCalledWith(
      expect.objectContaining({ user: null }),
    );
  });
});

// --------------------------------------------------------------------------
// withSessionContext
// --------------------------------------------------------------------------
describe("withSessionContext", () => {
  test("calls otelContext.with when sessionId is provided", () => {
    const withSpy = vi.spyOn(otelContext, "with");

    withSessionContext("test-session", () => "result");

    expect(withSpy).toHaveBeenCalledOnce();
    // Verify the context has the session ID set
    const passedCtx = withSpy.mock.calls[0][0];
    expect(passedCtx.getValue(SESSION_ID_KEY)).toBe("test-session");

    withSpy.mockRestore();
  });

  test("executes fn normally when sessionId is null", () => {
    const withSpy = vi.spyOn(otelContext, "with");

    const result = withSessionContext(null, () => 42);

    expect(result).toBe(42);
    expect(withSpy).not.toHaveBeenCalled();

    withSpy.mockRestore();
  });

  test("executes fn normally when sessionId is undefined", () => {
    const withSpy = vi.spyOn(otelContext, "with");

    const result = withSessionContext(undefined, () => "hello");

    expect(result).toBe("hello");
    expect(withSpy).not.toHaveBeenCalled();

    withSpy.mockRestore();
  });
});

describe("shouldForwardAnthropicBeta", () => {
  test("forwards to real Anthropic (no base-URL override)", () => {
    expect(shouldForwardAnthropicBeta("claude-opus-4-8", false)).toBe(true);
  });

  test("forwards to Claude proxied behind a custom base URL", () => {
    expect(shouldForwardAnthropicBeta("claude-3-5-sonnet", true)).toBe(true);
  });

  test("strips for a non-Claude model on a custom base URL", () => {
    expect(shouldForwardAnthropicBeta("kimi-k2", true)).toBe(false);
  });

  test("keeps forwarding a non-Claude model with no override (canonical endpoint)", () => {
    expect(shouldForwardAnthropicBeta("kimi-k2", false)).toBe(true);
  });
});

describe("handleError", () => {
  function makeReply(headersSent: boolean) {
    const writes: string[] = [];
    const headers: Record<string, string> = {};
    const sent: { statusCode?: number; body?: unknown } = {};
    const replyShape = {
      header: (name: string, value: string) => {
        headers[name] = value;
        return replyShape;
      },
      status: (statusCode: number) => {
        sent.statusCode = statusCode;
        return replyShape;
      },
      send: (body: unknown) => {
        sent.body = body;
        return replyShape;
      },
      raw: {
        headersSent,
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
        end: () => {},
      },
    };
    const reply = replyShape as unknown as FastifyReply;
    return { reply, writes, headers, sent };
  }

  const extractMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Internal server error";

  test("preserves the internal code carried by a thrown ApiError", () => {
    const { reply } = makeReply(false);
    const upstreamError = new ApiError(
      503,
      "empty upstream response",
      ArchestraInternalErrorCode.UpstreamEmptyResponse,
    );

    let thrown: unknown;
    try {
      handleError(upstreamError, reply, extractMessage, true, () => undefined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).statusCode).toBe(503);
    expect((thrown as ApiError).internalCode).toBe(
      ArchestraInternalErrorCode.UpstreamEmptyResponse,
    );
  });

  test("prefers the adapter's classification over the ApiError's own code", () => {
    const { reply } = makeReply(false);
    const upstreamError = new ApiError(
      400,
      "context too long",
      ArchestraInternalErrorCode.UpstreamEmptyResponse,
    );

    let thrown: unknown;
    try {
      handleError(
        upstreamError,
        reply,
        extractMessage,
        false,
        () => ArchestraInternalErrorCode.ContextLengthExceeded,
      );
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ApiError).internalCode).toBe(
      ArchestraInternalErrorCode.ContextLengthExceeded,
    );
  });

  test("surfaces the internal code in the mid-stream SSE error event", () => {
    const { reply, writes } = makeReply(true);
    const upstreamError = new ApiError(
      503,
      "empty upstream response",
      ArchestraInternalErrorCode.UpstreamEmptyResponse,
    );

    handleError(upstreamError, reply, extractMessage, true, () => undefined);

    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0].replace(/^event: error\ndata: /, ""));
    expect(payload.error.internal_code).toBe(
      ArchestraInternalErrorCode.UpstreamEmptyResponse,
    );
    expect(payload.error.message).toBe("empty upstream response");
  });

  // Transient upstream connection failures carry no HTTP status, so they used to
  // fall through as a generic 500 and get captured as a server exception. They're
  // reclassified to 502/504 so the central handler keeps them out of error
  // tracking (it already excludes 502/504) while the client still sees a 5xx.
  function throwStatusFor(error: unknown): number | undefined {
    const { reply } = makeReply(false);
    try {
      handleError(error, reply, extractMessage, false, () => undefined);
    } catch (thrown) {
      return (thrown as ApiError).statusCode;
    }
    return undefined;
  }

  test("classifies an SDK connection error as 502", () => {
    // OpenAI/Anthropic SDK APIConnectionError message, no HTTP status.
    expect(throwStatusFor(new Error("Connection error."))).toBe(502);
  });

  test("classifies an SDK request timeout as 504", () => {
    // OpenAI/Anthropic SDK APIConnectionTimeoutError message, no HTTP status.
    expect(throwStatusFor(new Error("Request timed out."))).toBe(504);
  });

  test("classifies a wrapped network errno cause as an upstream gateway error", () => {
    const connReset = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      }),
    });
    expect(throwStatusFor(connReset)).toBe(502);

    const timedOut = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("connect ETIMEDOUT"), {
        code: "ETIMEDOUT",
      }),
    });
    expect(throwStatusFor(timedOut)).toBe(504);
  });

  test("leaves an error that carries an explicit HTTP status untouched", () => {
    // A real upstream 500 response must not be reclassified away from capture.
    expect(throwStatusFor(new ApiError(500, "Connection error."))).toBe(500);
    expect(
      throwStatusFor(Object.assign(new Error("boom"), { status: 500 })),
    ).toBe(500);
  });

  test("leaves a generic internal error as a 500", () => {
    // No connection/timeout signal → stays a 500 and remains captured.
    expect(throwStatusFor(new TypeError("cannot read x of undefined"))).toBe(
      500,
    );
  });

  // The fetch-based adapters (Cohere, MiniMax, Zhipu) throw upstreamHttpError
  // for non-OK responses. The attached status must reach the client (a
  // provider 429 relays as 429, not 500), and a provider 5xx must be marked
  // upstream so error tracking drops the relay as expected noise.
  test("relays a provider 429 thrown as upstreamHttpError with its own status and body", () => {
    const rateLimited = upstreamHttpError(
      "Error from Cohere API : 429 - trial key limit",
      429,
    );

    const { reply, sent } = makeReply(false);
    handleError(rateLimited, reply, extractMessage, false, () => undefined);

    expect(sent.statusCode).toBe(429);
    expect(sent.body).toEqual({
      error: { message: "Error from Cohere API : 429 - trial key limit" },
    });
  });

  test("marks a provider 5xx thrown as upstreamHttpError as an upstream failure", () => {
    const providerDown = upstreamHttpError(
      "MiniMax API error: 503 Service Unavailable",
      503,
    );

    const { reply } = makeReply(false);
    let thrown: unknown;
    try {
      handleError(providerDown, reply, extractMessage, false, () => undefined);
    } catch (error) {
      thrown = error;
    }

    expect((thrown as ApiError).statusCode).toBe(503);
    expect((thrown as ApiError).upstream).toBe(true);
  });

  test("classifies a downstream client abort as a 499", () => {
    // The fetch AbortError raised when the client-disconnect signal fires.
    expect(
      throwStatusFor(
        new DOMException("This operation was aborted", "AbortError"),
      ),
    ).toBe(499);
    // The provider SDKs' wrapper for a caller-supplied signal firing mid-call.
    expect(
      throwStatusFor(
        Object.assign(new Error("Request was aborted."), {
          name: "APIUserAbortError",
        }),
      ),
    ).toBe(499);
  });

  test("keeps classifying an abort-due-to-timeout as a 504, not a client abort", () => {
    expect(
      throwStatusFor(
        Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        }),
      ),
    ).toBe(504);
  });

  function makeStreamedOverloadError(headers?: Headers) {
    const body = {
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    };
    return Object.assign(new Error(JSON.stringify(body)), {
      error: body,
      headers,
    });
  }

  function throwErrorFor(error: unknown, reply: FastifyReply): ApiError {
    try {
      handleError(error, reply, extractMessage, true, () => undefined);
    } catch (thrown) {
      return thrown as ApiError;
    }
    throw new Error("handleError did not throw");
  }

  test("relays a streamed Anthropic overload as 529 with the provider body verbatim", () => {
    const { reply, sent } = makeReply(false);
    const error = makeStreamedOverloadError();

    handleError(error, reply, extractMessage, true, () => undefined);

    expect(sent.statusCode).toBe(529);
    expect(sent.body).toEqual({
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    });
  });

  test("classifies generic overload wording without a status as 503", () => {
    const thrown = throwErrorFor(
      Object.assign(
        new Error("The server is currently overloaded, please retry"),
        { error: { message: "Overloaded" } },
      ),
      makeReply(false).reply,
    );

    expect(thrown.statusCode).toBe(503);
    expect(thrown.internalCode).toBe(
      ArchestraInternalErrorCode.ProviderOverloaded,
    );
  });

  test("does not reclassify an internal error containing overload wording", () => {
    const thrown = throwErrorFor(
      new Error("Internal worker overloaded"),
      makeReply(false).reply,
    );

    expect(thrown.statusCode).toBe(500);
    expect(thrown.internalCode).toBeUndefined();
  });

  test("keeps an explicit upstream 529 and tags it as overloaded", () => {
    const thrown = throwErrorFor(
      Object.assign(new Error("Overloaded"), { status: 529 }),
      makeReply(false).reply,
    );

    expect(thrown.statusCode).toBe(529);
    expect(thrown.internalCode).toBe(
      ArchestraInternalErrorCode.ProviderOverloaded,
    );
  });

  test("tags any explicit provider 503 as overloaded, regardless of wording", () => {
    // Providers phrase unavailability differently (Google returns UNAVAILABLE
    // "experiencing high demand" with no "overloaded" wording) — a 503 from
    // the provider call is provider unavailability either way.
    const thrown = throwErrorFor(
      Object.assign(new Error("Service Unavailable"), { status: 503 }),
      makeReply(false).reply,
    );

    expect(thrown.statusCode).toBe(503);
    expect(thrown.internalCode).toBe(
      ArchestraInternalErrorCode.ProviderOverloaded,
    );
    expect(thrown.upstream).toBe(true);
  });

  test("reads the HTTP status from AWS SDK response metadata", () => {
    // AWS SDK errors (Bedrock) carry the status on $metadata — without it a
    // throttling 429 surfaced as a generic 500.
    const throttled = throwErrorFor(
      Object.assign(new Error("Too many requests, please wait."), {
        $metadata: { httpStatusCode: 429 },
      }),
      makeReply(false).reply,
    );
    expect(throttled.statusCode).toBe(429);

    const providerFault = throwErrorFor(
      Object.assign(new Error("Bedrock is unable to process your request."), {
        $metadata: { httpStatusCode: 500 },
      }),
      makeReply(false).reply,
    );
    expect(providerFault.statusCode).toBe(500);
    expect(providerFault.upstream).toBe(true);
  });

  test("marks a status-less in-stream provider error as an upstream failure", () => {
    // Once the provider's stream commits 200, a failure arrives as an SSE
    // `error` event that the SDK relays with a parsed provider body but no
    // HTTP status — e.g. Anthropic's mid-stream `api_error` ("Internal
    // server error"). Without the upstream marker it was captured as a
    // crash of ours.
    const body = {
      type: "error",
      error: { type: "api_error", message: "Internal server error" },
    };
    const thrown = throwErrorFor(
      Object.assign(new Error(JSON.stringify(body)), {
        error: body,
        headers: new Headers(),
      }),
      makeReply(false).reply,
    );

    expect(thrown.statusCode).toBe(500);
    expect(thrown.upstream).toBe(true);
  });

  test("marks a status-less in-stream provider error with a bare-string payload as upstream", () => {
    // OpenAI-compatible upstreams may put a plain string under the stream's
    // `error` member; the SDK relays it verbatim with no HTTP status.
    const thrown = throwErrorFor(
      Object.assign(new Error("tool call refused by upstream"), {
        error: "tool call refused by upstream",
        headers: new Headers(),
      }),
      makeReply(false).reply,
    );

    expect(thrown.statusCode).toBe(500);
    expect(thrown.upstream).toBe(true);
  });

  test("does not mark an internal 500 as an upstream failure", () => {
    const thrown = throwErrorFor(
      new TypeError("cannot read x of undefined"),
      makeReply(false).reply,
    );

    expect(thrown.statusCode).toBe(500);
    expect(thrown.upstream).toBeFalsy();
  });

  test("forwards the upstream Retry-After header before headers commit", () => {
    const { reply, headers, sent } = makeReply(false);
    const error = makeStreamedOverloadError(
      new Headers({ "retry-after": "30" }),
    );

    handleError(error, reply, extractMessage, true, () => undefined);

    expect(sent.statusCode).toBe(529);
    expect(headers["retry-after"]).toBe("30");
  });

  test("drops a Retry-After value that is neither seconds nor a date", () => {
    const { reply, headers } = makeReply(false);
    const error = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { "retry-after": "soon\u0000ish" },
    });

    expect(throwErrorFor(error, reply).statusCode).toBe(429);
    expect(headers["retry-after"]).toBeUndefined();
  });

  test("surfaces the overload code in the mid-stream SSE error event", () => {
    const { reply, writes } = makeReply(true);

    handleError(
      makeStreamedOverloadError(),
      reply,
      extractMessage,
      true,
      () => undefined,
    );

    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0].replace(/^event: error\ndata: /, ""));
    expect(payload.error.internal_code).toBe(
      ArchestraInternalErrorCode.ProviderOverloaded,
    );
  });

  // A provider rate limit must reach native clients uncorrupted: the provider
  // error body is relayed verbatim (not rewrapped into the Archestra envelope,
  // which rewrote `rate_limit_error` to `unknown_api_error`) and the
  // provider's ratelimit headers are forwarded so clients can tell an
  // account/usage limit apart from server-side throttling.
  function makeAnthropicRateLimitError(headers?: unknown) {
    const body = {
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "This request would exceed your account's rate limit.",
      },
    };
    return Object.assign(new Error(JSON.stringify(body)), {
      status: 429,
      error: body,
      headers,
    });
  }

  test("relays an Anthropic 429 body verbatim with its original error type", () => {
    const { reply, sent } = makeReply(false);

    handleError(
      makeAnthropicRateLimitError(),
      reply,
      extractMessage,
      false,
      () => undefined,
    );

    expect(sent.statusCode).toBe(429);
    expect(sent.body).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "This request would exceed your account's rate limit.",
      },
    });
  });

  test("rewraps an OpenAI-style 429 error member into the provider's original body shape", () => {
    const { reply, sent } = makeReply(false);
    const error = Object.assign(new Error("Rate limit reached"), {
      status: 429,
      // OpenAI-compatible SDKs store the body's `error` member directly.
      error: {
        message: "Rate limit reached for requests",
        type: "requests",
        code: "rate_limit_exceeded",
      },
    });

    handleError(error, reply, extractMessage, false, () => undefined);

    expect(sent.statusCode).toBe(429);
    expect(sent.body).toEqual({
      error: {
        message: "Rate limit reached for requests",
        type: "requests",
        code: "rate_limit_exceeded",
      },
    });
  });

  test("forwards the provider's ratelimit headers on a rate-limited response", () => {
    const { reply, headers } = makeReply(false);
    const error = makeAnthropicRateLimitError(
      new Headers({
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": "1753257600",
        "x-ratelimit-remaining-tokens": "0",
        "retry-after": "60",
        // Unrelated headers must not leak through.
        "x-request-id": "req_123",
      }),
    );

    handleError(error, reply, extractMessage, false, () => undefined);

    expect(headers["anthropic-ratelimit-unified-status"]).toBe("rejected");
    expect(headers["anthropic-ratelimit-unified-reset"]).toBe("1753257600");
    expect(headers["x-ratelimit-remaining-tokens"]).toBe("0");
    expect(headers["retry-after"]).toBe("60");
    expect(headers["x-request-id"]).toBeUndefined();
  });

  test("drops a ratelimit header value with non-printable characters", () => {
    const { reply, headers } = makeReply(false);
    const error = makeAnthropicRateLimitError({
      "anthropic-ratelimit-unified-status": "reject\u0000ed",
    });

    handleError(error, reply, extractMessage, false, () => undefined);

    expect(headers["anthropic-ratelimit-unified-status"]).toBeUndefined();
  });

  test("keeps the provider's error type in the mid-stream SSE event for a rate limit", () => {
    const { reply, writes } = makeReply(true);

    handleError(
      makeAnthropicRateLimitError(),
      reply,
      extractMessage,
      true,
      () => undefined,
    );

    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0].replace(/^event: error\ndata: /, ""));
    expect(payload.error.type).toBe("rate_limit_error");
  });

  test("falls back to the Archestra envelope for a 429 without a provider body", () => {
    const { reply } = makeReply(false);
    const error = Object.assign(new Error("rate limited"), { status: 429 });

    const thrown = throwErrorFor(error, reply);
    expect(thrown.statusCode).toBe(429);
  });

  test("keeps the Archestra envelope for an internal ApiError 429 (usage-limit block)", () => {
    const { reply } = makeReply(false);
    const error = new ApiError(429, "Usage limit exceeded");

    const thrown = throwErrorFor(error, reply);
    expect(thrown.statusCode).toBe(429);
    expect(thrown.message).toBe("Usage limit exceeded");
  });

  test("lets an adapter's intentional reclassification win over body passthrough", () => {
    const { reply } = makeReply(false);
    const error = makeAnthropicRateLimitError();

    const thrown = (() => {
      try {
        handleError(
          error,
          reply,
          extractMessage,
          false,
          () => ArchestraInternalErrorCode.ProviderInsufficientBalance,
        );
      } catch (caught) {
        return caught as ApiError;
      }
      throw new Error("handleError did not throw");
    })();

    expect(thrown.internalCode).toBe(
      ArchestraInternalErrorCode.ProviderInsufficientBalance,
    );
  });
});

describe("handleError upstream marking", () => {
  function makeReply() {
    const replyShape = {
      header: () => replyShape,
      status: () => replyShape,
      send: () => replyShape,
      raw: { headersSent: false, write: () => true, end: () => {} },
    };
    return replyShape as unknown as FastifyReply;
  }

  const extractMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Internal server error";

  function thrownFor(error: unknown): ApiError {
    try {
      handleError(error, makeReply(), extractMessage, false, () => undefined);
    } catch (thrown) {
      return thrown as ApiError;
    }
    throw new Error("handleError did not throw");
  }

  test("marks a relayed Bedrock 5xx (statusCode + responseBody shape) as upstream", () => {
    // clients/bedrock-client.ts errors carry the provider's raw body as
    // `responseBody` rather than a parsed `error` member; these relays used
    // to be captured as crashes of ours.
    const error = new Error(
      "Bedrock API error (500): The system encountered an unexpected error during processing. Try your request again.",
    );
    (error as Error & { statusCode: number }).statusCode = 500;
    (error as Error & { responseBody: string }).responseBody =
      '{"message":"The system encountered an unexpected error during processing. Try your request again."}';

    const thrown = thrownFor(error);
    expect(thrown.statusCode).toBe(500);
    expect(thrown.upstream).toBe(true);
  });

  test("marks a status-less SDK connection failure as upstream alongside its 502 mapping", () => {
    // The OpenAI SDK's APIConnectionError ("Connection error.") carries no
    // HTTP status and no provider body — classified as a 502 relay, it must
    // also be marked upstream so error tracking drops it.
    const error = new Error("Connection error.");
    error.name = "APIConnectionError";

    const thrown = thrownFor(error);
    expect(thrown.statusCode).toBe(502);
    expect(thrown.upstream).toBe(true);
  });

  test("does not mark our own unclassified 500s as upstream", () => {
    const thrown = thrownFor(new Error("something internal exploded"));
    expect(thrown.statusCode).toBe(500);
    expect(thrown.upstream).not.toBe(true);
  });
});
