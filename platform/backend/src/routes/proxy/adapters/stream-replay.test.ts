/**
 * Exact full-event-sequence tests for the streaming tool-call replay path.
 *
 * The proxy handler replays tool-call events through
 * `getRawToolCallEvents()` and dedups by ARRAY INDEX
 * (llm-proxy-handler.ts:1213-1222, :1388-1401), so every stream adapter must
 * return the full, index-stable, append-only event history on every call.
 *
 * Each test drives an adapter with a synthetic chunk stream through the exact
 * write pattern of the handler and asserts the COMPLETE ordered sequence of
 * SSE writes, byte for byte, for three scenarios:
 *  - immediately-streamed non-blocking tool call (replay after every chunk),
 *  - buffered-then-approved final flush,
 *  - blocked-then-refused discard.
 *
 * The three native paths (OpenAI, Anthropic, Bedrock) pin byte-identical
 * pre-existing behavior. The model-router Anthropic->OpenAI wrapper pins the
 * FIXED behavior: the tool name event AND every argument-delta event are
 * delivered exactly once (previously the wrapper drained its buffer on each
 * getter call, re-basing indices at 0, so the handler's index dedup dropped
 * every event after the first).
 */
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { LLMStreamAdapter, OpenAi } from "@/types";
import { anthropicAdapterFactory } from "./anthropic";
import { makeAnthropicOpenaiAdapterFactory } from "./anthropic-openai";
import { bedrockAdapterFactory } from "./bedrock";
import { openaiAdapterFactory } from "./openai";

const FAKE_NOW_MS = 1_767_225_600_000; // 2026-01-01T00:00:00Z
const FAKE_NOW_UNIX = Math.floor(FAKE_NOW_MS / 1000);
const REFUSAL_TEXT = "This tool call was blocked by policy.";

const ARGUMENT_FRAGMENTS = ['{"query":"', "weather ", 'today"', "}"] as const;

type Scenario =
  | "streamed-non-blocking"
  | "buffered-approved"
  | "blocked-refused";

type SseWrite = string | Uint8Array;

/**
 * Replicates the handler's SSE write pattern exactly:
 * - per-chunk: llm-proxy-handler.ts:1174-1230 (text sseData streams
 *   immediately; in the non-blocking scenario every tool-call chunk triggers
 *   a full replay deduped by array index),
 * - post-stream: llm-proxy-handler.ts:1361-1405 (refusal events, or the
 *   final flush of un-streamed tool events, then formatEndSSE).
 */
function runHandlerWritePattern<TChunk, TResponse>(params: {
  adapter: LLMStreamAdapter<TChunk, TResponse>;
  chunks: TChunk[];
  scenario: Scenario;
}): SseWrite[] {
  const { adapter, chunks, scenario } = params;
  const writes: SseWrite[] = [];
  const streamedEventIndices = new Set<number>();

  for (const chunk of chunks) {
    const result = adapter.processChunk(chunk);
    if (result.sseData) {
      writes.push(result.sseData);
    } else if (result.isToolCallChunk && scenario === "streamed-non-blocking") {
      const allEvents = adapter.getRawToolCallEvents();
      for (let i = 0; i < allEvents.length; i++) {
        if (!streamedEventIndices.has(i)) {
          writes.push(allEvents[i]);
          streamedEventIndices.add(i);
        }
      }
    }
    if (result.isFinal) {
      break;
    }
  }

  if (scenario === "blocked-refused") {
    for (const event of adapter.formatCompleteTextSSE(REFUSAL_TEXT)) {
      writes.push(event);
    }
  } else if (
    adapter.state.toolCalls.length > 0 &&
    streamedEventIndices.size < adapter.getRawToolCallEvents().length
  ) {
    const allEvents = adapter.getRawToolCallEvents();
    for (let i = 0; i < allEvents.length; i++) {
      if (!streamedEventIndices.has(i)) {
        writes.push(allEvents[i]);
      }
    }
  }

  writes.push(adapter.formatEndSSE());
  return writes;
}

beforeEach(() => {
  vi.useFakeTimers({ now: FAKE_NOW_MS });
});

afterEach(() => {
  vi.useRealTimers();
});

// =============================================================================
// Native OpenAI
// =============================================================================

const OPENAI_ID = "chatcmpl-replay-test";
const OPENAI_MODEL = "gpt-test";

function openaiChunks(): OpenAi.Types.ChatCompletionChunk[] {
  const base = {
    id: OPENAI_ID,
    object: "chat.completion.chunk" as const,
    created: 1_700_000_000,
    model: OPENAI_MODEL,
  };
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { content: "Checking " },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_replay_0",
                type: "function",
                function: { name: "search_documents", arguments: "" },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    ...ARGUMENT_FRAGMENTS.map((fragment) => ({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: fragment } }],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    })),
    {
      ...base,
      choices: [
        { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
      ],
    },
    {
      ...base,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ] as OpenAi.Types.ChatCompletionChunk[];
}

// Expected serializations are computed from fresh chunk literals BEFORE the
// adapter sees anything, so a post-accumulation mutation inside the adapter
// would fail these tests.
const openaiExpected = {
  textEvent: () => `data: ${JSON.stringify(openaiChunks()[0])}\n\n`,
  toolEvents: () =>
    openaiChunks()
      .slice(1, 6)
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
  endEvent: (finishReason: "tool_calls" | "stop") =>
    `data: ${JSON.stringify({
      id: OPENAI_ID,
      object: "chat.completion.chunk",
      created: FAKE_NOW_UNIX,
      model: OPENAI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\ndata: [DONE]\n\n`,
  refusalEvent: () =>
    `data: ${JSON.stringify({
      id: OPENAI_ID,
      object: "chat.completion.chunk",
      created: FAKE_NOW_UNIX,
      model: OPENAI_MODEL,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: REFUSAL_TEXT },
          finish_reason: null,
        },
      ],
    })}\n\n`,
};

describe("native OpenAI stream replay", () => {
  test("streamed non-blocking tool call delivers every event once, in order", () => {
    const writes = runHandlerWritePattern({
      adapter: openaiAdapterFactory.createStreamAdapter(),
      chunks: openaiChunks(),
      scenario: "streamed-non-blocking",
    });

    expect(writes).toEqual([
      openaiExpected.textEvent(),
      ...openaiExpected.toolEvents(),
      openaiExpected.endEvent("tool_calls"),
    ]);
  });

  test("buffered-then-approved flushes the full event history at the end", () => {
    const writes = runHandlerWritePattern({
      adapter: openaiAdapterFactory.createStreamAdapter(),
      chunks: openaiChunks(),
      scenario: "buffered-approved",
    });

    expect(writes).toEqual([
      openaiExpected.textEvent(),
      ...openaiExpected.toolEvents(),
      openaiExpected.endEvent("tool_calls"),
    ]);
  });

  test("blocked-then-refused discards tool events and sends the refusal", () => {
    const writes = runHandlerWritePattern({
      adapter: openaiAdapterFactory.createStreamAdapter(),
      chunks: openaiChunks(),
      scenario: "blocked-refused",
    });

    expect(writes).toEqual([
      openaiExpected.textEvent(),
      openaiExpected.refusalEvent(),
      openaiExpected.endEvent("stop"),
    ]);
  });

  test("getRawToolCallEvents is non-destructive and index-stable across calls", () => {
    const adapter = openaiAdapterFactory.createStreamAdapter();
    for (const chunk of openaiChunks()) {
      adapter.processChunk(chunk);
    }
    const first = adapter.getRawToolCallEvents();
    const second = adapter.getRawToolCallEvents();
    expect([...first]).toEqual(openaiExpected.toolEvents());
    expect([...second]).toEqual([...first]);
  });
});

// =============================================================================
// Native Anthropic
// =============================================================================

const ANTHROPIC_MESSAGE_ID = "msg-replay-test";
const ANTHROPIC_MODEL = "claude-test";

type AnthropicStreamChunk = Parameters<
  ReturnType<typeof anthropicAdapterFactory.createStreamAdapter>["processChunk"]
>[0];

function anthropicChunkPayloads(): Record<string, unknown>[] {
  return [
    {
      type: "message_start",
      message: {
        id: ANTHROPIC_MESSAGE_ID,
        type: "message",
        role: "assistant",
        content: [],
        model: ANTHROPIC_MODEL,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 25, output_tokens: 1 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_replay_0",
        name: "search_documents",
        input: {},
      },
    },
    ...ARGUMENT_FRAGMENTS.map((partial_json) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json },
    })),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 9 },
    },
    { type: "message_stop" },
  ];
}

function anthropicChunks(): AnthropicStreamChunk[] {
  return anthropicChunkPayloads() as unknown as AnthropicStreamChunk[];
}

function anthropicSse(payload: Record<string, unknown>): string {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const anthropicExpected = {
  messageStartEvent: () => anthropicSse(anthropicChunkPayloads()[0]),
  toolEvents: () => anthropicChunkPayloads().slice(1, 7).map(anthropicSse),
  endEvent: (stopReason: "tool_use" | "end_turn") =>
    anthropicSse({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 9 },
    }) + anthropicSse({ type: "message_stop" }),
  refusalEvents: () => [
    anthropicSse({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    anthropicSse({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: REFUSAL_TEXT },
    }),
    anthropicSse({ type: "content_block_stop", index: 0 }),
  ],
};

describe("native Anthropic stream replay", () => {
  test("streamed non-blocking tool call delivers every event once, in order", () => {
    const writes = runHandlerWritePattern({
      adapter: anthropicAdapterFactory.createStreamAdapter(),
      chunks: anthropicChunks(),
      scenario: "streamed-non-blocking",
    });

    expect(writes).toEqual([
      anthropicExpected.messageStartEvent(),
      ...anthropicExpected.toolEvents(),
      anthropicExpected.endEvent("tool_use"),
    ]);
  });

  test("buffered-then-approved flushes the full event history at the end", () => {
    const writes = runHandlerWritePattern({
      adapter: anthropicAdapterFactory.createStreamAdapter(),
      chunks: anthropicChunks(),
      scenario: "buffered-approved",
    });

    expect(writes).toEqual([
      anthropicExpected.messageStartEvent(),
      ...anthropicExpected.toolEvents(),
      anthropicExpected.endEvent("tool_use"),
    ]);
  });

  test("blocked-then-refused discards tool events and sends the refusal", () => {
    const writes = runHandlerWritePattern({
      adapter: anthropicAdapterFactory.createStreamAdapter(),
      chunks: anthropicChunks(),
      scenario: "blocked-refused",
    });

    expect(writes).toEqual([
      anthropicExpected.messageStartEvent(),
      ...anthropicExpected.refusalEvents(),
      anthropicExpected.endEvent("end_turn"),
    ]);
  });

  test("getRawToolCallEvents is non-destructive and index-stable across calls", () => {
    const adapter = anthropicAdapterFactory.createStreamAdapter();
    for (const chunk of anthropicChunks()) {
      adapter.processChunk(chunk);
    }
    const first = adapter.getRawToolCallEvents();
    const second = adapter.getRawToolCallEvents();
    expect([...first]).toEqual(anthropicExpected.toolEvents());
    expect([...second]).toEqual([...first]);
  });
});

// =============================================================================
// Native Bedrock
// =============================================================================

type BedrockStreamChunk = Parameters<
  ReturnType<typeof bedrockAdapterFactory.createStreamAdapter>["processChunk"]
>[0];

const bedrockCodec = new EventStreamCodec(toUtf8, fromUtf8);

// Independent re-implementation of the adapter's AWS event-stream encoding
// (bedrock.ts encodeEventStreamMessage + generatePadding) so expected bytes
// are pinned by the test, not derived from the code under test.
function encodeBedrockEvent(
  eventType: string,
  body: Record<string, unknown>,
): Uint8Array {
  const bodyWithoutPadding = JSON.stringify(body);
  const paddingAlphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const paddingNeeded = Math.max(0, 80 - bodyWithoutPadding.length - 10);
  const padding = paddingAlphabet.slice(
    0,
    Math.min(paddingNeeded, paddingAlphabet.length),
  );
  return bedrockCodec.encode({
    headers: {
      ":event-type": { type: "string", value: eventType },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    body: fromUtf8(JSON.stringify({ ...body, p: padding })),
  });
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bedrockChunks(): BedrockStreamChunk[] {
  return [
    { messageStart: { role: "assistant" } },
    {
      contentBlockStart: {
        contentBlockIndex: 0,
        start: {
          toolUse: { toolUseId: "tooluse_replay_0", name: "search_documents" },
        },
      },
    },
    ...ARGUMENT_FRAGMENTS.map((input) => ({
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { toolUse: { input } },
      },
    })),
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "tool_use" } },
    { metadata: { usage: { inputTokens: 25, outputTokens: 9 } } },
  ] as BedrockStreamChunk[];
}

const bedrockExpected = {
  messageStartEvent: () =>
    encodeBedrockEvent("messageStart", { role: "assistant" }),
  toolEvents: () => [
    encodeBedrockEvent("contentBlockStart", {
      contentBlockIndex: 0,
      start: {
        toolUse: { toolUseId: "tooluse_replay_0", name: "search_documents" },
      },
    }),
    ...ARGUMENT_FRAGMENTS.map((input) =>
      encodeBedrockEvent("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { toolUse: { input } },
      }),
    ),
    encodeBedrockEvent("contentBlockStop", { contentBlockIndex: 0 }),
    encodeBedrockEvent("messageStop", { stopReason: "tool_use" }),
    encodeBedrockEvent("metadata", {
      usage: { inputTokens: 25, outputTokens: 9 },
    }),
  ],
  refusalEvents: () => [
    encodeBedrockEvent("contentBlockStart", {
      contentBlockIndex: 0,
      start: { text: "" },
    }),
    encodeBedrockEvent("contentBlockDelta", {
      contentBlockIndex: 0,
      delta: { text: REFUSAL_TEXT },
    }),
    encodeBedrockEvent("contentBlockStop", { contentBlockIndex: 0 }),
  ],
  refusalEndEvent: () =>
    concatBytes(
      encodeBedrockEvent("messageStop", { stopReason: "end_turn" }),
      encodeBedrockEvent("metadata", {
        usage: { inputTokens: 25, outputTokens: 9 },
      }),
    ),
};

describe("native Bedrock stream replay", () => {
  test("streamed non-blocking tool call delivers every event once, in order", () => {
    const writes = runHandlerWritePattern({
      adapter: bedrockAdapterFactory.createStreamAdapter(),
      chunks: bedrockChunks(),
      scenario: "streamed-non-blocking",
    });

    expect(writes).toEqual([
      bedrockExpected.messageStartEvent(),
      ...bedrockExpected.toolEvents(),
      // Bedrock's formatEndSSE is empty on the non-refusal path: messageStop
      // and metadata were already replayed with the tool events.
      "",
    ]);
  });

  test("buffered-then-approved flushes the full event history at the end", () => {
    const writes = runHandlerWritePattern({
      adapter: bedrockAdapterFactory.createStreamAdapter(),
      chunks: bedrockChunks(),
      scenario: "buffered-approved",
    });

    expect(writes).toEqual([
      bedrockExpected.messageStartEvent(),
      ...bedrockExpected.toolEvents(),
      "",
    ]);
  });

  test("blocked-then-refused discards tool events and sends the refusal", () => {
    const writes = runHandlerWritePattern({
      adapter: bedrockAdapterFactory.createStreamAdapter(),
      chunks: bedrockChunks(),
      scenario: "blocked-refused",
    });

    expect(writes).toEqual([
      bedrockExpected.messageStartEvent(),
      ...bedrockExpected.refusalEvents(),
      bedrockExpected.refusalEndEvent(),
    ]);
  });

  test("getRawToolCallEvents is non-destructive and index-stable across calls", () => {
    const adapter = bedrockAdapterFactory.createStreamAdapter();
    for (const chunk of bedrockChunks()) {
      adapter.processChunk(chunk);
    }
    const first = adapter.getRawToolCallEvents();
    const second = adapter.getRawToolCallEvents();
    expect([...first]).toEqual(bedrockExpected.toolEvents());
    expect([...second]).toEqual([...first]);
  });
});

// =============================================================================
// Model-router Anthropic -> OpenAI wrapper
// =============================================================================

const WRAPPER_CTX = {
  chatcmplId: "chatcmpl-router-test",
  createdUnix: 1_700_000_123,
  requestedModel: "anthropic:claude-test",
};

function wrapperAdapter() {
  return makeAnthropicOpenaiAdapterFactory(WRAPPER_CTX).createStreamAdapter();
}

function wrapperChunkSse(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: WRAPPER_CTX.chatcmplId,
    object: "chat.completion.chunk",
    created: WRAPPER_CTX.createdUnix,
    model: WRAPPER_CTX.requestedModel,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  })}\n\n`;
}

const wrapperExpected = {
  roleEvent: () => wrapperChunkSse({ role: "assistant" }),
  toolEvents: () => [
    wrapperChunkSse({
      tool_calls: [
        {
          index: 0,
          id: "toolu_replay_0",
          type: "function",
          function: { name: "search_documents", arguments: "" },
        },
      ],
    }),
    ...ARGUMENT_FRAGMENTS.map((fragment) =>
      wrapperChunkSse({
        tool_calls: [{ index: 0, function: { arguments: fragment } }],
      }),
    ),
  ],
  endEvent: (finishReason: "tool_calls" | "stop") =>
    `${wrapperChunkSse({}, finishReason)}data: [DONE]\n\n`,
  refusalEvent: () =>
    wrapperChunkSse({ role: "assistant", content: REFUSAL_TEXT }),
};

describe("model-router Anthropic->OpenAI wrapper stream replay (fixed behavior)", () => {
  test("streamed non-blocking tool call delivers the name event and every argument delta once", () => {
    const writes = runHandlerWritePattern({
      adapter: wrapperAdapter(),
      chunks: anthropicChunks(),
      scenario: "streamed-non-blocking",
    });

    expect(writes).toEqual([
      wrapperExpected.roleEvent(),
      ...wrapperExpected.toolEvents(),
      wrapperExpected.endEvent("tool_calls"),
    ]);
  });

  test("buffered-then-approved flushes the full event history at the end", () => {
    const writes = runHandlerWritePattern({
      adapter: wrapperAdapter(),
      chunks: anthropicChunks(),
      scenario: "buffered-approved",
    });

    expect(writes).toEqual([
      wrapperExpected.roleEvent(),
      ...wrapperExpected.toolEvents(),
      wrapperExpected.endEvent("tool_calls"),
    ]);
  });

  test("blocked-then-refused discards tool events and sends the refusal", () => {
    const writes = runHandlerWritePattern({
      adapter: wrapperAdapter(),
      chunks: anthropicChunks(),
      scenario: "blocked-refused",
    });

    expect(writes).toEqual([
      wrapperExpected.roleEvent(),
      wrapperExpected.refusalEvent(),
      wrapperExpected.endEvent("stop"),
    ]);
  });

  test("getRawToolCallEvents is non-destructive and index-stable across calls", () => {
    const adapter = wrapperAdapter();
    for (const chunk of anthropicChunks()) {
      adapter.processChunk(chunk);
    }
    const first = adapter.getRawToolCallEvents();
    const second = adapter.getRawToolCallEvents();
    expect([...first]).toEqual(wrapperExpected.toolEvents());
    expect([...second]).toEqual([...first]);
  });
});
