/**
 * Bedrock InvokeModel adapter tests.
 *
 * The adapter reuses the Anthropic adapters for all semantics; these tests pin
 * the transport differences:
 * - invoke bodies must not carry `model` / `stream` / `_isStreaming` and must
 *   carry `anthropic_version`
 * - the streaming wire format is AWS event stream "chunk" messages whose
 *   `bytes` payload base64-encodes the Anthropic stream event JSON
 */

import type AnthropicProvider from "@anthropic-ai/sdk";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { describe, expect, test } from "@/test";
import { bedrockInvokeAdapterFactory } from "./bedrock-invoke";

type AnthropicStreamChunk = AnthropicProvider.Messages.MessageStreamEvent;

const eventStreamCodec = new EventStreamCodec(toUtf8, fromUtf8);

/** Decode AWS event stream bytes into the wrapped Anthropic event JSONs. */
function decodeInvokeChunks(data: Uint8Array): unknown[] {
  const events: unknown[] = [];
  let buffer = data;
  while (buffer.length >= 4) {
    const totalLength = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    ).getUint32(0, false);
    const decoded = eventStreamCodec.decode(buffer.subarray(0, totalLength));
    buffer = buffer.subarray(totalLength);

    expect(decoded.headers[":event-type"]?.value).toBe("chunk");
    expect(decoded.headers[":message-type"]?.value).toBe("event");
    const body = JSON.parse(new TextDecoder().decode(decoded.body)) as {
      bytes: string;
    };
    events.push(JSON.parse(Buffer.from(body.bytes, "base64").toString("utf8")));
  }
  return events;
}

describe("bedrockInvokeAdapterFactory.execute", () => {
  test("strips model/stream/_isStreaming, injects anthropic_version, and passes model in URL", async () => {
    const captured: { modelId: string; body: Record<string, unknown> }[] = [];
    const client = {
      invoke: async (modelId: string, body: Record<string, unknown>) => {
        captured.push({ modelId, body });
        return {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 2 },
        };
      },
    };

    const response = await bedrockInvokeAdapterFactory.execute(client, {
      model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 128,
      stream: true,
      _isStreaming: false,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].modelId).toBe(
      "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
    expect(captured[0].body.model).toBeUndefined();
    expect(captured[0].body.stream).toBeUndefined();
    expect(captured[0].body._isStreaming).toBeUndefined();
    expect(captured[0].body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(captured[0].body.messages).toEqual([
      { role: "user", content: "Hello" },
    ]);
    expect(captured[0].body.max_tokens).toBe(128);

    expect(response.content).toEqual([{ type: "text", text: "hi" }]);
    expect(response.stop_sequence).toBeNull();
  });

  test("keeps a client-sent anthropic_version and defaults missing response fields", async () => {
    const captured: Record<string, unknown>[] = [];
    const client = {
      invoke: async (_modelId: string, body: Record<string, unknown>) => {
        captured.push(body);
        return {
          id: "msg_2",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    const response = await bedrockInvokeAdapterFactory.execute(client, {
      model: "anthropic.claude-3-sonnet-20240229-v1:0",
      anthropic_version: "bedrock-2024-custom",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 16,
    });

    expect(captured[0].anthropic_version).toBe("bedrock-2024-custom");
    // Defensive defaults for schema-required response fields
    expect(response.model).toBe("anthropic.claude-3-sonnet-20240229-v1:0");
    expect(response.stop_sequence).toBeNull();
  });
});

describe("BedrockInvokeStreamAdapter", () => {
  test("re-frames pass-through events as invoke chunk bytes and preserves accumulation", () => {
    const adapter = bedrockInvokeAdapterFactory.createStreamAdapter();

    const messageStart = {
      type: "message_start",
      message: {
        id: "msg_stream",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    } as unknown as AnthropicStreamChunk;

    const startResult = adapter.processChunk(messageStart);
    expect(startResult.isToolCallChunk).toBe(false);
    expect(startResult.sseData).toBeInstanceOf(Uint8Array);
    expect(decodeInvokeChunks(startResult.sseData as Uint8Array)).toEqual([
      messageStart,
    ]);

    const textDelta = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    } as unknown as AnthropicStreamChunk;
    const deltaResult = adapter.processChunk(textDelta);
    expect(decodeInvokeChunks(deltaResult.sseData as Uint8Array)).toEqual([
      textDelta,
    ]);

    expect(adapter.state.text).toBe("Hello");
    expect(adapter.state.responseId).toBe("msg_stream");
  });

  test("buffers tool_use chunks for policy evaluation and replays them as chunk bytes", () => {
    const adapter = bedrockInvokeAdapterFactory.createStreamAdapter();

    const toolStart = {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_1",
        name: "get_weather",
        input: {},
      },
    } as unknown as AnthropicStreamChunk;
    const toolDelta = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"city":"NYC"}' },
    } as unknown as AnthropicStreamChunk;

    const startResult = adapter.processChunk(toolStart);
    expect(startResult.isToolCallChunk).toBe(true);
    expect(startResult.sseData).toBeNull();
    adapter.processChunk(toolDelta);

    expect(adapter.state.toolCalls).toEqual([
      { id: "toolu_1", name: "get_weather", arguments: '{"city":"NYC"}' },
    ]);

    const replayed = adapter
      .getRawToolCallEvents()
      .flatMap((bytes) => decodeInvokeChunks(bytes as Uint8Array));
    expect(replayed).toEqual([toolStart, toolDelta]);
  });

  test("formatEndSSE emits message_delta and message_stop chunk events", () => {
    const adapter = bedrockInvokeAdapterFactory.createStreamAdapter();

    adapter.processChunk({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 10 },
    } as unknown as AnthropicStreamChunk);

    const endEvents = decodeInvokeChunks(
      adapter.formatEndSSE() as Uint8Array,
    ) as { type: string }[];
    expect(endEvents.map((e) => e.type)).toEqual([
      "message_delta",
      "message_stop",
    ]);
  });

  test("advertises the AWS event stream content type", () => {
    const adapter = bedrockInvokeAdapterFactory.createStreamAdapter();
    expect(adapter.getSSEHeaders()["Content-Type"]).toBe(
      "application/vnd.amazon.eventstream",
    );
  });
});

describe("BedrockInvokeRequestAdapter", () => {
  test("streaming is endpoint-selected via _isStreaming, not the stream body field", () => {
    const base = {
      model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
      messages: [{ role: "user" as const, content: "Hello" }],
      max_tokens: 128,
    };

    expect(
      bedrockInvokeAdapterFactory
        .createRequestAdapter({ ...base, _isStreaming: true })
        .isStreaming(),
    ).toBe(true);
    expect(
      bedrockInvokeAdapterFactory
        .createRequestAdapter({ ...base, stream: true })
        .isStreaming(),
    ).toBe(false);
  });

  test("exposes provider bedrock for policy/telemetry while reading Anthropic shapes", () => {
    const adapter = bedrockInvokeAdapterFactory.createRequestAdapter({
      model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 128,
      tools: [
        {
          name: "get_weather",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });

    expect(adapter.provider).toBe("bedrock");
    expect(adapter.getModel()).toBe(
      "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
    expect(adapter.hasTools()).toBe(true);
    expect(adapter.getTools()).toEqual([
      {
        name: "get_weather",
        description: undefined,
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    expect(adapter.getMessages()).toEqual([{ role: "user", content: "Hello" }]);
  });
});
