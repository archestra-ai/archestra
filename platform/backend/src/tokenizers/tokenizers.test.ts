import { describe, expect, test } from "vitest";
import { AnthropicTokenizer } from "./anthropic";
import type { ProviderMessage } from "./base";
import { getTokenizerForProvider } from "./index";
import { TiktokenTokenizer } from "./tiktoken";

describe("Tokenizers", () => {
  describe("TiktokenTokenizer", () => {
    test("should count tokens in a simple string message", () => {
      const tokenizer = new TiktokenTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: "Hello, world!",
      };

      const tokenCount = tokenizer.countMessageTokens(message);

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

      const tokenCount = tokenizer.countMessageTokens(message);

      expect(tokenCount).toBeGreaterThan(0);
    });

    test("should count tokens in multiple messages", () => {
      const tokenizer = new TiktokenTokenizer();
      const messages: ProviderMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ];

      const tokenCount = tokenizer.countMessagesTokens(messages);

      expect(tokenCount).toBeGreaterThan(0);
    });

    test("should handle empty messages", () => {
      const tokenizer = new TiktokenTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: "",
      };

      const tokenCount = tokenizer.countMessageTokens(message);

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

      const tokenCount = tokenizer.countMessageTokens(message);

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

      const tokenCount = tokenizer.countMessageTokens(message);

      expect(tokenCount).toBeGreaterThan(0);
    });

    test("should count tokens in multiple messages", () => {
      const tokenizer = new AnthropicTokenizer();
      const messages: ProviderMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ];

      const tokenCount = tokenizer.countMessagesTokens(messages);

      expect(tokenCount).toBeGreaterThan(0);
    });
  });

  describe("getTokenizerForProvider", () => {
    test("should return AnthropicTokenizer for anthropic provider", () => {
      const tokenizer = getTokenizerForProvider("anthropic");

      expect(tokenizer).toBeInstanceOf(AnthropicTokenizer);
    });

    test("should return TiktokenTokenizer for openai provider", () => {
      const tokenizer = getTokenizerForProvider("openai");

      expect(tokenizer).toBeInstanceOf(TiktokenTokenizer);
    });

    test("should return TiktokenTokenizer for gemini provider", () => {
      const tokenizer = getTokenizerForProvider("gemini");

      expect(tokenizer).toBeInstanceOf(TiktokenTokenizer);
    });

    test("should return consistent token counts for same input", () => {
      const anthropicTokenizer = getTokenizerForProvider("anthropic");
      const openaiTokenizer = getTokenizerForProvider("openai");

      const message: ProviderMessage = {
        role: "user",
        content: "This is a test message",
      };

      const anthropicCount = anthropicTokenizer.countMessageTokens(message);
      const openaiCount = openaiTokenizer.countMessageTokens(message);

      // Token counts should be in the same ballpark (within 20% of each other)
      expect(anthropicCount).toBeGreaterThan(0);
      expect(openaiCount).toBeGreaterThan(0);
      expect(Math.abs(anthropicCount - openaiCount)).toBeLessThan(
        Math.max(anthropicCount, openaiCount) * 0.2,
      );
    });
  });
});
