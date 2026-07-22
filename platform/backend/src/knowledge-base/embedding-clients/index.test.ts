import { HttpResponse, http } from "msw";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  UnsupportedEmbeddingProviderError,
  UnusableEmbeddingResponseError,
} from "../errors";
import {
  AzureEmbeddingError,
  BedrockEmbeddingError,
  callEmbedding,
  GeminiEmbeddingError,
  getEmbeddingRetryDelayMs,
  isRetryableEmbeddingError,
  OpenAIEmbeddingError,
} from "./index";

// openai@6 requests base64 embeddings by default and decodes them client-side,
// so the wire payload must carry Float32Array bytes, not a JSON number array.
function encodeEmbedding(values: number[]): string {
  const floats = new Float32Array(values);
  return Buffer.from(
    floats.buffer,
    floats.byteOffset,
    floats.byteLength,
  ).toString("base64");
}

describe("callEmbedding dimensions handling", () => {
  const BASE_URL = "https://embed.example.com/v1";
  const captured: Array<{ dimensions?: number }> = [];
  // The dispatcher validates each vector's length against the configured
  // dimension, so the mock must return a correctly-sized vector.
  let mockEmbeddingLength = 2;
  useMswServer(
    http.post(`${BASE_URL}/embeddings`, async ({ request }) => {
      const body = (await request.json()) as { dimensions?: number };
      captured.push({ dimensions: body.dimensions });
      return HttpResponse.json({
        object: "list",
        data: [
          {
            object: "embedding",
            embedding: encodeEmbedding(
              new Array(mockEmbeddingLength).fill(0.1),
            ),
            index: 0,
          },
        ],
        model: "m",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }),
  );

  test("drops the dimensions param for Ollama (fixed native dimension)", async () => {
    captured.length = 0;
    mockEmbeddingLength = 1024;
    await callEmbedding({
      inputs: ["hello"],
      model: "mxbai-embed-large",
      apiKey: "k",
      baseUrl: BASE_URL,
      dimensions: 1024,
      provider: "ollama",
    });
    expect(captured[0].dimensions).toBeUndefined();
  });

  test("forwards the dimensions param for OpenAI (Matryoshka truncation)", async () => {
    captured.length = 0;
    mockEmbeddingLength = 1536;
    await callEmbedding({
      inputs: ["hello"],
      model: "text-embedding-3-small",
      apiKey: "k",
      baseUrl: BASE_URL,
      dimensions: 1536,
      provider: "openai",
    });
    expect(captured[0].dimensions).toBe(1536);
  });
});

describe("callEmbedding response validation", () => {
  const BASE_URL = "https://embed-validate.example.com/v1";
  let responseBody: Record<string, unknown>;
  useMswServer(
    http.post(`${BASE_URL}/embeddings`, () => HttpResponse.json(responseBody)),
  );

  const call = (params?: { dimensions?: number; inputs?: string[] }) =>
    callEmbedding({
      inputs: params?.inputs ?? ["hi"],
      model: "text-embedding-3-small",
      apiKey: "k",
      baseUrl: BASE_URL,
      dimensions: params?.dimensions,
      provider: "openai",
    });

  const embeddingItem = (values: number[], index = 0) => ({
    object: "embedding",
    embedding: encodeEmbedding(values),
    index,
  });

  test("throws when the response has no embeddings array (the historic crash)", async () => {
    responseBody = {
      object: "list",
      model: "m",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    };
    await expect(call()).rejects.toBeInstanceOf(UnusableEmbeddingResponseError);
  });

  test("throws when the embedding count does not match the inputs", async () => {
    responseBody = {
      object: "list",
      data: [embeddingItem([0.1, 0.2])],
      model: "m",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    };
    await expect(call({ inputs: ["a", "b"] })).rejects.toBeInstanceOf(
      UnusableEmbeddingResponseError,
    );
  });

  test("throws when a vector's length differs from the configured dimension", async () => {
    responseBody = {
      object: "list",
      data: [embeddingItem([0.1, 0.2])],
      model: "m",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    };
    await expect(call({ dimensions: 1536 })).rejects.toBeInstanceOf(
      UnusableEmbeddingResponseError,
    );
  });
});

describe("callEmbedding provider gating", () => {
  // Providers with no embedding path must be rejected, never sent to the
  // OpenAI-compatible client where they crash on a non-OpenAI response.
  test.each([
    "anthropic",
    "archestra",
    "cohere",
    "cerebras",
    "deepseek",
    "groq",
    "perplexity",
    "xai",
    "minimax",
    "github-copilot",
    "microsoft-365-copilot",
  ] as const)("rejects %s with UnsupportedEmbeddingProviderError", async (provider) => {
    await expect(
      callEmbedding({
        inputs: ["hi"],
        model: "some-model",
        apiKey: "k",
        provider,
      }),
    ).rejects.toBeInstanceOf(UnsupportedEmbeddingProviderError);
  });
});

describe("isRetryableEmbeddingError", () => {
  test("returns true for retryable provider status codes", () => {
    expect(
      isRetryableEmbeddingError(new AzureEmbeddingError(429, "rate")),
    ).toBe(true);
    expect(
      isRetryableEmbeddingError(new GeminiEmbeddingError(429, "rate")),
    ).toBe(true);
    expect(
      isRetryableEmbeddingError(new OpenAIEmbeddingError(503, "server")),
    ).toBe(true);
    expect(
      isRetryableEmbeddingError(new BedrockEmbeddingError(503, "server")),
    ).toBe(true);
  });

  test("returns false for non-retryable provider status codes", () => {
    expect(isRetryableEmbeddingError(new AzureEmbeddingError(400, "bad"))).toBe(
      false,
    );
    expect(
      isRetryableEmbeddingError(new GeminiEmbeddingError(400, "bad")),
    ).toBe(false);
    expect(
      isRetryableEmbeddingError(new OpenAIEmbeddingError(404, "missing")),
    ).toBe(false);
    expect(
      isRetryableEmbeddingError(new BedrockEmbeddingError(400, "bad")),
    ).toBe(false);
  });

  test("returns true only for known retryable network error codes", () => {
    const timeout = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const reset = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const invalidArg = Object.assign(new Error("invalid"), {
      code: "ERR_INVALID_ARG_TYPE",
    });

    expect(isRetryableEmbeddingError(timeout)).toBe(true);
    expect(isRetryableEmbeddingError(reset)).toBe(true);
    expect(isRetryableEmbeddingError(invalidArg)).toBe(false);
  });
});

describe("getEmbeddingRetryDelayMs", () => {
  test("honors Azure retry-after delays", () => {
    expect(
      getEmbeddingRetryDelayMs(
        new AzureEmbeddingError(429, "rate limited", 60_000),
        1_000,
      ),
    ).toBe(60_000);
  });

  test("falls back when provider error has no retry-after delay", () => {
    expect(
      getEmbeddingRetryDelayMs(new OpenAIEmbeddingError(429, "rate"), 2_000),
    ).toBe(2_000);
  });
});
