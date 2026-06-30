import { ArchestraInternalErrorCode } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import {
  internalCodeFromProviderMessage,
  isContextOverflowMessage,
  isRequestTooLargeMessage,
} from "./context-overflow-patterns";

describe("isContextOverflowMessage", () => {
  // Real wordings captured from live providers/gateways plus the phrasings the
  // per-adapter sniffs already relied on. These are the strings that must classify
  // as context overflow.
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
    // Cohere
    "too many tokens for this model",
  ])("classifies overflow: %s", (message) => {
    expect(isContextOverflowMessage(message)).toBe(true);
    expect(internalCodeFromProviderMessage(message)).toBe(
      ArchestraInternalErrorCode.ContextLengthExceeded,
    );
  });

  // Messages that must NOT be classified as context overflow — guards the
  // conservative pattern set against false positives.
  test.each([
    "total message size 3275158 exceeds limit 2097152", // byte-size, not tokens
    "Rate limit exceeded, please try again later",
    "rate_limit_exceeded",
    "Invalid API key provided",
    "There was an issue with your request. Please try again.",
    "stop sequences must be non-empty strings",
    "Input is too long for requested model", // bare "too long" — intentionally excluded
  ])("does not classify as overflow: %s", (message) => {
    expect(isContextOverflowMessage(message)).toBe(false);
  });

  test("ignores non-string input", () => {
    expect(isContextOverflowMessage(undefined)).toBe(false);
    expect(isContextOverflowMessage(null)).toBe(false);
    expect(isContextOverflowMessage({ message: "prompt is too long" })).toBe(
      false,
    );
  });
});

describe("isRequestTooLargeMessage", () => {
  test.each([
    "total message size 3275158 exceeds limit 2097152",
    "Request Entity Too Large",
    "payload too large",
    "request body exceeds the maximum allowed request size",
  ])("classifies request-too-large: %s", (message) => {
    expect(isRequestTooLargeMessage(message)).toBe(true);
    expect(internalCodeFromProviderMessage(message)).toBe(
      ArchestraInternalErrorCode.RequestTooLarge,
    );
  });

  test.each([
    "prompt is too long: 201381 tokens > 200000 maximum",
    "maximum context length is 8192 tokens",
    "Invalid API key provided",
  ])("does not classify as request-too-large: %s", (message) => {
    expect(isRequestTooLargeMessage(message)).toBe(false);
  });

  test("context overflow wins when both could match", () => {
    // Defensive: a hypothetical message hitting both lists resolves to overflow.
    const message = "maximum context length exceeded; payload too large";
    expect(internalCodeFromProviderMessage(message)).toBe(
      ArchestraInternalErrorCode.ContextLengthExceeded,
    );
  });
});
