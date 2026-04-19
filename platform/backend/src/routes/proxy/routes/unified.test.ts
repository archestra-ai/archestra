/**
 * Tests for the /v1/unified/* proxy routes.
 */

import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";

vi.mock("prom-client", () => ({
  default: {
    Counter: class {
      inc() {}
    },
    Histogram: class {
      observe() {}
    },
    register: {
      removeSingleMetric: vi.fn(),
    },
  },
}));

import { InteractionModel, ModelModel, ToolModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createAnthropicTestClient,
  createOpenAiTestClient,
} from "@/test/llm-provider-stubs";
import { ApiError } from "@/types";
import {
  anthropicAdapterFactory,
  groqAdapterFactory,
  openaiAdapterFactory,
} from "../adapters";
import * as proxyUtils from "../utils";
import unifiedProxyRoutes from "./unified";

const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file from the filesystem",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file" },
      },
      required: ["file_path"],
    },
  },
} as const;

function buildApp(): FastifyInstance {
  return Fastify()
    .withTypeProvider<ZodTypeProvider>()
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler)
    .setErrorHandler<ApiError | Error>((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply
          .status(error.statusCode)
          .send({ error: { message: error.message, type: error.type } });
      }
      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
      const type =
        statusCode === 400
          ? "api_validation_error"
          : "api_internal_server_error";
      return reply
        .status(statusCode)
        .send({ error: { message: error.message, type } });
    });
}

describe("Unified LLM Proxy Route", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.restoreAllMocks();
    app = buildApp();
    await app.register(unifiedProxyRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("GET /v1/unified/models returns all registry models in OpenAI format", async () => {
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
    await ModelModel.upsert({
      externalId: "anthropic/claude-3-5-sonnet-20241022",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "3.00",
      customPricePerMillionOutput: "15.00",
      lastSyncedAt: new Date(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/unified/models",
      headers: {
        authorization: "Bearer test-key",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("claude-3-5-sonnet-20241022");
    const gpt = body.data.find((m: { id: string }) => m.id === "gpt-4o");
    expect(gpt).toMatchObject({
      id: "gpt-4o",
      object: "model",
      owned_by: "openai",
    });
    expect(typeof gpt.created).toBe("number");
  });

  test("returns 404 when model is not in registry", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "Unified 404 agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/unified/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      payload: {
        model: "nonexistent-model-xyz",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.message).toContain("nonexistent-model-xyz");
    expect(body.error.message).toContain("not found in the model registry");
  });

  test("returns 400 for malformed agentId UUID", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/unified/not-a-valid-uuid/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("routes Anthropic model via translation adapter, response in OpenAI format", async ({
    makeAgent,
  }) => {
    await ModelModel.upsert({
      externalId: "anthropic/claude-3-5-sonnet-20241022",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "3.00",
      customPricePerMillionOutput: "15.00",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({ name: "Unified Anthropic agent" });

    const anthropicClient = createAnthropicTestClient();
    vi.spyOn(anthropicAdapterFactory, "createClient").mockReturnValue(
      anthropicClient as never,
    );
    const executeSpy = vi.spyOn(anthropicAdapterFactory, "execute");

    const response = await app.inject({
      method: "POST",
      url: `/v1/unified/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "Hi Claude" }],
        stream: false,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("object", "chat.completion");
    expect(body).toHaveProperty("choices");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body).toHaveProperty("usage");
    expect(body.usage.prompt_tokens).toBe(12);
    expect(body.usage.completion_tokens).toBe(10);

    expect(executeSpy).toHaveBeenCalledOnce();
    const [, nativeReq] = executeSpy.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(nativeReq).toHaveProperty("max_tokens");
    expect(nativeReq).toHaveProperty("messages");
    expect(Array.isArray(nativeReq.messages)).toBe(true);
  });

  test("routes to openai and records interaction with executionId", async ({
    makeAgent,
  }) => {
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

    const agent = await makeAgent({ name: "Unified openai agent" });
    const executionId = randomUUID();

    vi.spyOn(openaiAdapterFactory, "createClient").mockReturnValue(
      createOpenAiTestClient() as never,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/unified/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
        "x-archestra-execution-id": executionId,
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello from unified!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBeGreaterThan(0);
    expect(interactions.some((i) => i.executionId === executionId)).toBe(true);
  });

  test("routes to groq based on model registry and records interaction", async ({
    makeAgent,
  }) => {
    await ModelModel.upsert({
      externalId: "groq/llama-3.3-70b-versatile",
      provider: "groq",
      modelId: "llama-3.3-70b-versatile",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "0.59",
      customPricePerMillionOutput: "0.79",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({ name: "Unified groq agent" });

    vi.spyOn(groqAdapterFactory, "createClient").mockReturnValue(
      createOpenAiTestClient() as never,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/unified/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "Hello from groq!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(groqAdapterFactory.createClient).toHaveBeenCalled();

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBeGreaterThan(0);
  });

  test("persists declared tools from unified proxy request", async ({
    makeAgent,
  }) => {
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
      agentType: "llm_proxy",
      name: "Unified tools agent",
    });

    vi.spyOn(openaiAdapterFactory, "createClient").mockReturnValue(
      createOpenAiTestClient() as never,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/unified/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Read a file" }],
        tools: [READ_FILE_TOOL],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);

    const storedTool = await ToolModel.findByName(READ_FILE_TOOL.function.name);
    expect(storedTool).not.toBeNull();
  });

  test("streams tool calls through unified proxy with SSE format", async ({
    makeAgent,
  }) => {
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

    const agent = await makeAgent({ name: "Unified streaming agent" });

    vi.spyOn(openaiAdapterFactory, "createClient").mockReturnValue(
      createOpenAiTestClient() as never,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/unified/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Stream a tool call" }],
        tools: [READ_FILE_TOOL],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("data:");
    expect(response.body).toContain("data: [DONE]");
  });

  test("applies optimized model before provider execution", async ({
    makeAgent,
  }) => {
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

    const agent = await makeAgent({ name: "Unified optimization agent" });

    vi.spyOn(openaiAdapterFactory, "createClient").mockReturnValue(
      createOpenAiTestClient() as never,
    );

    vi.spyOn(
      proxyUtils.costOptimization,
      "getOptimizedModel",
    ).mockResolvedValue("gpt-4o-mini");

    const response = await app.inject({
      method: "POST",
      url: `/v1/unified/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "x".repeat(1100) }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(proxyUtils.costOptimization.getOptimizedModel).toHaveBeenCalled();
  });
});
