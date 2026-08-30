import { describe, expect, it } from "vitest";
import { getKnowledgeRerankerKind } from "./knowledge-reranker";

describe("getKnowledgeRerankerKind", () => {
  it("allows chat models through their provider chat transport", () => {
    expect(
      getKnowledgeRerankerKind({
        provider: "bedrock",
        model: "anthropic.claude-3-sonnet",
        outputModalities: ["text"],
      }),
    ).toBe("llm");
  });

  it("allows native rerank only when Archestra implements the provider route", () => {
    expect(
      getKnowledgeRerankerKind({
        provider: "cohere",
        model: "rerank-v3.5",
        supportedEndpoints: ["/rerank"],
      }),
    ).toBe("native-rerank");
    expect(
      getKnowledgeRerankerKind({
        provider: "bedrock",
        model: "cohere.rerank-v3-5:0",
        supportedEndpoints: ["/rerank"],
      }),
    ).toBeNull();
  });

  it("rejects embedding and non-text output models", () => {
    expect(
      getKnowledgeRerankerKind({
        provider: "cohere",
        model: "embed-v4",
        embeddingDimensions: 1024,
      }),
    ).toBeNull();
    expect(
      getKnowledgeRerankerKind({
        provider: "openai",
        model: "image-model",
        outputModalities: ["image"],
      }),
    ).toBeNull();
  });
});
