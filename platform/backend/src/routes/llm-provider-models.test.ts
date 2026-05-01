import { vi } from "vitest";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { modelSyncService } from "@/services/model-sync";
import { systemKeyManager } from "@/services/system-key-manager";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { syncModelsForVisibleApiKeys } from "./llm-provider-models";

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
const mockSyncSystemKeys = vi.mocked(systemKeyManager.syncSystemKeys);

describe("chat model routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockIsVertexAiEnabled.mockReturnValue(false);

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
});
