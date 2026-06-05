import { describe, expect, test } from "@/test";
import LlmProviderApiKeyModelLinkModel from "./llm-provider-api-key-model";
import ModelModel from "./model";

describe("LlmProviderApiKeyModelLinkModel", () => {
  describe("getBestModelsForApiKeys", () => {
    test("returns an empty map for empty input", async () => {
      const bestModels =
        await LlmProviderApiKeyModelLinkModel.getBestModelsForApiKeys([]);

      expect(bestModels).toEqual(new Map());
    });

    test("returns best-marked models and falls back to the first linked model", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();

      const bestMarkedKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });
      const fallbackKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });

      const fallbackFirstModel = await ModelModel.create({
        externalId: "openai/gpt-5.4-mini",
        provider: "openai",
        modelId: "gpt-5.4-mini",
        description: "GPT-5.4 Mini",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000001",
        completionPricePerToken: "0.000002",
        lastSyncedAt: new Date(),
      });
      const fallbackSecondModel = await ModelModel.create({
        externalId: "openai/gpt-5.4",
        provider: "openai",
        modelId: "gpt-5.4",
        description: "GPT-5.4",
        contextLength: 200000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000002",
        completionPricePerToken: "0.000006",
        lastSyncedAt: new Date(),
      });
      const bestCandidateModel = await ModelModel.create({
        externalId: "openai/gpt-5.5",
        provider: "openai",
        modelId: "gpt-5.5",
        description: "GPT-5.5",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000002",
        completionPricePerToken: "0.000008",
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        bestMarkedKey.id,
        [
          { id: fallbackFirstModel.id, modelId: fallbackFirstModel.modelId },
          { id: bestCandidateModel.id, modelId: bestCandidateModel.modelId },
        ],
        "openai",
      );
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(fallbackKey.id, [
        fallbackSecondModel.id,
        fallbackFirstModel.id,
      ]);

      const bestModels =
        await LlmProviderApiKeyModelLinkModel.getBestModelsForApiKeys([
          bestMarkedKey.id,
          fallbackKey.id,
        ]);

      expect(bestModels.get(bestMarkedKey.id)?.id).toBe(bestCandidateModel.id);
      expect(bestModels.get(fallbackKey.id)?.id).toBe(fallbackSecondModel.id);
    });
  });

  describe("getAllModelsWithApiKeys", () => {
    test("returns empty array when no models exist", async ({
      makeOrganization,
    }) => {
      await makeOrganization();
      const result =
        await LlmProviderApiKeyModelLinkModel.getAllModelsWithApiKeys();
      expect(result).toEqual([]);
    });

    test("returns models that have linked API keys", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();

      // Create an API key
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });

      // Create a model and link it
      const model = await ModelModel.create({
        externalId: "openai/gpt-5.5",
        provider: "openai",
        modelId: "gpt-5.5",
        description: "GPT-5.5",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000005",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(apiKey.id, [
        model.id,
      ]);

      const result =
        await LlmProviderApiKeyModelLinkModel.getAllModelsWithApiKeys();
      expect(result).toHaveLength(1);
      expect(result[0].model.id).toBe(model.id);
      expect(result[0].apiKeys).toHaveLength(1);
      expect(result[0].apiKeys[0].id).toBe(apiKey.id);
    });

    test("excludes orphaned models with no linked API keys", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();

      // Create an API key and a linked model
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });
      const linkedModel = await ModelModel.create({
        externalId: "openai/gpt-5.5",
        provider: "openai",
        modelId: "gpt-5.5",
        description: "GPT-5.5",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000005",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(apiKey.id, [
        linkedModel.id,
      ]);

      // Create an orphaned model (no API key link)
      await ModelModel.create({
        externalId: "openai/gpt-5.4-mini",
        provider: "openai",
        modelId: "gpt-5.4-mini",
        description: "GPT-5.4 Mini",
        contextLength: 16000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000001",
        completionPricePerToken: "0.000002",
        lastSyncedAt: new Date(),
      });

      const result =
        await LlmProviderApiKeyModelLinkModel.getAllModelsWithApiKeys();

      // Only the linked model should be returned
      expect(result).toHaveLength(1);
      expect(result[0].model.id).toBe(linkedModel.id);
      expect(result[0].model.modelId).toBe("gpt-5.5");
    });

    test("orphaned models appear after API key deletion due to cascade", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();

      // Create API key and link a model
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "anthropic",
      });
      const model = await ModelModel.create({
        externalId: "anthropic/claude-opus-4-7",
        provider: "anthropic",
        modelId: "claude-opus-4-7",
        description: "Claude Opus 4.7",
        contextLength: 200000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000003",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(apiKey.id, [
        model.id,
      ]);

      // Verify model is visible before deletion
      let result =
        await LlmProviderApiKeyModelLinkModel.getAllModelsWithApiKeys();
      expect(result).toHaveLength(1);

      // Delete the API key (cascade deletes api_key_models entries)
      const { LlmProviderApiKeyModel } = await import("@/models");
      await LlmProviderApiKeyModel.delete(apiKey.id);

      // Model should no longer appear since it has no linked API keys
      result = await LlmProviderApiKeyModelLinkModel.getAllModelsWithApiKeys();
      expect(result).toHaveLength(0);

      // But the model itself still exists in the models table
      const orphanedModel = await ModelModel.findById(model.id);
      expect(orphanedModel).not.toBeNull();
    });
  });

  describe("syncModelsForApiKey", () => {
    test("deduplicates repeated models before inserting links", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });

      const model = await ModelModel.create({
        externalId: "openai/gpt-5.5",
        provider: "openai",
        modelId: "gpt-5.5",
        description: "GPT-5.5",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000002",
        completionPricePerToken: "0.000008",
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        apiKey.id,
        [
          { id: model.id, modelId: model.modelId },
          { id: model.id, modelId: model.modelId },
        ],
        "openai",
      );

      const linkedModels =
        await LlmProviderApiKeyModelLinkModel.getModelsForApiKey(apiKey.id);

      expect(linkedModels).toHaveLength(1);
      expect(linkedModels[0].id).toBe(model.id);
    });

    test("getLinkedModelSelectionKeys returns only existing links", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });
      const otherApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });

      const model = await ModelModel.create({
        externalId: "openai/gpt-5.5",
        provider: "openai",
        modelId: "gpt-5.5",
        description: "GPT-5.5",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000002",
        completionPricePerToken: "0.000008",
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        apiKey.id,
        [{ id: model.id, modelId: model.modelId }],
        "openai",
      );

      const linkedSelections =
        await LlmProviderApiKeyModelLinkModel.getLinkedModelSelectionKeys([
          { modelId: model.id, apiKeyId: apiKey.id },
          { modelId: model.id, apiKeyId: otherApiKey.id },
        ]);

      expect(linkedSelections).toEqual(new Set([`${apiKey.id}:${model.id}`]));
    });
  });

  describe("chat-capable filtering in resolution fallbacks", () => {
    test("getFirstModelForApiKey skips ignored models", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });

      const hiddenModel = await ModelModel.create({
        externalId: "openai/babbage-002",
        provider: "openai",
        modelId: "babbage-002",
        description: "Babbage",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: false,
        lastSyncedAt: new Date(),
      });
      await ModelModel.update(hiddenModel.id, { ignored: true });

      const chatModel = await ModelModel.create({
        externalId: "openai/gpt-5.4",
        provider: "openai",
        modelId: "gpt-5.4",
        description: "GPT-5.4",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(apiKey.id, [
        hiddenModel.id,
        chatModel.id,
      ]);

      const first =
        await LlmProviderApiKeyModelLinkModel.getFirstModelForApiKey(apiKey.id);
      expect(first?.id).toBe(chatModel.id);
    });

    test("getRankedModelsForApiKeys excludes ignored and embedding models", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });

      const hiddenModel = await ModelModel.create({
        externalId: "openai/babbage-002",
        provider: "openai",
        modelId: "babbage-002",
        description: "Babbage",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: false,
        lastSyncedAt: new Date(),
      });
      await ModelModel.update(hiddenModel.id, { ignored: true });

      const embeddingModel = await ModelModel.create({
        externalId: "openai/text-embedding-3-small",
        provider: "openai",
        modelId: "text-embedding-3-small",
        description: "Embedding",
        inputModalities: ["text"],
        outputModalities: ["text"],
        embeddingDimensions: 1536,
        lastSyncedAt: new Date(),
      });

      const chatModel = await ModelModel.create({
        externalId: "openai/gpt-5.4",
        provider: "openai",
        modelId: "gpt-5.4",
        description: "GPT-5.4",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(apiKey.id, [
        hiddenModel.id,
        embeddingModel.id,
        chatModel.id,
      ]);

      const ranked =
        await LlmProviderApiKeyModelLinkModel.getRankedModelsForApiKeys([
          apiKey.id,
        ]);

      expect(ranked.map((r) => r.modelId)).toEqual([chatModel.id]);
    });

    test("getBestModel skips an ignored best-marked model", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });

      const hiddenBest = await ModelModel.create({
        externalId: "openai/gpt-5.5",
        provider: "openai",
        modelId: "gpt-5.5",
        description: "GPT-5.5",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        lastSyncedAt: new Date(),
      });
      const chatModel = await ModelModel.create({
        externalId: "openai/gpt-5.4",
        provider: "openai",
        modelId: "gpt-5.4",
        description: "GPT-5.4",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        apiKey.id,
        [
          { id: hiddenBest.id, modelId: hiddenBest.modelId },
          { id: chatModel.id, modelId: chatModel.modelId },
        ],
        "openai",
      );
      await ModelModel.update(hiddenBest.id, { ignored: true });

      const best = await LlmProviderApiKeyModelLinkModel.getBestModel(
        apiKey.id,
      );
      expect(best?.id).toBe(chatModel.id);
    });

    test("getBestModelsForApiKeys skips an ignored best-marked model", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });

      const hiddenBest = await ModelModel.create({
        externalId: "openai/gpt-5.5",
        provider: "openai",
        modelId: "gpt-5.5",
        description: "GPT-5.5",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        lastSyncedAt: new Date(),
      });
      const chatModel = await ModelModel.create({
        externalId: "openai/gpt-5.4",
        provider: "openai",
        modelId: "gpt-5.4",
        description: "GPT-5.4",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        apiKey.id,
        [
          { id: hiddenBest.id, modelId: hiddenBest.modelId },
          { id: chatModel.id, modelId: chatModel.modelId },
        ],
        "openai",
      );
      await ModelModel.update(hiddenBest.id, { ignored: true });

      const bestModels =
        await LlmProviderApiKeyModelLinkModel.getBestModelsForApiKeys([
          apiKey.id,
        ]);
      expect(bestModels.get(apiKey.id)?.id).toBe(chatModel.id);
    });
  });

  describe("best-model marker priority", () => {
    test.for([
      { catalog: ["gpt-4o", "gpt-3.5-turbo"], expected: "gpt-4o" },
      { catalog: ["gpt-4.1", "gpt-4o"], expected: "gpt-4.1" },
      { catalog: ["gpt-5", "gpt-4o"], expected: "gpt-5" },
      { catalog: ["gpt-5.4", "gpt-5"], expected: "gpt-5.4" },
      { catalog: ["gpt-5.5", "gpt-5.4"], expected: "gpt-5.5" },
      { catalog: ["gpt-5.5-pro", "gpt-5.5"], expected: "gpt-5.5-pro" },
    ])("marks $expected as best for $catalog", async ({ catalog, expected }, {
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });

      const models = [];
      for (const modelId of catalog) {
        models.push(
          await ModelModel.create({
            externalId: `openai/${modelId}`,
            provider: "openai",
            modelId,
            description: modelId,
            inputModalities: ["text"],
            outputModalities: ["text"],
            supportsToolCalling: true,
            lastSyncedAt: new Date(),
          }),
        );
      }

      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        apiKey.id,
        models.map((model) => ({ id: model.id, modelId: model.modelId })),
        "openai",
      );

      const best = await LlmProviderApiKeyModelLinkModel.getBestModel(
        apiKey.id,
      );
      expect(best?.modelId).toBe(expected);
    });
  });
});
