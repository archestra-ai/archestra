/**
 * Anthropic Proxy V2 Tests
 *
 * Tests for the unified Anthropic proxy routes covering:
 * - Cost tracking in database
 * - Streaming mode and interaction recording
 * - Interrupted stream handling
 * - Tool call accumulation (no [object Object] bug)
 * - HTTP proxy routing (UUID stripping)
 *
 * KEY DIFFERENCES FROM V1 TESTS (../anthropic.test.ts):
 * TODO: Consider aligning V2 behavior with V1 for these cases:
 *
 * 1. Interrupted stream recording: V2 may not record interactions when stream
 *    is interrupted before receiving usage data. V1 always records interactions
 *    even without usage. Tests verify graceful handling rather than guaranteed
 *    recording.
 *
 * 2. Streaming headers: V2 uses reply.raw.write() directly. Headers are set
 *    via reply.header() but may not be captured by Fastify inject in the same
 *    way as V1.
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
import { MockAnthropicClient } from "../mock-anthropic-client";
import anthropicProxyRoutesV2 from "./anthropic";

describe("Anthropic V2 cost tracking", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
  });

  test("stores cost and baselineCost in interaction", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(anthropicProxyRoutesV2);
    config.benchmark.mockMode = true;

    await TokenPriceModel.create({
      provider: "anthropic",
      model: "claude-opus-4-20250514",
      pricePerMillionInput: "15.00",
      pricePerMillionOutput: "75.00",
    });

    const agent = await makeAgent({ name: "Test Cost Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 1024,
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

describe("Anthropic V2 streaming mode", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
    MockAnthropicClient.resetStreamOptions();
  });

  test("streaming mode completes normally and records interaction", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(anthropicProxyRoutesV2);
    config.benchmark.mockMode = true;

    await TokenPriceModel.create({
      provider: "anthropic",
      model: "claude-opus-4-20250514",
      pricePerMillionInput: "15.00",
      pricePerMillionOutput: "75.00",
    });

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const { InteractionModel } = await import("@/models");

    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);
    const initialCount = initialInteractions.length;

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 1024,
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.body;
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain("event: message_stop");

    await new Promise((resolve) => setTimeout(resolve, 100));

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);

    const interaction = interactions[interactions.length - 1];

    expect(interaction.type).toBe("anthropic:messages");
    expect(interaction.model).toBe("claude-opus-4-20250514");
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

      // Configure mock to interrupt at chunk 3 (after message_start, content_block_start, content_block_delta)
      MockAnthropicClient.setStreamOptions({ interruptAtChunk: 3 });

      try {
        await app.register(anthropicProxyRoutesV2);

        await TokenPriceModel.create({
          provider: "anthropic",
          model: "claude-opus-4-20250514",
          pricePerMillionInput: "15.00",
          pricePerMillionOutput: "75.00",
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
          url: `/v1/anthropic/${agent.id}/v1/messages`,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-key",
            "user-agent": "test-client",
            "anthropic-version": "2023-06-01",
            "x-api-key": "test-anthropic-key",
          },
          payload: {
            model: "claude-opus-4-20250514",
            messages: [{ role: "user", content: "Hello!" }],
            max_tokens: 1024,
            stream: true,
          },
        });

        expect(response.statusCode).toBe(200);

        await new Promise((resolve) => setTimeout(resolve, 200));

        const interactions =
          await InteractionModel.getAllInteractionsForProfile(agent.id);
        expect(interactions.length).toBe(initialCount + 1);

        const interaction = interactions[interactions.length - 1];

        expect(interaction.type).toBe("anthropic:messages");
        expect(interaction.model).toBe("claude-opus-4-20250514");
        expect(interaction.inputTokens).toBe(12);
        expect(interaction.outputTokens).toBe(10); // Usage from message_start event
        expect(interaction.cost).toBeTruthy();
        expect(interaction.baselineCost).toBeTruthy();
      } finally {
        MockAnthropicClient.resetStreamOptions();
      }
    },
  );
});

describe("Anthropic V2 tool call accumulation", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
    MockAnthropicClient.resetStreamOptions();
  });

  test("accumulates tool call input without [object Object] bug", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(anthropicProxyRoutesV2);
    config.benchmark.mockMode = true;

    MockAnthropicClient.setStreamOptions({ includeToolUse: true });

    try {
      await TokenPriceModel.create({
        provider: "anthropic",
        model: "claude-opus-4-20250514",
        pricePerMillionInput: "15.00",
        pricePerMillionOutput: "75.00",
      });

      const agent = await makeAgent({ name: "Test Tool Call Agent" });

      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${agent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "user-agent": "test-client",
          "anthropic-version": "2023-06-01",
          "x-api-key": "test-anthropic-key",
        },
        payload: {
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "What's the weather?" }],
          max_tokens: 1024,
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = response.body;

      // Verify stream contains tool_use events
      expect(body).toContain("event: content_block_start");
      expect(body).toContain('"type":"tool_use"');
      expect(body).toContain('"name":"get_weather"');

      // Verify tool input is properly accumulated without [object Object]
      expect(body).not.toContain("[object Object]");

      // Verify the tool input contains valid JSON parts
      expect(body).toContain("location");
      expect(body).toContain("San Francisco");
      expect(body).toContain("fahrenheit");
    } finally {
      MockAnthropicClient.resetStreamOptions();
    }
  });
});

describe("Anthropic V2 proxy routing", () => {
  let app: FastifyInstance;
  let mockUpstream: FastifyInstance;
  let upstreamPort: number;

  beforeEach(async () => {
    mockUpstream = Fastify();

    // Note: Our proxy rewrites /v1/anthropic/v1/models to /v1/v1/models
    mockUpstream.get("/v1/v1/models", async () => ({
      data: [
        { id: "claude-3-5-sonnet-20241022", type: "model" },
        { id: "claude-3-opus-20240229", type: "model" },
      ],
    }));

    mockUpstream.get("/v1/v1/models/:model", async (request) => ({
      id: (request.params as { model: string }).model,
      type: "model",
    }));

    await mockUpstream.listen({ port: 0 });
    const address = mockUpstream.server.address();
    upstreamPort = typeof address === "string" ? 0 : address?.port || 0;

    app = Fastify();

    await app.register(async (fastify) => {
      const fastifyHttpProxy = (await import("@fastify/http-proxy")).default;
      const API_PREFIX = "/v1/anthropic";
      const MESSAGES_SUFFIX = "/messages";

      await fastify.register(fastifyHttpProxy, {
        upstream: `http://localhost:${upstreamPort}`,
        prefix: API_PREFIX,
        rewritePrefix: "/v1",
        preHandler: (request, _reply, next) => {
          if (
            request.method === "POST" &&
            request.url.includes(MESSAGES_SUFFIX)
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
  });

  afterEach(async () => {
    await app.close();
    await mockUpstream.close();
  });

  test("proxies /v1/anthropic/v1/models without UUID", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/anthropic/v1/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/anthropic/:uuid/v1/models", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/anthropic/44f56e01-7167-42c1-88ee-64b566fbc34d/v1/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/anthropic/:uuid/v1/models/:model", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/anthropic/44f56e01-7167-42c1-88ee-64b566fbc34d/v1/models/claude-3-5-sonnet-20241022",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe("claude-3-5-sonnet-20241022");
    expect(body.type).toBe("model");
  });

  test("does not strip non-UUID segments", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/anthropic/not-a-uuid/v1/models",
    });

    expect(response.statusCode).toBe(404);
  });

  test("skips proxy for messages routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/anthropic/v1/messages",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 1024,
      },
    });

    expect([404, 500]).toContain(response.statusCode);
  });

  test("skips proxy for messages routes with UUID", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/anthropic/44f56e01-7167-42c1-88ee-64b566fbc34d/v1/messages",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 1024,
      },
    });

    expect([404, 500]).toContain(response.statusCode);
  });
});
