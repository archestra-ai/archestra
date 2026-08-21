import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { describe, expect, test } from "@/test";
import {
  bedrockOrphanReasoningMiddleware,
  createBedrockRedactedReasoningFetch,
} from "./bedrock-redacted-reasoning";

// A real Bedrock redacted-reasoning payload is a KMS-encrypted blob, base64'd
// onto the JSON wire. Only its shape matters here.
const REDACTED_BLOB = "cnNuXzVaVnJpZjRKMGJYSXFtV2RsZWRqN1FJRmVBQmw2UGVH";

const codec = new EventStreamCodec(toUtf8, fromUtf8);

function frame(eventType: string, body: Record<string, unknown>): Uint8Array {
  return codec.encode({
    headers: {
      ":event-type": { type: "string", value: eventType },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    // Bedrock pads every event body with a "p" field; keep it so the
    // pass-through assertions exercise the real shape.
    body: fromUtf8(JSON.stringify({ ...body, p: "abcdefgh" })),
  });
}

/**
 * The frames a Converse stream emits for a turn whose entire chain of thought
 * was redacted: an empty reasoning block, then the visible answer.
 */
function redactedReasoningFrames(): Uint8Array[] {
  return [
    frame("messageStart", { role: "assistant" }),
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
      metrics: { latencyMs: 12 },
    }),
  ];
}

function eventStreamResponse(frames: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const bytes of frames) {
          controller.enqueue(bytes);
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/vnd.amazon.eventstream" },
    },
  );
}

/**
 * The model exactly as `providerModelConfigs.bedrock` builds it: the real
 * provider package behind both halves of the shim. `bare` drops the shim, to
 * pin what the package does on its own.
 */
function bedrockModel(
  fetchImpl: typeof globalThis.fetch,
  { bare = false }: { bare?: boolean } = {},
) {
  const model = createAmazonBedrock({
    apiKey: "test-key",
    region: "us-east-1",
    fetch: bare ? fetchImpl : createBedrockRedactedReasoningFetch(fetchImpl),
  })("anthropic.claude-haiku-4-5-20251001-v1:0");

  return bare
    ? model
    : wrapLanguageModel({
        model,
        middleware: bedrockOrphanReasoningMiddleware(),
      });
}

async function collectStream(
  fetchImpl: typeof globalThis.fetch,
  options: { bare?: boolean } = {},
) {
  const result = streamText({
    model: bedrockModel(fetchImpl, options),
    prompt: "What is 6 * 7?",
    maxRetries: 0,
  });

  const errors: unknown[] = [];
  const redactedData: unknown[] = [];
  const partTypes: string[] = [];
  let text = "";

  for await (const part of result.fullStream) {
    partTypes.push(part.type);
    if (part.type === "error") errors.push(part.error);
    if (part.type === "text-delta") text += part.text;
    if (part.type === "reasoning-start" || part.type === "reasoning-delta") {
      const bedrock = part.providerMetadata?.bedrock;
      if (bedrock?.redactedData !== undefined) {
        redactedData.push(bedrock.redactedData);
      }
    }
  }

  return { errors, redactedData, partTypes, text };
}

describe("createBedrockRedactedReasoningFetch", () => {
  describe("Converse event stream", () => {
    // The regression itself: @ai-sdk/amazon-bedrock's BedrockStreamSchema is a
    // closed union over {text} | {signature} | {data}, so Bedrock's own
    // `redactedContent` matches nothing and the turn dies before any content
    // reaches the caller. This is the unwrapped control for the test below it —
    // if it ever stops failing, the provider package has grown the field and
    // the wrapper can go.
    test("the provider package rejects Bedrock's redactedContent unwrapped", async () => {
      const { errors, text } = await collectStream(
        async () => eventStreamResponse(redactedReasoningFrames()),
        { bare: true },
      );

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).name).toBe("AI_TypeValidationError");
      // The answer bytes are still on the wire, but the turn now carries an
      // error part — which is what the chat renders instead of the response.
      expect(text).toBe("42");
    });

    test("surfaces redacted reasoning and the answer that follows it", async () => {
      const { errors, redactedData, partTypes, text } = await collectStream(
        async () => eventStreamResponse(redactedReasoningFrames()),
      );

      expect(errors).toEqual([]);
      expect(redactedData).toContain(REDACTED_BLOB);
      expect(text).toBe("42");
      // The reasoning block opens and closes around its delta, so it nests in
      // order with the text block that follows.
      expect(partTypes).toEqual([
        "start",
        "start-step",
        "reasoning-start",
        "reasoning-delta",
        "reasoning-end",
        "text-start",
        "text-delta",
        "text-end",
        "finish-step",
        "finish",
      ]);
    });

    test("carries the redacted blob on the block it opens", async () => {
      const result = streamText({
        model: bedrockModel(async () =>
          eventStreamResponse(redactedReasoningFrames()),
        ),
        prompt: "What is 6 * 7?",
        maxRetries: 0,
      });

      const reasoning = (await result.content).find(
        (part) => part.type === "reasoning",
      );

      // Matches how @ai-sdk/anthropic reports redacted_thinking: no readable
      // text, the encrypted blob in provider metadata, which is what the chat
      // echoes back to Bedrock on the next turn.
      expect(reasoning?.text).toBe("");
      expect(reasoning?.providerMetadata?.bedrock?.redactedData).toBe(
        REDACTED_BLOB,
      );
    });

    test("leaves plain reasoning and signature deltas alone", async () => {
      const { errors, partTypes, text } = await collectStream(async () =>
        eventStreamResponse([
          frame("messageStart", { role: "assistant" }),
          frame("contentBlockDelta", {
            contentBlockIndex: 0,
            delta: { reasoningContent: { text: "weighing the options" } },
          }),
          frame("contentBlockDelta", {
            contentBlockIndex: 0,
            delta: { reasoningContent: { signature: "sig_abc123" } },
          }),
          frame("contentBlockStop", { contentBlockIndex: 0 }),
          frame("contentBlockDelta", {
            contentBlockIndex: 1,
            delta: { text: "42" },
          }),
          frame("messageStop", { stopReason: "end_turn" }),
          frame("metadata", {
            usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
          }),
        ]),
      );

      expect(errors).toEqual([]);
      expect(text).toBe("42");
      // The provider opens this block itself from the text delta; the repair
      // must not start it a second time.
      expect(
        partTypes.filter((type) => type === "reasoning-start"),
      ).toHaveLength(1);
    });

    // Same orphan, reached without any redacted content: the provider only ever
    // opens a reasoning block from a non-empty text delta, so a signature that
    // arrives first is rejected the same way.
    test("opens a block for a signature delta that arrives first", async () => {
      const { errors, partTypes, text } = await collectStream(async () =>
        eventStreamResponse([
          frame("messageStart", { role: "assistant" }),
          frame("contentBlockDelta", {
            contentBlockIndex: 0,
            delta: { reasoningContent: { signature: "sig_abc123" } },
          }),
          frame("contentBlockStop", { contentBlockIndex: 0 }),
          frame("contentBlockDelta", {
            contentBlockIndex: 1,
            delta: { text: "42" },
          }),
          frame("messageStop", { stopReason: "end_turn" }),
          frame("metadata", {
            usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
          }),
        ]),
      );

      expect(errors).toEqual([]);
      expect(text).toBe("42");
      expect(partTypes).toContain("reasoning-start");
    });

    test("forwards frames it does not rewrite as the original bytes", async () => {
      const frames = redactedReasoningFrames();
      const original = Buffer.concat(frames.map((f) => Buffer.from(f)));

      const wrapped = createBedrockRedactedReasoningFetch(async () =>
        eventStreamResponse(frames),
      );
      const response = await wrapped("https://bedrock.example/converse-stream");
      const forwarded = Buffer.from(await response.arrayBuffer());

      // Only the one redacted-reasoning frame differs; splitting on the
      // pass-through frames proves the rest survived byte for byte.
      const untouched = [0, 2, 3, 4, 5, 6].map((i) => Buffer.from(frames[i]));
      for (const bytes of untouched) {
        expect(forwarded.includes(bytes)).toBe(true);
      }
      expect(forwarded.equals(original)).toBe(false);
      expect(forwarded.toString("utf8")).not.toContain("redactedContent");
    });

    test("reassembles frames split across chunk boundaries", async () => {
      const all = Buffer.concat(
        redactedReasoningFrames().map((f) => Buffer.from(f)),
      );
      // Three bytes at a time, so every frame straddles several reads and the
      // first read cannot even hold the 4-byte length prefix.
      const dribbled: Uint8Array[] = [];
      for (let i = 0; i < all.length; i += 3) {
        dribbled.push(new Uint8Array(all.subarray(i, i + 3)));
      }

      const { errors, redactedData, text } = await collectStream(
        createBedrockRedactedReasoningFetch(async () =>
          eventStreamResponse(dribbled),
        ),
      );

      expect(errors).toEqual([]);
      expect(redactedData).toContain(REDACTED_BLOB);
      expect(text).toBe("42");
    });

    test("passes undecodable bytes through instead of stalling", async () => {
      const garbage = new Uint8Array([0, 0, 0, 2, 9, 9]);

      const wrapped = createBedrockRedactedReasoningFetch(async () =>
        eventStreamResponse([garbage]),
      );
      const response = await wrapped("https://bedrock.example/converse-stream");

      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        Buffer.from(garbage),
      );
    });
  });

  describe("Converse JSON response", () => {
    async function generate(fetchImpl: typeof globalThis.fetch) {
      return generateText({
        model: bedrockModel(fetchImpl),
        prompt: "What is 6 * 7?",
        maxRetries: 0,
      });
    }

    function converseResponse(reasoningContent: Record<string, unknown>) {
      return () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              output: {
                message: {
                  role: "assistant",
                  content: [{ reasoningContent }, { text: "42" }],
                },
              },
              stopReason: "end_turn",
              usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
    }

    test("surfaces a redacted reasoning block", async () => {
      const result = await generate(
        createBedrockRedactedReasoningFetch(
          converseResponse({ redactedContent: REDACTED_BLOB }),
        ),
      );

      expect(result.text).toBe("42");
      expect(
        result.content.find((part) => part.type === "reasoning")
          ?.providerMetadata?.bedrock?.redactedData,
      ).toBe(REDACTED_BLOB);
    });

    test("leaves a reasoningText block alone", async () => {
      const result = await generate(
        createBedrockRedactedReasoningFetch(
          converseResponse({
            reasoningText: { text: "6 times 7", signature: "sig_abc123" },
          }),
        ),
      );

      expect(result.text).toBe("42");
      expect(result.reasoningText).toBe("6 times 7");
    });
  });

  test("forwards error responses untouched", async () => {
    const wrapped = createBedrockRedactedReasoningFetch(
      async () =>
        new Response(JSON.stringify({ message: "throttled" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );

    const response = await wrapped("https://bedrock.example/converse");

    expect(response.status).toBe(429);
    expect(await response.text()).toBe('{"message":"throttled"}');
  });

  test("forwards bodies of other media types untouched", async () => {
    const wrapped = createBedrockRedactedReasoningFetch(
      async () =>
        new Response("redactedContent is just a word here", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );

    const response = await wrapped("https://bedrock.example/anything");

    expect(await response.text()).toBe("redactedContent is just a word here");
  });
});
