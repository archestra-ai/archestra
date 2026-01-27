import { describe, expect, test } from "@/test";
import TokenPriceModel from "./token-price";

describe("TokenPriceModel", () => {
  describe("create", () => {
    test("can create a token price", async () => {
      const tokenPrice = await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      expect(tokenPrice.id).toBeDefined();
      expect(tokenPrice.model).toBe("gpt-4");
      expect(tokenPrice.pricePerMillionInput).toBe("30.00");
      expect(tokenPrice.pricePerMillionOutput).toBe("60.00");
      expect(tokenPrice.createdAt).toBeDefined();
      expect(tokenPrice.updatedAt).toBeDefined();
    });

    test("can create multiple token prices with different models", async () => {
      const tokenPrice1 = await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      const tokenPrice2 = await TokenPriceModel.create({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        pricePerMillionInput: "3.00",
        pricePerMillionOutput: "15.00",
      });

      expect(tokenPrice1.model).toBe("gpt-4");
      expect(tokenPrice2.model).toBe("claude-3-5-sonnet-20241022");
    });
  });

  describe("findAll", () => {
    test("returns empty array when no token prices exist", async () => {
      const tokenPrices = await TokenPriceModel.findAll();
      expect(tokenPrices).toEqual([]);
    });

    test("can retrieve all token prices", async () => {
      await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      await TokenPriceModel.create({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        pricePerMillionInput: "3.00",
        pricePerMillionOutput: "15.00",
      });

      const tokenPrices = await TokenPriceModel.findAll();
      expect(tokenPrices).toHaveLength(2);
    });

    test("returns token prices ordered by createdAt (oldest first)", async () => {
      // Create first token price
      const first = await TokenPriceModel.create({
        provider: "openai",
        model: "model-1",
        pricePerMillionInput: "10.00",
        pricePerMillionOutput: "20.00",
      });

      // Wait a tiny bit to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Create second token price
      const second = await TokenPriceModel.create({
        provider: "openai",
        model: "model-2",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "40.00",
      });

      // Wait a tiny bit to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Create third token price
      const third = await TokenPriceModel.create({
        provider: "openai",
        model: "model-3",
        pricePerMillionInput: "50.00",
        pricePerMillionOutput: "60.00",
      });

      const tokenPrices = await TokenPriceModel.findAll();

      expect(tokenPrices).toHaveLength(3);
      expect(tokenPrices[0].id).toBe(first.id);
      expect(tokenPrices[1].id).toBe(second.id);
      expect(tokenPrices[2].id).toBe(third.id);
    });

    test("maintains order after updating a token price (bug fix test)", async () => {
      // Create three token prices in sequence
      const first = await TokenPriceModel.create({
        provider: "openai",
        model: "model-1",
        pricePerMillionInput: "10.00",
        pricePerMillionOutput: "20.00",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await TokenPriceModel.create({
        provider: "openai",
        model: "model-2",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "40.00",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const third = await TokenPriceModel.create({
        provider: "openai",
        model: "model-3",
        pricePerMillionInput: "50.00",
        pricePerMillionOutput: "60.00",
      });

      // Get initial order
      const beforeUpdate = await TokenPriceModel.findAll();
      expect(beforeUpdate[0].id).toBe(first.id);
      expect(beforeUpdate[1].id).toBe(second.id);
      expect(beforeUpdate[2].id).toBe(third.id);

      // Update the second token price
      await TokenPriceModel.update(second.id, {
        pricePerMillionInput: "35.00",
        pricePerMillionOutput: "45.00",
      });

      // Get order after update - should remain the same
      const afterUpdate = await TokenPriceModel.findAll();
      expect(afterUpdate).toHaveLength(3);
      expect(afterUpdate[0].id).toBe(first.id);
      expect(afterUpdate[1].id).toBe(second.id);
      expect(afterUpdate[2].id).toBe(third.id);

      // Verify the update was applied
      expect(afterUpdate[1].pricePerMillionInput).toBe("35.00");
      expect(afterUpdate[1].pricePerMillionOutput).toBe("45.00");
    });
  });

  describe("findById", () => {
    test("can find a token price by ID", async () => {
      const created = await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      const found = await TokenPriceModel.findById(created.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.model).toBe("gpt-4");
    });

    test("returns null for non-existent token price", async () => {
      const found = await TokenPriceModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(found).toBeNull();
    });
  });

  describe("findByModel", () => {
    test("can find a token price by model name", async () => {
      await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      const found = await TokenPriceModel.findByModel("gpt-4");
      expect(found).toBeDefined();
      expect(found?.model).toBe("gpt-4");
      expect(found?.pricePerMillionInput).toBe("30.00");
    });

    test("returns null for non-existent model", async () => {
      const found = await TokenPriceModel.findByModel("non-existent-model");
      expect(found).toBeNull();
    });
  });

  describe("update", () => {
    test("can update a token price", async () => {
      const tokenPrice = await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      const updated = await TokenPriceModel.update(tokenPrice.id, {
        pricePerMillionInput: "35.00",
        pricePerMillionOutput: "65.00",
      });

      expect(updated).toBeDefined();
      expect(updated?.pricePerMillionInput).toBe("35.00");
      expect(updated?.pricePerMillionOutput).toBe("65.00");
      expect(updated?.model).toBe("gpt-4"); // Model unchanged
    });

    test("updates the updatedAt timestamp", async () => {
      const tokenPrice = await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      const originalUpdatedAt = tokenPrice.updatedAt;

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await TokenPriceModel.update(tokenPrice.id, {
        pricePerMillionInput: "35.00",
      });

      expect(updated?.updatedAt.getTime()).toBeGreaterThan(
        originalUpdatedAt.getTime(),
      );
    });

    test("can partially update a token price", async () => {
      const tokenPrice = await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      const updated = await TokenPriceModel.update(tokenPrice.id, {
        pricePerMillionInput: "35.00",
      });

      expect(updated?.pricePerMillionInput).toBe("35.00");
      expect(updated?.pricePerMillionOutput).toBe("60.00"); // Unchanged
    });

    test("returns null for non-existent token price", async () => {
      const updated = await TokenPriceModel.update(
        "00000000-0000-0000-0000-000000000000",
        {
          pricePerMillionInput: "35.00",
        },
      );
      expect(updated).toBeNull();
    });
  });

  describe("delete", () => {
    test("can delete a token price", async () => {
      const tokenPrice = await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      const deleted = await TokenPriceModel.delete(tokenPrice.id);
      expect(deleted).toBe(true);

      const found = await TokenPriceModel.findById(tokenPrice.id);
      expect(found).toBeNull();
    });

    test("returns false for non-existent token price", async () => {
      const deleted = await TokenPriceModel.delete(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(deleted).toBe(false);
    });
  });

  describe("upsertForModel", () => {
    test("creates a new token price if model doesn't exist", async () => {
      const tokenPrice = await TokenPriceModel.upsertForModel("gpt-4", {
        provider: "openai",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      expect(tokenPrice.model).toBe("gpt-4");
      expect(tokenPrice.pricePerMillionInput).toBe("30.00");
      expect(tokenPrice.pricePerMillionOutput).toBe("60.00");

      // Verify it was created
      const found = await TokenPriceModel.findByModel("gpt-4");
      expect(found).toBeDefined();
    });

    test("updates existing token price if model already exists", async () => {
      // Create initial token price
      const initial = await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      // Upsert with new prices
      const upserted = await TokenPriceModel.upsertForModel("gpt-4", {
        provider: "openai",
        pricePerMillionInput: "35.00",
        pricePerMillionOutput: "65.00",
      });

      expect(upserted.id).toBe(initial.id); // Same ID
      expect(upserted.pricePerMillionInput).toBe("35.00");
      expect(upserted.pricePerMillionOutput).toBe("65.00");

      // Verify only one record exists
      const allPrices = await TokenPriceModel.findAll();
      const gpt4Prices = allPrices.filter((p) => p.model === "gpt-4");
      expect(gpt4Prices).toHaveLength(1);
    });

    test("updates the updatedAt timestamp on upsert", async () => {
      const initial = await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const upserted = await TokenPriceModel.upsertForModel("gpt-4", {
        provider: "openai",
        pricePerMillionInput: "35.00",
        pricePerMillionOutput: "65.00",
      });

      expect(upserted.updatedAt.getTime()).toBeGreaterThan(
        initial.updatedAt.getTime(),
      );
    });
  });

  describe("bulkCreateIfNotExists", () => {
    test("creates multiple token prices in a single operation", async () => {
      const tokenPrices = [
        {
          model: "model-1",
          provider: "openai" as const,
          pricePerMillionInput: "10.00",
          pricePerMillionOutput: "20.00",
        },
        {
          model: "model-2",
          provider: "anthropic" as const,
          pricePerMillionInput: "15.00",
          pricePerMillionOutput: "30.00",
        },
        {
          model: "model-3",
          provider: "gemini" as const,
          pricePerMillionInput: "5.00",
          pricePerMillionOutput: "10.00",
        },
      ];

      const createdCount =
        await TokenPriceModel.bulkCreateIfNotExists(tokenPrices);

      expect(createdCount).toBe(3);

      const allPrices = await TokenPriceModel.findAll();
      expect(allPrices).toHaveLength(3);

      const model1 = await TokenPriceModel.findByModel("model-1");
      expect(model1?.pricePerMillionInput).toBe("10.00");

      const model2 = await TokenPriceModel.findByModel("model-2");
      expect(model2?.pricePerMillionInput).toBe("15.00");

      const model3 = await TokenPriceModel.findByModel("model-3");
      expect(model3?.pricePerMillionInput).toBe("5.00");
    });

    test("skips existing models without overwriting", async () => {
      // Create an existing price
      await TokenPriceModel.create({
        model: "existing-model",
        provider: "openai",
        pricePerMillionInput: "100.00",
        pricePerMillionOutput: "200.00",
      });

      const tokenPrices = [
        {
          model: "existing-model",
          provider: "openai" as const,
          pricePerMillionInput: "10.00",
          pricePerMillionOutput: "20.00",
        },
        {
          model: "new-model",
          provider: "anthropic" as const,
          pricePerMillionInput: "15.00",
          pricePerMillionOutput: "30.00",
        },
      ];

      const createdCount =
        await TokenPriceModel.bulkCreateIfNotExists(tokenPrices);

      // Only the new model should be created
      expect(createdCount).toBe(1);

      // Existing model should keep original prices
      const existingModel = await TokenPriceModel.findByModel("existing-model");
      expect(existingModel?.pricePerMillionInput).toBe("100.00");
      expect(existingModel?.pricePerMillionOutput).toBe("200.00");

      // New model should have new prices
      const newModel = await TokenPriceModel.findByModel("new-model");
      expect(newModel?.pricePerMillionInput).toBe("15.00");
      expect(newModel?.pricePerMillionOutput).toBe("30.00");
    });

    test("returns 0 when given empty array", async () => {
      const createdCount = await TokenPriceModel.bulkCreateIfNotExists([]);

      expect(createdCount).toBe(0);

      const allPrices = await TokenPriceModel.findAll();
      expect(allPrices).toHaveLength(0);
    });

    test("returns 0 when all models already exist", async () => {
      // Create existing prices
      await TokenPriceModel.create({
        model: "model-1",
        provider: "openai",
        pricePerMillionInput: "50.00",
        pricePerMillionOutput: "100.00",
      });
      await TokenPriceModel.create({
        model: "model-2",
        provider: "anthropic",
        pricePerMillionInput: "60.00",
        pricePerMillionOutput: "120.00",
      });

      const tokenPrices = [
        {
          model: "model-1",
          provider: "openai" as const,
          pricePerMillionInput: "10.00",
          pricePerMillionOutput: "20.00",
        },
        {
          model: "model-2",
          provider: "anthropic" as const,
          pricePerMillionInput: "15.00",
          pricePerMillionOutput: "30.00",
        },
      ];

      const createdCount =
        await TokenPriceModel.bulkCreateIfNotExists(tokenPrices);

      expect(createdCount).toBe(0);

      // Verify prices were not changed
      const model1 = await TokenPriceModel.findByModel("model-1");
      expect(model1?.pricePerMillionInput).toBe("50.00");

      const model2 = await TokenPriceModel.findByModel("model-2");
      expect(model2?.pricePerMillionInput).toBe("60.00");
    });

    test("is idempotent when called concurrently", async () => {
      const tokenPrices = [
        {
          model: "concurrent-model",
          provider: "openai" as const,
          pricePerMillionInput: "10.00",
          pricePerMillionOutput: "20.00",
        },
      ];

      // Call concurrently - one should succeed, one should return 0
      const [count1, count2] = await Promise.all([
        TokenPriceModel.bulkCreateIfNotExists(tokenPrices),
        TokenPriceModel.bulkCreateIfNotExists(tokenPrices),
      ]);

      // Total created should be 1 (one succeeds, one finds conflict)
      expect(count1 + count2).toBe(1);

      // Verify only one record exists
      const allPrices = await TokenPriceModel.findAll();
      const matches = allPrices.filter((p) => p.model === "concurrent-model");
      expect(matches).toHaveLength(1);
    });
  });

  describe("getAllModelsFromInteractions", () => {
    test("returns empty array when no interactions exist", async () => {
      const models = await TokenPriceModel.getAllModelsFromInteractions();
      expect(models).toEqual([]);
    });

    test("returns unique models from interactions", async ({
      makeAgent,
      makeInteraction,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      await makeInteraction(agent.id, {
        model: "gpt-4",
        inputTokens: 100,
        outputTokens: 200,
      });

      await makeInteraction(agent.id, {
        type: "anthropic:messages",
        model: "claude-3-5-sonnet-20241022",
        inputTokens: 150,
        outputTokens: 250,
      });

      // Create duplicate model interaction
      await makeInteraction(agent.id, {
        model: "gpt-4",
        inputTokens: 50,
        outputTokens: 75,
      });

      const models = await TokenPriceModel.getAllModelsFromInteractions();

      expect(models).toHaveLength(2);
      expect(models.map((m) => m.model)).toContain("gpt-4");
      expect(models.map((m) => m.model)).toContain(
        "claude-3-5-sonnet-20241022",
      );
      expect(models.find((m) => m.model === "gpt-4")?.provider).toBe("openai");
      expect(
        models.find((m) => m.model === "claude-3-5-sonnet-20241022")?.provider,
      ).toBe("anthropic");
    });

    test("filters out null models", async ({ makeAgent, makeInteraction }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      await makeInteraction(agent.id, {
        model: "gpt-4",
        inputTokens: 100,
        outputTokens: 200,
      });

      await makeInteraction(agent.id, {
        model: null,
        inputTokens: 150,
        outputTokens: 250,
      });

      const models = await TokenPriceModel.getAllModelsFromInteractions();

      expect(models).toHaveLength(1);
      expect(models.map((m) => m.model)).toContain("gpt-4");
      expect(models[0].provider).toBe("openai");
    });
  });

  describe("ensureAllModelsHavePricing", () => {
    test("creates default pricing for models without pricing", async ({
      makeAgent,
      makeInteraction,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      // Create interactions with models that don't have pricing
      await makeInteraction(agent.id, {
        model: "new-model-1",
        inputTokens: 100,
        outputTokens: 200,
      });

      await makeInteraction(agent.id, {
        model: "new-model-2",
        inputTokens: 150,
        outputTokens: 250,
      });

      await TokenPriceModel.ensureAllModelsHavePricing();

      // Verify pricing was created with default values
      const model1Price = await TokenPriceModel.findByModel("new-model-1");
      expect(model1Price).toBeDefined();
      expect(model1Price?.pricePerMillionInput).toBe("50.00");
      expect(model1Price?.pricePerMillionOutput).toBe("50.00");

      const model2Price = await TokenPriceModel.findByModel("new-model-2");
      expect(model2Price).toBeDefined();
      expect(model2Price?.pricePerMillionInput).toBe("50.00");
      expect(model2Price?.pricePerMillionOutput).toBe("50.00");
    });

    test("does not create pricing for models that already have pricing", async ({
      makeAgent,
      makeInteraction,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      // Create a model with existing pricing
      await TokenPriceModel.create({
        provider: "openai",
        model: "existing-model",
        pricePerMillionInput: "10.00",
        pricePerMillionOutput: "20.00",
      });

      // Create interaction with the existing model
      await makeInteraction(agent.id, {
        model: "existing-model",
        inputTokens: 100,
        outputTokens: 200,
      });

      await TokenPriceModel.ensureAllModelsHavePricing();

      // Verify pricing was not changed
      const modelPrice = await TokenPriceModel.findByModel("existing-model");
      expect(modelPrice?.pricePerMillionInput).toBe("10.00");
      expect(modelPrice?.pricePerMillionOutput).toBe("20.00");

      // Verify only one pricing record exists for this model
      const allPrices = await TokenPriceModel.findAll();
      const existingModelPrices = allPrices.filter(
        (p) => p.model === "existing-model",
      );
      expect(existingModelPrices).toHaveLength(1);
    });

    test("handles mixed scenario with some models having pricing and some not", async ({
      makeAgent,
      makeInteraction,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      // Create pricing for one model
      await TokenPriceModel.create({
        provider: "openai",
        model: "model-with-pricing",
        pricePerMillionInput: "15.00",
        pricePerMillionOutput: "25.00",
      });

      // Create interactions with both models
      await makeInteraction(agent.id, {
        model: "model-with-pricing",
        inputTokens: 100,
        outputTokens: 200,
      });

      await makeInteraction(agent.id, {
        model: "model-without-pricing",
        inputTokens: 150,
        outputTokens: 250,
      });

      await TokenPriceModel.ensureAllModelsHavePricing();

      // Verify existing pricing was not changed
      const withPricing =
        await TokenPriceModel.findByModel("model-with-pricing");
      expect(withPricing?.pricePerMillionInput).toBe("15.00");
      expect(withPricing?.pricePerMillionOutput).toBe("25.00");

      // Verify default pricing was created for the new model
      const withoutPricing = await TokenPriceModel.findByModel(
        "model-without-pricing",
      );
      expect(withoutPricing?.pricePerMillionInput).toBe("50.00");
      expect(withoutPricing?.pricePerMillionOutput).toBe("50.00");
    });

    test("does nothing when all models have pricing", async ({
      makeAgent,
      makeInteraction,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      // Create pricing for a model
      await TokenPriceModel.create({
        provider: "openai",
        model: "gpt-4",
        pricePerMillionInput: "30.00",
        pricePerMillionOutput: "60.00",
      });

      // Create interaction with the model
      await makeInteraction(agent.id, {
        model: "gpt-4",
        inputTokens: 100,
        outputTokens: 200,
      });

      const beforeCount = (await TokenPriceModel.findAll()).length;
      await TokenPriceModel.ensureAllModelsHavePricing();
      const afterCount = (await TokenPriceModel.findAll()).length;

      expect(afterCount).toBe(beforeCount);
    });

    test("is idempotent even when called concurrently", async ({
      makeAgent,
      makeInteraction,
    }) => {
      const agent = await makeAgent({ name: "Concurrency Agent" });

      await makeInteraction(agent.id, {
        model: "gpt-concurrent",
        inputTokens: 80,
        outputTokens: 120,
      });

      await Promise.all([
        TokenPriceModel.ensureAllModelsHavePricing(),
        TokenPriceModel.ensureAllModelsHavePricing(),
      ]);

      const prices = await TokenPriceModel.findAll();
      const matches = prices.filter(
        (price) => price.model === "gpt-concurrent",
      );
      expect(matches).toHaveLength(1);
    });
  });
});
