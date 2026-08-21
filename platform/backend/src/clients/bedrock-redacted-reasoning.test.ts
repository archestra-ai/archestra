import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { streamText } from "ai";
import { vi } from "vitest";
import { createDirectLLMModel } from "@/clients/llm-client";
import { beforeEach, describe, expect, test } from "@/test";

/**
 * Pins that *redacted* extended thinking survives the Bedrock model factory —
 * the encrypted reasoning blob a model emits when its own chain of thought
 * trips a safety filter.
 *
 * It used to not. @ai-sdk/amazon-bedrock below 4.0.158 modelled that union
 * member as `data` rather than the Converse API's `redactedContent`, so the
 * delta matched no member of its closed stream schema and the turn died with
 * `AI_TypeValidationError` before any content reached the caller. Even under a
 * name it accepted, it emitted the reasoning delta without opening the block,
 * which the AI SDK core rejects as "reasoning part <id> not found".
 *
 * Both are fixed in the pinned provider, so there is no wrapper left to test —
 * these drive the real factory against a mocked wire, and fail if the pin is
 * rolled back or the provider regresses.
 */

// Invented: a real payload is KMS-encrypted ciphertext, and only its shape
// matters here.
const REDACTED_BLOB =
  "cnNuX0VYQU1QTEVfcmVkYWN0ZWRfcmVhc29uaW5nX3BsYWNlaG9sZGVyX25vdF9hX3JlYWxfYmxvYg==";

const codec = new EventStreamCodec(toUtf8, fromUtf8);

function frame(eventType: string, body: Record<string, unknown>): Uint8Array {
  return codec.encode({
    headers: {
      ":event-type": { type: "string", value: eventType },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    // Bedrock pads every event body with a "p" field.
    body: fromUtf8(JSON.stringify({ ...body, p: "abcdefgh" })),
  });
}

function serveConverseStream(frames: Uint8Array[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const bytes of frames) controller.enqueue(bytes);
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/vnd.amazon.eventstream" },
          },
        ),
    ),
  );
}

async function streamBedrockTurn() {
  const result = streamText({
    model: createDirectLLMModel({
      provider: "bedrock",
      apiKey: "test-key",
      modelName: "anthropic.claude-haiku-4-5-20251001-v1:0",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    }),
    prompt: "What is 6 * 7?",
    maxRetries: 0,
  });

  const errors: unknown[] = [];
  const partTypes: string[] = [];
  let text = "";

  for await (const part of result.fullStream) {
    partTypes.push(part.type);
    if (part.type === "error") errors.push(part.error);
    if (part.type === "text-delta") text += part.text;
  }

  const reasoning = (await result.content).find(
    (part) => part.type === "reasoning",
  );

  return { errors, partTypes, text, reasoning };
}

describe("bedrock redacted reasoning", () => {
  // vi.stubGlobal auto-reverts after each test, so the stub is re-applied here.
  beforeEach(() => {
    serveConverseStream([
      frame("messageStart", { role: "assistant" }),
      // The delta that used to kill the turn: encrypted reasoning, and no text
      // delta anywhere to open the block for it.
      frame("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { reasoningContent: { redactedContent: REDACTED_BLOB } },
      }),
      frame("contentBlockStop", { contentBlockIndex: 0 }),
      frame("contentBlockDelta", {
        contentBlockIndex: 1,
        delta: { text: "42" },
      }),
      frame("contentBlockStop", { contentBlockIndex: 1 }),
      frame("messageStop", { stopReason: "end_turn" }),
      frame("metadata", {
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      }),
    ]);
  });

  test("delivers the answer that follows a wholly redacted block", async () => {
    const { errors, text } = await streamBedrockTurn();

    expect(errors).toEqual([]);
    expect(text).toBe("42");
  });

  test("opens and closes the reasoning block around the redacted delta", async () => {
    const { partTypes } = await streamBedrockTurn();

    // A delta without its `reasoning-start` is what the AI SDK core rejects,
    // and the block must close before the text block opens so they nest.
    expect(partTypes).toEqual([
      "start",
      "start-step",
      "reasoning-start",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
  });

  test("carries the encrypted blob for the next turn to echo back", async () => {
    const { reasoning } = await streamBedrockTurn();

    // No readable text — the blob in provider metadata is the whole content,
    // and `prepare-for-provider` keys on it to decide the block is not empty.
    expect(reasoning?.text).toBe("");
    expect(reasoning?.providerMetadata?.bedrock?.redactedContent).toBe(
      REDACTED_BLOB,
    );
  });
});
