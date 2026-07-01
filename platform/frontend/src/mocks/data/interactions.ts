import type { archestraApiTypes } from "@archestra/shared";

type SessionSummary =
  archestraApiTypes.GetInteractionSessionsResponses["200"]["data"][number];
type Interaction = archestraApiTypes.GetInteractionResponses["200"];
// The factory builds the OpenAI chat-completions member of the interaction
// union, which keeps `request`/`response` overrides cleanly typed.
type OpenAiInteraction = Extract<
  Interaction,
  { type: "openai:chatCompletions" }
>;

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
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCost: "0.01",
    totalBaselineCost: "0.01",
    totalToonCostSavings: null,
    totalCacheSavings: null,
    toonSkipReasonCounts: {
      applied: 0,
      notEnabled: 0,
      notEffective: 0,
      noToolResults: 0,
    },
    firstRequestTime: "2026-01-01T00:00:00.000Z",
    lastRequestTime: "2026-01-01T00:00:00.000Z",
    models: ["gpt-4o"],
    profileId: "test-profile-id",
    profileName: "Test Agent",
    externalAgentIds: [],
    externalAgentIdLabels: [],
    authMethods: [],
    authenticatedAppNames: [],
    userNames: [],
    lastInteractionRequest: null,
    lastInteractionType: null,
    conversationTitle: null,
    claudeCodeTitle: null,
    ...overrides,
  };
}

export function makeInteraction(
  overrides: Partial<OpenAiInteraction> = {},
): OpenAiInteraction {
  return {
    id: "test-interaction-id",
    profileId: "test-profile-id",
    externalAgentId: null,
    executionId: null,
    userId: null,
    virtualKeyId: null,
    passthroughVirtualKeyId: null,
    environmentId: null,
    sessionId: "test-session-id",
    sessionSource: null,
    authenticatedAppId: null,
    authenticatedAppName: null,
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
    toonTokensBefore: null,
    toonTokensAfter: null,
    toonCostSavings: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Seed sessions for the LLM logs list, each with a distinct client/session
// source and identifiable title, so a query-aware handler can filter them by
// the `sessionSource` the frontend actually sends.
export const llmLogsSessionsSeed = [
  makeSessionSummary({
    sessionId: "cc-session",
    sessionSource: "claude_code",
    claudeCodeTitle: "Claude Code session title",
  }),
  makeSessionSummary({
    sessionId: "cd-session",
    sessionSource: "claude_desktop",
    claudeCodeTitle: "Claude Desktop session title",
  }),
  makeSessionSummary({
    sessionId: "api-session",
    sessionSource: null,
    source: "api",
    lastInteractionType: "openai:chatCompletions",
    lastInteractionRequest: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Plain API session message" }],
    },
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
