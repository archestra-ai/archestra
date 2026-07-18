import { describe, expect, test } from "@/test";
import {
  EmbeddingConfigUnresolvableError,
  EmbeddingDimensionMismatchError,
  EmbeddingProviderUnreachableError,
  normalizeEmbeddingError,
  toKnowledgeBaseUserMessage,
  UnsupportedEmbeddingProviderError,
  UnusableEmbeddingResponseError,
} from "./errors";

describe("toKnowledgeBaseUserMessage", () => {
  test("returns the actionable message for a KB error", () => {
    const err = new UnsupportedEmbeddingProviderError("anthropic", "claude");
    expect(toKnowledgeBaseUserMessage(err)).toBe(err.userMessage);
  });

  test("returns undefined for a non-KB error (falls back to generic)", () => {
    expect(toKnowledgeBaseUserMessage(new Error("boom"))).toBeUndefined();
    expect(toKnowledgeBaseUserMessage("boom")).toBeUndefined();
  });
});

describe("normalizeEmbeddingError", () => {
  test("wraps a raw error as EmbeddingProviderUnreachableError with context", () => {
    const result = normalizeEmbeddingError(new Error("ECONNREFUSED"), {
      provider: "bedrock",
      model: "amazon.titan-embed-text-v2:0",
    });
    expect(result).toBeInstanceOf(EmbeddingProviderUnreachableError);
    expect(result.userMessage).toContain("bedrock");
    expect(result.userMessage).toContain("amazon.titan-embed-text-v2:0");
  });

  test("passes an already-typed KB error through unchanged", () => {
    const original = new UnusableEmbeddingResponseError(
      "openai",
      "text-embedding-3-small",
      "empty vector",
    );
    expect(
      normalizeEmbeddingError(original, { provider: "openai", model: "x" }),
    ).toBe(original);
  });
});

describe("KB error messages are actionable", () => {
  test("name the provider/model and point to Settings, never the vague phrase", () => {
    const messages = [
      new UnsupportedEmbeddingProviderError("anthropic", "claude").userMessage,
      new UnusableEmbeddingResponseError("openai", "m", "empty").userMessage,
      new EmbeddingProviderUnreachableError("vllm", "m", "timeout").userMessage,
      new EmbeddingConfigUnresolvableError().userMessage,
    ];
    for (const message of messages) {
      expect(message).toContain("Settings → Knowledge");
      expect(message.toLowerCase()).not.toContain(
        "non supported embedding format",
      );
    }
  });

  test("dimension mismatch names both dimensions and says re-ingest", () => {
    const message = new EmbeddingDimensionMismatchError(
      "text-embedding-3-large",
      1024,
      [1536],
    ).userMessage;
    expect(message).toContain("1024");
    expect(message).toContain("1536");
    expect(message.toLowerCase()).toContain("re-ingest");
  });
});
