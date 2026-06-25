import { describe, expect, test } from "@/test";
import { cerebrasAdapterFactory } from "./cerebras";
import { ollamaAdapterFactory } from "./ollama";
import { openaiAdapterFactory } from "./openai";
import { vllmAdapterFactory } from "./vllm";

// These four adapters are OpenAI-compatible and each synthesize their final streaming chunk the same
// way. They must all carry the provider's accumulated usage into that chunk, otherwise streaming
// clients see no token counts. One parametrized guard keeps the four copies from drifting apart.
const FACTORIES = {
  openai: openaiAdapterFactory,
  vllm: vllmAdapterFactory,
  ollama: ollamaAdapterFactory,
  cerebras: cerebrasAdapterFactory,
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
