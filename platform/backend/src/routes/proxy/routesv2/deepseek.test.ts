/**
 * DeepSeek Proxy V2 Tests
 *
 * Tests for the unified DeepSeek proxy routes covering:
 * - Streaming response format validation
 * - Cost tracking in database
 * - Interaction recording
 * - Interrupted stream handling
 * - HTTP proxy routing (UUID stripping)
 *
 * DeepSeek uses an OpenAI-compatible API, so these tests mirror
 * the OpenAI V2 test patterns with DeepSeek-specific endpoints.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import { TokenPriceModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { DeepSeek } from "@/types";
import { MockOpenAIClient } from "../mock-openai-client";
import deepseekProxyRoutesV2 from "./deepseek";

describe("DeepSeek V2 proxy streaming", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
  });

  test("streaming response has SSE format", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(deepseekProxyRoutesV2);
    config.benchmark.mockMode = true;

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/deepseek/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.body;
    expect(body).toContain("data: ");
    expect(body).toContain("data: [DONE]");
  });

  test("streaming response contains content chunks", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(deepseekProxyRoutesV2);
    config.benchmark.mockMode = true;

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/deepseek/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    const chunks = response.body
      .split("\n")
      .filter(
        (line: string) => line.startsWith("data: ") && line !== "data: [DONE]",
      )
      .map((line: string) => JSON.parse(line.substring(6)));

    expect(chunks.length).toBeGreaterThan(0);

    const contentChunks = chunks.filter(
      (chunk: DeepSeek.Types.ChatCompletionChunk) =>
        chunk.choices?.[0]?.delta?.content,
    );
    expect(contentChunks.length).toBeGreaterThan(0);
  });
});

describe("DeepSeek V2 cost tracking", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
  });

  test("stores cost and baselineCost in interaction", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(deepseekProxyRoutesV2);
    config.benchmark.mockMode = true;

    await TokenPriceModel.create({
      provider: "deepseek",
      model: "deepseek-chat",
      pricePerMillionInput: "0.27",
      pricePerMillionOutput: "1.10",
    });

    const agent = await makeAgent({ name: "Test Cost Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/deepseek/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "deepseek-chat",
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

describe("DeepSeek V2 streaming mode", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
    MockOpenAIClient.resetStreamOptions();
  });

  test("streaming mode completes normally and records interaction", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(deepseekProxyRoutesV2);
    config.benchmark.mockMode = true;

    await TokenPriceModel.create({
      provider: "deepseek",
      model: "deepseek-chat",
      pricePerMillionInput: "0.27",
      pricePerMillionOutput: "1.10",
    });

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const { InteractionModel } = await import("@/models");

    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);
    const initialCount = initialInteractions.length;

    const response = await app.inject({
      method: "POST",
      url: `/v1/deepseek/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "deepseek-chat",
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

    expect(interaction.type).toBe("deepseek:chatCompletions");
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10);
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
    expect(typeof interaction.cost).toBe("string");
    expect(typeof interaction.baselineCost).toBe("string");
  });

  test(
    "streaming mode interrupted still records interaction",
    { timeout: 10000 },
    async ({ makeAgent }) => {
      const app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);

      config.benchmark.mockMode = true;

      MockOpenAIClient.setStreamOptions({ interruptAtChunk: 4 });

      try {
        await app.register(deepseekProxyRoutesV2);

        await TokenPriceModel.create({
          provider: "deepseek",
          model: "deepseek-chat",
          pricePerMillionInput: "0.27",
          pricePerMillionOutput: "1.10",
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
          url: `/v1/deepseek/${agent.id}/chat/completions`,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-key",
            "user-agent": "test-client",
          },
          payload: {
            model: "deepseek-chat",
            messages: [{ role: "user", content: "Hello!" }],
            stream: true,
          },
        });

        expect(response.statusCode).toBe(200);

        await new Promise((resolve) => setTimeout(resolve, 200));

        const interactions =
          await InteractionModel.getAllInteractionsForProfile(agent.id);
        expect(interactions.length).toBe(initialCount + 1);

        const interaction = interactions[interactions.length - 1];

        expect(interaction.type).toBe("deepseek:chatCompletions");
        expect(interaction.inputTokens).toBe(12);
        expect(interaction.outputTokens).toBe(10);
        expect(interaction.cost).toBeTruthy();
        expect(interaction.baselineCost).toBeTruthy();
      } finally {
        MockOpenAIClient.resetStreamOptions();
      }
    },
  );

  test(
    "streaming mode interrupted before usage handles gracefully",
    { timeout: 10000 },
    async ({ makeAgent }) => {
      const app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);

      config.benchmark.mockMode = true;

      MockOpenAIClient.setStreamOptions({ interruptAtChunk: 2 });

      try {
        await app.register(deepseekProxyRoutesV2);

        await TokenPriceModel.create({
          provider: "deepseek",
          model: "deepseek-chat",
          pricePerMillionInput: "0.27",
          pricePerMillionOutput: "1.10",
        });

        const agent = await makeAgent({
          name: "Test Interrupted Before Usage Agent",
        });

        const response = await app.inject({
          method: "POST",
          url: `/v1/deepseek/${agent.id}/chat/completions`,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-key",
            "user-agent": "test-client",
          },
          payload: {
            model: "deepseek-chat",
            messages: [{ role: "user", content: "Hello!" }],
            stream: true,
          },
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toContain("data: ");
      } finally {
        MockOpenAIClient.resetStreamOptions();
      }
    },
  );
});

describe("DeepSeek V2 proxy routing", () => {
  let app: FastifyInstance;
  let mockUpstream: FastifyInstance;
  let upstreamPort: number;

  beforeEach(async () => {
    mockUpstream = Fastify();

    mockUpstream.get("/models", async () => ({
      object: "list",
      data: [
        {
          id: "deepseek-chat",
          object: "model",
          created: 1687882411,
          owned_by: "deepseek",
        },
        {
          id: "deepseek-reasoner",
          object: "model",
          created: 1677610602,
          owned_by: "deepseek",
        },
      ],
    }));

    mockUpstream.get("/models/:model", async (request) => ({
      id: (request.params as { model: string }).model,
      object: "model",
      created: 1687882411,
      owned_by: "deepseek",
    }));

    await mockUpstream.listen({ port: 0 });
    const address = mockUpstream.server.address();
    upstreamPort = typeof address === "string" ? 0 : address?.port || 0;

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const originalBaseUrl = config.llm.deepseek.baseUrl;
    config.llm.deepseek.baseUrl = `http://localhost:${upstreamPort}`;

    await app.register(async (fastify) => {
      const fastifyHttpProxy = (await import("@fastify/http-proxy")).default;
      const API_PREFIX = "/v1/deepseek";
      const CHAT_COMPLETIONS_SUFFIX = "chat/completions";

      await fastify.register(fastifyHttpProxy, {
        upstream: `http://localhost:${upstreamPort}`,
        prefix: API_PREFIX,
        rewritePrefix: "",
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

    config.llm.deepseek.baseUrl = originalBaseUrl;
  });

  afterEach(async () => {
    await app.close();
    await mockUpstream.close();
  });

  test("proxies /v1/deepseek/models without UUID", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/deepseek/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/deepseek/:uuid/models", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/deepseek/44f56e01-7167-42c1-88ee-64b566fbc34d/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/deepseek/:uuid/models/:model", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/deepseek/44f56e01-7167-42c1-88ee-64b566fbc34d/models/deepseek-chat",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe("deepseek-chat");
    expect(body.object).toBe("model");
  });

  test("does not strip non-UUID segments", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/deepseek/not-a-uuid/models",
    });

    expect(response.statusCode).toBe(404);
  });

  test("skips proxy for chat/completions routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/deepseek/chat/completions",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Hello!" }],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("skips proxy for chat/completions routes with UUID", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/deepseek/44f56e01-7167-42c1-88ee-64b566fbc34d/chat/completions",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Hello!" }],
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
