/**
 * Gemini Proxy Tests
 *
 * Tests for the unified Gemini proxy routes covering:
 * - Streaming response format validation
 * - Cost tracking in database
 * - Streaming mode and interaction recording
 * - Interrupted stream handling
 * - HTTP proxy routing
 *
 * Current behavior notes:
 * - Streaming headers are written alongside SSE chunks sent through
 *   reply.raw.write(), so inject-based assertions focus on the body format.
 * - Interrupted streams may not record interactions before usage data arrives.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { ModelModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createGeminiTestClient } from "@/test/llm-provider-stubs";
import { geminiAdapterFactory } from "../adapters/gemini";
import geminiProxyRoutes from "./gemini";

describe("Gemini streaming format", () => {
  beforeEach(() => {
    vi.spyOn(geminiAdapterFactory, "createClient").mockImplementation(
      () => createGeminiTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("streaming response has correct SSE format", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(geminiProxyRoutes);

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

    // The route uses reply.raw.write() which produces SSE format
    const body = response.body;
    expect(body).toContain("data: ");
    expect(body).toContain("data: [DONE]");
  });
});

describe("Gemini dispatch rewrite signatures", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createGeminiProxyTestApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("keeps a rewritten tool-call signature usable on the next turn", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Gemini Dispatch Follow-up Agent" });
    const providerRequests: GeminiSdkRequest[] = [];

    stubGeminiStreamClient((request) => {
      providerRequests.push(request);
      return providerRequests.length === 1
        ? [
            geminiToolCallChunk([
              {
                id: "call_read",
                name: "inventory__read",
                args: { itemId: "item-1" },
                thoughtSignature: "opaque-thought-signature",
              },
            ]),
          ]
        : [geminiTextChunk("Done")];
    });

    await app.register(geminiProxyRoutes);

    const firstResponse = await app.inject({
      method: "POST",
      url: `/v1/gemini/${agent.id}/v1beta/models/gemini-3.7-flash:streamGenerateContent`,
      headers: geminiTestHeaders(),
      payload: geminiDispatchRequest("Read item 1"),
    });

    expect(firstResponse.statusCode, firstResponse.body).toBe(200);
    const rewrittenPart = findStreamedFunctionCallPart(firstResponse.body);
    expect(rewrittenPart).toMatchObject({
      functionCall: {
        id: "call_read",
        name: "archestra__run_tool",
        args: {
          tool_name: "inventory__read",
          tool_args: { itemId: "item-1" },
        },
      },
      thoughtSignature: "opaque-thought-signature",
    });

    const secondResponse = await app.inject({
      method: "POST",
      url: `/v1/gemini/${agent.id}/v1beta/models/gemini-3.7-flash:streamGenerateContent`,
      headers: geminiTestHeaders(),
      payload: {
        ...geminiDispatchRequest("Read item 1"),
        contents: [
          { role: "user", parts: [{ text: "Read item 1" }] },
          { role: "model", parts: [rewrittenPart] },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call_read",
                  name: "archestra__run_tool",
                  response: { result: "available" },
                },
              },
            ],
          },
        ],
      },
    });

    expect(secondResponse.statusCode, secondResponse.body).toBe(200);
    expect(secondResponse.body).toContain("Done");
    expect(providerRequests[1]?.contents[1]?.parts[0]?.thoughtSignature).toBe(
      "opaque-thought-signature",
    );
  });

  test("keeps parallel rewritten signatures paired by position", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Gemini Parallel Dispatch Agent" });

    stubGeminiStreamClient(() => [
      geminiToolCallChunk([
        {
          id: "call_read",
          name: "inventory__read",
          args: { itemId: "item-1" },
          thoughtSignature: "signature-read",
        },
        {
          id: "call_write",
          name: "inventory__write",
          args: { itemId: "item-2" },
          thoughtSignature: "signature-write",
        },
      ]),
    ]);

    await app.register(geminiProxyRoutes);

    const response = await app.inject({
      method: "POST",
      url: `/v1/gemini/${agent.id}/v1beta/models/gemini-3.7-flash:streamGenerateContent`,
      headers: geminiTestHeaders(),
      payload: geminiDispatchRequest("Read one item and update another"),
    });

    expect(response.statusCode, response.body).toBe(200);
    const functionCallParts = streamedFunctionCallParts(response.body);
    expect(
      functionCallParts.map((part) => ({
        target: part.functionCall.args.tool_name,
        thoughtSignature: part.thoughtSignature,
      })),
    ).toEqual([
      {
        target: "inventory__read",
        thoughtSignature: "signature-read",
      },
      {
        target: "inventory__write",
        thoughtSignature: "signature-write",
      },
    ]);
  });
});

describe("Gemini cost tracking", () => {
  beforeEach(() => {
    vi.spyOn(geminiAdapterFactory, "createClient").mockImplementation(
      () => createGeminiTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("stores cost and baselineCost in interaction", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(geminiProxyRoutes);

    await ModelModel.upsert({
      externalId: "gemini/gemini-2.5-pro",
      provider: "gemini",
      modelId: "gemini-2.5-pro",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "1.25",
      customPricePerMillionOutput: "5.00",
      lastSyncedAt: new Date(),
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

describe("Gemini streaming mode", () => {
  let geminiStubOptions: { interruptAtChunk?: number };

  beforeEach(() => {
    geminiStubOptions = {};
    vi.spyOn(geminiAdapterFactory, "createClient").mockImplementation(
      () => createGeminiTestClient(geminiStubOptions) as never,
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

    await app.register(geminiProxyRoutes);

    await ModelModel.upsert({
      externalId: "gemini/gemini-2.5-pro",
      provider: "gemini",
      modelId: "gemini-2.5-pro",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "1.25",
      customPricePerMillionOutput: "5.00",
      lastSyncedAt: new Date(),
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

  test("streaming mode interrupted handles gracefully", {
    timeout: 10000,
  }, async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Configure stub to interrupt at chunk 2 (before final usage chunk).
    geminiStubOptions.interruptAtChunk = 2;

    await app.register(geminiProxyRoutes);

    await ModelModel.upsert({
      externalId: "gemini/gemini-2.5-pro",
      provider: "gemini",
      modelId: "gemini-2.5-pro",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "1.25",
      customPricePerMillionOutput: "5.00",
      lastSyncedAt: new Date(),
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
  });

  test("streaming mode interrupted before usage handles gracefully", {
    timeout: 10000,
  }, async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Configure stub to interrupt at chunk 1 (before any usage data).
    geminiStubOptions.interruptAtChunk = 1;

    await app.register(geminiProxyRoutes);

    await ModelModel.upsert({
      externalId: "gemini/gemini-2.5-pro",
      provider: "gemini",
      modelId: "gemini-2.5-pro",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "1.25",
      customPricePerMillionOutput: "5.00",
      lastSyncedAt: new Date(),
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
  });
});

describe("Gemini proxy routing", () => {
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
        preHandler: (request, reply, next) => {
          if (
            request.method === "POST" &&
            (request.url.includes(":generateContent") ||
              request.url.includes(":streamGenerateContent"))
          ) {
            reply.code(400).send({
              error: {
                code: 400,
                message:
                  "generateContent requests should use the dedicated endpoint",
                status: "INVALID_ARGUMENT",
              },
            });
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

    // Should get 400 because the preHandler blocks proxy forwarding with a clean error response
    expect(response.statusCode).toBe(400);
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

    // Should get 400 because the preHandler blocks proxy forwarding with a clean error response
    expect(response.statusCode).toBe(400);
  });
});

describe("Gemini non-streaming mode", () => {
  beforeEach(() => {
    vi.spyOn(geminiAdapterFactory, "createClient").mockImplementation(
      () => createGeminiTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("non-streaming mode completes and records interaction", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(geminiProxyRoutes);

    await ModelModel.upsert({
      externalId: "gemini/gemini-2.5-pro",
      provider: "gemini",
      modelId: "gemini-2.5-pro",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "1.25",
      customPricePerMillionOutput: "5.00",
      lastSyncedAt: new Date(),
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

type StreamedFunctionCallPart = {
  functionCall: {
    id: string;
    name: string;
    args: Record<string, unknown> & { tool_name: string };
  };
  thoughtSignature?: string;
};

type GeminiSdkRequest = {
  contents: Array<{
    role: string;
    parts: Array<{ thoughtSignature?: string }>;
  }>;
};

function createGeminiProxyTestApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

function geminiTestHeaders() {
  return {
    "content-type": "application/json",
    "x-goog-api-key": "test-key",
  };
}

function geminiDispatchRequest(prompt: string) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [
      {
        functionDeclarations: [
          {
            name: "archestra__search_tools",
            description: "Find tools by capability",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
          {
            name: "archestra__run_tool",
            description: "Run a tool by exact name",
            parameters: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                tool_args: { type: "object" },
              },
              required: ["tool_name"],
            },
          },
        ],
      },
    ],
  };
}

function geminiStream(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function stubGeminiStreamClient(
  getChunks: (request: GeminiSdkRequest) => unknown[],
) {
  vi.spyOn(geminiAdapterFactory, "createClient").mockImplementation(
    () =>
      ({
        models: {
          generateContentStream: async (request: GeminiSdkRequest) =>
            geminiStream(getChunks(request)),
        },
      }) as never,
  );
}

function geminiToolCallChunk(
  calls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    thoughtSignature: string;
  }>,
) {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: calls.map(({ thoughtSignature, ...functionCall }) => ({
            functionCall,
            thoughtSignature,
          })),
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 12,
      candidatesTokenCount: 10,
      totalTokenCount: 22,
    },
    modelVersion: "gemini-3.7-flash",
    responseId: "gemini-dispatch-test",
  };
}

function geminiTextChunk(text: string) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 24,
      candidatesTokenCount: 2,
      totalTokenCount: 26,
    },
    modelVersion: "gemini-3.7-flash",
    responseId: "gemini-follow-up-test",
  };
}

function streamedFunctionCallParts(body: string): StreamedFunctionCallPart[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => JSON.parse(payload))
    .flatMap((event) => event.candidates?.[0]?.content?.parts ?? [])
    .filter(
      (part): part is StreamedFunctionCallPart =>
        part.functionCall !== undefined,
    );
}

function findStreamedFunctionCallPart(body: string): StreamedFunctionCallPart {
  const [part] = streamedFunctionCallParts(body);
  if (!part) {
    throw new Error("Expected a streamed Gemini function call");
  }
  return part;
}
