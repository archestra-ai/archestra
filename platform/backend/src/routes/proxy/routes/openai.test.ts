/**
 * OpenAI Proxy Tests
 *
 * Tests for the unified OpenAI proxy routes covering:
 * - Streaming response format validation
 * - Cost tracking in database
 * - Interaction recording
 * - Interrupted stream handling
 * - HTTP proxy routing (UUID stripping)
 *
 * Current behavior notes:
 * - Streaming headers are written alongside SSE chunks sent through
 *   reply.raw.write(), so inject-based assertions focus on the body format.
 * - The adapter forwards only chunks with actual delta content.
 * - Interrupted streams may not record interactions before usage data arrives.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import config from "@/config";
import { ModelModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import type { OpenAi } from "@/types";
import {
  openAiResponsesAdapterFactory,
  openaiAdapterFactory,
} from "../adapters";
import openAiProxyRoutes from "./openai";

function createOpenAiResponsesTestClient() {
  return {
    responses: {
      create: async (params: { stream?: boolean }) => {
        if (params.stream) {
          return {
            [Symbol.asyncIterator]: async function* () {
              yield {
                type: "response.created",
                response: {
                  id: "resp-test-openai",
                  object: "response",
                  created_at: Math.floor(Date.now() / 1000),
                  model: "gpt-4o",
                  status: "in_progress",
                  output: [],
                },
              };
              yield {
                type: "response.output_text.delta",
                delta: "Hello from Responses",
              };
              yield {
                type: "response.completed",
                response: {
                  id: "resp-test-openai",
                  object: "response",
                  created_at: Math.floor(Date.now() / 1000),
                  model: "gpt-4o",
                  status: "completed",
                  output: [
                    {
                      id: "msg-test-openai",
                      type: "message",
                      role: "assistant",
                      status: "completed",
                      content: [
                        {
                          type: "output_text",
                          text: "Hello from Responses",
                          annotations: [],
                        },
                      ],
                    },
                  ],
                  usage: {
                    input_tokens: 12,
                    output_tokens: 10,
                    total_tokens: 22,
                  },
                },
              };
            },
          };
        }

        return {
          id: "resp-test-openai",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          model: "gpt-4o",
          status: "completed",
          output: [
            {
              id: "msg-test-openai",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "Hello from Responses",
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 10,
            total_tokens: 22,
          },
        };
      },
    },
  };
}

describe("OpenAI proxy streaming", () => {
  let openAiStubOptions: { interruptAtChunk?: number };

  beforeEach(() => {
    openAiStubOptions = {};
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient(openAiStubOptions) as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("streaming response has SSE format", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutes);

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    // The route uses reply.raw.write() which produces SSE format
    const body = response.body;
    expect(body).toContain("data: ");
    expect(body).toContain("data: [DONE]");
  });

  test("streaming response contains content chunks", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutes);

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    //  adapter only emits chunks with actual content
    const chunks = response.body
      .split("\n")
      .filter(
        (line: string) => line.startsWith("data: ") && line !== "data: [DONE]",
      )
      .map((line: string) => JSON.parse(line.substring(6)));

    // Should have content chunks
    expect(chunks.length).toBeGreaterThan(0);

    // At least one chunk should have content
    const contentChunks = chunks.filter(
      (chunk: OpenAi.Types.ChatCompletionChunk) =>
        chunk.choices?.[0]?.delta?.content,
    );
    expect(contentChunks.length).toBeGreaterThan(0);
  });
});

describe("OpenAI cost tracking", () => {
  beforeEach(() => {
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("stores cost and baselineCost in interaction", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutes);

    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({ name: "Test Cost Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);

    const { InteractionModel } = await import("@/models");
    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBeGreaterThan(0);

    const interaction = interactions[interactions.length - 1];
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
    expect(typeof interaction.cost).toBe("string");
    expect(typeof interaction.baselineCost).toBe("string");
  });
});

describe("OpenAI Responses proxy", () => {
  beforeEach(() => {
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiResponsesTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("creates a response and records an openai responses interaction", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutes);

    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({ name: "Test Responses Agent" });
    const { InteractionModel } = await import("@/models");
    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        input: "Hello!",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "response",
      model: "gpt-4o",
      output: [
        expect.objectContaining({
          type: "message",
        }),
      ],
    });

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialInteractions.length + 1);
    const interaction = interactions[interactions.length - 1];
    expect(interaction.type).toBe("openai:responses");
    expect(interaction.model).toBe("gpt-4o");
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10);
  });

  test("streams responses as OpenAI Responses SSE events", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutes);

    const agent = await makeAgent({ name: "Test Streaming Responses Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        input: "Hello!",
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("data: ");
    expect(response.body).toContain('"type":"response.output_text.delta"');
    expect(response.body).toContain("data: [DONE]");
  });
});

describe("OpenAI streaming mode", () => {
  let openAiStubOptions: { interruptAtChunk?: number };

  beforeEach(() => {
    openAiStubOptions = {};
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient(openAiStubOptions) as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("streaming mode completes normally and records interaction", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutes);

    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const { InteractionModel } = await import("@/models");

    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);
    const initialCount = initialInteractions.length;

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.body;
    expect(body).toContain("data: ");
    expect(body).toContain('"finish_reason":"stop"');

    await new Promise((resolve) => setTimeout(resolve, 100));

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);

    const interaction = interactions[interactions.length - 1];

    expect(interaction.type).toBe("openai:chatCompletions");
    expect(interaction.model).toBe("gpt-4o");
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10);
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
    expect(typeof interaction.cost).toBe("string");
    expect(typeof interaction.baselineCost).toBe("string");
  });

  test("streaming mode interrupted still records interaction", {
    timeout: 10000,
  }, async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Configure stub to interrupt at chunk 4 (after usage chunk but before stream completes)
    openAiStubOptions.interruptAtChunk = 4;

    await app.register(openAiProxyRoutes);

    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({
      name: "Test Interrupted Streaming Agent",
    });

    const { InteractionModel } = await import("@/models");

    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);
    const initialCount = initialInteractions.length;

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    // Stream ends early but request should complete successfully
    expect(response.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify interaction was still recorded despite interruption
    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);

    const interaction = interactions[interactions.length - 1];

    expect(interaction.type).toBe("openai:chatCompletions");
    expect(interaction.model).toBe("gpt-4o");
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10);
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
  });

  test("streaming mode interrupted before usage handles gracefully", {
    timeout: 10000,
  }, async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Configure stub to interrupt at chunk 2 (before usage chunk)
    openAiStubOptions.interruptAtChunk = 2;

    await app.register(openAiProxyRoutes);

    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({
      name: "Test Interrupted Before Usage Agent",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    // Request should complete without error even when stream is interrupted
    expect(response.statusCode).toBe(200);

    // Response should have partial SSE data
    expect(response.body).toContain("data: ");
  });
});

describe("OpenAI proxy routing", () => {
  let app: FastifyInstance;
  let mockUpstream: FastifyInstance;
  let upstreamPort: number;

  beforeEach(async () => {
    mockUpstream = Fastify();

    mockUpstream.get("/v1/models", async () => ({
      object: "list",
      data: [
        {
          id: "gpt-4",
          object: "model",
          created: 1687882411,
          owned_by: "openai",
        },
        {
          id: "gpt-3.5-turbo",
          object: "model",
          created: 1677610602,
          owned_by: "openai",
        },
      ],
    }));

    mockUpstream.get("/v1/models/:model", async (request) => ({
      id: (request.params as { model: string }).model,
      object: "model",
      created: 1687882411,
      owned_by: "openai",
    }));

    await mockUpstream.listen({ port: 0 });
    const address = mockUpstream.server.address();
    upstreamPort = typeof address === "string" ? 0 : address?.port || 0;

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const originalBaseUrl = config.llm.openai.baseUrl;
    config.llm.openai.baseUrl = `http://localhost:${upstreamPort}`;

    await app.register(async (fastify) => {
      const fastifyHttpProxy = (await import("@fastify/http-proxy")).default;
      const API_PREFIX = "/v1/openai";
      const CHAT_COMPLETIONS_SUFFIX = "chat/completions";

      await fastify.register(fastifyHttpProxy, {
        upstream: `http://localhost:${upstreamPort}`,
        prefix: API_PREFIX,
        rewritePrefix: "/v1",
        preHandler: (request, reply, next) => {
          const urlPath = request.url.split("?")[0];
          if (
            request.method === "POST" &&
            urlPath.endsWith(CHAT_COMPLETIONS_SUFFIX)
          ) {
            reply.code(400).send({
              error: {
                message:
                  "Chat completions requests should use the dedicated endpoint",
                type: "invalid_request_error",
              },
            });
            return;
          }

          const pathAfterPrefix = request.url.replace(API_PREFIX, "");
          const uuidMatch = pathAfterPrefix.match(
            /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i,
          );

          if (uuidMatch) {
            const remainingPath = uuidMatch[2] || "";
            request.raw.url = `${API_PREFIX}${remainingPath}`;
          }

          next();
        },
      });
    });

    config.llm.openai.baseUrl = originalBaseUrl;
  });

  afterEach(async () => {
    await app.close();
    await mockUpstream.close();
  });

  test("proxies /v1/openai/models without UUID", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/openai/:uuid/models", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/44f56e01-7167-42c1-88ee-64b566fbc34d/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/openai/:uuid/models/:model", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/44f56e01-7167-42c1-88ee-64b566fbc34d/models/gpt-4",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe("gpt-4");
    expect(body.object).toBe("model");
  });

  test("does not strip non-UUID segments", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/not-a-uuid/models",
    });

    // This should try to proxy to /v1/not-a-uuid/models which won't exist
    expect(response.statusCode).toBe(404);
  });

  test("skips proxy for chat/completions routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/openai/chat/completions",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
      },
    });

    // Should get 400 because the preHandler blocks proxy forwarding with a clean error response
    expect(response.statusCode).toBe(400);
  });

  test("skips proxy for chat/completions routes with UUID", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/openai/44f56e01-7167-42c1-88ee-64b566fbc34d/chat/completions",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
      },
    });

    // Should get 400 because the preHandler blocks proxy forwarding with a clean error response
    expect(response.statusCode).toBe(400);
  });
});
