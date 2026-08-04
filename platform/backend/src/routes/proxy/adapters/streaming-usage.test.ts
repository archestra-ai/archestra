import { describe, expect, test } from "@/test";
import { makeAnthropicOpenaiAdapterFactory } from "./anthropic-openai";
import { cerebrasAdapterFactory } from "./cerebras";
import { makeCohereOpenaiAdapterFactory } from "./cohere-openai";
import { makeGeminiOpenaiAdapterFactory } from "./gemini-openai";
import { geminiResponseToOpenai } from "./gemini-openai-translator";
import { ollamaAdapterFactory } from "./ollama";
import { openaiAdapterFactory } from "./openai";
import { perplexityAdapterFactory } from "./perplexity";
import { vllmAdapterFactory } from "./vllm";
import { zhipuaiAdapterFactory } from "./zhipuai";

// Every adapter that synthesizes its final streaming chunk in the OpenAI
// chat-completions shape must carry the provider's accumulated usage into that
// chunk, otherwise streaming clients see no token counts — including another
// Archestra chained to this one through the `archestra` provider, which then
// records every proxied call with zero tokens and no cost.
//
// This roster is the anti-drift mechanism, so it has to stay exhaustive: zhipuai
// and perplexity were missing from it and both had silently dropped usage. When
// you add an adapter that builds its own final chunk, add it here too.
//
// Deliberately NOT listed: bedrock-openai, which emits usage as a separate
// `choices: []` chunk gated on the client's own `stream_options.include_usage`
// (bedrock-openai-translator.ts) rather than on the synthesized final chunk, and
// is covered by bedrock-openai-sse.test.ts.
const FACTORIES = {
  openai: openaiAdapterFactory,
  vllm: vllmAdapterFactory,
  ollama: ollamaAdapterFactory,
  cerebras: cerebrasAdapterFactory,
  zhipuai: zhipuaiAdapterFactory,
  perplexity: perplexityAdapterFactory,
};

function usageOf(endSse: string | Uint8Array): unknown {
  const text =
    typeof endSse === "string" ? endSse : new TextDecoder().decode(endSse);
  const firstData = text.split("\n\n")[0].replace(/^data: /, "");
  return (JSON.parse(firstData) as { usage?: unknown }).usage;
}

describe("OpenAI-compatible stream adapters carry usage into the final SSE", () => {
  for (const [name, factory] of Object.entries(FACTORIES)) {
    test(`${name}: emits accumulated usage`, () => {
      const adapter = factory.createStreamAdapter();
      const base = {
        id: "chatcmpl-1",
        object: "chat.completion.chunk" as const,
        created: 0,
        model: "m",
      };
      adapter.processChunk({
        ...base,
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      } as never);
      adapter.processChunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      } as never);
      // Trailing usage-only chunk, as OpenAI-compatible providers send with include_usage.
      adapter.processChunk({
        ...base,
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      } as never);

      expect(usageOf(adapter.formatEndSSE())).toEqual({
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140,
      });
    });

    test(`${name}: omits usage when the provider sent none`, () => {
      const adapter = factory.createStreamAdapter();
      adapter.processChunk({
        id: "chatcmpl-2",
        object: "chat.completion.chunk" as const,
        created: 0,
        model: "m",
        choices: [
          { index: 0, delta: { content: "hi" }, finish_reason: "stop" },
        ],
      } as never);

      expect(usageOf(adapter.formatEndSSE())).toBeUndefined();
    });
  }
});

// The `*-openai` translators expose a non-OpenAI provider through the OpenAI
// chat-completions surface (this is what the `archestra` provider and the model
// router speak). They wrap an inner native adapter and share one envelope
// encoder, so the guard here asserts the invariant directly on the accumulator:
// whatever the inner adapter accumulated must reach the client's final chunk.
// All three shipped without it, so a client streaming Claude/Gemini/Cohere
// through the OpenAI surface saw no token counts at all.
const TRANSLATOR_CTX = {
  chatcmplId: "chatcmpl-test",
  createdUnix: 0,
  requestedModel: "archestra:test",
};

const TRANSLATORS = {
  "anthropic-openai": () =>
    makeAnthropicOpenaiAdapterFactory(TRANSLATOR_CTX).createStreamAdapter(),
  "cohere-openai": () =>
    makeCohereOpenaiAdapterFactory(TRANSLATOR_CTX).createStreamAdapter(),
  "gemini-openai": () =>
    makeGeminiOpenaiAdapterFactory(TRANSLATOR_CTX).createStreamAdapter(),
};

describe("OpenAI-compat translators carry usage into the final SSE", () => {
  for (const [name, make] of Object.entries(TRANSLATORS)) {
    test(`${name}: emits accumulated usage`, () => {
      const adapter = make();
      adapter.state.usage = { inputTokens: 100, outputTokens: 40 };

      expect(usageOf(adapter.formatEndSSE())).toEqual({
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140,
      });
    });

    test(`${name}: omits usage when the provider reported none`, () => {
      const adapter = make();
      adapter.state.usage = null;

      expect(usageOf(adapter.formatEndSSE())).toBeUndefined();
    });
  }
});

// `UsageView.inputTokens` is normalized to *uncached* input, but OpenAI's
// `prompt_tokens` is the gross prompt count — so an adapter whose accumulator
// subtracts cache reads cannot map through the shared helper. Gemini is the one
// that does (promptTokenCount - cachedContentTokenCount), and its `totalTokenCount`
// additionally counts thinking tokens. Streaming and non-streaming answer the
// same route, so they must report the same numbers for the same turn.
describe("gemini-openai reports the same usage streaming and non-streaming", () => {
  const geminiResponse = {
    candidates: [
      {
        content: { parts: [{ text: "hi" }], role: "model" },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 2000,
      cachedContentTokenCount: 1800,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 500,
      totalTokenCount: 2600,
    },
  };

  test("streams the gross prompt count, not the cache-adjusted one", () => {
    const adapter =
      makeGeminiOpenaiAdapterFactory(TRANSLATOR_CTX).createStreamAdapter();
    // What the native Gemini adapter accumulates for the response above.
    adapter.state.usage = {
      inputTokens: 200, // 2000 - 1800 cached
      outputTokens: 100,
      cacheReadTokens: 1800,
      cacheWriteTokens: 0,
      reasoningTokens: 500,
    };
    adapter.processChunk(geminiResponse as never);

    expect(usageOf(adapter.formatEndSSE())).toEqual({
      prompt_tokens: 2000,
      completion_tokens: 100,
      total_tokens: 2600,
    });
  });

  test("matches the non-streaming translation exactly", () => {
    const adapter =
      makeGeminiOpenaiAdapterFactory(TRANSLATOR_CTX).createStreamAdapter();
    adapter.processChunk(geminiResponse as never);

    expect(usageOf(adapter.formatEndSSE())).toEqual(
      geminiResponseToOpenai(geminiResponse as never, TRANSLATOR_CTX).usage,
    );
  });
});
