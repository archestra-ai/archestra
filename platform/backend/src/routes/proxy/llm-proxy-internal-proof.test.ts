import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CHAT_API_KEY_ID_HEADER,
  PROVIDER_BASE_URL_HEADER,
} from "@archestra/shared";
import { generateText } from "ai";
import { createLLMModel } from "@/clients/llm-client";
import config from "@/config";
import { LlmProviderApiKeyModel } from "@/models";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
  registerWorkerRoutes,
} from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

/**
 * The in-process proof end to end: a model built by `createLLMModel` dials
 * this process's proxy over real HTTP on loopback (the listener built by
 * `createFastifyInstance`, with the worker's route set, as A2A and scheduled
 * runs use), and the proxy reaches a keyless Ollama-style upstream.
 *
 * Public traffic the frontend relays to the API arrives over loopback too, so
 * the same headers sent without the proof must get nothing the in-process
 * caller gets — and must not reach the upstream at all.
 */
describe("in-process proof over a real loopback listener", () => {
  let upstream: Server;
  let upstreamUrl: string;
  let upstreamRequests: { url: string; headers: IncomingHttpHeaders }[];
  let app: FastifyInstanceWithZod;
  let proxyOrigin: string;
  const originalPort = config.api.port;
  const originalNativeBaseUrl = config.llm["ollama-native"].baseUrl;

  beforeEach(async () => {
    upstreamRequests = [];
    upstream = createServer((req, res) => {
      upstreamRequests.push({ url: req.url ?? "", headers: req.headers });
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            req.url === "/api/tags" ? { models: [] } : chatCompletion(),
          ),
        );
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

    // The native pass-through reads its upstream when the routes register.
    config.llm["ollama-native"].baseUrl = upstreamUrl.replace(/\/v1$/, "");
    app = createFastifyInstance();
    await registerWorkerRoutes(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    proxyOrigin = `http://127.0.0.1:${port}`;
    // buildProxyBaseUrl dials config.api.port, the listener's own port.
    config.api.port = port;
  });

  afterEach(async () => {
    config.api.port = originalPort;
    config.llm["ollama-native"].baseUrl = originalNativeBaseUrl;
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  test("createLLMModel reaches a keyless provider; the proof never goes upstream", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const key = await keylessOllamaKey(agent.organizationId, upstreamUrl);

    const result = await generateText({
      model: createLLMModel({
        provider: "ollama",
        apiKey: undefined,
        agentId: agent.id,
        modelName: "llama3",
        baseUrl: upstreamUrl,
        chatApiKeyId: key.id,
        source: "chat",
      }),
      prompt: "Hello",
    });

    expect(result.text).toBe("hi from upstream");
    expect(upstreamRequests).toHaveLength(1);
    const forwarded = upstreamRequests[0].headers;
    expect(forwarded["x-archestra-internal-call"]).toBeUndefined();
    expect(forwarded[PROVIDER_BASE_URL_HEADER.toLowerCase()]).toBeUndefined();
    expect(forwarded[CHAT_API_KEY_ID_HEADER.toLowerCase()]).toBeUndefined();
  });

  test.for([
    ["without a proof", {}],
    ["with a forged proof", { "x-archestra-internal-call": "A".repeat(43) }],
  ] as const)("a loopback request %s is denied before the upstream", async ([
    ,
    proof,
  ], { makeAgent }) => {
    const agent = await makeAgent();
    const key = await keylessOllamaKey(agent.organizationId, upstreamUrl);

    const response = await fetch(
      `${proxyOrigin}/v1/ollama/${agent.id}/chat/completions`,
      {
        method: "POST",
        headers: {
          ...proof,
          "content-type": "application/json",
          [PROVIDER_BASE_URL_HEADER]: upstreamUrl,
          [CHAT_API_KEY_ID_HEADER]: key.id,
        },
        body: JSON.stringify({
          model: "llama3",
          messages: [{ role: "user", content: "Hello" }],
        }),
      },
    );

    expect(response.status).toBe(401);
    expect(upstreamRequests).toHaveLength(0);
  });

  test("the ollama-native pass-through rejects an anonymous loopback request", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const response = await fetch(
      `${proxyOrigin}/v1/ollama-native/${agent.id}/api/tags`,
    );

    expect(response.status).toBe(401);
    expect(upstreamRequests).toHaveLength(0);
  });
});

// =========================================================================
// Internal helpers
// =========================================================================

function keylessOllamaKey(organizationId: string, baseUrl: string) {
  return LlmProviderApiKeyModel.create({
    organizationId,
    secretId: null,
    name: "Local Ollama",
    provider: "ollama",
    scope: "org",
    userId: null,
    teamId: null,
    baseUrl,
  });
}

function chatCompletion() {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "llama3",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi from upstream" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
  };
}
