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
import openaiProxyRoutes from "./routes/openai";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

for (const provider of ["anthropic", "openai", "responses"] as const) {
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
    let finalizationGate: ReturnType<typeof deferred> | undefined;
    let unregister: (() => void) | undefined;
    let failures: number;
    let cleanups: number;
    let completions: number;
    let mode: "headers" | "stream" | "complete";
    const model =
      provider === "anthropic" ? "claude-3-5-sonnet-20241022" : "gpt-4o-mini";

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

    function finish(response: ServerResponse) {
      completed = true;
      if (provider === "anthropic") {
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
      await app.register(
        provider === "anthropic" ? anthropicProxyRoutes : openaiProxyRoutes,
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
          : provider === "responses"
            ? `/v1/openai/${agentId}/responses`
            : `/v1/openai/${agentId}/chat/completions`;
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": "synthetic-key",
          authorization: "Bearer synthetic-key",
          "anthropic-version": "2023-06-01",
          "x-archestra-virtual-key": token,
        },
        body: JSON.stringify({
          model,
          max_tokens: 100,
          stream,
          ...(provider === "responses"
            ? { input: "Count slowly" }
            : { messages: [{ role: "user", content: "Count slowly" }] }),
        }),
      });
    }

    for (const stream of [true, false]) {
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
        await vi.waitFor(async () =>
          expect(
            await InteractionModel.getAllInteractionsForProfile(agentId),
          ).toHaveLength(1),
        );
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
        expect(rows[0].outputTokens).toBe(provider === "anthropic" ? 1 : 0);
        expect(rows[0].inputTokens).toBe(provider === "anthropic" ? 12 : 0);
        if (provider === "anthropic") {
          const receipts = await InteractionBillingModel.findMany([rows[0].id]);
          expect(receipts).toHaveLength(1);
          expect(receipts[0].usage.status).toBe("incomplete");
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
