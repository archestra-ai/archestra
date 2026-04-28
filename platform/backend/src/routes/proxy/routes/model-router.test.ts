import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { ModelModel } from "@/models";
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
import modelRouterProxyRoutes from "./model-router";

function createFastifyApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: {
          message: error.message,
          type: error.type,
        },
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.status(500).send({
      error: {
        message,
        type: "internal_server_error",
      },
    });
  });
  return app;
}

async function upsertModel(params: {
  provider: "anthropic" | "openai" | "groq";
  modelId: string;
}) {
  await ModelModel.upsert({
    externalId: `${params.provider}/${params.modelId}`,
    provider: params.provider,
    modelId: params.modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    customPricePerMillionInput: "2.50",
    customPricePerMillionOutput: "10.00",
    lastSyncedAt: new Date(),
  });
}

describe("model router proxy routes", () => {
  beforeEach(() => {
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient() as never,
    );
    vi.spyOn(groqAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient() as never,
    );
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("routes provider-qualified model ids to their provider", async ({
    makeAgent,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    const agent = await makeAgent({
      name: "Model Router Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-openai-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "openai:gpt-5.4",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(openaiAdapterFactory.createClient).toHaveBeenCalledOnce();
    expect(groqAdapterFactory.createClient).not.toHaveBeenCalled();
  });

  test("routes provider-qualified model ids after stripping provider prefix with colon separator", async ({
    makeAgent,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "groq", modelId: "llama-3.1-8b-instant" });
    const agent = await makeAgent({
      name: "Model Router Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-groq-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "groq:llama-3.1-8b-instant",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(groqAdapterFactory.createClient).toHaveBeenCalledOnce();
    expect(openaiAdapterFactory.createClient).not.toHaveBeenCalled();
  });

  test("rejects unqualified model ids", async ({ makeAgent }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "shared-chat-model" });
    await upsertModel({ provider: "groq", modelId: "shared-chat-model" });
    const agent = await makeAgent({
      name: "Model Router Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "shared-chat-model",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("provider-qualified");
  });

  test("translates Anthropic models to and from OpenAI chat completions", async ({
    makeAgent,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({
      provider: "anthropic",
      modelId: "claude-opus-4-6-20250918",
    });
    const agent = await makeAgent({
      name: "Model Router Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-anthropic-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "anthropic:claude-opus-4-6-20250918",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(anthropicAdapterFactory.createClient).toHaveBeenCalledOnce();
    expect(anthropicAdapterFactory.createClient).toHaveBeenCalledWith(
      "test-anthropic-key",
      expect.objectContaining({
        agent,
      }),
    );
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "claude-opus-4-6-20250918",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello! How can I help you today?",
          },
        },
      ],
    });
  });

  test("lists provider-qualified OpenAI-compatible model ids", async () => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    await upsertModel({ provider: "groq", modelId: "llama-3.1-8b-instant" });

    const response = await app.inject({
      method: "GET",
      url: "/v1/model-router/models",
      headers: {
        authorization: "Bearer test-key",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "openai:gpt-5.4",
          object: "model",
          owned_by: "openai",
        }),
        expect.objectContaining({
          id: "groq:llama-3.1-8b-instant",
          object: "model",
          owned_by: "groq",
        }),
      ]),
    });
  });

  test("lists only configured model router models for an LLM proxy", async ({
    makeAgent,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    await upsertModel({ provider: "groq", modelId: "llama-3.1-8b-instant" });
    const agent = await makeAgent({
      name: "Constrained Model Router Agent",
      agentType: "llm_proxy",
      modelRouterAllowedModelIds: ["groq:llama-3.1-8b-instant"],
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/model-router/${agent.id}/models`,
      headers: {
        authorization: "Bearer test-key",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        id: "groq:llama-3.1-8b-instant",
      }),
    ]);
  });

  test("rejects a model that is not enabled for the LLM proxy", async ({
    makeAgent,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    await upsertModel({ provider: "groq", modelId: "llama-3.1-8b-instant" });
    const agent = await makeAgent({
      name: "Constrained Model Router Agent",
      agentType: "llm_proxy",
      modelRouterAllowedModelIds: ["groq:llama-3.1-8b-instant"],
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-openai-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "openai:gpt-5.4",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("is not enabled");
  });
});
