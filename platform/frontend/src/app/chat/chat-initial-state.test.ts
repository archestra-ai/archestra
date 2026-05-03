import { describe, expect, test } from "vitest";
import {
  buildCreateConversationInput,
  getProviderForModelId,
  resolveChatModelState,
  resolveInitialAgentSelection,
  resolveInitialAgentState,
  resolvePreferredModelForProvider,
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

describe("resolveInitialAgentSelection", () => {
  const agents = [
    { id: "first-agent" },
    { id: "member-default" },
    { id: "saved-agent" },
    { id: "org-default" },
  ];

  test("prefers the organization default over saved and member defaults", () => {
    expect(
      resolveInitialAgentSelection({
        agents,
        organizationDefaultAgentId: "org-default",
        savedAgentId: "saved-agent",
        memberDefaultAgentId: "member-default",
        canUseSavedAgent: true,
      })?.id,
    ).toBe("org-default");
  });

  test("uses saved agent before member default when the picker is available", () => {
    expect(
      resolveInitialAgentSelection({
        agents,
        organizationDefaultAgentId: null,
        savedAgentId: "saved-agent",
        memberDefaultAgentId: "member-default",
        canUseSavedAgent: true,
      })?.id,
    ).toBe("saved-agent");
  });

  test("ignores saved agent when the picker is hidden", () => {
    expect(
      resolveInitialAgentSelection({
        agents,
        organizationDefaultAgentId: null,
        savedAgentId: "saved-agent",
        memberDefaultAgentId: "member-default",
        canUseSavedAgent: false,
      })?.id,
    ).toBe("member-default");
  });

  test("returns null when no agents are available", () => {
    expect(
      resolveInitialAgentSelection({
        agents: [],
        organizationDefaultAgentId: "org-default",
        savedAgentId: "saved-agent",
        memberDefaultAgentId: "member-default",
        canUseSavedAgent: true,
      }),
    ).toBeNull();
  });

  test("falls back to the first agent when no defaults match", () => {
    expect(
      resolveInitialAgentSelection({
        agents,
        organizationDefaultAgentId: null,
        savedAgentId: "missing-saved-agent",
        memberDefaultAgentId: "missing-member-default",
        canUseSavedAgent: true,
      })?.id,
    ).toBe("first-agent");
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

describe("resolveChatModelState", () => {
  test("includes provider information when chat models are supplied", () => {
    const result = resolveChatModelState({
      agent: { id: "agent-1", llmModel: "gpt-4.1", llmApiKeyId: "key-1" },
      modelsByProvider: {
        openai: [{ id: "gpt-4.1", provider: "openai" } as never],
      },
      chatApiKeys: [{ id: "key-1", provider: "openai" }],
      organization: null,
      chatModels: [{ id: "gpt-4.1", provider: "openai" } as never],
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
  test("prefers the best model for a provider", () => {
    expect(
      resolvePreferredModelForProvider({
        provider: "openai",
        modelsByProvider: {
          openai: [
            { id: "gpt-4.1-mini", provider: "openai" } as never,
            { id: "gpt-4.1", provider: "openai", isBest: true } as never,
          ],
        },
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
        modelsByProvider: {},
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
        chatModels: [{ id: "gpt-4.1", provider: "openai" } as never],
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
        chatModels: [],
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
        chatModels: [],
      }),
    ).toBeNull();
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
