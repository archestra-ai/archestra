import { describe, expect, test } from "@/test";
import {
  AzureEmbeddingError,
  GeminiEmbeddingError,
  getEmbeddingRetryDelayMs,
  isRetryableEmbeddingError,
  OpenAIEmbeddingError,
} from "./index";

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
