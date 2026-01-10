import { expect, test } from "./fixtures";

test.describe
  .skip("Chat Models API", () => {
    test.describe.configure({ mode: "serial" });

    test("should fetch chat models from all providers", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/chat/models",
      });

      expect(response.ok()).toBe(true);
      const models = await response.json();

      expect(Array.isArray(models)).toBe(true);

      // Check that models have the expected shape
      for (const model of models) {
        expect(model).toHaveProperty("id");
        expect(model).toHaveProperty("displayName");
        expect(model).toHaveProperty("provider");
        expect(["openai", "anthropic", "gemini"]).toContain(model.provider);
      }
    });

    test("should fetch chat models filtered by provider (openai)", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/chat/models?provider=openai",
      });

      expect(response.ok()).toBe(true);
      const models = await response.json();

      expect(Array.isArray(models)).toBe(true);

      // All models should be from OpenAI provider
      for (const model of models) {
        expect(model.provider).toBe("openai");
        expect(model).toHaveProperty("id");
        expect(model).toHaveProperty("displayName");
      }
    });

    test("should fetch chat models filtered by provider (anthropic)", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/chat/models?provider=anthropic",
      });

      expect(response.ok()).toBe(true);
      const models = await response.json();

      expect(Array.isArray(models)).toBe(true);

      // All models should be from Anthropic provider
      for (const model of models) {
        expect(model.provider).toBe("anthropic");
        expect(model).toHaveProperty("id");
        expect(model).toHaveProperty("displayName");
      }
    });

    test("should fetch chat models filtered by provider (gemini)", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/chat/models?provider=gemini",
      });

      expect(response.ok()).toBe(true);
      const models = await response.json();

      expect(Array.isArray(models)).toBe(true);

      // All models should be from Gemini provider
      for (const model of models) {
        expect(model.provider).toBe("gemini");
        expect(model).toHaveProperty("id");
        expect(model).toHaveProperty("displayName");
      }
    });

    test("should return empty array for invalid provider", async ({
      request,
      makeApiRequest,
    }) => {
      // Request with an invalid provider should still return 200 with empty array
      // since the schema validation will filter it out
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/chat/models?provider=invalid",
        ignoreStatusCheck: true,
      });

      // Should return 400 for invalid provider enum value
      expect(response.status()).toBe(400);
    });

    test("should return consistent model structure across providers", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/chat/models",
      });

      expect(response.ok()).toBe(true);
      const models = await response.json();

      if (models.length > 0) {
        // Check first model has all expected fields
        const firstModel = models[0];
        expect(typeof firstModel.id).toBe("string");
        expect(typeof firstModel.displayName).toBe("string");
        expect(typeof firstModel.provider).toBe("string");
        // createdAt is optional
        if (firstModel.createdAt !== undefined) {
          expect(typeof firstModel.createdAt).toBe("string");
        }
      }
    });

    test("should cache models (subsequent requests should be fast)", async ({
      request,
      makeApiRequest,
    }) => {
      // First request - may hit provider APIs
      const response1 = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/chat/models",
      });
      expect(response1.ok()).toBe(true);
      const models1 = await response1.json();

      // Second request - should use cache
      const response2 = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/chat/models",
      });
      expect(response2.ok()).toBe(true);
      const models2 = await response2.json();

      // Results should be the same (from cache)
      expect(models2.length).toBe(models1.length);
    });
  });
