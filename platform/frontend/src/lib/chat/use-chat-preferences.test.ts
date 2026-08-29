import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  agentNotRecommendedForModel,
  agentRequiresPerUserConnect,
  agentToolsUnavailableForModel,
  CHAT_STORAGE_KEYS,
  deriveModelSource,
  getAgentSubscriptionConnection,
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

  test("true when the selected per-user agent model is catalogued but not connected", () => {
    expect(
      agentRequiresPerUserConnect({
        agent: perUserAgent,
        selectedModelId: "uuid-copilot",
        selectedModel: {
          dbId: "uuid-copilot",
          requiresUserConnection: true,
          isConnected: false,
        },
      }),
    ).toBe(true);
  });

  test("false when the viewer can use the model (connected)", () => {
    expect(
      agentRequiresPerUserConnect({
        agent: perUserAgent,
        selectedModelId: "uuid-copilot",
        selectedModel: {
          dbId: "uuid-copilot",
          requiresUserConnection: true,
          isConnected: true,
        },
      }),
    ).toBe(false);
  });

  test("supports a credential-level subscription on a shared provider", () => {
    expect(
      agentRequiresPerUserConnect({
        agent: {
          modelId: "uuid-chatgpt",
          llmProviderRequiresPerUserCredential: false,
        },
        selectedModelId: "uuid-chatgpt",
        selectedModel: undefined,
        requiresPerUserCredential: true,
        isCredentialConnected: false,
      }),
    ).toBe(true);
  });

  test("false when the selection is not the agent's pinned model (user override)", () => {
    expect(
      agentRequiresPerUserConnect({
        agent: perUserAgent,
        selectedModelId: "uuid-other",
        selectedModel: undefined,
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
        selectedModel: undefined,
      }),
    ).toBe(false);
  });

  test("false when no agent is selected", () => {
    expect(
      agentRequiresPerUserConnect({
        agent: undefined,
        selectedModelId: "uuid-copilot",
        selectedModel: undefined,
      }),
    ).toBe(false);
  });
});

describe("getAgentSubscriptionConnection", () => {
  const xPremiumAgent = {
    llmApiKeyId: "owner-x-premium",
    resolvedLlmProvider: "xai" as const,
    llmProviderRequiresPerUserCredential: false,
  };
  // The owner's pinned SuperGrok key, as the included agent key (`isAgentKey`)
  // path returns it to a viewer who can't list it: metadata only, another
  // user's row.
  const pinnedXPremiumKey = {
    id: "owner-x-premium",
    provider: "xai" as const,
    name: "SuperGrok",
    userId: "owner",
    subscriptionKind: "x-premium" as const,
  };

  test("gates a SuperGrok shared agent for a viewer with no credentials", () => {
    expect(
      getAgentSubscriptionConnection({
        agent: xPremiumAgent,
        credentials: [pinnedXPremiumKey],
        userId: "viewer",
      }),
    ).toEqual({ requiresConnection: true, isConnected: false });
  });

  test("a plain personal xAI console key does not count as connected (kind-matched, like the send path)", () => {
    expect(
      getAgentSubscriptionConnection({
        agent: xPremiumAgent,
        credentials: [
          pinnedXPremiumKey,
          {
            id: "viewer-xai-console",
            provider: "xai",
            name: "My xAI Key",
            userId: "viewer",
            subscriptionKind: null,
          },
        ],
        userId: "viewer",
      }),
    ).toEqual({ requiresConnection: true, isConnected: false });
  });

  test("the viewer's own SuperGrok key connects the agent", () => {
    expect(
      getAgentSubscriptionConnection({
        agent: xPremiumAgent,
        credentials: [
          pinnedXPremiumKey,
          {
            id: "viewer-x-premium",
            provider: "xai",
            name: "SuperGrok",
            userId: "viewer",
            subscriptionKind: "x-premium",
          },
        ],
        userId: "viewer",
      }),
    ).toEqual({ requiresConnection: true, isConnected: true });
  });

  test("a ChatGPT display name without authoritative metadata does not gate", () => {
    const agent = {
      llmApiKeyId: "owner-chatgpt",
      resolvedLlmProvider: "openai" as const,
      llmProviderRequiresPerUserCredential: false,
    };
    const pinnedLegacyChatgpt = {
      id: "owner-chatgpt",
      provider: "openai" as const,
      name: "ChatGPT Subscription",
      userId: "owner",
    };
    expect(
      getAgentSubscriptionConnection({
        agent,
        credentials: [pinnedLegacyChatgpt],
        userId: "viewer",
      }),
    ).toEqual({ requiresConnection: false, isConnected: undefined });
  });

  test("a SuperGrok display name without authoritative metadata does not gate", () => {
    const agent = {
      llmApiKeyId: "owner-x-premium-nokind",
      resolvedLlmProvider: "xai" as const,
      llmProviderRequiresPerUserCredential: false,
    };
    const pinnedNameOnly = {
      id: "owner-x-premium-nokind",
      provider: "xai" as const,
      name: "SuperGrok",
      userId: "owner",
    };
    expect(
      getAgentSubscriptionConnection({
        agent,
        credentials: [pinnedNameOnly],
        userId: "viewer",
      }),
    ).toEqual({ requiresConnection: false, isConnected: undefined });
  });

  test("an ordinary shared key requires no connection", () => {
    expect(
      getAgentSubscriptionConnection({
        agent: {
          llmApiKeyId: "org-openai",
          resolvedLlmProvider: "openai" as const,
          llmProviderRequiresPerUserCredential: false,
        },
        credentials: [
          {
            id: "org-openai",
            provider: "openai",
            name: "OpenAI Key",
            userId: null,
            subscriptionKind: null,
          },
        ],
        userId: "viewer",
      }),
    ).toEqual({ requiresConnection: false, isConnected: undefined });
  });

  test("a provider-level subscription (Copilot) accepts any personal key of the provider", () => {
    expect(
      getAgentSubscriptionConnection({
        agent: {
          llmApiKeyId: "owner-copilot",
          resolvedLlmProvider: "github-copilot" as const,
          llmProviderRequiresPerUserCredential: true,
        },
        credentials: [
          {
            id: "viewer-copilot",
            provider: "github-copilot",
            name: "GitHub Copilot",
            userId: "viewer",
          },
        ],
        userId: "viewer",
      }),
    ).toEqual({ requiresConnection: true, isConnected: true });
  });
});

describe("agentToolsUnavailableForModel", () => {
  const noToolsModel = {
    dbId: "uuid-m365",
    capabilities: { supportsToolCalling: false },
  };
  const toolCallingModel = {
    dbId: "uuid-anthropic",
    capabilities: { supportsToolCalling: true },
  };
  const unknownCapabilityModel = { dbId: "uuid-unknown" };
  const models = [noToolsModel, toolCallingModel, unknownCapabilityModel];

  test("true for a tooled agent on a no-tools model", () => {
    expect(
      agentToolsUnavailableForModel({
        agent: { accessAllTools: false, tools: [{}] },
        selectedModelId: "uuid-m365",
        models,
      }),
    ).toBe(true);
  });

  test("true for an Auto-mode agent (no assignments) on a no-tools model", () => {
    expect(
      agentToolsUnavailableForModel({
        agent: { accessAllTools: true, tools: [] },
        selectedModelId: "uuid-m365",
        models,
      }),
    ).toBe(true);
  });

  test("false for a tool-less Custom agent on a no-tools model", () => {
    expect(
      agentToolsUnavailableForModel({
        agent: { accessAllTools: false, tools: [] },
        selectedModelId: "uuid-m365",
        models,
      }),
    ).toBe(false);
  });

  test("false when the model supports tool calling", () => {
    expect(
      agentToolsUnavailableForModel({
        agent: { accessAllTools: true, tools: [{}] },
        selectedModelId: "uuid-anthropic",
        models,
      }),
    ).toBe(false);
  });

  test("false when the model's capability is unknown", () => {
    expect(
      agentToolsUnavailableForModel({
        agent: { accessAllTools: true, tools: [{}] },
        selectedModelId: "uuid-unknown",
        models,
      }),
    ).toBe(false);
  });

  test("false without an agent or a selection", () => {
    expect(
      agentToolsUnavailableForModel({
        agent: undefined,
        selectedModelId: "uuid-m365",
        models,
      }),
    ).toBe(false);
    expect(
      agentToolsUnavailableForModel({
        agent: { accessAllTools: true, tools: [] },
        selectedModelId: null,
        models,
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

describe("agentNotRecommendedForModel", () => {
  const flaggedModel = {
    dbId: "uuid-qwen-4b",
    capabilities: { recommendedForAgents: false, supportsToolCalling: true },
  };
  const recommendedModel = {
    dbId: "uuid-llama-70b",
    capabilities: { recommendedForAgents: true, supportsToolCalling: true },
  };
  // Nothing evaluated this model, so the sync left the verdict null.
  const unjudgedModel = {
    dbId: "uuid-anthropic",
    capabilities: { supportsToolCalling: true },
  };
  const flaggedAndToolless = {
    dbId: "uuid-tiny-no-tools",
    capabilities: { recommendedForAgents: false, supportsToolCalling: false },
  };
  const models = [
    flaggedModel,
    recommendedModel,
    unjudgedModel,
    flaggedAndToolless,
  ];

  test("true for a tooled agent on a flagged model", () => {
    expect(
      agentNotRecommendedForModel({
        agent: { accessAllTools: false, tools: [{}] },
        selectedModelId: "uuid-qwen-4b",
        models,
      }),
    ).toBe(true);
  });

  test("true for an Auto-mode agent (no assignments) on a flagged model", () => {
    expect(
      agentNotRecommendedForModel({
        agent: { accessAllTools: true, tools: [] },
        selectedModelId: "uuid-qwen-4b",
        models,
      }),
    ).toBe(true);
  });

  // A flagged model doing plain chat is fine; the verdict only matters for
  // agentic use.
  test("false for a tool-less Custom agent on a flagged model", () => {
    expect(
      agentNotRecommendedForModel({
        agent: { accessAllTools: false, tools: [] },
        selectedModelId: "uuid-qwen-4b",
        models,
      }),
    ).toBe(false);
  });

  test("false for a recommended model", () => {
    expect(
      agentNotRecommendedForModel({
        agent: { accessAllTools: true, tools: [{}] },
        selectedModelId: "uuid-llama-70b",
        models,
      }),
    ).toBe(false);
  });

  test("false when no verdict was recorded", () => {
    expect(
      agentNotRecommendedForModel({
        agent: { accessAllTools: true, tools: [{}] },
        selectedModelId: "uuid-anthropic",
        models,
      }),
    ).toBe(false);
  });

  // "No tools" is the stronger, more actionable statement, and two chips side
  // by side in the composer is noise.
  test("defers to the no-tools notice when the flagged model takes no tools", () => {
    expect(
      agentNotRecommendedForModel({
        agent: { accessAllTools: true, tools: [{}] },
        selectedModelId: "uuid-tiny-no-tools",
        models,
      }),
    ).toBe(false);
    expect(
      agentToolsUnavailableForModel({
        agent: { accessAllTools: true, tools: [{}] },
        selectedModelId: "uuid-tiny-no-tools",
        models,
      }),
    ).toBe(true);
  });

  test("false without an agent or a selection", () => {
    expect(
      agentNotRecommendedForModel({
        agent: undefined,
        selectedModelId: "uuid-qwen-4b",
        models,
      }),
    ).toBe(false);
    expect(
      agentNotRecommendedForModel({
        agent: { accessAllTools: true, tools: [] },
        selectedModelId: null,
        models,
      }),
    ).toBe(false);
  });
});
