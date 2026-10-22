import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import OpenAI from "openai";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import {
  InteractionModel,
  LimitModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { accessGrants, describe, expect, test, vi } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { azureCapabilityConfigurationHash } from "@/utils/azure-capability-scope";
import modelRouterRoutes from "./model-router";

setupTestCacheManager();

test("the same Azure alias binds to the selected resource's evidence and credentials", async ({
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  config.llmProxy.plugins = [];
  const agent = await makeAgent({ isDefault: true, agentType: "llm_proxy" });
  const upstream = await startUpstream();
  const model = await ModelModel.upsert({
    externalId: "azure/production",
    provider: "azure",
    modelId: "production",
    inputModalities: ["text"],
    outputModalities: ["image"],
    lastSyncedAt: new Date(),
  });
  const keys = [];
  for (const kind of ["image", "text"] as const) {
    const secret = await makeSecret({
      secret: { apiKey: `synthetic-${kind}-key` },
    });
    const baseUrl = `${upstream.origin}/${kind}/openai/v1`;
    const providerKey = await makeLlmProviderApiKey(
      agent.organizationId,
      secret.id,
      { provider: "azure", baseUrl },
    );
    await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
      providerKey.id,
      [
        {
          id: model.id,
          modelId: model.modelId,
          azureCapabilities: {
            kind,
            underlyingModelName: kind === "image" ? "gpt-image-1" : "gpt-4o",
            operations:
              kind === "image"
                ? ["image-generation", "image-edit"]
                : ["chat", "responses"],
            source: "deployment",
            configurationHash: azureCapabilityConfigurationHash({
              baseUrl,
              inferenceBaseUrl: null,
              extraHeaders: null,
              secretId: secret.id,
            }),
          },
        },
      ],
      "azure",
    );
    if (kind === "image") {
      const unclassified = await ModelModel.upsert({
        externalId: "azure/unclassified",
        provider: "azure",
        modelId: "unclassified",
        inputModalities: ["text"],
        outputModalities: ["image"],
        lastSyncedAt: new Date(),
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(providerKey.id, [
        unclassified.id,
      ]);
    }
    keys.push(
      await VirtualApiKeyModel.create({
        organizationId: agent.organizationId,
        name: `${kind}-only`,
        ...accessGrants("org"),
        providerApiKeys: [
          { provider: "azure", providerApiKeyId: providerKey.id },
        ],
      }),
    );
  }
  const app = createFastifyInstance();
  await app.register(modelRouterRoutes);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string")
    throw new Error("No router port");
  const baseURL = `http://127.0.0.1:${address.port}/v1/model-router`;
  const image = new OpenAI({ baseURL, apiKey: keys[0].value, maxRetries: 0 });
  const text = new OpenAI({ baseURL, apiKey: keys[1].value, maxRetries: 0 });
  try {
    const listed = (await image.models.list()).data.map((item) => item.id);
    expect(listed).toContain("azure:production");
    expect(listed).not.toContain("azure:unclassified");
    expect(
      (
        await image.images.generate({
          model: "production",
          prompt: "Draw a circle.",
        })
      ).data?.[0].b64_json,
    ).toBe(IMAGE);
    await expect(
      image.chat.completions.create({
        model: "production",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      text.images.generate({ model: "production", prompt: "Draw a circle." }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await text.chat.completions.create({
          model: "production",
          messages: [{ role: "user", content: "Hello" }],
        })
      ).choices[0].message.content,
    ).toBe("hello");
    expect(
      (await text.responses.create({ model: "production", input: "Hello" }))
        .output_text,
    ).toBe("hello");
    expect(upstream.calls).toHaveLength(3);
    expect(upstream.calls[0]).toMatchObject({
      path: "/image/openai/v1/images/generations",
      apiKey: "synthetic-image-key",
      body: { model: "production" },
    });
    expect(
      upstream.calls
        .slice(1)
        .every(
          (call) =>
            call.apiKey === "synthetic-text-key" &&
            call.path.startsWith("/text/"),
        ),
    ).toBe(true);
  } finally {
    await app.close();
    await upstream.close();
  }
});

// These are real HTTP listeners, real provider SDK transports and a real migrated
// PGlite database. Only the external provider boundary is controlled by this test.
describe.each([
  false,
  true,
])("Model Router SDK media (agent path: %s)", (withAgent) => {
  test("uses one URL/key for images, Chat, Responses and embeddings with isolation and honest accounting", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    config.llmProxy.plugins = [];
    const agent = await makeAgent({ isDefault: true, agentType: "llm_proxy" });
    const upstream = await startUpstream();
    const mappings = [];
    const imageModels = [];
    for (const provider of ["azure", "openai", "gemini"] as const) {
      const secret = await makeSecret({
        secret: { apiKey: `synthetic-${provider}-secret` },
      });
      const providerKey = await makeLlmProviderApiKey(
        agent.organizationId,
        secret.id,
        {
          provider,
          baseUrl: `${upstream.origin}/${provider}${provider === "gemini" ? "" : "/openai/v1"}`,
        },
      );
      const modelId =
        provider === "gemini" ? "gemini-2.5-flash-image" : "gpt-image-1";
      const model = await ModelModel.upsert({
        externalId: `${provider}/${modelId}`,
        provider,
        modelId,
        inputModalities: ["text"],
        outputModalities: ["image"],
        lastSyncedAt: new Date(),
        customPricePerMillionInput: "1",
        customPricePerMillionOutput: "2",
      });
      const textModel = await ModelModel.upsert({
        externalId: `${provider}/gpt-4o`,
        provider,
        modelId: "gpt-4o",
        inputModalities: ["text"],
        outputModalities: ["text"],
        lastSyncedAt: new Date(),
      });
      const embeddingModel = await ModelModel.upsert({
        externalId: `${provider}/text-embedding-3-small`,
        provider,
        modelId: "text-embedding-3-small",
        embeddingDimensions: 1536,
        inputModalities: ["text"],
        outputModalities: ["text"],
        lastSyncedAt: new Date(),
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(providerKey.id, [
        model.id,
        textModel.id,
        embeddingModel.id,
      ]);
      if (provider === "azure") {
        await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
          providerKey.id,
          [
            {
              id: model.id,
              modelId: model.modelId,
              azureCapabilities: {
                kind: "image",
                underlyingModelName: "gpt-image-1",
                operations: ["image-generation", "image-edit"],
                source: "deployment",
                configurationHash: azureCapabilityConfigurationHash({
                  baseUrl: providerKey.baseUrl,
                  inferenceBaseUrl: providerKey.inferenceBaseUrl,
                  extraHeaders: providerKey.extraHeaders,
                  secretId: providerKey.secretId,
                }),
              },
            },
            { id: textModel.id, modelId: textModel.modelId },
            { id: embeddingModel.id, modelId: embeddingModel.modelId },
          ],
          "azure",
        );
      }
      mappings.push({ provider, providerApiKeyId: providerKey.id });
      imageModels.push(`${provider}:${modelId}`);
    }
    const key = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "media-sdk",
      ...accessGrants("org"),
      providerApiKeys: mappings,
    });
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("No router port");
    const baseURL = `http://127.0.0.1:${address.port}/v1/model-router${withAgent ? `/${agent.id}` : ""}`;
    const client = new OpenAI({ baseURL, apiKey: key.value, maxRetries: 0 });
    try {
      expect(
        (await client.models.list()).data.map((model) => model.id),
      ).toEqual(expect.arrayContaining(imageModels));
      for (const model of imageModels) {
        expect(
          (
            await client.images.generate({
              model,
              prompt: "Draw a circle.",
              n: 1,
            })
          ).data?.[0]?.b64_json,
        ).toBe(IMAGE);
      }
      const externalEnv = {
        ...process.env,
        MEDIA_BASE_URL: baseURL,
        MEDIA_KEY: key.value,
        MEDIA_MODELS: JSON.stringify(imageModels),
      };
      const externalClients: Array<Promise<{ stdout: string }>> = [];
      if (process.env.ARCHESTRA_MEDIA_SDK_PYTHON)
        externalClients.push(
          promisify(execFile)(
            process.env.ARCHESTRA_MEDIA_SDK_PYTHON,
            ["-c", PYTHON_IMAGES],
            { env: externalEnv },
          ),
        );
      if (process.env.ARCHESTRA_MEDIA_SDK_JS)
        externalClients.push(
          promisify(execFile)(
            process.execPath,
            ["--input-type=module", "-e", CURRENT_JS_IMAGES],
            { env: externalEnv },
          ),
        );
      for (const result of await Promise.all(externalClients))
        expect(JSON.parse(result.stdout).images).toEqual([IMAGE, IMAGE, IMAGE]);

      // The same configured client retains its original text and vector APIs.
      expect(
        (
          await client.chat.completions.create({
            model: "openai:gpt-4o",
            messages: [{ role: "user", content: "Hello" }],
          })
        ).choices[0].message.content,
      ).toBe("hello");
      const stream = await client.chat.completions.create({
        model: "openai:gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      });
      let streamed = "";
      for await (const chunk of stream)
        streamed += chunk.choices[0]?.delta.content ?? "";
      expect(streamed).toBe("hello");
      expect(
        (
          await client.responses.create({
            model: "openai:gpt-4o",
            input: "Hello",
          })
        ).output_text,
      ).toBe("hello");
      expect(
        (
          await client.embeddings.create({
            model: "azure:text-embedding-3-small",
            input: "Hello",
          })
        ).data[0].embedding,
      ).toEqual([0.25, 0.5]);

      const imageCalls = upstream.calls.filter((call) =>
        call.path.includes("images/generations"),
      );
      expect(
        imageCalls.some(
          (call) =>
            call.path === "/azure/openai/v1/images/generations" &&
            call.apiKey === "synthetic-azure-secret",
        ),
      ).toBe(true);
      expect(
        imageCalls.some(
          (call) =>
            call.path === "/openai/openai/v1/images/generations" &&
            call.authorization === "Bearer synthetic-openai-secret",
        ),
      ).toBe(true);
      const geminiCall = upstream.calls.find((call) =>
        call.path.includes(":generateContent"),
      );
      expect(geminiCall).toMatchObject({
        apiKey: "synthetic-gemini-secret",
        body: {
          contents: [{ role: "user", parts: [{ text: "Draw a circle." }] }],
          generationConfig: { responseModalities: ["IMAGE"] },
        },
      });
      expect(
        upstream.calls.find((call) => call.path.includes("embeddings"))?.apiKey,
      ).toBe("synthetic-azure-secret");
      expect(JSON.stringify(upstream.calls)).not.toContain(key.value);

      const count = upstream.calls.length;
      const anonymous = new OpenAI({
        baseURL,
        apiKey: "invalid-token",
        maxRetries: 0,
      });
      await expect(
        anonymous.images.generate({
          model: imageModels[0],
          prompt: "Draw a circle.",
        }),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        client.images.generate({
          model: "anthropic:other",
          prompt: "Draw a circle.",
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        client.images.generate({
          model: "gpt-image-1",
          prompt: "Draw a circle.",
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        client.images.generate({
          model: "azure:unlinked-deployment",
          prompt: "Draw a circle.",
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        client.images.generate({
          model: imageModels[0],
          prompt: "Draw a circle.",
          stream: true,
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        client.images.generate({
          model: imageModels[2],
          prompt: "Draw a circle.",
          size: "1024x1024",
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        client.images.generate({
          model: imageModels[2],
          prompt: "Draw a circle.",
          n: 2,
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(upstream.calls).toHaveLength(count);

      const otherAgent = await makeAgent({ agentType: "llm_proxy" });
      const foreign = new OpenAI({
        baseURL: `http://127.0.0.1:${address.port}/v1/model-router/${otherAgent.id}`,
        apiKey: key.value,
        maxRetries: 0,
      });
      await expect(
        foreign.images.generate({
          model: imageModels[0],
          prompt: "Draw a circle.",
        }),
      ).rejects.toMatchObject({ status: 403 });
      const unmapped = await VirtualApiKeyModel.create({
        organizationId: agent.organizationId,
        name: "openai-only",
        ...accessGrants("org"),
        providerApiKeys: [mappings[1]],
      });
      const limitedClient = new OpenAI({
        baseURL,
        apiKey: unmapped.value,
        maxRetries: 0,
      });
      await expect(
        limitedClient.images.generate({
          model: imageModels[0],
          prompt: "Draw a circle.",
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(
        (
          await limitedClient.images.generate({
            model: "gpt-image-1",
            prompt: "Draw a circle.",
          })
        ).data?.[0].b64_json,
      ).toBe(IMAGE);

      const beforeError = upstream.calls.length;
      for (const model of imageModels) {
        const error = await client.images
          .generate({ model, prompt: "upstream-error" })
          .catch((failure: unknown) => failure);
        expect(error).toMatchObject({ status: 429 });
        if (!model.startsWith("gemini:")) {
          expect(
            (error as { headers?: Headers }).headers?.get("retry-after"),
          ).toBe("2");
        }
        expect((error as Error).message).not.toContain(
          "synthetic-openai-secret",
        );
      }
      expect(upstream.calls).toHaveLength(beforeError + imageModels.length);
      for (const model of imageModels) {
        await expect(
          client.images.generate({ model, prompt: "slow" }, { timeout: 50 }),
        ).rejects.toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
        await vi.waitFor(
          () => expect(upstream.calls.at(-1)?.cancelled).toBe(true),
          { timeout: 2000 },
        );
      }
      const noUsage = await client.images.generate({
        model: imageModels[1],
        prompt: "unknown-usage",
      });
      expect(noUsage.usage).toBeUndefined();
      const interactions = await InteractionModel.getAllInteractionsForProfile(
        agent.id,
      );
      const images = interactions.filter(
        (row) =>
          row.type.endsWith(":images") || row.type === "gemini:generateContent",
      );
      expect(images.length).toBeGreaterThanOrEqual(5);
      const failedImages = images.filter(
        (row) =>
          (
            row.request as {
              prompt?: string;
              contents?: Array<{ parts?: Array<{ text?: string }> }>;
            }
          ).prompt === "upstream-error" ||
          (
            row.request as {
              contents?: Array<{ parts?: Array<{ text?: string }> }>;
            }
          ).contents?.[0]?.parts?.[0]?.text === "upstream-error",
      );
      expect(failedImages).toHaveLength(imageModels.length);
      for (const row of failedImages) {
        expect(row).toMatchObject({
          inputTokens: null,
          outputTokens: null,
          cost: null,
          response: {
            __mediaUsage: { tokensAvailable: false, costAvailable: false },
          },
        });
      }
      expect(
        images.every(
          (row) =>
            row.virtualKeyId === key.virtualKey.id ||
            row.virtualKeyId === unmapped.virtualKey.id,
        ),
      ).toBe(true);
      expect(images.every((row) => row.cost === null)).toBe(true);
      expect(
        images.some(
          (row) =>
            row.model === "gpt-image-1" &&
            row.inputTokens === null &&
            row.outputTokens === null,
        ),
      ).toBe(true);
      expect(JSON.stringify(interactions)).not.toContain(
        "synthetic-azure-secret",
      );
      expect(JSON.stringify(interactions)).not.toContain(
        "synthetic-openai-secret",
      );
      expect(JSON.stringify(interactions)).not.toContain(
        "synthetic-gemini-secret",
      );
      const beforeEnforced = upstream.calls.length;
      config.llmProxy.usageAccountingMode = "enforce";
      await expect(
        client.images.generate({
          model: imageModels[1],
          prompt: "Draw a circle.",
        }),
      ).rejects.toMatchObject({ status: 422 });
      expect(upstream.calls).toHaveLength(beforeEnforced);
      config.llmProxy.usageAccountingMode = "off";
      await LimitModel.create({
        entityType: "virtual_key",
        entityId: key.virtualKey.id,
        limitType: "token_cost",
        limitValue: 0,
      });
      await expect(
        client.images.generate({
          model: imageModels[1],
          prompt: "Draw a circle.",
        }),
      ).rejects.toMatchObject({ status: 422 });
      expect(upstream.calls).toHaveLength(beforeEnforced);
    } finally {
      app.server.closeAllConnections();
      await app.close();
      await upstream.close();
    }
  });
});

const IMAGE = "aW1hZ2U=";
const PYTHON_IMAGES = `
import os, json, openai
client = openai.OpenAI(base_url=os.environ['MEDIA_BASE_URL'], api_key=os.environ['MEDIA_KEY'], max_retries=0)
images = [client.images.generate(model=m, prompt='Draw a circle.', n=1).data[0].b64_json for m in json.loads(os.environ['MEDIA_MODELS'])]
assert client.embeddings.create(model='azure:text-embedding-3-small', input='Hello').data[0].embedding == [0.25, 0.5]
assert client.chat.completions.create(model='openai:gpt-4o', messages=[{'role':'user','content':'Hello'}]).choices[0].message.content == 'hello'
assert client.responses.create(model='openai:gpt-4o', input='Hello').output_text == 'hello'
print(json.dumps({'version': openai.__version__, 'images': images}))
`;
const CURRENT_JS_IMAGES = `
const { default: OpenAI } = await import(process.env.ARCHESTRA_MEDIA_SDK_JS);
const client = new OpenAI({ baseURL: process.env.MEDIA_BASE_URL, apiKey: process.env.MEDIA_KEY, maxRetries: 0 });
const images = [];
for (const model of JSON.parse(process.env.MEDIA_MODELS)) images.push((await client.images.generate({ model, prompt: 'Draw a circle.', n: 1 })).data[0].b64_json);
if ((await client.embeddings.create({ model: 'azure:text-embedding-3-small', input: 'Hello' })).data[0].embedding[0] !== 0.25) throw Error('embedding');
if ((await client.chat.completions.create({ model: 'openai:gpt-4o', messages: [{ role: 'user', content: 'Hello' }] })).choices[0].message.content !== 'hello') throw Error('chat');
if ((await client.responses.create({ model: 'openai:gpt-4o', input: 'Hello' })).output_text !== 'hello') throw Error('responses');
console.log(JSON.stringify({ images }));
`;

async function startUpstream() {
  const calls: Array<{
    path: string;
    authorization?: string;
    apiKey?: string;
    body: Record<string, unknown>;
    cancelled?: boolean;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const path = request.url ?? "";
    const call = {
      path,
      authorization: request.headers.authorization,
      apiKey: (request.headers["api-key"] ??
        request.headers["x-goog-api-key"]) as string | undefined,
      body,
    };
    calls.push(call);
    const prompt = body.prompt ?? body.contents?.[0]?.parts?.[0]?.text;
    if (prompt === "slow") {
      const timer = setTimeout(() => response.end("{}"), 3000);
      response.once("close", () => {
        clearTimeout(timer);
        Object.assign(call, { cancelled: true });
      });
      return;
    }
    if (prompt === "upstream-error") {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "2",
      });
      return response.end(
        JSON.stringify({
          error: {
            message: "Synthetic rate limit: synthetic-openai-secret",
            type: "rate_limit_error",
          },
        }),
      );
    }
    const usage =
      body.prompt === "unknown-usage"
        ? undefined
        : { input_tokens: 2, output_tokens: 3, total_tokens: 5 };
    response.setHeader("content-type", "application/json");
    if (path.includes("embeddings"))
      return response.end(
        JSON.stringify({
          object: "list",
          model: body.model,
          data: [
            {
              object: "embedding",
              index: 0,
              embedding:
                body.encoding_format === "base64"
                  ? Buffer.from(new Float32Array([0.25, 0.5]).buffer).toString(
                      "base64",
                    )
                  : [0.25, 0.5],
            },
          ],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }),
      );
    if (path.includes("chat/completions")) {
      if (body.stream) {
        response.setHeader("content-type", "text/event-stream");
        response.write(
          `data: ${JSON.stringify({ id: "chat-sdk", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}\n\n`,
        );
        return response.end(
          `data: ${JSON.stringify({ id: "chat-sdk", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        );
      }
      return response.end(
        JSON.stringify({
          id: "chat-sdk",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
      );
    }
    if (path.endsWith("responses"))
      return response.end(
        JSON.stringify({
          id: "resp-sdk",
          object: "response",
          created_at: 1,
          model: body.model,
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg-sdk",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "hello", annotations: [] },
              ],
            },
          ],
          usage,
        }),
      );
    if (path.includes(":generateContent"))
      return response.end(
        JSON.stringify({
          responseId: "gemini-sdk",
          modelVersion: "gemini-2.5-flash-image",
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "A circle." },
                  { inlineData: { mimeType: "image/png", data: IMAGE } },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 3,
            totalTokenCount: 5,
          },
        }),
      );
    response.end(
      JSON.stringify({ created: 1, data: [{ b64_json: IMAGE }], usage }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No upstream port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
