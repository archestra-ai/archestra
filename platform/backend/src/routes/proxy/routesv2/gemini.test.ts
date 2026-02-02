/**
 * Gemini Proxy V2 Tests
 *
 * Tests for the unified Gemini proxy routes covering:
 * - Streaming response format validation
 * - Cost tracking in database
 * - Streaming mode and interaction recording
 * - Interrupted stream handling
 * - HTTP proxy routing
 *
 * KEY DIFFERENCES FROM V1 (Gemini had no V1 tests - these are new):
 * TODO: Consider these behavioral notes when comparing with OpenAI/Anthropic V1:
 *
 * 1. Streaming headers: V2 uses reply.raw.write() which doesn't populate
 *    response.headers in Fastify inject. Tests validate SSE body format instead.
 *
 * 2. Interrupted stream recording: V2 may not record interactions when stream
 *    is interrupted before receiving usage data. Tests verify graceful handling
 *    rather than guaranteed recording.
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
import { MockGeminiClient } from "../mock-gemini-client";
import geminiProxyRoutesV2 from "./gemini";

describe("Gemini V2 streaming format", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
  });

  test("streaming response has correct SSE format", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(geminiProxyRoutesV2);
    config.benchmark.mockMode = true;

    const agent = await makeAgent({ name: "Test Streaming Format Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/gemini/${agent.id}/v1beta/models/gemini-2.5-pro:streamGenerateContent`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": "test-key",
      },
      payload: {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello!" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    // V2 uses reply.raw.write() which produces SSE format
    const body = response.body;
    expect(body).toContain("data: ");
    expect(body).toContain("data: [DONE]");
  });
});

describe("Gemini V2 cost tracking", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
  });

  test("stores cost and baselineCost in interaction", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(geminiProxyRoutesV2);
    config.benchmark.mockMode = true;

    await TokenPriceModel.create({
      provider: "gemini",
      model: "gemini-2.5-pro",
      pricePerMillionInput: "1.25",
      pricePerMillionOutput: "5.00",
    });

    const agent = await makeAgent({ name: "Test Cost Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/gemini/${agent.id}/v1beta/models/gemini-2.5-pro:generateContent`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": "test-key",
      },
      payload: {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello!" }],
          },
        ],
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

describe("Gemini V2 streaming mode", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
    MockGeminiClient.resetStreamOptions();
  });

  test("streaming mode completes normally and records interaction", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(geminiProxyRoutesV2);
    config.benchmark.mockMode = true;

    await TokenPriceModel.create({
      provider: "gemini",
      model: "gemini-2.5-pro",
      pricePerMillionInput: "1.25",
      pricePerMillionOutput: "5.00",
    });

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const { InteractionModel } = await import("@/models");

    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);
    const initialCount = initialInteractions.length;

    const response = await app.inject({
      method: "POST",
      url: `/v1/gemini/${agent.id}/v1beta/models/gemini-2.5-pro:streamGenerateContent`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": "test-key",
      },
      payload: {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello!" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.body;
    expect(body).toContain("data: ");
    expect(body).toContain("data: [DONE]");

    await new Promise((resolve) => setTimeout(resolve, 100));

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);

    const interaction = interactions[interactions.length - 1];

    expect(interaction.type).toBe("gemini:generateContent");
    expect(interaction.model).toBe("gemini-2.5-pro");
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10);
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
    expect(typeof interaction.cost).toBe("string");
    expect(typeof interaction.baselineCost).toBe("string");
  });

  test(
    "streaming mode interrupted handles gracefully",
    { timeout: 10000 },
    async ({ makeAgent }) => {
      const app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);

      config.benchmark.mockMode = true;

      // Configure mock to interrupt at chunk 2 (before final usage chunk)
      MockGeminiClient.setStreamOptions({ interruptAtChunk: 2 });

      try {
        await app.register(geminiProxyRoutesV2);

        await TokenPriceModel.create({
          provider: "gemini",
          model: "gemini-2.5-pro",
          pricePerMillionInput: "1.25",
          pricePerMillionOutput: "5.00",
        });

        const agent = await makeAgent({
          name: "Test Interrupted Streaming Agent",
        });

        const response = await app.inject({
          method: "POST",
          url: `/v1/gemini/${agent.id}/v1beta/models/gemini-2.5-pro:streamGenerateContent`,
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": "test-key",
          },
          payload: {
            contents: [
              {
                role: "user",
                parts: [{ text: "Hello!" }],
              },
            ],
          },
        });

        // Request should complete without error even when stream is interrupted
        expect(response.statusCode).toBe(200);

        // Response should have partial SSE data
        expect(response.body).toContain("data: ");
      } finally {
        MockGeminiClient.resetStreamOptions();
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

      // Configure mock to interrupt at chunk 1 (before any usage data)
      MockGeminiClient.setStreamOptions({ interruptAtChunk: 1 });

      try {
        await app.register(geminiProxyRoutesV2);

        await TokenPriceModel.create({
          provider: "gemini",
          model: "gemini-2.5-pro",
          pricePerMillionInput: "1.25",
          pricePerMillionOutput: "5.00",
        });

        const agent = await makeAgent({
          name: "Test Interrupted Before Usage Agent",
        });

        const response = await app.inject({
          method: "POST",
          url: `/v1/gemini/${agent.id}/v1beta/models/gemini-2.5-pro:streamGenerateContent`,
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": "test-key",
          },
          payload: {
            contents: [
              {
                role: "user",
                parts: [{ text: "Hello!" }],
              },
            ],
          },
        });

        // Request should complete without error even when stream is interrupted
        expect(response.statusCode).toBe(200);

        // Response should have partial SSE data
        expect(response.body).toContain("data: ");
      } finally {
        MockGeminiClient.resetStreamOptions();
      }
    },
  );
});

describe("Gemini V2 proxy routing", () => {
  let app: FastifyInstance;
  let mockUpstream: FastifyInstance;
  let upstreamPort: number;

  beforeEach(async () => {
    mockUpstream = Fastify();

    mockUpstream.get("/v1/models", async () => ({
      models: [
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
        { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
      ],
    }));

    mockUpstream.get("/v1/models/:model", async (request) => ({
      name: `models/${(request.params as { model: string }).model}`,
      displayName: "Gemini Model",
    }));

    await mockUpstream.listen({ port: 0 });
    const address = mockUpstream.server.address();
    upstreamPort = typeof address === "string" ? 0 : address?.port || 0;

    app = Fastify();

    await app.register(async (fastify) => {
      const fastifyHttpProxy = (await import("@fastify/http-proxy")).default;
      const API_PREFIX = "/v1/gemini";

      await fastify.register(fastifyHttpProxy, {
        upstream: `http://localhost:${upstreamPort}`,
        prefix: `${API_PREFIX}/v1beta`,
        rewritePrefix: "/v1",
        preHandler: (request, _reply, next) => {
          if (
            request.method === "POST" &&
            (request.url.includes(":generateContent") ||
              request.url.includes(":streamGenerateContent"))
          ) {
            next(new Error("skip"));
            return;
          }
          next();
        },
      });
    });
  });

  afterEach(async () => {
    await app.close();
    await mockUpstream.close();
  });

  test("proxies /v1/gemini/v1beta/models", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/gemini/v1beta/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.models).toHaveLength(2);
  });

  test("proxies /v1/gemini/v1beta/models/:model", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/gemini/v1beta/models/gemini-2.5-pro",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.name).toBe("models/gemini-2.5-pro");
  });

  test("skips proxy for generateContent routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/gemini/v1beta/models/gemini-2.5-pro:generateContent",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello!" }],
          },
        ],
      },
    });

    // Should get 404 or 500 because we didn't register the actual generateContent handler
    expect([404, 500]).toContain(response.statusCode);
  });

  test("skips proxy for streamGenerateContent routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello!" }],
          },
        ],
      },
    });

    // Should get 404 or 500 because we didn't register the actual streamGenerateContent handler
    expect([404, 500]).toContain(response.statusCode);
  });
});

describe("Gemini V2 non-streaming mode", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
  });

  test("non-streaming mode completes and records interaction", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(geminiProxyRoutesV2);
    config.benchmark.mockMode = true;

    await TokenPriceModel.create({
      provider: "gemini",
      model: "gemini-2.5-pro",
      pricePerMillionInput: "1.25",
      pricePerMillionOutput: "5.00",
    });

    const agent = await makeAgent({ name: "Test Non-Streaming Agent" });

    const { InteractionModel } = await import("@/models");

    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);
    const initialCount = initialInteractions.length;

    const response = await app.inject({
      method: "POST",
      url: `/v1/gemini/${agent.id}/v1beta/models/gemini-2.5-pro:generateContent`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": "test-key",
      },
      payload: {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello!" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);

    const interaction = interactions[interactions.length - 1];

    expect(interaction.type).toBe("gemini:generateContent");
    expect(interaction.model).toBe("gemini-2.5-pro");
    // Non-streaming mock returns different token counts
    expect(interaction.inputTokens).toBe(82);
    expect(interaction.outputTokens).toBe(17);
  });
});
