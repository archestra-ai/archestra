import Fastify from "fastify";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import modelRouterRoutes from "./model-router";
import xaiRoutes from "./xai";

setupTestCacheManager();

const formats = [
  { type: "text" },
  { type: "json_object" },
  {
    type: "json_schema",
    name: "status_result",
    description: "Synthetic status",
    strict: true,
    schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["ready"] } },
      required: ["status"],
      additionalProperties: false,
    },
  },
] as const;

test.for([
  { stream: false, withAgent: false },
  { stream: true, withAgent: false },
  { stream: false, withAgent: true },
  { stream: true, withAgent: true },
])("forwards Responses output constraints through xAI and model-router HTTP (%j)", async ({
  stream,
  withAgent,
}, { makeAgent, makeSecret, makeLlmProviderApiKey }) => {
  const captured: Record<string, unknown>[] = [];
  const upstream = Fastify();
  upstream.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    captured.push(body);
    const format = body.response_format as { type: string } | undefined;
    const content =
      format && format.type !== "text" ? '{"status":"ready"}' : "OK";
    const base = { id: "chatcmpl-formatted", created: 1, model: body.model };
    const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 };
    if (body.stream)
      return reply
        .type("text/event-stream")
        .send(
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
        );
    return {
      ...base,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage,
    };
  });
  const app = createFastifyInstance();
  try {
    const url = await upstream.listen({ host: "127.0.0.1", port: 0 });
    config.llm.xai.baseUrl = `${url}/v1`;
    config.llmProxy.plugins = [];
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    const model = await ModelModel.upsert({
      externalId: "xai/grok-4.7",
      provider: "xai",
      modelId: "grok-4.7",
      inputModalities: ["text"],
      outputModalities: ["text"],
      lastSyncedAt: new Date(),
    });
    const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
    const key = await makeLlmProviderApiKey(agent.organizationId, secret.id, {
      provider: "xai",
      baseUrl: `${url}/v1`,
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    const { value } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "Responses format test",
      providerApiKeys: [{ provider: "xai", providerApiKeyId: key.id }],
    });
    await app.register(xaiRoutes);
    await app.register(modelRouterRoutes);
    for (const provider of ["xai", "model-router"]) {
      const path = `/v1/${provider}${withAgent ? `/${agent.id}` : ""}/responses`;
      const modelName =
        provider === "model-router" ? "xai:grok-4.7" : "grok-4.7";
      for (const format of formats) {
        const response = await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${value}` },
          payload: {
            model: modelName,
            input: "Reply OK.",
            stream,
            text: { format },
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        const expected =
          format.type === "json_schema"
            ? {
                type: "json_schema",
                json_schema: {
                  name: format.name,
                  description: format.description,
                  schema: format.schema,
                  strict: format.strict,
                },
              }
            : format;
        expect(captured.at(-1)?.response_format).toEqual(expected);
        const content = stream
          ? response.body
              .split("\n")
              .filter(
                (line) => line.startsWith("data: ") && !line.includes("[DONE]"),
              )
              .map(
                (line) =>
                  JSON.parse(line.slice(6)) as {
                    type?: string;
                    delta?: string;
                  },
              )
              .filter((event) => event.type === "response.output_text.delta")
              .map((event) => event.delta ?? "")
              .join("")
          : response.json().output[0].content[0].text;
        expect(content).toBe(
          format.type === "text" ? "OK" : '{"status":"ready"}',
        );
      }
      const beforeInvalid = captured.length;
      for (const format of [
        null,
        { type: "unsupported" },
        { type: "json_schema", name: "missing_schema" },
        { type: "json_schema", name: "bad_strict", schema: {}, strict: "true" },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${value}` },
          payload: {
            model: modelName,
            input: "Reply OK.",
            stream,
            text: { format },
          },
        });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().error.message).toContain("text.format");
      }
      expect(captured).toHaveLength(beforeInvalid);
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: `Bearer ${value}` },
        payload: { model: modelName, input: "Reply OK.", stream },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(captured.at(-1)).not.toHaveProperty("response_format");
    }
  } finally {
    app.server.closeAllConnections();
    upstream.server.closeAllConnections();
    await app.close();
    await upstream.close();
  }
});
