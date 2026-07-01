import { describe, expect, test, vi } from "@/test";
import { AnthropicTokenizer } from "./anthropic";
import { BaseTokenizer, type ProviderMessage } from "./base";
import { getTokenizer } from "./index";
import { TiktokenTokenizer } from "./tiktoken";

describe("Tokenizers", () => {
  describe("TiktokenTokenizer", () => {
    test("should count tokens in a simple string message", () => {
      const tokenizer = new TiktokenTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: "Hello, world!",
      };

      const tokenCount = tokenizer.countTokens(message);

      // "Hello, world!" should be around 4 tokens with cl100k_base
      expect(tokenCount).toBeGreaterThan(0);
      expect(tokenCount).toBeLessThan(10);
    });

    test("should count tokens in an array content message", () => {
      const tokenizer = new TiktokenTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      };

      const tokenCount = tokenizer.countTokens(message);

      expect(tokenCount).toBeGreaterThan(0);
    });

    test("should count tokens in multiple messages", () => {
      const tokenizer = new TiktokenTokenizer();
      const messages: ProviderMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ];

      const tokenCount = tokenizer.countTokens(messages);

      expect(tokenCount).toBeGreaterThan(0);
    });

    test("should handle empty messages", () => {
      const tokenizer = new TiktokenTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: "",
      };

      const tokenCount = tokenizer.countTokens(message);

      // Should at least count the role
      expect(tokenCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe("AnthropicTokenizer", () => {
    test("should count tokens in a simple string message", () => {
      const tokenizer = new AnthropicTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: "Hello, world!",
      };

      const tokenCount = tokenizer.countTokens(message);

      expect(tokenCount).toBeGreaterThan(0);
      expect(tokenCount).toBeLessThan(10);
    });

    test("should count tokens in an array content message", () => {
      const tokenizer = new AnthropicTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      };

      const tokenCount = tokenizer.countTokens(message);

      expect(tokenCount).toBeGreaterThan(0);
    });

    test("should count tokens in multiple messages", () => {
      const tokenizer = new AnthropicTokenizer();
      const messages: ProviderMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ];

      const tokenCount = tokenizer.countTokens(messages);

      expect(tokenCount).toBeGreaterThan(0);
    });
  });

  describe("getTokenizer", () => {
    test("should return AnthropicTokenizer for anthropic provider", () => {
      const tokenizer = getTokenizer("anthropic");

      expect(tokenizer).toBeInstanceOf(AnthropicTokenizer);
    });

    test("should return TiktokenTokenizer for openai provider", () => {
      const tokenizer = getTokenizer("openai");

      expect(tokenizer).toBeInstanceOf(TiktokenTokenizer);
    });

    test("should return TiktokenTokenizer for gemini provider", () => {
      const tokenizer = getTokenizer("gemini");

      expect(tokenizer).toBeInstanceOf(TiktokenTokenizer);
    });

    test("should reuse a cached instance across calls for the same provider", () => {
      // The tiktoken encoding allocated in the constructor holds WASM heap that
      // is never freed, so getTokenizer must not allocate a new instance per
      // call. Reuse also keeps the (expensive) encoding init a one-time cost.
      expect(getTokenizer("openai")).toBe(getTokenizer("openai"));
      expect(getTokenizer("anthropic")).toBe(getTokenizer("anthropic"));
    });

    test("should share one tiktoken instance across tiktoken-backed providers", () => {
      // Every non-anthropic provider maps to the same cl100k_base tokenizer, so
      // they should all resolve to the single shared instance.
      expect(getTokenizer("openai")).toBe(getTokenizer("bedrock"));
      expect(getTokenizer("gemini")).toBe(getTokenizer("cohere"));
      expect(getTokenizer("openai")).not.toBe(getTokenizer("anthropic"));
    });

    test("should return consistent token counts for same input", () => {
      const anthropicTokenizer = getTokenizer("anthropic");
      const openaiTokenizer = getTokenizer("openai");

      const message: ProviderMessage = {
        role: "user",
        content: "This is a test message",
      };

      const anthropicCount = anthropicTokenizer.countTokens(message);
      const openaiCount = openaiTokenizer.countTokens(message);

      // Token counts should be in the same ballpark (within 20% of each other)
      expect(anthropicCount).toBeGreaterThan(0);
      expect(openaiCount).toBeGreaterThan(0);
      const errorMargin = Math.max(anthropicCount, openaiCount) * 0.2;
      expect(Math.abs(anthropicCount - openaiCount)).toBeLessThan(errorMargin);
    });
  });

  describe("per-message memoization", () => {
    // A tokenizer that records how many times the (uncached) encoder ran, so we
    // can assert repeated message content is served from the memo.
    class CountingTokenizer extends BaseTokenizer {
      computeCalls = 0;

      protected computeMessageTokens(encodableText: string): number {
        this.computeCalls++;
        return encodableText.length;
      }
    }

    test("encodes repeated message content only once", () => {
      const tokenizer = new CountingTokenizer();
      const first = tokenizer.countTokens({ role: "user", content: "hello" });
      // A different object with identical content must hit the memo.
      const second = tokenizer.countTokens({ role: "user", content: "hello" });

      expect(second).toBe(first);
      expect(tokenizer.computeCalls).toBe(1);

      // Distinct content is encoded on its own.
      tokenizer.countTokens({ role: "user", content: "different" });
      expect(tokenizer.computeCalls).toBe(2);
    });

    test("counts each unique message in an array, reusing repeats", () => {
      const tokenizer = new CountingTokenizer();
      const messages: ProviderMessage[] = [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "a" }, // repeat of the first
      ];

      tokenizer.countTokens(messages);

      // Only the two unique (role, content) pairs are encoded.
      expect(tokenizer.computeCalls).toBe(2);
    });

    test("does not expire cached counts over time (deterministic)", () => {
      // Token counts are pure, so the memo must not use the cache manager's
      // default 1h TTL — otherwise long conversations re-encode every hour.
      vi.useFakeTimers();
      try {
        const tokenizer = new CountingTokenizer();
        const message: ProviderMessage = { role: "user", content: "hello" };

        tokenizer.countTokens(message);
        expect(tokenizer.computeCalls).toBe(1);

        // Advance well past the manager's 1h default TTL.
        vi.advanceTimersByTime(2 * 60 * 60 * 1000);

        tokenizer.countTokens(message);
        expect(tokenizer.computeCalls).toBe(1); // still served from the memo
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
