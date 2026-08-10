import { HttpResponse, http } from "msw";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { countTokens, getEncoding } from "../tokenizer";
import { BedrockEmbeddingError, callBedrockEmbedding } from "./bedrock";

const BEDROCK_HOST = "https://bedrock-runtime.us-east-1.amazonaws.com";

describe("callBedrockEmbedding", () => {
  // Capture the InvokeModel requests the AI SDK issues (one per input for Titan).
  const captured: Array<{
    modelId: string;
    body: Record<string, unknown>;
    authorization: string | null;
  }> = [];

  const server = useMswServer(
    http.post(
      `${BEDROCK_HOST}/model/:modelId/invoke`,
      async ({ params, request }) => {
        captured.push({
          modelId: String(params.modelId),
          body: (await request.json()) as Record<string, unknown>,
          authorization: request.headers.get("authorization"),
        });
        return HttpResponse.json({
          embedding: [0.1, 0.2, 0.3],
          inputTextTokenCount: 3,
        });
      },
    ),
  );

  test("attempts the embed for any model — no client-side allowlist", async () => {
    captured.length = 0;
    // A non-Titan model is no longer pre-screened; the client calls Bedrock and
    // lets the provider decide support, exactly like every other embedding client.
    await callBedrockEmbedding({
      inputs: ["hello"],
      model: "amazon.nova-lite-v1:0",
      apiKey: "test-key",
      baseUrl: BEDROCK_HOST,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].modelId).toBe("amazon.nova-lite-v1:0");
  });

  test("surfaces the provider error without the AI SDK's 'undefined: ' prefix", async () => {
    server.use(
      http.post(`${BEDROCK_HOST}/model/:modelId/invoke`, () =>
        HttpResponse.json(
          { message: "Malformed input request: extraneous key [inputText]." },
          { status: 400 },
        ),
      ),
    );
    const error = await callBedrockEmbedding({
      inputs: ["hello"],
      model: "amazon.titan-embed-text-v2:0",
      apiKey: "test-key",
      baseUrl: BEDROCK_HOST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BedrockEmbeddingError);
    expect((error as BedrockEmbeddingError).message).not.toMatch(/^undefined:/);
    expect((error as BedrockEmbeddingError).message).toContain(
      "Malformed input request",
    );
  });

  test("sends the dimensions parameter for Titan v2", async () => {
    captured.length = 0;
    await callBedrockEmbedding({
      inputs: ["hello"],
      model: "amazon.titan-embed-text-v2:0",
      apiKey: "test-key",
      baseUrl: BEDROCK_HOST,
      dimensions: 1024,
    });
    expect(captured[0].body.dimensions).toBe(1024);
  });

  test("omits the dimensions parameter for Titan v1 (fixed dimension)", async () => {
    captured.length = 0;
    await callBedrockEmbedding({
      inputs: ["hello"],
      model: "amazon.titan-embed-text-v1",
      apiKey: "test-key",
      baseUrl: BEDROCK_HOST,
      dimensions: 1536,
    });
    expect(captured[0].body.dimensions).toBeUndefined();
  });

  test("omits the dimensions parameter for Titan v1 even for a dimension in the unknown-model fallback set", async () => {
    captured.length = 0;
    // A cataloged model without `onRequestDimensions` REJECTS the parameter
    // with a ValidationException — it must never inherit the Titan v2
    // fallback set reserved for unknown models.
    await callBedrockEmbedding({
      inputs: ["hello"],
      model: "amazon.titan-embed-text-v1",
      apiKey: "test-key",
      baseUrl: BEDROCK_HOST,
      dimensions: 512,
    });
    expect(captured[0].body.dimensions).toBeUndefined();
  });

  test("normalizes the response to the OpenAI embedding shape, preserving order", async () => {
    captured.length = 0;
    const result = await callBedrockEmbedding({
      inputs: ["a", "b"],
      model: "amazon.titan-embed-text-v2:0",
      apiKey: "test-key",
      baseUrl: BEDROCK_HOST,
      dimensions: 1024,
    });
    expect(result.object).toBe("list");
    expect(result.data).toHaveLength(2);
    expect(result.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.data[0].index).toBe(0);
    expect(result.data[1].index).toBe(1);
  });

  test("uses bearer auth when an API key is provided", async () => {
    captured.length = 0;
    await callBedrockEmbedding({
      inputs: ["hello"],
      model: "amazon.titan-embed-text-v2:0",
      apiKey: "test-key",
      baseUrl: BEDROCK_HOST,
    });
    expect(captured[0].authorization).toBe("Bearer test-key");
  });

  test("rejects image inputs for text-only models (Titan text)", async () => {
    await expect(
      callBedrockEmbedding({
        inputs: [{ mimeType: "image/png", data: "abc" }],
        model: "amazon.titan-embed-text-v2:0",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      }),
    ).rejects.toBeInstanceOf(BedrockEmbeddingError);
  });

  test("rejects image inputs for an unknown model", async () => {
    const error = await callBedrockEmbedding({
      inputs: [{ mimeType: "image/png", data: "abc" }],
      model: "amazon.nova-embed-v1:0",
      apiKey: "test-key",
      baseUrl: BEDROCK_HOST,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BedrockEmbeddingError);
    expect((error as BedrockEmbeddingError).status).toBe(400);
    expect((error as BedrockEmbeddingError).message).toContain(
      "amazon.nova-embed-v1:0",
    );
  });

  describe("Titan Multimodal G1", () => {
    test("sends inputText for texts and inputImage for images, preserving order", async () => {
      captured.length = 0;
      const result = await callBedrockEmbedding({
        inputs: ["a caption", { mimeType: "image/png", data: "aW1hZ2U=" }],
        model: "amazon.titan-embed-image-v1",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      });
      expect(captured).toHaveLength(2);
      const bodies = captured.map((c) => c.body);
      expect(bodies).toContainEqual(
        expect.objectContaining({ inputText: "a caption" }),
      );
      expect(bodies).toContainEqual(
        expect.objectContaining({ inputImage: "aW1hZ2U=" }),
      );
      // The image body carries raw base64, never a data URI.
      expect(JSON.stringify(bodies)).not.toContain("data:image");
      expect(result.data).toHaveLength(2);
      expect(result.data[0].index).toBe(0);
      expect(result.data[1].index).toBe(1);
    });

    test("forwards a supported on-request dimension via embeddingConfig", async () => {
      captured.length = 0;
      await callBedrockEmbedding({
        inputs: ["hello"],
        model: "amazon.titan-embed-image-v1",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
        dimensions: 384,
      });
      expect(captured[0].body.embeddingConfig).toEqual({
        outputEmbeddingLength: 384,
      });
    });

    test("omits embeddingConfig for a dimension the model doesn't take on request", async () => {
      captured.length = 0;
      await callBedrockEmbedding({
        inputs: ["hello"],
        model: "amazon.titan-embed-image-v1",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
        dimensions: 768,
      });
      expect(captured[0].body.embeddingConfig).toBeUndefined();
    });

    test("truncates a text input over the model's 256-token limit", async () => {
      captured.length = 0;
      const longText = "alpha bravo charlie delta ".repeat(100);
      await callBedrockEmbedding({
        inputs: [longText, "short caption"],
        model: "amazon.titan-embed-image-v1",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      });
      // Titan MM REJECTS text over 256 tokens with a ValidationException (no
      // truncate parameter), so the client must send a truncated input.
      const bodies = captured.map((c) => c.body);
      const truncated = bodies.find(
        (body) =>
          typeof body.inputText === "string" &&
          (body.inputText as string).length > "short caption".length,
      );
      expect(truncated).toBeDefined();
      const sentText = truncated?.inputText as string;
      expect(sentText.length).toBeLessThan(longText.length);
      expect(countTokens(getEncoding(), sentText)).toBeLessThanOrEqual(256);
      expect(longText.startsWith(sentText)).toBe(true);
      // The short input passes through unmodified.
      expect(bodies).toContainEqual(
        expect.objectContaining({ inputText: "short caption" }),
      );
    });

    test("maps a provider error to BedrockEmbeddingError with its status", async () => {
      server.use(
        http.post(`${BEDROCK_HOST}/model/:modelId/invoke`, () =>
          HttpResponse.json(
            { message: "The provided image must have a valid format" },
            { status: 400 },
          ),
        ),
      );
      const error = await callBedrockEmbedding({
        inputs: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
        model: "amazon.titan-embed-image-v1",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BedrockEmbeddingError);
      expect((error as BedrockEmbeddingError).status).toBe(400);
      expect((error as BedrockEmbeddingError).message).toContain(
        "valid format",
      );
    });

    test("maps Titan's error-on-200 (message, no vector) to a non-retryable 400", async () => {
      server.use(
        http.post(`${BEDROCK_HOST}/model/:modelId/invoke`, () =>
          // Titan reports deterministic generation errors as `message` on an
          // otherwise-200 response; a 500 would make the embedder retry it.
          HttpResponse.json({ message: "Input image dimensions too large" }),
        ),
      );
      const error = await callBedrockEmbedding({
        inputs: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
        model: "amazon.titan-embed-image-v1",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BedrockEmbeddingError);
      expect((error as BedrockEmbeddingError).status).toBe(400);
      expect((error as BedrockEmbeddingError).message).toContain(
        "dimensions too large",
      );
    });

    test("keeps a vectorless response with no message a 500", async () => {
      server.use(
        http.post(`${BEDROCK_HOST}/model/:modelId/invoke`, () =>
          HttpResponse.json({}),
        ),
      );
      const error = await callBedrockEmbedding({
        inputs: ["hello"],
        model: "amazon.titan-embed-image-v1",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BedrockEmbeddingError);
      expect((error as BedrockEmbeddingError).status).toBe(500);
    });
  });

  describe("Cohere Embed v3", () => {
    test("batches texts into one call and gives each image its own call", async () => {
      const cohereCaptured: Array<Record<string, unknown>> = [];
      server.use(
        http.post(
          `${BEDROCK_HOST}/model/:modelId/invoke`,
          async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            cohereCaptured.push(body);
            const count = Array.isArray(body.texts)
              ? (body.texts as string[]).length
              : 1;
            return HttpResponse.json({
              embeddings: Array.from({ length: count }, (_, i) => [i + 1, 0.5]),
            });
          },
        ),
      );

      const result = await callBedrockEmbedding({
        inputs: [
          "first text",
          { mimeType: "image/jpeg", data: "aW1n" },
          "second text",
        ],
        model: "cohere.embed-english-v3",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      });

      const textCall = cohereCaptured.find((body) => "texts" in body);
      const imageCall = cohereCaptured.find((body) => "images" in body);
      expect(textCall).toMatchObject({
        texts: ["first text", "second text"],
        input_type: "search_document",
        truncate: "END",
      });
      expect(imageCall).toMatchObject({
        images: ["data:image/jpeg;base64,aW1n"],
        input_type: "image",
      });

      // Results reassemble in input order: texts at 0 and 2, image at 1.
      expect(result.data).toHaveLength(3);
      expect(result.data[0].embedding).toEqual([1, 0.5]);
      expect(result.data[2].embedding).toEqual([2, 0.5]);
      expect(result.data[1].embedding).toEqual([1, 0.5]);
    });

    test("clamps texts over the 2048-character request cap client-side", async () => {
      const cohereCaptured: Array<Record<string, unknown>> = [];
      server.use(
        http.post(
          `${BEDROCK_HOST}/model/:modelId/invoke`,
          async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            cohereCaptured.push(body);
            const count = (body.texts as string[]).length;
            return HttpResponse.json({
              embeddings: Array.from({ length: count }, () => [0.1, 0.2]),
            });
          },
        ),
      );

      // Bedrock's Cohere request schema rejects any `texts` entry over 2048
      // characters BEFORE the token-level `truncate: "END"` applies, and the
      // KB's default chunk plus contextual header already crosses it.
      const longText = "alpha bravo charlie ".repeat(250); // 5000 chars
      await callBedrockEmbedding({
        inputs: [longText, "short text"],
        model: "cohere.embed-english-v3",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      });

      const texts = cohereCaptured[0].texts as string[];
      expect(texts).toHaveLength(2);
      expect(texts[0].length).toBeLessThanOrEqual(2048);
      expect(longText.startsWith(texts[0])).toBe(true);
      expect(texts[1]).toBe("short text");
    });

    test("embeds queries as search_query, images untouched", async () => {
      const cohereCaptured: Array<Record<string, unknown>> = [];
      server.use(
        http.post(
          `${BEDROCK_HOST}/model/:modelId/invoke`,
          async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            cohereCaptured.push(body);
            return HttpResponse.json({ embeddings: [[0.1, 0.2]] });
          },
        ),
      );

      // Cohere conditions the vector on input_type: documents embedded as
      // search_document must be searched with search_query vectors, or
      // ranking silently degrades.
      await callBedrockEmbedding({
        inputs: [
          "what is in the picture?",
          { mimeType: "image/jpeg", data: "aW1n" },
        ],
        model: "cohere.embed-english-v3",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
        purpose: "search_query",
      });

      const textCall = cohereCaptured.find((body) => "texts" in body);
      const imageCall = cohereCaptured.find((body) => "images" in body);
      expect(textCall?.input_type).toBe("search_query");
      expect(imageCall?.input_type).toBe("image");
    });

    test("records token usage from the X-Amzn-Bedrock-Input-Token-Count header", async () => {
      server.use(
        http.post(
          `${BEDROCK_HOST}/model/:modelId/invoke`,
          async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            const count = Array.isArray(body.texts)
              ? (body.texts as string[]).length
              : 1;
            return HttpResponse.json(
              {
                embeddings: Array.from({ length: count }, () => [0.1, 0.2]),
              },
              // The Cohere response body carries no usage; the header is the
              // only place Bedrock reports the input token count.
              { headers: { "X-Amzn-Bedrock-Input-Token-Count": "7" } },
            );
          },
        ),
      );

      const result = await callBedrockEmbedding({
        inputs: ["a", "b", { mimeType: "image/png", data: "aW1n" }],
        model: "cohere.embed-english-v3",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      });

      // One text batch (7) + one image call (7).
      expect(result.usage.prompt_tokens).toBe(14);
      expect(result.usage.total_tokens).toBe(14);
    });

    test("takes the multimodal path for a region-prefixed inference-profile id", async () => {
      captured.length = 0;
      server.use(
        http.post(
          `${BEDROCK_HOST}/model/:modelId/invoke`,
          async ({ params, request }) => {
            captured.push({
              modelId: String(params.modelId),
              body: (await request.json()) as Record<string, unknown>,
              authorization: request.headers.get("authorization"),
            });
            return HttpResponse.json({ embeddings: [[0.1, 0.2]] });
          },
        ),
      );
      await callBedrockEmbedding({
        inputs: [{ mimeType: "image/png", data: "aW1n" }],
        model: "us.cohere.embed-english-v3",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      });
      // The configured id goes to the API verbatim (profile ids are invokable).
      expect(captured[0].modelId).toBe("us.cohere.embed-english-v3");
      expect(captured[0].body.input_type).toBe("image");
    });

    test("parses the embedding_types-keyed response shape", async () => {
      server.use(
        http.post(`${BEDROCK_HOST}/model/:modelId/invoke`, () =>
          HttpResponse.json({ embeddings: { float: [[0.7, 0.8]] } }),
        ),
      );
      const result = await callBedrockEmbedding({
        inputs: ["hello"],
        model: "cohere.embed-multilingual-v3",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      });
      expect(result.data[0].embedding).toEqual([0.7, 0.8]);
    });

    test("rejects an oversized image before spending the request", async () => {
      // ~6MB decoded — over the 5MB limit. No MSW handler runs (a network call
      // would fail the test as unhandled).
      const oversized = "A".repeat(8 * 1024 * 1024);
      const error = await callBedrockEmbedding({
        inputs: [{ mimeType: "image/png", data: oversized }],
        model: "cohere.embed-english-v3",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BedrockEmbeddingError);
      expect((error as BedrockEmbeddingError).status).toBe(400);
      expect((error as BedrockEmbeddingError).message).toContain("5MB limit");
    });

    test("throws when the embedding count doesn't match the input count", async () => {
      server.use(
        http.post(`${BEDROCK_HOST}/model/:modelId/invoke`, () =>
          HttpResponse.json({ embeddings: [[0.1]] }),
        ),
      );
      const error = await callBedrockEmbedding({
        inputs: ["a", "b"],
        model: "cohere.embed-english-v3",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BedrockEmbeddingError);
      expect((error as BedrockEmbeddingError).message).toContain(
        "1 embedding(s) for 2 input(s)",
      );
    });
  });
});
