/**
 * LLM Proxy Helpers Tests
 *
 * Unit tests for shared helper functions extracted from llm-proxy-handler.ts.
 */

import { context as otelContext } from "@opentelemetry/api";
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
vi.mock("@/routes/proxy/utils/cost-optimization", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/routes/proxy/utils/cost-optimization")
    >();
  return {
    ...original,
    calculateCost: (...args: Parameters<typeof mockCalculateCost>) =>
      mockCalculateCost(...args),
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
const mockReportBlockedTools = vi.fn();
vi.mock("@/observability", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/observability")>();
  return {
    ...original,
    metrics: {
      ...original.metrics,
      llm: {
        ...original.metrics.llm,
        reportBlockedTools: (...args: unknown[]) =>
          mockReportBlockedTools(...args),
      },
    },
  };
});

// Import after mocks
import {
  buildInteractionRecord,
  calculateInteractionCosts,
  normalizeToolCallsForPolicy,
  recordBlockedToolCallMetrics,
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

  test("returns null for null input", () => {
    expect(toSpanUserInfo(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(toSpanUserInfo(undefined)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// normalizeToolCallsForPolicy
// --------------------------------------------------------------------------
describe("normalizeToolCallsForPolicy", () => {
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
});

// --------------------------------------------------------------------------
// calculateInteractionCosts
// --------------------------------------------------------------------------
describe("calculateInteractionCosts", () => {
  test("returns both costs when models differ", async () => {
    mockCalculateCost
      .mockResolvedValueOnce(0.001) // baseline
      .mockResolvedValueOnce(0.0005); // actual

    const result = await calculateInteractionCosts({
      baselineModel: "gpt-4",
      actualModel: "gpt-3.5-turbo",
      usage: { inputTokens: 100, outputTokens: 50 },
      providerName: "openai",
    });

    expect(result).toEqual({ baselineCost: 0.001, actualCost: 0.0005 });
    expect(mockCalculateCost).toHaveBeenCalledTimes(2);
    expect(mockCalculateCost).toHaveBeenCalledWith("gpt-4", 100, 50, "openai");
    expect(mockCalculateCost).toHaveBeenCalledWith(
      "gpt-3.5-turbo",
      100,
      50,
      "openai",
    );
  });

  test("returns same cost for both when models match", async () => {
    mockCalculateCost.mockResolvedValue(0.002);

    const result = await calculateInteractionCosts({
      baselineModel: "gpt-4",
      actualModel: "gpt-4",
      usage: { inputTokens: 200, outputTokens: 100 },
      providerName: "openai",
    });

    expect(result.baselineCost).toBe(0.002);
    expect(result.actualCost).toBe(0.002);
  });

  test("handles undefined costs (model not found)", async () => {
    mockCalculateCost.mockResolvedValue(undefined);

    const result = await calculateInteractionCosts({
      baselineModel: "unknown-model",
      actualModel: "unknown-model",
      usage: { inputTokens: 100, outputTokens: 50 },
      providerName: "openai",
    });

    expect(result).toEqual({
      baselineCost: undefined,
      actualCost: undefined,
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
    executionId: "exec-1",
    userId: "user-1",
    sessionId: "session-1",
    sessionSource: "header" as const,
    providerType: "openai:chatCompletions" as const,
    request: { messages: [] },
    processedRequest: { messages: [], model: "gpt-4" },
    response: { id: "resp-1" },
    actualModel: "gpt-3.5-turbo",
    baselineModel: "gpt-4",
    usage: { inputTokens: 100, outputTokens: 50 },
    costs: { baselineCost: 0.001, actualCost: 0.0005 },
    toonStats: {
      tokensBefore: 500,
      tokensAfter: 300,
      costSavings: 0.00012,
      wasEffective: true,
      hadToolResults: true,
    } satisfies ToolCompressionStats,
    toonSkipReason: null,
  };

  test("builds correct record with all fields", () => {
    const record = buildInteractionRecord(baseParams);

    expect(record.profileId).toBe("agent-1");
    expect(record.externalAgentId).toBe("ext-1");
    expect(record.executionId).toBe("exec-1");
    expect(record.userId).toBe("user-1");
    expect(record.sessionId).toBe("session-1");
    expect(record.sessionSource).toBe("header");
    expect(record.type).toBe("openai:chatCompletions");
    expect(record.request).toEqual({ messages: [] });
    expect(record.processedRequest).toEqual({ messages: [], model: "gpt-4" });
    expect(record.response).toEqual({ id: "resp-1" });
    expect(record.model).toBe("gpt-3.5-turbo");
    expect(record.baselineModel).toBe("gpt-4");
    expect(record.inputTokens).toBe(100);
    expect(record.outputTokens).toBe(50);
    expect(record.toonTokensBefore).toBe(500);
    expect(record.toonTokensAfter).toBe(300);
    expect(record.toonSkipReason).toBeNull();
  });

  test("formats costs to 10 decimal places", () => {
    const record = buildInteractionRecord(baseParams);

    expect(record.cost).toBe("0.0005000000");
    expect(record.baselineCost).toBe("0.0010000000");
  });

  test("handles null costs → null strings", () => {
    const record = buildInteractionRecord({
      ...baseParams,
      costs: { baselineCost: undefined, actualCost: undefined },
    });

    expect(record.cost).toBeNull();
    expect(record.baselineCost).toBeNull();
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
      externalAgentId: "ext-1",
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
      externalAgentId: "ext-2",
    });

    expect(mockReportBlockedTools).toHaveBeenCalledWith(
      "anthropic",
      agent,
      1,
      "claude-3-opus",
      "ext-2",
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
