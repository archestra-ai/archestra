/** Real proxy + SDK + TCP connections; the local upstream simulates generation. */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import {
  AgentModel,
  InteractionModel,
  ModelModel,
  ModelPoolModel,
  VirtualApiKeyModel,
} from "@/models";
import InteractionBillingModel from "@/models/interaction-billing";
import LimitModel, { LimitValidationService } from "@/models/limit";
import LlmThroughputModel from "@/models/llm-throughput";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
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
    let handlerFinished: ReturnType<typeof deferred>;
    let clientDisconnected: boolean;
    let finalizationGate: ReturnType<typeof deferred> | undefined;
    let policyGate: ReturnType<typeof deferred> | undefined;
    let policyStarted: ReturnType<typeof deferred>;
    let bufferResponse: boolean;
    let invalidPolicyBatch: "added" | "duplicate" | undefined;
    let unregister: (() => void) | undefined;
    let failures: number;
    let failure: unknown;
    let cleanups: number;
    let completions: number;
    let mode:
      | "headers"
      | "stream"
      | "tool-stream"
      | "terminal-tool-stream"
      | "complete";
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
          `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { id: "held-call", name: "lookup", args: {} } }] }, ...(mode === "terminal-tool-stream" ? { finishReason: "STOP" } : {}) }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1, totalTokenCount: 13 } })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ candidates: [{ index: mode === "terminal-tool-stream" ? 1 : 0, content: { role: "model", parts: [{ text: "After held call" }] } }] })}\n\n`,
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
      handlerFinished = deferred();
      clientDisconnected = false;
      finalizationGate = undefined;
      policyGate = undefined;
      bufferResponse = false;
      invalidPolicyBatch = undefined;
      policyStarted = deferred();
      failures = 0;
      failure = undefined;
      cleanups = 0;
      completions = 0;
      unregister = registerLlmProxyPlugin({
        id: `disconnect-proof-${crypto.randomUUID()}`,
        buffersModelResponse: () => bufferResponse,
        onToolCalls: async ({ toolCalls }) => {
          policyStarted.resolve();
          await policyGate?.promise;
          if (invalidPolicyBatch)
            return {
              decision: "allow",
              toolCalls:
                invalidPolicyBatch === "added"
                  ? [{ ...toolCalls[0], id: "added-call" }]
                  : [toolCalls[0], toolCalls[0]],
            };
          return undefined;
        },
        onModelResponse: async () => {
          providerFinished.resolve();
          await finalizationGate?.promise;
          return undefined;
        },
        onError: async ({ error }) => {
          failure = error;
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
          if (mode === "tool-stream" || mode === "terminal-tool-stream")
            sendHeldToolCall(response);
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
      app.addHook("onRoute", (route) => {
        if (route.method !== "POST" || !route.url.endsWith("/chat/completions"))
          return;
        const handler = route.handler;
        route.handler = async function (request, reply) {
          try {
            return await handler.call(this, request, reply);
          } finally {
            handlerFinished.resolve();
          }
        };
      });
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
      policyGate?.resolve();
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

    if (provider === "openai") {
      describe("model-pool budget refusal", () => {
        setupTestCacheManager();

        for (const stream of [true, false]) {
          test(`does not record an unsent member when its budget refusal races with disconnect (stream=${stream})`, async ({
            makeSecret,
            makeLlmProviderApiKey,
          }) => {
            config.llmProxy.modelPoolsEnabled = true;
            const agent = await AgentModel.findById(agentId);
            if (!agent) throw new Error("Expected proxy agent");
            const key = await makeLlmProviderApiKey(
              agent.organizationId,
              (await makeSecret({ secret: { apiKey: "synthetic-key" } })).id,
              { provider: "openai" },
            );
            const { virtualKey, value: poolToken } =
              await VirtualApiKeyModel.create({
                organizationId: agent.organizationId,
                name: "budget-disconnect-key",
                providerApiKeys: [
                  { provider: "openai", providerApiKeyId: key.id },
                ],
              });
            await ModelModel.create({
              externalId: `openai/${model}`,
              provider: "openai",
              modelId: model,
              inputModalities: ["text"],
              outputModalities: ["text"],
              customPricePerMillionInput: "1",
              customPricePerMillionOutput: "1",
            });
            await ModelPoolModel.create({
              organizationId: agent.organizationId,
              input: {
                name: "budget-disconnect-pool",
                members: [
                  {
                    providerApiKeyId: key.id,
                    modelId: model,
                    priority: 1,
                    weight: 1,
                    enabled: true,
                  },
                ],
              },
            });
            const budget = await LimitModel.create({
              entityType: "virtual_key",
              entityId: virtualKey.id,
              limitType: "token_cost",
              limitValue: 0,
              model: [model],
              lastCleanup: new Date(),
            });
            const rpm = await LimitModel.create({
              entityType: "organization",
              entityId: agent.organizationId,
              limitType: "requests_per_minute",
              limitValue: 1,
            });
            const originalSpend = await LimitModel.getTokenCostTotals([
              budget.id,
            ]);
            const decisionReady = deferred();
            const releaseDecision = deferred();
            const checkLimits =
              LimitValidationService.checkLimitsBeforeRequest.bind(
                LimitValidationService,
              );
            // Run the real stored-budget check, delaying only delivery of its
            // result so the TCP disconnect deterministically wins this race.
            const check = vi
              .spyOn(LimitValidationService, "checkLimitsBeforeRequest")
              .mockImplementation(async (params) => {
                const violation = await checkLimits(params);
                if (
                  params.model === model &&
                  !params.deferModelScopedLimits &&
                  violation
                ) {
                  decisionReady.resolve();
                  await releaseDecision.promise;
                }
                return violation;
              });
            const controller = new AbortController();
            const response = fetch(
              `${baseUrl}/v1/openai/${agentId}/chat/completions`,
              {
                method: "POST",
                signal: controller.signal,
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${poolToken}`,
                },
                body: JSON.stringify({
                  model: "budget-disconnect-pool",
                  stream,
                  messages: [{ role: "user", content: "Hello" }],
                }),
              },
            ).catch((error: Error) => error);
            try {
              await decisionReady.promise;
              controller.abort();
              expect(await response).toBeInstanceOf(Error);
              await vi.waitFor(() => expect(clientDisconnected).toBe(true));
              releaseDecision.resolve();
              // Cleanup plugins run before persistence; wait for the entire
              // real route handler before asserting the absence of writes.
              await handlerFinished.promise;
              expect(requests).toBe(0);
              expect
                .soft(
                  await InteractionModel.getAllInteractionsForProfile(agentId),
                )
                .toEqual([]);
              expect
                .soft(await db.select().from(schema.interactionBillingTable))
                .toEqual([]);
              expect(await LimitModel.getTokenCostTotals([budget.id])).toEqual(
                originalSpend,
              );
              expect(
                (await LlmThroughputModel.usage([rpm])).get(rpm.id)
                  ?.currentUsage,
              ).toBeCloseTo(0);
              expect(failures).toBe(1);
              expect(failure).toMatchObject({ statusCode: 402 });
              expect(cleanups).toBe(1);
              expect(completions).toBe(0);
            } finally {
              releaseDecision.resolve();
              controller.abort();
              check.mockRestore();
            }
          });
        }
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
        expect(rows[0].outputTokens).toBe(reportsPartialUsage ? 1 : null);
        expect(rows[0].inputTokens).toBe(reportsPartialUsage ? 12 : null);
        if (reportsPartialUsage) {
          const receipts = await InteractionBillingModel.findMany([rows[0].id]);
          expect(receipts).toHaveLength(1);
          expect(receipts[0].usage.status).toBe("incomplete");
          expect(receipts[0].usage.issues).toContain("partial_stream");
        }
      });
    });

    for (const earlyTerminal of provider === "gemini"
      ? [false, true]
      : [false]) {
      test(`discards unreleased tool calls on disconnect while preserving partial usage (early terminal=${earlyTerminal})`, async () => {
        mode = earlyTerminal ? "terminal-tool-stream" : "tool-stream";
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
          expect(rows[0].inputTokens).toBe(provider === "openai" ? null : 12);
          expect(rows[0].outputTokens).toBe(provider === "openai" ? null : 1);
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
            const receipts = await InteractionBillingModel.findMany([
              rows[0].id,
            ]);
            expect(receipts).toHaveLength(1);
            expect(receipts[0].usage.status).toBe("incomplete");
            expect(receipts[0].usage.issues).toContain("partial_stream");
          }
        });
      });
    }

    if (provider === "gemini") {
      test("discards unreleased calls on a post-drain policy disconnect while preserving final usage", async () => {
        mode = "tool-stream";
        policyGate = deferred();
        const controller = new AbortController();
        const response = await post(controller.signal);
        expect(response.status).toBe(200);
        if (!upstreamResponse) throw new Error("Upstream request missing");
        finish(upstreamResponse);
        await policyStarted.promise;
        controller.abort();
        await vi.waitFor(() => expect(clientDisconnected).toBe(true));
        policyGate.resolve();
        await vi.waitFor(async () => {
          const rows =
            await InteractionModel.getAllInteractionsForProfile(agentId);
          expect(rows).toHaveLength(1);
          expect(JSON.stringify(rows[0].response)).not.toContain("held-call");
          expect(JSON.stringify(rows[0].response)).not.toContain("lookup");
          expect(rows[0].inputTokens).toBe(12);
          expect(rows[0].outputTokens).toBe(40);
          const receipts = await InteractionBillingModel.findMany([rows[0].id]);
          expect(receipts).toHaveLength(1);
          expect(receipts[0].usage.issues).not.toContain("partial_stream");
        });
      });
    }

    if (provider === "gemini") {
      test("discards buffered calls when the client disconnects during final response policy", async () => {
        mode = "tool-stream";
        bufferResponse = true;
        finalizationGate = deferred();
        const controller = new AbortController();
        const request = post(controller.signal).catch(() => undefined);
        await received.promise;
        if (!upstreamResponse) throw new Error("Upstream request missing");
        finish(upstreamResponse);
        await providerFinished.promise;
        controller.abort();
        await vi.waitFor(() => expect(clientDisconnected).toBe(true));
        finalizationGate.resolve();
        await request;
        await vi.waitFor(async () => {
          const rows =
            await InteractionModel.getAllInteractionsForProfile(agentId);
          expect(rows).toHaveLength(1);
          expect(JSON.stringify(rows[0].response)).not.toContain("held-call");
          expect(JSON.stringify(rows[0].response)).not.toContain("lookup");
          expect(rows[0].inputTokens).toBe(12);
          expect(rows[0].outputTokens).toBe(40);
          const receipts = await InteractionBillingModel.findMany([rows[0].id]);
          expect(receipts).toHaveLength(1);
          expect(receipts[0].usage.issues).not.toContain("partial_stream");
        });
      });
    }

    if (provider === "gemini") {
      test.for([
        "added",
        "duplicate",
      ] as const)("discards unreleased calls when policy mapping fails (%s)", async (batch) => {
        mode = "tool-stream";
        invalidPolicyBatch = batch;
        const response = await post(new AbortController().signal);
        if (!upstreamResponse) throw new Error("Upstream request missing");
        finish(upstreamResponse);
        const delivered = await response.text();
        expect(delivered).not.toContain("functionCall");
        expect(delivered).not.toContain("held-call");
        await vi.waitFor(async () => {
          const rows =
            await InteractionModel.getAllInteractionsForProfile(agentId);
          expect(rows).toHaveLength(1);
          expect(JSON.stringify(rows[0].response)).not.toContain("held-call");
          expect(JSON.stringify(rows[0].response)).not.toContain("lookup");
          expect(rows[0].inputTokens).toBe(12);
          expect(rows[0].outputTokens).toBe(40);
          const receipts = await InteractionBillingModel.findMany([rows[0].id]);
          expect(receipts).toHaveLength(1);
          expect(receipts[0].usage.issues).not.toContain("partial_stream");
        });
        expect(failures).toBe(1);
      });
    }

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
