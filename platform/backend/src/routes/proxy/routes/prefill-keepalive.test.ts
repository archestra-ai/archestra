import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import InteractionModel from "@/models/interaction";
import ModelModel from "@/models/model";
import { beforeEach, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { STREAM_KEEPALIVE_SSE_COMMENT } from "../stream-keepalive";
import anthropicProxyRoutes from "./anthropic";
import openaiProxyRoutes from "./openai";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const event = (value: { type: string }) =>
  `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const usage = { input_tokens: 12, output_tokens: 1 };
const message = {
  id: "msg_prefill",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text: "Hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage,
};
const anthropicStream = [
  {
    type: "message_start",
    message: { ...message, content: [], stop_reason: null },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
].map(event);
const response = {
  id: "resp_prefill",
  object: "response",
  created_at: 1,
  model: "gpt-test",
  status: "completed",
  output: [],
  usage: { ...usage, total_tokens: 13 },
};
const responsesStream = [
  {
    type: "response.created",
    response: { ...response, status: "in_progress" },
  },
  { type: "response.completed", response },
].map(event);
const chatStream = [
  {
    id: "chat_prefill",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "Hello" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chat_prefill",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
  },
]
  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
  .concat("data: [DONE]\n\n");

describe("prefill SSE keep-alives over HTTP", () => {
  let app: ReturnType<typeof createFastifyInstance>;
  let upstream: ReturnType<typeof createServer>;
  let baseUrl: string;
  let agentId: string;
  let credential: string;
  let release: ReturnType<typeof deferred>;
  let received: ReturnType<typeof deferred>;
  let requests: number;
  let respond: (
    response: ServerResponse,
    payload: { stream: boolean },
    path: string,
  ) => Promise<void>;

  beforeEach(async ({ makeAgent, makeMember, makeUser }) => {
    config.llmProxy.streamKeepAliveIntervalMs = 30;
    config.llmProxy.streamKeepAliveDuringPrefill = true;
    release = deferred();
    received = deferred();
    requests = 0;
    respond = async (raw, payload, path) => {
      await release.promise;
      if (!payload.stream) {
        raw.writeHead(200, { "content-type": "application/json" });
        raw.end(JSON.stringify(message));
        return;
      }
      raw.writeHead(200, { "content-type": "text/event-stream" });
      raw.end(
        (path.endsWith("/responses")
          ? responsesStream
          : path.endsWith("/chat/completions")
            ? chatStream
            : anthropicStream
        ).join(""),
      );
    };
    upstream = createServer((req, raw) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests++;
        received.resolve();
        void respond(raw, JSON.parse(body), req.url ?? "");
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    config.llm.anthropic.baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    config.llm.anthropic.vertexAi.enabled = false;
    config.llm.openai.baseUrl = `${config.llm.anthropic.baseUrl}/v1`;
    const agent = await makeAgent({ name: "Prefill test" });
    agentId = agent.id;
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    credential = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    for (const [provider, modelId] of [
      ["anthropic", "claude-test"],
      ["openai", "gpt-test"],
    ] as const) {
      await ModelModel.create({
        externalId: `${provider}/${modelId}`,
        provider,
        modelId,
        inputModalities: ["text"],
        outputModalities: ["text"],
      });
    }
    app = createFastifyInstance();
    await app.register(anthropicProxyRoutes);
    await app.register(openaiProxyRoutes);
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterEach(async () => {
    release.resolve();
    await app?.close();
    upstream?.closeAllConnections();
    if (upstream)
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const send = (
    endpoint = "messages",
    stream = true,
    signal = AbortSignal.timeout(3000),
  ) =>
    fetch(
      `${baseUrl}/v1/${endpoint === "messages" ? "anthropic" : "openai"}/${agentId}/${endpoint === "messages" ? "v1/messages" : endpoint}`,
      {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          authorization: "Bearer test-key",
          "anthropic-version": "2023-06-01",
          "x-archestra-virtual-key": credential,
        },
        body: JSON.stringify({
          model: endpoint === "messages" ? "claude-test" : "gpt-test",
          max_tokens: 256,
          stream,
          ...(endpoint === "responses"
            ? { input: "Hello" }
            : { messages: [{ role: "user", content: "Hello" }] }),
        }),
      },
    );

  for (const endpoint of ["messages", "chat/completions", "responses"]) {
    test(`sends comments before upstream headers on ${endpoint} and preserves the response and usage`, async () => {
      try {
        const result = await send(endpoint);
        if (!result.body) throw new Error("Expected SSE body");
        const reader = result.body.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe(
          STREAM_KEEPALIVE_SSE_COMMENT,
        );
        expect(requests).toBe(1);
        release.resolve();
        let body = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          body += new TextDecoder().decode(chunk.value);
        }
        expect(body).toContain(
          endpoint === "responses"
            ? "response.completed"
            : endpoint === "messages"
              ? "message_stop"
              : "[DONE]",
        );
        expect(body).not.toContain("event: error");
        await app.close();
        const interactions =
          await InteractionModel.getAllInteractionsForProfile(agentId);
        expect(interactions).toHaveLength(1);
        expect(interactions[0].inputTokens).toBe(12);
        expect(interactions[0].outputTokens).toBe(1);
      } finally {
        release.resolve();
      }
    });
  }

  test("reports a delayed upstream 429 as an SSE error after a heartbeat", async () => {
    respond = async (raw) => {
      await release.promise;
      raw.writeHead(429, { "content-type": "application/json" });
      raw.end(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Try later" },
        }),
      );
    };
    const result = await send();
    expect(result.status).toBe(200);
    release.resolve();
    const body = await result.text();
    expect(body).toContain(STREAM_KEEPALIVE_SSE_COMMENT);
    expect(body).toContain("event: error");
    expect(body).toContain("rate_limit_error");
    expect(requests).toBe(1);
  });

  test.each([
    "prefill",
    "interval",
  ])("retains the HTTP error status with %s keep-alives disabled", async (setting) => {
    if (setting === "prefill")
      config.llmProxy.streamKeepAliveDuringPrefill = false;
    else config.llmProxy.streamKeepAliveIntervalMs = 0;
    respond = async (raw) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      raw.writeHead(429, { "content-type": "application/json" });
      raw.end(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Try later" },
        }),
      );
    };
    const result = await send();
    expect(result.status).toBe(429);
    expect(await result.text()).not.toContain(STREAM_KEEPALIVE_SSE_COMMENT);
  });

  test("keeps a silent mid-stream response alive without releasing or inventing model events", async () => {
    config.llmProxy.streamKeepAliveDuringPrefill = false;
    respond = async (raw) => {
      raw.writeHead(200, { "content-type": "text/event-stream" });
      raw.write(anthropicStream[0]);
      await release.promise;
      raw.end(anthropicStream.slice(1).join(""));
    };
    try {
      const result = await send();
      if (!result.body) throw new Error("Expected SSE body");
      const reader = result.body.getReader();
      let body = "";
      while (!body.includes(STREAM_KEEPALIVE_SSE_COMMENT)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Stream ended before keep-alive");
        body += new TextDecoder().decode(chunk.value);
      }
      expect(body).toContain("message_start");
      expect(body).not.toContain("content_block_delta");
      release.resolve();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += new TextDecoder().decode(chunk.value);
      }
      expect(body).toContain("message_stop");
      expect(body.match(/event: content_block_delta/g)).toHaveLength(1);
    } finally {
      release.resolve();
    }
  });

  test("still retries a connection reset before the first provider event after a heartbeat", async () => {
    const succeed = respond;
    respond = async (raw, payload, path) => {
      if (requests === 1) {
        await release.promise;
        raw.destroy();
      } else await succeed(raw, payload, path);
    };
    const result = await send();
    release.resolve();
    const body = await result.text();
    expect(body).toContain(STREAM_KEEPALIVE_SSE_COMMENT);
    expect(body).toContain("message_stop");
    expect(body).not.toContain("event: error");
    expect(requests).toBe(2);
  });

  test("preserves usage draining when a client disconnects during prefill", async () => {
    let downstreamClosed = false;
    app.server.on("connection", (socket) => {
      socket.on("close", () => {
        downstreamClosed = true;
      });
    });
    const controller = new AbortController();
    const result = await send("messages", true, controller.signal);
    expect(result.status).toBe(200);
    await received.promise;
    controller.abort();
    await vi.waitFor(() => expect(downstreamClosed).toBe(true));
    release.resolve();
    await app.close();
    const interactions =
      await InteractionModel.getAllInteractionsForProfile(agentId);
    expect(interactions).toHaveLength(1);
    expect(interactions[0].inputTokens).toBe(12);
    expect(interactions[0].outputTokens).toBe(1);
    expect(requests).toBe(1);
  });

  test("does not add comments to non-streaming responses", async () => {
    const pending = send("messages", false);
    await received.promise;
    await new Promise((resolve) => setTimeout(resolve, 100));
    release.resolve();
    const result = await pending;
    expect(result.headers.get("content-type")).toContain("application/json");
    expect(await result.json()).toMatchObject({ content: message.content });
  });
});
