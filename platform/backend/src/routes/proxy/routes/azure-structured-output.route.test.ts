import fastifySwagger from "@fastify/swagger";
import Fastify from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { OpenAI } from "openai";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel, VirtualApiKeyModel } from "@/models";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import azureRoutes from "./azure";

setupTestCacheManager();

const responseFormat = {
  type: "json_schema" as const,
  json_schema: {
    name: "status_result",
    description: "A synthetic status result",
    strict: true,
    schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["ready"] } },
      required: ["status"],
      additionalProperties: false,
    },
  },
};

test.for([
  { withAgent: false, stream: false },
  { withAgent: true, stream: false },
  { withAgent: false, stream: true },
  { withAgent: true, stream: true },
])("preserves strict structured output through Azure chat and interaction logs (%j)", async ({
  withAgent,
  stream,
}, { makeAgent, makeSecret, makeLlmProviderApiKey }) => {
  config.llm.azure.baseUrl = "";
  config.llm.azure.entraIdEnabled = false;
  config.llmProxy.plugins = [];
  const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
  const upstream = Fastify();
  const captured: Record<string, unknown>[] = [];
  upstream.post("/openai/v1/chat/completions", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    captured.push(body);
    const content = body.response_format ? '{"status":"ready"}' : "OK";
    if (body.stream) {
      return reply.type("text/event-stream").send(
        `data: ${JSON.stringify({
          id: "chatcmpl-structured",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content },
              finish_reason: null,
            },
          ],
        })}\n\ndata: ${JSON.stringify({
          id: "chatcmpl-structured",
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        })}\n\ndata: [DONE]\n\n`,
      );
    }
    return {
      id: "chatcmpl-structured",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };
  });
  const app = createFastifyInstance();
  try {
    const url = await upstream.listen({ host: "127.0.0.1", port: 0 });
    const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
    const key = await makeLlmProviderApiKey(agent.organizationId, secret.id, {
      provider: "azure",
      baseUrl: `${url}/openai/v1`,
    });
    const { value } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "Structured output test",
      providerApiKeys: [{ provider: "azure", providerApiKeyId: key.id }],
    });
    await app.register(fastifySwagger, {
      openapi: { info: { title: "Azure test", version: "1" } },
      transform: jsonSchemaTransform,
    });
    await app.register(azureRoutes);
    const proxyUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const document = app.swagger();
    for (const path of [
      "/v1/azure/chat/completions",
      "/v1/azure/{agentId}/chat/completions",
    ]) {
      const requestBody = document.paths?.[path]?.post?.requestBody;
      expect(requestBody).toHaveProperty(
        "content.application/json.schema.properties.response_format",
      );
    }
    const client = new OpenAI({
      baseURL: `${proxyUrl}/v1/azure${withAgent ? `/${agent.id}` : ""}`,
      apiKey: value,
      maxRetries: 0,
    });
    const body = {
      model: "structured-deployment",
      messages: [{ role: "user" as const, content: "Reply OK." }],
      response_format: responseFormat,
    };
    let content: string;
    if (stream) {
      content = "";
      for await (const chunk of await client.chat.completions.create({
        ...body,
        stream: true,
      })) {
        content += chunk.choices[0]?.delta.content ?? "";
      }
    } else {
      const response = await client.chat.completions.create(body);
      content = response.choices[0].message.content ?? "";
    }
    expect(content).toBe('{"status":"ready"}');
    expect(captured).toHaveLength(1);
    expect(captured[0].response_format).toEqual(responseFormat);
    await expect
      .poll(
        async () =>
          (await InteractionModel.getAllInteractionsForProfile(agent.id))
            .length,
      )
      .toBe(1);
    const [interaction] = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interaction.request).toMatchObject({
      response_format: responseFormat,
    });
    expect(interaction.processedRequest).toMatchObject({
      response_format: responseFormat,
    });
    const previousCalls = captured.length;
    for (const invalid of [
      { type: "unsupported" },
      { type: "json_schema" },
      {
        type: "json_schema",
        json_schema: { name: "bad", strict: "true", schema: {} },
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/azure${withAgent ? `/${agent.id}` : ""}/chat/completions`,
        headers: { authorization: `Bearer ${value}` },
        payload: { ...body, response_format: invalid },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(captured).toHaveLength(previousCalls);
  } finally {
    app.server.closeAllConnections();
    upstream.server.closeAllConnections();
    await app.close();
    await upstream.close();
  }
});
