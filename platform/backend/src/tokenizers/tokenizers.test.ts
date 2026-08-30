import { describe, expect, test, vi } from "@/test";
import { AnthropicTokenizer } from "./anthropic";
import { BaseTokenizer, type ProviderMessage } from "./base";
import { getTokenizer } from "./index";
import { TiktokenTokenizer } from "./tiktoken";

describe("Tokenizers", () => {
  describe("TiktokenTokenizer", () => {
    test("counts a fixed string message with cl100k_base", () => {
      const tokenizer = new TiktokenTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: "Hello, world!",
      };

      expect(tokenizer.countTokens(message)).toBe(5);
    });

    test("concatenates text content blocks before encoding", () => {
      const tokenizer = new TiktokenTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      };

      expect(tokenizer.countTokens(message)).toBe(3);
    });

    test("sums separately encoded messages", () => {
      const tokenizer = new TiktokenTokenizer();
      const messages: ProviderMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ];

      expect(tokenizer.countTokens(messages)).toBe(10);
    });

    test("should handle empty messages", () => {
      const tokenizer = new TiktokenTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: "",
      };

      // The role still contributes to an otherwise empty message.
      expect(tokenizer.countTokens(message)).toBe(1);
    });
  });

  describe("AnthropicTokenizer", () => {
    test("counts a fixed string message with Anthropic's tokenizer", () => {
      const tokenizer = new AnthropicTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: "Hello, world!",
      };

      expect(tokenizer.countTokens(message)).toBe(5);
    });

    test("concatenates text content blocks before encoding", () => {
      const tokenizer = new AnthropicTokenizer();
      const message: ProviderMessage = {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      };

      expect(tokenizer.countTokens(message)).toBe(3);
    });

    test("sums separately encoded messages", () => {
      const tokenizer = new AnthropicTokenizer();
      const messages: ProviderMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ];

      expect(tokenizer.countTokens(messages)).toBe(10);
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

    test("should count Claude served by a reseller with the Anthropic tokenizer", () => {
      // Bedrock and OpenRouter front several vendors, so the provider id alone
      // picks the wrong encoder for a Claude model — and that estimate is what
      // decides when auto-compaction fires and whether a turn is let through to
      // the provider, both measured against that model's own context window.
      expect(getTokenizer("bedrock", "us.anthropic.claude-opus-4-8")).toBe(
        getTokenizer("anthropic"),
      );
      expect(getTokenizer("bedrock", "anthropic.claude-opus-4-8")).toBe(
        getTokenizer("anthropic"),
      );
      expect(
        getTokenizer("bedrock", "global.anthropic.claude-sonnet-4-6"),
      ).toBe(getTokenizer("anthropic"));
      expect(getTokenizer("openrouter", "anthropic/claude-opus-4-8")).toBe(
        getTokenizer("anthropic"),
      );
    });

    test("should keep the provider default for non-Anthropic reseller models", () => {
      expect(getTokenizer("bedrock", "us.amazon.nova-pro-v1:0")).toBe(
        getTokenizer("openai"),
      );
      expect(getTokenizer("bedrock", "us.meta.llama3-70b-instruct-v1:0")).toBe(
        getTokenizer("openai"),
      );
      expect(getTokenizer("openrouter", "openai/gpt-5.5")).toBe(
        getTokenizer("openai"),
      );
      // Azure fronts a single vendor whose models cl100k_base already fits.
      expect(getTokenizer("azure", "gpt-5.5")).toBe(getTokenizer("openai"));
    });

    test("should fall back to the provider default when no model is given", () => {
      expect(getTokenizer("bedrock")).toBe(getTokenizer("openai"));
      expect(getTokenizer("bedrock", null)).toBe(getTokenizer("openai"));
    });

    test("counts code-dense text with the selected model tokenizer", () => {
      // Why the reseller mapping is load-bearing rather than cosmetic: the two
      // encoders agree on prose and diverge on the code/identifier-heavy
      // payloads that dominate long tool-using conversations. The direction of
      // the gap depends on the content, so what matters is that a Claude model
      // is measured on Claude's own yardstick — the estimate is compared
      // against that model's context window.
      const message: ProviderMessage = {
        role: "user",
        content:
          `export function resolveTargets(modelId: string) {\n  const withoutRegion = modelId.replace(REGION_PREFIX, "");\n  return withoutRegion;\n}\n`.repeat(
            60,
          ),
      };
      const claudeOnBedrock = getTokenizer(
        "bedrock",
        "us.anthropic.claude-opus-4-8",
      ).countTokens(message);
      const cl100k = getTokenizer("bedrock").countTokens(message);

      expect(claudeOnBedrock).toBe(2101);
      expect(cl100k).toBe(1741);
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
