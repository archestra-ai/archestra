import type { ModelMessage } from "ai";
import { describe, expect, test } from "vitest";
import {
  parseMaxInputTokens,
  shouldProbeTextStreamForContextTrimRetry,
  trimMessagesToTokenLimit,
} from "./context-trimming";

const msg = (role: ModelMessage["role"], content: string): ModelMessage =>
  ({ role, content }) as ModelMessage;

describe("parseMaxInputTokens", () => {
  test("parses limit from LiteLLM error message", () => {
    const error = new Error(
      'litellm.BadRequestError: Hosted_vllmException - {"error":{"message":"You passed 8193 input tokens and requested 0 output tokens. However, the model\'s context length is only 8192 tokens, resulting in a maximum input length of 8192 tokens.","type":"BadRequestError","param":"input_tokens","code":400}}',
    );
    expect(parseMaxInputTokens(error)).toBe(8192);
  });

  test("returns null for unrelated errors", () => {
    expect(parseMaxInputTokens(new Error("rate limit exceeded"))).toBeNull();
  });

  test("returns null for non-error values", () => {
    expect(parseMaxInputTokens(null)).toBeNull();
    expect(parseMaxInputTokens(undefined)).toBeNull();
    expect(parseMaxInputTokens(42)).toBeNull();
  });
});

describe("shouldProbeTextStreamForContextTrimRetry", () => {
  test("skips the textStream probe for Gemini", () => {
    expect(shouldProbeTextStreamForContextTrimRetry("gemini")).toBe(false);
  });

  test("keeps the textStream probe enabled for OpenAI-compatible flows", () => {
    expect(shouldProbeTextStreamForContextTrimRetry("openai")).toBe(true);
    expect(shouldProbeTextStreamForContextTrimRetry("vllm")).toBe(true);
  });
});

describe("trimMessagesToTokenLimit", () => {
  test("returns messages unchanged if within budget", () => {
    const messages = [msg("user", "hi")];
    expect(trimMessagesToTokenLimit(messages, 10000)).toBe(messages);
  });

  test("returns empty array unchanged", () => {
    expect(trimMessagesToTokenLimit([], 100)).toEqual([]);
  });

  test("drops middle messages first (oldest)", () => {
    const messages = [
      msg("user", "a".repeat(100)),
      msg("assistant", "b".repeat(100)),
      msg("user", "c".repeat(100)),
    ];
    // Budget fits ~2 messages worth + trim note
    const result = trimMessagesToTokenLimit(messages, 60);
    // Should have dropped the first message, kept last
    expect(result.some((m) => m.content === "a".repeat(100))).toBe(false);
    expect(result[result.length - 1].content).toBe("c".repeat(100));
  });

  test("drops system messages after middle messages", () => {
    const messages = [
      msg("system", "x".repeat(200)),
      msg("user", "a".repeat(200)),
      msg("user", "b".repeat(200)),
    ];
    // Very tight budget — only last message fits
    const result = trimMessagesToTokenLimit(messages, 60);
    expect(
      result.some((m) => m.role === "system" && m.content === "x".repeat(200)),
    ).toBe(false);
  });

  test("truncates last message if still over budget", () => {
    const messages = [msg("user", "a".repeat(1000))];
    const result = trimMessagesToTokenLimit(messages, 10);
    const lastContent = result[result.length - 1].content as string;
    expect(lastContent.length).toBeLessThan(1000);
  });

  test("adds trim note only when trimmed", () => {
    const small = [msg("user", "hi")];
    expect(trimMessagesToTokenLimit(small, 10000)[0].content).toBe("hi");

    const big = [
      msg("user", "a".repeat(200)),
      msg("assistant", "b".repeat(200)),
      msg("user", "c".repeat(200)),
    ];
    const result = trimMessagesToTokenLimit(big, 60);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("trimmed");
  });

  test("keeps last message even with single message", () => {
    const messages = [msg("user", "hello")];
    const result = trimMessagesToTokenLimit(messages, 1);
    expect(result.some((m) => m.role === "user")).toBe(true);
  });
});
