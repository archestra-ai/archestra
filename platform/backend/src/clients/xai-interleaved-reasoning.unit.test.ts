import { createXai } from "@ai-sdk/xai";
import { readUIMessageStream, streamText, type UIMessage } from "ai";
import { describe, expect, test } from "vitest";

/**
 * Pins how the patched @ai-sdk/xai chat model handles reasoning that resumes
 * after the answer has started (patches/@ai-sdk__xai@3.0.67.patch).
 *
 * Grok can think, write some text, and think again in one response. Every
 * chunk carries the same completion id. Unpatched, the package named both
 * reasoning runs `reasoning-<id>`, closed that part when the text started, and
 * then sent the second run's deltas to the closed part without a new
 * `reasoning-start`. streamText reported "reasoning part … not found", and the
 * chat UI failed with "Received reasoning-delta for missing reasoning part".
 * If a package bump drops the patch, these tests fail.
 */

type StreamPart = { type: string; id?: string; delta?: string };

const COMPLETION_ID = "132291ec-24a5-93e3-af00-329f125b8378";

describe("@ai-sdk/xai interleaved reasoning (patched)", () => {
  test("opens a new reasoning part when reasoning resumes after text", async () => {
    const model = makeModel([
      delta({ role: "assistant", reasoning_content: "Plan the " }),
      delta({ reasoning_content: "answer." }),
      delta({ content: "I'll" }),
      delta({ reasoning_content: "Check the " }),
      delta({ reasoning_content: "policy." }),
      delta({ content: " add the rule." }),
      finish("stop"),
    ]);

    const parts = await collectParts(
      (await model.doStream({ prompt: PROMPT })).stream,
    );

    expect(contentParts(parts)).toEqual([
      ["reasoning-start", "reasoning-A"],
      ["reasoning-delta", "reasoning-A", "Plan the "],
      ["reasoning-delta", "reasoning-A", "answer."],
      ["reasoning-end", "reasoning-A"],
      ["text-start", "text-A"],
      ["text-delta", "text-A", "I'll"],
      ["text-end", "text-A"],
      ["reasoning-start", "reasoning-B"],
      ["reasoning-delta", "reasoning-B", "Check the "],
      ["reasoning-delta", "reasoning-B", "policy."],
      ["reasoning-end", "reasoning-B"],
      ["text-start", "text-B"],
      ["text-delta", "text-B", " add the rule."],
      ["text-end", "text-B"],
    ]);
  });

  test("closes resumed reasoning before a tool call", async () => {
    const model = makeModel([
      delta({ role: "assistant", reasoning_content: "Think." }),
      delta({ content: "Let me look." }),
      delta({ reasoning_content: "Use the tool." }),
      delta({
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"x"}' },
          },
        ],
      }),
      finish("tool_calls"),
    ]);

    const parts = await collectParts(
      (await model.doStream({ prompt: PROMPT, tools: [LOOKUP_TOOL] })).stream,
    );
    const types = parts.map((part) => part.type);

    expect(contentParts(parts).slice(-4)).toEqual([
      ["reasoning-start", "reasoning-B"],
      ["reasoning-delta", "reasoning-B", "Use the tool."],
      ["reasoning-end", "reasoning-B"],
      ["tool-input-start", "call_1"],
    ]);
    expect(types).toContain("tool-call");
    expect(types).not.toContain("error");
  });

  test("keeps a single reasoning-then-text response unchanged", async () => {
    const model = makeModel([
      delta({ role: "assistant", reasoning_content: "Think." }),
      delta({ content: "Hello" }),
      delta({ content: " there." }),
      finish("stop"),
    ]);

    const parts = await collectParts(
      (await model.doStream({ prompt: PROMPT })).stream,
    );

    expect(contentParts(parts)).toEqual([
      ["reasoning-start", "reasoning-A"],
      ["reasoning-delta", "reasoning-A", "Think."],
      ["reasoning-end", "reasoning-A"],
      ["text-start", "text-A"],
      ["text-delta", "text-A", "Hello"],
      ["text-delta", "text-A", " there."],
      ["text-end", "text-A"],
    ]);
  });

  test("chat receives both reasoning runs in order with no stream error", async () => {
    const model = makeModel([
      delta({ role: "assistant", reasoning_content: "Plan." }),
      delta({ content: "I'll" }),
      delta({ reasoning_content: "Check." }),
      delta({ content: " add it." }),
      finish("stop"),
    ]);

    const result = streamText({ model, prompt: "Add the rule." });
    const streamErrors: string[] = [];
    let lastMessage: UIMessage | undefined;
    for await (const message of readUIMessageStream({
      stream: result.toUIMessageStream({
        sendReasoning: true,
        onError: (error) => {
          streamErrors.push(String(error));
          return String(error);
        },
      }),
      terminateOnError: true,
    })) {
      lastMessage = message;
    }

    expect(streamErrors).toEqual([]);
    const parts = lastMessage?.parts.filter(
      (part) => part.type === "reasoning" || part.type === "text",
    );
    expect(parts).toEqual([
      expect.objectContaining({ type: "reasoning", text: "Plan." }),
      expect.objectContaining({ type: "text", text: "I'll" }),
      expect.objectContaining({ type: "reasoning", text: "Check." }),
      expect.objectContaining({ type: "text", text: " add it." }),
    ]);
  });
});

const PROMPT = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Add the rule." }],
  },
];

const LOOKUP_TOOL = {
  type: "function",
  name: "lookup",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
} as const;

function delta(value: Record<string, unknown>) {
  return {
    id: COMPLETION_ID,
    created: 1_760_000_000,
    model: "grok-4.7",
    choices: [{ index: 0, delta: value, finish_reason: null }],
  };
}

function finish(reason: string) {
  return {
    id: COMPLETION_ID,
    created: 1_760_000_000,
    model: "grok-4.7",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
  };
}

function makeModel(chunks: unknown[]) {
  const body = `${chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return createXai({
    apiKey: "test-key",
    baseURL: "http://xai.test/v1",
    fetch: async () =>
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
      }),
  })("grok-4.7");
}

async function collectParts(
  stream: ReadableStream<unknown>,
): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream as unknown as AsyncIterable<StreamPart>) {
    parts.push(part);
  }
  return parts;
}

/**
 * Text, reasoning and tool-input parts as [type, id, delta?], with each
 * distinct id renamed by kind and order of appearance ("reasoning-A",
 * "text-A", …) so the assertions read without the provider's id scheme.
 */
function contentParts(parts: StreamPart[]): string[][] {
  const aliases = new Map<string, string>();
  const counts = { reasoning: 0, text: 0 };
  return parts
    .filter(
      (part) =>
        /^(reasoning|text)-(start|delta|end)$/.test(part.type) ||
        part.type === "tool-input-start",
    )
    .map((part) => {
      const id = part.id ?? "";
      if (part.type === "tool-input-start") return [part.type, id];
      const kind = part.type.startsWith("reasoning") ? "reasoning" : "text";
      const key = `${kind}:${id}`;
      if (!aliases.has(key)) {
        aliases.set(key, `${kind}-${String.fromCharCode(65 + counts[kind]++)}`);
      }
      const alias = aliases.get(key) as string;
      return part.delta === undefined
        ? [part.type, alias]
        : [part.type, alias, part.delta];
    });
}
