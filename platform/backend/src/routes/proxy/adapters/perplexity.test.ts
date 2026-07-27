import { perplexityAdapterFactory } from "@/routes/proxy/adapters/perplexity";
import { describe, expect, test } from "@/test";
import type { Perplexity } from "@/types";

/**
 * Pins Perplexity reasoning surfacing.
 *
 * Perplexity emits no chain of thought under its default `full` stream mode —
 * the inline <think> text it used to put in `content` is gone. Reasoning is
 * only available via `stream_mode: "concise"`, which carries it in dedicated
 * `chat.reasoning` chunks that no OpenAI-compatible client understands. The
 * adapter opts reasoning models into that mode and re-emits the steps as
 * <think> content so downstream reasoning parsers can surface them.
 */

type StreamChunk = Perplexity.Types.ChatCompletionChunk;

describe("perplexity request adapter: stream mode", () => {
  test("opts reasoning models into concise streaming", () => {
    const request = makeRequest({
      model: "sonar-reasoning-pro",
      stream: true,
    });

    const result = perplexityAdapterFactory
      .createRequestAdapter(request)
      .toProviderRequest();

    expect(result.stream_mode).toBe("concise");
  });

  test("leaves tagless models on the default wire format", () => {
    const request = makeRequest({ model: "sonar-pro", stream: true });

    const result = perplexityAdapterFactory
      .createRequestAdapter(request)
      .toProviderRequest();

    expect(result.stream_mode).toBeUndefined();
  });

  test("leaves sonar-deep-research on the default wire format", () => {
    // Deep research exposes no reasoning on this API in any mode; under
    // concise it streams an empty reasoning stage, so the opt-in would change
    // its wire format for nothing.
    const request = makeRequest({ model: "sonar-deep-research", stream: true });

    const result = perplexityAdapterFactory
      .createRequestAdapter(request)
      .toProviderRequest();

    expect(result.stream_mode).toBeUndefined();
  });

  test("does not request concise mode for non-streaming calls", () => {
    const request = makeRequest({
      model: "sonar-reasoning-pro",
      stream: false,
    });

    const result = perplexityAdapterFactory
      .createRequestAdapter(request)
      .toProviderRequest();

    expect(result.stream_mode).toBeUndefined();
  });

  test("honours a stream mode the caller chose explicitly", () => {
    const request = makeRequest({
      model: "sonar-reasoning-pro",
      stream: true,
      stream_mode: "full",
    });

    const result = perplexityAdapterFactory
      .createRequestAdapter(request)
      .toProviderRequest();

    expect(result.stream_mode).toBe("full");
  });
});

describe("perplexity stream adapter: concise reasoning", () => {
  test("re-emits reasoning steps as a <think> block before the answer", () => {
    const adapter = perplexityAdapterFactory.createStreamAdapter();

    const streamed = [
      adapter.processChunk(reasoningChunk(["Searching the web..."])),
      adapter.processChunk(reasoningChunk(["Found 15 results"])),
      adapter.processChunk(reasoningDoneChunk()),
      adapter.processChunk(contentChunk("There are 3 r's.")),
    ];

    expect(contentOf(streamed)).toBe(
      "<think>Searching the web...\nFound 15 results</think>\n\nThere are 3 r's.",
    );
  });

  test("does not repeat steps the reasoning-done chunk replays", () => {
    const adapter = perplexityAdapterFactory.createStreamAdapter();

    const streamed = [
      adapter.processChunk(reasoningChunk(["Searching the web..."])),
      // The done chunk carries every accumulated step, not just new ones.
      adapter.processChunk(
        reasoningDoneChunk(["Searching the web...", "Found 15 results"]),
      ),
    ];

    expect(contentOf(streamed)).toBe(
      "<think>Searching the web...\nFound 15 results</think>\n\n",
    );
  });

  test("closes an unterminated reasoning block when the answer starts", () => {
    const adapter = perplexityAdapterFactory.createStreamAdapter();

    const streamed = [
      adapter.processChunk(reasoningChunk(["Thinking..."])),
      // No reasoning-done chunk: without the guard the answer would be
      // swallowed into the reasoning block.
      adapter.processChunk(contentChunk("Answer.")),
    ];

    expect(contentOf(streamed)).toBe("<think>Thinking...</think>\n\nAnswer.");
  });

  test("ends the stream on the concise terminal chunk", () => {
    const adapter = perplexityAdapterFactory.createStreamAdapter();

    adapter.processChunk(reasoningChunk(["Thinking..."]));
    const midStream = adapter.processChunk(contentChunk("Answer."));
    const terminal = adapter.processChunk(completionDoneChunk());

    expect(midStream.isFinal).toBe(false);
    expect(terminal.isFinal).toBe(true);
    expect(adapter.toProviderResponse().usage?.completion_tokens).toBe(10);
  });

  test("keeps reasoning text out of the recorded answer", () => {
    const adapter = perplexityAdapterFactory.createStreamAdapter();

    adapter.processChunk(reasoningChunk(["Thinking..."]));
    adapter.processChunk(reasoningDoneChunk());
    adapter.processChunk(contentChunk("There are 3 r's."));
    adapter.processChunk(completionDoneChunk());

    // The interaction log and cost accounting record the answer, not the
    // progress narration the reasoning stage streamed.
    expect(adapter.toProviderResponse().choices[0].message.content).toBe(
      "There are 3 r's.",
    );
  });

  test("passes a full-mode stream through unchanged", () => {
    const adapter = perplexityAdapterFactory.createStreamAdapter();

    const streamed = [
      adapter.processChunk(contentChunk("Hello")),
      adapter.processChunk(contentChunk(" there.")),
    ];

    expect(contentOf(streamed)).toBe("Hello there.");
    expect(streamed.every((result) => result.isFinal)).toBe(false);
  });
});

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function makeRequest(overrides: {
  model: string;
  stream: boolean;
  stream_mode?: "full" | "concise";
}): Perplexity.Types.ChatCompletionsRequest {
  return {
    messages: [{ role: "user", content: "How many r's in strawberry?" }],
    ...overrides,
  } as Perplexity.Types.ChatCompletionsRequest;
}

/** A concise-mode chunk streamed during the reasoning stage. */
function reasoningChunk(thoughts: string[]): StreamChunk {
  return conciseChunk("chat.reasoning", {
    reasoning_steps: thoughts.map((thought) => ({
      thought,
      type: "web_search",
    })),
  });
}

/** The chunk closing the reasoning stage; it replays accumulated steps. */
function reasoningDoneChunk(thoughts: string[] = []): StreamChunk {
  return conciseChunk("chat.reasoning.done", {
    reasoning_steps: thoughts.map((thought) => ({
      thought,
      type: "web_search",
    })),
  });
}

function contentChunk(content: string): StreamChunk {
  return conciseChunk("chat.completion.chunk", { content });
}

/** The concise-mode terminal chunk carrying final usage. */
function completionDoneChunk(): StreamChunk {
  return {
    ...conciseChunk("chat.completion.done", { content: "", role: "assistant" }),
    usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  } as StreamChunk;
}

function conciseChunk(
  object: string,
  delta: Record<string, unknown>,
): StreamChunk {
  return {
    id: "chatcmpl-test",
    object,
    created: 1720000000,
    model: "sonar-reasoning-pro",
    choices: [{ index: 0, delta, finish_reason: null }],
  } as unknown as StreamChunk;
}

/** Concatenates the content deltas of every SSE payload the adapter emitted. */
function contentOf(results: { sseData: string | Uint8Array | null }[]): string {
  return results
    .flatMap((result) => (result.sseData?.toString() ?? "").split("\n\n"))
    .filter((event) => event.startsWith("data: "))
    .map((event) => JSON.parse(event.slice(6)))
    .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
    .join("");
}
