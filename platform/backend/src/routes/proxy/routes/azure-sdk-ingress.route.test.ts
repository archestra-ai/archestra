import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AzureOpenAI, OpenAI } from "openai";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import {
  InteractionModel,
  LimitModel,
  LlmProviderApiKeyModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import azureRoutes from "./azure";

describe("Azure SDK ingress over HTTP", () => {
  setupTestCacheManager();
  let upstream: Server;
  let app: ReturnType<typeof createFastifyInstance>;
  let endpoint: string;
  let token: string;
  let agentId: string;
  let organizationId: string;
  let keyId: string;
  let virtualKeyId: string;
  let status: number;
  let stall: boolean;
  let upstreamCanceled: boolean;
  let requests: Array<{
    url: string;
    headers: Record<string, unknown>;
    body: unknown;
  }>;

  beforeEach(async ({ makeAgent, makeSecret, makeLlmProviderApiKey }) => {
    requests = [];
    status = 200;
    stall = false;
    upstreamCanceled = false;
    upstream = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ url: request.url ?? "", headers: request.headers, body });
      response.on("close", () => {
        if (!response.writableEnded) upstreamCanceled = true;
      });
      response.setHeader("content-type", "application/json");
      if (stall) return;
      if (status !== 200) {
        response.statusCode = status;
        response.setHeader("retry-after", "0");
        response.end(
          JSON.stringify({
            error: {
              message: "Controlled upstream failure",
              code: "controlled_failure",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      if (request.url?.includes("/embeddings")) {
        response.end(
          JSON.stringify({
            object: "list",
            model: body.model,
            data: [
              {
                object: "embedding",
                index: 0,
                embedding:
                  body.encoding_format === "base64"
                    ? Buffer.from(new Float32Array([0.1, 0.2]).buffer).toString(
                        "base64",
                      )
                    : [0.1, 0.2],
              },
            ],
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
        );
        return;
      }
      if (body.stream) {
        response.setHeader("content-type", "text/event-stream");
        response.end(
          `${[
            {
              id: "chatcmpl-sdk",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "READY" },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "chatcmpl-sdk",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 5,
                completion_tokens: 1,
                total_tokens: 6,
              },
            },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("")}data: [DONE]\n\n`,
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "chatcmpl-sdk",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "READY", refusal: null },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/openai`;
    config.llm.azure.baseUrl = upstreamUrl;
    config.llm.azure.entraIdEnabled = false;
    config.llmProxy.plugins = [];
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    agentId = agent.id;
    organizationId = agent.organizationId;
    const secret = await makeSecret({
      secret: { apiKey: "controlled-upstream-key" },
    });
    const key = await makeLlmProviderApiKey(agent.organizationId, secret.id, {
      provider: "azure",
      baseUrl: upstreamUrl,
    });
    keyId = key.id;
    const createdVirtual = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "SDK ingress test",
      providerApiKeys: [{ provider: "azure", providerApiKeyId: key.id }],
    });
    token = createdVirtual.value;
    virtualKeyId = createdVirtual.virtualKey.id;
    await ModelModel.upsert({
      externalId: "azure/sdk-deployment",
      provider: "azure",
      modelId: "sdk-deployment",
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "2",
      lastSyncedAt: new Date(),
    });
    app = createFastifyInstance();
    await app.register(azureRoutes);
    endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    await app?.close();
    await new Promise<void>((resolve, reject) =>
      upstream?.close((error) => (error ? reject(error) : resolve())),
    );
  });

  test.each([
    false,
    true,
  ])("classic AzureOpenAI works with URL/key changes (agent path: %s)", async (withAgent) => {
    const client = new AzureOpenAI({
      endpoint: `${endpoint}/v1/azure${withAgent ? `/${agentId}` : ""}`,
      apiKey: token,
      apiVersion: "2025-01-01-preview",
      maxRetries: 0,
    });
    const response = await client.chat.completions.create({
      model: "sdk-deployment",
      messages: [{ role: "user", content: "Reply READY." }],
    });
    expect(response.choices[0].message.content).toBe("READY");
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["api-key"]).toBe("controlled-upstream-key");
    expect(JSON.stringify(requests[0].headers)).not.toContain(token);
    expect(requests[0].url).toBe(
      "/openai/deployments/sdk-deployment/chat/completions?api-version=2025-01-01-preview",
    );
    const interactions =
      await InteractionModel.getAllInteractionsForProfile(agentId);
    expect(interactions.at(-1)).toMatchObject({
      model: "sdk-deployment",
      type: "azure:chatCompletions",
      inputTokens: 5,
      outputTokens: 1,
    });
  });

  test("OpenAI bearer client keeps canonical behavior", async () => {
    const client = new OpenAI({
      baseURL: `${endpoint}/v1/azure`,
      apiKey: token,
      maxRetries: 0,
    });
    const response = await client.chat.completions.create({
      model: "sdk-deployment",
      messages: [{ role: "user", content: "Reply READY." }],
    });
    expect(response.choices[0].message.content).toBe("READY");
    expect(requests).toHaveLength(1);
  });
  const payload = {
    model: "sdk-deployment",
    messages: [{ role: "user" as const, content: "Reply READY." }],
  };
  const clientFor = (
    options: Partial<ConstructorParameters<typeof AzureOpenAI>[0]> = {},
  ) =>
    new AzureOpenAI({
      endpoint: `${endpoint}/v1/azure`,
      apiKey: token,
      apiVersion: "2025-01-01-preview",
      maxRetries: 0,
      ...options,
    });

  test("native streaming keeps chunks, usage and cost", async () => {
    const stream = await clientFor().chat.completions.create({
      ...payload,
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    for await (const chunk of stream)
      text += chunk.choices[0]?.delta?.content ?? "";
    expect(text).toBe("READY");
    const rows = await InteractionModel.getAllInteractionsForProfile(agentId);
    expect(rows.at(-1)).toMatchObject({
      model: "sdk-deployment",
      inputTokens: 5,
      outputTokens: 1,
    });
    expect(Number(rows.at(-1)?.cost)).toBe(0.000007);
  });

  test("native embeddings uses the mapped Azure credential and deployment", async () => {
    const response = await clientFor().embeddings.create({
      model: "sdk-deployment",
      input: "Synthetic input",
      encoding_format: "float",
    });
    expect(response.data[0].embedding).toEqual([0.1, 0.2]);
    expect(requests[0].headers["api-key"]).toBe("controlled-upstream-key");
    expect(requests[0].url).toContain(
      "/openai/deployments/sdk-deployment/embeddings?",
    );
  });

  test("native SDK default and explicit base64 embeddings retain vectors and numeric logs", async () => {
    const normal = await clientFor().embeddings.create({
      model: "sdk-deployment",
      input: "Synthetic input",
    });
    expect(normal.data[0].embedding).toHaveLength(2);
    expect(normal.data[0].embedding[0]).toBeCloseTo(0.1);
    const base64 = await clientFor().embeddings.create({
      model: "sdk-deployment",
      input: "Synthetic input",
      encoding_format: "base64",
    });
    expect(base64.data[0].embedding).toBe(
      Buffer.from(new Float32Array([0.1, 0.2]).buffer).toString("base64"),
    );
    const rows = await InteractionModel.getAllInteractionsForProfile(agentId);
    const logged = rows.at(-1)?.response as {
      data: Array<{ embedding: number[] }>;
    };
    expect(logged.data[0].embedding).toHaveLength(2);
    expect(logged.data[0].embedding[0]).toBeCloseTo(0.1);
  });

  test("URL deployment overrides a different body model and fixed upstream deployment", async () => {
    const row = await LlmProviderApiKeyModel.findById(keyId);
    await LlmProviderApiKeyModel.update(keyId, {
      baseUrl: `${row?.baseUrl}/deployments/configured-default`,
    });
    await clientFor({
      deployment: "sdk-deployment",
    }).chat.completions.create({ ...payload, model: "body-model" });
    expect(requests[0].body).toMatchObject({ model: "sdk-deployment" });
    expect(requests[0].url).toContain("/deployments/sdk-deployment/");
    const rows = await InteractionModel.getAllInteractionsForProfile(agentId);
    expect(rows.at(-1)?.model).toBe("sdk-deployment");
  });

  test("native dated SDK requests use the classic surface of a configured v1 resource", async () => {
    const row = await LlmProviderApiKeyModel.findById(keyId);
    await LlmProviderApiKeyModel.update(keyId, {
      baseUrl: `${row?.baseUrl}/v1`,
    });
    await clientFor({ apiVersion: "2024-10-21" }).chat.completions.create(
      payload,
    );
    expect(requests[0].url).toBe(
      "/openai/deployments/sdk-deployment/chat/completions?api-version=2024-10-21",
    );
    await new OpenAI({
      baseURL: `${endpoint}/v1/azure/openai/v1`,
      apiKey: token,
      maxRetries: 0,
    }).chat.completions.create(payload);
    expect(requests[1].url).toBe("/openai/v1/chat/completions");
  });

  test("wire-encoded deployment names are decoded once before accounting", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/azure/openai/deployments/%73dk%2Ddeployment/chat/completions",
      headers: { "api-key": token },
      payload: { ...payload, model: "body-model" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(requests[0].body).toMatchObject({ model: "sdk-deployment" });
    expect(requests[0].url).toContain("/deployments/sdk-deployment/");
    const rows = await InteractionModel.getAllInteractionsForProfile(agentId);
    expect(rows.at(-1)?.model).toBe("sdk-deployment");
  });

  test("request API versions and extra query remain request-local", async () => {
    await Promise.all([
      clientFor({
        apiVersion: "2024-10-21",
        defaultQuery: { probe: "a/b c" },
      }).chat.completions.create(payload),
      clientFor({ apiVersion: "2025-02-01-preview" }).chat.completions.create(
        payload,
      ),
    ]);
    const urls = requests.map((item) => new URL(item.url, "http://upstream"));
    expect(
      urls.map((url) => url.searchParams.get("api-version")).sort(),
    ).toEqual(["2024-10-21", "2025-02-01-preview"]);
    expect(
      urls
        .find((url) => url.searchParams.has("probe"))
        ?.searchParams.get("probe"),
    ).toBe("a/b c");
  });

  test.each([
    "2024-02-01",
    "2025-01-01-preview",
  ])("token parameter compatibility uses caller API version %s", async (apiVersion) => {
    await clientFor({ apiVersion }).chat.completions.create({
      ...payload,
      model: "gpt-4.1",
      max_tokens: 16,
    });
    expect(
      new URL(requests[0].url, "http://upstream").searchParams.get(
        "api-version",
      ),
    ).toBe(apiVersion);
    expect(requests[0].body).toMatchObject(
      apiVersion === "2024-02-01"
        ? { max_tokens: 16 }
        : { max_completion_tokens: 16 },
    );
    expect(requests[0].body).not.toHaveProperty(
      apiVersion === "2024-02-01" ? "max_completion_tokens" : "max_tokens",
    );
  });

  test.each([
    "api-key",
    "authorization",
  ])("invalid %s virtual key never reaches upstream", async (header) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/azure/chat/completions",
      headers: {
        [header]:
          header === "authorization" ? "Bearer arch_invalid" : "arch_invalid",
      },
      payload,
    });
    expect(response.statusCode).toBe(401);
    expect(requests).toHaveLength(0);
  });

  test("expired and revoked keys fail before upstream", async () => {
    await VirtualApiKeyModel.update({
      id: virtualKeyId,
      name: "expired",
      scope: "org",
      authorId: null,
      teamIds: [],
      providerApiKeys: [{ provider: "azure", providerApiKeyId: keyId }],
      expiresAt: new Date(0),
    });
    await expect(
      clientFor().chat.completions.create(payload),
    ).rejects.toMatchObject({ status: 401 });
    await VirtualApiKeyModel.delete(virtualKeyId);
    await expect(
      clientFor().chat.completions.create(payload),
    ).rejects.toMatchObject({ status: 401 });
    expect(requests).toHaveLength(0);
  });

  test("a refreshed bearer token is read on each SDK call", async () => {
    let current = "arch_invalid";
    const client = clientFor({
      apiKey: undefined,
      azureADTokenProvider: async () => current,
    });
    await expect(client.chat.completions.create(payload)).rejects.toMatchObject(
      { status: 401 },
    );
    current = token;
    await client.chat.completions.create(payload);
    current = "arch_invalid_again";
    await expect(client.chat.completions.create(payload)).rejects.toMatchObject(
      { status: 401 },
    );
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).not.toContain(token);
  });

  test("conflicting native and bearer credentials fail closed", async () => {
    await expect(
      clientFor({
        defaultHeaders: { authorization: "Bearer arch_other" },
      }).chat.completions.create(payload),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(0);
    await clientFor({
      defaultHeaders: { authorization: `Bearer ${token}` },
    }).chat.completions.create(payload);
    expect(requests).toHaveLength(1);
  });

  test.each([
    "sdk%2Fother",
    "%2e%2e",
    "%5cother",
    "%00bad",
    "%ZZ",
  ])("rejects encoded deployment %s", async (deployment) => {
    const response = await new Promise<number>((resolve, reject) => {
      const target = new URL(endpoint);
      const request = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: `/v1/azure/openai/deployments/${deployment}/chat/completions`,
          method: "POST",
          headers: { "content-type": "application/json", "api-key": token },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify(payload));
    });
    expect(response).toBe(400);
    expect(requests).toHaveLength(0);
  });

  test("repeated authentication headers fail before credential resolution", async () => {
    const result = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${endpoint}/v1/azure/chat/completions`,
        {
          method: "POST",
          headers: [
            "content-type",
            "application/json",
            "api-key",
            token,
            "Api-Key",
            token,
          ],
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify(payload));
    });
    expect(result).toBe(400);
    expect(requests).toHaveLength(0);
  });

  test("another organization agent cannot spend this key", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const other = await makeOrganization();
    const agent = await makeAgent({
      organizationId: other.id,
      agentType: "agent",
    });
    await expect(
      clientFor({
        endpoint: `${endpoint}/v1/azure/${agent.id}`,
      }).chat.completions.create(payload),
    ).rejects.toMatchObject({ status: 403 });
    expect(requests).toHaveLength(0);
  });

  test("a mapping for a different provider grants no Azure access", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({
      secret: { apiKey: "other-provider-key" },
    });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });
    const other = await VirtualApiKeyModel.create({
      organizationId,
      name: "Other provider",
      providerApiKeys: [{ provider: "openai", providerApiKeyId: key.id }],
    });
    await expect(
      clientFor({ apiKey: other.value }).chat.completions.create(payload),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(0);
  });

  test("provider selection headers cannot override a virtual key mapping", async () => {
    await clientFor({
      defaultHeaders: {
        "provider-api-key-id": crypto.randomUUID(),
        "x-archestra-provider-base-url": "http://127.0.0.1:1/openai",
      },
    }).chat.completions.create(payload);
    expect(requests[0].headers["api-key"]).toBe("controlled-upstream-key");
    expect(requests[0].headers["provider-api-key-id"]).toBeUndefined();
  });

  test("native provider keys work with a separate authenticated passthrough principal", async ({
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    const passthrough = await makePassthroughCredential({
      organizationId,
      ownerId: user.id,
    });
    await clientFor({
      apiKey: "controlled-upstream-key",
      defaultHeaders: { "x-archestra-virtual-key": passthrough },
    }).chat.completions.create(payload);
    expect(requests[0].headers["api-key"]).toBe("controlled-upstream-key");
    expect(JSON.stringify(requests[0])).not.toContain(passthrough);
  });

  test("deployment-style SDK requests cannot bypass virtual-key budgets", async () => {
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: virtualKeyId,
      limitType: "token_cost",
      limitValue: 1,
      model: ["sdk-deployment"],
      lastCleanup: new Date(),
    });
    await LimitModel.updateTokenLimitUsage(
      "virtual_key",
      virtualKeyId,
      "sdk-deployment",
      1000000,
      1000000,
    );
    await expect(
      clientFor().chat.completions.create(payload),
    ).rejects.toMatchObject({ status: 402 });
    expect(requests).toHaveLength(0);
  });

  test.each([
    401, 403, 404, 429, 500,
  ])("upstream %s stays an SDK error without proxy retries", async (code) => {
    status = code;
    await expect(
      clientFor().chat.completions.create(payload),
    ).rejects.toMatchObject({ status: code });
    expect(requests).toHaveLength(1);
  });

  test("SDK cancellation closes the controlled upstream request", async () => {
    stall = true;
    const controller = new AbortController();
    const result = clientFor().chat.completions.create(payload, {
      signal: controller.signal,
    });
    await expect.poll(() => requests.length).toBe(1);
    controller.abort();
    await expect(result).rejects.toThrow();
    await expect.poll(() => upstreamCanceled).toBe(true);
  });

  test("unsupported catch-all inference never reaches upstream", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/azure/openai/deployments/sdk-deployment/completions",
      headers: { "api-key": token },
      payload: { model: "sdk-deployment", prompt: "Synthetic input" },
    });
    expect(response.statusCode).toBe(400);
    expect(requests).toHaveLength(0);
  });
});
