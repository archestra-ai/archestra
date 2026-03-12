import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CHAT_STORAGE_KEYS,
  clearSavedModel,
  getApiKeyStorageKey,
  getSavedAgent,
  getSavedApiKey,
  getSavedModel,
  resolveAutoSelectedModel,
  resolveInitialModel,
  saveAgent,
  saveApiKey,
  saveModel,
} from "./use-chat-preferences";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("CHAT_STORAGE_KEYS", () => {
  test("has correct key values", () => {
    expect(CHAT_STORAGE_KEYS.selectedModel).toBe(
      "archestra-chat-selected-chat-model",
    );
    expect(CHAT_STORAGE_KEYS.selectedAgent).toBe("selected-chat-agent");
    expect(CHAT_STORAGE_KEYS.selectedApiKeyPrefix).toBe(
      "selected-chat-api-key-id",
    );
  });
});

describe("getApiKeyStorageKey", () => {
  test("returns provider-specific key", () => {
    expect(getApiKeyStorageKey("openai")).toBe(
      "selected-chat-api-key-id-openai",
    );
    expect(getApiKeyStorageKey("anthropic")).toBe(
      "selected-chat-api-key-id-anthropic",
    );
  });
});

describe("model persistence", () => {
  test("saveModel and getSavedModel round-trip", () => {
    expect(getSavedModel()).toBeNull();
    saveModel("gpt-4o");
    expect(getSavedModel()).toBe("gpt-4o");
  });

  test("clearSavedModel removes the saved model", () => {
    saveModel("gpt-4o");
    clearSavedModel();
    expect(getSavedModel()).toBeNull();
  });
});

describe("agent persistence", () => {
  test("saveAgent and getSavedAgent round-trip", () => {
    expect(getSavedAgent()).toBeNull();
    saveAgent("agent-123");
    expect(getSavedAgent()).toBe("agent-123");
  });
});

describe("API key persistence", () => {
  test("saveApiKey and getSavedApiKey round-trip per provider", () => {
    saveApiKey("openai", "key-1");
    saveApiKey("anthropic", "key-2");
    expect(getSavedApiKey("openai")).toBe("key-1");
    expect(getSavedApiKey("anthropic")).toBe("key-2");
    expect(getSavedApiKey("gemini")).toBeNull();
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
    });
    expect(result).toBeNull();
  });

  test("prefers localStorage model when valid", () => {
    saveModel("claude-3-5-sonnet");
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: null,
      chatApiKeys: baseChatApiKeys,
    });
    expect(result).toEqual({
      modelId: "claude-3-5-sonnet",
      apiKeyId: "key-anthropic",
      source: "localStorage",
    });
  });

  test("clears stale localStorage model and falls through", () => {
    saveModel("deleted-model");
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: null,
      chatApiKeys: baseChatApiKeys,
    });
    // Should have cleared the stale value
    expect(getSavedModel()).toBeNull();
    // Should fall through to first available
    expect(result?.source).toBe("fallback");
    expect(result?.modelId).toBe("gpt-4o");
  });

  test("uses agent model when no localStorage", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: { llmModel: "claude-3-5-sonnet", llmApiKeyId: "agent-key" },
      chatApiKeys: baseChatApiKeys,
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
    });
    expect(result?.source).toBe("fallback");
  });

  test("falls back to first available model", () => {
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: null,
      chatApiKeys: baseChatApiKeys,
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
    });
    expect(result?.modelId).toBe("gpt-4o");
    expect(result?.apiKeyId).toBeNull();
  });

  test("localStorage takes priority over agent config", () => {
    saveModel("gpt-4o");
    const result = resolveInitialModel({
      modelsByProvider: baseModels,
      agent: { llmModel: "claude-3-5-sonnet", llmApiKeyId: "agent-key" },
      chatApiKeys: baseChatApiKeys,
    });
    expect(result?.source).toBe("localStorage");
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
