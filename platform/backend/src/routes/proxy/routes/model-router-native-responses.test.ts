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
    scope: "org",
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
