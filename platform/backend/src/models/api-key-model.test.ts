import { describe, expect, test } from "@/test";
import ApiKeyModelModel from "./api-key-model";
import ModelModel from "./model";

describe("ApiKeyModelModel", () => {
  describe("getBestModelsForApiKeys", () => {
    test("returns an empty map for empty input", async () => {
      const bestModels = await ApiKeyModelModel.getBestModelsForApiKeys([]);

      expect(bestModels).toEqual(new Map());
    });

    test("returns best-marked models and falls back to the first linked model", async ({
      makeOrganization,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();

      const bestMarkedKey = await makeChatApiKey(org.id, secret.id, {
        provider: "openai",
      });
      const fallbackKey = await makeChatApiKey(org.id, secret.id, {
        provider: "openai",
      });

      const fallbackFirstModel = await ModelModel.create({
        externalId: "openai/gpt-4.1-mini",
        provider: "openai",
        modelId: "gpt-4.1-mini",
        description: "GPT-4.1 Mini",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000001",
        completionPricePerToken: "0.000002",
        lastSyncedAt: new Date(),
      });
      const fallbackSecondModel = await ModelModel.create({
        externalId: "openai/o3",
        provider: "openai",
        modelId: "o3",
        description: "o3",
        contextLength: 200000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000002",
        completionPricePerToken: "0.000006",
        lastSyncedAt: new Date(),
      });
      const bestCandidateModel = await ModelModel.create({
        externalId: "openai/gpt-4.1",
        provider: "openai",
        modelId: "gpt-4.1",
        description: "GPT-4.1",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000002",
        completionPricePerToken: "0.000008",
        lastSyncedAt: new Date(),
      });

      await ApiKeyModelModel.syncModelsForApiKey(
        bestMarkedKey.id,
        [
          { id: fallbackFirstModel.id, modelId: fallbackFirstModel.modelId },
          { id: bestCandidateModel.id, modelId: bestCandidateModel.modelId },
        ],
        "openai",
      );
      await ApiKeyModelModel.linkModelsToApiKey(fallbackKey.id, [
        fallbackSecondModel.id,
        fallbackFirstModel.id,
      ]);

      const bestModels = await ApiKeyModelModel.getBestModelsForApiKeys([
        bestMarkedKey.id,
        fallbackKey.id,
      ]);

      expect(bestModels.get(bestMarkedKey.id)?.id).toBe(bestCandidateModel.id);
      expect(bestModels.get(fallbackKey.id)?.id).toBe(fallbackFirstModel.id);
    });
  });

  describe("getAllModelsWithApiKeys", () => {
    test("returns empty array when no models exist", async ({
      makeOrganization,
    }) => {
      await makeOrganization();
      const result = await ApiKeyModelModel.getAllModelsWithApiKeys();
      expect(result).toEqual([]);
    });

    test("returns models that have linked API keys", async ({
      makeOrganization,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();

      // Create an API key
      const apiKey = await makeChatApiKey(org.id, secret.id, {
        provider: "openai",
      });

      // Create a model and link it
      const model = await ModelModel.create({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        description: "GPT-4o",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000005",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });

      await ApiKeyModelModel.linkModelsToApiKey(apiKey.id, [model.id]);

      const result = await ApiKeyModelModel.getAllModelsWithApiKeys();
      expect(result).toHaveLength(1);
      expect(result[0].model.id).toBe(model.id);
      expect(result[0].apiKeys).toHaveLength(1);
      expect(result[0].apiKeys[0].id).toBe(apiKey.id);
    });

    test("excludes orphaned models with no linked API keys", async ({
      makeOrganization,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();

      // Create an API key and a linked model
      const apiKey = await makeChatApiKey(org.id, secret.id, {
        provider: "openai",
      });
      const linkedModel = await ModelModel.create({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        description: "GPT-4o",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000005",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });
      await ApiKeyModelModel.linkModelsToApiKey(apiKey.id, [linkedModel.id]);

      // Create an orphaned model (no API key link)
      await ModelModel.create({
        externalId: "openai/gpt-3.5-turbo",
        provider: "openai",
        modelId: "gpt-3.5-turbo",
        description: "GPT-3.5 Turbo",
        contextLength: 16000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000001",
        completionPricePerToken: "0.000002",
        lastSyncedAt: new Date(),
      });

      const result = await ApiKeyModelModel.getAllModelsWithApiKeys();

      // Only the linked model should be returned
      expect(result).toHaveLength(1);
      expect(result[0].model.id).toBe(linkedModel.id);
      expect(result[0].model.modelId).toBe("gpt-4o");
    });

    test("orphaned models appear after API key deletion due to cascade", async ({
      makeOrganization,
      makeSecret,
      makeChatApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();

      // Create API key and link a model
      const apiKey = await makeChatApiKey(org.id, secret.id, {
        provider: "anthropic",
      });
      const model = await ModelModel.create({
        externalId: "anthropic/claude-3-sonnet",
        provider: "anthropic",
        modelId: "claude-3-sonnet",
        description: "Claude 3 Sonnet",
        contextLength: 200000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000003",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });
      await ApiKeyModelModel.linkModelsToApiKey(apiKey.id, [model.id]);

      // Verify model is visible before deletion
      let result = await ApiKeyModelModel.getAllModelsWithApiKeys();
      expect(result).toHaveLength(1);

      // Delete the API key (cascade deletes api_key_models entries)
      const { ChatApiKeyModel } = await import("@/models");
      await ChatApiKeyModel.delete(apiKey.id);

      // Model should no longer appear since it has no linked API keys
      result = await ApiKeyModelModel.getAllModelsWithApiKeys();
      expect(result).toHaveLength(0);

      // But the model itself still exists in the models table
      const orphanedModel = await ModelModel.findById(model.id);
      expect(orphanedModel).not.toBeNull();
    });
  });
});
