/**
 * Bedrock Converse proxy routes — extended-thinking round trip.
 *
 * Reasoning reaches the proxy in both directions: Bedrock returns a
 * `reasoningContent` block (or streams one as a delta), and the next request
 * echoes it back. These pin the shapes the route must carry, including the
 * *redacted* variant, whose union member the Converse API spells
 * `redactedContent` and @ai-sdk/amazon-bedrock spells `redactedReasoning.data`.
 */

import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { afterEach, describe, expect, test } from "@/test";
import { bedrockAdapterFactory } from "../adapters/bedrock";
import bedrockProxyRoutes from "./bedrock";

const MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";
const REDACTED_BLOB = "cnNuXzVaVnJpZjRKMGJYSXFtV2RsZWRqN1FJRmVBQmw2UGVH";

const HEADERS = {
  "content-type": "application/json",
  authorization: "Bearer test-key",
  "user-agent": "test-client",
};

const eventStreamCodec = new EventStreamCodec(toUtf8, fromUtf8);

function createFastifyApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

async function* asyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

/** Decode a converse-stream payload back into its event bodies. */
function decodeStreamPayload(
  payload: Buffer,
): { eventType: string; body: Record<string, unknown> }[] {
  const events: { eventType: string; body: Record<string, unknown> }[] = [];
  let buffer = new Uint8Array(payload);

  while (buffer.length >= 4) {
    const totalLength = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    ).getUint32(0, false);
    const decoded = eventStreamCodec.decode(buffer.subarray(0, totalLength));
    buffer = buffer.subarray(totalLength);

    const body = JSON.parse(new TextDecoder().decode(decoded.body));
    // Bedrock pads event bodies; it is noise for these assertions.
    delete body.p;
    events.push({
      eventType: String(decoded.headers[":event-type"]?.value),
      body,
    });
  }

  return events;
}

describe("Bedrock Converse proxy — reasoning content", () => {
  afterEach(() => vi.restoreAllMocks());

  test("returns reasoning blocks from a non-streaming response", async ({
    makeAgent,
  }) => {
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          converse: async () => ({
            output: {
              message: {
                role: "assistant",
                content: [
                  {
                    reasoningContent: {
                      reasoningText: {
                        text: "Counting the days.",
                        signature: "sig_abc123",
                      },
                    },
                  },
                  // Part of the same chain of thought, redacted by the model
                  // provider — the Converse API's own spelling.
                  { reasoningContent: { redactedContent: REDACTED_BLOB } },
                  { text: "Seven." },
                ],
              },
            },
            stopReason: "end_turn",
            usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
          }),
        }) as never,
    );

    const app = createFastifyApp();
    await app.register(bedrockProxyRoutes);
    const agent = await makeAgent({ name: "bedrock-reasoning-agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/${agent.id}/converse`,
      headers: HEADERS,
      payload: {
        modelId: MODEL_ID,
        messages: [{ role: "user", content: [{ text: "Days in a week?" }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    // Response serialization runs against the route's schema, so a block it
    // does not model is dropped or rejected rather than forwarded.
    expect(response.json().output.message.content).toEqual([
      {
        reasoningContent: {
          reasoningText: {
            text: "Counting the days.",
            signature: "sig_abc123",
          },
        },
      },
      { reasoningContent: { redactedContent: REDACTED_BLOB } },
      { text: "Seven." },
    ]);
  });

  test("forwards a redacted reasoning delta on the stream", async ({
    makeAgent,
  }) => {
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          converseStream: async () =>
            asyncIterable([
              { messageStart: { role: "assistant" } },
              {
                contentBlockDelta: {
                  contentBlockIndex: 0,
                  delta: {
                    reasoningContent: { redactedContent: REDACTED_BLOB },
                  },
                },
              },
              { contentBlockStop: { contentBlockIndex: 0 } },
              {
                contentBlockDelta: {
                  contentBlockIndex: 1,
                  delta: { text: "Seven." },
                },
              },
              { contentBlockStop: { contentBlockIndex: 1 } },
              { messageStop: { stopReason: "end_turn" } },
              {
                metadata: {
                  usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
                },
              },
            ]),
        }) as never,
    );

    const app = createFastifyApp();
    await app.register(bedrockProxyRoutes);
    const agent = await makeAgent({ name: "bedrock-reasoning-stream-agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/${agent.id}/converse-stream`,
      headers: HEADERS,
      payload: {
        modelId: MODEL_ID,
        messages: [{ role: "user", content: [{ text: "Days in a week?" }] }],
      },
    });

    expect(response.statusCode).toBe(200);
    const events = decodeStreamPayload(response.rawPayload);

    expect(events.map((event) => event.eventType)).toEqual([
      "messageStart",
      "contentBlockDelta",
      "contentBlockStop",
      "contentBlockDelta",
      "contentBlockStop",
      "messageStop",
      "metadata",
    ]);
    expect(events[1].body).toEqual({
      contentBlockIndex: 0,
      delta: { reasoningContent: { redactedContent: REDACTED_BLOB } },
    });
  });

  test("sends redacted reasoning upstream under the Converse API's name", async ({
    makeAgent,
  }) => {
    const captured: Record<string, unknown>[] = [];
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          converse: async (
            _modelId: string,
            request: Record<string, unknown>,
          ) => {
            captured.push(request);
            return {
              output: {
                message: { role: "assistant", content: [{ text: "Seven." }] },
              },
              stopReason: "end_turn",
              usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
            };
          },
        }) as never,
    );

    const app = createFastifyApp();
    await app.register(bedrockProxyRoutes);
    const agent = await makeAgent({ name: "bedrock-reasoning-echo-agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/${agent.id}/converse`,
      headers: HEADERS,
      payload: {
        modelId: MODEL_ID,
        messages: [
          { role: "user", content: [{ text: "Days in a week?" }] },
          {
            role: "assistant",
            content: [
              // What @ai-sdk/amazon-bedrock echoes back; ReasoningContentBlock
              // has no such member, so the proxy renames it.
              {
                reasoningContent: {
                  redactedReasoning: { data: REDACTED_BLOB },
                },
              },
              { text: "Seven." },
            ],
          },
          { role: "user", content: [{ text: "And in a fortnight?" }] },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(captured).toHaveLength(1);
    expect(
      (captured[0].messages as { content: unknown[] }[])[1].content,
    ).toEqual([
      { reasoningContent: { redactedContent: REDACTED_BLOB } },
      { text: "Seven." },
    ]);
  });
});
