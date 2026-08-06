import { describe, expect, test } from "@/test";
import { azureResponsesAdapterFactory } from "./azure-responses";
import { openaiAdapterFactory } from "./openai";
import { openAiResponsesAdapterFactory } from "./openai-responses";
import { makeResponsesFromChatAdapterFactory } from "./openai-responses-from-chat";
import { perplexityResponsesAdapterFactory } from "./perplexity-responses";
import { fromResponsesUsage, toResponsesUsage } from "./responses-usage";

// When the proxy replaces a turn — a tool-invocation refusal, or the dual-LLM
// guardrail failing closed — it synthesizes the whole Responses stream itself
// instead of relaying upstream's. That synthesized `response.completed` is the
// client's only usage report for the turn, and it used to hard-code every token
// count to zero, so a refused turn always looked free.
//
// It also has to stay NUMERIC even when nothing was accumulated: the Responses
// parser's `response.completed` arm requires numeric `usage.input_tokens` and
// `usage.output_tokens`, and a frame missing them matches the union's
// permissive unknown-chunk fallback and is dropped silently — the turn then
// ends with no tokens and a default finish reason.
const RESPONSES_CTX = {
  responseId: "resp_test",
  createdUnix: 0,
  requestedModel: "archestra:test",
};

const FACTORIES = {
  "openai-responses": () => openAiResponsesAdapterFactory.createStreamAdapter(),
  "azure-responses": () => azureResponsesAdapterFactory.createStreamAdapter(),
  // Composes from the OpenAI Responses factory, so it must inherit the fix.
  "perplexity-responses": () =>
    perplexityResponsesAdapterFactory.createStreamAdapter(),
  // The model router's chat -> Responses translation.
  "responses-from-chat": () =>
    makeResponsesFromChatAdapterFactory(
      openaiAdapterFactory,
      RESPONSES_CTX,
    ).createStreamAdapter(),
};

/** The three transports that read and write the Responses wire shape natively. */
const NATIVE_FACTORIES = {
  "openai-responses": FACTORIES["openai-responses"],
  "azure-responses": FACTORIES["azure-responses"],
  "perplexity-responses": FACTORIES["perplexity-responses"],
};

/** Pull the `response.completed` frame's usage out of a synthesized stream. */
function completedUsage(
  sse: string | Uint8Array | (string | Uint8Array)[],
): Record<string, unknown> {
  const decoder = new TextDecoder();
  const decode = (part: string | Uint8Array) =>
    typeof part === "string" ? part : decoder.decode(part);
  const text = Array.isArray(sse) ? sse.map(decode).join("") : decode(sse);
  const frame = text
    .split("\n\n")
    .map((block) => block.replace(/^data: /, "").trim())
    .filter((block) => block.startsWith("{"))
    .map((block) => JSON.parse(block) as Record<string, unknown>)
    .find((event) => event.type === "response.completed");

  expect(frame, "no response.completed frame was emitted").toBeDefined();
  const response = (frame as { response: { usage?: Record<string, unknown> } })
    .response;
  return response.usage as Record<string, unknown>;
}

describe("Responses adapters report real usage on a synthesized completion", () => {
  for (const [name, make] of Object.entries(FACTORIES)) {
    test(`${name}: reports the accumulated tokens, not zeros`, () => {
      const adapter = make();
      adapter.state.usage = {
        inputTokens: 1200,
        outputTokens: 350,
        reasoningTokens: 200,
        cacheReadTokens: 900,
      };

      const usage = completedUsage(adapter.formatCompleteTextSSE("refused"));

      // The accumulator holds UNCACHED input; the wire field is the gross
      // prompt count, so the cache read is added back: 1200 + 900.
      expect(usage).toMatchObject({
        input_tokens: 2100,
        output_tokens: 350,
        total_tokens: 2450,
      });
    });

    test(`${name}: still emits numeric usage when nothing was accumulated`, () => {
      const adapter = make();
      adapter.state.usage = null;

      const usage = completedUsage(adapter.formatCompleteTextSSE("refused"));

      // Absence is what the parser drops; zero is a value it can read.
      expect(usage).toBeDefined();
      expect(typeof usage.input_tokens).toBe("number");
      expect(typeof usage.output_tokens).toBe("number");
    });
  }
});

// `UsageView.inputTokens` is uncached input only, but the Responses wire counts
// cache reads INSIDE `input_tokens`. Both directions of that split live in
// responses-usage.ts, and they have to stay inverse: a refusal reports the same
// prompt count as the turn it replaced, and the recorded cost prices the cached
// portion at the provider's read rate instead of the full input rate.
const UPSTREAM_USAGE = {
  input_tokens: 4321,
  input_tokens_details: { cached_tokens: 4000 },
  output_tokens: 77,
  output_tokens_details: { reasoning_tokens: 11 },
  total_tokens: 4398,
};

describe("Responses usage splits cache reads out of the gross input", () => {
  test("reading subtracts the cache read and records it", () => {
    expect(fromResponsesUsage(UPSTREAM_USAGE)).toEqual({
      inputTokens: 321,
      outputTokens: 77,
      cacheReadTokens: 4000,
      cacheWriteTokens: 0,
      reasoningTokens: 11,
    });
  });

  test("a body with no usage reads as zeros rather than throwing", () => {
    expect(fromResponsesUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });

  test("writing puts the cache read back, so the split round-trips", () => {
    expect(toResponsesUsage(fromResponsesUsage(UPSTREAM_USAGE))).toEqual(
      UPSTREAM_USAGE,
    );
  });

  for (const [name, make] of Object.entries(NATIVE_FACTORIES)) {
    test(`${name}: a refusal reports upstream's own prompt count`, () => {
      const adapter = make();
      adapter.processChunk({
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-4o",
          status: "completed",
          output: [],
          usage: UPSTREAM_USAGE,
        },
      } as never);

      // What the interaction row and cost calculation read...
      expect(adapter.state.usage).toMatchObject({
        inputTokens: 321,
        cacheReadTokens: 4000,
      });
      // ...and what the client reads, unchanged from what the provider sent.
      expect(completedUsage(adapter.formatCompleteTextSSE("refused"))).toEqual(
        UPSTREAM_USAGE,
      );
    });
  }
});
