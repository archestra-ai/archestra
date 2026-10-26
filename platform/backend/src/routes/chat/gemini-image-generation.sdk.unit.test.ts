import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { isGeminiImageGenerationModel } from "@archestra/shared/gemini-models";
import { generateText, streamText } from "ai";
import { expect, test } from "vitest";
import { buildGeminiProviderOptions } from "./gemini-provider-options";

test.each([
  false,
  true,
])("round-trips Nano Banana 2.1 image output through the real SDK (stream=%s)", async (streaming) => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const image = "iVBORw0KGgo=";
  const response = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text: "Here is the image." },
            { inlineData: { mimeType: "image/png", data: image } },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 4,
      candidatesTokenCount: 10,
      totalTokenCount: 14,
    },
  };
  const google = createGoogleGenerativeAI({
    apiKey: "test-api-key",
    // Only HTTP is faked. The SDK serializes the actual request and parses
    // both the normal response and SSE image chunks.
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return streaming
        ? new Response(`data: ${JSON.stringify(response)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json(response);
    },
  });
  const modelId = "gemini-nano-banana-2.1";
  const options = {
    model: google(modelId),
    prompt: "Draw a small blue circle.",
    providerOptions: {
      google:
        buildGeminiProviderOptions({
          provider: "gemini",
          selectedModel: modelId,
          isGeminiImageModel: isGeminiImageGenerationModel(modelId),
          thinkingEffort: "high",
        }) ?? {},
    },
  };
  const result = streaming ? streamText(options) : await generateText(options);
  expect(await result.text).toBe("Here is the image.");
  const files = await result.files;
  expect(files).toHaveLength(1);
  expect(files[0].mediaType).toBe("image/png");
  expect(files[0].base64).toBe(image);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toContain(`/models/${modelId}:`);
  const generationConfig = requests[0].body.generationConfig;
  expect(generationConfig).toMatchObject({
    responseModalities: ["TEXT", "IMAGE"],
  });
  for (const unsupported of [
    "temperature",
    "topK",
    "topP",
    "seed",
    "logprobs",
    "thinkingConfig",
  ]) {
    expect(generationConfig).not.toHaveProperty(unsupported);
  }
  expect(requests[0].body).not.toHaveProperty("tools");
});
