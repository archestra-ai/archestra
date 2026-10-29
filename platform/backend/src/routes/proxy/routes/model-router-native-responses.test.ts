import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import config from "@/config";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import modelRouterProxyRoutes from "./model-router";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper, not a React hook.
const server = useMswServer();

const AZURE_BASE_URL = "https://router-test.services.ai.azure.com/openai/v1";

test("preserves native Responses reasoning, replay state and tool calls through the model router", async ({
  makeOrganization,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  config.llm.openai.baseUrl = "https://native-responses.example.test/v1";
  const organization = await makeOrganization();
  const agent = await makeAgent({
    organizationId: organization.id,
    agentType: "agent",
  });
  const model = await ModelModel.upsert({
    externalId: "openai/gpt-5.4",
    provider: "openai",
    modelId: "gpt-5.4",
    inputModalities: ["text"],
    outputModalities: ["text"],
    lastSyncedAt: new Date(),
  });
  const secret = await makeSecret({ secret: { apiKey: "test-native-key" } });
  const key = await makeLlmProviderApiKey(organization.id, secret.id, {
    provider: "openai",
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [model.id]);
  const { value } = await VirtualApiKeyModel.create({
    organizationId: organization.id,
    name: "Native Responses test",
    providerApiKeys: [{ provider: "openai", providerApiKeyId: key.id }],
  });
  const payload = {
    model: "openai:gpt-5.4",
    stream: false,
    reasoning: { effort: "high" },
    include: ["reasoning.encrypted_content"],
    input: [
      { role: "user", content: "Inspect the project." },
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Checking the project." }],
      },
      {
        type: "reasoning",
        id: "rs_prior",
        encrypted_content: "opaque-state",
        summary: [],
      },
    ],
    tools: [
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: {} },
      },
    ],
  };
  const call = {
    type: "function_call",
    id: "fc_read",
    call_id: "call_read",
    name: "read_file",
    arguments: "{}",
    status: "completed",
  };
  const message = {
    type: "message",
    id: "msg_progress",
    role: "assistant",
    phase: "commentary",
    status: "completed",
    content: [
      { type: "output_text", text: "Checking the project.", annotations: [] },
    ],
  };
  let upstream: unknown;
  server.use(
    http.post(
      "https://native-responses.example.test/v1/responses",
      async ({ request }) => {
        upstream = await request.json();
        return HttpResponse.json({
          id: "resp_native",
          object: "response",
          created_at: 1,
          model: "gpt-5.4",
          status: "completed",
          output: [message, call],
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        });
      },
    ),
    http.post("https://native-responses.example.test/v1/chat/completions", () =>
      HttpResponse.json(
        {
          error: { message: "Native Responses must not be translated to chat" },
        },
        { status: 400 },
      ),
    ),
  );
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(modelRouterProxyRoutes);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/responses`,
      headers: {
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(upstream).toMatchObject({ ...payload, model: "gpt-5.4" });
    expect(response.json().output).toEqual([message, call]);
  } finally {
    await app.close();
  }
});

test("sends Azure OpenAI deployments to Azure's native Responses API", async ({
  makeOrganization,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const { agent, value } = await setUpAzureRouter({
    modelId: "gpt-5.4",
    makeOrganization,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  });
  // Azure Chat Completions rejects function tools combined with reasoning on
  // GPT reasoning deployments, so a chat round trip cannot serve this request.
  const payload = {
    model: "azure:gpt-5.4",
    stream: false,
    reasoning: { effort: "low" },
    max_output_tokens: 256,
    input: [{ role: "user", content: "Inspect the project." }],
    tools: [
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: {} },
      },
    ],
  };
  const call = {
    type: "function_call",
    id: "fc_read",
    call_id: "call_read",
    name: "read_file",
    arguments: "{}",
    status: "completed",
  };
  let upstream: unknown;
  server.use(
    http.post(`${AZURE_BASE_URL}/responses`, async ({ request }) => {
      upstream = await request.json();
      return HttpResponse.json({
        id: "resp_azure",
        object: "response",
        created_at: 1,
        model: "gpt-5.4",
        status: "completed",
        output: [call],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      });
    }),
    http.post(`${AZURE_BASE_URL}/chat/completions`, () =>
      HttpResponse.json(
        {
          error: {
            message:
              "Function tools with reasoning_effort are not supported for this model in /v1/chat/completions.",
          },
        },
        { status: 400 },
      ),
    ),
  );
  const response = await injectRouterResponses({ agent, value, payload });

  expect(response.statusCode, response.body).toBe(200);
  expect(upstream).toMatchObject({ ...payload, model: "gpt-5.4" });
  expect(response.json().output).toEqual([call]);
});

test("keeps non-OpenAI Azure deployments on the chat translation", async ({
  makeOrganization,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  // Azure's Responses API serves only some partner models, and answers the
  // rest with "Model not supported", so these stay on the chat translation.
  const modelId = "Llama-4-Scout-17B-16E-Instruct";
  const { agent, value } = await setUpAzureRouter({
    modelId,
    makeOrganization,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  });
  let upstream: Record<string, unknown> | undefined;
  server.use(
    http.post(`${AZURE_BASE_URL}/responses`, () =>
      HttpResponse.json(
        { error: { message: "Model not supported" } },
        { status: 400 },
      ),
    ),
    http.post(`${AZURE_BASE_URL}/chat/completions`, async ({ request }) => {
      upstream = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        id: "chatcmpl_azure",
        object: "chat.completion",
        created: 1,
        model: modelId,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Done." },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }),
  );
  const response = await injectRouterResponses({
    agent,
    value,
    payload: {
      model: `azure:${modelId}`,
      stream: false,
      max_output_tokens: 256,
      input: "Hello",
    },
  });

  expect(response.statusCode, response.body).toBe(200);
  // Open models accept `max_tokens`; only OpenAI deployments switch fields.
  expect(upstream).toMatchObject({ model: modelId, max_tokens: 256 });
  expect(upstream).not.toHaveProperty("max_completion_tokens");
  expect(response.json()).toMatchObject({ object: "response" });
});

test.for([
  {
    name: "a v1 endpoint",
    baseUrl: AZURE_BASE_URL,
    upstreamUrl: `${AZURE_BASE_URL}/chat/completions`,
    apiVersion: "2024-02-01",
    expected: { max_completion_tokens: 512 },
  },
  {
    name: "a classic endpoint on a current api-version",
    baseUrl: "https://router-test.openai.azure.com/openai",
    upstreamUrl:
      "https://router-test.openai.azure.com/openai/deployments/gpt-6-luna/chat/completions",
    apiVersion: "2024-10-21",
    expected: { max_completion_tokens: 512 },
  },
  {
    name: "a classic endpoint on an api-version that predates max_completion_tokens",
    baseUrl: "https://router-test.openai.azure.com/openai",
    upstreamUrl:
      "https://router-test.openai.azure.com/openai/deployments/gpt-6-luna/chat/completions",
    apiVersion: "2024-02-01",
    expected: { max_tokens: 512 },
  },
])("sends Azure OpenAI deployments max_completion_tokens on $name", async ({
  baseUrl,
  upstreamUrl,
  apiVersion,
  expected,
}, { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey }) => {
  // A newer GPT family that the AI SDK's reasoning-name list does not know,
  // so clients send `max_tokens`, which Azure rejects for reasoning models.
  const modelId = "gpt-6-luna";
  const { agent, value } = await setUpAzureRouter({
    modelId,
    makeOrganization,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  });
  config.llm.azure.baseUrl = baseUrl;
  const originalApiVersion = config.llm.azure.apiVersion;
  config.llm.azure.apiVersion = apiVersion;
  let upstream: Record<string, unknown> | undefined;
  server.use(
    http.post(upstreamUrl, async ({ request }) => {
      upstream = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        id: "chatcmpl_azure",
        object: "chat.completion",
        created: 1,
        model: modelId,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Done." },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }),
  );
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(modelRouterProxyRoutes);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/chat/completions`,
      headers: {
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: {
        model: `azure:${modelId}`,
        max_tokens: 512,
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(upstream).toMatchObject({ model: modelId, ...expected });
    const replaced =
      "max_tokens" in expected ? "max_completion_tokens" : "max_tokens";
    expect(upstream).not.toHaveProperty(replaced);
  } finally {
    config.llm.azure.apiVersion = originalApiVersion;
    await app.close();
  }
});

// === Helpers ===

async function setUpAzureRouter(params: {
  modelId: string;
  makeOrganization: () => Promise<{ id: string }>;
  makeAgent: (overrides: {
    organizationId: string;
    agentType: "agent";
  }) => Promise<{ id: string }>;
  makeSecret: (overrides: {
    secret: Record<string, string>;
  }) => Promise<{ id: string }>;
  makeLlmProviderApiKey: (
    organizationId: string,
    secretId: string,
    overrides: { provider: "azure" },
  ) => Promise<{ id: string }>;
}) {
  config.llm.azure.baseUrl = AZURE_BASE_URL;
  const organization = await params.makeOrganization();
  const agent = await params.makeAgent({
    organizationId: organization.id,
    agentType: "agent",
  });
  const model = await ModelModel.upsert({
    externalId: `azure/${params.modelId}`,
    provider: "azure",
    modelId: params.modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    lastSyncedAt: new Date(),
  });
  const secret = await params.makeSecret({
    secret: { apiKey: "test-azure-key" },
  });
  const key = await params.makeLlmProviderApiKey(organization.id, secret.id, {
    provider: "azure",
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [model.id]);
  const { value } = await VirtualApiKeyModel.create({
    organizationId: organization.id,
    name: "Azure Model Router test",
    providerApiKeys: [{ provider: "azure", providerApiKeyId: key.id }],
  });
  return { agent, value };
}

async function injectRouterResponses(params: {
  agent: { id: string };
  value: string;
  payload: Record<string, unknown>;
}) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(modelRouterProxyRoutes);
  try {
    return await app.inject({
      method: "POST",
      url: `/v1/model-router/${params.agent.id}/responses`,
      headers: {
        authorization: `Bearer ${params.value}`,
        "user-agent": "test-client",
      },
      payload: params.payload,
    });
  } finally {
    await app.close();
  }
}
