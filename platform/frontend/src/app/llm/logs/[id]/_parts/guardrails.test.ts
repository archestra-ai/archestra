// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ExternalConsult } from "@/lib/openappa/external-consults.query";
import type { LabelChangeRecord } from "@/lib/openappa/label-changes.query";
import type { OpenAppaYell } from "@/lib/openappa-yells.query";
import { buildGuardrails } from "./guardrails";
import {
  buildTimeline,
  type InteractionSummary,
  type SessionToolCall,
} from "./session-timeline";

describe("buildGuardrails", () => {
  it("ties each check to the tool call it was raised for, through a trajectory stamp", () => {
    const guardrails = buildGuardrails({
      timeline: timeline(),
      consults: [
        consult({ id: "c1", role: "annotator", callId: "call:toolu_read" }),
        consult({
          id: "c2",
          role: "authority",
          callId: "call:toolu_write",
          answer: { allow: false, reason: "no" },
        }),
      ],
      labelChanges: [],
    });

    expect(
      guardrails?.consults.map((c) => [c.key, c.toolCallKey, c.decision]),
    ).toEqual([
      ["consult:c1", "tool:read", "labeled"],
      ["consult:c2", "tool:write", "blocked"],
    ]);
  });

  it("starts from the baseline and opens a segment at each change, skipping unchanged rows", () => {
    const guardrails = buildGuardrails({
      timeline: timeline(),
      consults: [
        consult({ id: "c1", role: "annotator", callId: "call:toolu_read" }),
      ],
      labelChanges: [
        change({ event: "session_start", at: 0 }),
        change({
          event: "tool_result",
          at: 7_000,
          callId: "call:toolu_read",
          trustAfter: "suspicious",
          rule: {
            source: "root",
            battery: null,
            batteryEntry: null,
            line: 4,
            text: '[[policy.tool]]\nname = "jira__get_issue"',
          },
        }),
      ],
    });

    expect(
      guardrails?.labels.map((segment) => [
        segment.trust,
        segment.cause?.toolCallKey ?? null,
        segment.cause?.consultKey ?? null,
        segment.cause?.ruleSource ?? null,
        segment.cause?.ruleHref ?? null,
      ]),
    ).toEqual([
      ["trusted", null, null, null, null],
      [
        "suspicious",
        "tool:read",
        "consult:c1",
        "Organization policy, line 4",
        "/openappa/policy?line=4",
      ],
    ]);
    expect(guardrails?.labelAt(BASE + 6_000)?.trust).toBe("trusted");
    expect(guardrails?.labelAt(BASE + 8_000)?.trust).toBe("suspicious");
  });

  it("places yells on their calls and turns guardrails off at the first superyell", () => {
    const guardrails = buildGuardrails({
      timeline: timeline(),
      consults: [],
      labelChanges: [],
      yells: [
        yell({ id: "late", at: 15_000, superyell: true, mcpToolCallId: null }),
        yell({
          id: "off",
          at: 12_000,
          superyell: true,
          mcpToolCallId: "write",
        }),
        yell({ id: "first", at: 7_000, mcpToolCallId: "read" }),
        yell({ id: "elsewhere", at: 8_000, mcpToolCallId: "not-in-trace" }),
      ],
    });

    expect(
      guardrails?.yells.map((y) => [y.key, y.toolCallKey, y.superyell]),
    ).toEqual([
      ["yell:first", "tool:read", false],
      ["yell:elsewhere", null, false],
      ["yell:off", "tool:write", true],
      ["yell:late", null, true],
    ]);
    expect(guardrails?.guardrailsOffAt).toBe(BASE + 12_000);
  });

  it("has nothing to show without checks or a label history", () => {
    expect(
      buildGuardrails({ timeline: timeline(), consults: [], labelChanges: [] }),
    ).toBeNull();
  });
});

const BASE = Date.UTC(2026, 8, 18, 10, 0, 0);

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

function timeline() {
  const result = buildTimeline({
    requests: [
      row({ id: "first", createdAt: at(5_000), durationMs: 5_000 }),
      row({ id: "second", createdAt: at(20_000), durationMs: 5_000 }),
    ],
    toolCalls: [
      toolCall({
        id: "read",
        createdAt: at(7_000),
        // A stamped id: `appat1` + base64url("<session>\0<call id>") + tag.
        llmToolCallId: `appat1${btoa("session\u0000toolu_read").replace(/=+$/, "")}${"t".repeat(22)}`,
      }),
      toolCall({
        id: "write",
        createdAt: at(12_000),
        llmToolCallId: "toolu_write",
      }),
    ],
  });
  if (!result) throw new Error("no timeline");
  return result;
}

function yell(params: {
  id: string;
  at: number;
  superyell?: boolean;
  mcpToolCallId: string | null;
}): OpenAppaYell {
  return {
    id: params.id,
    organizationId: "org",
    callerId: "user:u1",
    sessionId: "user:u1|session",
    toolCallId: `toolu_${params.id}`,
    message: `yell ${params.id}`,
    withTrajectory: false,
    superyell: params.superyell ?? false,
    hasArchive: false,
    createdAt: at(params.at),
    reportedAt: null,
    reportFailed: false,
    resolvedAt: null,
    resolvedBy: null,
    caller: null,
    callerApp: null,
    conversation: null,
    trace: { llmSessionId: "session", mcpToolCallId: params.mcpToolCallId },
  };
}

function consult(params: {
  id: string;
  role: "annotator" | "authority";
  callId: string;
  answer?: unknown;
}): ExternalConsult {
  return {
    id: params.id,
    organizationId: "org",
    sessionId: "user:a|session",
    callerId: "user:a",
    createdAt: at(7_100),
    startedAt: at(7_000),
    durationMs: 100,
    role: params.role,
    externalName: "checker",
    backend: "llm",
    request: {},
    outcome: "answered",
    answer: params.answer ?? { delta_trust: "suspicious" },
    rawResponse: null,
    httpStatus: 200,
    diagnostics: null,
    diagnosticsTruncated: false,
    root: "root",
    trajectory: "root",
    callId: params.callId,
    offerId: null,
    callDigest: null,
  } as ExternalConsult;
}

function change(params: {
  event: LabelChangeRecord["event"];
  at: number;
  callId?: string;
  trustAfter?: string;
  rule?: LabelChangeRecord["rule"];
}): LabelChangeRecord {
  return {
    id: `${params.event}-${params.at}`,
    organizationId: "org",
    root: "root",
    sessionId: "user:a|session",
    callerId: "user:a",
    createdAt: at(params.at),
    event: params.event,
    callId: params.callId ?? null,
    tool: null,
    trustBefore: "trusted",
    audienceBefore: "public",
    trustAfter: params.trustAfter ?? "trusted",
    audienceAfter: "public",
    policyRevision: null,
    rule: params.rule ?? null,
  };
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
