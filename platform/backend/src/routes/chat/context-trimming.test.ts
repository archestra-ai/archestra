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
    expect(trimMessagesToTokenLimit({ messages, maxTokens: 10000 })).toBe(
      messages,
    );
  });

  test("returns empty array unchanged", () => {
    expect(trimMessagesToTokenLimit({ messages: [], maxTokens: 100 })).toEqual(
      [],
    );
  });

  test("drops middle messages first (oldest)", () => {
    const messages = [
      msg("user", "a".repeat(100)),
      msg("assistant", "b".repeat(100)),
      msg("user", "c".repeat(100)),
    ];
    // Budget fits ~2 messages worth + trim note
    const result = trimMessagesToTokenLimit({ messages, maxTokens: 60 });
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
    const result = trimMessagesToTokenLimit({ messages, maxTokens: 60 });
    expect(
      result.some((m) => m.role === "system" && m.content === "x".repeat(200)),
    ).toBe(false);
  });

  test("truncates last message if still over budget", () => {
    const messages = [msg("user", "a".repeat(1000))];
    const result = trimMessagesToTokenLimit({ messages, maxTokens: 10 });
    const lastContent = result[result.length - 1].content as string;
    expect(lastContent.length).toBeLessThan(1000);
  });

  test("adds trim note only when trimmed", () => {
    const small = [msg("user", "hi")];
    expect(
      trimMessagesToTokenLimit({ messages: small, maxTokens: 10000 })[0]
        .content,
    ).toBe("hi");

    const big = [
      msg("user", "a".repeat(200)),
      msg("assistant", "b".repeat(200)),
      msg("user", "c".repeat(200)),
    ];
    const result = trimMessagesToTokenLimit({ messages: big, maxTokens: 60 });
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("trimmed");
  });

  test("keeps last message even with single message", () => {
    const messages = [msg("user", "hello")];
    const result = trimMessagesToTokenLimit({ messages, maxTokens: 1 });
    expect(result.some((m) => m.role === "user")).toBe(true);
  });

  test("reserves budget for the separately-sent system prompt", () => {
    const messages = [msg("user", "a".repeat(40))];
    // 20 tokens * 4 chars = 80 char budget; the 40-char message fits alone.
    expect(trimMessagesToTokenLimit({ messages, maxTokens: 20 })).toHaveLength(
      1,
    );
    // A 200-char system prompt overruns the same budget, forcing a trim.
    const result = trimMessagesToTokenLimit({
      messages,
      maxTokens: 20,
      systemPrompt: "s".repeat(200),
    });
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("trimmed");
  });

  test("drops (never corrupts) a structured last message over budget", () => {
    const toolMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "search",
          output: { type: "text", value: "x".repeat(1000) },
        },
      ],
    } as ModelMessage;
    const result = trimMessagesToTokenLimit({
      messages: [toolMessage],
      maxTokens: 5,
    });
    // The structured message is dropped, not turned into a truncated JSON
    // string; every surviving message keeps array/string content intact.
    expect(result.some((m) => m === toolMessage)).toBe(false);
    for (const m of result) {
      const isStringOrArray =
        typeof m.content === "string" || Array.isArray(m.content);
      expect(isStringOrArray).toBe(true);
    }
  });

  test("preserves the text of a structured last message, dropping image parts", () => {
    // a current user turn carrying both text and an image; the image blows the
    // budget but the text request must survive the retry.
    const userMessage = {
      role: "user",
      content: [
        { type: "text", text: "summarize this screenshot" },
        { type: "image", image: `data:image/png;base64,${"A".repeat(2000)}` },
      ],
    } as ModelMessage;
    const result = trimMessagesToTokenLimit({
      messages: [userMessage],
      maxTokens: 50,
    });
    // the text request survives as string content; no oversized image part.
    const surviving = result.find((m) => m.role === "user");
    expect(surviving?.content).toBe("summarize this screenshot");
  });

  test("never returns undefined entries when only system messages exist", () => {
    const messages = [
      msg("system", "x".repeat(200)),
      msg("system", "y".repeat(200)),
    ];
    const result = trimMessagesToTokenLimit({ messages, maxTokens: 5 });
    expect(result.every((m) => m !== undefined)).toBe(true);
  });
});
