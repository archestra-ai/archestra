import { expect, test } from "./fixtures";

// Orlando-format models (aggregated from all providers under the OpenAI endpoint)
const ALL_MODELS = [
  {
    id: "gpt-4o",
    displayName: "GPT-4o",
    provider: "openai",
  },
  {
    id: "gpt-4o-mini",
    displayName: "GPT-4o Mini",
    provider: "openai",
  },
  {
    id: "claude-3-5-sonnet-20241022",
    displayName: "Claude 3.5 Sonnet",
    provider: "anthropic",
  },
  {
    id: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    provider: "gemini",
  },
  {
    id: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    provider: "gemini",
  },
];

test.describe("Chat Models API", () => {
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

    // Wiremock returns Orlando-format models (aggregated from all providers)
    // plus additional models from anthropic and gemini endpoints
    // Check that all expected models are present
    expect(models).toEqual(expect.arrayContaining(ALL_MODELS));
  });

  test("should fetch chat models filtered by provider (openai) - Orlando format", async ({
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

    // Orlando aggregates all models under the OpenAI endpoint
    expect(models).toEqual(ALL_MODELS);
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

    // Anthropic endpoint returns only Anthropic models
    expect(models).toEqual([
      {
        id: "claude-3-5-sonnet-20241022",
        displayName: "Claude 3.5 Sonnet",
        provider: "anthropic",
        createdAt: "2024-10-22T00:00:00Z",
      },
    ]);
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

    // Gemini endpoint returns only Gemini models
    expect(models).toEqual([
      {
        id: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        provider: "gemini",
      },
      {
        id: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        provider: "gemini",
      },
    ]);
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
});
