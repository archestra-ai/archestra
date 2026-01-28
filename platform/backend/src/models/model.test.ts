import { describe, expect, test } from "@/test";
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
      expect(updated.contextLength).toBe(256000);
      expect(updated.inputModalities).toEqual(["text", "image"]);
      expect(updated.supportsToolCalling).toBe(true);
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
      expect(updated?.contextLength).toBe(200000);
      expect(updated?.supportsToolCalling).toBe(true);
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
});
