import { TimeInMs } from "@archestra/shared";
import { vi } from "vitest";
import { userHasPermission } from "@/auth";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { modelSyncService } from "@/services/model-sync";
import { systemKeyManager } from "@/services/system-key-manager";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import {
  getStaleModelSyncApiKeys,
  isModelSyncStateStale,
  syncModelsForVisibleApiKeys,
  triggerLazyModelSyncForStaleApiKeys,
} from "./llm-provider-models";

vi.mock("@/auth");

vi.mock("@/clients/gemini-client", () => ({
  isVertexAiEnabled: vi.fn(() => false),
}));

vi.mock("@/clients/bedrock-credentials", () => ({
  isBedrockIamAuthEnabled: vi.fn(() => false),
}));

vi.mock("@/services/system-key-manager", () => ({
  systemKeyManager: {
    syncSystemKeys: vi.fn(),
  },
}));

vi.mock("@/clients/models-dev-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/clients/models-dev-client")>();
  return {
    ...actual,
    modelsDevClient: {
      ...actual.modelsDevClient,
      syncIfNeeded: vi.fn(),
    },
  };
});

vi.mock("@/secrets-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/secrets-manager")>();
  return {
    ...actual,
    getSecretValueForLlmProviderApiKey: vi.fn(),
  };
});

const mockGetSecretValueForLlmProviderApiKey = vi.mocked(
  getSecretValueForLlmProviderApiKey,
);
const mockIsVertexAiEnabled = vi.mocked(isVertexAiEnabled);
const mockUserHasPermission = vi.mocked(userHasPermission);
const mockSyncSystemKeys = vi.mocked(systemKeyManager.syncSystemKeys);

describe("chat model routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockIsVertexAiEnabled.mockReturnValue(false);
    mockUserHasPermission.mockResolvedValue(true);

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    registerAuditLogHook(app);

    const { default: llmModelsRoutes } = await import("./llm-provider-models");
    await app.register(llmModelsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("GET /api/chat/models only returns models suitable for chat", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "gemini",
      scope: "personal",
      userId: user.id,
    });

    const chatModel = await ModelModel.create({
      externalId: "gemini/gemini-2.5-flash",
      provider: "gemini",
      modelId: "gemini-2.5-flash",
      description: "Gemini 2.5 Flash",
      contextLength: 1_000_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      promptPricePerToken: "0.000001",
      completionPricePerToken: "0.000002",
      ignored: false,
      lastSyncedAt: new Date(),
    });
    const embeddingModel = await ModelModel.create({
      externalId: "gemini/gemini-embedding-001",
      provider: "gemini",
      modelId: "gemini-embedding-001",
      description: "Gemini Embedding 001",
      contextLength: null,
      inputModalities: ["text"],
      outputModalities: [],
      supportsToolCalling: false,
      promptPricePerToken: null,
      completionPricePerToken: null,
      ignored: false,
      lastSyncedAt: new Date(),
    });
    const ignoredModel = await ModelModel.create({
      externalId: "gemini/gemini-2.5-pro",
      provider: "gemini",
      modelId: "gemini-2.5-pro",
      description: "Gemini 2.5 Pro",
      contextLength: 1_000_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      promptPricePerToken: "0.00001",
      completionPricePerToken: "0.00003",
      ignored: true,
      lastSyncedAt: new Date(),
    });

    await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
      apiKey.id,
      [
        { id: chatModel.id, modelId: chatModel.modelId },
        { id: embeddingModel.id, modelId: embeddingModel.modelId },
        { id: ignoredModel.id, modelId: ignoredModel.modelId },
      ],
      "gemini",
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/llm-models/available",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        provider: "gemini",
      }),
    ]);
  });

  test("GET /api/llm-models/available?isEmbedding=true only returns embedding models with configured dimensions", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "gemini",
      scope: "personal",
      userId: user.id,
    });

    const configuredEmbeddingModel = await ModelModel.create({
      externalId: "gemini/gemini-embedding-001",
      provider: "gemini",
      modelId: "gemini-embedding-001",
      description: "Gemini Embedding 001",
      contextLength: null,
      inputModalities: ["text"],
      outputModalities: [],
      supportsToolCalling: false,
      promptPricePerToken: null,
      completionPricePerToken: null,
      ignored: false,
      embeddingDimensions: 3072,
      lastSyncedAt: new Date(),
    });
    const incompleteEmbeddingModel = await ModelModel.create({
      externalId: "gemini/custom-embed-v2",
      provider: "gemini",
      modelId: "custom-embed-v2",
      description: "Custom Embed V2",
      contextLength: null,
      inputModalities: ["text"],
      outputModalities: [],
      supportsToolCalling: false,
      promptPricePerToken: null,
      completionPricePerToken: null,
      ignored: false,
      embeddingDimensions: null,
      lastSyncedAt: new Date(),
    });

    await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
      apiKey.id,
      [
        {
          id: configuredEmbeddingModel.id,
          modelId: configuredEmbeddingModel.modelId,
        },
        {
          id: incompleteEmbeddingModel.id,
          modelId: incompleteEmbeddingModel.modelId,
        },
      ],
      "gemini",
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-models/available?apiKeyId=${apiKey.id}&isEmbedding=true`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: "gemini-embedding-001",
        embeddingDimensions: 3072,
      }),
    ]);
  });

  test("GET /api/llm-models/available marks responses when lazy sync is pending", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "openrouter-key" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openrouter",
      scope: "personal",
      userId: user.id,
    });
    mockGetSecretValueForLlmProviderApiKey.mockResolvedValue("openrouter-key");
    const syncSpy = vi
      .spyOn(modelSyncService, "syncModelsForApiKey")
      .mockResolvedValue(0);

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-models/available?apiKeyId=${apiKey.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-archestra-lazy-model-sync"]).toBe("pending");
    expect(response.json()).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(syncSpy).toHaveBeenCalledWith({
      apiKeyId: apiKey.id,
      provider: "openrouter",
      apiKeyValue: "openrouter-key",
      baseUrl: null,
      extraHeaders: null,
    });
  });

  test("GET /api/llm-models only attaches keys visible to the caller", async ({
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeMember,
    makeOrganization,
  }) => {
    // Per-user providers give every member an identically-named personal key
    // linked to the same global model row — without visibility filtering the
    // Models page showed them all as indistinguishable duplicates.
    const model = await ModelModel.create({
      externalId: "microsoft-365-copilot/microsoft-365-copilot",
      provider: "microsoft-365-copilot",
      modelId: "microsoft-365-copilot",
      description: "Microsoft 365 Copilot",
      contextLength: null,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: false,
      promptPricePerToken: null,
      completionPricePerToken: null,
      ignored: false,
      lastSyncedAt: new Date(),
    });

    const ownSecret = await makeSecret({ secret: { apiKey: "own-token" } });
    const ownKey = await makeLlmProviderApiKey(organizationId, ownSecret.id, {
      provider: "microsoft-365-copilot",
      scope: "personal",
      userId: user.id,
      name: "Microsoft 365 Copilot",
    });

    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId);
    const otherSecret = await makeSecret({ secret: { apiKey: "other-token" } });
    const otherUsersKey = await makeLlmProviderApiKey(
      organizationId,
      otherSecret.id,
      {
        provider: "microsoft-365-copilot",
        scope: "personal",
        userId: otherUser.id,
        name: "Microsoft 365 Copilot",
      },
    );

    const foreignOrg = await makeOrganization();
    const foreignSecret = await makeSecret({
      secret: { apiKey: "foreign-token" },
    });
    const foreignOrgKey = await makeLlmProviderApiKey(
      foreignOrg.id,
      foreignSecret.id,
      {
        provider: "microsoft-365-copilot",
        scope: "org",
        name: "Microsoft 365 Copilot",
      },
    );

    for (const key of [ownKey, otherUsersKey, foreignOrgKey]) {
      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        key.id,
        [{ id: model.id, modelId: model.modelId }],
        "microsoft-365-copilot",
      );
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/llm-models",
    });

    expect(response.statusCode).toBe(200);
    const copilotModel = response
      .json()
      .find((m: { id: string }) => m.id === model.id);
    // Only the caller's own personal key — the other member's personal key
    // and the other organization's key must not leak into the response.
    expect(copilotModel.apiKeys.map((k: { id: string }) => k.id)).toEqual([
      ownKey.id,
    ]);
  });

  describe("GET /api/llm-models — effectiveContextLength", () => {
    /**
     * The models table shows the window Ollama will actually enforce, while
     * `contextLength` stays the architectural ceiling `num_ctx` is validated
     * against. Both have to travel on the response or the table and the chat
     * context ring disagree.
     */
    async function fetchListedModel(params: {
      apiKeyId: string;
      defaultParameters?: Record<string, string | number | string[]> | null;
      configuredParameters?: Record<string, number> | null;
    }) {
      const model = await ModelModel.create({
        externalId: "ollama/qwen3",
        provider: "ollama-native",
        modelId: "qwen3",
        contextLength: 262144,
        defaultParameters: params.defaultParameters ?? null,
        configuredParameters: params.configuredParameters ?? null,
        inputModalities: ["text"],
        outputModalities: ["text"],
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        params.apiKeyId,
        [{ id: model.id, modelId: model.modelId }],
        "ollama-native",
      );

      const response = await app.inject({
        method: "GET",
        url: "/api/llm-models",
      });
      expect(response.statusCode).toBe(200);
      return response.json().find((m: { id: string }) => m.id === model.id) as {
        contextLength: number | null;
        effectiveContextLength: number | null;
      };
    }

    test("equals the architectural window when nothing caps it", async ({
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const secret = await makeSecret({ secret: { apiKey: "ollama" } });
      const key = await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "ollama-native",
        scope: "org",
        name: "Ollama",
      });
      const listed = await fetchListedModel({ apiKeyId: key.id });

      expect(listed.contextLength).toBe(262144);
      expect(listed.effectiveContextLength).toBe(262144);
    });

    test("reports a Modelfile num_ctx that caps the architectural window", async ({
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const secret = await makeSecret({ secret: { apiKey: "ollama" } });
      const key = await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "ollama-native",
        scope: "org",
        name: "Ollama",
      });
      const listed = await fetchListedModel({
        apiKeyId: key.id,
        defaultParameters: { num_ctx: "8192" },
      });

      // The architectural value must survive — it is the `num_ctx` ceiling, so
      // overwriting it would forbid raising the window past the Modelfile.
      expect(listed.contextLength).toBe(262144);
      expect(listed.effectiveContextLength).toBe(8192);
    });

    test("prefers a configured num_ctx over the Modelfile default", async ({
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const secret = await makeSecret({ secret: { apiKey: "ollama" } });
      const key = await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "ollama-native",
        scope: "org",
        name: "Ollama",
      });
      const listed = await fetchListedModel({
        apiKeyId: key.id,
        defaultParameters: { num_ctx: "8192" },
        configuredParameters: { num_ctx: 32768 },
      });

      expect(listed.contextLength).toBe(262144);
      expect(listed.effectiveContextLength).toBe(32768);
    });
  });

  test("PATCH /api/llm-models/:id rejects embedding changes for the model backing the knowledge base", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "gemini",
      scope: "org",
    });
    const embeddingModel = await ModelModel.create({
      externalId: "gemini/gemini-embedding-001",
      provider: "gemini",
      modelId: "gemini-embedding-001",
      description: "Gemini Embedding 001",
      contextLength: null,
      inputModalities: ["text"],
      outputModalities: [],
      supportsToolCalling: false,
      promptPricePerToken: null,
      completionPricePerToken: null,
      embeddingDimensions: 3072,
      ignored: false,
      lastSyncedAt: new Date(),
    });
    await OrganizationModel.patch(organizationId, {
      embeddingChatApiKeyId: apiKey.id,
      embeddingModel: embeddingModel.modelId,
    });

    // Changing dimensions would silently corrupt the existing index.
    const changeDimensionsResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-models/${embeddingModel.id}`,
      payload: { embeddingDimensions: 768 },
    });
    expect(changeDimensionsResponse.statusCode).toBe(400);
    expect(changeDimensionsResponse.json().error.message).toContain(
      "knowledge base embedding model",
    );
    expect(changeDimensionsResponse.json().error.internal_code).toBe(
      "embedding_validation_failed",
    );

    // Clearing dimensions (turning it back into a chat model) is just as bad.
    const clearDimensionsResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-models/${embeddingModel.id}`,
      payload: { embeddingDimensions: null },
    });
    expect(clearDimensionsResponse.statusCode).toBe(400);
    expect(clearDimensionsResponse.json().error.internal_code).toBe(
      "embedding_validation_failed",
    );

    const unchanged = await ModelModel.findById(embeddingModel.id);
    expect(unchanged?.embeddingDimensions).toBe(3072);

    // Non-embedding updates (and resending the unchanged dimensions, which is
    // what the edit dialog does) stay allowed while the model is locked.
    const benignResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-models/${embeddingModel.id}`,
      payload: { ignored: true, embeddingDimensions: 3072 },
    });
    expect(benignResponse.statusCode).toBe(200);
    expect(benignResponse.json().ignored).toBe(true);
  });

  test("PATCH /api/llm-models/:id embedding lock is scoped to the embedding key's provider and lifts after drop", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "gemini",
      scope: "org",
    });
    const geminiModel = await ModelModel.create({
      externalId: "gemini/gemini-embedding-001",
      provider: "gemini",
      modelId: "gemini-embedding-001",
      description: "Gemini Embedding 001",
      contextLength: null,
      inputModalities: ["text"],
      outputModalities: [],
      supportsToolCalling: false,
      promptPricePerToken: null,
      completionPricePerToken: null,
      embeddingDimensions: 3072,
      ignored: false,
      lastSyncedAt: new Date(),
    });
    // Same model ID under a different provider — a different model row that the
    // knowledge base never resolves, so it must remain editable.
    const openrouterModel = await ModelModel.create({
      externalId: "openrouter/gemini-embedding-001",
      provider: "openrouter",
      modelId: "gemini-embedding-001",
      description: "Gemini Embedding 001 via OpenRouter",
      contextLength: null,
      inputModalities: ["text"],
      outputModalities: [],
      supportsToolCalling: false,
      promptPricePerToken: null,
      completionPricePerToken: null,
      embeddingDimensions: 3072,
      ignored: false,
      lastSyncedAt: new Date(),
    });
    await OrganizationModel.patch(organizationId, {
      embeddingChatApiKeyId: apiKey.id,
      embeddingModel: geminiModel.modelId,
    });

    const otherProviderResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-models/${openrouterModel.id}`,
      payload: { embeddingDimensions: 768 },
    });
    expect(otherProviderResponse.statusCode).toBe(200);
    expect(otherProviderResponse.json().embeddingDimensions).toBe(768);

    // Dropping the embedding config unlocks the previously locked model.
    await OrganizationModel.patch(organizationId, {
      embeddingChatApiKeyId: null,
      embeddingModel: null,
    });
    const afterDropResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-models/${geminiModel.id}`,
      payload: { embeddingDimensions: null },
    });
    expect(afterDropResponse.statusCode).toBe(200);
    expect(afterDropResponse.json().embeddingDimensions).toBe(null);
  });

  test("syncModelsForVisibleApiKeys syncs visible keys and preserves baseUrl", async ({
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const openAiKey = await LlmProviderApiKeyModel.create({
      organizationId,
      secretId: secret.id,
      name: "OpenAI Key",
      provider: "openai",
      scope: "personal",
      userId: user.id,
      baseUrl: "https://proxy.example.com/v1",
    });
    const vllmKey = await LlmProviderApiKeyModel.create({
      organizationId,
      secretId: null,
      name: "vLLM Key",
      provider: "vllm",
      scope: "personal",
      userId: user.id,
      baseUrl: null,
    });

    mockGetSecretValueForLlmProviderApiKey.mockResolvedValue("resolved-secret");
    const syncSpy = vi
      .spyOn(modelSyncService, "syncModelsForApiKey")
      .mockResolvedValue(1);

    await syncModelsForVisibleApiKeys({
      organizationId,
      userId: user.id,
    });

    expect(syncSpy).toHaveBeenNthCalledWith(1, {
      apiKeyId: vllmKey.id,
      provider: "vllm",
      apiKeyValue: "",
      baseUrl: null,
      extraHeaders: null,
    });
    expect(syncSpy).toHaveBeenNthCalledWith(2, {
      apiKeyId: openAiKey.id,
      provider: "openai",
      apiKeyValue: "resolved-secret",
      baseUrl: "https://proxy.example.com/v1",
      extraHeaders: null,
    });
  });

  test("syncModelsForVisibleApiKeys skips required providers when the secret cannot be resolved", async ({
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    await LlmProviderApiKeyModel.create({
      organizationId,
      secretId: secret.id,
      name: "OpenAI Key",
      provider: "openai",
      scope: "personal",
      userId: user.id,
    });
    const availableKeysSpy = vi.spyOn(
      LlmProviderApiKeyModel,
      "getAvailableKeysForUser",
    );
    const syncSpy = vi
      .spyOn(modelSyncService, "syncModelsForApiKey")
      .mockResolvedValue(1);

    mockGetSecretValueForLlmProviderApiKey.mockResolvedValue(undefined);

    await syncModelsForVisibleApiKeys({
      organizationId,
      userId: user.id,
    });

    expect(availableKeysSpy).toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();
  });

  test("syncModelsForVisibleApiKeys delegates Vertex AI system keys to system key sync", async () => {
    mockIsVertexAiEnabled.mockReturnValue(true);

    const syncSpy = vi
      .spyOn(modelSyncService, "syncModelsForApiKey")
      .mockResolvedValue(1);

    await LlmProviderApiKeyModel.createSystemKey({
      organizationId,
      name: "Vertex AI",
      provider: "gemini",
    });

    await syncModelsForVisibleApiKeys({
      organizationId,
      userId: user.id,
    });

    expect(mockSyncSystemKeys).toHaveBeenCalledWith(organizationId);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  test("isModelSyncStateStale uses provider-specific TTLs", () => {
    const now = new Date("2026-05-28T12:00:00.000Z");

    expect(isModelSyncStateStale({ provider: "openrouter", now })).toBe(true);
    expect(
      isModelSyncStateStale({
        provider: "openrouter",
        now,
        syncState: {
          linkedModelCount: 1,
          oldestLastSyncedAt: new Date(now.getTime() - 59 * TimeInMs.Minute),
        },
      }),
    ).toBe(false);
    expect(
      isModelSyncStateStale({
        provider: "openrouter",
        now,
        syncState: {
          linkedModelCount: 1,
          oldestLastSyncedAt: new Date(now.getTime() - 2 * TimeInMs.Hour),
        },
      }),
    ).toBe(true);
    expect(
      isModelSyncStateStale({
        provider: "openai",
        now,
        syncState: {
          linkedModelCount: 1,
          oldestLastSyncedAt: new Date(now.getTime() - 2 * TimeInMs.Hour),
        },
      }),
    ).toBe(false);
  });

  test("isModelSyncStateStale treats the exact TTL boundary as stale", () => {
    const now = new Date("2026-05-28T12:00:00.000Z");
    expect(
      isModelSyncStateStale({
        provider: "openrouter",
        now,
        syncState: {
          linkedModelCount: 1,
          oldestLastSyncedAt: new Date(now.getTime() - TimeInMs.Hour),
        },
      }),
    ).toBe(true);
  });

  test("isModelSyncStateStale handles missing and zero-model sync states", () => {
    const now = new Date("2026-05-28T12:00:00.000Z");

    // null oldest timestamp with a positive count is still unusable -> stale
    expect(
      isModelSyncStateStale({
        provider: "openai",
        now,
        syncState: { linkedModelCount: 1, oldestLastSyncedAt: null },
      }),
    ).toBe(true);

    // zero linked models with a present sync state -> stale
    expect(
      isModelSyncStateStale({
        provider: "openai",
        now,
        syncState: {
          linkedModelCount: 0,
          oldestLastSyncedAt: new Date(now.getTime() - TimeInMs.Minute),
        },
      }),
    ).toBe(true);
  });

  test("isModelSyncStateStale spares zero-model keys synced recently", () => {
    const now = new Date("2026-05-28T12:00:00.000Z");

    // a key that legitimately resolves zero models must not be re-synced on
    // every request once an attempt has been recorded within the TTL window
    expect(
      isModelSyncStateStale({
        provider: "openrouter",
        now,
        syncState: { linkedModelCount: 0, oldestLastSyncedAt: null },
        recentlyAttempted: true,
      }),
    ).toBe(false);

    expect(
      isModelSyncStateStale({
        provider: "openrouter",
        now,
        syncState: { linkedModelCount: 0, oldestLastSyncedAt: null },
        recentlyAttempted: false,
      }),
    ).toBe(true);

    // recentlyAttempted never rescues a key whose linked models have aged out
    expect(
      isModelSyncStateStale({
        provider: "openrouter",
        now,
        syncState: {
          linkedModelCount: 1,
          oldestLastSyncedAt: new Date(now.getTime() - 2 * TimeInMs.Hour),
        },
        recentlyAttempted: true,
      }),
    ).toBe(true);
  });

  test("getStaleModelSyncApiKeys treats old OpenRouter keys as stale", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const now = new Date("2026-05-28T12:00:00.000Z");
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const staleOpenRouterKey = await makeLlmProviderApiKey(
      organizationId,
      secret.id,
      { provider: "openrouter", scope: "personal", userId: user.id },
    );
    const freshOpenAiKey = await makeLlmProviderApiKey(
      organizationId,
      secret.id,
      { provider: "openai", scope: "personal", userId: user.id },
    );
    const freshGeminiKey = await makeLlmProviderApiKey(
      organizationId,
      secret.id,
      { provider: "gemini", scope: "personal", userId: user.id },
    );

    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getModelSyncStatesForApiKeys",
    ).mockResolvedValue(
      new Map([
        [
          staleOpenRouterKey.id,
          {
            apiKeyId: staleOpenRouterKey.id,
            linkedModelCount: 1,
            oldestLastSyncedAt: new Date(now.getTime() - 2 * TimeInMs.Hour),
          },
        ],
        [
          freshOpenAiKey.id,
          {
            apiKeyId: freshOpenAiKey.id,
            linkedModelCount: 1,
            oldestLastSyncedAt: new Date(now.getTime() - 2 * TimeInMs.Hour),
          },
        ],
        [
          freshGeminiKey.id,
          {
            apiKeyId: freshGeminiKey.id,
            linkedModelCount: 1,
            oldestLastSyncedAt: new Date(now.getTime() - 2 * TimeInMs.Hour),
          },
        ],
      ]),
    );

    const staleKeys = await getStaleModelSyncApiKeys({
      apiKeys: [staleOpenRouterKey, freshOpenAiKey, freshGeminiKey],
      now,
    });

    expect(staleKeys.map((key) => key.id).sort()).toEqual(
      [staleOpenRouterKey.id].sort(),
    );
  });

  test("triggerLazyModelSyncForStaleApiKeys dedupes in-flight syncs", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "openrouter-key" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openrouter",
      scope: "personal",
      userId: user.id,
    });
    mockGetSecretValueForLlmProviderApiKey.mockResolvedValue("openrouter-key");

    let resolveSync: ((value: number) => void) | undefined;
    const syncSpy = vi
      .spyOn(modelSyncService, "syncModelsForApiKey")
      .mockImplementation(
        () =>
          new Promise<number>((resolve) => {
            resolveSync = resolve;
          }),
      );

    const firstSyncs = await triggerLazyModelSyncForStaleApiKeys({
      organizationId,
      apiKeys: [apiKey],
    });
    const secondSyncs = await triggerLazyModelSyncForStaleApiKeys({
      organizationId,
      apiKeys: [apiKey],
    });

    expect(firstSyncs).toHaveLength(1);
    expect(secondSyncs).toHaveLength(1);
    expect(secondSyncs[0]).toBe(firstSyncs[0]);
    expect(syncSpy).toHaveBeenCalledTimes(1);

    resolveSync?.(1);
    await Promise.all(firstSyncs);
  });

  describe("PATCH /api/llm-models/:id — configuredParameters", () => {
    async function makeNativeModel(contextLength: number | null = 131072) {
      return ModelModel.create({
        externalId: "ollama/llama3.2",
        provider: "ollama-native",
        modelId: "llama3.2",
        contextLength,
        inputModalities: ["text"],
        outputModalities: ["text"],
        lastSyncedAt: new Date(),
      });
    }

    async function settleAuditWrites() {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    test("saves generation parameters and records a non-empty audit diff", async () => {
      const model = await makeNativeModel();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/llm-models/${model.id}`,
        payload: {
          configuredParameters: { num_predict: 1024, temperature: 0.4 },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().configuredParameters).toEqual({
        num_predict: 1024,
        temperature: 0.4,
      });

      await settleAuditWrites();
      const { data: rows } = await AuditLogModel.findPaginated({
        organizationId,
        resourceType: "llmModel",
        sortDirection: "asc",
        limit: 50,
        offset: 0,
      });

      // Without configuredParameters in the audit snapshot this diff is empty —
      // the only other field the save moves is `updatedAt`, which the hook
      // strips — so "who set num_predict on a globally shared row" is
      // unanswerable. platform/CLAUDE.md requires asserting on it here.
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("llmModel.updated");
      expect(rows[0].before).toMatchObject({ configuredParameters: null });
      expect(rows[0].after).toMatchObject({
        configuredParameters: { num_predict: 1024, temperature: 0.4 },
      });
    });

    test("rejects generation parameters for a non-native provider", async () => {
      const anthropic = await ModelModel.create({
        externalId: "anthropic/claude-test",
        provider: "anthropic",
        modelId: "claude-test",
        contextLength: 200000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        lastSyncedAt: new Date(),
      });

      // Schema-valid on its own — the rejection under test is the provider
      // gate, not the bounds check. Nothing sends these to a paid provider, but
      // an accepted num_ctx would still redefine the window the step-context
      // guard compacts against.
      const response = await app.inject({
        method: "PATCH",
        url: `/api/llm-models/${anthropic.id}`,
        payload: { configuredParameters: { num_ctx: 8192 } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("Ollama (Native)");
      expect(
        (await ModelModel.findById(anthropic.id))?.configuredParameters,
      ).toBeNull();
    });

    test("rejects a num_ctx above the model's context length", async () => {
      const model = await makeNativeModel(131072);

      const response = await app.inject({
        method: "PATCH",
        url: `/api/llm-models/${model.id}`,
        payload: { configuredParameters: { num_ctx: 1310720 } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("131072");
    });

    test("accepts a num_ctx at the model's context length", async () => {
      const model = await makeNativeModel(131072);

      const response = await app.inject({
        method: "PATCH",
        url: `/api/llm-models/${model.id}`,
        payload: { configuredParameters: { num_ctx: 131072 } },
      });

      expect(response.statusCode).toBe(200);
    });

    test("generation parameters need no permission beyond the route's own", async () => {
      const model = await makeNativeModel();
      mockUserHasPermission.mockResolvedValue(false);

      const response = await app.inject({
        method: "PATCH",
        url: `/api/llm-models/${model.id}`,
        payload: { configuredParameters: { num_predict: 1 } },
      });

      // An extra `llmModel:admin` gate used to live here. Model rows are global,
      // but so are the pricing and `ignored` fields an editor could already
      // write, so it drew a line the rest of the route does not — while locking
      // custom roles (frozen permission snapshots) out of every edit on an
      // ollama-native model. `llmModel:update` is the only gate now.
      expect(response.statusCode).toBe(200);
      expect(mockUserHasPermission).not.toHaveBeenCalled();
    });

    test("a pricing-only update still works", async () => {
      const model = await makeNativeModel();
      mockUserHasPermission.mockResolvedValue(false);

      const response = await app.inject({
        method: "PATCH",
        url: `/api/llm-models/${model.id}`,
        payload: { ignored: true },
      });

      expect(response.statusCode).toBe(200);
      expect(mockUserHasPermission).not.toHaveBeenCalled();
    });

    test("rejects an out-of-range parameter at the schema boundary", async () => {
      const model = await makeNativeModel();

      for (const payload of [
        { top_p: 2 },
        { num_ctx: 0 },
        { num_ctx: 8192.5 },
        { seed: 1.5 },
        { num_predict: -3 },
      ]) {
        const response = await app.inject({
          method: "PATCH",
          url: `/api/llm-models/${model.id}`,
          payload: { configuredParameters: payload },
        });
        expect(response.statusCode).toBe(400);
      }
    });
  });
});
