import { createHash } from "node:crypto";
import {
  credentialRequiresPerUserScope,
  LLM_PROXY_OAUTH_SCOPE,
  SOURCE_HEADER,
  type SupportedProvider,
  type SupportedProviderEndpoint,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import db, { schema } from "@/database";
import {
  AgentModel,
  InteractionModel,
  LlmOauthClientModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  VirtualApiKeyModel,
} from "@/models";
import authRoutes from "@/routes/auth";
import { encodeXaiSubscriptionCredential } from "@/services/xai-subscription-credentials";
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
  geminiEmbeddingsAdapterFactory,
  githubCopilotAdapterFactory,
  githubCopilotResponsesAdapterFactory,
  groqAdapterFactory,
  minimaxAdapterFactory,
  mistralAdapterFactory,
  ollamaAdapterFactory,
  openAiResponsesAdapterFactory,
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
        type: "api_internal_server_error",
      },
    });
  });
  return app;
}

function createAzureTestClient() {
  return {
    apiKey: "test-azure-key",
    baseUrl: undefined,
    defaultHeaders: undefined,
    fetch: undefined,
    openai: createOpenAiTestClient(),
  };
}

async function upsertModel(params: {
  provider: SupportedProvider;
  modelId: string;
  embeddingDimensions?: 768 | 1536 | 3072;
  supportedEndpoints?: SupportedProviderEndpoint[];
}) {
  await ModelModel.upsert({
    externalId: `${params.provider}/${params.modelId}`,
    provider: params.provider,
    modelId: params.modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    embeddingDimensions: params.embeddingDimensions,
    supportedEndpoints: params.supportedEndpoints,
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
    overrides?: {
      provider?: SupportedProvider;
      scope?: "personal" | "team" | "org";
      userId?: string | null;
    },
  ) => Promise<{ id: string; provider: SupportedProvider }>;
  makeUser?: () => Promise<{ id: string }>;
  apiKeyValue?: string;
  expiresAt?: Date | null;
}) {
  const apiKeyValue = params.apiKeyValue ?? `test-${params.provider}-key`;
  const secret = await params.makeSecret({ secret: { apiKey: apiKeyValue } });
  const requiresPerUser = credentialRequiresPerUserScope({
    provider: params.provider,
    apiKey: apiKeyValue,
  });
  const owner = requiresPerUser ? await params.makeUser?.() : undefined;
  if (requiresPerUser && !owner) {
    throw new Error("Per-user Model Router fixtures require makeUser");
  }
  const chatApiKey = await params.makeLlmProviderApiKey(
    params.organizationId,
    secret.id,
    {
      provider: params.provider,
      scope: owner ? "personal" : "org",
      userId: owner?.id ?? null,
    },
  );
  await linkAllProviderModelsToApiKey(params.provider, chatApiKey.id);
  return VirtualApiKeyModel.create({
    organizationId: params.organizationId,
    name: `${params.provider} model router virtual key`,
    expiresAt: params.expiresAt,
    scope: owner ? "personal" : "org",
    authorId: owner?.id ?? null,
    providerApiKeys: [
      {
        provider: params.provider,
        providerApiKeyId: chatApiKey.id,
      },
    ],
  });
}

async function linkAllProviderModelsToApiKey(
  provider: SupportedProvider,
  apiKeyId: string,
) {
  const models = await ModelModel.findAll({ provider });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
    apiKeyId,
    models.map((m) => m.id),
  );
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
  // A Copilot model that serves chat completions takes the same uniform path
  // as any other OpenAI-wire provider; its Responses-only siblings are covered
  // separately below.
  { provider: "github-copilot", modelId: "gpt-4o" },
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

/**
 * Stands in for a provider's native Responses surface — the only shape a
 * Responses-only model can be served over.
 */
function createResponsesTestClient() {
  const completedResponse = {
    id: "resp-test-copilot",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: "gpt-5.4-codex",
    status: "completed",
    output: [
      {
        id: "msg-test-copilot",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Hello from Copilot Responses",
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 10,
      total_tokens: 22,
    },
  };

  return {
    responses: {
      create: async (params: { stream?: boolean }) => {
        if (params.stream) {
          return {
            [Symbol.asyncIterator]: async function* () {
              yield {
                type: "response.created",
                response: {
                  ...completedResponse,
                  status: "in_progress",
                  output: [],
                },
              };
              yield {
                type: "response.output_text.delta",
                delta: "Hello from Copilot Responses",
              };
              yield { type: "response.completed", response: completedResponse };
            },
          };
        }
        return completedResponse;
      },
    },
  };
}

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
      cerebrasAdapterFactory,
      deepseekAdapterFactory,
      groqAdapterFactory,
      minimaxAdapterFactory,
      mistralAdapterFactory,
      ollamaAdapterFactory,
      openaiAdapterFactory,
      githubCopilotAdapterFactory,
      openrouterAdapterFactory,
      perplexityAdapterFactory,
      vllmAdapterFactory,
      xaiAdapterFactory,
    ]) {
      vi.spyOn(factory, "createClient").mockImplementation(
        () => createOpenAiTestClient() as never,
      );
    }
    vi.spyOn(
      githubCopilotResponsesAdapterFactory,
      "createClient",
    ).mockImplementation(() => createResponsesTestClient() as never);
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () => createResponsesTestClient() as never,
    );
    vi.spyOn(azureAdapterFactory, "createClient").mockImplementation(
      () => createAzureTestClient() as never,
    );
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
      makeUser,
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
        makeUser,
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
      makeUser,
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
        makeUser,
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
      makeUser,
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
        makeUser,
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

  test("routes an internal Agent through the model router for background execution attribution", async ({
    makeAgent,
    makeOrganization,
    makeUser,
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
      makeUser,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Background execution Agent",
      agentType: "agent",
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
        model: "openai:gpt-5.4",
        input: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "response",
      model: "openai:gpt-5.4",
    });
  });

  test("routes a Responses-only model natively through the provider's Responses surface", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    const provider = "github-copilot";
    const modelId = "gpt-5.4-codex";
    await upsertModel({
      provider,
      modelId,
      supportedEndpoints: ["/responses"],
    });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider,
      makeUser,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Responses-only Agent",
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

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ object: "response" });
    // The native surface must be used verbatim: translating down to chat
    // completions would hit an endpoint this model does not serve.
    expect(
      githubCopilotResponsesAdapterFactory.createClient,
    ).toHaveBeenCalledOnce();
    expect(githubCopilotAdapterFactory.createClient).not.toHaveBeenCalled();
  });

  test("routes a native Codex model slug through OpenAI's Responses surface", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    const provider = "openai";
    const modelId = "gpt-5.3-codex";
    await upsertModel({ provider, modelId });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider,
      makeUser,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "OpenAI Responses Background Agent",
      agentType: "agent",
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
        // Native coding clients use OpenAI's slug. This is unambiguous because
        // the task's virtual key maps exactly one provider.
        model: modelId,
        input: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(openAiResponsesAdapterFactory.createClient).toHaveBeenCalledOnce();
    expect(openaiAdapterFactory.createClient).not.toHaveBeenCalled();
  });

  test("streams a Responses-only model through the provider's Responses surface", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    const provider = "github-copilot";
    const modelId = "gpt-5.4-codex";
    await upsertModel({
      provider,
      modelId,
      supportedEndpoints: ["/responses"],
    });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider,
      makeUser,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Responses-only Streaming Agent",
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
        stream: true,
        input: "Hello",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("data: [DONE]");
    expect(
      githubCopilotResponsesAdapterFactory.createClient,
    ).toHaveBeenCalledOnce();
  });

  test("rejects a Responses-only model on chat completions with an actionable error", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    const provider = "github-copilot";
    const modelId = "gpt-5.4-codex";
    await upsertModel({
      provider,
      modelId,
      supportedEndpoints: ["/responses"],
    });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider,
      makeUser,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Responses-only Chat Agent",
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

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("/responses");
    // Nothing may reach the provider: the point of the local rejection is that
    // the request is known-bad before it costs an upstream round trip.
    expect(githubCopilotAdapterFactory.createClient).not.toHaveBeenCalled();
    expect(
      githubCopilotResponsesAdapterFactory.createClient,
    ).not.toHaveBeenCalled();
  });

  test("rejects Copilot embedding requests rather than sending the raw token upstream", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    // Copilot is an OpenAI-wire chat provider, so a registered embedding model
    // would otherwise fall into the generic OpenAI-compatible embeddings
    // adapter — which skips the GitHub-token-to-Copilot-bearer exchange.
    const provider = "github-copilot";
    const modelId = "text-embedding-3-small";
    await upsertModel({ provider, modelId, embeddingDimensions: 1536 });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider,
      makeUser,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Copilot Embedding Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/embeddings`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: `${provider}:${modelId}`,
        input: ["first"],
      },
    });

    expect(response.statusCode).toBe(501);
    expect(githubCopilotAdapterFactory.createClient).not.toHaveBeenCalled();
  });

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

    expect(response.statusCode, response.body).toBe(200);
    const interactions = await InteractionModel.findAllPaginated(
      { limit: 10, offset: 0 },
      undefined,
      undefined,
      undefined,
      { profileId: (await AgentModel.getOrgLlmProxy(agent.organizationId)).id },
    );
    expect(interactions.data).toHaveLength(1);
    expect(interactions.data[0].source).toBe("model_router");
  });

  test("routes OpenAI embedding models through embeddings", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    const provider = "openai";
    const modelId = "text-embedding-3-small";
    await upsertModel({ provider, modelId, embeddingDimensions: 1536 });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider,
      makeSecret,
      makeLlmProviderApiKey,
      apiKeyValue: "sk-openai-embedding",
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Embedding Agent",
      agentType: "llm_proxy",
    });

    let capturedApiKey: string | undefined;
    vi.mocked(openaiAdapterFactory.createClient).mockImplementation(
      (apiKey) => {
        capturedApiKey = apiKey;
        return createOpenAiTestClient() as never;
      },
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/embeddings`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: `${provider}:${modelId}`,
        input: ["first", "second"],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      model: modelId,
      data: [
        { object: "embedding", index: 0 },
        { object: "embedding", index: 1 },
      ],
    });
    expect(capturedApiKey).toBe("sk-openai-embedding");

    const interactions = await InteractionModel.findAllPaginated(
      { limit: 10, offset: 0 },
      undefined,
      undefined,
      undefined,
      { profileId: (await AgentModel.getOrgLlmProxy(agent.organizationId)).id },
    );
    expect(interactions.data[0]).toMatchObject({
      type: "openai:embeddings",
      source: "model_router",
      model: modelId,
      inputTokens: 2,
      outputTokens: 0,
    });
  });

  const OPENAI_COMPATIBLE_EMBEDDING_CASES: Array<{
    provider: SupportedProvider;
    modelId: string;
  }> = [
    { provider: "azure", modelId: "text-embedding-3-large" },
    { provider: "mistral", modelId: "mistral-embed" },
    { provider: "ollama", modelId: "nomic-embed-text" },
    { provider: "vllm", modelId: "BAAI/bge-m3" },
    { provider: "zhipuai", modelId: "embedding-3" },
  ];

  for (const { provider, modelId } of OPENAI_COMPATIBLE_EMBEDDING_CASES) {
    test(`routes ${provider} embedding models through the OpenAI-compatible embeddings adapter`, async ({
      makeAgent,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const app = createFastifyApp();
      await app.register(modelRouterProxyRoutes);
      await upsertModel({ provider, modelId, embeddingDimensions: 1536 });
      const organization = await makeOrganization();
      const { value } = await createModelRouterVirtualKey({
        organizationId: organization.id,
        provider,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const agent = await makeAgent({
        organizationId: organization.id,
        name: `Model Router ${provider} Embedding Agent`,
        agentType: "llm_proxy",
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/model-router/${agent.id}/embeddings`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${value}`,
          "user-agent": "test-client",
        },
        payload: {
          model: `${provider}:${modelId}`,
          input: ["first", "second"],
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        object: "list",
        model: modelId,
        data: [
          { object: "embedding", index: 0 },
          { object: "embedding", index: 1 },
        ],
      });

      const interactions = await InteractionModel.findAllPaginated(
        { limit: 10, offset: 0 },
        undefined,
        undefined,
        undefined,
        {
          profileId: (await AgentModel.getOrgLlmProxy(agent.organizationId)).id,
        },
      );
      expect(interactions.data[0]).toMatchObject({
        type: "openai:embeddings",
        source: "model_router",
        model: modelId,
        inputTokens: 2,
        outputTokens: 0,
      });
    });
  }

  test("routes Gemini embedding models through the native Gemini embeddings adapter", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    const provider = "gemini";
    const modelId = "gemini-embedding-001";
    await upsertModel({ provider, modelId, embeddingDimensions: 3072 });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Gemini Embedding Agent",
      agentType: "llm_proxy",
    });

    // The Gemini embeddings adapter creates its own GenAI client (rather than
    // delegating to the chat adapter), so mock its createClient specifically.
    vi.spyOn(geminiEmbeddingsAdapterFactory, "createClient").mockImplementation(
      () => createGeminiTestClient() as never,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/embeddings`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: `${provider}:${modelId}`,
        input: ["first", "second"],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      model: modelId,
      data: [
        { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
        { object: "embedding", index: 1, embedding: [0.1, 0.2, 0.3] },
      ],
    });

    const interactions = await InteractionModel.findAllPaginated(
      { limit: 10, offset: 0 },
      undefined,
      undefined,
      undefined,
      { profileId: (await AgentModel.getOrgLlmProxy(agent.organizationId)).id },
    );
    expect(interactions.data[0]).toMatchObject({
      type: "gemini:embeddings",
      source: "model_router",
      model: modelId,
    });
  });

  test("rejects embedding requests for providers without an embeddings adapter", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    // Cohere is a translated (non-OpenAI-wire) provider with no embeddings
    // adapter, so a registered embedding model must surface a clear 501.
    const provider = "cohere";
    const modelId = "embed-english-v3.0";
    await upsertModel({ provider, modelId, embeddingDimensions: 1536 });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Cohere Embedding Agent",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/embeddings`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: `${provider}:${modelId}`,
        input: ["first"],
      },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json().error.message).toContain("not yet available");
  });

  test("lists embedding models but rejects them on chat completions", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({
      provider: "openai",
      modelId: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider: "openai",
      makeSecret,
      makeLlmProviderApiKey,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Model Router Embedding List Agent",
      agentType: "llm_proxy",
    });

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
        model: "openai:text-embedding-3-small",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(modelsResponse.statusCode).toBe(200);
    expect(modelsResponse.json().data).toEqual([
      expect.objectContaining({ id: "openai:text-embedding-3-small" }),
    ]);
    expect(chatResponse.statusCode).toBe(404);
    expect(chatResponse.json().error.message).toContain("not available");
  });

  test("routes requests authenticated with an LLM OAuth client access token issued from client credentials", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(authRoutes);
    await app.register(modelRouterProxyRoutes);
    const provider = "openai";
    const modelId = "gpt-5.4";
    await upsertModel({ provider, modelId });
    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const chatApiKey = await makeLlmProviderApiKey(organization.id, secret.id, {
      provider,
    });
    await linkAllProviderModelsToApiKey(provider, chatApiKey.id);
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "OAuth Client Model Router Agent",
      agentType: "llm_proxy",
    });
    const { oauthClient, clientSecret } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      authorId: crypto.randomUUID(),
      name: "Backend Service",
      providerApiKeys: [
        {
          provider,
          providerApiKeyId: chatApiKey.id,
        },
      ],
    });

    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      payload: {
        grant_type: "client_credentials",
        client_id: oauthClient.clientId,
        client_secret: clientSecret,
        scope: LLM_PROXY_OAUTH_SCOPE,
      },
    });
    expect(tokenResponse.statusCode).toBe(200);
    const { access_token: accessToken } = tokenResponse.json();
    expect(accessToken).toMatch(/^llm_at_/);

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "x-archestra-agent-id": "caller-supplied-label",
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
      { profileId: (await AgentModel.getOrgLlmProxy(agent.organizationId)).id },
    );
    expect(interactions.data[0]).toMatchObject({
      authMethod: "oauth_client_credentials",
      authenticatedAppId: oauthClient.id,
      authenticatedAppName: "Backend Service",
      externalAgentId: "caller-supplied-label",
    });
  });

  test("rejects a credential-level subscription mapped out of band to client credentials", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(authRoutes);
    await app.register(modelRouterProxyRoutes);
    const provider = "xai";
    const modelId = "grok-4";
    await upsertModel({ provider, modelId });
    const organization = await makeOrganization();
    const secret = await makeSecret({
      secret: {
        apiKey: `Bearer: ${encodeXaiSubscriptionCredential({
          refreshToken: "rt-never-share",
          userId: "x-user",
        })}`,
      },
    });
    const chatApiKey = await makeLlmProviderApiKey(organization.id, secret.id, {
      provider,
    });
    await linkAllProviderModelsToApiKey(provider, chatApiKey.id);
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Unsafe Subscription Router",
      agentType: "llm_proxy",
    });
    const { oauthClient, clientSecret } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      authorId: crypto.randomUUID(),
      name: "Out-of-band Subscription Client",
      providerApiKeys: [{ provider, providerApiKeyId: chatApiKey.id }],
    });
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      payload: {
        grant_type: "client_credentials",
        client_id: oauthClient.clientId,
        client_secret: clientSecret,
        scope: LLM_PROXY_OAUTH_SCOPE,
      },
    });
    expect(tokenResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenResponse.json().access_token}`,
      },
      payload: {
        model: `${provider}:${modelId}`,
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("SuperGrok is per-user");
  });

  test("rejects a shared virtual key mapped to another user's Copilot credential", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    const provider = "github-copilot";
    const modelId = "gpt-4o";
    await upsertModel({ provider, modelId });
    const organization = await makeOrganization();
    const owner = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "gho_owner" } });
    const chatApiKey = await makeLlmProviderApiKey(organization.id, secret.id, {
      provider,
      scope: "personal",
      userId: owner.id,
    });
    await linkAllProviderModelsToApiKey(provider, chatApiKey.id);
    const { value } = await VirtualApiKeyModel.create({
      organizationId: organization.id,
      name: "legacy-shared-copilot-router",
      scope: "org",
      authorId: owner.id,
      providerApiKeys: [{ provider, providerApiKeyId: chatApiKey.id }],
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Shared Copilot Router",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
      },
      payload: {
        model: `${provider}:${modelId}`,
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "github-copilot is per-user",
    );
  });

  test("rejects Model Router access tokens for disabled LLM OAuth clients", async ({
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
    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const chatApiKey = await makeLlmProviderApiKey(organization.id, secret.id, {
      provider,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Disabled OAuth Client Model Router Agent",
      agentType: "llm_proxy",
    });
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      authorId: crypto.randomUUID(),
      name: "Disabled Backend Service",
      providerApiKeys: [{ provider, providerApiKeyId: chatApiKey.id }],
    });
    await db
      .update(schema.oauthClientsTable)
      .set({ disabled: true })
      .where(eq(schema.oauthClientsTable.id, oauthClient.id));
    const accessToken = "model-router-disabled-client-token";
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
      referenceId: `llm-proxy:${oauthClient.id}`,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      payload: {
        model: `${provider}:${modelId}`,
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe("LLM OAuth client is disabled.");
  });

  test("rejects Model Router access tokens linked to revoked refresh tokens", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    const provider = "openai";
    const modelId = "gpt-5.4";
    await upsertModel({ provider, modelId });
    const organization = await makeOrganization();
    const user = await makeUser({ email: "model-router-revoked@example.com" });
    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const chatApiKey = await makeLlmProviderApiKey(organization.id, secret.id, {
      provider,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Revoked Token Model Router Agent",
      agentType: "llm_proxy",
    });
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      authorId: user.id,
      name: "Revoked Token Backend Service",
      providerApiKeys: [{ provider, providerApiKeyId: chatApiKey.id }],
    });
    const refreshId = crypto.randomUUID();
    await db.insert(schema.oauthRefreshTokensTable).values({
      id: refreshId,
      token: "model-router-revoked-refresh-token",
      clientId: oauthClient.clientId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      revoked: new Date(),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
    });
    const accessToken = "model-router-revoked-refresh-token";
    const createdAccessToken =
      await OAuthAccessTokenModel.createClientCredentialsToken({
        tokenHash: createHash("sha256").update(accessToken).digest("base64url"),
        clientId: oauthClient.clientId,
        expiresAt: new Date(Date.now() + 60_000),
        scopes: [LLM_PROXY_OAUTH_SCOPE],
        referenceId: `llm-proxy:${oauthClient.id}`,
      });
    await db
      .update(schema.oauthAccessTokensTable)
      .set({ refreshId })
      .where(eq(schema.oauthAccessTokensTable.id, createdAccessToken.id));

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      payload: {
        model: `${provider}:${modelId}`,
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe(
      "Invalid LLM OAuth client access token.",
    );
  });

  test("routes requests authenticated with a user OAuth access token from an authorization code app", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeSecret,
    makeUser,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    const provider = "openai";
    const modelId = "gpt-5.4";
    await upsertModel({ provider, modelId });
    const organization = await makeOrganization();
    const user = await makeUser({ email: "oauth-user@example.com" });
    await makeMember(user.id, organization.id);
    const olderSecret = await makeSecret({
      secret: { apiKey: "sk-older-openai" },
    });
    const olderKey = await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      secretId: olderSecret.id,
      name: "Older User OpenAI Key",
      provider,
      scope: "personal",
      userId: user.id,
      teamId: null,
      isPrimary: false,
    });
    await linkAllProviderModelsToApiKey(provider, olderKey.id);
    const primarySecret = await makeSecret({
      secret: { apiKey: "sk-primary-openai" },
    });
    const primaryKey = await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      secretId: primarySecret.id,
      name: "Primary User OpenAI Key",
      provider,
      scope: "personal",
      userId: user.id,
      teamId: null,
      isPrimary: true,
    });
    await linkAllProviderModelsToApiKey(provider, primaryKey.id);
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "User OAuth Model Router Agent",
      agentType: "llm_proxy",
      scope: "org",
    });
    const clientId = `https://example.com/${crypto.randomUUID()}/client.json`;
    await OAuthClientModel.upsertFromCimd({
      id: crypto.randomUUID(),
      clientId,
      name: "Example OAuth App",
      redirectUris: ["http://localhost:3107/callback"],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      scopes: ["mcp"],
      tokenEndpointAuthMethod: "none",
      isPublic: true,
      metadata: { demo: true },
    });
    const rawAccessToken = `user-oauth-token-${crypto.randomUUID()}`;
    await OAuthAccessTokenModel.create({
      tokenHash: createHash("sha256")
        .update(rawAccessToken)
        .digest("base64url"),
      clientId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
    });
    let capturedApiKey: string | undefined;
    vi.mocked(openaiAdapterFactory.createClient).mockImplementation(
      (apiKey) => {
        capturedApiKey = apiKey;
        return createOpenAiTestClient() as never;
      },
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${rawAccessToken}`,
      },
      payload: {
        model: `${provider}:${modelId}`,
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedApiKey).toBe("sk-primary-openai");
    const interactions = await InteractionModel.findAllPaginated(
      { limit: 10, offset: 0 },
      undefined,
      undefined,
      undefined,
      { profileId: (await AgentModel.getOrgLlmProxy(agent.organizationId)).id },
    );
    expect(interactions.data[0]).toMatchObject({
      authMethod: "oauth_user",
      authenticatedAppName: "Example OAuth App",
      userId: user.id,
    });
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
      "Invalid LLM OAuth client access token",
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

  test("accepts mapped virtual keys for model router requests", async ({
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
    await linkAllProviderModelsToApiKey("openai", chatApiKey.id);
    const { value } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
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

    expect(response.statusCode).toBe(200);
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
        "Model Router virtual key cannot access this Agent.",
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
    await linkAllProviderModelsToApiKey("openai", chatApiKey.id);
    const {
      virtualKey: { id: virtualKeyId },
      value,
    } = await VirtualApiKeyModel.create({
      name: "model-router-openai-vk",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: chatApiKey.id },
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
    await linkAllProviderModelsToApiKey("gemini", systemKey.id);
    const { value } = await VirtualApiKeyModel.create({
      name: "model-router-gemini-system-vk",
      providerApiKeys: [{ provider: "gemini", providerApiKeyId: systemKey.id }],
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
    await linkAllProviderModelsToApiKey("openai", openaiKey.id);
    await linkAllProviderModelsToApiKey("groq", groqKey.id);
    const { value } = await VirtualApiKeyModel.create({
      name: "model-router-openai-groq-vk",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: openaiKey.id },
        { provider: "groq", providerApiKeyId: groqKey.id },
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

  test("routes an unqualified model id when the key maps one provider", async ({
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

    expect(response.statusCode).toBe(200);
    expect(openaiAdapterFactory.createClient).toHaveBeenCalledOnce();
    expect(groqAdapterFactory.createClient).not.toHaveBeenCalled();
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
    const llmProxy = await AgentModel.getOrgLlmProxy(agent.organizationId);
    expect(anthropicAdapterFactory.createClient).toHaveBeenCalledOnce();
    expect(anthropicAdapterFactory.createClient).toHaveBeenCalledWith(
      "test-anthropic-key",
      // The proxy resolves a lean GatewayAgent (agents row + labels, no
      // tools/teams hydration), so assert the identity fields adapters and
      // observability actually consume rather than the full fixture object.
      expect.objectContaining({
        agent: expect.objectContaining({
          id: llmProxy.id,
          name: llmProxy.name,
          organizationId: agent.organizationId,
          agentType: "llm_proxy",
        }),
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

  // End-to-end counterpart to the adapter-level guard in
  // adapters/streaming-usage.test.ts: Anthropic counts cache reads and writes
  // OUTSIDE `input_tokens`, so relaying that field as OpenAI's `prompt_tokens`
  // reported an agent turn whose prompt was almost entirely a cache hit as a
  // prompt of the handful of tokens that missed — and dropped the cache read
  // from the wire, where a chained Archestra recovers it as
  // `prompt_tokens - cached_tokens`.
  test("reports Anthropic cache reads as part of the OpenAI prompt count", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    anthropicStubOptions.cacheReadInputTokens = 90_000;
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
    // The stub reports input_tokens 12, output_tokens 10 alongside the 90k read.
    expect(response.json().usage).toEqual({
      prompt_tokens: 90_012,
      completion_tokens: 10,
      total_tokens: 90_022,
      prompt_tokens_details: { cached_tokens: 90_000 },
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
    await linkAllProviderModelsToApiKey("openai", openaiKey.id);
    await linkAllProviderModelsToApiKey("groq", groqKey.id);
    const { value } = await VirtualApiKeyModel.create({
      name: "model-router-multi-vk",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: openaiKey.id },
        { provider: "groq", providerApiKeyId: groqKey.id },
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

  test("excludes models that exist for the mapped provider but are not linked to the virtual key's chat api key", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createFastifyApp();
    await app.register(modelRouterProxyRoutes);
    await upsertModel({ provider: "groq", modelId: "llama-3.1-8b-instant" });
    await upsertModel({ provider: "groq", modelId: "unlinked-model" });
    const organization = await makeOrganization();
    const { value } = await createModelRouterVirtualKey({
      organizationId: organization.id,
      provider: "groq",
      makeSecret,
      makeLlmProviderApiKey,
    });
    // Add a second model AFTER the virtual key so it's not linked
    await upsertModel({ provider: "groq", modelId: "added-after-link" });
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Unlinked Model Test Agent",
      agentType: "llm_proxy",
    });

    const listResponse = await app.inject({
      method: "GET",
      url: `/v1/model-router/${agent.id}/models`,
      headers: {
        authorization: `Bearer ${value}`,
      },
    });

    expect(listResponse.statusCode).toBe(200);
    const listedIds = listResponse.json().data.map((m: { id: string }) => m.id);
    expect(listedIds).toContain("groq:llama-3.1-8b-instant");
    expect(listedIds).toContain("groq:unlinked-model");
    expect(listedIds).not.toContain("groq:added-after-link");

    const routeResponse = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: "groq:added-after-link",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(routeResponse.statusCode).toBe(404);
    expect(routeResponse.json().error.message).toContain("not available");
  });
});
