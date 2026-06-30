import { ArchestraInternalErrorCode } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { internalCodeFromProviderMessage } from "./context-overflow-patterns";

describe("internalCodeFromProviderMessage", () => {
  // Real wordings captured from live providers/gateways plus the phrasings the
  // per-adapter sniffs already relied on — all must classify as context overflow.
  test.each([
    // Anthropic native + Bedrock Claude
    "prompt is too long: 201381 tokens > 200000 maximum",
    // Kimi via its Anthropic-compatible gateway
    "Invalid request: Your request exceeded model token limit: 262144 (requested: 566084)",
    // OpenRouter (MiniMax-M2.7 / DeepSeek-V4-Flash)
    "This endpoint's maximum context length is 204800 tokens. However, you requested about 309977 tokens (303247 of text input, 6730 of tool input). Please reduce the length of either one.",
    // OpenAI structured-message variant
    "This model's maximum context length is 8192 tokens. However, your messages resulted in 8904 tokens.",
    // Ollama
    "exceeded max context length",
    "input prompt too long",
    // MiniMax Anthropic-compatible
    "context window exceeds limit (2013)",
    // Cohere (real full message)
    "too many tokens: total number of tokens in the prompt cannot exceed 4096",
  ])("classifies overflow: %s", (message) => {
    expect(internalCodeFromProviderMessage(message)).toBe(
      ArchestraInternalErrorCode.ContextLengthExceeded,
    );
  });

  // Request-payload byte-size limits classify as request-too-large, not overflow.
  test.each([
    "total message size 3275158 exceeds limit 2097152",
    "Request Entity Too Large",
    "payload too large",
    "request body exceeds the maximum allowed request size",
  ])("classifies request-too-large: %s", (message) => {
    expect(internalCodeFromProviderMessage(message)).toBe(
      ArchestraInternalErrorCode.RequestTooLarge,
    );
  });

  // Must stay unclassified — guards the conservative patterns against false
  // positives, especially token *rate*/quota limits that are not context overflow.
  test.each([
    "Rate limit exceeded, please try again later",
    "rate_limit_exceeded",
    "You have exceeded your token limit for this minute",
    "too many tokens per minute, slow down",
    "You've used too many tokens this month; upgrade your plan",
    "Invalid API key provided",
    "There was an issue with your request. Please try again.",
    "stop sequences must be non-empty strings",
    "Input is too long for requested model", // bare "too long" — intentionally excluded
  ])("does not classify: %s", (message) => {
    expect(internalCodeFromProviderMessage(message)).toBeUndefined();
  });

  test("ignores non-string input", () => {
    expect(internalCodeFromProviderMessage(undefined)).toBeUndefined();
    expect(internalCodeFromProviderMessage(null)).toBeUndefined();
    expect(
      internalCodeFromProviderMessage({ message: "prompt is too long" }),
    ).toBeUndefined();
  });

  test("context overflow wins when both could match", () => {
    const message = "maximum context length exceeded; payload too large";
    expect(internalCodeFromProviderMessage(message)).toBe(
      ArchestraInternalErrorCode.ContextLengthExceeded,
    );
  });
});
