import { describe, expect, test } from "@/test";
import { findBedrockEmbeddingModel } from "./bedrock-models";

describe("findBedrockEmbeddingModel", () => {
  test("matches a Titan foundation-model id", () => {
    expect(
      findBedrockEmbeddingModel("amazon.titan-embed-text-v2:0"),
    ).toMatchObject({
      dimensions: 1024,
      supportsDimensionsParam: true,
    });
    expect(
      findBedrockEmbeddingModel("amazon.titan-embed-text-v1"),
    ).toMatchObject({
      dimensions: 1536,
      supportsDimensionsParam: false,
    });
  });

  test("tolerates a cross-region inference-profile prefix", () => {
    expect(
      findBedrockEmbeddingModel("us.amazon.titan-embed-text-v2:0"),
    ).toMatchObject({ dimensions: 1024 });
    expect(
      findBedrockEmbeddingModel("global.amazon.titan-embed-text-v1"),
    ).toMatchObject({ dimensions: 1536 });
  });

  test("returns undefined for an unsupported model (chat, or not-yet-supported embed)", () => {
    // Cohere is a deferred fast-follow — not yet in the catalog, so it stays out.
    expect(
      findBedrockEmbeddingModel("cohere.embed-english-v3"),
    ).toBeUndefined();
    expect(
      findBedrockEmbeddingModel("anthropic.claude-3-5-sonnet-20240620-v1:0"),
    ).toBeUndefined();
    expect(findBedrockEmbeddingModel("amazon.nova-lite-v1:0")).toBeUndefined();
  });
});
