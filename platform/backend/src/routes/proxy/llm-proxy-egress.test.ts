import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CHAT_API_KEY_ID_HEADER,
  PROVIDER_BASE_URL_HEADER,
} from "@archestra/shared";
import { generateText } from "ai";
import { internalCallHeader } from "@/clients/internal-call";
import { createLLMModel } from "@/clients/llm-client";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { UserTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import ollamaRoutes from "./routes/ollama";
import ollamaNativeRoutes from "./routes/ollama-native";

describe("proxy provenance and credential egress over HTTP", () => {
  setupTestCacheManager();
  let upstream: Server;
  let upstreamOrigin: string;
  let requests: { url: string; headers: IncomingHttpHeaders }[];
  let app: FastifyInstanceWithZod;
  let origin: string;

  beforeEach(async () => {
    requests = [];
    upstream = createServer((req, res) => {
      requests.push({ url: req.url ?? "", headers: req.headers });
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            req.url?.includes("chat/completions")
              ? {
                  id: "chatcmpl-test",
                  object: "chat.completion",
                  created: 1,
                  model: "llama3",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "hello" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    total_tokens: 2,
                  },
                }
              : { models: [] },
          ),
        );
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    config.llm["ollama-native"].baseUrl = upstreamOrigin;
    app = createFastifyInstance();
    await app.register(ollamaRoutes);
    await app.register(ollamaNativeRoutes);
    await app.listen({ port: 0, host: "127.0.0.1" });
    config.api.port = (app.server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${config.api.port}`;
  });

  afterEach(async () => {
    await app?.close();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  });

  test.for<Record<string, string>>([
    {},
    { "x-archestra-internal-call": "forged" },
    {
      "x-archestra-internal-call": `${internalCallHeader()["x-archestra-internal-call"]}, #`,
    },
  ])("denies untrusted loopback requests before upstream access: %j", async (proof, {
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const response = await fetch(
      `${origin}/v1/ollama-native/${agent.id}/api/tags`,
      {
        headers: { ...proof, [PROVIDER_BASE_URL_HEADER]: upstreamOrigin },
      },
    );
    expect(response.status).toBe(401);
    expect(requests).toHaveLength(0);
  });

  test("removes an authenticated personal bearer and its copies, preserving a separate provider key", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const row = await UserTokenModel.ensureUserToken(
      user.id,
      agent.organizationId,
    );
    const token = await UserTokenModel.getTokenValue(row.id);
    if (!token) throw new Error("Test personal token was not created");
    const response = await fetch(
      `${origin}/v1/ollama-native/${agent.id}/api/tags?key=${token}&keep=1`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-goog-api-key": token,
          "x-api-key": "separate-provider-key",
          [CHAT_API_KEY_ID_HEADER]: "selector",
          "provider-api-key-id": "legacy-selector",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/tags?keep=1");
    expect(requests[0].headers).not.toHaveProperty("authorization");
    expect(requests[0].headers).not.toHaveProperty("x-goog-api-key");
    expect(requests[0].headers).not.toHaveProperty(
      CHAT_API_KEY_ID_HEADER.toLowerCase(),
    );
    expect(requests[0].headers).not.toHaveProperty("provider-api-key-id");
    expect(requests[0].headers["x-api-key"]).toBe("separate-provider-key");
  });

  test("preserves a provider bearer authenticated by a passthrough key", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const token = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: user.id,
    });
    const response = await fetch(
      `${origin}/v1/ollama-native/${agent.id}/api/tags`,
      {
        headers: {
          authorization: "Bearer provider-secret",
          "x-archestra-virtual-key": token,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe("Bearer provider-secret");
    expect(requests[0].headers).not.toHaveProperty("x-archestra-virtual-key");
  });

  test("preserves a downstream Archestra credential on a verified internal call", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const response = await fetch(
      `${origin}/v1/ollama-native/${agent.id}/api/tags`,
      {
        headers: {
          ...internalCallHeader(),
          authorization: "Bearer arch_downstream",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe("Bearer arch_downstream");
    expect(requests[0].headers).not.toHaveProperty("x-archestra-internal-call");
  });

  test("createLLMModel still reaches a private keyless provider through the production listener", async ({
    makeAgent,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent();
    const baseUrl = `${upstreamOrigin}/v1`;
    const key = await makeLlmProviderApiKey(agent.organizationId, null, {
      provider: "ollama",
      baseUrl,
    });
    const result = await generateText({
      model: createLLMModel({
        provider: "ollama",
        apiKey: undefined,
        agentId: agent.id,
        modelName: "llama3",
        baseUrl,
        chatApiKeyId: key.id,
        source: "chat",
      }),
      prompt: "Hello",
    });
    expect(result.text).toBe("hello");
    expect(requests).toHaveLength(1);
    expect(requests[0].headers).not.toHaveProperty("x-archestra-internal-call");
    expect(requests[0].headers).not.toHaveProperty(
      CHAT_API_KEY_ID_HEADER.toLowerCase(),
    );
    expect(requests[0].headers).not.toHaveProperty(
      PROVIDER_BASE_URL_HEADER.toLowerCase(),
    );
  });
});
