import { describe, expect, test } from "@/test";
import { makeAnthropicOpenaiAdapterFactory } from "./anthropic-openai";
import {
  converseResponseToOpenai,
  createConverseToOpenaiSseEncoder,
} from "./bedrock-openai-translator";
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

// Bedrock's encoder only emits the usage chunk when the client asked for it.
const BEDROCK_CTX = {
  chatcmplId: "chatcmpl-test",
  createdUnix: 0,
  requestedModel: "archestra:test",
  includeUsageInStream: true,
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
// `prompt_tokens` is the gross prompt count — so an adapter whose provider
// reports cache tokens outside its input count cannot map through the shared
// helper. That is every cache-aware provider behind this surface: Gemini
// (promptTokenCount - cachedContentTokenCount, and its `totalTokenCount` also
// counts thinking tokens), Anthropic and Bedrock (`input_tokens` is what MISSED
// the cache; reads and writes are counted alongside it). Streaming and
// non-streaming answer the same route, so they must report the same numbers for
// the same turn.
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

// A cached agent turn is the normal case for Claude behind the model router:
// almost the whole prompt is read back from the cache and only a few tokens
// miss. Mapping Anthropic's `input_tokens` straight onto `prompt_tokens` — as
// both surfaces did — reported that handful as the entire prompt and dropped
// the cache read from the wire altogether, so a client (or a chained Archestra,
// which recovers the split as `prompt_tokens - cached_tokens`) billed a 91k
// prompt as 4 tokens of input and no cache at all.
describe("anthropic-openai reports the gross prompt count", () => {
  const usage = {
    input_tokens: 4,
    output_tokens: 55,
    cache_read_input_tokens: 90_000,
    cache_creation_input_tokens: 1_200,
  };
  // 4 missed + 90_000 read back + 1_200 newly written.
  const expected = {
    prompt_tokens: 91_204,
    completion_tokens: 55,
    total_tokens: 91_259,
    prompt_tokens_details: { cached_tokens: 90_000 },
  };
  const response = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-5",
    content: [{ type: "text", text: "hi", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };

  test("streams cache reads and writes as part of the prompt", () => {
    const adapter =
      makeAnthropicOpenaiAdapterFactory(TRANSLATOR_CTX).createStreamAdapter();
    adapter.processChunk({
      type: "message_start",
      message: { id: "msg_1", model: "claude-opus-4-5", usage },
    } as never);

    expect(usageOf(adapter.formatEndSSE())).toEqual(expected);
  });

  test("matches the non-streaming translation exactly", () => {
    const adapter = makeAnthropicOpenaiAdapterFactory(
      TRANSLATOR_CTX,
    ).createResponseAdapter(response as never);

    expect(
      (adapter.getOriginalResponse() as unknown as { usage: unknown }).usage,
    ).toEqual(expected);
  });

  test("omits cached_tokens when nothing was read from the cache", () => {
    const adapter =
      makeAnthropicOpenaiAdapterFactory(TRANSLATOR_CTX).createStreamAdapter();
    adapter.processChunk({
      type: "message_start",
      message: {
        id: "msg_1",
        model: "claude-opus-4-5",
        usage: { input_tokens: 100, output_tokens: 40 },
      },
    } as never);

    expect(usageOf(adapter.formatEndSSE())).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
    });
  });
});

// Converse counts cache reads/writes alongside `inputTokens`, not inside it —
// which is why its own `totalTokens` exceeded the `prompt + completion` this
// surface reported. Same defect, same shape, for Claude on Bedrock.
describe("bedrock-openai reports the gross prompt count", () => {
  const bedrockUsage = {
    inputTokens: 4,
    outputTokens: 55,
    cacheReadInputTokens: 90_000,
    cacheWriteInputTokens: 1_200,
    totalTokens: 91_259,
  };
  const expected = {
    prompt_tokens: 91_204,
    completion_tokens: 55,
    total_tokens: 91_259,
    prompt_tokens_details: { cached_tokens: 90_000 },
  };

  test("translates a non-streaming Converse response", () => {
    expect(
      converseResponseToOpenai(
        {
          output: { message: { role: "assistant", content: [{ text: "hi" }] } },
          stopReason: "end_turn",
          usage: bedrockUsage,
        } as never,
        BEDROCK_CTX,
      ).usage,
    ).toEqual(expected);
  });

  test("emits the same counts on the stream's usage chunk", () => {
    const chunk = createConverseToOpenaiSseEncoder(
      BEDROCK_CTX,
    ).encodeBedrockEvent({ metadata: { usage: bedrockUsage } } as never);

    expect(chunk).not.toBeNull();
    expect(usageOf(chunk as Uint8Array)).toEqual(expected);
  });
});
