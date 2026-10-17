// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  InteractionSummary,
  SessionToolCall,
} from "@/app/llm/logs/session/[sessionId]/_parts/session-timeline";
import { buildExcerptTimeline } from "./excerpt-timeline";

/** The excerpt keeps six records on each side of the call. */
const SPANS_EACH_SIDE = 6;

describe("buildExcerptTimeline", () => {
  it("keeps the records on each side of the call and re-lays them", () => {
    // 20 tool calls a second apart; the call is the 11th.
    const calls = Array.from({ length: 20 }, (_, i) =>
      toolCall(`c${i}`, i * 1_000),
    );

    const { timeline, before, after } = buildExcerptTimeline({
      requests: [],
      toolCalls: calls,
      call: calls[10],
    });

    expect(timeline?.spans.map((span) => span.key)).toEqual(
      calls
        .slice(10 - SPANS_EACH_SIDE, 11 + SPANS_EACH_SIDE)
        .map((call) => `tool:${call.id}`),
    );
    expect(before).toBe(SPANS_EACH_SIDE);
    expect(after).toBe(SPANS_EACH_SIDE);
    // Its own axis: the first kept span starts it.
    expect(timeline?.spans[0].x).toBe(0);
  });

  it("interleaves requests and counts what is on either side near an edge", () => {
    const call = toolCall("self", 5_000);
    const { timeline, before, after } = buildExcerptTimeline({
      requests: [request("r1", 3_000), request("r2", 9_000)],
      toolCalls: [toolCall("later", 7_000)],
      call,
    });

    expect(timeline?.spans.map((span) => span.key)).toEqual([
      "request:r1",
      "tool:self",
      "tool:later",
      "request:r2",
    ]);
    expect({ before, after }).toEqual({ before: 1, after: 2 });
  });

  it("adds the call when the fetched page missed it", () => {
    const call = toolCall("self", 1_000);
    const { timeline, before, after } = buildExcerptTimeline({
      requests: [],
      toolCalls: [],
      call,
    });

    expect(timeline?.spans.map((span) => span.key)).toEqual(["tool:self"]);
    expect({ before, after }).toEqual({ before: 0, after: 0 });
  });
});

const BASE = Date.parse("2026-10-16T10:00:00.000Z");

function toolCall(id: string, endOffsetMs: number): SessionToolCall {
  return {
    id,
    ownerType: "agent",
    agentId: "gateway",
    appId: null,
    mcpServerName: "github",
    method: "tools/call",
    toolCall: { id: `tc-${id}`, name: "github__search_issues", arguments: {} },
    toolResult: { isError: false, content: [] },
    userId: null,
    runId: null,
    sessionId: null,
    llmToolCallId: null,
    authMethod: "oauth",
    oauthClientId: null,
    source: "api",
    durationMs: 500,
    createdAt: new Date(BASE + endOffsetMs).toISOString(),
    userName: null,
    appName: null,
  };
}

function request(id: string, endOffsetMs: number): InteractionSummary {
  return {
    id,
    createdAt: new Date(BASE + endOffsetMs).toISOString(),
    durationMs: 1_000,
    requestType: "main",
    source: "api",
  } as InteractionSummary;
}
