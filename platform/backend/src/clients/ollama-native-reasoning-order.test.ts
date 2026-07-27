import { createOllama } from "ollama-ai-provider-v2";
import { describe, expect, test } from "@/test";

/**
 * Pins the stream-part ordering of the patched ollama-ai-provider-v2
 * (patches/ollama-ai-provider-v2@3.6.0.patch).
 *
 * Native Ollama `/api/chat` sends `"content": ""` on every thinking-phase
 * chunk. Unpatched, the package opened the text part on `content != null` and
 * processed text before thinking, so the assistant message's text part was
 * created before its reasoning part and chat rendered the answer above the
 * thinking block. If a package bump drops the patch, these tests fail.
 */

type StreamPart = { type: string; id?: string; delta?: string };

const PROMPT = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "How many r's in strawberry?" }],
  },
];

describe("ollama-ai-provider-v2 reasoning ordering (patched)", () => {
  test("opens the reasoning part before the text part when thinking streams first", async () => {
    const model = makeModel(
      ndjson([
        wireChunk({ role: "assistant", content: "", thinking: "Let me " }),
        wireChunk({ role: "assistant", content: "", thinking: "count." }),
        wireChunk({ role: "assistant", content: "There are" }),
        wireChunk({ role: "assistant", content: " three." }),
        wireChunk(
          { role: "assistant", content: "" },
          {
            done: true,
            done_reason: "stop",
            prompt_eval_count: 5,
            eval_count: 10,
          },
        ),
      ]),
    );

    const { stream } = await model.doStream({ prompt: PROMPT });
    const parts = await collectParts(stream);
    const types = parts.map((part) => part.type);

    const reasoningStart = types.indexOf("reasoning-start");
    const textStart = types.indexOf("text-start");
    expect(reasoningStart).toBeGreaterThanOrEqual(0);
    expect(textStart).toBeGreaterThanOrEqual(0);
    expect(reasoningStart).toBeLessThan(textStart);

    expect(deltasOf(parts, "reasoning-delta")).toEqual(["Let me ", "count."]);
    // The empty `content` on thinking-phase and done chunks must not leak
    // empty text deltas or open the text part early.
    expect(deltasOf(parts, "text-delta")).toEqual(["There are", " three."]);
  });

  test("emits no text part when the response is thinking only", async () => {
    const model = makeModel(
      ndjson([
        wireChunk({ role: "assistant", content: "", thinking: "Let me " }),
        wireChunk({ role: "assistant", content: "", thinking: "count." }),
        wireChunk(
          { role: "assistant", content: "" },
          { done: true, done_reason: "stop" },
        ),
      ]),
    );

    const { stream } = await model.doStream({ prompt: PROMPT });
    const parts = await collectParts(stream);

    expect(deltasOf(parts, "reasoning-delta")).toEqual(["Let me ", "count."]);
    // Deliberate: all-empty `content` yields zero text parts, matching the
    // OpenAI-compatible `/v1` transport.
    expect(parts.map((part) => part.type)).not.toContain("text-start");
  });

  test("keeps plain text streaming intact for non-thinking responses", async () => {
    const model = makeModel(
      ndjson([
        wireChunk({ role: "assistant", content: "Hello" }),
        wireChunk({ role: "assistant", content: " there." }),
        wireChunk(
          { role: "assistant", content: "" },
          { done: true, done_reason: "stop" },
        ),
      ]),
    );

    const { stream } = await model.doStream({ prompt: PROMPT });
    const parts = await collectParts(stream);

    expect(deltasOf(parts, "text-delta")).toEqual(["Hello", " there."]);
    expect(parts.map((part) => part.type)).not.toContain("reasoning-start");
  });

  test("orders reasoning before text in non-streaming generate results", async () => {
    const model = makeModel(
      JSON.stringify(
        wireChunk(
          {
            role: "assistant",
            content: "There are three.",
            thinking: "Let me count.",
          },
          { done: true, done_reason: "stop" },
        ),
      ),
    );

    const { content } = await model.doGenerate({ prompt: PROMPT });

    expect(content).toEqual([
      expect.objectContaining({ type: "reasoning", text: "Let me count." }),
      expect.objectContaining({ type: "text", text: "There are three." }),
    ]);
  });
});

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/** Builds a chat model whose fetch returns the given canned response body. */
function makeModel(body: string) {
  const fetchStub: typeof globalThis.fetch = async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  return createOllama({
    baseURL: "http://ollama.test/api",
    fetch: fetchStub,
  }).chat("qwen3:0.6b");
}

/** One native `/api/chat` NDJSON object, as Ollama puts it on the wire. */
function wireChunk(
  message: { role: string; content: string; thinking?: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    model: "qwen3:0.6b",
    created_at: "2026-01-01T00:00:00.000Z",
    message,
    done: false,
    ...overrides,
  };
}

function ndjson(chunks: unknown[]): string {
  return `${chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n`;
}

async function collectParts(
  stream: ReadableStream<unknown>,
): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as StreamPart);
  }
  return parts;
}

function deltasOf(
  parts: StreamPart[],
  type: string,
): Array<string | undefined> {
  return parts.filter((part) => part.type === type).map((part) => part.delta);
}
