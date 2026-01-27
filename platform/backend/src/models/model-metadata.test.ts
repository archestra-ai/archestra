import { describe, expect, test } from "@/test";
import ModelMetadataModel from "./model-metadata";

describe("ModelMetadataModel", () => {
  describe("create", () => {
    test("can create model metadata", async () => {
      const metadata = await ModelMetadataModel.create({
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

      expect(metadata.id).toBeDefined();
      expect(metadata.externalId).toBe("openai/gpt-4o");
      expect(metadata.provider).toBe("openai");
      expect(metadata.modelId).toBe("gpt-4o");
      expect(metadata.description).toBe("GPT-4o is a multimodal model");
      expect(metadata.contextLength).toBe(128000);
      expect(metadata.inputModalities).toEqual(["text", "image"]);
      expect(metadata.outputModalities).toEqual(["text"]);
      expect(metadata.supportsToolCalling).toBe(true);
      expect(metadata.promptPricePerToken).toBe("0.000005000000");
      expect(metadata.completionPricePerToken).toBe("0.000015000000");
    });
  });

  describe("findByProviderAndModelId", () => {
    test("returns null when metadata does not exist", async () => {
      const metadata = await ModelMetadataModel.findByProviderAndModelId(
        "openai",
        "nonexistent-model",
      );
      expect(metadata).toBeNull();
    });

    test("can find metadata by provider and model ID", async () => {
      await ModelMetadataModel.create({
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

      const metadata = await ModelMetadataModel.findByProviderAndModelId(
        "anthropic",
        "claude-3-5-sonnet",
      );

      expect(metadata).not.toBeNull();
      expect(metadata?.provider).toBe("anthropic");
      expect(metadata?.modelId).toBe("claude-3-5-sonnet");
    });
  });

  describe("findByProviderModelIds", () => {
    test("returns empty map when no keys provided", async () => {
      const map = await ModelMetadataModel.findByProviderModelIds([]);
      expect(map.size).toBe(0);
    });

    test("returns metadata for matching keys", async () => {
      await ModelMetadataModel.create({
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

      await ModelMetadataModel.create({
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

      const map = await ModelMetadataModel.findByProviderModelIds([
        { provider: "openai", modelId: "gpt-4o" },
        { provider: "anthropic", modelId: "claude-3-opus" },
        { provider: "openai", modelId: "nonexistent" },
      ]);

      expect(map.size).toBe(2);
      expect(map.get("openai:gpt-4o")?.modelId).toBe("gpt-4o");
      expect(map.get("anthropic:claude-3-opus")?.modelId).toBe("claude-3-opus");
      expect(map.get("openai:nonexistent")).toBeUndefined();
    });
  });

  describe("upsert", () => {
    test("creates new metadata if it does not exist", async () => {
      const metadata = await ModelMetadataModel.upsert({
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

      expect(metadata.id).toBeDefined();
      expect(metadata.modelId).toBe("gpt-4-turbo");
    });

    test("updates existing metadata on conflict", async () => {
      // Create initial metadata
      const initial = await ModelMetadataModel.create({
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
      const updated = await ModelMetadataModel.upsert({
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
      const results = await ModelMetadataModel.bulkUpsert([]);
      expect(results).toEqual([]);
    });

    test("can bulk upsert multiple records", async () => {
      const results = await ModelMetadataModel.bulkUpsert([
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
      const all = await ModelMetadataModel.findAll();
      expect(all).toHaveLength(2);
    });
  });

  describe("delete", () => {
    test("returns false when metadata does not exist", async () => {
      const result = await ModelMetadataModel.delete("openai", "nonexistent");
      expect(result).toBe(false);
    });

    test("can delete metadata by provider and model ID", async () => {
      await ModelMetadataModel.create({
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

      const result = await ModelMetadataModel.delete("cohere", "command-r");
      expect(result).toBe(true);

      const metadata = await ModelMetadataModel.findByProviderAndModelId(
        "cohere",
        "command-r",
      );
      expect(metadata).toBeNull();
    });
  });

  describe("toCapabilities", () => {
    test("returns null values when metadata is null", () => {
      const capabilities = ModelMetadataModel.toCapabilities(null);

      expect(capabilities.contextLength).toBeNull();
      expect(capabilities.inputModalities).toBeNull();
      expect(capabilities.outputModalities).toBeNull();
      expect(capabilities.supportsToolCalling).toBeNull();
      expect(capabilities.pricePerMillionInput).toBeNull();
      expect(capabilities.pricePerMillionOutput).toBeNull();
    });

    test("converts metadata to capabilities format", async () => {
      const metadata = await ModelMetadataModel.create({
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

      const capabilities = ModelMetadataModel.toCapabilities(metadata);

      expect(capabilities.contextLength).toBe(128000);
      expect(capabilities.inputModalities).toEqual(["text", "image"]);
      expect(capabilities.outputModalities).toEqual(["text"]);
      expect(capabilities.supportsToolCalling).toBe(true);
      expect(capabilities.pricePerMillionInput).toBe("5.00");
      expect(capabilities.pricePerMillionOutput).toBe("15.00");
    });
  });
});
