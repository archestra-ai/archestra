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
