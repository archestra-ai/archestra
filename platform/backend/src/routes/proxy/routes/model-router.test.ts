import { SOURCE_HEADER, type SupportedProvider } from "@shared";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { InteractionModel, ModelModel, VirtualApiKeyModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  type AnthropicStubOptions,
  createAnthropicTestClient,
  createGeminiTestClient,
  createOpenAiTestClient,
} from "@/test/llm-provider-stubs";
import { ApiError } from "@/types";
import {
  anthropicAdapterFactory,
  azureAdapterFactory,
  bedrockAdapterFactory,
  cerebrasAdapterFactory,
  cohereAdapterFactory,
  deepseekAdapterFactory,
  geminiAdapterFactory,
  groqAdapterFactory,
  minimaxAdapterFactory,
  mistralAdapterFactory,
  ollamaAdapterFactory,
  openaiAdapterFactory,
  openrouterAdapterFactory,
  perplexityAdapterFactory,
  vllmAdapterFactory,
  xaiAdapterFactory,
  zhipuaiAdapterFactory,
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
  provider: SupportedProvider;
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

async function createModelRouterVirtualKey(params: {
  organizationId: string;
  provider: SupportedProvider;
  makeSecret: (params: { secret: Record<string, unknown> }) => Promise<{
    id: string;
  }>;
  makeLlmProviderApiKey: (
    organizationId: string,
    secretId: string,
    overrides?: { provider?: SupportedProvider },
  ) => Promise<{ id: string }>;
  apiKeyValue?: string;
  expiresAt?: Date | null;
}) {
  const secret = await params.makeSecret({
    secret: { apiKey: params.apiKeyValue ?? `test-${params.provider}-key` },
  });
  const chatApiKey = await params.makeLlmProviderApiKey(
    params.organizationId,
    secret.id,
    {
      provider: params.provider,
    },
  );
  return VirtualApiKeyModel.create({
    chatApiKeyId: chatApiKey.id,
    name: `${params.provider} model router virtual key`,
    expiresAt: params.expiresAt,
    modelRouterProviderApiKeys: [
      {
        provider: params.provider,
        chatApiKeyId: chatApiKey.id,
      },
    ],
  });
}

const ROUTABLE_PROVIDER_CASES: Array<{
  provider: SupportedProvider;
  modelId: string;
}> = [
  { provider: "anthropic", modelId: "claude-opus-4-6-20250918" },
  { provider: "azure", modelId: "gpt-4.1" },
  { provider: "bedrock", modelId: "amazon.nova-pro-v1:0" },
  { provider: "cerebras", modelId: "llama-4-scout-17b-16e-instruct" },
  { provider: "cohere", modelId: "command-a-03-2025" },
  { provider: "deepseek", modelId: "deepseek-chat" },
  { provider: "gemini", modelId: "gemini-2.5-pro" },
  { provider: "groq", modelId: "llama-3.1-8b-instant" },
  { provider: "minimax", modelId: "MiniMax-M1" },
  { provider: "mistral", modelId: "mistral-large-latest" },
  { provider: "ollama", modelId: "llama3.1" },
  { provider: "openai", modelId: "gpt-5.4" },
  { provider: "openrouter", modelId: "openai/gpt-4o-mini" },
  { provider: "perplexity", modelId: "sonar-pro" },
  { provider: "vllm", modelId: "meta-llama/Llama-3.1-8B-Instruct" },
  { provider: "xai", modelId: "grok-4" },
  { provider: "zhipuai", modelId: "glm-4.5" },
];

function createCohereTestClient() {
  return {
    chat: {
      create: async () => ({
        id: "cohere-test",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from Cohere" }],
        },
        finish_reason: "COMPLETE",
        usage: {
          tokens: {
            input_tokens: 12,
            output_tokens: 10,
          },
        },
      }),
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: "message-start",
            message: { id: "cohere-test" },
          };
          yield {
            type: "content-delta",
            delta: { message: { content: { text: "Hello from Cohere" } } },
          };
          yield {
            type: "message-end",
            delta: {
              finish_reason: "COMPLETE",
              usage: { tokens: { input_tokens: 12, output_tokens: 10 } },
            },
          };
        },
      }),
    },
  };
}

function createBedrockTestClient() {
  return {
    converse: async () => ({
      output: {
        message: {
          role: "assistant",
          content: [{ text: "Hello from Bedrock" }],
        },
      },
      stopReason: "end_turn",
      usage: {
        inputTokens: 12,
        outputTokens: 10,
      },
    }),
    converseStream: async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          messageStart: { role: "assistant" },
        };
        yield {
          contentBlockDelta: {
            delta: { text: "Hello from Bedrock" },
          },
        };
        yield {
          messageStop: { stopReason: "end_turn" },
        };
        yield {
          metadata: {
            usage: {
              inputTokens: 12,
              outputTokens: 10,
            },
          },
        };
      },
    }),
  };
}

function createMinimaxTestClient() {
  const streamChunk = {
    id: "minimax-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "MiniMax-M1",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: "Hello from MiniMax",
        },
        finish_reason: null,
      },
    ],
  };
  const finalChunk = {
    ...streamChunk,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 10,
      total_tokens: 22,
    },
  };

  return {
    chatCompletions: async () => ({
      id: "minimax-test",
      object: "chat.completion",
      created: 1,
      model: "MiniMax-M1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello from MiniMax",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 10,
        total_tokens: 22,
      },
    }),
    chatCompletionsStream: async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield streamChunk;
        yield finalChunk;
      },
    }),
  };
}

function createZhipuaiTestClient() {
  const streamChunk = {
    id: "zhipuai-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "glm-4.5",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: "Hello from ZhipuAI",
        },
        finish_reason: null,
      },
    ],
  };
  const finalChunk = {
    ...streamChunk,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 10,
      total_tokens: 22,
    },
  };

  return {
    chatCompletions: async () => ({
      id: "zhipuai-test",
      object: "chat.completion",
      created: 1,
      model: "glm-4.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello from ZhipuAI",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 10,
        total_tokens: 22,
      },
    }),
    chatCompletionsStream: async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield streamChunk;
        yield finalChunk;
      },
    }),
  };
}

describe("model router proxy routes", () => {
  let anthropicStubOptions: AnthropicStubOptions;

  beforeEach(() => {
    anthropicStubOptions = {};
    for (const factory of [
      azureAdapterFactory,
      cerebrasAdapterFactory,
      deepseekAdapterFactory,
      groqAdapterFactory,
      minimaxAdapterFactory,
      mistralAdapterFactory,
      ollamaAdapterFactory,
      openaiAdapterFactory,
      openrouterAdapterFactory,
      perplexityAdapterFactory,
      vllmAdapterFactory,
      xaiAdapterFactory,
    ]) {
      vi.spyOn(factory, "createClient").mockImplementation(
        () => createOpenAiTestClient() as never,
      );
    }
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient(anthropicStubOptions) as never,
    );
    vi.spyOn(cohereAdapterFactory, "createClient").mockImplementation(
      () => createCohereTestClient() as never,
    );
    vi.spyOn(geminiAdapterFactory, "createClient").mockImplementation(
      () => createGeminiTestClient() as never,
    );
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () => createBedrockTestClient() as never,
    );
    vi.spyOn(minimaxAdapterFactory, "createClient").mockImplementation(
      () => createMinimaxTestClient() as never,
    );
    vi.spyOn(zhipuaiAdapterFactory, "createClient").mockImplementation(
      () => createZhipuaiTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const { provider, modelId } of ROUTABLE_PROVIDER_CASES) {
    test(`routes ${provider} models through chat completions`, async ({
      makeAgent,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const app = createFastifyApp();
      await app.register(modelRouterProxyRoutes);
      await upsertModel({ provider, modelId });
      const organization = await makeOrganization();
      const { value } = await createModelRouterVirtualKey({
        organizationId: organization.id,
        provider,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const agent = await makeAgent({
        organizationId: organization.id,
        name: `${provider} Model Router Agent`,
        agentType: "llm_proxy",
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/model-router/${agent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${value}`,
          "user-agent": "test-client",
        },
        payload: {
          model: `${provider}:${modelId}`,
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        object: "chat.completion",
      });
    });

    test(`routes ${provider} models through responses`, async ({
      makeAgent,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const app = createFastifyApp();
      await app.register(modelRouterProxyRoutes);
      await upsertModel({ provider, modelId });
      const organization = await makeOrganization();
      const { value } = await createModelRouterVirtualKey({
        organizationId: organization.id,
        provider,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const agent = await makeAgent({
        organizationId: organization.id,
        name: `${provider} Model Router Agent`,
        agentType: "llm_proxy",
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/model-router/${agent.id}/responses`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${value}`,
          "user-agent": "test-client",
        },
        payload: {
          model: `${provider}:${modelId}`,
          input: "Hello",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        object: "response",
        model: `${provider}:${modelId}`,
      });
    });

    test(`streams ${provider} models through chat completions and responses`, async ({
      makeAgent,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const app = createFastifyApp();
      await app.register(modelRouterProxyRoutes);
      await upsertModel({ provider, modelId });
      const organization = await makeOrganization();
      const { value } = await createModelRouterVirtualKey({
        organizationId: organization.id,
        provider,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const agent = await makeAgent({
        organizationId: organization.id,
        name: `${provider} Streaming Model Router Agent`,
        agentType: "llm_proxy",
      });

      const chatResponse = await app.inject({
        method: "POST",
        url: `/v1/model-router/${agent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${value}`,
          "user-agent": "test-client",
        },
        payload: {
          model: `${provider}:${modelId}`,
          stream: true,
          messages: [{ role: "user", content: "Hello" }],
        },
      });
      const responsesResponse = await app.inject({
        method: "POST",
        url: `/v1/model-router/${agent.id}/responses`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${value}`,
          "user-agent": "test-client",
        },
        payload: {
          model: `${provider}:${modelId}`,
          stream: true,
          input: "Hello",
        },
      });

      expect(chatResponse.statusCode, chatResponse.body).toBe(200);
      expect(chatResponse.headers["content-type"]).toContain(
        "text/event-stream",
      );
      expect(chatResponse.body).toContain("data: [DONE]");

      expect(responsesResponse.statusCode, responsesResponse.body).toBe(200);
      expect(responsesResponse.headers["content-type"]).toContain(
        "text/event-stream",
      );
      expect(responsesResponse.body).toContain("data: [DONE]");
      expect(responsesResponse.body).not.toContain(
        "Streaming is not yet available",
      );
    });
  }

  test("records model router requests with a model router interaction source", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    const provider = "openai";
    const modelId = "gpt-5.4";
    await upsertModel({ provider, modelId });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Source Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        [SOURCE_HEADER]: "chat",
      },
      payload: {
        model: `${provider}:${modelId}`,
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    const interactions = await InteractionModel.findAllPaginated(
      { limit: 10, offset: 0 },
      undefined,
      undefined,
      undefined,
      { profileId: agent.id },
    );
    expect(interactions.data).toHaveLength(1);
    expect(interactions.data[0].source).toBe("model_router");
  });

  test("rejects raw provider keys on model router routes", async ({
    makeAgent,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "gemini", modelId: "gemini-2.5-pro" });
    const agent = await makeAgent({
      name: "Model Router Provider Key Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-gemini-provider-key",
        "user-agent": "test-client",
      },
      payload: {
        model: "gemini:gemini-2.5-pro",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toContain(
      "Model Router-enabled virtual API key",
    );
  });

  test("rejects expired virtual keys on model router routes", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider: "openai",
      makeSecret,
      makeLlmProviderApiKey,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Expired Model Router Virtual Key Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "openai:gpt-5.4",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe("Virtual API key expired");
  });

  test("rejects provider-specific virtual keys that are not configured for model router", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const chatApiKey = await makeLlmProviderApiKey(organization.id, secret.id, {
      provider: "openai",
    });
    const { value } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "regular-provider-vk",
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Regular Virtual Key Model Router Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "openai:gpt-5.4",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe(
      "This virtual API key is not configured for Model Router usage.",
    );
  });

  test("rejects model router virtual keys for agents in another organization", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    const virtualKeyOrganization = await makeOrganization();
    const agentOrganization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: virtualKeyOrganization.id,
      provider: "openai",
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: agentOrganization.id,
      name: "Cross-org Model Router Agent",
      agentType: "llm_proxy",
    });

    const requests = [
      {
        method: "GET" as const,
        url: `/v1/model-router/${agent.id}/models`,
      },
      {
        method: "POST" as const,
        url: `/v1/model-router/${agent.id}/chat/completions`,
        payload: {
          model: "openai:gpt-5.4",
          messages: [{ role: "user", content: "Hello" }],
        },
      },
      {
        method: "POST" as const,
        url: `/v1/model-router/${agent.id}/responses`,
        payload: {
          model: "openai:gpt-5.4",
          input: "Hello",
        },
      },
    ];

    for (const request of requests) {
      const response = await app.inject({
        ...request,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${value}`,
          "user-agent": "test-client",
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toBe(
        "Model Router virtual key cannot access this LLM Proxy.",
      );
    }
  });

  test("resolves virtual keys and scopes model router access to the key provider", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    await upsertModel({ provider: "groq", modelId: "llama-3.1-8b-instant" });

    const organization = await makeOrganization();
    const secret = await makeSecret({
      secret: { apiKey: "sk-openai-parent-key" },
    });
    const chatApiKey = await makeLlmProviderApiKey(organization.id, secret.id, {
      provider: "openai",
    });
    const {
      virtualKey: { id: virtualKeyId },
      value,
    } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "model-router-openai-vk",
      modelRouterProviderApiKeys: [
        { provider: "openai", chatApiKeyId: chatApiKey.id },
      ],
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Virtual Key Agent",
      agentType: "llm_proxy",
    });

    let capturedApiKey: string | undefined;
    vi.mocked(openaiAdapterFactory.createClient).mockImplementation(
      (apiKey) => {
        capturedApiKey = apiKey;
        return createOpenAiTestClient() as never;
      },
    );

    const modelsResponse = await app.inject({
      method: "GET",
      url: `/v1/model-router/${agent.id}/models`,
      headers: {
        authorization: `Bearer ${value}`,
      },
    });
    const chatResponse = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "openai:gpt-5.4",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(modelsResponse.statusCode).toBe(200);
    expect(modelsResponse.json().data).toEqual([
      expect.objectContaining({ id: "openai:gpt-5.4" }),
    ]);
    expect(chatResponse.statusCode).toBe(200);
    expect(capturedApiKey).toBe("sk-openai-parent-key");
    expect(
      (await VirtualApiKeyModel.findById(virtualKeyId))?.lastUsedAt,
    ).not.toBeNull();
  });

  test("allows keyless Gemini system keys through model router responses", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { LlmProviderApiKeyModel } = await import("@/models");
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "gemini", modelId: "gemini-2.5-pro" });

    const organization = await makeOrganization();
    const systemKey = await LlmProviderApiKeyModel.createSystemKey({
      organizationId: organization.id,
      name: "Vertex AI",
      provider: "gemini",
    });
    const { value } = await VirtualApiKeyModel.create({
      chatApiKeyId: systemKey.id,
      name: "model-router-gemini-system-vk",
      modelRouterProviderApiKeys: [
        { provider: "gemini", chatApiKeyId: systemKey.id },
      ],
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Keyless Gemini Agent",
      agentType: "llm_proxy",
    });

    let capturedApiKey: string | undefined | null = null;
    vi.mocked(geminiAdapterFactory.createClient).mockImplementation(
      (apiKey) => {
        capturedApiKey = apiKey;
        return createGeminiTestClient() as never;
      },
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/responses`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "gemini:gemini-2.5-pro",
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "response",
      model: "gemini:gemini-2.5-pro",
    });
    expect(capturedApiKey).toBeUndefined();
  });

  test("routes provider-qualified model ids to their provider", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider: "openai",
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
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
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "groq", modelId: "llama-3.1-8b-instant" });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider: "groq",
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
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

  test("routes multiple providers through one model router virtual key", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    await upsertModel({ provider: "groq", modelId: "llama-3.1-8b-instant" });

    const organization = await makeOrganization();
    const openaiSecret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const groqSecret = await makeSecret({ secret: { apiKey: "sk-groq" } });
    const openaiKey = await makeLlmProviderApiKey(
      organization.id,
      openaiSecret.id,
      { provider: "openai" },
    );
    const groqKey = await makeLlmProviderApiKey(
      organization.id,
      groqSecret.id,
      { provider: "groq" },
    );
    const { value } = await VirtualApiKeyModel.create({
      chatApiKeyId: openaiKey.id,
      name: "model-router-openai-groq-vk",
      modelRouterProviderApiKeys: [
        { provider: "openai", chatApiKeyId: openaiKey.id },
        { provider: "groq", chatApiKeyId: groqKey.id },
      ],
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Multi-provider Model Router Agent",
      agentType: "llm_proxy",
    });

    const openaiResponse = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "openai:gpt-5.4",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const groqResponse = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "groq:llama-3.1-8b-instant",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(openaiResponse.statusCode).toBe(200);
    expect(groqResponse.statusCode).toBe(200);
    expect(openaiAdapterFactory.createClient).toHaveBeenCalledOnce();
    expect(groqAdapterFactory.createClient).toHaveBeenCalledOnce();
  });

  test("rejects unqualified model ids", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "shared-chat-model" });
    await upsertModel({ provider: "groq", modelId: "shared-chat-model" });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider: "openai",
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
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
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({
      provider: "anthropic",
      modelId: "claude-opus-4-6-20250918",
    });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider: "anthropic",
      makeSecret,
      makeLlmProviderApiKey,
      apiKeyValue: "test-anthropic-key",
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
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

  test("lists provider-qualified OpenAI-compatible model ids for mapped providers", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    await upsertModel({ provider: "groq", modelId: "llama-3.1-8b-instant" });
    await upsertModel({ provider: "cohere", modelId: "command-a-03-2025" });
    await upsertModel({ provider: "gemini", modelId: "gemini-2.5-pro" });
    const organization = await makeOrganization();
    const openaiSecret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const groqSecret = await makeSecret({ secret: { apiKey: "sk-groq" } });
    const openaiKey = await makeLlmProviderApiKey(
      organization.id,
      openaiSecret.id,
      { provider: "openai" },
    );
    const groqKey = await makeLlmProviderApiKey(
      organization.id,
      groqSecret.id,
      { provider: "groq" },
    );
    const { value } = await VirtualApiKeyModel.create({
      chatApiKeyId: openaiKey.id,
      name: "model-router-multi-vk",
      modelRouterProviderApiKeys: [
        { provider: "openai", chatApiKeyId: openaiKey.id },
        { provider: "groq", chatApiKeyId: groqKey.id },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/model-router/models",
      headers: {
        authorization: `Bearer ${value}`,
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
    expect(response.json().data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cohere:command-a-03-2025" }),
        expect.objectContaining({ id: "gemini:gemini-2.5-pro" }),
      ]),
    );
  });

  test("streams Anthropic model router responses as OpenAI SSE chunks", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({
      provider: "anthropic",
      modelId: "claude-opus-4-6-20250918",
    });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider: "anthropic",
      makeSecret,
      makeLlmProviderApiKey,
      apiKeyValue: "test-anthropic-key",
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Streaming Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "anthropic:claude-opus-4-6-20250918",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("data: ");
    expect(response.body).toContain('"object":"chat.completion.chunk"');
    expect(response.body).toContain("Hello!");
    expect(response.body).toContain("data: [DONE]");
    expect(response.body).not.toContain("event: message_start");
  });

  test("lists only models for providers mapped on the virtual key", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    await upsertModel({ provider: "groq", modelId: "llama-3.1-8b-instant" });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider: "groq",
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Mapped Model Router Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/model-router/${agent.id}/models`,
      headers: {
        authorization: `Bearer ${value}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        id: "groq:llama-3.1-8b-instant",
      }),
    ]);
  });

  test("rejects a model for a provider not mapped on the virtual key", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "openai", modelId: "gpt-5.4" });
    await upsertModel({ provider: "groq", modelId: "llama-3.1-8b-instant" });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider: "groq",
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Mapped Model Router Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "openai:gpt-5.4",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("not mapped");
  });
});
