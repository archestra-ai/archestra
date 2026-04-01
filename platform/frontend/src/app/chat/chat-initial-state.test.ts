import { describe, expect, test } from "vitest";
import {
  getProviderForModelId,
  resolveInitialAgentState,
  shouldResetInitialChatState,
} from "./chat-initial-state";

describe("resolveInitialAgentState", () => {
  test("returns org default model for an agent without its own model", () => {
    const result = resolveInitialAgentState({
      agent: { id: "agent-1" },
      modelsByProvider: {
        openai: [{ id: "gpt-4.1", provider: "openai" } as never],
      },
      chatApiKeys: [{ id: "key-1", provider: "openai" }],
      organization: {
        defaultLlmModel: "gpt-4.1",
        defaultLlmApiKeyId: "key-1",
      },
    });

    expect(result).toEqual({
      agentId: "agent-1",
      modelId: "gpt-4.1",
      apiKeyId: "key-1",
      modelSource: "organization",
    });
  });

  test("returns agent-configured model when available", () => {
    const result = resolveInitialAgentState({
      agent: {
        id: "agent-1",
        llmModel: "claude-3-5-sonnet",
        llmApiKeyId: "key-2",
      },
      modelsByProvider: {
        anthropic: [
          { id: "claude-3-5-sonnet", provider: "anthropic" } as never,
        ],
      },
      chatApiKeys: [{ id: "key-2", provider: "anthropic" }],
      organization: {
        defaultLlmModel: "gpt-4.1",
        defaultLlmApiKeyId: "key-1",
      },
    });

    expect(result).toEqual({
      agentId: "agent-1",
      modelId: "claude-3-5-sonnet",
      apiKeyId: "key-2",
      modelSource: "agent",
    });
  });
});

describe("getProviderForModelId", () => {
  test("returns the model provider when present", () => {
    expect(
      getProviderForModelId({
        modelId: "gpt-4.1",
        chatModels: [{ id: "gpt-4.1", provider: "openai" } as never],
      }),
    ).toBe("openai");
  });
});

describe("shouldResetInitialChatState", () => {
  test("does not reset when mounting directly on the initial chat route", () => {
    expect(
      shouldResetInitialChatState({
        previousRouteConversationId: undefined,
        routeConversationId: undefined,
      }),
    ).toBe(false);
  });

  test("resets when leaving a conversation route for the initial chat route", () => {
    expect(
      shouldResetInitialChatState({
        previousRouteConversationId: "conv-1",
        routeConversationId: undefined,
      }),
    ).toBe(true);
  });
});
