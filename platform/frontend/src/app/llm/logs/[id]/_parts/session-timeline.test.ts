// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  type InteractionSummary,
  requestLabel,
  type SessionToolCall,
  spanKind,
  visibleToolCalls,
} from "./session-timeline";

describe("buildTimeline", () => {
  it("places a span from createdAt − duration to createdAt, oldest first", () => {
    const timeline = buildTimeline({
      requests: [
        row({ id: "late", createdAt: at(20_000), durationMs: 10_000 }),
        row({ id: "early", createdAt: at(10_000), durationMs: 10_000 }),
      ],
    });

    expect(timeline?.spans.map((s) => s.key)).toEqual([
      "request:early",
      "request:late",
    ]);
    expect(timeline?.origin).toBe(BASE);
    expect(timeline?.realSpanMs).toBe(20_000);
    const [early, late] = timeline?.spans ?? [];
    expect(early.x).toBeCloseTo(0);
    expect(early.w).toBeCloseTo(0.5);
    expect(late.x).toBeCloseTo(0.5);
    expect(late.x + late.w).toBeCloseTo(1);
  });

  it("folds a long idle stretch so the busy parts keep their width", () => {
    // Two 10s bursts an hour apart: unfolded, each would be ~0.3% wide.
    const timeline = buildTimeline({
      requests: [
        row({ id: "a", createdAt: at(10_000), durationMs: 10_000 }),
        row({ id: "b", createdAt: at(3_620_000), durationMs: 10_000 }),
      ],
    });

    expect(timeline?.breaks).toHaveLength(1);
    expect(timeline?.breaks[0].gapMs).toBe(3_600_000);
    for (const span of timeline?.spans ?? []) {
      expect(span.w).toBeGreaterThan(0.4);
    }
    // No tick may claim a time inside the folded hour.
    const fold = timeline?.breaks[0];
    for (const tick of timeline?.ticks ?? []) {
      expect(
        fold && tick.x > fold.x + 0.005 && tick.x < fold.x + fold.w - 0.005,
      ).toBe(false);
    }
  });

  it("does not fold short pauses between turns", () => {
    const timeline = buildTimeline({
      requests: [
        row({ id: "a", createdAt: at(5_000), durationMs: 5_000 }),
        row({ id: "b", createdAt: at(40_000), durationMs: 5_000 }),
      ],
    });

    expect(timeline?.breaks).toEqual([]);
  });

  it("fills the track for a lone untimed request instead of dividing by zero", () => {
    const timeline = buildTimeline({
      requests: [row({ id: "only", createdAt: at(0), durationMs: null })],
    });

    expect(timeline?.spans[0]).toMatchObject({ x: 0, w: 1 });
    expect(timeline?.ticks).toEqual([{ x: 0, label: "0s" }]);
  });

  it("interleaves each tool call after the request that issued it", () => {
    const timeline = buildTimeline({
      requests: [
        row({ id: "second", createdAt: at(20_000), durationMs: 5_000 }),
        row({ id: "first", createdAt: at(5_000), durationMs: 5_000 }),
      ],
      toolCalls: [
        toolCall({ id: "lookup", createdAt: at(9_000), durationMs: 3_000 }),
      ],
    });

    expect(timeline?.spans.map((s) => s.key)).toEqual([
      "request:first",
      "tool:lookup",
      "request:second",
    ]);
    const lookup = timeline?.spans[1];
    expect(lookup?.kind).toBe("tool");
    // 6s..9s on a 0..20s axis.
    expect(lookup?.x).toBeCloseTo(0.3);
    expect(lookup?.w).toBeCloseTo(0.15);
  });

  it("has nothing to lay out for an empty page", () => {
    expect(buildTimeline({ requests: [] })).toBeNull();
  });
});

describe("visibleToolCalls", () => {
  it("drops a run_tool dispatch in favour of the tool it ran", () => {
    const outer = toolCall({
      id: "outer",
      llmToolCallId: "toolu_1",
      toolCall: { id: "a", name: "archestra__run_tool", arguments: {} },
    });
    const inner = toolCall({ id: "inner", llmToolCallId: "toolu_1" });
    const lone = toolCall({
      id: "lone",
      llmToolCallId: "toolu_2",
      toolCall: { id: "b", name: "archestra__run_tool", arguments: {} },
    });

    expect(visibleToolCalls([outer, inner, lone]).map((c) => c.id)).toEqual([
      "inner",
      "lone",
    ]);
  });

  it("keeps unrelated calls that carry no model tool-call id", () => {
    const calls = [toolCall({ id: "a" }), toolCall({ id: "b" })];
    expect(visibleToolCalls(calls)).toEqual(calls);
  });
});

describe("spanKind", () => {
  it("treats a sub-agent by request type or by its source", () => {
    expect(spanKind({ requestType: "subagent", source: "api" })).toBe(
      "subagent",
    );
    expect(spanKind({ requestType: "main", source: "opencode:subagent" })).toBe(
      "subagent",
    );
  });

  it("separates side requests from the main thread", () => {
    expect(spanKind({ requestType: "main", source: "chat:compaction" })).toBe(
      "auxiliary",
    );
    expect(spanKind({ requestType: "main", source: "chatops:slack" })).toBe(
      "main",
    );
  });
});

describe("requestLabel", () => {
  it("names ChatOps and chat turns after the agent, not the channel", () => {
    expect(requestLabel(row({ source: "chatops:slack" }), "My Assistant")).toBe(
      "My Assistant",
    );
  });

  it("names a side request by what it did", () => {
    expect(
      requestLabel(row({ source: "chat:compaction" }), "My Assistant"),
    ).toBe("Chat Compaction");
  });

  it("prefers the client's label over the raw external agent id", () => {
    expect(
      requestLabel(
        row({ externalAgentId: "claude-code", externalAgentIdLabel: "Claude" }),
        "Proxy",
      ),
    ).toBe("Claude");
    expect(requestLabel(row({ externalAgentId: "claude-code" }), "Proxy")).toBe(
      "claude-code",
    );
  });

  it("tells apart the requests one prompt drives by what each produced", () => {
    const prompt = { userMessagePreview: "find the flaky test" };
    expect(
      requestLabel(
        row({
          ...prompt,
          responseToolNames: [
            "mcp__engineering-gateway__linear__get_issue",
            "Read",
          ],
        }),
        "Proxy",
      ),
    ).toBe("Called linear__get_issue, Read");
    expect(
      requestLabel(
        row({ ...prompt, responseToolNames: ["Read", "Grep", "Bash", "Edit"] }),
        "Proxy",
      ),
    ).toBe("Called Read, Grep, Bash +1");
    expect(
      requestLabel(
        row({ ...prompt, responseTextPreview: "The **retry** key is stale." }),
        "Proxy",
      ),
    ).toBe("The retry key is stale.");
    // Logged before the output was kept: the prompt still names it.
    expect(requestLabel(row(prompt), "Proxy")).toBe("find the flaky test");
  });

  it("falls back to a generic sub-agent label", () => {
    expect(requestLabel(row({ requestType: "subagent" }), "Proxy")).toBe(
      "Sub-agent",
    );
  });
});

const BASE = Date.UTC(2026, 8, 18, 10, 0, 0);

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

function row(overrides: Partial<InteractionSummary> = {}): InteractionSummary {
  return {
    id: "row",
    profileId: null,
    externalAgentId: null,
    sessionId: "session",
    model: "claude-sonnet-4-5",
    baselineModel: null,
    billingMode: "metered",
    inputTokens: 10,
    inputTokensEstimated: false,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: "0.001",
    baselineCost: "0.001",
    durationMs: 1000,
    createdAt: at(0),
    providerApiKeyId: null,
    modelPoolId: null,
    attempt: null,
    attemptOutcome: null,
    failureReason: null,
    type: "anthropic:messages",
    externalAgentIdLabel: null,
    requestType: "main",
    source: "api",
    ...overrides,
  };
}

function toolCall(overrides: Partial<SessionToolCall> = {}): SessionToolCall {
  return {
    id: "call",
    ownerType: "agent",
    agentId: null,
    appId: null,
    mcpServerName: "jira",
    method: "tools/call",
    toolCall: { id: "tc", name: "jira__get_issue", arguments: {} },
    toolResult: { isError: false, content: [] },
    userId: null,
    runId: null,
    authMethod: "session",
    oauthClientId: null,
    source: "chat",
    durationMs: 500,
    createdAt: at(0),
    userName: null,
    appName: null,
    sessionId: "session",
    llmToolCallId: null,
    ...overrides,
  };
}
