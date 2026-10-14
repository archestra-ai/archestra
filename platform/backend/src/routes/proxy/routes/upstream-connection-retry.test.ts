import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect } from "vitest";
import config from "@/config";
import InteractionModel from "@/models/interaction";
import ModelModel from "@/models/model";
import { createFastifyInstance } from "@/server";
import { beforeEach, test } from "@/test";
import anthropicProxyRoutes from "./anthropic";
import geminiProxyRoutes from "./gemini";
import openaiProxyRoutes from "./openai";

const MODEL = "claude-3-5-sonnet-20241022";
const MESSAGE = {
  id: "msg_retry",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: [{ type: "text", text: "Recovered" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 1 },
};
const messageStart = {
  type: "message_start",
  message: { ...MESSAGE, content: [], stop_reason: null },
};
const sse = <T extends { type: string }>(event: T) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const SUCCESS_STREAM = [
  messageStart,
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Recovered" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
]
  .map(sse)
  .join("");

const RESPONSES_MESSAGE = {
  id: "msg_retry",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Recovered", annotations: [] }],
};
const OPENAI_RESPONSE = {
  id: "resp_retry",
  object: "response",
  created_at: 1,
  model: "gpt-5.4",
  status: "completed",
  output: [RESPONSES_MESSAGE],
  usage: { input_tokens: 12, output_tokens: 1, total_tokens: 13 },
};
const RESPONSES_STREAM = [
  {
    type: "response.created",
    response: { ...OPENAI_RESPONSE, status: "in_progress", output: [] },
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...RESPONSES_MESSAGE, status: "in_progress", content: [] },
  },
  {
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    item_id: "msg_retry",
    delta: "Recovered",
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: RESPONSES_MESSAGE,
  },
  { type: "response.completed", response: OPENAI_RESPONSE },
]
  .map((event, sequence_number) => sse({ ...event, sequence_number }))
  .join("");

describe("upstream connection retry over HTTP", () => {
  let upstream: Server;
  let app: ReturnType<typeof createFastifyInstance>;
  let agentId: string;
  let requests: unknown[];
  let failure:
    | "headers"
    | "first-event"
    | "partial"
    | "http"
    | "http-truncated";
  let failuresRemaining: number;
  let failedAttemptOverage: boolean;

  beforeEach(async ({ makeAgent }) => {
    requests = [];
    failure = "headers";
    failuresRemaining = 1;
    failedAttemptOverage = false;
    upstream = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body);
        const responses = request.url?.endsWith("/responses");
        requests.push(payload);
        if (failuresRemaining-- > 0) {
          if (failure === "http-truncated") {
            response.writeHead(429, {
              "content-type": "application/json",
              "content-length": "1000",
            });
            response.write('{"error":{"message":"partial');
            setTimeout(() => response.destroy(), 30);
            return;
          }
          if (failure === "http") {
            response.writeHead(429, {
              "content-type": "application/json",
              "retry-after": "3600",
            });
            response.end(
              JSON.stringify({
                type: "error",
                error: { type: "rate_limit_error", message: "Try later" },
              }),
            );
            return;
          }
          if (failure === "headers") {
            response.destroy();
            return;
          }
          response.writeHead(200, {
            "content-type": "text/event-stream",
            ...(failedAttemptOverage
              ? {
                  "anthropic-ratelimit-unified-status": "rejected",
                  "anthropic-ratelimit-unified-overage-status": "allowed",
                }
              : {}),
          });
          response.flushHeaders();
          if (failure === "partial") {
            response.write(
              SUCCESS_STREAM.split("event: content_block_stop")[0],
            );
          }
          // Give fetch time to expose the response, then interrupt its body.
          setTimeout(() => response.destroy(), 30);
          return;
        }
        response.writeHead(200, {
          "content-type": payload.stream
            ? "text/event-stream"
            : "application/json",
        });
        response.end(
          payload.stream
            ? responses
              ? RESPONSES_STREAM
              : SUCCESS_STREAM
            : JSON.stringify(responses ? OPENAI_RESPONSE : MESSAGE),
        );
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    config.llm.anthropic.baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    config.llm.anthropic.vertexAi.enabled = false;
    config.llm.openai.baseUrl = `${config.llm.anthropic.baseUrl}/v1`;
    config.llm.gemini.baseUrl = config.llm.anthropic.baseUrl;
    config.llm.gemini.vertexAi.enabled = false;
    agentId = (await makeAgent({ name: "Transport retry test" })).id;
    await ModelModel.create({
      externalId: `anthropic/${MODEL}`,
      provider: "anthropic",
      modelId: MODEL,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    app = createFastifyInstance();
    await app.register(anthropicProxyRoutes);
    await ModelModel.create({
      externalId: "openai/gpt-5.4",
      provider: "openai",
      modelId: "gpt-5.4",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    await app.register(openaiProxyRoutes);
    await ModelModel.create({
      externalId: "gemini/gemini-2.5-pro",
      provider: "gemini",
      modelId: "gemini-2.5-pro",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    await app.register(geminiProxyRoutes);
  });

  afterEach(async () => {
    await app?.close();
    upstream?.closeAllConnections();
    if (upstream)
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const send = (stream: boolean, apiKey = "test-key") =>
    app.inject({
      method: "POST",
      url: `/v1/anthropic/${agentId}/v1/messages`,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      payload: {
        model: MODEL,
        max_tokens: 256,
        stream,
        messages: [{ role: "user", content: "Hello" }],
      },
    });

  for (const stream of [false, true]) {
    test(`recovers after two connection resets (stream: ${stream})`, async () => {
      failuresRemaining = 2;
      const response = await send(stream);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Recovered");
      expect(response.body).not.toContain("upstream_connection_closed");
      expect(requests).toHaveLength(3);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[2]).toEqual(requests[0]);
    });
  }

  test("reopens a stream interrupted before its first event", async () => {
    failure = "first-event";
    const response = await send(true);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Recovered");
    expect(response.body).not.toContain("event: error");
    expect(requests).toHaveLength(2);
  });

  test("bills the successful attempt without inheriting failed-attempt overage", async () => {
    failure = "first-event";
    failedAttemptOverage = true;
    config.llmCost.subscriptionAutodetect = true;
    const response = await send(true, "sk-ant-oat-test-subscription");
    expect(response.statusCode).toBe(200);
    await app.close();
    const interactions =
      await InteractionModel.getAllInteractionsForProfile(agentId);
    expect(interactions).toHaveLength(1);
    expect(interactions[0].billingMode).toBe("subscription");
    expect(requests).toHaveLength(2);
  });

  for (const stream of [false, true]) {
    test(`recovers an OpenAI Responses connection reset (stream: ${stream})`, async () => {
      if (stream) failure = "first-event";
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agentId}/responses`,
        headers: { authorization: "Bearer test-key" },
        payload: {
          model: "gpt-5.4",
          stream,
          input: [{ role: "user", content: "Hello" }],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("Recovered");
      expect(response.body).not.toContain("upstream_connection_closed");
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
    });
  }

  test("returns a retryable gateway status after exhausting early retries", async () => {
    failuresRemaining = 10;
    const response = await send(true);
    expect(response.statusCode).toBe(502);
    expect(requests).toHaveLength(3);
    expect(response.body).not.toContain("event: message_start");
  });

  for (const stream of [false, true]) {
    test(`does not replay Gemini's ambiguous truncated quota error (stream: ${stream})`, async () => {
      failure = "http-truncated";
      const response = await app.inject({
        method: "POST",
        url: `/v1/gemini/${agentId}/v1beta/models/gemini-2.5-pro:${stream ? "streamGenerateContent" : "generateContent"}`,
        headers: { "x-goog-api-key": "test-key" },
        payload: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      });
      // The SDK lost the original status; do not turn that loss into a replay.
      expect(response.statusCode).toBe(502);
      expect(requests).toHaveLength(1);
    });
  }

  test("does not restart a stream after output has arrived", async () => {
    failure = "partial";
    const response = await send(true);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Recovered");
    expect(response.body).toContain("upstream_connection_closed");
    expect(requests).toHaveLength(1);
  });

  test("relays a quota error without retrying or waiting for Retry-After", async () => {
    failure = "http";
    const response = await send(true);
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("3600");
    expect(response.json().error.type).toBe("rate_limit_error");
    expect(requests).toHaveLength(1);
  });
});
