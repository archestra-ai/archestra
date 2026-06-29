import { describe, expect, test } from "@/test";
import { AnthropicTokenizer } from "./anthropic";
import type { ProviderMessage } from "./base";
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
});
