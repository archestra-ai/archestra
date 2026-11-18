import { HttpResponse, http } from "msw";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import {
  InteractionModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { promptCacheUpstreamResponse } from "@/test/llm-prompt-cache-upstream";
import { useMswServer } from "@/test/msw";
import bedrockOpenaiRoutes from "./bedrock-openai";
import modelRouterRoutes from "./model-router";

setupTestCacheManager();
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper, not a React hook.
const server = useMswServer();

for (const stream of [false, true]) {
  test.for([
    { provider: "anthropic" as const, modelId: "claude-opus-4-6-20250918" },
    { provider: "cohere" as const, modelId: "command-a-03-2025" },
    { provider: "gemini" as const, modelId: "gemini-2.5-pro" },
  ])(`rejects unsupported $provider structured output before upstream (stream: ${stream})`, async ({
    provider,
    modelId,
  }, { makeAgent, makeSecret, makeLlmProviderApiKey }) => {
    let upstreamCalls = 0;
    server.use(
      http.all("*", () => {
        upstreamCalls++;
        return HttpResponse.json(
          { error: "Unexpected upstream call" },
          { status: 502 },
        );
      }),
    );
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    const model = await ModelModel.upsert({
      externalId: `${provider}/${modelId}`,
      provider,
      modelId,
      inputModalities: ["text"],
      outputModalities: ["text"],
      lastSyncedAt: new Date(),
    });
    const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
    const key = await makeLlmProviderApiKey(agent.organizationId, secret.id, {
      provider,
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    const { value } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "Structured translation test",
      providerApiKeys: [{ provider, providerApiKeyId: key.id }],
    });
    const app = createFastifyInstance();
    try {
      await app.register(modelRouterRoutes);
      await app.register(bedrockOpenaiRoutes);
      const urls = [
        "/v1/model-router/chat/completions",
        `/v1/model-router/${agent.id}/chat/completions`,
        "/v1/model-router/responses",
        `/v1/model-router/${agent.id}/responses`,
      ];
      for (const url of urls) {
        for (const format of [
          { type: "json_object" },
          {
            type: "json_schema",
            json_schema: {
              name: "status_result",
              strict: true,
              schema: {
                type: "object",
                properties: { status: { type: "string" } },
                required: ["status"],
                additionalProperties: false,
              },
            },
          },
        ]) {
          const response = await app.inject({
            method: "POST",
            url,
            headers: { authorization: `Bearer ${value}` },
            payload: {
              model: url.includes("model-router")
                ? `${provider}:${modelId}`
                : modelId,
              ...(url.endsWith("/responses")
                ? {
                    input: "Reply OK.",
                    text: {
                      format:
                        format.type === "json_schema"
                          ? { type: "json_schema", ...format.json_schema }
                          : format,
                    },
                  }
                : {
                    messages: [{ role: "user", content: "Reply OK." }],
                    response_format: format,
                  }),
              stream,
            },
          });
          expect(response.statusCode, response.body).toBe(400);
          expect(response.json().error.message).toContain("response_format");
        }
      }
      expect(upstreamCalls).toBe(0);
    } finally {
      await app.close();
    }
  });
}

// Bedrock Converse enforces a JSON Schema natively and has no JSON mode: a
// schema must reach Bedrock as a constraint, and `json_object` must still be
// served. Only the HTTP upstream is mocked.
const bedrockOrigin = "https://bedrock.example.test";
const bedrockModelId = "amazon.nova-pro-v1:0";
const statusSchema = {
  type: "object",
  properties: { status: { type: "string" } },
  required: ["status"],
  additionalProperties: false,
};

const bedrockTest = test.extend<{
  bedrock: {
    app: ReturnType<typeof createFastifyInstance>;
    agentId: string;
    token: string;
  };
}>({
  bedrock: async ({ makeAgent, makeSecret, makeLlmProviderApiKey }, use) => {
    const previous = { ...config.llm.bedrock };
    config.llm.bedrock.baseUrl = bedrockOrigin;
    config.llm.bedrock.iamAuthEnabled = false;
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    const model = await ModelModel.upsert({
      externalId: `bedrock/${bedrockModelId}`,
      provider: "bedrock",
      modelId: bedrockModelId,
      inputModalities: ["text"],
      outputModalities: ["text"],
      lastSyncedAt: new Date(),
    });
    const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
    const key = await makeLlmProviderApiKey(agent.organizationId, secret.id, {
      provider: "bedrock",
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    const { value } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "Bedrock structured output test",
      providerApiKeys: [{ provider: "bedrock", providerApiKeyId: key.id }],
    });
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    await app.register(bedrockOpenaiRoutes);
    try {
      await use({ app, agentId: agent.id, token: value });
    } finally {
      await app.close();
      Object.assign(config.llm.bedrock, previous);
    }
  },
});

function bedrockAnswer(stream: boolean): Response {
  return promptCacheUpstreamResponse({
    provider: "bedrock",
    api: "converse",
    model: bedrockModelId,
    stream,
    reads: 0,
    writes: 0,
  });
}

for (const stream of [false, true]) {
  bedrockTest(
    `sends a Bedrock json_schema constraint upstream and serves json_object (stream: ${stream})`,
    async ({ bedrock }) => {
      const upstream: Array<Record<string, unknown>> = [];
      server.use(
        http.post(
          `${bedrockOrigin}/model/:model/${stream ? "converse-stream" : "converse"}`,
          async ({ request }) => {
            upstream.push((await request.json()) as Record<string, unknown>);
            return bedrockAnswer(stream);
          },
        ),
      );
      const formats = [
        { type: "json_object" },
        {
          type: "json_schema",
          json_schema: {
            name: "status_result",
            strict: true,
            schema: statusSchema,
          },
        },
      ] as const;
      const urls = [
        "/v1/bedrock/openai/chat/completions",
        `/v1/bedrock/openai/${bedrock.agentId}/chat/completions`,
        "/v1/model-router/chat/completions",
        "/v1/model-router/responses",
      ];
      for (const url of urls) {
        for (const format of formats) {
          upstream.length = 0;
          const response = await bedrock.app.inject({
            method: "POST",
            url,
            headers: { authorization: `Bearer ${bedrock.token}` },
            payload: {
              model: url.includes("model-router")
                ? `bedrock:${bedrockModelId}`
                : bedrockModelId,
              ...(url.endsWith("/responses")
                ? {
                    input: "Reply OK.",
                    text: {
                      format:
                        format.type === "json_schema"
                          ? { type: "json_schema", ...format.json_schema }
                          : format,
                    },
                  }
                : {
                    messages: [{ role: "user", content: "Reply OK." }],
                    response_format: format,
                  }),
              stream,
            },
          });
          expect(response.statusCode, `${url} ${response.body}`).toBe(200);
          expect(response.body).toContain("answer");
          expect(upstream).toHaveLength(1);
          if (format.type === "json_object") {
            expect(upstream[0].outputConfig).toBeUndefined();
            continue;
          }
          const textFormat = (
            upstream[0].outputConfig as {
              textFormat: {
                type: string;
                structure: { jsonSchema: { name: string; schema: string } };
              };
            }
          ).textFormat;
          expect(textFormat.type).toBe("json_schema");
          expect(textFormat.structure.jsonSchema.name).toBe("status_result");
          expect(JSON.parse(textFormat.structure.jsonSchema.schema)).toEqual(
            statusSchema,
          );
        }
      }
    },
  );

  bedrockTest(
    `answers without the constraint when the Bedrock model has no structured output (stream: ${stream})`,
    async ({ bedrock }) => {
      const upstream: Array<Record<string, unknown>> = [];
      server.use(
        http.post(
          `${bedrockOrigin}/model/:model/${stream ? "converse-stream" : "converse"}`,
          async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            upstream.push(body);
            if (body.outputConfig)
              return HttpResponse.json(
                {
                  message:
                    "This model doesn't support the outputConfig field. Remove outputConfig and try again.",
                },
                { status: 400 },
              );
            return bedrockAnswer(stream);
          },
        ),
      );
      const response = await bedrock.app.inject({
        method: "POST",
        url: "/v1/bedrock/openai/chat/completions",
        headers: { authorization: `Bearer ${bedrock.token}` },
        payload: {
          model: bedrockModelId,
          messages: [{ role: "user", content: "Reply OK." }],
          response_format: {
            type: "json_schema",
            json_schema: { name: "status_result", schema: statusSchema },
          },
          stream,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("answer");
      expect(upstream.map((body) => Boolean(body.outputConfig))).toEqual([
        true,
        false,
      ]);
      // The log keeps the constraint the client asked for, and shows that
      // the request the model accepted carried none.
      const logged = await InteractionModel.findAllPaginated({
        limit: 1,
        offset: 0,
      });
      expect(logged.data[0].request).toHaveProperty("outputConfig");
      expect(logged.data[0].processedRequest).not.toHaveProperty(
        "outputConfig",
      );
    },
  );
}
