import { describe, expect, test } from "@/test";
import LlmProviderApiKeyModelLinkModel from "./llm-provider-api-key-model";
import ModelModel from "./model";

describe("ModelModel", () => {
  describe("create", () => {
    test("can create model", async () => {
      const model = await ModelModel.create({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        description: "GPT-4o is a multimodal model",
        contextLength: 128000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000005",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });

      expect(model.id).toBeDefined();
      expect(model.externalId).toBe("openai/gpt-4o");
      expect(model.provider).toBe("openai");
      expect(model.modelId).toBe("gpt-4o");
      expect(model.description).toBe("GPT-4o is a multimodal model");
      expect(model.contextLength).toBe(128000);
      expect(model.inputModalities).toEqual(["text", "image"]);
      expect(model.outputModalities).toEqual(["text"]);
      expect(model.supportsToolCalling).toBe(true);
      expect(model.promptPricePerToken).toBe("0.000005000000");
      expect(model.completionPricePerToken).toBe("0.000015000000");
    });
  });

  describe("findByProviderAndModelId", () => {
    test("returns null when model does not exist", async () => {
      const model = await ModelModel.findByProviderAndModelId(
        "openai",
        "nonexistent-model",
      );
      expect(model).toBeNull();
    });

    test("can find model by provider and model ID", async () => {
      await ModelModel.create({
        externalId: "anthropic/claude-3-5-sonnet",
        provider: "anthropic",
        modelId: "claude-3-5-sonnet",
        description: "Claude 3.5 Sonnet",
        contextLength: 200000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000003",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });

      const model = await ModelModel.findByProviderAndModelId(
        "anthropic",
        "claude-3-5-sonnet",
      );

      expect(model).not.toBeNull();
      expect(model?.provider).toBe("anthropic");
      expect(model?.modelId).toBe("claude-3-5-sonnet");
    });

    test("disambiguates same model ID across different providers", async () => {
      await ModelModel.create({
        externalId: "openai/shared-model",
        provider: "openai",
        modelId: "shared-model",
        inputModalities: ["text"],
        outputModalities: ["text"],
        promptPricePerToken: "0.000010",
        completionPricePerToken: "0.000030",
        lastSyncedAt: new Date(),
      });
      await ModelModel.create({
        externalId: "anthropic/shared-model",
        provider: "anthropic",
        modelId: "shared-model",
        inputModalities: ["text"],
        outputModalities: ["text"],
        promptPricePerToken: "0.000003",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });

      const openaiModel = await ModelModel.findByProviderAndModelId(
        "openai",
        "shared-model",
      );
      const anthropicModel = await ModelModel.findByProviderAndModelId(
        "anthropic",
        "shared-model",
      );

      expect(openaiModel?.provider).toBe("openai");
      expect(openaiModel?.promptPricePerToken).toBe("0.000010000000");
      expect(anthropicModel?.provider).toBe("anthropic");
      expect(anthropicModel?.promptPricePerToken).toBe("0.000003000000");
    });
  });

  describe("findAll", () => {
    test("filters by multiple providers", async () => {
      await ModelModel.create({
        externalId: "openai/find-all-provider-filter",
        provider: "openai",
        modelId: "find-all-provider-filter",
        inputModalities: ["text"],
        outputModalities: ["text"],
        promptPricePerToken: "0.000010",
        completionPricePerToken: "0.000030",
        lastSyncedAt: new Date(),
      });
      await ModelModel.create({
        externalId: "anthropic/find-all-provider-filter",
        provider: "anthropic",
        modelId: "find-all-provider-filter",
        inputModalities: ["text"],
        outputModalities: ["text"],
        promptPricePerToken: "0.000003",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });
      await ModelModel.create({
        externalId: "gemini/find-all-provider-filter",
        provider: "gemini",
        modelId: "find-all-provider-filter",
        inputModalities: ["text"],
        outputModalities: ["text"],
        promptPricePerToken: "0.000001",
        completionPricePerToken: "0.000002",
        lastSyncedAt: new Date(),
      });

      const models = await ModelModel.findAll({
        providers: ["anthropic", "gemini"],
      });

      expect(models.map((model) => model.provider).sort()).toEqual([
        "anthropic",
        "gemini",
      ]);
    });

    test("returns no models for an empty provider filter", async () => {
      await ModelModel.create({
        externalId: "openai/empty-provider-filter",
        provider: "openai",
        modelId: "empty-provider-filter",
        inputModalities: ["text"],
        outputModalities: ["text"],
        promptPricePerToken: "0.000010",
        completionPricePerToken: "0.000030",
        lastSyncedAt: new Date(),
      });

      await expect(ModelModel.findAll({ providers: [] })).resolves.toEqual([]);
    });
  });

  describe("findByProviderModelIds", () => {
    test("returns empty map when no keys provided", async () => {
      const map = await ModelModel.findByProviderModelIds([]);
      expect(map.size).toBe(0);
    });

    test("returns models for matching keys", async () => {
      await ModelModel.create({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        description: "GPT-4o",
        contextLength: 128000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000005",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });

      await ModelModel.create({
        externalId: "anthropic/claude-3-opus",
        provider: "anthropic",
        modelId: "claude-3-opus",
        description: "Claude 3 Opus",
        contextLength: 200000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000015",
        completionPricePerToken: "0.000075",
        lastSyncedAt: new Date(),
      });

      const map = await ModelModel.findByProviderModelIds([
        { provider: "openai", modelId: "gpt-4o" },
        { provider: "anthropic", modelId: "claude-3-opus" },
        { provider: "openai", modelId: "nonexistent" },
      ]);

      expect(map.size).toBe(2);
      expect(map.get("openai:gpt-4o")?.modelId).toBe("gpt-4o");
      expect(map.get("anthropic:claude-3-opus")?.modelId).toBe("claude-3-opus");
      expect(map.get("openai:nonexistent")).toBeUndefined();
    });

    test("only returns requested records via database-level filtering", async () => {
      // Create multiple records in the database
      await ModelModel.create({
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

      await ModelModel.create({
        externalId: "anthropic/claude-3-opus",
        provider: "anthropic",
        modelId: "claude-3-opus",
        description: "Claude 3 Opus",
        contextLength: 200000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000015",
        completionPricePerToken: "0.000075",
        lastSyncedAt: new Date(),
      });

      // Request only one of the three records
      const map = await ModelModel.findByProviderModelIds([
        { provider: "openai", modelId: "gpt-4o" },
      ]);

      // Should only return the requested record, not all records in the table
      expect(map.size).toBe(1);
      expect(map.get("openai:gpt-4o")?.modelId).toBe("gpt-4o");
      expect(map.get("openai:gpt-3.5-turbo")).toBeUndefined();
      expect(map.get("anthropic:claude-3-opus")).toBeUndefined();
    });
  });

  describe("upsert", () => {
    test("creates new model if it does not exist", async () => {
      const model = await ModelModel.upsert({
        externalId: "openai/gpt-4-turbo",
        provider: "openai",
        modelId: "gpt-4-turbo",
        description: "GPT-4 Turbo",
        contextLength: 128000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.00001",
        completionPricePerToken: "0.00003",
        lastSyncedAt: new Date(),
      });

      expect(model.id).toBeDefined();
      expect(model.modelId).toBe("gpt-4-turbo");
    });

    test("updates existing model on conflict", async () => {
      // Create initial model
      const initial = await ModelModel.create({
        externalId: "openai/gpt-4o-mini",
        provider: "openai",
        modelId: "gpt-4o-mini",
        description: "Initial description",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: false,
        promptPricePerToken: "0.00001",
        completionPricePerToken: "0.00003",
        lastSyncedAt: new Date(),
      });

      // Upsert with updated data
      const updated = await ModelModel.upsert({
        externalId: "openai/gpt-4o-mini",
        provider: "openai",
        modelId: "gpt-4o-mini",
        description: "Updated description",
        contextLength: 256000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.00002",
        completionPricePerToken: "0.00006",
        lastSyncedAt: new Date(),
      });

      expect(updated.id).toBe(initial.id);
      expect(updated.description).toBe("Updated description");
      // contextLength, inputModalities, supportsToolCalling are NOT updated on conflict
      // to preserve user-edited values
      expect(updated.contextLength).toBe(128000);
      expect(updated.inputModalities).toEqual(["text"]);
      expect(updated.supportsToolCalling).toBe(false);
    });
  });

  describe("bulkUpsert", () => {
    test("returns empty array when no data provided", async () => {
      const results = await ModelModel.bulkUpsert([]);
      expect(results).toEqual([]);
    });

    test("can bulk upsert multiple records", async () => {
      const results = await ModelModel.bulkUpsert([
        {
          externalId: "google/gemini-pro",
          provider: "gemini",
          modelId: "gemini-pro",
          description: "Gemini Pro",
          contextLength: 32000,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalling: true,
          promptPricePerToken: "0.0000005",
          completionPricePerToken: "0.0000015",
          lastSyncedAt: new Date(),
        },
        {
          externalId: "google/gemini-flash",
          provider: "gemini",
          modelId: "gemini-flash",
          description: "Gemini Flash",
          contextLength: 1000000,
          inputModalities: ["text", "image", "video"],
          outputModalities: ["text"],
          supportsToolCalling: true,
          promptPricePerToken: "0.00000025",
          completionPricePerToken: "0.0000005",
          lastSyncedAt: new Date(),
        },
      ]);

      expect(results).toHaveLength(2);

      // Verify both were persisted
      const all = await ModelModel.findAll();
      expect(all).toHaveLength(2);
    });

    test("handles large batches correctly (more than batch size of 50)", async () => {
      // Create 150 test models to verify batching works across multiple batches
      const models = Array.from({ length: 150 }, (_, i) => ({
        externalId: `test-provider/model-${i}`,
        provider: "openai" as const,
        modelId: `test-model-${i}`,
        description: `Test Model ${i}`,
        contextLength: 128000,
        inputModalities: ["text" as const],
        outputModalities: ["text" as const],
        supportsToolCalling: true,
        promptPricePerToken: "0.000001",
        completionPricePerToken: "0.000002",
        lastSyncedAt: new Date(),
      }));

      const results = await ModelModel.bulkUpsert(models);

      // All 150 models should be inserted
      expect(results).toHaveLength(150);

      // Verify all were persisted
      const all = await ModelModel.findAll();
      expect(all).toHaveLength(150);

      // Verify some specific models to ensure data integrity
      const first = await ModelModel.findByProviderAndModelId(
        "openai",
        "test-model-0",
      );
      expect(first).not.toBeNull();
      expect(first?.description).toBe("Test Model 0");

      const last = await ModelModel.findByProviderAndModelId(
        "openai",
        "test-model-149",
      );
      expect(last).not.toBeNull();
      expect(last?.description).toBe("Test Model 149");
    });

    test("batching handles updates correctly", async () => {
      // First create 100 models
      const models = Array.from({ length: 100 }, (_, i) => ({
        externalId: `test-provider/update-model-${i}`,
        provider: "anthropic" as const,
        modelId: `update-model-${i}`,
        description: `Original Description ${i}`,
        contextLength: 100000,
        inputModalities: ["text" as const],
        outputModalities: ["text" as const],
        supportsToolCalling: false,
        promptPricePerToken: "0.000001",
        completionPricePerToken: "0.000002",
        lastSyncedAt: new Date(),
      }));

      await ModelModel.bulkUpsert(models);

      // Update all with new descriptions
      const updatedModels = models.map((m, i) => ({
        ...m,
        description: `Updated Description ${i}`,
        contextLength: 200000,
        supportsToolCalling: true,
      }));

      const results = await ModelModel.bulkUpsert(updatedModels);

      expect(results).toHaveLength(100);

      // Verify updates were applied
      const updated = await ModelModel.findByProviderAndModelId(
        "anthropic",
        "update-model-50",
      );
      expect(updated?.description).toBe("Updated Description 50");
      // contextLength and supportsToolCalling are NOT updated on conflict
      // to preserve user-edited values
      expect(updated?.contextLength).toBe(100000);
      expect(updated?.supportsToolCalling).toBe(false);
    });

    test("preserves manual embedding dimension overrides on non-full sync", async () => {
      const [created] = await ModelModel.bulkUpsert([
        {
          externalId: "openai/custom-embed-toggle",
          provider: "openai",
          modelId: "custom-embed-toggle",
          description: "Custom Embed Toggle",
          contextLength: 8192,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalling: false,
          promptPricePerToken: "0.000001",
          completionPricePerToken: "0.000002",
          embeddingDimensions: null,
          lastSyncedAt: new Date(),
        },
      ]);

      await ModelModel.update(created.id, { embeddingDimensions: 1536 });

      await ModelModel.bulkUpsert([
        {
          externalId: "openai/custom-embed-toggle",
          provider: "openai",
          modelId: "custom-embed-toggle",
          description: "Updated Custom Embed Toggle",
          contextLength: 16384,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalling: false,
          promptPricePerToken: "0.000003",
          completionPricePerToken: "0.000004",
          embeddingDimensions: null,
          lastSyncedAt: new Date(),
        },
      ]);

      const updated = await ModelModel.findByProviderAndModelId(
        "openai",
        "custom-embed-toggle",
      );
      expect(updated?.embeddingDimensions).toBe(1536);
    });
  });

  describe("delete", () => {
    test("returns false when model does not exist", async () => {
      const result = await ModelModel.delete("openai", "nonexistent");
      expect(result).toBe(false);
    });

    test("can delete model by provider and model ID", async () => {
      await ModelModel.create({
        externalId: "cohere/command-r",
        provider: "cohere",
        modelId: "command-r",
        description: "Command R",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.0000005",
        completionPricePerToken: "0.0000015",
        lastSyncedAt: new Date(),
      });

      const result = await ModelModel.delete("cohere", "command-r");
      expect(result).toBe(true);

      const model = await ModelModel.findByProviderAndModelId(
        "cohere",
        "command-r",
      );
      expect(model).toBeNull();
    });
  });

  describe("calculateCostSavings", () => {
    test("uses custom pricing when set", async () => {
      const model = await ModelModel.create({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        inputModalities: ["text"],
        outputModalities: ["text"],
        promptPricePerToken: "0.000005",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });
      await ModelModel.update(model.id, {
        customPricePerMillionInput: "20.00",
        customPricePerMillionOutput: "60.00",
      });

      // 1000 tokens saved at $20/M input = 1000 * 20 / 1_000_000 = $0.02
      const savings = await ModelModel.calculateCostSavings(
        "gpt-4o",
        1000,
        "openai",
      );
      expect(savings).toBeCloseTo(0.02);
    });

    test("uses models.dev synced pricing when no custom price", async () => {
      await ModelModel.create({
        externalId: "openai/gpt-4o-mini",
        provider: "openai",
        modelId: "gpt-4o-mini",
        inputModalities: ["text"],
        outputModalities: ["text"],
        promptPricePerToken: "0.000005",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });

      // 1000 tokens saved at $5/M input (0.000005 * 1M) = 1000 * 5 / 1_000_000 = $0.005
      const savings = await ModelModel.calculateCostSavings(
        "gpt-4o-mini",
        1000,
        "openai",
      );
      expect(savings).toBeCloseTo(0.005);
    });

    test("uses default fallback pricing when model not in database", async () => {
      // Model doesn't exist — falls through to default pricing
      const savings = await ModelModel.calculateCostSavings(
        "nonexistent-model",
        1000,
        "openai",
      );
      // Default is $50/M for non-mini models → 1000 * 50 / 1_000_000 = $0.05
      expect(savings).toBeCloseTo(0.05);
    });

    test("returns 0 when tokensSaved is 0", async () => {
      const savings = await ModelModel.calculateCostSavings(
        "gpt-4o",
        0,
        "openai",
      );
      expect(savings).toBe(0);
    });
  });

  describe("ensureModelExists", () => {
    test("creates a new model with discoveredViaLlmProxy=true", async () => {
      await ModelModel.ensureModelExists("gpt-4o-mini", "openai");

      const model = await ModelModel.findByProviderAndModelId(
        "openai",
        "gpt-4o-mini",
      );
      expect(model).not.toBeNull();
      expect(model?.discoveredViaLlmProxy).toBe(true);
      expect(model?.externalId).toBe("openai/gpt-4o-mini");
    });

    test("sets discoveredViaLlmProxy=true on existing model", async () => {
      // Create model via normal sync (discoveredViaLlmProxy defaults to false)
      await ModelModel.create({
        externalId: "anthropic/claude-3-5-sonnet",
        provider: "anthropic",
        modelId: "claude-3-5-sonnet",
        inputModalities: ["text"],
        outputModalities: ["text"],
        lastSyncedAt: new Date(),
      });

      const before = await ModelModel.findByProviderAndModelId(
        "anthropic",
        "claude-3-5-sonnet",
      );
      expect(before?.discoveredViaLlmProxy).toBe(false);

      // LLM Proxy request triggers ensureModelExists
      await ModelModel.ensureModelExists("claude-3-5-sonnet", "anthropic");

      const after = await ModelModel.findByProviderAndModelId(
        "anthropic",
        "claude-3-5-sonnet",
      );
      expect(after?.discoveredViaLlmProxy).toBe(true);
    });
  });

  describe("findLlmProxyModels", () => {
    test("returns only models with discoveredViaLlmProxy=true", async () => {
      // Create a regular synced model
      await ModelModel.create({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        inputModalities: ["text"],
        outputModalities: ["text"],
        lastSyncedAt: new Date(),
      });

      // Create an LLM Proxy-discovered model
      await ModelModel.ensureModelExists("custom-model", "openai");

      const proxyModels = await ModelModel.findLlmProxyModels();
      expect(proxyModels).toHaveLength(1);
      expect(proxyModels[0].modelId).toBe("custom-model");
    });
  });

  describe("deleteOrphanedModels", () => {
    test("deletes models without API key links that are not from LLM Proxy", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();

      // Create a model with no API key link (orphaned, not from proxy)
      await ModelModel.create({
        externalId: "openai/orphan-model",
        provider: "openai",
        modelId: "orphan-model",
        inputModalities: ["text"],
        outputModalities: ["text"],
        lastSyncedAt: new Date(),
      });

      // Create an LLM Proxy-discovered model (no API key link but should be preserved)
      await ModelModel.ensureModelExists("proxy-model", "openai");

      // Create a model WITH an API key link (should be preserved)
      const linkedModel = await ModelModel.create({
        externalId: "openai/linked-model",
        provider: "openai",
        modelId: "linked-model",
        inputModalities: ["text"],
        outputModalities: ["text"],
        lastSyncedAt: new Date(),
      });

      // Create an API key and link the model
      const secret = await makeSecret({ secret: { apiKey: "test-key" } });
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "openai",
      });
      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        apiKey.id,
        [{ id: linkedModel.id, modelId: linkedModel.modelId }],
        "openai",
      );

      const deletedCount = await ModelModel.deleteOrphanedModels();

      // Only the orphan without proxy flag should be deleted
      expect(deletedCount).toBe(1);

      // Verify the proxy model and linked model still exist
      const proxyModel = await ModelModel.findByProviderAndModelId(
        "openai",
        "proxy-model",
      );
      expect(proxyModel).not.toBeNull();

      const linked = await ModelModel.findByProviderAndModelId(
        "openai",
        "linked-model",
      );
      expect(linked).not.toBeNull();

      // Verify the orphan was deleted
      const orphan = await ModelModel.findByProviderAndModelId(
        "openai",
        "orphan-model",
      );
      expect(orphan).toBeNull();
    });
  });

  describe("toCapabilities", () => {
    test("returns null values when model is null", () => {
      const capabilities = ModelModel.toCapabilities(null);

      expect(capabilities.contextLength).toBeNull();
      expect(capabilities.inputModalities).toBeNull();
      expect(capabilities.outputModalities).toBeNull();
      expect(capabilities.supportsToolCalling).toBeNull();
      expect(capabilities.pricePerMillionInput).toBeNull();
      expect(capabilities.pricePerMillionOutput).toBeNull();
    });

    test("converts model to capabilities format", async () => {
      const model = await ModelModel.create({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        description: "GPT-4o",
        contextLength: 128000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000005",
        completionPricePerToken: "0.000015",
        lastSyncedAt: new Date(),
      });

      const capabilities = ModelModel.toCapabilities(model);

      expect(capabilities.contextLength).toBe(128000);
      expect(capabilities.inputModalities).toEqual(["text", "image"]);
      expect(capabilities.outputModalities).toEqual(["text"]);
      expect(capabilities.supportsToolCalling).toBe(true);
      expect(capabilities.pricePerMillionInput).toBe("5.00");
      expect(capabilities.pricePerMillionOutput).toBe("15.00");
    });
  });

  describe("supportsTextChat", () => {
    test("returns false when a model is marked as ignored", async () => {
      const model = await ModelModel.create({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        description: null,
        contextLength: null,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: null,
        completionPricePerToken: null,
        lastSyncedAt: new Date(),
        ignored: true,
      });

      expect(ModelModel.supportsTextChat(model)).toBe(false);
    });

    test("returns true when modalities include text input and output", async () => {
      const model = await ModelModel.create({
        externalId: "gemini/gemini-2.5-flash",
        provider: "gemini",
        modelId: "gemini-2.5-flash",
        description: null,
        contextLength: null,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportsToolCalling: null,
        promptPricePerToken: null,
        completionPricePerToken: null,
        lastSyncedAt: new Date(),
      });

      expect(ModelModel.supportsTextChat(model)).toBe(true);
    });

    test("returns false when input modalities do not include text", async () => {
      const model = await ModelModel.create({
        externalId: "gemini/gemini-live-2.5-flash-native-audio",
        provider: "gemini",
        modelId: "gemini-live-2.5-flash-native-audio",
        description: null,
        contextLength: null,
        inputModalities: ["audio"],
        outputModalities: ["audio"],
        supportsToolCalling: null,
        promptPricePerToken: null,
        completionPricePerToken: null,
        lastSyncedAt: new Date(),
      });

      expect(ModelModel.supportsTextChat(model)).toBe(false);
    });

    test("returns false when output modalities do not include text", async () => {
      const model = await ModelModel.create({
        externalId: "gemini/gemini-2.5-flash-image-preview",
        provider: "gemini",
        modelId: "gemini-2.5-flash-image-preview",
        description: null,
        contextLength: null,
        inputModalities: ["text", "image"],
        outputModalities: ["image"],
        supportsToolCalling: null,
        promptPricePerToken: null,
        completionPricePerToken: null,
        lastSyncedAt: new Date(),
      });

      expect(ModelModel.supportsTextChat(model)).toBe(false);
    });

    test("returns false for embedding models", async () => {
      const model = await ModelModel.create({
        externalId: "gemini/gemini-embedding-001",
        provider: "gemini",
        modelId: "gemini-embedding-001",
        description: null,
        contextLength: null,
        inputModalities: ["text"],
        outputModalities: [],
        supportsToolCalling: false,
        promptPricePerToken: null,
        completionPricePerToken: null,
        lastSyncedAt: new Date(),
      });

      expect(ModelModel.supportsTextChat(model)).toBe(false);
    });

    test("returns true when modalities are unknown", async () => {
      const model = await ModelModel.create({
        externalId: "openai/gpt-4o",
        provider: "openai",
        modelId: "gpt-4o",
        description: null,
        contextLength: null,
        inputModalities: null,
        outputModalities: null,
        supportsToolCalling: null,
        promptPricePerToken: null,
        completionPricePerToken: null,
        lastSyncedAt: new Date(),
      });

      expect(ModelModel.supportsTextChat(model)).toBe(true);
    });
  });

  describe("update", () => {
    test("can update ignored alongside editable model settings", async () => {
      const model = await ModelModel.create({
        externalId: "openai/gpt-4o-mini",
        provider: "openai",
        modelId: "gpt-4o-mini",
        description: null,
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        promptPricePerToken: "0.000001",
        completionPricePerToken: "0.000002",
        lastSyncedAt: new Date(),
      });

      const updated = await ModelModel.update(model.id, {
        ignored: true,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
      });

      expect(updated).not.toBeNull();
      expect(updated?.ignored).toBe(true);
      expect(updated?.inputModalities).toEqual(["text", "image"]);
    });

    test("can update embedding dimensions alongside editable model settings", async () => {
      const model = await ModelModel.create({
        externalId: "openai/text-embedding-3-small",
        provider: "openai",
        modelId: "text-embedding-3-small",
        description: null,
        contextLength: 8192,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: false,
        promptPricePerToken: "0.000001",
        completionPricePerToken: "0.000002",
        embeddingDimensions: null,
        lastSyncedAt: new Date(),
      });

      const updated = await ModelModel.update(model.id, {
        embeddingDimensions: 1536,
        ignored: true,
      });

      expect(updated).not.toBeNull();
      expect(updated?.embeddingDimensions).toBe(1536);
      expect(updated?.ignored).toBe(true);
    });

    test("clears embedding dimensions when a model is no longer used for embeddings", async () => {
      const model = await ModelModel.create({
        externalId: "openai/text-embedding-3-large",
        provider: "openai",
        modelId: "text-embedding-3-large",
        description: null,
        contextLength: 8192,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: false,
        promptPricePerToken: "0.000001",
        completionPricePerToken: "0.000002",
        embeddingDimensions: 1536,
        lastSyncedAt: new Date(),
      });

      const updated = await ModelModel.update(model.id, {
        embeddingDimensions: null,
      });

      expect(updated).not.toBeNull();
      expect(updated?.embeddingDimensions).toBeNull();
    });
  });
});
