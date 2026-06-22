import {
  OPENROUTER_FREE_MODEL_ID,
  type SupportedProvider,
} from "@archestra/shared";
import { vi } from "vitest";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";
import { modelFetchers } from "@/routes/chat/model-fetchers";
import { afterEach, describe, expect, test } from "@/test";
import { modelSyncService, resolveModelCapabilities } from "./model-sync";

// Mock the models.dev client to avoid external API calls
vi.mock("@/clients/models-dev-client", () => ({
  modelsDevClient: {
    fetchModelsFromApi: vi.fn().mockResolvedValue({}),
  },
}));

describe("ModelSyncService", () => {
  const originalOpenAiFetcher = modelFetchers.openai;
  const originalAzureFetcher = modelFetchers.azure;
  const originalGeminiFetcher = modelFetchers.gemini;
  const originalOpenrouterFetcher = modelFetchers.openrouter;

  afterEach(() => {
    modelFetchers.openai = originalOpenAiFetcher;
    modelFetchers.azure = originalAzureFetcher;
    modelFetchers.gemini = originalGeminiFetcher;
    modelFetchers.openrouter = originalOpenrouterFetcher;
  });

  test("stores models with the API key's provider, not detected provider", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });

    // Register a fetcher that returns models with various detected providers
    // (simulating an OpenAI-compatible proxy returning models from multiple providers)
    modelFetchers.openai = async () => [
      {
        id: "gpt-4o",
        displayName: "GPT-4o",
        provider: "openai" as SupportedProvider,
      },
      {
        // A proxy might return claude models; mapOpenAiModelToModelInfo
        // would detect this as "anthropic", but sync should store as "openai"
        id: "claude-3-5-sonnet",
        displayName: "Claude 3.5 Sonnet",
        provider: "anthropic" as SupportedProvider,
      },
      {
        id: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        provider: "gemini" as SupportedProvider,
      },
    ];

    await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: "openai",
      apiKeyValue: "test-key",
    });

    // All models should be stored with provider="openai" (the API key's provider)
    const gpt = await ModelModel.findByProviderAndModelId("openai", "gpt-4o");
    expect(gpt).not.toBeNull();
    expect(gpt?.provider).toBe("openai");

    const claude = await ModelModel.findByProviderAndModelId(
      "openai",
      "claude-3-5-sonnet",
    );
    expect(claude).not.toBeNull();
    expect(claude?.provider).toBe("openai");

    const gemini = await ModelModel.findByProviderAndModelId(
      "openai",
      "gemini-2.5-pro",
    );
    expect(gemini).not.toBeNull();
    expect(gemini?.provider).toBe("openai");

    // Models should NOT exist under the detected providers
    const claudeAsAnthropic = await ModelModel.findByProviderAndModelId(
      "anthropic",
      "claude-3-5-sonnet",
    );
    expect(claudeAsAnthropic).toBeNull();

    const geminiAsGemini = await ModelModel.findByProviderAndModelId(
      "gemini",
      "gemini-2.5-pro",
    );
    expect(geminiAsGemini).toBeNull();

    // Verify all 3 models are linked to the API key
    const linkedModels =
      await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([apiKey.id]);
    expect(linkedModels).toHaveLength(3);
    expect(linkedModels.every((m) => m.model.provider === "openai")).toBe(true);
  });

  test("forceRefresh resets custom pricing, normal sync preserves it", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });

    modelFetchers.openai = async () => [
      {
        id: "gpt-4o",
        displayName: "GPT-4o",
        provider: "openai" as SupportedProvider,
      },
    ];

    // Initial sync creates the model
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: "openai",
      apiKeyValue: "test-key",
    });

    // Set custom pricing and user-edited capabilities
    const model = await ModelModel.findByProviderAndModelId("openai", "gpt-4o");
    expect(model).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    await ModelModel.update(model!.id, {
      customPricePerMillionInput: "1.00",
      customPricePerMillionOutput: "2.00",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
    });

    // Normal sync should preserve custom pricing and capabilities
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: "openai",
      apiKeyValue: "test-key",
    });

    const afterNormalSync = await ModelModel.findByProviderAndModelId(
      "openai",
      "gpt-4o",
    );
    expect(afterNormalSync?.customPricePerMillionInput).toBe("1.00");
    expect(afterNormalSync?.customPricePerMillionOutput).toBe("2.00");
    expect(afterNormalSync?.inputModalities).toEqual(["text", "image"]);
    expect(afterNormalSync?.outputModalities).toEqual(["text"]);

    // Force refresh should reset custom pricing and capabilities
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: "openai",
      apiKeyValue: "test-key",
      forceRefresh: true,
    });

    const afterForceRefresh = await ModelModel.findByProviderAndModelId(
      "openai",
      "gpt-4o",
    );
    expect(afterForceRefresh?.customPricePerMillionInput).toBeNull();
    expect(afterForceRefresh?.customPricePerMillionOutput).toBeNull();
    expect(afterForceRefresh?.inputModalities).toBeNull();
    expect(afterForceRefresh?.outputModalities).toBeNull();
  });

  test("infers Gemini modalities and backfills missing values without overwriting user edits", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { apiKey: "vertex-placeholder" },
    });
    const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "gemini",
    });

    await ModelModel.create({
      externalId: "gemini/gemini-2.5-flash",
      provider: "gemini",
      modelId: "gemini-2.5-flash",
      description: null,
      contextLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      promptPricePerToken: null,
      completionPricePerToken: null,
      lastSyncedAt: new Date(),
    });

    modelFetchers.gemini = async () => [
      {
        id: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        provider: "gemini" as SupportedProvider,
      },
      {
        id: "gemini-embedding-001",
        displayName: "Gemini Embedding 001",
        provider: "gemini" as SupportedProvider,
      },
      {
        id: "gemini-live-2.5-flash-native-audio",
        displayName: "Gemini Live 2.5 Flash Native Audio",
        provider: "gemini" as SupportedProvider,
      },
      {
        id: "gemini-2.5-flash-image-preview",
        displayName: "Gemini 2.5 Flash Image Preview",
        provider: "gemini" as SupportedProvider,
      },
    ];

    await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: "gemini",
      apiKeyValue: "vertex-placeholder",
    });

    const flash = await ModelModel.findByProviderAndModelId(
      "gemini",
      "gemini-2.5-flash",
    );
    expect(flash).not.toBeNull();
    expect(flash?.inputModalities).toEqual(["text"]);
    expect(flash?.outputModalities).toEqual(["text"]);

    const embedding = await ModelModel.findByProviderAndModelId(
      "gemini",
      "gemini-embedding-001",
    );
    expect(embedding?.inputModalities).toEqual(["text"]);
    expect(embedding?.outputModalities).toEqual([]);

    const liveAudio = await ModelModel.findByProviderAndModelId(
      "gemini",
      "gemini-live-2.5-flash-native-audio",
    );
    expect(liveAudio?.inputModalities).toEqual(["text", "audio"]);
    expect(liveAudio?.outputModalities).toEqual(["audio"]);

    const imagePreview = await ModelModel.findByProviderAndModelId(
      "gemini",
      "gemini-2.5-flash-image-preview",
    );
    expect(imagePreview?.inputModalities).toEqual(["text", "image"]);
    expect(imagePreview?.outputModalities).toEqual(["image"]);

    // biome-ignore lint/style/noNonNullAssertion: asserted above
    await ModelModel.update(flash!.id, {
      inputModalities: ["text", "image"],
      outputModalities: ["text", "image"],
    });

    await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: "gemini",
      apiKeyValue: "vertex-placeholder",
    });

    const flashAfterResync = await ModelModel.findByProviderAndModelId(
      "gemini",
      "gemini-2.5-flash",
    );
    expect(flashAfterResync?.inputModalities).toEqual(["text", "image"]);
    expect(flashAfterResync?.outputModalities).toEqual(["text", "image"]);
  });

  test("normalizes gemini-embedding-2-preview as multimodal during sync", () => {
    const capabilities = resolveModelCapabilities({
      provider: "gemini",
      modelId: "gemini-embedding-2-preview",
      capabilities: {
        description: "Gemini Embedding 2 Preview",
        contextLength: null,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: null,
        completionPricePerToken: null,
        cacheReadPricePerToken: null,
        cacheWritePricePerToken: null,
      },
    });

    expect(capabilities.inputModalities).toEqual(["text", "image"]);
    expect(capabilities.outputModalities).toEqual([]);
    expect(capabilities.supportsToolCalling).toBe(false);
  });

  test("prefers fetcher capabilities over models.dev with per-field fallthrough", () => {
    const capabilities = resolveModelCapabilities({
      provider: "openrouter",
      modelId: "deepseek/deepseek-chat-v3.1:free",
      capabilities: {
        description: "DeepSeek V3.1",
        contextLength: 32000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: false,
        promptPricePerToken: "0.0000002",
        completionPricePerToken: "0.0000008",
        cacheReadPricePerToken: null,
        cacheWritePricePerToken: null,
      },
      fetched: {
        contextLength: 64000,
        supportsToolCalling: true,
        promptPricePerToken: "0",
        completionPricePerToken: "0",
      },
    });

    // Fetcher wins on the fields it carries.
    expect(capabilities.contextLength).toBe(64000);
    expect(capabilities.supportsToolCalling).toBe(true);
    expect(capabilities.promptPricePerToken).toBe("0");
    expect(capabilities.completionPricePerToken).toBe("0");
    // models.dev still fills fields the fetcher does not carry.
    expect(capabilities.description).toBe("DeepSeek V3.1");
    expect(capabilities.inputModalities).toEqual(["text"]);
  });

  test("persists fetcher pricing so :free models sync as zero-priced", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "openrouter-key" } });
    const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openrouter",
    });

    modelFetchers.openrouter = async () => [
      {
        id: "deepseek/deepseek-chat-v3.1:free",
        displayName: "DeepSeek V3.1 (free)",
        provider: "openrouter" as SupportedProvider,
        capabilities: {
          contextLength: 64000,
          supportsToolCalling: true,
          promptPricePerToken: "0",
          completionPricePerToken: "0",
        },
      },
    ];

    await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: "openrouter",
      apiKeyValue: "openrouter-key",
    });

    const model = await ModelModel.findByProviderAndModelId(
      "openrouter",
      "deepseek/deepseek-chat-v3.1:free",
    );
    expect(Number(model?.promptPricePerToken)).toBe(0);
    expect(Number(model?.completionPricePerToken)).toBe(0);
    expect(model?.contextLength).toBe(64000);
    expect(model?.supportsToolCalling).toBe(true);
  });

  test("auto-selects the Free Models Router as the org default for a new OpenRouter key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "openrouter-key" } });
    const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openrouter",
    });

    modelFetchers.openrouter = async () => [
      {
        id: "deepseek/deepseek-chat-v3.1:free",
        displayName: "DeepSeek V3.1 (free)",
        provider: "openrouter" as SupportedProvider,
        capabilities: {
          contextLength: 64000,
          supportsToolCalling: true,
          promptPricePerToken: "0",
          completionPricePerToken: "0",
        },
      },
      {
        id: OPENROUTER_FREE_MODEL_ID,
        displayName: "Free Models Router",
        provider: "openrouter" as SupportedProvider,
        capabilities: {
          contextLength: 200000,
          supportsToolCalling: true,
          promptPricePerToken: "0",
          completionPricePerToken: "0",
        },
      },
    ];

    await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: "openrouter",
      apiKeyValue: "openrouter-key",
    });
    await modelSyncService.maybeAutoSetOrgDefaultModel({
      organizationId: org.id,
      apiKeyId: apiKey.id,
      provider: "openrouter",
    });

    const routerModel = await ModelModel.findByProviderAndModelId(
      "openrouter",
      OPENROUTER_FREE_MODEL_ID,
    );
    const updatedOrg = await OrganizationModel.getById(org.id);
    expect(updatedOrg?.defaultModelId).toBe(routerModel?.id);
    expect(updatedOrg?.defaultLlmApiKeyId).toBe(apiKey.id);
  });

  test("does not override an existing org default model", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "openrouter-key" } });
    const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openrouter",
    });

    modelFetchers.openrouter = async () => [
      {
        id: OPENROUTER_FREE_MODEL_ID,
        displayName: "Free Models Router",
        provider: "openrouter" as SupportedProvider,
        capabilities: {
          contextLength: 200000,
          supportsToolCalling: true,
          promptPricePerToken: "0",
          completionPricePerToken: "0",
        },
      },
    ];
    await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: "openrouter",
      apiKeyValue: "openrouter-key",
    });

    const routerModel = await ModelModel.findByProviderAndModelId(
      "openrouter",
      OPENROUTER_FREE_MODEL_ID,
    );
    if (!routerModel) throw new Error("router model not synced");
    await OrganizationModel.patch(org.id, {
      defaultModelId: routerModel.id,
      defaultLlmApiKeyId: apiKey.id,
    });

    // A non-openrouter provider must never trigger an auto-default.
    await modelSyncService.maybeAutoSetOrgDefaultModel({
      organizationId: org.id,
      apiKeyId: apiKey.id,
      provider: "openai",
    });
    const unchanged = await OrganizationModel.getById(org.id);
    expect(unchanged?.defaultModelId).toBe(routerModel.id);
  });

  test("infers dimensions for Azure OpenAI embedding deployments", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "azure-key" } });
    const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "azure",
    });

    modelFetchers.azure = async () => [
      {
        id: "gpt-5.4-mini",
        displayName: "GPT 5.4 Mini",
        provider: "azure" as SupportedProvider,
      },
      {
        id: "text-embedding-3-large",
        displayName: "Text Embedding 3 Large",
        provider: "azure" as SupportedProvider,
      },
    ];

    const count = await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: "azure",
      apiKeyValue: "azure-key",
    });

    expect(count).toBe(2);

    const embedding = await ModelModel.findByProviderAndModelId(
      "azure",
      "text-embedding-3-large",
    );
    expect(embedding).toEqual(
      expect.objectContaining({
        provider: "azure",
        modelId: "text-embedding-3-large",
        embeddingDimensions: 1536,
        inputModalities: ["text"],
        outputModalities: [],
        supportsToolCalling: false,
      }),
    );
  });

  test("infers dimensions for known OpenRouter embedding models", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "openrouter-key" } });
    const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openrouter",
    });

    modelFetchers.openrouter = async () => [
      {
        id: "openrouter/auto",
        displayName: "openrouter/auto",
        provider: "openrouter" as SupportedProvider,
      },
      {
        id: "openai/text-embedding-3-small",
        displayName: "Text Embedding 3 Small",
        provider: "openrouter" as SupportedProvider,
      },
      {
        id: "nomic-ai/nomic-embed-text",
        displayName: "Nomic Embed Text",
        provider: "openrouter" as SupportedProvider,
      },
    ];

    const count = await modelSyncService.syncModelsForApiKey({
      apiKeyId: apiKey.id,
      provider: "openrouter",
      apiKeyValue: "openrouter-key",
    });

    expect(count).toBe(3);

    const embedding = await ModelModel.findByProviderAndModelId(
      "openrouter",
      "openai/text-embedding-3-small",
    );
    expect(embedding).toEqual(
      expect.objectContaining({
        provider: "openrouter",
        modelId: "openai/text-embedding-3-small",
        embeddingDimensions: 1536,
      }),
    );

    const nomic = await ModelModel.findByProviderAndModelId(
      "openrouter",
      "nomic-ai/nomic-embed-text",
    );
    expect(nomic?.embeddingDimensions).toBe(768);

    const linkedModels =
      await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([apiKey.id]);
    const selectableEmbeddingModels = linkedModels
      .map((link) => link.model)
      .filter((model) => model.embeddingDimensions !== null);
    expect(
      selectableEmbeddingModels.map((model) => model.modelId).sort(),
    ).toEqual(["nomic-ai/nomic-embed-text", "openai/text-embedding-3-small"]);
  });
});
