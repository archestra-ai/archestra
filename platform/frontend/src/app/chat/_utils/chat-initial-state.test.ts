import { describe, expect, test } from "vitest";
import {
  buildCreateConversationInput,
  resolveChatModelState,
  resolveInitialAgentState,
  resolvePreferredModelForProvider,
  shouldResetInitialChatState,
} from "../_utils/chat-initial-state";

describe("resolveInitialAgentState", () => {
  test("returns org default model for an agent without its own model", () => {
    const result = resolveInitialAgentState({
      agent: { id: "agent-1" },
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

describe("resolveChatModelState", () => {
  test("includes provider information when chat models are supplied", () => {
    const result = resolveChatModelState({
      agent: { id: "agent-1", llmModel: "gpt-4.1", llmApiKeyId: "key-1" },
      chatApiKeys: [{ id: "key-1", provider: "openai" }],
      organization: null,
      selectedModelMetadata: { id: "gpt-4.1", provider: "openai" } as never,
    });

    expect(result).toEqual({
      modelId: "gpt-4.1",
      apiKeyId: "key-1",
      modelSource: "agent",
      provider: "openai",
    });
  });
});

describe("resolvePreferredModelForProvider", () => {
  test("prefers the selected API key best model for a provider", () => {
    expect(
      resolvePreferredModelForProvider({
        provider: "openai",
        apiKeyId: "key-1",
        chatApiKeys: [
          { id: "key-1", provider: "openai", bestModelId: "gpt-4.1" },
        ],
      }),
    ).toEqual({
      modelId: "gpt-4.1",
      provider: "openai",
    });
  });

  test("returns null when the provider has no models", () => {
    expect(
      resolvePreferredModelForProvider({
        provider: "openai",
        apiKeyId: "key-1",
        chatApiKeys: [{ id: "key-1", provider: "openai" }],
      }),
    ).toBeNull();
  });
});

describe("buildCreateConversationInput", () => {
  test("builds the payload from the selected initial chat state", () => {
    expect(
      buildCreateConversationInput({
        agentId: "agent-1",
        modelId: "gpt-4.1",
        chatApiKeyId: "key-1",
        selectedModelMetadata: { id: "gpt-4.1", provider: "openai" } as never,
        chatApiKeys: [{ id: "key-1", provider: "openai" }],
      }),
    ).toEqual({
      agentId: "agent-1",
      selectedModel: "gpt-4.1",
      selectedProvider: "openai",
      chatApiKeyId: "key-1",
    });
  });

  test("builds a minimal payload when model selectors are unavailable", () => {
    expect(
      buildCreateConversationInput({
        agentId: "agent-1",
        modelId: "",
        chatApiKeyId: null,
        selectedModelMetadata: null,
        chatApiKeys: [],
      }),
    ).toEqual({
      agentId: "agent-1",
      selectedModel: undefined,
      selectedProvider: undefined,
      chatApiKeyId: undefined,
    });
  });

  test("returns null when the initial selection is incomplete", () => {
    expect(
      buildCreateConversationInput({
        agentId: null,
        modelId: "",
        chatApiKeyId: null,
        selectedModelMetadata: null,
        chatApiKeys: [],
      }),
    ).toBeNull();
  });

  test("uses selected API key provider when model metadata is unavailable", () => {
    expect(
      buildCreateConversationInput({
        agentId: "agent-1",
        modelId: "gpt-4.1",
        chatApiKeyId: "key-1",
        selectedModelMetadata: null,
        chatApiKeys: [{ id: "key-1", provider: "openai" }],
      }),
    ).toEqual({
      agentId: "agent-1",
      selectedModel: "gpt-4.1",
      selectedProvider: "openai",
      chatApiKeyId: "key-1",
    });
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
