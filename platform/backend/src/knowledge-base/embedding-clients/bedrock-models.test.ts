import { describe, expect, test } from "@/test";
import { findBedrockEmbeddingModel } from "./bedrock-models";

describe("findBedrockEmbeddingModel", () => {
  test("matches a Titan foundation-model id", () => {
    expect(
      findBedrockEmbeddingModel("amazon.titan-embed-text-v2:0"),
    ).toMatchObject({
      dimensions: 1024,
      onRequestDimensions: [256, 512, 1024],
      inputModalities: ["text"],
    });
    expect(
      findBedrockEmbeddingModel("amazon.titan-embed-text-v1"),
    ).toMatchObject({
      dimensions: 1536,
      inputModalities: ["text"],
    });
    expect(
      findBedrockEmbeddingModel("amazon.titan-embed-text-v1")
        ?.onRequestDimensions,
    ).toBeUndefined();
  });

  test("matches the multimodal models with an image modality", () => {
    expect(
      findBedrockEmbeddingModel("amazon.titan-embed-image-v1"),
    ).toMatchObject({
      dimensions: 1024,
      onRequestDimensions: [256, 384, 1024],
      inputModalities: ["text", "image"],
      // Titan MM rejects text over 256 tokens (no truncate parameter), so the
      // client truncates to this limit.
      maxInputTextTokens: 256,
      acceptedImageMimeTypes: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
      ],
    });
    // AWS publishes no inference profiles for embedding models, so Cohere is
    // statically injected by its bare on-demand id, exactly like Titan.
    expect(findBedrockEmbeddingModel("cohere.embed-english-v3")).toMatchObject({
      dimensions: 1024,
      staticInject: true,
      inputModalities: ["text", "image"],
      acceptedImageMimeTypes: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
      ],
    });
    expect(
      findBedrockEmbeddingModel("cohere.embed-multilingual-v3"),
    ).toMatchObject({
      dimensions: 1024,
      staticInject: true,
      inputModalities: ["text", "image"],
    });
  });

  test("tolerates a cross-region inference-profile prefix", () => {
    expect(
      findBedrockEmbeddingModel("us.amazon.titan-embed-text-v2:0"),
    ).toMatchObject({ dimensions: 1024 });
    expect(
      findBedrockEmbeddingModel("global.amazon.titan-embed-text-v1"),
    ).toMatchObject({ dimensions: 1536 });
    expect(
      findBedrockEmbeddingModel("eu.cohere.embed-english-v3"),
    ).toMatchObject({ inputModalities: ["text", "image"] });
  });

  test("returns undefined for an unsupported model (chat, or not-yet-supported embed)", () => {
    expect(
      findBedrockEmbeddingModel("anthropic.claude-3-5-sonnet-20240620-v1:0"),
    ).toBeUndefined();
    expect(findBedrockEmbeddingModel("amazon.nova-lite-v1:0")).toBeUndefined();
    // Cohere Embed v4 is not yet supported — only the v3 models are cataloged.
    expect(findBedrockEmbeddingModel("cohere.embed-v4:0")).toBeUndefined();
  });
});
