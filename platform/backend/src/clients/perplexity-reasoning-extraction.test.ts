import { HttpResponse, http } from "msw";
import { createDirectLLMModel, type LLMModel } from "@/clients/llm-client";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";

/**
 * Pins the Perplexity reasoning extraction in the model factory.
 *
 * Perplexity reasoning models (sonar-reasoning-pro) stream their chain of
 * thought as inline <think>…</think> text in `content` — there is no
 * reasoning_content field — so the factory wraps the model with
 * extractReasoningMiddleware. These tests drive the real factory against a
 * mocked wire and fail if the wrap is dropped or the middleware stops
 * extracting: raw <think> text would then leak into chat answers again.
 */

type StreamPart = {
  type: string;
  delta?: string;
  finishReason?: { unified?: string };
  usage?: {
    inputTokens?: { total?: number };
    outputTokens?: { total?: number };
  };
};

const PROMPT = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "How many r's in strawberry?" }],
  },
];

// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper (per-test MSW server), not a React hook
const server = useMswServer();

describe("perplexity reasoning extraction", () => {
  test("streams <think> content as reasoning parts before the text part", async () => {
    serveSse(["<think>Let me ", "count.</think>", "There are three."]);

    const parts = await streamParts();
    const types = parts.map((part) => part.type);

    const reasoningStart = types.indexOf("reasoning-start");
    const textStart = types.indexOf("text-start");
    expect(reasoningStart).toBeGreaterThanOrEqual(0);
    expect(textStart).toBeGreaterThanOrEqual(0);
    expect(reasoningStart).toBeLessThan(textStart);

    expect(joinedDeltas(parts, "reasoning-delta")).toBe("Let me count.");
    expect(joinedDeltas(parts, "text-delta")).toBe("There are three.");
    // The tags themselves must not leak into either channel.
    expect(joinedDeltas(parts, "text-delta")).not.toContain("think");

    // Usage still arrives on the finish part — cost accounting is unaffected.
    const finish = parts.find((part) => part.type === "finish");
    expect(finish?.finishReason?.unified).toBe("stop");
    expect(finish?.usage?.inputTokens?.total).toBe(5);
    expect(finish?.usage?.outputTokens?.total).toBe(10);
  });

  test("extracts reasoning when tags are split across stream chunks", async () => {
    serveSse(["<thi", "nk>pondering</th", "ink>Done."]);

    const parts = await streamParts();

    expect(joinedDeltas(parts, "reasoning-delta")).toBe("pondering");
    expect(joinedDeltas(parts, "text-delta")).toBe("Done.");
  });

  test("passes tagless responses through unchanged", async () => {
    serveSse(["Hello", " there."]);

    const parts = await streamParts();

    expect(joinedDeltas(parts, "text-delta")).toBe("Hello there.");
    expect(parts.map((part) => part.type)).not.toContain("reasoning-start");
  });
});

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/** Serves one streamed chat completion whose content deltas are `deltas`. */
function serveSse(deltas: string[]) {
  const events = [
    ...deltas.map((delta) =>
      chunk({ delta: { role: "assistant", content: delta } }),
    ),
    chunk({
      delta: {},
      finish_reason: "stop",
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    }),
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  server.use(
    http.post(
      "https://api.perplexity.ai/chat/completions",
      () =>
        new HttpResponse(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    ),
  );
}

/** One OpenAI-style chat completion SSE chunk, as Perplexity puts it on the wire. */
function chunk({
  delta,
  finish_reason = null,
  usage,
}: {
  delta: Record<string, unknown>;
  finish_reason?: string | null;
  usage?: Record<string, number>;
}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1720000000,
    model: "sonar-reasoning-pro",
    choices: [{ index: 0, delta, finish_reason }],
    ...(usage ? { usage } : {}),
  };
}

/** Streams one completion through the real factory-built model. */
async function streamParts(): Promise<StreamPart[]> {
  // Exclude the plain-string model ids from the union so doStream is typed.
  const model = createDirectLLMModel({
    provider: "perplexity",
    apiKey: "test-key",
    modelName: "sonar-reasoning-pro",
    baseUrl: null,
  }) as Exclude<LLMModel, string>;
  const { stream } = await model.doStream({ prompt: PROMPT });
  const parts: StreamPart[] = [];
  const reader = (stream as unknown as ReadableStream<StreamPart>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

function joinedDeltas(parts: StreamPart[], type: string): string {
  return parts
    .filter((part) => part.type === type)
    .map((part) => part.delta ?? "")
    .join("");
}
