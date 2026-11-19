import type { archestraApiTypes } from "@archestra/shared";
// Import runtime values from the leaf `interactions/client` module, not the root
// barrel: the barrel (`@archestra/shared`) transitively imports a JSON module
// without an import attribute, which the Playwright integration-test ESM loader
// rejects. `client.ts` depends only on zod. The `archestraApiTypes` import above
// is type-only, so it is erased and safe.
import {
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_DESKTOP_CLIENT_ID,
  CODEX_CLIENT_ID,
  OPENCODE_CLIENT_ID,
} from "@archestra/shared/interactions/client";

type SessionSummary =
  archestraApiTypes.GetLlmProxyLogSessionsResponses["200"]["data"][number];
type Interaction = archestraApiTypes.GetLlmProxyLogResponses["200"];
type InteractionSummary =
  archestraApiTypes.GetLlmProxyLogSummariesResponses["200"]["data"][number];
type ChatError =
  archestraApiTypes.GetLlmProxyLogSessionChatErrorsResponses["200"]["chatErrors"][number];
// The factory builds the OpenAI chat-completions member of the interaction
// union, which keeps `request`/`response` overrides cleanly typed.
type OpenAiInteraction = Extract<
  Interaction,
  { type: "openai:chatCompletions" }
>;

export const ORCHESTRATOR_SESSION_ID = "0193a1c2-7d4e-7b21-9c3f-5a1e2d3c4b5a";

type Pagination = {
  currentPage: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

export function makeSessionSummary(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId: "test-session-id",
    sessionSource: null,
    source: "api",
    sources: ["api"],
    interactionId: null,
    requestCount: 1,
    failedOverCount: 0,
    failedRequestCount: 0,
    chatErrorCount: 0,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCost: "0.01",
    totalBilledCost: "0.01",
    totalSubscriptionCost: null,
    totalBaselineCost: "0.01",
    totalCacheSavings: null,
    firstRequestTime: "2026-01-01T00:00:00.000Z",
    lastRequestTime: "2026-01-01T00:00:00.000Z",
    models: ["gpt-4o"],
    profileId: "test-profile-id",
    profileName: "Test Agent",
    profileAgentType: "agent",
    externalAgentIds: [],
    externalAgentIdLabels: [],
    authMethods: [],
    authenticatedAppNames: [],
    userNames: [],
    userIds: [],
    unattributedReason: null,
    virtualKeys: [],
    lastUserMessagePreview: null,
    lastInteractionId: null,
    lastInteractionType: null,
    contentNotStored: false,
    conversationTitle: null,
    claudeCodeTitle: null,
    connectorName: null,
    ...overrides,
  };
}

export function makeInteraction(
  overrides: Partial<OpenAiInteraction> = {},
): OpenAiInteraction {
  return {
    id: "test-interaction-id",
    profileId: "test-profile-id",
    connectorId: null,
    appId: null,
    providerApiKeyId: null,
    modelPoolId: null,
    attempt: null,
    attemptOutcome: null,
    failureReason: null,
    failed: false,
    externalAgentId: null,
    runId: null,
    userId: null,
    serviceAccountId: null,
    virtualKeyId: null,
    passthroughVirtualKeyId: null,
    environmentId: null,
    sessionId: "test-session-id",
    sessionSource: null,
    billingMode: "metered",
    authenticatedAppId: null,
    authenticatedAppName: null,
    billingTeamId: null,
    attributionLabels: null,
    request: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    },
    response: {
      id: "chatcmpl-test",
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          logprobs: null,
          message: {
            content: "The capital of France is Paris.",
            role: "assistant",
          },
        },
      ],
      created: 0,
      model: "gpt-4o",
      object: "chat.completion",
    },
    type: "openai:chatCompletions",
    model: "gpt-4o",
    baselineModel: null,
    durationMs: null,
    inputTokens: 100,
    inputTokensEstimated: false,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    baselineCost: null,
    cost: "0.01",
    cacheCost: null,
    cacheSavings: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Seed sessions for the LLM logs list. Client attribution lives in
// `externalAgentIds`; the "Client" filter sends `client=claude`/`client=codex`
// and the query-aware handler matches those rows. Two Claude sessions
// (header-set `claude code` and auto-discovered `claude`), one Codex session,
// one OpenCode session, plus a plain API session.
export const llmLogsSessionsSeed = [
  makeSessionSummary({
    sessionId: "cc-session",
    sessionSource: "claude_metadata",
    externalAgentIds: [CLAUDE_CODE_CLIENT_ID],
    claudeCodeTitle: "Claude Code session title",
  }),
  makeSessionSummary({
    sessionId: "codex-session",
    sessionSource: "codex_session",
    externalAgentIds: [CODEX_CLIENT_ID],
  }),
  makeSessionSummary({
    sessionId: "cd-session",
    sessionSource: "claude_metadata",
    externalAgentIds: [CLAUDE_DESKTOP_CLIENT_ID],
    // Non-api source so the Source + Client filter combo can isolate cc-session.
    source: "chat",
    sources: ["chat"],
    claudeCodeTitle: "Claude Desktop session title",
  }),
  makeSessionSummary({
    sessionId: "opencode-session",
    sessionSource: "opencode_session",
    externalAgentIds: [OPENCODE_CLIENT_ID],
    lastUserMessagePreview: "OpenCode proxy session",
  }),
  // An Archestra Chat orchestrator whose delegation died inside the proxy
  // after usage came back: every request row looks healthy, and only the
  // chat's error card says the turn failed.
  makeSessionSummary({
    sessionId: ORCHESTRATOR_SESSION_ID,
    sessionSource: "header",
    source: "chat",
    sources: ["chat"],
    requestCount: 3,
    chatErrorCount: 1,
    totalInputTokens: 18_240,
    totalOutputTokens: 1_102,
    totalCost: "0.0614",
    totalBilledCost: "0.0614",
    totalBaselineCost: "0.0614",
    firstRequestTime: "2026-11-17T19:26:41.000Z",
    lastRequestTime: "2026-11-17T19:27:20.000Z",
    models: ["claude-sonnet-4-5"],
    profileName: "Research orchestrator",
    conversationTitle: "Summarise open incidents across teams",
    lastInteractionType: "anthropic:messages",
    lastUserMessagePreview: "Summarise open incidents across teams",
  }),
  // A coding-agent session whose provider rejected two requests.
  makeSessionSummary({
    sessionId: "cc-failed-session",
    sessionSource: "claude_metadata",
    externalAgentIds: [CLAUDE_CODE_CLIENT_ID],
    claudeCodeTitle: "Refactor the billing worker",
    requestCount: 4,
    failedRequestCount: 2,
    totalInputTokens: 52_100,
    totalOutputTokens: 2_480,
    totalCost: "0.1932",
    totalBilledCost: "0.1932",
    totalBaselineCost: "0.1932",
    firstRequestTime: "2026-11-17T18:02:10.000Z",
    lastRequestTime: "2026-11-17T18:05:44.000Z",
    models: ["claude-opus-4-1"],
    lastInteractionType: "anthropic:messages",
  }),
  makeSessionSummary({
    sessionId: "api-session",
    sessionSource: null,
    source: "api",
    lastUserMessagePreview: "Plain API session message",
    lastInteractionType: "openai:chatCompletions",
    contentNotStored: false,
  }),
];

/**
 * Requests inside the seeded Claude Code session, so the session detail page
 * has a conversation to show rather than the empty state. The ids differ so
 * each row of its request list selects a distinct request.
 */
export const llmLogsInteractionsSeed = [
  makeInteraction({
    id: "cc-interaction-1",
    sessionId: "cc-session",
    createdAt: "2026-08-27T07:54:18.000Z",
    request: {
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: "Which of our MCP servers failed to start this week?",
        },
      ],
    },
    inputTokens: 4210,
    outputTokens: 318,
    cacheReadTokens: 18_400,
    cost: "0.0182",
  }),
  makeInteraction({
    id: "cc-interaction-2",
    sessionId: "cc-session",
    createdAt: "2026-08-27T07:41:02.000Z",
    request: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Summarise yesterday's sync runs." }],
    },
    inputTokens: 1980,
    outputTokens: 145,
    cost: "0.0071",
  }),
];

/**
 * Wraps items in the standard paginated envelope used by the interaction list
 * and sessions endpoints.
 */
export function paginated<T>(
  data: T[],
  overrides: Partial<Pagination> = {},
): { data: T[]; pagination: Pagination } {
  const total = overrides.total ?? data.length;
  return {
    data,
    pagination: {
      currentPage: 1,
      limit: 50,
      total,
      totalPages: total === 0 ? 0 : 1,
      hasNext: false,
      hasPrev: false,
      ...overrides,
    },
  };
}

export function makeInteractionSummary(
  overrides: Partial<InteractionSummary> = {},
): InteractionSummary {
  return {
    id: "test-summary-id",
    profileId: "test-profile-id",
    externalAgentId: null,
    sessionId: "test-session-id",
    model: "claude-sonnet-4-5",
    baselineModel: null,
    billingMode: "metered",
    inputTokens: 1000,
    inputTokensEstimated: false,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: "0.01",
    baselineCost: null,
    durationMs: 2400,
    createdAt: "2026-11-17T19:00:00.000Z",
    providerApiKeyId: null,
    modelPoolId: null,
    attempt: null,
    attemptOutcome: null,
    failureReason: null,
    attributionLabels: null,
    failed: false,
    type: "anthropic:messages",
    externalAgentIdLabel: null,
    requestType: "main",
    source: "chat",
    userMessagePreview: null,
    responseToolNames: null,
    responseToolCalls: null,
    responseTextPreview: null,
    autoRouted: false,
    ...overrides,
  };
}

/** Request rows of the seeded failing sessions, oldest first per session. */
export const llmLogsSummariesSeed: InteractionSummary[] = [
  makeInteractionSummary({
    id: "orch-1",
    sessionId: ORCHESTRATOR_SESSION_ID,
    createdAt: "2026-11-17T19:26:41.000Z",
    durationMs: 3100,
    inputTokens: 5200,
    outputTokens: 310,
    cost: "0.0181",
    userMessagePreview: "Summarise open incidents across teams",
    responseToolNames: ["archestra__list_agents"],
  }),
  makeInteractionSummary({
    id: "orch-2",
    sessionId: ORCHESTRATOR_SESSION_ID,
    createdAt: "2026-11-17T19:27:02.000Z",
    durationMs: 4200,
    inputTokens: 6100,
    outputTokens: 402,
    cost: "0.0203",
    userMessagePreview: "Summarise open incidents across teams",
    responseToolNames: ["agent__incident_triage"],
  }),
  // The delegation call re-issued after the guardrail plan was accepted. Its
  // row is healthy; the delegation itself then failed inside the proxy.
  makeInteractionSummary({
    id: "orch-3",
    sessionId: ORCHESTRATOR_SESSION_ID,
    createdAt: "2026-11-17T19:27:20.000Z",
    durationMs: 3900,
    inputTokens: 6940,
    outputTokens: 390,
    cost: "0.0230",
    userMessagePreview: "Summarise open incidents across teams",
    responseToolNames: ["agent__incident_triage"],
  }),
  makeInteractionSummary({
    id: "ccf-1",
    sessionId: "cc-failed-session",
    source: "api",
    model: "claude-opus-4-1",
    createdAt: "2026-11-17T18:02:10.000Z",
    durationMs: 8200,
    inputTokens: 14_200,
    outputTokens: 940,
    cost: "0.0712",
    userMessagePreview: "Refactor the billing worker",
    responseToolNames: ["Read", "Grep"],
  }),
  makeInteractionSummary({
    id: "ccf-2",
    sessionId: "cc-failed-session",
    source: "api",
    model: "claude-opus-4-1",
    createdAt: "2026-11-17T18:03:31.000Z",
    durationMs: 61_000,
    inputTokens: 15_900,
    outputTokens: 610,
    cost: "0.0640",
    failed: true,
    userMessagePreview: "Refactor the billing worker",
    responseTextPreview: "I'll split the worker into",
  }),
  makeInteractionSummary({
    id: "ccf-3",
    sessionId: "cc-failed-session",
    source: "api",
    model: "claude-opus-4-1",
    createdAt: "2026-11-17T18:04:40.000Z",
    durationMs: 900,
    inputTokens: null,
    outputTokens: null,
    cost: null,
    failed: true,
    userMessagePreview: "Refactor the billing worker",
  }),
  makeInteractionSummary({
    id: "ccf-4",
    sessionId: "cc-failed-session",
    source: "api",
    model: "claude-opus-4-1",
    createdAt: "2026-11-17T18:05:44.000Z",
    durationMs: 9400,
    inputTokens: 22_000,
    outputTokens: 930,
    cost: "0.0580",
    userMessagePreview: "Refactor the billing worker",
    responseTextPreview: "Done. The worker now",
  }),
];

/** The chat's error card for the orchestrator session's failed delegation. */
export const llmLogsChatErrorsSeed: ChatError[] = [
  {
    id: "chat-error-1",
    conversationId: ORCHESTRATOR_SESSION_ID,
    createdAt: "2026-11-17T19:27:21.000Z",
    error: {
      code: "unknown",
      message:
        "Guardrails could not settle a withheld tool call (engine_invariant)",
      isRetryable: false,
      sessionId: ORCHESTRATOR_SESSION_ID,
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      subagent: { name: "Incident triage", model: "claude-sonnet-4-5" },
      originalError: {
        type: "engine_invariant",
        message: "could not settle a withheld tool call",
      },
    },
  },
];
