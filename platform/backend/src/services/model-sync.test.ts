import type { SupportedProvider } from "@shared";
import { vi } from "vitest";
import ApiKeyModelModel from "@/models/api-key-model";
import ModelModel from "@/models/model";
import { describe, expect, test } from "@/test";
import { modelSyncService } from "./model-sync";

// Mock the models.dev client to avoid external API calls
vi.mock("@/clients/models-dev-client", () => ({
  modelsDevClient: {
    fetchModelsFromApi: vi.fn().mockResolvedValue({}),
  },
}));

describe("ModelSyncService", () => {
  test("stores models with the API key's provider, not detected provider", async ({
    makeOrganization,
    makeSecret,
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const apiKey = await makeChatApiKey(org.id, secret.id, {
      provider: "openai",
    });

    // Register a fetcher that returns models with various detected providers
    // (simulating an OpenAI-compatible proxy returning models from multiple providers)
    modelSyncService.registerFetcher("openai", async () => [
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
    ]);

    await modelSyncService.syncModelsForApiKey(apiKey.id, "openai", "test-key");

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
    const linkedModels = await ApiKeyModelModel.getModelsForApiKeyIds([
      apiKey.id,
    ]);
    expect(linkedModels).toHaveLength(3);
    expect(linkedModels.every((m) => m.model.provider === "openai")).toBe(true);
  });
});
