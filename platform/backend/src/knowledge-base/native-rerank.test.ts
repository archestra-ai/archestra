import { HttpResponse, http } from "msw";
import { describe, expect, it, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { callNativeRerank, isNativeRerankModel } from "./native-rerank";

let server: ReturnType<typeof useMswServer>;

describe("isNativeRerankModel", () => {
  test("matches Cohere rerank models on the cohere provider", () => {
    expect(
      isNativeRerankModel({ provider: "cohere", model: "rerank-v3.5" }),
    ).toBe(true);
    expect(
      isNativeRerankModel({ provider: "cohere", model: "rerank-english-v3.0" }),
    ).toBe(true);
    expect(
      isNativeRerankModel({ provider: "cohere", model: "command-r-plus" }),
    ).toBe(false);
  });

  test("matches Azure-hosted Cohere rerank deployments", () => {
    expect(
      isNativeRerankModel({
        provider: "azure",
        model: "Cohere-rerank-v4.0-fast",
      }),
    ).toBe(true);
    expect(isNativeRerankModel({ provider: "azure", model: "gpt-4.1" })).toBe(
      false,
    );
  });

  test("never matches providers without a native rerank surface", () => {
    // A rerank-named model on e.g. OpenAI has no native route to call; it must
    // stay on the chat path (and fail verification with the explanatory hint).
    expect(
      isNativeRerankModel({ provider: "openai", model: "my-rerank-model" }),
    ).toBe(false);
    expect(
      isNativeRerankModel({
        provider: "bedrock",
        model: "cohere.rerank-v3-5:0",
      }),
    ).toBe(false);
  });
});

describe("callNativeRerank", () => {
  server = useMswServer();

  it("calls the Azure rerank route derived from the key's base URL origin", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let apiKeyHeader: string | null = null;
    server.use(
      http.post(
        "https://my-resource.cognitiveservices.azure.com/providers/cohere/v2/rerank",
        async ({ request }) => {
          apiKeyHeader = request.headers.get("api-key");
          requestBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            id: "rerank-test",
            results: [
              { index: 1, relevance_score: 0.9 },
              { index: 0, relevance_score: 0.2 },
            ],
          });
        },
      ),
    );

    const scores = await callNativeRerank({
      provider: "azure",
      apiKey: "azure-key",
      // The stored base URL keeps its inference path; only the origin matters.
      baseUrl: "https://my-resource.cognitiveservices.azure.com/openai/v1",
      model: "Cohere-rerank-v4.0-fast",
      query: "capital of France",
      documents: ["Berlin doc", "Paris doc"],
    });

    expect(apiKeyHeader).toBe("azure-key");
    expect(requestBody).toEqual({
      model: "Cohere-rerank-v4.0-fast",
      query: "capital of France",
      documents: ["Berlin doc", "Paris doc"],
    });
    expect(scores).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.2 },
    ]);
  });

  it("strips a Bearer prefix from the Azure api-key", async () => {
    let apiKeyHeader: string | null = null;
    server.use(
      http.post(
        "https://my-resource.services.ai.azure.com/providers/cohere/v2/rerank",
        ({ request }) => {
          apiKeyHeader = request.headers.get("api-key");
          return HttpResponse.json({ results: [] });
        },
      ),
    );

    await callNativeRerank({
      provider: "azure",
      apiKey: "Bearer azure-key",
      baseUrl: "https://my-resource.services.ai.azure.com/models",
      model: "Cohere-rerank-v4.0-fast",
      query: "q",
      documents: ["d"],
    });

    expect(apiKeyHeader).toBe("azure-key");
  });

  it("calls the Cohere v2 rerank route with bearer auth", async () => {
    let authHeader: string | null = null;
    server.use(
      http.post("https://api.cohere.ai/v2/rerank", ({ request }) => {
        authHeader = request.headers.get("authorization");
        return HttpResponse.json({
          results: [{ index: 0, relevance_score: 0.7 }],
        });
      }),
    );

    const scores = await callNativeRerank({
      provider: "cohere",
      apiKey: "cohere-key",
      // The configured default carries a version segment in some setups; the
      // rerank route lives at /v2/rerank on the API root.
      baseUrl: "https://api.cohere.ai/v1",
      model: "rerank-v3.5",
      query: "q",
      documents: ["d"],
    });

    expect(authHeader).toBe("Bearer cohere-key");
    expect(scores).toEqual([{ index: 0, score: 0.7 }]);
  });

  it("surfaces the provider's error message on failure", async () => {
    server.use(
      http.post(
        "https://my-resource.cognitiveservices.azure.com/providers/cohere/v2/rerank",
        () =>
          HttpResponse.json(
            { error: { message: "invalid model" } },
            { status: 400 },
          ),
      ),
    );

    await expect(
      callNativeRerank({
        provider: "azure",
        apiKey: "azure-key",
        baseUrl: "https://my-resource.cognitiveservices.azure.com/openai/v1",
        model: "Cohere-rerank-v4.0-fast",
        query: "q",
        documents: ["d"],
      }),
    ).rejects.toThrow("invalid model");
  });

  it("rejects a response without a results array", async () => {
    server.use(
      http.post("https://api.cohere.ai/v2/rerank", () =>
        HttpResponse.json({ message: "ok but wrong shape" }),
      ),
    );

    await expect(
      callNativeRerank({
        provider: "cohere",
        apiKey: "cohere-key",
        baseUrl: "https://api.cohere.ai",
        model: "rerank-v3.5",
        query: "q",
        documents: ["d"],
      }),
    ).rejects.toThrow("no results array");
  });

  it("requires an API key for Azure when Entra ID is not enabled", async () => {
    await expect(
      callNativeRerank({
        provider: "azure",
        apiKey: null,
        baseUrl: "https://my-resource.cognitiveservices.azure.com/openai/v1",
        model: "Cohere-rerank-v4.0-fast",
        query: "q",
        documents: ["d"],
      }),
    ).rejects.toThrow("API key is required");
  });
});
