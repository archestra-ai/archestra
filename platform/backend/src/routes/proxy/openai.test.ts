import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import { AgentModel, TokenPriceModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { OpenAi } from "@/types";
import openAiProxyRoutes from "./openai";

describe("OpenAI proxy streaming", () => {
  let response: Awaited<ReturnType<FastifyInstance["inject"]>>;
  let chunks: OpenAi.Types.ChatCompletionChunk[] = [];
  beforeEach(async () => {
    // Create a test Fastify app
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutes);
    config.benchmark.mockMode = true;

    // Make a streaming request to the route
    response = await app.inject({
      method: "POST",
      url: "/v1/openai/chat/completions",
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

    chunks = response.body
      .split("\n")
      .filter(
        (line: string) => line.startsWith("data: ") && line !== "data: [DONE]",
      )
      .map((line: string) => JSON.parse(line.substring(6))); // Remove 'data: ' prefix
  });
  test("response has stream content type", async () => {
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
  });
  test("first chunk has role", () => {
    const firstChunk = chunks[0];
    expect(firstChunk.choices[0].delta).toHaveProperty("role", "assistant");
  });
  test("last chunk has finish reason", () => {
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.choices[0]).toHaveProperty("finish_reason");
  });
});

describe("OpenAI cost tracking", () => {
  test("stores cost and baselineCost in interaction", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutes);
    config.benchmark.mockMode = true;

    // Create token pricing for the model
    await TokenPriceModel.create({
      provider: "openai",
      model: "gpt-4o",
      pricePerMillionInput: "2.50",
      pricePerMillionOutput: "10.00",
    });

    // Create a test agent with cost optimization enabled
    const agent = await AgentModel.create({
      name: "Test Cost Agent",
      teams: [],
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
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);

    // Find the created interaction
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

describe("OpenAI streaming mode", () => {
  test("streaming mode completes normally and records interaction", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(openAiProxyRoutes);
    config.benchmark.mockMode = true;

    // Create token pricing for the model
    await TokenPriceModel.create({
      provider: "openai",
      model: "gpt-4o",
      pricePerMillionInput: "2.50",
      pricePerMillionOutput: "10.00",
    });

    // Create a test agent
    const agent = await AgentModel.create({
      name: "Test Streaming Agent",
      teams: [],
    });

    const { InteractionModel } = await import("@/models");

    // Get initial interaction count
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

    // Verify the response contains SSE events
    const body = response.body;
    expect(body).toContain("data: ");
    expect(body).toContain('"finish_reason":"stop"');

    // Wait a bit for async interaction recording
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Find the created interaction
    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);

    const interaction = interactions[interactions.length - 1];

    // Verify interaction was recorded with proper fields
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
    async () => {
      const app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);

      // Enable mock mode
      config.benchmark.mockMode = true;

      // Configure mock to interrupt at chunk 4 (after usage chunk but before stream completes)
      // Chunks: 0=role, 1=content1, 2=content2, 3=finish+usage, 4=[DONE] would come next
      const { MockOpenAIClient } = await import("./mock-openai-client");
      MockOpenAIClient.setStreamOptions({ interruptAtChunk: 4 });

      try {
        await app.register(openAiProxyRoutes);

        // Create token pricing for the model
        await TokenPriceModel.create({
          provider: "openai",
          model: "gpt-4o",
          pricePerMillionInput: "2.50",
          pricePerMillionOutput: "10.00",
        });

        // Create a test agent
        const agent = await AgentModel.create({
          name: "Test Interrupted Streaming Agent",
          teams: [],
        });

        const { InteractionModel } = await import("@/models");

        // Get initial interaction count
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

        // Wait for async interaction recording (longer timeout for error handling)
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify interaction was still recorded despite interruption
        const interactions =
          await InteractionModel.getAllInteractionsForProfile(agent.id);
        expect(interactions.length).toBe(initialCount + 1);

        const interaction = interactions[interactions.length - 1];

        // Verify interaction was recorded even though stream was interrupted
        expect(interaction.type).toBe("openai:chatCompletions");
        expect(interaction.model).toBe("gpt-4o");
        expect(interaction.inputTokens).toBe(12);
        expect(interaction.outputTokens).toBe(10);
        expect(interaction.cost).toBeTruthy();
        expect(interaction.baselineCost).toBeTruthy();
      } finally {
        // Reset mock options for other tests
        MockOpenAIClient.resetStreamOptions();
      }
    },
  );

  test(
    "streaming mode interrupted before usage still records interaction",
    { timeout: 10000 },
    async () => {
      const app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);

      // Enable mock mode
      config.benchmark.mockMode = true;

      // Configure mock to interrupt at chunk 2 (before usage chunk)
      // Chunks: 0=role, 1=content1, 2=content2 (interrupt here), 3=finish+usage (never received)
      const { MockOpenAIClient } = await import("./mock-openai-client");
      MockOpenAIClient.setStreamOptions({ interruptAtChunk: 2 });

      try {
        await app.register(openAiProxyRoutes);

        // Create token pricing for the model
        await TokenPriceModel.create({
          provider: "openai",
          model: "gpt-4o",
          pricePerMillionInput: "2.50",
          pricePerMillionOutput: "10.00",
        });

        // Create a test agent
        const agent = await AgentModel.create({
          name: "Test Interrupted Before Usage Agent",
          teams: [],
        });

        const { InteractionModel } = await import("@/models");

        // Get initial interaction count
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

        // Wait for async interaction recording
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify interaction was recorded even without usage data
        const interactions =
          await InteractionModel.getAllInteractionsForProfile(agent.id);
        expect(interactions.length).toBe(initialCount + 1);

        const interaction = interactions[interactions.length - 1];

        // Verify interaction was recorded without usage/cost data
        expect(interaction.type).toBe("openai:chatCompletions");
        expect(interaction.model).toBe("gpt-4o");
        expect(interaction.inputTokens).toBeNull();
        expect(interaction.outputTokens).toBeNull();
        expect(interaction.cost).toBeNull();
        expect(interaction.baselineCost).toBeNull();
      } finally {
        // Reset mock options for other tests
        MockOpenAIClient.resetStreamOptions();
      }
    },
  );
});

describe("OpenAI proxy routing", () => {
  let app: FastifyInstance;
  let mockUpstream: FastifyInstance;
  let upstreamPort: number;

  beforeEach(async () => {
    // Create a mock upstream server
    mockUpstream = Fastify();

    // Mock OpenAI models endpoint
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

    // Mock other endpoints
    mockUpstream.get("/v1/models/:model", async (request) => ({
      id: (request.params as { model: string }).model,
      object: "model",
      created: 1687882411,
      owned_by: "openai",
    }));

    await mockUpstream.listen({ port: 0 });
    const address = mockUpstream.server.address();
    upstreamPort = typeof address === "string" ? 0 : address?.port || 0;

    // Create test app with proxy pointing to mock upstream
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Override the upstream URL to point to our mock server
    const originalBaseUrl = config.llm.openai.baseUrl;
    config.llm.openai.baseUrl = `http://localhost:${upstreamPort}`;

    // Register routes with a modified version that uses the mock upstream
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

    // Restore original config after registration
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
    // This confirms the proxy was skipped (next(new Error("skip")) throws error)
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
    // This confirms the proxy was skipped (next(new Error("skip")) throws error)
    expect([404, 500]).toContain(response.statusCode);
  });
});
