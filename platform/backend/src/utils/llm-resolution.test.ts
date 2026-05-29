import {
  FAST_MODELS,
  OPENROUTER_FREE_MODEL_ID,
  type SupportedProvider,
} from "@shared";
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
  resolveBestAvailableLlm,
  resolveConfiguredAgentLlm,
  resolveConversationLlmSelectionForAgent,
  resolveFastModelName,
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
  inputModalities: null,
  outputModalities: null,
  supportsToolCalling: null,
  promptPricePerToken: null,
  completionPricePerToken: null,
  customPricePerMillionInput: null,
  customPricePerMillionOutput: null,
  embeddingDimensions: null,
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

describe("resolveFastModelName", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("returns hardcoded FAST_MODELS fallback when no chatApiKeyId", async () => {
    const result = await resolveFastModelName("anthropic", undefined);

    expect(result).toBe(FAST_MODELS.anthropic);
  });

  test("returns fastest model from DB when chatApiKeyId is provided", async () => {
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getFastestModel",
    ).mockResolvedValue({
      ...MOCK_MODEL,
      modelId: "claude-haiku-3-5",
    });

    const result = await resolveFastModelName("anthropic", "key-123");

    expect(result).toBe("claude-haiku-3-5");
    expect(
      LlmProviderApiKeyModelLinkModel.getFastestModel,
    ).toHaveBeenCalledWith("key-123");
  });

  test("falls back to hardcoded model when DB has no fastest model", async () => {
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getFastestModel",
    ).mockResolvedValue(null);

    const result = await resolveFastModelName("openai", "key-456");

    expect(result).toBe(FAST_MODELS.openai);
  });

  test("falls back to hardcoded model when DB lookup throws", async () => {
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getFastestModel",
    ).mockRejectedValue(new Error("DB connection failed"));

    const result = await resolveFastModelName("openai", "key-789");

    expect(result).toBe(FAST_MODELS.openai);
  });

  test("always uses the free router for OpenRouter, bypassing the DB lookup", async () => {
    const getFastestModel = vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getFastestModel",
    );

    expect(await resolveFastModelName("openrouter", undefined)).toBe(
      OPENROUTER_FREE_MODEL_ID,
    );
    expect(await resolveFastModelName("openrouter", "key-123")).toBe(
      OPENROUTER_FREE_MODEL_ID,
    );
    // openrouter/auto (the marked "fastest" model) is paid — never resolved here.
    expect(getFastestModel).not.toHaveBeenCalled();
  });
});
