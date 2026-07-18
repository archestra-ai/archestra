import { HttpResponse, http } from "msw";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { BedrockEmbeddingError, callBedrockEmbedding } from "./bedrock";

const BEDROCK_HOST = "https://bedrock-runtime.us-east-1.amazonaws.com";

describe("callBedrockEmbedding", () => {
  // Capture the InvokeModel requests the AI SDK issues (one per input for Titan).
  const captured: Array<{
    modelId: string;
    body: Record<string, unknown>;
    authorization: string | null;
  }> = [];

  useMswServer(
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

  test("rejects a non-Titan Bedrock model without calling the API", async () => {
    captured.length = 0;
    await expect(
      callBedrockEmbedding({
        inputs: ["hello"],
        model: "amazon.nova-lite-v1:0",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      }),
    ).rejects.toBeInstanceOf(BedrockEmbeddingError);
    expect(captured).toHaveLength(0);
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

  test("rejects image inputs (Titan is text-only)", async () => {
    await expect(
      callBedrockEmbedding({
        inputs: [{ mimeType: "image/png", data: "abc" }],
        model: "amazon.titan-embed-text-v2:0",
        apiKey: "test-key",
        baseUrl: BEDROCK_HOST,
      }),
    ).rejects.toBeInstanceOf(BedrockEmbeddingError);
  });
});
