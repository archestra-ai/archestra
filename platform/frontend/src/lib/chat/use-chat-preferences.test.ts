import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
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
  const baseModels = {
    openai: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
    anthropic: [{ id: "claude-3-5-sonnet" }],
  };

  const baseChatApiKeys = [
    { id: "key-openai", provider: "openai" },
    { id: "key-anthropic", provider: "anthropic" },
  ];

  test("returns null when no models available", () => {
    const result = resolveInitialModel({
      modelsByProvider: {},
      agent: null,
      chatApiKeys: [],
      organization: null,
    });
    expect(result).toBeNull();
  });

  test("prefers agent model over org default", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: { llmModel: "claude-3-5-sonnet", llmApiKeyId: "agent-key" },
      chatApiKeys: baseChatApiKeys,
      organization: {
        defaultLlmModel: "gpt-4o",
        defaultLlmApiKeyId: "key-openai",
      },
    });
    expect(result).toEqual({
      modelId: "claude-3-5-sonnet",
      apiKeyId: "agent-key",
    });
  });

  test("uses org default when agent has no model configured", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: { llmModel: null, llmApiKeyId: null },
      chatApiKeys: baseChatApiKeys,
      organization: {
        defaultLlmModel: "gpt-4o",
        defaultLlmApiKeyId: "key-openai",
      },
    });
    expect(result).toEqual({
      modelId: "gpt-4o",
      apiKeyId: "key-openai",
    });
  });

  test("uses agent model with agent API key", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: { llmModel: "claude-3-5-sonnet", llmApiKeyId: "agent-key" },
      chatApiKeys: baseChatApiKeys,
      organization: null,
    });
    expect(result).toEqual({
      modelId: "claude-3-5-sonnet",
      apiKeyId: "agent-key",
    });
  });

  test("falls back when the agent model is not in available models", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: { llmModel: "deleted-model", llmApiKeyId: "agent-key" },
      chatApiKeys: baseChatApiKeys,
      organization: null,
    });
    expect(result?.modelId).toBe("gpt-4o");
  });

  test("falls back to first available model", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: null,
      chatApiKeys: baseChatApiKeys,
      organization: null,
    });
    expect(result).toEqual({
      modelId: "gpt-4o",
      apiKeyId: "key-openai",
    });
  });

  test("fallback prefers the model marked best over the first one", () => {
    // The "best" model is listed second; without the isBest check the
    // fallback would pick the (cheaper/faster) first model instead.
    const result = resolveInitialModel({
      modelsByProvider: {
        anthropic: [
          { id: "claude-haiku-4-5" },
          { id: "claude-opus-4-6", isBest: true },
        ],
      },
      agent: null,
      chatApiKeys: [{ id: "key-anthropic", provider: "anthropic" }],
      organization: null,
    });
    expect(result).toEqual({
      modelId: "claude-opus-4-6",
      apiKeyId: "key-anthropic",
    });
  });

  test("returns null apiKeyId when no matching key for provider", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: null,
      chatApiKeys: [], // No keys at all
      organization: null,
    });
    expect(result?.modelId).toBe("gpt-4o");
    expect(result?.apiKeyId).toBeNull();
  });

  test("org default falls back to provider key when org API key is not available", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: null,
      chatApiKeys: baseChatApiKeys,
      organization: {
        defaultLlmModel: "gpt-4o",
        defaultLlmApiKeyId: "deleted-key",
      },
    });
    expect(result).toEqual({
      modelId: "gpt-4o",
      apiKeyId: "key-openai",
    });
  });

  test("org default with no API key configured uses provider key", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: null,
      chatApiKeys: baseChatApiKeys,
      organization: {
        defaultLlmModel: "gpt-4o",
        defaultLlmApiKeyId: null,
      },
    });
    expect(result).toEqual({
      modelId: "gpt-4o",
      apiKeyId: "key-openai",
    });
  });

  test("falls back when org default model is not in available models", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: null,
      chatApiKeys: baseChatApiKeys,
      organization: {
        defaultLlmModel: "deleted-model",
        defaultLlmApiKeyId: "key-openai",
      },
    });
    expect(result?.modelId).toBe("gpt-4o");
  });
});

describe("resolveAutoSelectedModel", () => {
  const models = [
    { id: "gpt-4o", isBest: true },
    { id: "gpt-4o-mini" },
    { id: "claude-3-5-sonnet" },
  ];

  test("returns null while loading", () => {
    expect(
      resolveAutoSelectedModel({
        selectedModel: "nonexistent",
        availableModels: models,
        isLoading: true,
      }),
    ).toBeNull();
  });

  test("returns null when no models available", () => {
    expect(
      resolveAutoSelectedModel({
        selectedModel: "gpt-4o",
        availableModels: [],
        isLoading: false,
      }),
    ).toBeNull();
  });

  test("returns null when selectedModel is empty (parent still initializing)", () => {
    expect(
      resolveAutoSelectedModel({
        selectedModel: "",
        availableModels: models,
        isLoading: false,
      }),
    ).toBeNull();
  });

  test("returns null when selected model is available (no change needed)", () => {
    expect(
      resolveAutoSelectedModel({
        selectedModel: "gpt-4o",
        availableModels: models,
        isLoading: false,
      }),
    ).toBeNull();
  });

  test("selects best model when selected model is unavailable", () => {
    expect(
      resolveAutoSelectedModel({
        selectedModel: "deleted-model",
        availableModels: models,
        isLoading: false,
      }),
    ).toBe("gpt-4o"); // isBest: true
  });

  test("selects first model when no best model and selected is unavailable", () => {
    const noBestModels = [{ id: "model-a" }, { id: "model-b" }];
    expect(
      resolveAutoSelectedModel({
        selectedModel: "deleted-model",
        availableModels: noBestModels,
        isLoading: false,
      }),
    ).toBe("model-a");
  });

  test("does NOT auto-select when model is available (race condition regression)", () => {
    // This is the key regression test: during initialization, the API key
    // transitions from null → "key1". The old code treated this as an
    // "apiKey change" and force-selected the best model, overwriting
    // the user's saved choice. The fix ensures we only auto-select
    // when the model is genuinely unavailable.
    expect(
      resolveAutoSelectedModel({
        selectedModel: "claude-3-5-sonnet", // user's saved model
        availableModels: models, // model IS in the list
        isLoading: false,
      }),
    ).toBeNull(); // should NOT switch to gpt-4o
  });
});

describe("resolveModelForAgent", () => {
  const baseModels = {
    openai: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
    anthropic: [{ id: "claude-3-5-sonnet" }],
  };

  const baseChatApiKeys = [
    { id: "key-openai", provider: "openai" },
    { id: "key-anthropic", provider: "anthropic" },
  ];

  const orgDefaults = {
    defaultLlmModel: "gpt-4o",
    defaultLlmApiKeyId: "key-openai",
  };

  const baseContext = {
    modelsByProvider: baseModels,
    chatApiKeys: baseChatApiKeys,
    organization: orgDefaults,
  };

  test("uses agent's direct model/key when configured", () => {
    const result = resolveModelForAgent({
      agent: {
        llmModel: "claude-3-5-sonnet",
        llmApiKeyId: "key-anthropic",
      },
      context: baseContext,
    });
    expect(result).toEqual({
      modelId: "claude-3-5-sonnet",
      apiKeyId: "key-anthropic",
    });
  });

  test("falls back to org default when agent has no model configured", () => {
    const result = resolveModelForAgent({
      agent: { llmModel: null, llmApiKeyId: null },
      context: baseContext,
    });
    expect(result).toEqual({
      modelId: "gpt-4o",
      apiKeyId: "key-openai",
    });
  });

  test("switching from agent with direct config to agent with org default resolves correctly", () => {
    const agentWithConfig = {
      llmModel: "claude-3-5-sonnet",
      llmApiKeyId: "key-anthropic",
    };
    const agentWithoutConfig = {
      llmModel: null,
      llmApiKeyId: null,
    };

    // First agent resolves to its own config
    const first = resolveModelForAgent({
      agent: agentWithConfig,
      context: baseContext,
    });
    expect(first?.modelId).toBe("claude-3-5-sonnet");
    expect(first?.apiKeyId).toBe("key-anthropic");

    // Switching to second agent should resolve to org default, NOT keep the first agent's values
    const second = resolveModelForAgent({
      agent: agentWithoutConfig,
      context: baseContext,
    });
    expect(second?.modelId).toBe("gpt-4o");
    expect(second?.apiKeyId).toBe("key-openai");
  });

  test("handles agent with non-string llmModel gracefully", () => {
    const result = resolveModelForAgent({
      agent: { llmModel: undefined, llmApiKeyId: undefined },
      context: baseContext,
    });
    expect(result?.modelId).toBe("gpt-4o");
  });

  test("switching between two agents with different direct configs", () => {
    const agentA = {
      llmModel: "gpt-4o",
      llmApiKeyId: "key-openai",
    };
    const agentB = {
      llmModel: "claude-3-5-sonnet",
      llmApiKeyId: "key-anthropic",
    };

    const resultA = resolveModelForAgent({
      agent: agentA,
      context: baseContext,
    });
    expect(resultA?.modelId).toBe("gpt-4o");

    const resultB = resolveModelForAgent({
      agent: agentB,
      context: baseContext,
    });
    expect(resultB?.modelId).toBe("claude-3-5-sonnet");
  });
});

describe("deriveModelSource", () => {
  test("returns null when no model is selected", () => {
    expect(
      deriveModelSource({
        selectedModel: "",
        agentLlmModel: "gpt-4o",
        orgDefaultLlmModel: "claude-3-5-sonnet",
      }),
    ).toBeNull();
  });

  test("'agent' when the model matches the agent's configured model", () => {
    expect(
      deriveModelSource({
        selectedModel: "gpt-4o",
        agentLlmModel: "gpt-4o",
        orgDefaultLlmModel: "claude-3-5-sonnet",
      }),
    ).toBe("agent");
  });

  test("'organization' when the model matches the org default", () => {
    expect(
      deriveModelSource({
        selectedModel: "claude-3-5-sonnet",
        agentLlmModel: null,
        orgDefaultLlmModel: "claude-3-5-sonnet",
      }),
    ).toBe("organization");
  });

  test("'user' when the model matches neither default", () => {
    expect(
      deriveModelSource({
        selectedModel: "gpt-4o-mini",
        agentLlmModel: "gpt-4o",
        orgDefaultLlmModel: "claude-3-5-sonnet",
      }),
    ).toBe("user");
  });

  test("agent takes precedence over the org default", () => {
    expect(
      deriveModelSource({
        selectedModel: "gpt-4o",
        agentLlmModel: "gpt-4o",
        orgDefaultLlmModel: "gpt-4o",
      }),
    ).toBe("agent");
  });

  test("'user' when nothing is configured", () => {
    expect(
      deriveModelSource({
        selectedModel: "gpt-4o",
        agentLlmModel: null,
        orgDefaultLlmModel: null,
      }),
    ).toBe("user");
  });
});
