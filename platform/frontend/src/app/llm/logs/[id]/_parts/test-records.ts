import type { InteractionSummary, SessionToolCall } from "./session-timeline";

export const BASE = Date.UTC(2026, 8, 18, 10, 0, 0);

export function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

export function row(
  overrides: Partial<InteractionSummary> = {},
): InteractionSummary {
  return {
    id: "row",
    profileId: null,
    externalAgentId: null,
    sessionId: "session",
    model: "claude-sonnet-4-5",
    baselineModel: null,
    billingMode: "metered",
    autoRouted: false,
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

export function toolCall(
  overrides: Partial<SessionToolCall> = {},
): SessionToolCall {
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
    credentialClientId: null,
    credentialClientType: "identity_provider",
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
