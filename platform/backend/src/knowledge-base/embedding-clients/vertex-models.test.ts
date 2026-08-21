import { describe, expect, test } from "@/test";
import { findVertexMultimodalEmbeddingModel } from "./vertex-models";

describe("findVertexMultimodalEmbeddingModel", () => {
  test("finds the model by its bare publisher id", () => {
    expect(
      findVertexMultimodalEmbeddingModel("multimodalembedding@001"),
    ).toMatchObject({
      modelId: "multimodalembedding@001",
      dimensions: 1408,
      inputModalities: ["text", "image"],
      acceptedImageMimeTypes: [
        "image/png",
        "image/jpeg",
        "image/bmp",
        "image/gif",
        "image/webp",
      ],
      maxInputTextBytes: 1024,
    });
  });

  test("tolerates the Vertex resource-name and GenAI prefixes", () => {
    expect(
      findVertexMultimodalEmbeddingModel(
        "publishers/google/models/multimodalembedding@001",
      )?.modelId,
    ).toBe("multimodalembedding@001");
    expect(
      findVertexMultimodalEmbeddingModel("models/multimodalembedding@001")
        ?.modelId,
    ).toBe("multimodalembedding@001");
  });

  test("returns undefined for other models", () => {
    expect(
      findVertexMultimodalEmbeddingModel("gemini-embedding-2"),
    ).toBeUndefined();
    expect(
      findVertexMultimodalEmbeddingModel("text-embedding-005"),
    ).toBeUndefined();
  });
});
