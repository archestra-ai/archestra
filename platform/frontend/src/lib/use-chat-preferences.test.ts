import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CHAT_STORAGE_KEYS,
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
      source: "agent",
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
      source: "organization",
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
      source: "agent",
    });
  });

  test("skips agent model when model is not in available models", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: { llmModel: "deleted-model", llmApiKeyId: "agent-key" },
      chatApiKeys: baseChatApiKeys,
      organization: null,
    });
    expect(result?.source).toBe("fallback");
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
      source: "fallback",
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
      source: "organization",
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
      source: "organization",
    });
  });

  test("skips org default when model is not in available models", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: null,
      chatApiKeys: baseChatApiKeys,
      organization: {
        defaultLlmModel: "deleted-model",
        defaultLlmApiKeyId: "key-openai",
      },
    });
    expect(result?.source).toBe("fallback");
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
      source: "agent",
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
      source: "organization",
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
    expect(first?.source).toBe("agent");

    // Switching to second agent should resolve to org default, NOT keep the first agent's values
    const second = resolveModelForAgent({
      agent: agentWithoutConfig,
      context: baseContext,
    });
    expect(second?.modelId).toBe("gpt-4o");
    expect(second?.apiKeyId).toBe("key-openai");
    expect(second?.source).toBe("organization");
  });

  test("handles agent with non-string llmModel gracefully", () => {
    const result = resolveModelForAgent({
      agent: { llmModel: undefined, llmApiKeyId: undefined },
      context: baseContext,
    });
    expect(result?.source).toBe("organization");
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
