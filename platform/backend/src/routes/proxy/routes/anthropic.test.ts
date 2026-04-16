/**
 * Anthropic Proxy Tests
 *
 * Tests for the unified Anthropic proxy routes covering:
 * - Cost tracking in database
 * - Streaming mode and interaction recording
 * - Interrupted stream handling
 * - Tool call accumulation (no [object Object] bug)
 * - HTTP proxy routing (UUID stripping)
 *
 * Current behavior notes:
 * - Interrupted streams may not record interactions before usage data arrives.
 * - Streaming headers are set via reply.header(), while the body is written
 *   directly through reply.raw.write().
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { ModelModel, VirtualApiKeyModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createAnthropicTestClient } from "@/test/llm-provider-stubs";
import { anthropicAdapterFactory } from "../adapters";
import anthropicProxyRoutes from "./anthropic";

describe("Anthropic cost tracking", () => {
  beforeEach(() => {
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("stores cost and baselineCost in interaction", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(anthropicProxyRoutes);

    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-4-20250514",
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "15.00",
      customPricePerMillionOutput: "75.00",
      lastSyncedAt: new Date(),
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

describe("Anthropic streaming mode", () => {
  let anthropicStubOptions: {
    includeToolUse?: boolean;
    interruptAtChunk?: number;
  };

  beforeEach(() => {
    anthropicStubOptions = {};
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient(anthropicStubOptions) as never,
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

    await app.register(anthropicProxyRoutes);

    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-4-20250514",
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "15.00",
      customPricePerMillionOutput: "75.00",
      lastSyncedAt: new Date(),
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

  test("streaming mode interrupted still records interaction", {
    timeout: 10000,
  }, async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Configure stub to interrupt at chunk 3.
    anthropicStubOptions.interruptAtChunk = 3;

    await app.register(anthropicProxyRoutes);

    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-4-20250514",
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "15.00",
      customPricePerMillionOutput: "75.00",
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

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);

    const interaction = interactions[interactions.length - 1];

    expect(interaction.type).toBe("anthropic:messages");
    expect(interaction.model).toBe("claude-opus-4-20250514");
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10); // Usage from message_start event
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
  });
});

describe("Anthropic virtual key auth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("resolves virtual keys passed via authorization header", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    let capturedApiKey: string | undefined;
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      (apiKey) => {
        capturedApiKey = apiKey;
        return createAnthropicTestClient() as never;
      },
    );

    try {
      await app.register(anthropicProxyRoutes);

      const organization = await makeOrganization();
      const secret = await makeSecret({
        secret: { apiKey: "sk-anthropic-parent-key" },
      });
      const chatApiKey = await makeLlmProviderApiKey(
        organization.id,
        secret.id,
        {
          provider: "anthropic",
        },
      );
      const {
        virtualKey: { id: virtualKeyId },
        value,
      } = await VirtualApiKeyModel.create({
        chatApiKeyId: chatApiKey.id,
        name: "anthropic-auth-header-vk",
      });

      const agent = await makeAgent({
        organizationId: organization.id,
        name: "Anthropic Virtual Key Agent",
      });

      const before = await VirtualApiKeyModel.findById(virtualKeyId);
      expect(before?.lastUsedAt).toBeNull();

      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${agent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${value}`,
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "Hello!" }],
          max_tokens: 128,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(capturedApiKey).toBe("sk-anthropic-parent-key");

      const after = await VirtualApiKeyModel.findById(virtualKeyId);
      expect(after?.lastUsedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe("Anthropic tool call accumulation", () => {
  let anthropicStubOptions: {
    includeToolUse?: boolean;
    interruptAtChunk?: number;
  };

  beforeEach(() => {
    anthropicStubOptions = {};
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient(anthropicStubOptions) as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("accumulates tool call input without [object Object] bug", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(anthropicProxyRoutes);

    anthropicStubOptions.includeToolUse = true;

    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-4-20250514",
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "15.00",
      customPricePerMillionOutput: "75.00",
      lastSyncedAt: new Date(),
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
  });

  test("accepts document content blocks in request payloads", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(anthropicProxyRoutes);

    const agent = await makeAgent({ name: "Test Document Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "pdfs-2024-09-25",
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: "claude-opus-4-20250514",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                title: "Spec",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "JVBERi0xLjQK",
                },
              },
              {
                type: "text",
                text: "Summarize this document.",
              },
            ],
          },
        ],
        max_tokens: 1024,
      },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("Anthropic proxy routing", () => {
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
        preHandler: (request, reply, next) => {
          const urlPath = request.url.split("?")[0];
          if (request.method === "POST" && urlPath.endsWith(MESSAGES_SUFFIX)) {
            reply.code(400).send({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "Messages requests should use the dedicated endpoint",
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

    // Should get 400 because the preHandler blocks proxy forwarding with a clean error response
    expect(response.statusCode).toBe(400);
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

    // Should get 400 because the preHandler blocks proxy forwarding with a clean error response
    expect(response.statusCode).toBe(400);
  });
});
