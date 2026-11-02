/** Real proxy + SDK + TCP connections; the local upstream simulates generation. */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel } from "@/models";
import InteractionBillingModel from "@/models/interaction-billing";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import anthropicProxyRoutes from "./routes/anthropic";
import geminiProxyRoutes from "./routes/gemini";
import openaiProxyRoutes from "./routes/openai";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

for (const provider of [
  "anthropic",
  "openai",
  "responses",
  "gemini",
] as const) {
  describe(`${provider} client disconnect`, () => {
    let app: FastifyInstance;
    let upstream: Server;
    let upstreamResponse: ServerResponse | undefined;
    let received: ReturnType<typeof deferred>;
    let closed: boolean;
    let completed: boolean;
    let requests: number;
    let agentId: string;
    let baseUrl: string;
    let token: string;
    let providerFinished: ReturnType<typeof deferred>;
    let clientDisconnected: boolean;
    let finalizationGate: ReturnType<typeof deferred> | undefined;
    let unregister: (() => void) | undefined;
    let failures: number;
    let cleanups: number;
    let completions: number;
    let mode: "headers" | "stream" | "tool-stream" | "complete";
    const model =
      provider === "anthropic"
        ? "claude-3-5-sonnet-20241022"
        : provider === "gemini"
          ? "gemini-2.5-pro"
          : "gpt-4o-mini";

    function sendStart(response: ServerResponse) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (provider === "anthropic") {
        const message = {
          id: "msg-cancel",
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 },
        };
        response.write(
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message })}\n\n`,
        );
        response.write(
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        );
        response.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial"}}\n\n',
        );
      } else if (provider === "gemini") {
        response.write(
          `data: ${JSON.stringify({ responseId: "gemini-cancel", modelVersion: model, candidates: [{ content: { role: "model", parts: [{ text: "Partial" }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1, totalTokenCount: 13 } })}\n\n`,
        );
      } else if (provider === "responses") {
        response.write(
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp-cancel", object: "response", created_at: 1, status: "in_progress", model, output: [] } })}\n\n`,
        );
        response.write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 1, item_id: "msg-cancel", output_index: 0, content_index: 0, delta: "Partial" })}\n\n`,
        );
      } else {
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl-cancel", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "Partial" }, finish_reason: null }] })}\n\n`,
        );
      }
    }

    function sendHeldToolCall(response: ServerResponse) {
      if (provider === "gemini") {
        response.write(
          `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "held-call", name: "lookup", args: {} } }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1, totalTokenCount: 13 } })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "After held call" }] } }] })}\n\n`,
        );
      } else if (provider === "anthropic") {
        response.write(
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        );
        response.write(
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"held-call","name":"lookup","input":{}}}\n\n',
        );
        response.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        );
        response.write(
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        );
        response.write(
          'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n',
        );
        response.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"After held call"}}\n\n',
        );
      } else if (provider === "responses") {
        response.write(
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 2, output_index: 1, item: { type: "function_call", id: "fc-held", call_id: "held-call", name: "lookup", arguments: "{}", status: "in_progress" } })}\n\n`,
        );
        response.write(
          `event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress", sequence_number: 3, response: { id: "resp-cancel", object: "response", created_at: 1, status: "in_progress", model, output: [], usage: { input_tokens: 12, output_tokens: 1, total_tokens: 13 } } })}\n\n`,
        );
        response.write(
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 4, item_id: "msg-cancel", output_index: 0, content_index: 0, delta: "After held call" })}\n\n`,
        );
      } else {
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl-cancel", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "held-call", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl-cancel", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "After held call" }, finish_reason: null }] })}\n\n`,
        );
      }
    }

    function finish(response: ServerResponse) {
      completed = true;
      if (provider === "gemini") {
        response.end(
          `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 40, totalTokenCount: 52 } })}\n\n`,
        );
      } else if (provider === "anthropic") {
        response.write(
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        );
        response.write(
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":40}}\n\n',
        );
        response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else if (provider === "responses") {
        response.end(
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: { id: "resp-cancel", object: "response", created_at: 1, status: "completed", model, output: [], usage: { input_tokens: 12, output_tokens: 40, total_tokens: 52 } } })}\n\n`,
        );
      } else {
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl-cancel", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 } })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      }
    }

    beforeEach(async ({ makeAgent, makeUser, makeMember }) => {
      providerFinished = deferred();
      clientDisconnected = false;
      finalizationGate = undefined;
      failures = 0;
      cleanups = 0;
      completions = 0;
      unregister = registerLlmProxyPlugin({
        id: `disconnect-proof-${crypto.randomUUID()}`,
        onModelResponse: async () => {
          providerFinished.resolve();
          await finalizationGate?.promise;
          return undefined;
        },
        onError: async () => {
          failures++;
        },
        onCleanup: async () => {
          cleanups++;
        },
        onComplete: async () => {
          completions++;
        },
      });
      received = deferred();
      closed = false;
      completed = false;
      requests = 0;
      mode = "stream";
      upstreamResponse = undefined;
      upstream = createServer((request, response) => {
        requests++;
        request.resume();
        request.on("end", () => {
          upstreamResponse = response;
          response.on("close", () => {
            closed = true;
          });
          if (mode !== "headers") sendStart(response);
          if (mode === "tool-stream") sendHeldToolCall(response);
          if (mode === "complete") finish(response);
          received.resolve();
        });
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      const address = upstream.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP upstream");
      config.llm[provider === "responses" ? "openai" : provider].baseUrl =
        `http://127.0.0.1:${address.port}`;
      const agent = await makeAgent({ name: "Cancellation proof" });
      agentId = agent.id;
      const user = await makeUser();
      await makeMember(user.id, agent.organizationId);
      token = await makePassthroughCredential({
        organizationId: agent.organizationId,
        ownerId: user.id,
      });
      app = createFastifyInstance();
      app.addHook("onRequest", async (_request, reply) => {
        reply.raw.on("close", () => {
          if (!reply.raw.writableEnded) clientDisconnected = true;
        });
      });
      await app.register(
        provider === "anthropic"
          ? anthropicProxyRoutes
          : provider === "gemini"
            ? geminiProxyRoutes
            : openaiProxyRoutes,
      );
      baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    });

    afterEach(async () => {
      finalizationGate?.resolve();
      upstreamResponse?.destroy();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await app.close();
      unregister?.();
    });

    function post(signal: AbortSignal, stream = true) {
      const path =
        provider === "anthropic"
          ? `/v1/anthropic/${agentId}/v1/messages`
          : provider === "gemini"
            ? `/v1/gemini/${agentId}/v1beta/models/${model}:streamGenerateContent`
            : provider === "responses"
              ? `/v1/openai/${agentId}/responses`
              : `/v1/openai/${agentId}/chat/completions`;
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": "synthetic-key",
          "x-goog-api-key": "synthetic-key",
          authorization: "Bearer synthetic-key",
          "anthropic-version": "2023-06-01",
          "x-archestra-virtual-key": token,
        },
        body: JSON.stringify(
          provider === "gemini"
            ? {
                contents: [{ role: "user", parts: [{ text: "Count slowly" }] }],
              }
            : {
                model,
                max_tokens: 100,
                stream,
                ...(provider === "responses"
                  ? { input: "Count slowly" }
                  : { messages: [{ role: "user", content: "Count slowly" }] }),
              },
        ),
      });
    }

    // SDK 1.45's early-abort timing gap is intentionally outside this coverage.
    for (const stream of provider === "gemini" ? [] : [true, false]) {
      test(`cancels before upstream headers (stream=${stream})`, async () => {
        mode = "headers";
        const controller = new AbortController();
        const response = post(controller.signal, stream).catch(
          (error: Error) => error,
        );
        await received.promise;
        controller.abort();
        expect(await response).toBeInstanceOf(Error);
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1500 });
        expect(completed).toBe(false);
        expect(requests).toBe(1);
        await vi.waitFor(() => expect(cleanups).toBe(1));
        expect(failures).toBe(1);
        expect(completions).toBe(0);
        await vi.waitFor(async () => {
          const rows =
            await InteractionModel.getAllInteractionsForProfile(agentId);
          expect(rows).toHaveLength(1);
          if (provider === "responses" && stream) {
            expect(rows[0].response).toMatchObject({
              status: "incomplete",
              error: { code: "client_disconnected" },
            });
          }
        });
      });
    }

    test("cancels mid-stream and records only observed usage", async () => {
      const controller = new AbortController();
      const response = await post(controller.signal);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      await reader?.read();
      controller.abort();
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1500 });
      expect(completed).toBe(false);
      expect(requests).toBe(1);
      await vi.waitFor(() => expect(cleanups).toBe(1));
      expect(failures).toBe(1);
      expect(completions).toBe(0);
      await vi.waitFor(async () => {
        const rows =
          await InteractionModel.getAllInteractionsForProfile(agentId);
        expect(rows).toHaveLength(1);
        const reportsPartialUsage =
          provider === "anthropic" || provider === "gemini";
        expect(rows[0].outputTokens).toBe(reportsPartialUsage ? 1 : 0);
        expect(rows[0].inputTokens).toBe(reportsPartialUsage ? 12 : 0);
        if (reportsPartialUsage) {
          const receipts = await InteractionBillingModel.findMany([rows[0].id]);
          expect(receipts).toHaveLength(1);
          expect(receipts[0].usage.status).toBe("incomplete");
          expect(receipts[0].usage.issues).toContain("partial_stream");
        }
      });
    });

    test("discards unreleased tool calls on disconnect while preserving partial usage", async () => {
      mode = "tool-stream";
      const controller = new AbortController();
      const response = await post(controller.signal);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const decoder = new TextDecoder();
      let receivedText = "";
      while (!receivedText.includes("After held call")) {
        const chunk = await reader?.read();
        expect(chunk?.done).toBe(false);
        receivedText += decoder.decode(chunk?.value, { stream: true });
      }
      expect(receivedText).not.toContain("held-call");
      controller.abort();
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1500 });
      await vi.waitFor(() => expect(cleanups).toBe(1));
      expect(failures).toBe(1);
      expect(completions).toBe(0);
      await vi.waitFor(async () => {
        const rows =
          await InteractionModel.getAllInteractionsForProfile(agentId);
        expect(rows).toHaveLength(1);
        expect(rows[0].inputTokens).toBe(provider === "openai" ? 0 : 12);
        expect(rows[0].outputTokens).toBe(provider === "openai" ? 0 : 1);
        expect(JSON.stringify(rows[0].response)).not.toContain("held-call");
        expect(JSON.stringify(rows[0].response)).not.toContain("lookup");
        if (provider === "responses") {
          expect(rows[0].response).toMatchObject({
            status: "incomplete",
            error: {
              code: "client_disconnected",
              message: "Client disconnected during inference",
            },
          });
        }
        if (provider !== "openai") {
          const receipts = await InteractionBillingModel.findMany([rows[0].id]);
          expect(receipts).toHaveLength(1);
          expect(receipts[0].usage.issues).toContain("partial_stream");
        }
      });
    });

    test("preserves final usage when the client disconnects during proxy finalization", async () => {
      mode = "complete";
      finalizationGate = deferred();
      const controller = new AbortController();
      const response = await post(controller.signal);
      expect(response.status).toBe(200);
      await providerFinished.promise;
      controller.abort();
      await vi.waitFor(() => expect(clientDisconnected).toBe(true));
      finalizationGate.resolve();
      await vi.waitFor(async () => {
        const rows =
          await InteractionModel.getAllInteractionsForProfile(agentId);
        expect(rows).toHaveLength(1);
        expect(rows[0].inputTokens).toBe(12);
        expect(rows[0].outputTokens).toBe(40);
        const receipts = await InteractionBillingModel.findMany([rows[0].id]);
        expect(receipts).toHaveLength(1);
        expect(receipts[0].usage.issues).not.toContain("partial_stream");
      });
      await vi.waitFor(() => expect(cleanups).toBe(1));
      expect(completions).toBe(1);
      expect(failures).toBe(0);
    });

    test("preserves normal completion and usage when the client closes afterwards", async () => {
      mode = "complete";
      const controller = new AbortController();
      const response = await post(controller.signal);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        provider === "anthropic"
          ? "message_stop"
          : provider === "responses"
            ? "response.completed"
            : "[DONE]",
      );
      controller.abort();
      expect(completed).toBe(true);
      expect(failures).toBe(0);
      expect(cleanups).toBe(1);
      expect(completions).toBe(1);
      expect(requests).toBe(1);
      const rows = await InteractionModel.getAllInteractionsForProfile(agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0].outputTokens).toBe(40);
      expect(rows[0].inputTokens).toBe(12);
    });
  });
}
