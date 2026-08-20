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
import * as secretsManager from "@/secrets-manager";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
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
  supportsReasoningEffort: null,
  supportedEndpoints: null,
  promptPricePerToken: null,
  completionPricePerToken: null,
  cacheReadPricePerToken: null,
  cacheWritePricePerToken: null,
  customPricePerMillionInput: null,
  customPricePerMillionOutput: null,
  customPricePerMillionCacheRead: null,
  customPricePerMillionCacheWrite: null,
  customContextLength: null,
  customOutputLength: null,
  embeddingDimensions: null,
  defaultParameters: null,
  configuredParameters: null,
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
      chatApiKeyId: "key-123",
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
      chatApiKeyId: "system-key-gemini",
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
      chatApiKeyId: "openai-key-id",
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

  test("uses the member's /chat default over the agent's model by default", async () => {
    vi.spyOn(MemberModel, "getByUserId").mockResolvedValue({
      defaultModelId: "m-member",
      defaultChatApiKeyId: "key-member",
    } as never);
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) => {
      if (id === "m-member") {
        return mockModel({
          id: "m-member",
          modelId: "gpt-4o",
          provider: "openai",
        });
      }
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
    });

    expect(result.modelId).toBe("m-member");
    expect(result.chatApiKeyId).toBe("key-member");
    expect(result.selectedModel).toBe("gpt-4o");
  });

  test("includeMemberChatDefault:false skips the member /chat default and falls to the agent's model", async () => {
    vi.spyOn(MemberModel, "getByUserId").mockResolvedValue({
      defaultModelId: "m-member",
      defaultChatApiKeyId: "key-member",
    } as never);
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) => {
      if (id === "m-member") {
        return mockModel({
          id: "m-member",
          modelId: "gpt-4o",
          provider: "openai",
        });
      }
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
      includeMemberChatDefault: false,
    });

    expect(result.modelId).toBe("m-agent");
    expect(result.chatApiKeyId).toBe("key-anthropic");
    expect(result.selectedModel).toBe("claude-3-5-sonnet");
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

  test("returns the attached key's secret for a plain provider key", async () => {
    vi.spyOn(LlmProviderApiKeyModel, "findById").mockResolvedValue({
      id: "key-openai",
      provider: "openai",
      secretId: "secret-openai",
      baseUrl: null,
      inferenceBaseUrl: null,
    } as never);
    vi.spyOn(
      secretsManager,
      "getSecretValueForLlmProviderApiKey",
    ).mockResolvedValue("sk-plain");
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({ id: "m-2", modelId: "gpt-4.1", provider: "openai" }),
    );

    const result = await resolveConfiguredAgentLlm({
      llmApiKeyId: "key-openai",
      modelId: "m-2",
    });

    expect(result?.apiKey).toBe("sk-plain");
  });

  test("withholds a ChatGPT-subscription credential from this ownership-blind path", async () => {
    vi.spyOn(LlmProviderApiKeyModel, "findById").mockResolvedValue({
      id: "key-codex",
      provider: "openai",
      secretId: "secret-codex",
      baseUrl: null,
      inferenceBaseUrl: null,
    } as never);
    vi.spyOn(
      secretsManager,
      "getSecretValueForLlmProviderApiKey",
    ).mockResolvedValue(
      encodeOpenAiCodexCredential({
        refreshToken: "refresh-token",
        accountId: "account-id",
      }),
    );
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({ id: "m-codex", modelId: "gpt-5-codex", provider: "openai" }),
    );

    const result = await resolveConfiguredAgentLlm({
      llmApiKeyId: "key-codex",
      modelId: "m-codex",
    });

    // The credential is per-user; the fall-through resolution enforces
    // ownership for the acting user instead of this helper handing it out.
    expect(result).toEqual({
      provider: "openai",
      apiKey: undefined,
      modelName: "gpt-5-codex",
      baseUrl: null,
    });
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

  test("moves an agent to the vLLM endpoint that serves its model", async () => {
    // The agent is pinned to one vLLM server while its model is served by a
    // sibling. Only the host can answer for the model, so the agent's own
    // credential and base URL must give way to the serving endpoint's.
    vi.spyOn(LlmProviderApiKeyModel, "findById").mockResolvedValue({
      id: "key-vllm-a",
      provider: "vllm",
      secretId: "secret-vllm-a",
      baseUrl: "http://vllm-a:8000/v1",
      inferenceBaseUrl: null,
    } as never);
    vi.spyOn(
      secretsManager,
      "getSecretValueForLlmProviderApiKey",
    ).mockResolvedValue("token-a");
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({
        id: "model-qwen",
        provider: "vllm",
        modelId: "Qwen/Qwen2.5-7B-Instruct",
      }),
    );
    vi.spyOn(llmApiKeyResolution, "resolveProviderApiKey").mockResolvedValue({
      apiKey: "token-b",
      source: "org",
      chatApiKeyId: "key-vllm-b",
      baseUrl: "http://vllm-b:8000/v1",
    });

    const result = await resolveAgentLlmOrDefault({
      agent: { llmApiKeyId: "key-vllm-a", modelId: "model-qwen" },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      provider: "vllm",
      apiKey: "token-b",
      modelName: "Qwen/Qwen2.5-7B-Instruct",
      baseUrl: "http://vllm-b:8000/v1",
      chatApiKeyId: "key-vllm-b",
    });
  });

  test("keeps an agent on its own vLLM endpoint when that endpoint serves the model", async () => {
    vi.spyOn(LlmProviderApiKeyModel, "findById").mockResolvedValue({
      id: "key-vllm-a",
      provider: "vllm",
      secretId: "secret-vllm-a",
      baseUrl: "http://vllm-a:8000/v1",
      inferenceBaseUrl: null,
    } as never);
    vi.spyOn(
      secretsManager,
      "getSecretValueForLlmProviderApiKey",
    ).mockResolvedValue("token-a");
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({
        id: "model-llama",
        provider: "vllm",
        modelId: "meta-llama/Llama-3.1-8B-Instruct",
      }),
    );
    vi.spyOn(llmApiKeyResolution, "resolveProviderApiKey").mockResolvedValue({
      apiKey: "token-a",
      source: "org",
      chatApiKeyId: "key-vllm-a",
      baseUrl: "http://vllm-a:8000/v1",
    });

    const result = await resolveAgentLlmOrDefault({
      agent: { llmApiKeyId: "key-vllm-a", modelId: "model-llama" },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      provider: "vllm",
      apiKey: "token-a",
      modelName: "meta-llama/Llama-3.1-8B-Instruct",
      baseUrl: "http://vllm-a:8000/v1",
      chatApiKeyId: "key-vllm-a",
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
      chatApiKeyId: "key-org",
    });
  });

  test("falls back to the inherited selection, not the organization default, when the subagent pins no model", async () => {
    // The reported shape: an agent on a self-hosted vLLM model while the
    // organization default still points at Ollama. The subagent has no model of
    // its own, so it must follow the agent's rather than the org's.
    vi.spyOn(OrganizationModel, "getById").mockResolvedValue({
      id: "org-1",
      defaultModelId: "model-org-ollama",
      defaultLlmApiKeyId: "key-org-ollama",
    } as never);
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) =>
      id === "model-vllm"
        ? mockModel({
            id: "model-vllm",
            provider: "vllm",
            modelId: "qwen3-32b",
          })
        : mockModel({
            id: "model-org-ollama",
            provider: "ollama",
            modelId: "llama3.1",
          }),
    );
    vi.spyOn(llmApiKeyResolution, "resolveProviderApiKey").mockImplementation(
      async ({ provider }) =>
        provider === "vllm"
          ? {
              apiKey: "vllm-key",
              source: "organization",
              chatApiKeyId: "key-vllm",
              baseUrl: "https://vllm.example.test",
            }
          : NO_KEY,
    );

    const result = await resolveAgentLlmOrDefault({
      // A seeded built-in subagent: no model, no key.
      agent: { llmApiKeyId: null, modelId: null },
      inheritFrom: { modelId: "model-vllm", agentLlmApiKeyId: null },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toMatchObject({
      provider: "vllm",
      modelName: "qwen3-32b",
      baseUrl: "https://vllm.example.test",
    });
  });

  test("resolves the inherited model's key for the acting user rather than reusing a stored one", async () => {
    // The inherited level pins a model, never a key. A conversation's key is
    // one the USER picked, and getCurrentApiKey re-checks their access to it on
    // every use — so resolution has to go back through resolveProviderApiKey
    // (with the conversation and the serving agent's key as the hint) instead
    // of decrypting a stored secret by id, which would skip that check and let
    // a background title keep billing a team key after the user lost the team.
    const findById = vi
      .spyOn(LlmProviderApiKeyModel, "findById")
      .mockResolvedValue({
        id: "key-conversation",
        provider: "vllm",
        secretId: "secret-conversation",
        baseUrl: null,
        inferenceBaseUrl: null,
      } as never);
    const getSecret = vi
      .spyOn(secretsManager, "getSecretValueForLlmProviderApiKey")
      .mockResolvedValue("leaked-secret" as never);
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({ id: "model-vllm", provider: "vllm", modelId: "qwen3-32b" }),
    );
    vi.spyOn(llmApiKeyResolution, "resolveProviderApiKey").mockResolvedValue({
      apiKey: "access-checked-key",
      source: "organization",
      chatApiKeyId: "key-conversation",
      baseUrl: null,
    });

    const result = await resolveAgentLlmOrDefault({
      agent: { llmApiKeyId: null, modelId: null },
      inheritFrom: { modelId: "model-vllm", agentLlmApiKeyId: "key-agent" },
      organizationId: "org-1",
      userId: "user-1",
      conversationId: "conv-1",
    });

    expect(result.apiKey).toBe("access-checked-key");
    expect(getSecret).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalledWith("key-conversation");
    // The serving agent's key travels as the hint, so getCurrentApiKey can
    // still apply its documented "conversation key IS the agent key" exemption.
    expect(llmApiKeyResolution.resolveProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        userId: "user-1",
        agentLlmApiKeyId: "key-agent",
      }),
    );
  });

  test("the subagent's own configured model wins over the inherited selection", async () => {
    vi.spyOn(LlmProviderApiKeyModel, "findById").mockResolvedValue({
      id: "key-pinned",
      provider: "anthropic",
      secretId: null,
      baseUrl: null,
      inferenceBaseUrl: null,
    } as never);
    vi.spyOn(ModelModel, "findById").mockImplementation(async (id) =>
      mockModel({
        id,
        provider: "anthropic",
        modelId: id === "model-pinned" ? "claude-pinned" : "claude-inherited",
      }),
    );

    const result = await resolveAgentLlmOrDefault({
      agent: { llmApiKeyId: "key-pinned", modelId: "model-pinned" },
      inheritFrom: { modelId: "model-inherited" },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result.modelName).toBe("claude-pinned");
  });

  test("an inherited selection with no model falls through to the organization default", async () => {
    // A conversation created before any model was synced carries a null
    // model_id; the org default must still outrank the env fallback.
    vi.spyOn(OrganizationModel, "getById").mockResolvedValue({
      id: "org-1",
      defaultModelId: "model-org",
      defaultLlmApiKeyId: "key-org",
    } as never);
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({
        id: "model-org",
        provider: "ollama",
        modelId: "llama3.1",
      }),
    );
    vi.spyOn(llmApiKeyResolution, "resolveProviderApiKey").mockResolvedValue({
      apiKey: "org-key",
      source: "organization",
      chatApiKeyId: "key-org",
      baseUrl: null,
    });

    const result = await resolveAgentLlmOrDefault({
      agent: { llmApiKeyId: null, modelId: null },
      inheritFrom: { modelId: null },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toMatchObject({
      provider: "ollama",
      modelName: "llama3.1",
    });
  });

  test("fills the provider key for an inherited model that pins none", async () => {
    vi.spyOn(ModelModel, "findById").mockResolvedValue(
      mockModel({ id: "model-vllm", provider: "vllm", modelId: "qwen3-32b" }),
    );
    vi.spyOn(llmApiKeyResolution, "resolveProviderApiKey").mockImplementation(
      async ({ provider }) =>
        provider === "vllm"
          ? {
              apiKey: "vllm-key",
              source: "organization",
              chatApiKeyId: "key-vllm",
              baseUrl: "https://vllm.example.test",
            }
          : NO_KEY,
    );

    const result = await resolveAgentLlmOrDefault({
      agent: null,
      inheritFrom: { modelId: "model-vllm" },
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(result).toEqual({
      provider: "vllm",
      apiKey: "vllm-key",
      modelName: "qwen3-32b",
      baseUrl: "https://vllm.example.test",
      chatApiKeyId: "key-vllm",
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
      chatApiKeyId: "key-available",
    });
  });
});
