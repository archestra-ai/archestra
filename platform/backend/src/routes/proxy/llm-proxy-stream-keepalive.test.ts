/**
 * Byte-level liveness of a proxied stream.
 *
 * Streaming clients (Claude Code among them) run a byte-clock watchdog: if no
 * byte arrives for ~20s the turn is flagged as stalled, and after a few
 * minutes of silence the stream is aborted and retried. The proxy withholds
 * client tool-call events until the whole turn has streamed and tool-invocation
 * policy has run, so a large tool payload generated token-by-token is, from
 * the client's side, a dead stream for exactly that long.
 *
 * These tests drive the real routes over a real TCP socket (not `app.inject`,
 * which buffers the whole body) and timestamp every chunk the client receives,
 * so they measure the property the client actually cares about: the longest
 * gap between successive bytes.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { Stream } from "@anthropic-ai/sdk/streaming";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { ModelModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { anthropicAdapterFactory, bedrockAdapterFactory } from "./adapters";
import anthropicProxyRoutes from "./routes/anthropic";
import bedrockProxyRoutes from "./routes/bedrock";
import { STREAM_KEEPALIVE_SSE_COMMENT } from "./stream-keepalive";

/** Short enough to keep the suite fast, long enough to be unambiguous. */
const { KEEPALIVE_INTERVAL_MS } = vi.hoisted(() => ({
  KEEPALIVE_INTERVAL_MS: 40,
}));
/** Upstream delta cadence; the withheld window is DELTA_COUNT × this. */
const DELTA_GAP_MS = 25;
const DELTA_COUNT = 12;
const WITHHELD_WINDOW_MS = DELTA_COUNT * DELTA_GAP_MS;

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    llmProxy: { streamKeepAliveIntervalMs: KEEPALIVE_INTERVAL_MS },
  }),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type StreamEvent = Anthropic.Messages.MessageStreamEvent;

const messageStart: StreamEvent = {
  type: "message_start",
  message: {
    id: "msg-keepalive",
    type: "message",
    container: null,
    role: "assistant",
    content: [],
    model: "claude-3-5-sonnet-20241022",
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    } as unknown as Anthropic.Messages.Usage,
  },
};

/**
 * An upstream turn that is one long tool call: `message_start`, then a
 * `tool_use` block whose input JSON arrives in DELTA_COUNT slow fragments.
 * Every fragment is a withheld chunk, so nothing the adapter emits reaches
 * the client between `message_start` and the post-policy flush.
 */
async function* slowAnthropicToolCall(): AsyncGenerator<StreamEvent> {
  yield messageStart;
  yield {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id: "toolu_write",
      caller: { type: "direct" },
      name: "write_file",
      input: {},
    },
  };
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"content":"' },
  };
  for (let i = 0; i < DELTA_COUNT; i++) {
    await sleep(DELTA_GAP_MS);
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: `line ${i}\\n` },
    };
  }
  yield {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '"}' },
  };
  yield { type: "content_block_stop", index: 0 };
  yield {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: {
      output_tokens: 40,
    } as unknown as Anthropic.Messages.MessageDeltaUsage,
  } as StreamEvent;
  yield { type: "message_stop" };
}

/** The same turn in Bedrock Converse shape, for the binary event-stream route. */
async function* slowBedrockToolCall(): AsyncGenerator<unknown> {
  yield { messageStart: { role: "assistant" } };
  yield {
    contentBlockStart: {
      contentBlockIndex: 0,
      start: { toolUse: { toolUseId: "toolu_write", name: "write_file" } },
    },
  };
  for (let i = 0; i < DELTA_COUNT; i++) {
    await sleep(DELTA_GAP_MS);
    yield {
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { toolUse: { input: i === 0 ? '{"content":"' : `line ${i}` } },
      },
    };
  }
  yield {
    contentBlockDelta: {
      contentBlockIndex: 0,
      delta: { toolUse: { input: '"}' } },
    },
  };
  yield { contentBlockStop: { contentBlockIndex: 0 } };
  yield { messageStop: { stopReason: "tool_use" } };
  yield { metadata: { usage: { inputTokens: 12, outputTokens: 40 } } };
}

type TimedChunk = { at: number; bytes: Uint8Array };

/** Read the whole body, timestamping each chunk as it arrives. */
async function readTimedChunks(response: Response): Promise<TimedChunk[]> {
  const chunks: TimedChunk[] = [];
  const reader = response.body!.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push({ at: Date.now(), bytes: value });
  }
  return chunks;
}

function maxGapMs(chunks: TimedChunk[]): number {
  let max = 0;
  for (let i = 1; i < chunks.length; i++) {
    max = Math.max(max, chunks[i].at - chunks[i - 1].at);
  }
  return max;
}

function concatText(chunks: TimedChunk[]): string {
  return chunks.map((c) => new TextDecoder().decode(c.bytes)).join("");
}

function newApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

describe("LLM proxy stream keep-alive", () => {
  let app: FastifyInstance;
  let testAgent: Agent;
  let baseUrl: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe("Anthropic (text/event-stream)", () => {
    let createStream: () => Promise<unknown>;

    beforeEach(async ({ makeAgent }) => {
      app = newApp();
      createStream = async () => slowAnthropicToolCall();
      vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
        () =>
          ({
            messages: {
              create: async (params: { stream?: boolean }) => {
                if (!params.stream) {
                  throw new Error("test stub only serves streaming requests");
                }
                return createStream();
              },
            },
          }) as never,
      );

      testAgent = await makeAgent({ name: "Keep-alive Agent" });
      await ModelModel.upsert({
        externalId: "anthropic/claude-3-5-sonnet-20241022",
        provider: "anthropic",
        modelId: "claude-3-5-sonnet-20241022",
        inputModalities: null,
        outputModalities: null,
        customPricePerMillionInput: "3.00",
        customPricePerMillionOutput: "15.00",
        lastSyncedAt: new Date(),
      });

      await app.register(anthropicProxyRoutes);
      baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    });

    const postMessages = () =>
      fetch(`${baseUrl}/v1/anthropic/${testAgent.id}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: "Write the file" }],
          tools: [
            {
              name: "write_file",
              description: "Write a file",
              input_schema: {
                type: "object",
                properties: { content: { type: "string" } },
              },
            },
          ],
          stream: true,
        }),
      });

    test("a withheld tool call never leaves the client without bytes for longer than the keep-alive interval", async () => {
      const response = await postMessages();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");

      const chunks = await readTimedChunks(response);
      const body = concatText(chunks);

      // Without the keep-alive the client sees `message_start` and then
      // nothing until the flush: two chunks, one gap the size of the window.
      expect(body).toContain(STREAM_KEEPALIVE_SSE_COMMENT);
      // Leave slack for event-loop scheduling: the bound that matters is
      // "well inside the withheld window", not the exact interval.
      expect(maxGapMs(chunks)).toBeLessThan(WITHHELD_WINDOW_MS / 2);
      expect(maxGapMs(chunks)).toBeLessThan(KEEPALIVE_INTERVAL_MS * 3);
    });

    test("the SDK's own SSE parser reads through the keep-alive comments to the released tool call", async () => {
      const response = await postMessages();
      expect(response.status).toBe(200);

      // Not a hand-rolled parser: this is the code path a real Anthropic
      // client runs on our bytes, so a comment it did not tolerate would
      // throw or drop events here.
      const events: StreamEvent[] = [];
      for await (const event of Stream.fromSSEResponse<StreamEvent>(
        response,
        new AbortController(),
      )) {
        events.push(event);
      }

      const toolStart = events.find(
        (e) =>
          e.type === "content_block_start" &&
          e.content_block.type === "tool_use",
      );
      expect(toolStart).toBeDefined();
      expect(
        toolStart?.type === "content_block_start" &&
          toolStart.content_block.type === "tool_use" &&
          toolStart.content_block.name,
      ).toBe("write_file");
      const input = events
        .flatMap((e) =>
          e.type === "content_block_delta" &&
          e.delta.type === "input_json_delta"
            ? [e.delta.partial_json]
            : [],
        )
        .join("");
      expect(JSON.parse(input)).toEqual({
        content: Array.from(
          { length: DELTA_COUNT },
          (_, i) => `line ${i}\n`,
        ).join(""),
      });
      expect(events.at(-1)?.type).toBe("message_stop");
    });

    // The keep-alive must not defeat lazy header commitment. A provider
    // failure before the first upstream byte has to reach the client as the
    // provider's HTTP status (clients retry on 429/529 and give up on 400),
    // which is impossible once a 200 has been written.
    test("an upstream failure after a silence longer than the interval still returns the provider's status", async () => {
      createStream = async () => {
        await sleep(KEEPALIVE_INTERVAL_MS * 3);
        throw Object.assign(new Error("rate limited upstream"), {
          status: 429,
        });
      };

      const response = await postMessages();
      expect(response.status).toBe(429);
      const body = await response.text();
      expect(body).not.toContain(STREAM_KEEPALIVE_SSE_COMMENT);
    });
  });

  // Bedrock's stream is `application/vnd.amazon.eventstream`: a binary
  // framing with no notion of a comment, where a stray `:` line is a parse
  // error at the client. The keep-alive must stay off it.
  describe("Bedrock (binary event stream)", () => {
    const BEDROCK_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

    beforeEach(async ({ makeAgent }) => {
      app = newApp();
      vi.spyOn(bedrockAdapterFactory, "createClient").mockReturnValue({
        converseStream: async () => slowBedrockToolCall(),
      } as never);

      testAgent = await makeAgent({ name: "Keep-alive Bedrock Agent" });
      await ModelModel.upsert({
        externalId: `bedrock/${BEDROCK_MODEL}`,
        provider: "bedrock",
        modelId: BEDROCK_MODEL,
        inputModalities: null,
        outputModalities: null,
        customPricePerMillionInput: "3.00",
        customPricePerMillionOutput: "15.00",
        lastSyncedAt: new Date(),
      });

      await app.register(bedrockProxyRoutes);
      baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    });

    test("no SSE comment is written into a non-SSE stream, even across a long withheld tool call", async () => {
      const response = await fetch(
        `${baseUrl}/v1/bedrock/${testAgent.id}/converse-stream`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-key",
          },
          body: JSON.stringify({
            modelId: BEDROCK_MODEL,
            messages: [{ role: "user", content: [{ text: "Write the file" }] }],
            toolConfig: {
              tools: [
                {
                  toolSpec: {
                    name: "write_file",
                    inputSchema: { json: { type: "object" } },
                  },
                },
              ],
            },
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/vnd.amazon.eventstream",
      );

      const chunks = await readTimedChunks(response);
      const body = concatText(chunks);

      // The withheld window went by in silence — the transport cannot carry
      // a keep-alive — but the tool call still arrived once policy ran.
      expect(body).not.toContain(STREAM_KEEPALIVE_SSE_COMMENT);
      expect(body).toContain("write_file");
      expect(maxGapMs(chunks)).toBeGreaterThanOrEqual(WITHHELD_WINDOW_MS / 2);
    });
  });
});
