import type { SupportedProvider } from "@archestra/shared";
import { vi } from "vitest";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  MemberModel,
  ModelModel,
  OrganizationModel,
  TeamModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import * as llmApiKeyResolution from "@/utils/llm-api-key-resolution";
import {
  resolveAgentLlmOrDefault,
  resolveBestAvailableLlm,
  resolveConfiguredAgentLlm,
  resolveConversationLlmSelectionForAgent,
} from "./llm-resolution";

vi.mock("@/clients/gemini-client", () => ({
  isVertexAiEnabled: vi.fn(() => false),
}));

const NO_KEY = {
  apiKey: undefined,
  source: "environment",
  chatApiKeyId: undefined,
  baseUrl: null,
};

const MOCK_MODEL = {
  id: "model-1",
  externalId: "anthropic/claude-3-5-sonnet",
  modelId: "claude-3-5-sonnet-20241022",
  provider: "anthropic" as SupportedProvider,
  description: null,
  contextLength: null,
  outputLength: null,
  inputModalities: null,
  outputModalities: null,
  supportsToolCalling: null,
  promptPricePerToken: null,
  completionPricePerToken: null,
  cacheReadPricePerToken: null,
  cacheWritePricePerToken: null,
  customPricePerMillionInput: null,
  customPricePerMillionOutput: null,
  customPricePerMillionCacheRead: null,
  customPricePerMillionCacheWrite: null,
  embeddingDimensions: null,
  defaultParameters: null,
  ignored: false,
  discoveredViaLlmProxy: false,
  lastSyncedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

function mockModel(
  over: Partial<typeof MOCK_MODEL> & { id: string },
): typeof MOCK_MODEL {
  return { ...MOCK_MODEL, ...over };
}

describe("resolveBestAvailableLlm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default: no provider has a key
    vi.spyOn(llmApiKeyResolution, "resolveProviderApiKey").mockResolvedValue(
      NO_KEY,
    );
    // Default: no system keys exist
    vi.spyOn(LlmProviderApiKeyModel, "findSystemKey").mockResolvedValue(null);
  });

  test("returns null when no API keys configured", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const result = await resolveBestAvailableLlm({ organizationId: org.id });

    expect(result).toBeNull();
  });

  test("returns provider/model when a DB key with best model exists", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    vi.mocked(llmApiKeyResolution.resolveProviderApiKey).mockImplementation(
      async (params) => {
        if (params.provider === "anthropic") {
          return {
            apiKey: "sk-ant-key",
            source: "org",
            chatApiKeyId: "key-123",
            baseUrl: null,
          };
        }
        return NO_KEY;
      },
    );
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getBestModel",
    ).mockImplementation(async (apiKeyId) => {
      if (apiKeyId === "key-123") return MOCK_MODEL;
      return null;
    });

    const result = await resolveBestAvailableLlm({ organizationId: org.id });

    expect(result).toEqual({
      provider: "anthropic",
      apiKey: "sk-ant-key",
      modelName: "claude-3-5-sonnet-20241022",
      baseUrl: null,
    });
  });

  test("returns system key fallback when no user-scoped key available", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    vi.spyOn(LlmProviderApiKeyModel, "findSystemKey").mockImplementation(
      async (provider) => {
        if (provider === "gemini") {
          return {
            id: "system-key-gemini",
            provider: "gemini",
            isSystem: true,
            baseUrl: "https://us-central1-aiplatform.googleapis.com/v1beta1",
          } as never;
        }
        return null;
      },
    );

    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getBestModel",
    ).mockImplementation(async (apiKeyId) => {
      if (apiKeyId === "system-key-gemini") {
        return {
          ...MOCK_MODEL,
          id: "model-gemini",
          modelId: "gemini-2.5-pro",
          provider: "gemini",
        };
      }
      return null;
    });

    const result = await resolveBestAvailableLlm({ organizationId: org.id });

    expect(result).toEqual({
      provider: "gemini",
      apiKey: undefined,
      modelName: "gemini-2.5-pro",
      baseUrl: "https://us-central1-aiplatform.googleapis.com/v1beta1",
    });
  });

  test("iterates providers in order and returns first available", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // Both anthropic and openai have keys, but anthropic has no models
    vi.mocked(llmApiKeyResolution.resolveProviderApiKey).mockImplementation(
      async (params) => {
        if (params.provider === "anthropic") {
          return {
            apiKey: "sk-ant-key",
            source: "org",
            chatApiKeyId: "ant-key-id",
            baseUrl: null,
          };
        }
        if (params.provider === "openai") {
          return {
            apiKey: "sk-openai-key",
            source: "org",
            chatApiKeyId: "openai-key-id",
            baseUrl: null,
          };
        }
        return NO_KEY;
      },
    );

    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getBestModel",
    ).mockImplementation(async (apiKeyId) => {
      if (apiKeyId === "ant-key-id") return null; // no models for anthropic
      if (apiKeyId === "openai-key-id") {
        return {
          ...MOCK_MODEL,
          id: "model-2",
          modelId: "gpt-4o",
          provider: "openai",
        };
      }
      return null;
    });

    const result = await resolveBestAvailableLlm({ organizationId: org.id });

    // Should skip anthropic (no models) and return openai
    expect(result).toEqual({
      provider: "openai",
      apiKey: "sk-openai-key",
      modelName: "gpt-4o",
      baseUrl: null,
    });
  });

  test("works with userId undefined (org-wide keys only)", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    vi.mocked(llmApiKeyResolution.resolveProviderApiKey).mockImplementation(
      async (params) => {
        if (params.provider === "anthropic") {
          return {
            apiKey: "sk-ant-key",
            source: "org",
            chatApiKeyId: "key-123",
            baseUrl: null,
          };
        }
        return NO_KEY;
      },
    );
    vi.spyOn(LlmProviderApiKeyModelLinkModel, "getBestModel").mockResolvedValue(
      MOCK_MODEL,
    );

    const result = await resolveBestAvailableLlm({ organizationId: org.id });

    expect(result).not.toBeNull();
    // Verify resolveProviderApiKey was called without userId
    expect(llmApiKeyResolution.resolveProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: org.id,
        userId: undefined,
      }),
    );
  });

  test("passes userId when provided", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await resolveBestAvailableLlm({
      organizationId: org.id,
      userId: "user-123",
    });

    expect(llmApiKeyResolution.resolveProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: org.id,
        userId: "user-123",
      }),
    );
  });

  test("returns null when provider has env-var key but no chatApiKeyId", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // API key from env var (no chatApiKeyId)
    vi.mocked(llmApiKeyResolution.resolveProviderApiKey).mockResolvedValue({
      apiKey: "sk-env-key",
      source: "environment",
      chatApiKeyId: undefined,
      baseUrl: null,
    });

    const result = await resolveBestAvailableLlm({ organizationId: org.id });

    expect(result).toBeNull();
  });

  test("returns null when system key exists but has no models synced", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    vi.spyOn(LlmProviderApiKeyModel, "findSystemKey").mockImplementation(
      async (provider) => {
        if (provider === "gemini") {
          return {
            id: "system-key-gemini",
            provider: "gemini",
            isSystem: true,
            baseUrl: null,
          } as never;
        }
        return null;
      },
    );

    vi.spyOn(LlmProviderApiKeyModelLinkModel, "getBestModel").mockResolvedValue(
      null,
    );

    const result = await resolveBestAvailableLlm({ organizationId: org.id });

    expect(result).toBeNull();
  });
});

describe("resolveConversationLlmSelectionForAgent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(isVertexAiEnabled).mockReturnValue(false);
    // Default: nothing configured anywhere, no models available.
    vi.spyOn(MemberModel, "getByUserId").mockResolvedValue(undefined as never);
    vi.spyOn(OrganizationModel, "getById").mockResolvedValue(null);
    vi.spyOn(TeamModel, "getUserTeamIds").mockResolvedValue([]);
    vi.spyOn(
      LlmProviderApiKeyModel,
      "getAvailableKeysForUser",
    ).mockResolvedValue([]);
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getRankedModelsForApiKeys",
    ).mockResolvedValue([]);
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getLinkedModelSelectionKeys",
    ).mockImplementation(
      async (selections) =>
        new Set(
          selections.map(
            (selection) => `${selection.apiKeyId}:${selection.modelId}`,
          ),
        ),
    );
    vi.spyOn(ModelModel, "findById").mockResolvedValue(null);
  });

  test("resolves the agent's configured model", async () => {
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({
        id: "m-agent",
        modelId: "claude-3-5-sonnet",
        provider: "anthropic",
      }),
    );

    const result = await resolveConversationLlmSelectionForAgent({
      agent: { llmApiKeyId: "key-anthropic", modelId: "m-agent" },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      modelId: "m-agent",
      chatApiKeyId: "key-anthropic",
      selectedModel: "claude-3-5-sonnet",
      selectedProvider: "anthropic",
    });
  });

  test("an explicit (model, key) pick overrides the agent model", async () => {
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) => {
      if (id === "m-explicit") {
        return mockModel({
          id: "m-explicit",
          modelId: "gpt-4o",
          provider: "openai",
        });
      }
      return null;
    });

    const result = await resolveConversationLlmSelectionForAgent({
      agent: { llmApiKeyId: "key-anthropic", modelId: "m-agent" },
      organizationId: "org-1",
      userId: "user-1",
      explicitModelId: "m-explicit",
      explicitApiKeyId: "key-openai",
    });

    expect(result.modelId).toBe("m-explicit");
    expect(result.chatApiKeyId).toBe("key-openai");
    expect(result.selectedModel).toBe("gpt-4o");
  });

  test("honors an explicit per-user provider model by model alone, ignoring a carried-over foreign key", async () => {
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) => {
      if (id === "m-copilot") {
        return mockModel({
          id: "m-copilot",
          modelId: "gpt-4",
          provider: "github-copilot",
        });
      }
      return null;
    });

    const result = await resolveConversationLlmSelectionForAgent({
      agent: { llmApiKeyId: "key-anthropic", modelId: "m-agent" },
      organizationId: "org-1",
      userId: "user-1",
      // The picker carried over a non-Copilot key (the member hasn't connected
      // Copilot, so that pair isn't linked). A per-user model is still honored
      // by model alone — its credential is resolved per-user at request time.
      explicitModelId: "m-copilot",
      explicitApiKeyId: "key-azure",
    });

    expect(result.modelId).toBe("m-copilot");
    expect(result.chatApiKeyId).toBeNull();
    expect(result.selectedModel).toBe("gpt-4");
    expect(result.selectedProvider).toBe("github-copilot");
  });

  test("does not pin a key when the org default points at a per-user model", async () => {
    // The org default pins a Copilot model + the admin's key; another member
    // inherits the model but must not inherit the admin's (inaccessible) key.
    vi.spyOn(OrganizationModel, "getById").mockResolvedValue({
      defaultModelId: "m-copilot",
      defaultLlmApiKeyId: "key-admin-copilot",
    } as never);
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) => {
      if (id === "m-copilot") {
        return mockModel({
          id: "m-copilot",
          modelId: "gpt-4o",
          provider: "github-copilot",
        });
      }
      return null;
    });

    const result = await resolveConversationLlmSelectionForAgent({
      agent: { llmApiKeyId: null, modelId: null },
      organizationId: "org-1",
      userId: "member-2",
    });

    expect(result.modelId).toBe("m-copilot");
    expect(result.chatApiKeyId).toBeNull();
    expect(result.selectedProvider).toBe("github-copilot");
  });

  test("an explicit model with no key falls through to the agent", async () => {
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) => {
      if (id === "m-agent") {
        return mockModel({
          id: "m-agent",
          modelId: "claude-3-5-sonnet",
          provider: "anthropic",
        });
      }
      return null;
    });

    const result = await resolveConversationLlmSelectionForAgent({
      agent: { llmApiKeyId: "key-anthropic", modelId: "m-agent" },
      organizationId: "org-1",
      userId: "user-1",
      explicitModelId: "m-explicit",
    });

    expect(result.modelId).toBe("m-agent");
    expect(result.chatApiKeyId).toBe("key-anthropic");
  });

  test("falls back to the organization default when the agent has no model", async () => {
    vi.spyOn(OrganizationModel, "getById").mockResolvedValue({
      id: "org-1",
      defaultModelId: "m-org",
      defaultLlmApiKeyId: "org-key",
    } as never);
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) => {
      if (id === "m-org") {
        return mockModel({
          id: "m-org",
          modelId: "gpt-4o",
          provider: "openai",
        });
      }
      return null;
    });

    const result = await resolveConversationLlmSelectionForAgent({
      agent: { llmApiKeyId: null, modelId: null },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      modelId: "m-org",
      chatApiKeyId: "org-key",
      selectedModel: "gpt-4o",
      selectedProvider: "openai",
    });
  });

  test("an agent with a model but no key (dynamic key) falls through to the org default", async () => {
    vi.spyOn(OrganizationModel, "getById").mockResolvedValue({
      id: "org-1",
      defaultModelId: "m-org",
      defaultLlmApiKeyId: "org-key",
    } as never);
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) => {
      if (id === "m-org") {
        return mockModel({
          id: "m-org",
          modelId: "gpt-4o",
          provider: "openai",
        });
      }
      return null;
    });

    const result = await resolveConversationLlmSelectionForAgent({
      agent: { llmApiKeyId: null, modelId: "m-agent" },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      modelId: "m-org",
      chatApiKeyId: "org-key",
      selectedModel: "gpt-4o",
      selectedProvider: "openai",
    });
  });

  test("skips a configured model that is no longer linked to its API key", async () => {
    vi.spyOn(OrganizationModel, "getById").mockResolvedValue({
      id: "org-1",
      defaultModelId: "m-org",
      defaultLlmApiKeyId: "org-key",
    } as never);
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getLinkedModelSelectionKeys",
    ).mockResolvedValue(new Set(["org-key:m-org"]));
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) => {
      if (id === "m-org") {
        return mockModel({
          id: "m-org",
          modelId: "gpt-4o",
          provider: "openai",
        });
      }
      return null;
    });

    const result = await resolveConversationLlmSelectionForAgent({
      agent: { llmApiKeyId: "stale-key", modelId: "stale-model" },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      modelId: "m-org",
      chatApiKeyId: "org-key",
      selectedModel: "gpt-4o",
      selectedProvider: "openai",
    });
  });

  test("falls back to the best available model when nothing is configured", async () => {
    vi.spyOn(
      LlmProviderApiKeyModel,
      "getAvailableKeysForUser",
    ).mockResolvedValue([{ id: "key-1" }, { id: "key-2" }] as never);
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getRankedModelsForApiKeys",
    ).mockResolvedValue([
      { modelId: "m-best", apiKeyId: "key-2", isBest: true },
      { modelId: "m-cheap", apiKeyId: "key-1", isBest: false },
    ]);
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) => {
      if (id === "m-best") {
        return mockModel({
          id: "m-best",
          modelId: "claude-opus",
          provider: "anthropic",
        });
      }
      return null;
    });

    const result = await resolveConversationLlmSelectionForAgent({
      agent: { llmApiKeyId: null, modelId: null },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      modelId: "m-best",
      chatApiKeyId: "key-2",
      selectedModel: "claude-opus",
      selectedProvider: "anthropic",
    });
  });

  test("falls back to env/config defaults when no models exist", async () => {
    const result = await resolveConversationLlmSelectionForAgent({
      agent: { llmApiKeyId: null, modelId: null },
      organizationId: "org-1",
      userId: "user-1",
    });

    // No model anywhere — modelId is null and the chain uses config defaults.
    expect(result.modelId).toBeNull();
  });

  test("falls back to Vertex AI when enabled and no models exist", async () => {
    vi.mocked(isVertexAiEnabled).mockReturnValue(true);

    const result = await resolveConversationLlmSelectionForAgent({
      agent: { llmApiKeyId: null, modelId: null },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result.modelId).toBeNull();
    expect(result.selectedProvider).toBe("gemini");
  });
});

describe("resolveConfiguredAgentLlm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("dereferences the agent's modelId via its API key", async () => {
    vi.spyOn(LlmProviderApiKeyModel, "findById").mockResolvedValue({
      id: "key-anthropic",
      provider: "anthropic",
      secretId: null,
      baseUrl: null,
      inferenceBaseUrl: null,
    } as never);
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({
        id: "m-1",
        modelId: "claude-3-5-sonnet",
        provider: "anthropic",
      }),
    );

    const result = await resolveConfiguredAgentLlm({
      llmApiKeyId: "key-anthropic",
      modelId: "m-1",
    });

    expect(result).toEqual({
      provider: "anthropic",
      apiKey: undefined,
      modelName: "claude-3-5-sonnet",
      baseUrl: null,
    });
  });

  test("returns null when the agent has neither a key nor a model", async () => {
    const result = await resolveConfiguredAgentLlm({
      llmApiKeyId: null,
      modelId: null,
    });

    expect(result).toBeNull();
  });
});

describe("resolveAgentLlmOrDefault", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(llmApiKeyResolution, "resolveProviderApiKey").mockResolvedValue(
      NO_KEY,
    );
  });

  test("uses an explicitly configured agent model and key", async () => {
    vi.spyOn(LlmProviderApiKeyModel, "findById").mockResolvedValue({
      id: "key-123",
      provider: "anthropic",
      secretId: null,
      baseUrl: null,
      inferenceBaseUrl: null,
    } as never);
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({
        id: "model-123",
        provider: "anthropic",
        modelId: "claude-configured",
      }),
    );

    const result = await resolveAgentLlmOrDefault({
      agent: { llmApiKeyId: "key-123", modelId: "model-123" },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      provider: "anthropic",
      apiKey: undefined,
      modelName: "claude-configured",
      baseUrl: null,
    });
  });

  test("falls back to organization default model and key", async () => {
    vi.spyOn(OrganizationModel, "getById").mockResolvedValue({
      id: "org-1",
      defaultModelId: "model-org",
      defaultLlmApiKeyId: "key-org",
    } as never);
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({
        id: "model-org",
        provider: "bedrock",
        modelId: "anthropic.claude-sonnet-4-5",
      }),
    );
    vi.spyOn(llmApiKeyResolution, "resolveProviderApiKey").mockResolvedValue({
      apiKey: "org-key",
      source: "organization",
      chatApiKeyId: "key-org",
      baseUrl: "https://bedrock.example.test",
    });

    const result = await resolveAgentLlmOrDefault({
      agent: null,
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      provider: "bedrock",
      apiKey: "org-key",
      modelName: "anthropic.claude-sonnet-4-5",
      baseUrl: "https://bedrock.example.test",
    });
  });

  test("falls back to best available model when no organization default is set", async () => {
    vi.spyOn(OrganizationModel, "getById").mockResolvedValue({
      id: "org-1",
      defaultModelId: null,
      defaultLlmApiKeyId: null,
    } as never);
    vi.spyOn(TeamModel, "getUserTeamIds").mockResolvedValue([]);
    vi.spyOn(
      LlmProviderApiKeyModel,
      "getAvailableKeysForUser",
    ).mockResolvedValue([{ id: "key-available" }] as never);
    vi.spyOn(LlmProviderApiKeyModelLinkModel, "getBestModel").mockResolvedValue(
      mockModel({
        id: "model-best",
        provider: "openai",
        modelId: "gpt-best",
      }),
    );
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({
        id: "model-best",
        provider: "openai",
        modelId: "gpt-best",
      }),
    );
    vi.spyOn(llmApiKeyResolution, "resolveProviderApiKey").mockImplementation(
      async ({ provider }) =>
        provider === "openai"
          ? {
              apiKey: "openai-key",
              source: "personal",
              chatApiKeyId: "key-available",
              baseUrl: null,
            }
          : NO_KEY,
    );

    const result = await resolveAgentLlmOrDefault({
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      provider: "openai",
      apiKey: "openai-key",
      modelName: "gpt-best",
      baseUrl: null,
    });
  });
});
