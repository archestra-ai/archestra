import type { archestraApiTypes } from "@archestra/shared";
// Import runtime values from the leaf `interactions/client` module, not the root
// barrel: the barrel (`@archestra/shared`) transitively imports a JSON module
// without an import attribute, which the Playwright integration-test ESM loader
// rejects. `client.ts` depends only on zod. The `archestraApiTypes` import above
// is type-only, so it is erased and safe.
import {
  CLAUDE_CLIENT_ID,
  CLAUDE_CODE_CLIENT_ID,
} from "@archestra/shared/interactions/client";

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
    seq: 1,
    ...overrides,
  };
}

// Seed sessions for the LLM logs list. Client attribution lives in
// `externalAgentIds`; the "Client" filter sends `client=claude` and the
// query-aware handler matches those rows. Two Claude sessions (header-set
// `claude code` and auto-discovered `claude`) plus a plain API session.
export const llmLogsSessionsSeed = [
  makeSessionSummary({
    sessionId: "cc-session",
    sessionSource: "claude_metadata",
    externalAgentIds: [CLAUDE_CODE_CLIENT_ID],
    claudeCodeTitle: "Claude Code session title",
  }),
  makeSessionSummary({
    sessionId: "cd-session",
    sessionSource: "claude_metadata",
    externalAgentIds: [CLAUDE_CLIENT_ID],
    // Non-api source so the Source + Client filter combo can isolate cc-session.
    source: "chat",
    sources: ["chat"],
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
