import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  agentRequiresPerUserConnect,
  CHAT_STORAGE_KEYS,
  deriveModelSource,
  getSavedAgent,
  resolveAutoSelectedModel,
  resolveInitialModel,
  resolveModelForAgent,
  saveAgent,
} from "./use-chat-preferences";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("CHAT_STORAGE_KEYS", () => {
  test("has correct key values", () => {
    expect(CHAT_STORAGE_KEYS.selectedAgent).toBe("selected-chat-agent");
  });
});

describe("agent persistence", () => {
  test("saveAgent and getSavedAgent round-trip", () => {
    expect(getSavedAgent()).toBeNull();
    saveAgent("agent-123");
    expect(getSavedAgent()).toBe("agent-123");
  });
});

describe("resolveInitialModel", () => {
  // Model identifiers are models.id UUIDs.
  const baseModels = {
    openai: [{ id: "uuid-gpt-4o" }, { id: "uuid-gpt-4o-mini", isBest: true }],
    anthropic: [{ id: "uuid-sonnet" }],
  };
  const baseChatApiKeys = [
    { id: "key-openai", provider: "openai" },
    { id: "key-anthropic", provider: "anthropic" },
  ];

  test("returns null when no models available", () => {
    expect(
      resolveInitialModel({
        modelsByProvider: {},
        agent: null,
        chatApiKeys: [],
        organization: null,
        memberDefault: null,
      }),
    ).toBeNull();
  });

  test("prefers the member default over the agent and org defaults", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: { modelId: "uuid-sonnet", llmApiKeyId: "key-anthropic" },
      chatApiKeys: baseChatApiKeys,
      organization: {
        defaultModelId: "uuid-gpt-4o",
        defaultLlmApiKeyId: "key-openai",
      },
      memberDefault: {
        modelId: "uuid-gpt-4o-mini",
        chatApiKeyId: "key-openai",
      },
    });
    expect(result).toEqual({
      modelId: "uuid-gpt-4o-mini",
      apiKeyId: "key-openai",
    });
  });

  test("prefers the agent model over the org default", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: { modelId: "uuid-sonnet", llmApiKeyId: "key-anthropic" },
      chatApiKeys: baseChatApiKeys,
      organization: {
        defaultModelId: "uuid-gpt-4o",
        defaultLlmApiKeyId: "key-openai",
      },
      memberDefault: null,
    });
    expect(result).toEqual({
      modelId: "uuid-sonnet",
      apiKeyId: "key-anthropic",
    });
  });

  test("uses the org default when the agent has no model", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: { modelId: null, llmApiKeyId: null },
      chatApiKeys: baseChatApiKeys,
      organization: {
        defaultModelId: "uuid-gpt-4o",
        defaultLlmApiKeyId: "key-openai",
      },
      memberDefault: null,
    });
    expect(result).toEqual({ modelId: "uuid-gpt-4o", apiKeyId: "key-openai" });
  });

  test("a member default with no key falls through to the agent", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: { modelId: "uuid-sonnet", llmApiKeyId: "key-anthropic" },
      chatApiKeys: baseChatApiKeys,
      organization: null,
      memberDefault: { modelId: "uuid-gpt-4o-mini", chatApiKeyId: null },
    });
    expect(result).toEqual({
      modelId: "uuid-sonnet",
      apiKeyId: "key-anthropic",
    });
  });

  test("falls back to the best available model when nothing is configured", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: null,
      chatApiKeys: baseChatApiKeys,
      organization: null,
      memberDefault: null,
    });
    // uuid-gpt-4o-mini is marked best.
    expect(result?.modelId).toBe("uuid-gpt-4o-mini");
  });

  // A per-user provider (GitHub Copilot) is catalogued org-wide but its key is
  // the viewer's own, resolved at send time. A member viewing an org/agent
  // default that points at a Copilot model holds no key for it, so the model
  // must still be selected (by model alone) with the key dropped.
  const copilotModels = {
    ...baseModels,
    "github-copilot": [{ id: "uuid-copilot-sonnet", isBest: true }],
  };

  test("resolves an org default pointing at a per-user model, dropping the key", () => {
    const result = resolveInitialModel({
      modelsByProvider: copilotModels,
      agent: { modelId: null, llmApiKeyId: null },
      // The member has no GitHub Copilot key — only openai/anthropic.
      chatApiKeys: baseChatApiKeys,
      organization: {
        defaultModelId: "uuid-copilot-sonnet",
        // The admin's personal Copilot key — not visible/usable by the member.
        defaultLlmApiKeyId: "key-admin-copilot",
      },
      memberDefault: null,
    });
    expect(result).toEqual({ modelId: "uuid-copilot-sonnet", apiKeyId: null });
  });

  test("resolves an agent default pointing at a per-user model, dropping the key", () => {
    const result = resolveInitialModel({
      modelsByProvider: copilotModels,
      agent: {
        modelId: "uuid-copilot-sonnet",
        llmApiKeyId: "key-owner-copilot",
      },
      chatApiKeys: baseChatApiKeys,
      organization: null,
      memberDefault: null,
    });
    expect(result).toEqual({ modelId: "uuid-copilot-sonnet", apiKeyId: null });
  });

  test("keeps the member's own keyed model over a lower per-user org default", () => {
    const result = resolveInitialModel({
      modelsByProvider: copilotModels,
      agent: { modelId: null, llmApiKeyId: null },
      chatApiKeys: baseChatApiKeys,
      organization: {
        defaultModelId: "uuid-copilot-sonnet",
        defaultLlmApiKeyId: "key-admin-copilot",
      },
      memberDefault: { modelId: "uuid-gpt-4o", chatApiKeyId: "key-openai" },
    });
    expect(result).toEqual({ modelId: "uuid-gpt-4o", apiKeyId: "key-openai" });
  });
});

describe("resolveModelForAgent", () => {
  test("delegates to the agent + org + best chain", () => {
    const result = resolveModelForAgent({
      agent: { modelId: null, llmApiKeyId: null },
      context: {
        modelsByProvider: { openai: [{ id: "uuid-gpt-4o" }] },
        chatApiKeys: [{ id: "key-openai", provider: "openai" }],
        organization: {
          defaultModelId: "uuid-gpt-4o",
          defaultLlmApiKeyId: "key-openai",
        },
        memberDefault: null,
      },
    });
    expect(result).toEqual({ modelId: "uuid-gpt-4o", apiKeyId: "key-openai" });
  });
});

describe("resolveAutoSelectedModel", () => {
  const models = [{ id: "uuid-a", isBest: true }, { id: "uuid-b" }];

  test("returns null while loading", () => {
    expect(
      resolveAutoSelectedModel({
        selectedModel: "uuid-x",
        availableModels: models,
        isLoading: true,
      }),
    ).toBeNull();
  });

  test("returns null when the selected model is available", () => {
    expect(
      resolveAutoSelectedModel({
        selectedModel: "uuid-b",
        availableModels: models,
        isLoading: false,
      }),
    ).toBeNull();
  });

  test("selects the best model when the selected model is unavailable", () => {
    expect(
      resolveAutoSelectedModel({
        selectedModel: "uuid-deleted",
        availableModels: models,
        isLoading: false,
      }),
    ).toBe("uuid-a");
  });

  test("prefers a keyed model over an unconnected per-user 'best' model", () => {
    expect(
      resolveAutoSelectedModel({
        selectedModel: "uuid-deleted",
        availableModels: [
          {
            id: "uuid-copilot",
            isBest: true,
            requiresUserConnection: true,
            isConnected: false,
          },
          { id: "uuid-kimi" },
        ],
        isLoading: false,
      }),
    ).toBe("uuid-kimi");
  });

  test("falls back to an unconnected per-user model when nothing else is available", () => {
    expect(
      resolveAutoSelectedModel({
        selectedModel: "uuid-deleted",
        availableModels: [
          {
            id: "uuid-copilot",
            isBest: true,
            requiresUserConnection: true,
            isConnected: false,
          },
        ],
        isLoading: false,
      }),
    ).toBe("uuid-copilot");
  });

  test("a connected per-user 'best' model stays eligible", () => {
    expect(
      resolveAutoSelectedModel({
        selectedModel: "uuid-deleted",
        availableModels: [
          {
            id: "uuid-copilot",
            isBest: true,
            requiresUserConnection: true,
            isConnected: true,
          },
          { id: "uuid-kimi" },
        ],
        isLoading: false,
      }),
    ).toBe("uuid-copilot");
  });
});

describe("agentRequiresPerUserConnect", () => {
  const perUserAgent = {
    modelId: "uuid-copilot",
    llmProviderRequiresPerUserCredential: true,
  };

  test("true when the per-user agent model is selected but unavailable", () => {
    expect(
      agentRequiresPerUserConnect({
        agent: perUserAgent,
        selectedModelId: "uuid-copilot",
        isModelAvailable: false,
      }),
    ).toBe(true);
  });

  test("false when the viewer can use the model (connected)", () => {
    expect(
      agentRequiresPerUserConnect({
        agent: perUserAgent,
        selectedModelId: "uuid-copilot",
        isModelAvailable: true,
      }),
    ).toBe(false);
  });

  test("false when the selection is not the agent's pinned model (user override)", () => {
    expect(
      agentRequiresPerUserConnect({
        agent: perUserAgent,
        selectedModelId: "uuid-other",
        isModelAvailable: false,
      }),
    ).toBe(false);
  });

  test("false for a non-per-user provider agent", () => {
    expect(
      agentRequiresPerUserConnect({
        agent: {
          modelId: "uuid-anthropic",
          llmProviderRequiresPerUserCredential: false,
        },
        selectedModelId: "uuid-anthropic",
        isModelAvailable: false,
      }),
    ).toBe(false);
  });

  test("false when no agent is selected", () => {
    expect(
      agentRequiresPerUserConnect({
        agent: undefined,
        selectedModelId: "uuid-copilot",
        isModelAvailable: false,
      }),
    ).toBe(false);
  });
});

describe("deriveModelSource", () => {
  test("'agent' when the model matches the agent default", () => {
    expect(
      deriveModelSource({
        selectedModelId: "uuid-a",
        agentModelId: "uuid-a",
        orgModelId: "uuid-o",
      }),
    ).toBe("agent");
  });

  test("null when nothing is configured", () => {
    expect(
      deriveModelSource({
        selectedModelId: "uuid-a",
        agentModelId: null,
        orgModelId: null,
      }),
    ).toBeNull();
  });
});
