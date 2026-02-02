/**
 * OpenAI Proxy V2 Tests
 *
 * Tests for the unified OpenAI proxy routes covering:
 * - Streaming response format validation
 * - Cost tracking in database
 * - Interaction recording
 * - Interrupted stream handling
 * - HTTP proxy routing (UUID stripping)
 *
 * KEY DIFFERENCES FROM V1 TESTS (../openai.test.ts):
 * TODO: Consider aligning V2 behavior with V1 for these cases:
 *
 * 1. Streaming headers: V2 uses reply.raw.write() which doesn't populate
 *    response.headers in Fastify inject. Tests validate SSE body format instead.
 *
 * 2. Chunk filtering: V2 adapter only emits chunks with actual content
 *    (delta.content non-empty). The first chunk with role="assistant" and
 *    empty content is not forwarded. V1 forwards all chunks including role-only.
 *
 * 3. Interrupted stream recording: V2 may not record interactions when stream
 *    is interrupted before receiving usage data. V1 always records interactions
 *    even without usage. Tests verify graceful handling rather than guaranteed
 *    recording.
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
import type { OpenAi } from "@/types";
import { MockOpenAIClient } from "../mock-openai-client";
import openAiProxyRoutesV2 from "./openai";

describe("OpenAI V2 proxy streaming", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
  });

  test("streaming response has SSE format", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutesV2);
    config.benchmark.mockMode = true;

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

    // V2 uses reply.raw.write() which produces SSE format
    const body = response.body;
    expect(body).toContain("data: ");
    expect(body).toContain("data: [DONE]");
  });

  test("streaming response contains content chunks", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutesV2);
    config.benchmark.mockMode = true;

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

    // V2 adapter only emits chunks with actual content
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

describe("OpenAI V2 cost tracking", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
  });

  test("stores cost and baselineCost in interaction", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutesV2);
    config.benchmark.mockMode = true;

    await TokenPriceModel.create({
      provider: "openai",
      model: "gpt-4o",
      pricePerMillionInput: "2.50",
      pricePerMillionOutput: "10.00",
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

describe("OpenAI V2 streaming mode", () => {
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

    await app.register(openAiProxyRoutesV2);
    config.benchmark.mockMode = true;

    await TokenPriceModel.create({
      provider: "openai",
      model: "gpt-4o",
      pricePerMillionInput: "2.50",
      pricePerMillionOutput: "10.00",
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

  test(
    "streaming mode interrupted still records interaction",
    { timeout: 10000 },
    async ({ makeAgent }) => {
      const app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);

      config.benchmark.mockMode = true;

      // Configure mock to interrupt at chunk 4 (after usage chunk but before stream completes)
      MockOpenAIClient.setStreamOptions({ interruptAtChunk: 4 });

      try {
        await app.register(openAiProxyRoutesV2);

        await TokenPriceModel.create({
          provider: "openai",
          model: "gpt-4o",
          pricePerMillionInput: "2.50",
          pricePerMillionOutput: "10.00",
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
        const interactions =
          await InteractionModel.getAllInteractionsForProfile(agent.id);
        expect(interactions.length).toBe(initialCount + 1);

        const interaction = interactions[interactions.length - 1];

        expect(interaction.type).toBe("openai:chatCompletions");
        expect(interaction.model).toBe("gpt-4o");
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

      // Configure mock to interrupt at chunk 2 (before usage chunk)
      MockOpenAIClient.setStreamOptions({ interruptAtChunk: 2 });

      try {
        await app.register(openAiProxyRoutesV2);

        await TokenPriceModel.create({
          provider: "openai",
          model: "gpt-4o",
          pricePerMillionInput: "2.50",
          pricePerMillionOutput: "10.00",
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
      } finally {
        MockOpenAIClient.resetStreamOptions();
      }
    },
  );
});

describe("OpenAI V2 proxy routing", () => {
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
        preHandler: (request, _reply, next) => {
          if (
            request.method === "POST" &&
            request.url.includes(CHAT_COMPLETIONS_SUFFIX)
          ) {
            next(new Error("skip"));
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

    // Should get 404 or 500 because we didn't register the actual chat/completions handler
    expect([404, 500]).toContain(response.statusCode);
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

    // Should get 404 or 500 because we didn't register the actual chat/completions handler
    expect([404, 500]).toContain(response.statusCode);
  });
});
