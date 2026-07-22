/**
 * Bedrock InvokeModel proxy route tests.
 *
 * Covers the native InvokeModel routes used by the Anthropic SDK's Bedrock
 * client (and Claude Code with CLAUDE_CODE_USE_BEDROCK=1):
 *   POST /v1/bedrock/:agentId/model/:modelId/invoke
 *   POST /v1/bedrock/:agentId/model/:modelId/invoke-with-response-stream
 * plus the default-agent variants. Model IDs contain dots and colons
 * (e.g. eu.anthropic.claude-sonnet-4-5-20250929-v1:0) and must route.
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
import { InteractionModel } from "@/models";
import { afterEach, describe, expect, test } from "@/test";
import { bedrockAdapterFactory } from "../adapters/bedrock";
import bedrockProxyRoutes from "./bedrock";

const MODEL_ID = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";

const eventStreamCodec = new EventStreamCodec(toUtf8, fromUtf8);

function createFastifyApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

function anthropicStreamEvents(): unknown[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_bedrock_stream",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello " },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "from Bedrock" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
}

async function* asyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

/** Decode an invoke-with-response-stream payload back into Anthropic events. */
function decodeInvokeStreamPayload(payload: Buffer): { type: string }[] {
  const events: { type: string }[] = [];
  let buffer = new Uint8Array(payload);
  while (buffer.length >= 4) {
    const totalLength = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    ).getUint32(0, false);
    const decoded = eventStreamCodec.decode(buffer.subarray(0, totalLength));
    buffer = buffer.subarray(totalLength);

    expect(decoded.headers[":event-type"]?.value).toBe("chunk");
    const body = JSON.parse(new TextDecoder().decode(decoded.body)) as {
      bytes: string;
    };
    events.push(JSON.parse(Buffer.from(body.bytes, "base64").toString("utf8")));
  }
  return events;
}

const HEADERS = {
  "content-type": "application/json",
  authorization: "Bearer test-key",
  "user-agent": "test-client",
};

const PAYLOAD = {
  anthropic_version: "bedrock-2023-05-31",
  max_tokens: 256,
  messages: [{ role: "user", content: "Hello!" }],
};

describe("/v1/bedrock/:agentId/model/:modelId/invoke — non-streaming", () => {
  afterEach(() => vi.restoreAllMocks());

  test("routes model IDs with dots and colons and returns the Anthropic response", async ({
    makeAgent,
  }) => {
    const captured: { modelId: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          invoke: async (modelId: string, body: Record<string, unknown>) => {
            captured.push({ modelId, body });
            return {
              id: "msg_bedrock_1",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Hello from Bedrock" }],
              model: "claude-sonnet-4-5",
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 12, output_tokens: 3 },
            };
          },
        }) as never,
    );

    const app = createFastifyApp();
    await app.register(bedrockProxyRoutes);
    const agent = await makeAgent({ name: "bedrock-invoke-agent" });

    const response = await app.inject({
      method: "POST",
      // Model ID goes into the path verbatim — this is the exact URL shape the
      // Anthropic SDK's Bedrock client produces.
      url: `/v1/bedrock/${agent.id}/model/${MODEL_ID}/invoke`,
      headers: HEADERS,
      payload: PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.type).toBe("message");
    expect(body.content).toEqual([
      { type: "text", text: "Hello from Bedrock" },
    ]);
    expect(body.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 });

    // The upstream call carries the model in the URL and never in the body.
    expect(captured).toHaveLength(1);
    expect(captured[0].modelId).toBe(MODEL_ID);
    expect(captured[0].body.model).toBeUndefined();
    expect(captured[0].body._isStreaming).toBeUndefined();
    expect(captured[0].body.anthropic_version).toBe("bedrock-2023-05-31");
  });

  test("default-agent variant routes without an agent id", async ({
    makeAgent,
  }) => {
    // The default-agent route resolves the default gateway profile.
    await makeAgent({
      name: "bedrock-invoke-default",
      isDefault: true,
      agentType: "profile",
    });
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          invoke: async () => ({
            id: "msg_bedrock_2",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            model: "claude-sonnet-4-5",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          }),
        }) as never,
    );

    const app = createFastifyApp();
    await app.register(bedrockProxyRoutes);

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/model/${MODEL_ID}/invoke`,
      headers: HEADERS,
      payload: PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().content).toEqual([{ type: "text", text: "ok" }]);
  });
});

describe("/v1/bedrock/:agentId/model/:modelId/invoke-with-response-stream", () => {
  afterEach(() => vi.restoreAllMocks());

  test("streams AWS event stream chunks wrapping Anthropic events and records the interaction", async ({
    makeAgent,
  }) => {
    const captured: { modelId: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          invokeStream: async (
            modelId: string,
            body: Record<string, unknown>,
          ) => {
            captured.push({ modelId, body });
            return asyncIterable(anthropicStreamEvents());
          },
        }) as never,
    );

    const app = createFastifyApp();
    await app.register(bedrockProxyRoutes);
    const agent = await makeAgent({ name: "bedrock-invoke-stream-agent" });

    const initialCount = (
      await InteractionModel.getAllInteractionsForProfile(agent.id)
    ).length;

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/${agent.id}/model/${MODEL_ID}/invoke-with-response-stream`,
      headers: HEADERS,
      payload: PAYLOAD,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "application/vnd.amazon.eventstream",
    );

    // The upstream request body must not carry model/stream/_isStreaming.
    expect(captured).toHaveLength(1);
    expect(captured[0].modelId).toBe(MODEL_ID);
    expect(captured[0].body.model).toBeUndefined();
    expect(captured[0].body.stream).toBeUndefined();
    expect(captured[0].body._isStreaming).toBeUndefined();

    const events = decodeInvokeStreamPayload(response.rawPayload);
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const deltas = events.filter(
      (e): e is { type: string; delta: { text: string } } =>
        e.type === "content_block_delta",
    );
    expect(deltas.map((d) => d.delta.text).join("")).toBe("Hello from Bedrock");

    // Interaction is persisted with the bedrock:invoke type
    await new Promise((resolve) => setTimeout(resolve, 100));
    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);
    const interaction = interactions[interactions.length - 1];
    expect(interaction.type).toBe("bedrock:invoke");
    expect(interaction.model).toBe(MODEL_ID);
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10);
  });
});
