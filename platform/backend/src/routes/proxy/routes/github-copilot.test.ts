/**
 * GitHub Copilot proxy route tests.
 *
 * Regression coverage for T-959: Copilot's /chat/completions can reject a
 * model that its own /models catalog advertises (and that we therefore
 * synced and offered in the picker) with a 400
 * `{"error":{"message":"The requested model is not supported.","type":"api_validation_error"}}`.
 *
 * These tests drive the real route, adapter, and Copilot fetch wrapper
 * (token exchange + editor-identity headers) with the network faked at the
 * wire, pinning:
 *   - the exact request Copilot receives (catalogued model name — never a
 *     models.id UUID — plus the exchanged bearer and integration headers)
 *   - how the upstream rejection surfaces to the proxy caller
 */
import { randomUUID } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import {
  type ModelsDevApiResponse,
  type ModelsDevCost,
  modelsDevClient,
} from "@/clients/models-dev-client";
import captured from "@/clients/models-dev-client.test-data.json";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import InteractionModel from "@/models/interaction";
import InteractionBillingModel from "@/models/interaction-billing";
import LimitModel from "@/models/limit";
import { modelSyncService } from "@/services/model-sync";
import {
  accessGrants,
  afterEach,
  beforeEach,
  describe,
  expect,
  type TestFixtures,
  test,
} from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { useMswServer } from "@/test/msw";
import { GithubCopilot } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import githubCopilotProxyRoutes from "./github-copilot";
import modelRouterProxyRoutes from "./model-router";

beforeEach(async () => {
  await ModelModel.create({
    externalId: "github-copilot/gpt-4",
    provider: "github-copilot",
    modelId: "gpt-4",
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
});

const COPILOT_TOKEN_EXCHANGE_URL =
  "https://api.github.com/copilot_internal/v2/token";
const COPILOT_CHAT_COMPLETIONS_URL =
  "https://api.githubcopilot.com/chat/completions";

/** The exact upstream rejection observed in T-959. */
const MODEL_NOT_SUPPORTED_BODY = {
  error: {
    message: GithubCopilot.API.MODEL_NOT_SUPPORTED_MESSAGE,
    type: "api_validation_error",
  },
};

// The Copilot bearer cache is keyed by the GitHub token, so each test uses a
// fresh token to stay independent of the singleton token manager's state.
let tokenCounter = 0;
function uniqueGithubToken(): string {
  tokenCounter += 1;
  return `gho_proxy_test_${Date.now()}_${tokenCounter}`;
}

function createTestApp() {
  return createFastifyInstance();
}

// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper (per-test MSW server), not a React hook
const server = useMswServer();

function stubTokenExchange() {
  server.use(
    http.get(COPILOT_TOKEN_EXCHANGE_URL, () =>
      HttpResponse.json({
        token: "copilot-bearer-test",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      }),
    ),
  );
}

describe("GitHub Copilot proxy — upstream model rejection (T-959)", () => {
  test("non-streaming: sends the catalogued model name with the exchanged bearer, surfaces Copilot's 400", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const app = createTestApp();
    await app.register(githubCopilotProxyRoutes);
    const agent = await makeAgent({ name: "Copilot Proxy Agent" });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    const passthroughKey = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });

    stubTokenExchange();
    let upstreamModel: unknown;
    let upstreamAuthorization: string | null = null;
    let upstreamIntegrationId: string | null = null;
    server.use(
      http.post(COPILOT_CHAT_COMPLETIONS_URL, async ({ request }) => {
        const body = (await request.json()) as { model?: unknown };
        upstreamModel = body.model;
        upstreamAuthorization = request.headers.get("authorization");
        upstreamIntegrationId = request.headers.get("copilot-integration-id");
        return HttpResponse.json(MODEL_NOT_SUPPORTED_BODY, { status: 400 });
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/github-copilot/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${uniqueGithubToken()}`,
        "x-archestra-virtual-key": passthroughKey,
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    // What Copilot received: the catalogued model name (never a models.id
    // UUID), the exchanged short-lived bearer, and the editor identity.
    expect(upstreamModel).toBe("gpt-4");
    expect(upstreamAuthorization).toBe("Bearer copilot-bearer-test");
    expect(upstreamIntegrationId).toBe("vscode-chat");

    // The deterministic upstream rejection reaches the caller as a 400 with
    // the provider's message intact (not a masked 500).
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain("The requested model is not supported.");
  });

  test("streaming: the same 400 surfaces instead of a stream", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const app = createTestApp();
    await app.register(githubCopilotProxyRoutes);
    const agent = await makeAgent({ name: "Copilot Proxy Streaming Agent" });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    const passthroughKey = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });

    stubTokenExchange();
    server.use(
      http.post(COPILOT_CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json(MODEL_NOT_SUPPORTED_BODY, { status: 400 }),
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/github-copilot/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${uniqueGithubToken()}`,
        "x-archestra-virtual-key": passthroughKey,
        "user-agent": "test-client",
      },
      payload: {
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain("The requested model is not supported.");
  });
});

describe("GitHub Copilot Responses account routing", () => {
  test.for([
    false,
    true,
  ])("completes a Responses request at the exchanged API endpoint (stream=%s)", async (stream, {
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const app = createTestApp();
    await app.register(githubCopilotProxyRoutes);
    const agent = await makeAgent({ name: "Copilot Responses Agent" });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    const passthroughKey = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    const model = "gpt-5.3-codex";
    const text = "Hello from Copilot";
    const result = {
      id: "resp_test",
      object: "response",
      created_at: 123,
      model,
      status: "completed",
      output: [
        {
          id: "msg_test",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    };
    let upstreamCalls = 0;
    // Drain MSW's response clone so the SDK can cancel its SSE reader when
    // the proxy stops at response.completed without waiting on the other tee.
    const drainResponse = ({ response }: { response: Response }) => {
      void response.arrayBuffer();
    };
    server.events.on("response:mocked", drainResponse);
    server.use(
      http.get(COPILOT_TOKEN_EXCHANGE_URL, () =>
        HttpResponse.json({
          token: "copilot-responses-bearer",
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: "https://api.business.githubcopilot.com" },
        }),
      ),
      http.post("https://api.githubcopilot.com/responses", () =>
        HttpResponse.json(
          {
            error: { message: "", type: "api_not_found_error" },
          },
          { status: 404 },
        ),
      ),
      http.post(
        "https://api.business.githubcopilot.com/responses",
        async ({ request }) => {
          upstreamCalls++;
          expect(request.headers.get("authorization")).toBe(
            "Bearer copilot-responses-bearer",
          );
          expect(request.headers.get("copilot-integration-id")).toBe(
            "vscode-chat",
          );
          expect(await request.json()).toMatchObject({ model, stream });
          if (!stream) return HttpResponse.json(result);
          const events = [
            {
              type: "response.created",
              response: { ...result, status: "in_progress", output: [] },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...result.output[0], content: [] },
            },
            {
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              item_id: "msg_test",
              delta: text,
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: result.output[0],
            },
            { type: "response.completed", response: result },
          ];
          return new HttpResponse(
            events
              .map(
                (event) =>
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(""),
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        },
      ),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/github-copilot/${agent.id}/responses`,
        headers: {
          authorization: `Bearer ${uniqueGithubToken()}`,
          "x-archestra-virtual-key": passthroughKey,
        },
        payload: { model, input: "Hello", stream },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain(text);
      expect(upstreamCalls).toBe(1);
      if (stream) expect(response.body).toContain("response.completed");
      else
        expect(response.json()).toMatchObject({ model, output: result.output });
    } finally {
      server.events.removeListener("response:mocked", drainResponse);
      await app.close();
    }
  });
});

describe("GitHub Copilot chat completion compatibility", () => {
  test.for([
    { envelope: { object: "chat.completion", created: 123 }, status: 200 },
    { envelope: { object: "completion", created: 123 }, status: 200 },
    { envelope: {}, status: 200 },
    { envelope: { object: 42, created: 123 }, status: 500 },
  ])("Model Router validates completion envelopes like the direct proxy: %j", async ({
    envelope,
    status,
  }, {
    makeAgent,
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = createTestApp();
    await app.register(githubCopilotProxyRoutes);
    await app.register(modelRouterProxyRoutes);
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id);
    const agent = await makeAgent({
      organizationId: organization.id,
      name: "Copilot Router Compatibility",
      agentType: "llm_proxy",
      isDefault: true,
    });
    const githubToken = uniqueGithubToken();
    const secret = await makeSecret({ secret: { apiKey: githubToken } });
    const providerKey = await makeLlmProviderApiKey(
      organization.id,
      secret.id,
      { provider: "github-copilot", userId: user.id },
    );
    const model = await ModelModel.findByProviderAndModelId(
      "github-copilot",
      "gpt-4",
    );
    if (!model) throw new Error("Copilot fixture model was not created");
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(providerKey.id, [
      model.id,
    ]);
    const { value } = await VirtualApiKeyModel.create({
      organizationId: organization.id,
      name: "Copilot Router Key",
      authorId: user.id,
      ...accessGrants("personal"),
      providerApiKeys: [
        { provider: "github-copilot", providerApiKeyId: providerKey.id },
      ],
    });
    const passthroughKey = await makePassthroughCredential({
      organizationId: organization.id,
      ownerId: user.id,
    });
    stubTokenExchange();
    const toolCall = {
      id: "call_lookup",
      type: "function",
      function: { name: "lookup", arguments: '{"key":"example"}' },
    };
    const completion = {
      ...envelope,
      id: "completion-router-test",
      model: "gpt-4",
      provider_metadata: { region: "synthetic" },
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Checking the example",
            tool_calls: [toolCall],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    };
    let upstreamCalls = 0;
    server.use(
      http.post(COPILOT_CHAT_COMPLETIONS_URL, async ({ request }) => {
        upstreamCalls++;
        expect(await request.json()).toMatchObject({
          model: "gpt-4",
          stream: false,
        });
        return HttpResponse.json(completion);
      }),
    );
    try {
      for (const path of [
        `/v1/github-copilot/${agent.id}`,
        "/v1/model-router",
        `/v1/model-router/${agent.id}`,
      ]) {
        const direct = path.startsWith("/v1/github-copilot");
        const response = await app.inject({
          method: "POST",
          url: `${path}/chat/completions`,
          headers: {
            authorization: `Bearer ${direct ? githubToken : value}`,
            ...(direct ? { "x-archestra-virtual-key": passthroughKey } : {}),
          },
          payload: {
            model: direct ? "gpt-4" : "github-copilot:gpt-4",
            messages: [{ role: "user", content: "Look up the example" }],
          },
        });
        expect(response.statusCode, `${path}: ${response.body}`).toBe(status);
        if (status === 200) {
          expect(response.json()).toEqual({
            ...completion,
            choices: [{ ...completion.choices[0], index: 0 }],
          });
        } else {
          expect(response.json()).toEqual({
            error: {
              message: "Response doesn't match the schema",
              type: "api_internal_server_error",
            },
          });
        }
      }
      expect(upstreamCalls).toBe(3);
    } finally {
      await app.close();
    }
  });

  test("the chat client accepts a completion whose upstream choices omit their indices", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const app = createTestApp();
    await app.register(githubCopilotProxyRoutes);
    const agent = await makeAgent({ name: "Copilot Compatibility Agent" });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    const passthroughKey = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    stubTokenExchange();
    server.use(
      http.post(COPILOT_CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json({
          id: "completion-test",
          model: "claude-sonnet-5",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "Hello from Copilot" },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
      ),
    );
    const client = createOpenAI({
      apiKey: uniqueGithubToken(),
      baseURL: `http://proxy.test/v1/github-copilot/${agent.id}`,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const response = await app.inject({
          method: "POST",
          url: new URL(request.url).pathname,
          headers: {
            ...Object.fromEntries(request.headers),
            "x-archestra-virtual-key": passthroughKey,
          },
          payload: await request.text(),
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const result = await generateText({
        model: client.chat("claude-sonnet-5"),
        prompt: "Hello",
        maxRetries: 0,
      });
      expect(result.text).toBe("Hello from Copilot");
      expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    } finally {
      await app.close();
    }
  });

  test("fills missing choice indices while preserving upstream indices and tool calls", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const app = createTestApp();
    await app.register(githubCopilotProxyRoutes);
    const agent = await makeAgent({ name: "Copilot Tool Compatibility Agent" });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    const passthroughKey = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    const toolCall = {
      id: "call_test",
      type: "function",
      function: { name: "lookup", arguments: '{"key":"example"}' },
    };
    stubTokenExchange();
    server.use(
      http.post(COPILOT_CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json({
          id: "completion-test",
          model: "claude-sonnet-5",
          choices: [
            {
              index: 3,
              finish_reason: "stop",
              message: { role: "assistant", content: "First" },
            },
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [toolCall],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
      ),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/github-copilot/${agent.id}/chat/completions`,
        headers: {
          authorization: `Bearer ${uniqueGithubToken()}`,
          "x-archestra-virtual-key": passthroughKey,
        },
        payload: {
          model: "claude-sonnet-5",
          messages: [{ role: "user", content: "Hello" }],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().choices).toMatchObject([
        { index: 3 },
        { index: 1, message: { tool_calls: [toolCall] } },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe("GitHub Copilot long-context accounting", () => {
  // Real Fastify, SDK, catalog sync, migrated PGlite, receipts and limit settlement.
  // Only provider HTTP is controlled: these are accounting proofs, not GitHub invoices.
  setupTestCacheManager();
  // Drain MSW's cloned SSE responses so cancellation can complete on both tees.
  const drainResponse = ({ response }: { response: Response }) => {
    void response.arrayBuffer();
  };
  beforeEach(() => {
    server.events.on("response:mocked", drainResponse);
  });
  const apps: ReturnType<typeof createFastifyInstance>[] = [];
  afterEach(async () => {
    await drainBackgroundWork();
    for (const app of apps.splice(0)) await app.close();
    modelsDevClient.clearFetchCache();
    server.events.removeListener("response:mocked", drainResponse);
  });

  type Fixtures = Pick<
    TestFixtures,
    | "makeOrganization"
    | "makeAgent"
    | "makeUser"
    | "makeMember"
    | "makeSecret"
    | "makeLlmProviderApiKey"
  >;
  async function setup(f: Fixtures, syncInitially = true) {
    const org = await f.makeOrganization();
    const user = await f.makeUser();
    await f.makeMember(user.id, org.id);
    const agent = await f.makeAgent({ organizationId: org.id });
    const token = uniqueGithubToken();
    stubTokenExchange();
    const key = syncInitially
      ? await f.makeLlmProviderApiKey(
          org.id,
          (await f.makeSecret({ secret: { apiKey: token } })).id,
          { provider: "github-copilot", userId: user.id },
        )
      : null;
    const passthrough = await makePassthroughCredential({
      organizationId: org.id,
      ownerId: user.id,
    });
    const cap = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      limitValue: 100,
      model: null,
      lastCleanup: new Date(),
    });
    let catalog: ModelsDevApiResponse = structuredClone(
      captured.catalog,
    ) as ModelsDevApiResponse;
    let prompt = 1;
    let read = 0;
    let write = 0;
    let upstreamCalls = 0;
    server.use(
      http.get("https://models.dev/api.json", () => HttpResponse.json(catalog)),
      http.get("https://api.githubcopilot.com/models", () =>
        HttpResponse.json({
          data: Object.keys(captured.catalog["github-copilot"].models).map(
            (id) => ({
              id,
              capabilities: {
                type: "chat",
                limits: { max_context_window_tokens: 1_000_000 },
              },
              supported_endpoints: ["/chat/completions", "/responses"],
            }),
          ),
        }),
      ),
      http.post(
        "https://api.githubcopilot.com/chat/completions",
        async ({ request }) => {
          const body = (await request.json()) as {
            model: string;
            messages: unknown[];
            stream?: boolean;
          };
          if (!body.messages?.length)
            return HttpResponse.json(
              {
                error: {
                  message: "messages must be non-empty",
                  type: "api_validation_error",
                },
              },
              { status: 400 },
            );
          upstreamCalls++;
          const usage = {
            prompt_tokens: prompt,
            completion_tokens: 4,
            total_tokens: prompt + 4,
            prompt_tokens_details: {
              cached_tokens: read,
              cache_write_tokens: write,
            },
          };
          const envelope = {
            id: `chatcmpl-${randomUUID()}`,
            object: "chat.completion",
            created: 1,
            model: body.model,
          };
          if (!body.stream)
            return HttpResponse.json({
              ...envelope,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "OK" },
                  finish_reason: "stop",
                },
              ],
              usage,
            });
          return new HttpResponse(
            `${[
              {
                ...envelope,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "OK" },
                    finish_reason: null,
                  },
                ],
              },
              {
                ...envelope,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage,
              },
            ]
              .map((e) => `data: ${JSON.stringify(e)}\n\n`)
              .join("")}data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
      http.post(
        "https://api.githubcopilot.com/responses",
        async ({ request }) => {
          const body = (await request.json()) as {
            model: string;
            input?: string;
            stream?: boolean;
          };
          if (!body.input)
            return HttpResponse.json(
              { error: { message: "input required" } },
              { status: 400 },
            );
          upstreamCalls++;
          const result = {
            id: `resp-${randomUUID()}`,
            object: "response",
            created_at: 1,
            status: "completed",
            model: body.model,
            output: [
              {
                id: "msg_test",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "OK", annotations: [] }],
              },
            ],
            usage: {
              input_tokens: prompt,
              output_tokens: 4,
              total_tokens: prompt + 4,
              input_tokens_details: {
                cached_tokens: read,
                cache_write_tokens: write,
              },
            },
          };
          if (!body.stream) return HttpResponse.json(result);
          const events = [
            {
              type: "response.created",
              response: { ...result, status: "in_progress", output: [] },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...result.output[0], content: [] },
            },
            {
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              item_id: "msg_test",
              delta: "OK",
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: result.output[0],
            },
            { type: "response.completed", response: result },
          ];
          return new HttpResponse(
            events
              .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
    );
    const sync = async (forceRefresh = false) => {
      if (!key) throw new Error("This fixture has no stored provider key");
      modelsDevClient.clearFetchCache();
      return modelSyncService.syncModelsForApiKey({
        apiKeyId: key.id,
        provider: "github-copilot",
        apiKeyValue: token,
        forceRefresh,
      });
    };
    if (syncInitially) await sync();
    const app = createFastifyInstance();
    apps.push(app);
    await app.register(githubCopilotProxyRoutes);
    return {
      cap,
      agent,
      sync,
      changeCatalog: (next: ModelsDevApiResponse) => {
        catalog = next;
      },
      catalog,
      calls: () => upstreamCalls,
      async send(
        model: string,
        tokens: number,
        options: {
          read?: number;
          write?: number;
          stream?: boolean;
          responses?: boolean;
        } = {},
      ) {
        prompt = tokens;
        read = options.read ?? 0;
        write = options.write ?? 0;
        const response = await app.inject({
          method: "POST",
          url: `/v1/github-copilot/${agent.id}/${options.responses ? "responses" : "chat/completions"}`,
          headers: {
            authorization: `Bearer ${token}`,
            "x-archestra-virtual-key": passthrough,
          },
          payload: options.responses
            ? {
                model,
                input: "Say OK.",
                max_output_tokens: 4,
                stream: options.stream ?? false,
              }
            : {
                model,
                messages: [{ role: "user", content: "Say OK." }],
                max_tokens: 4,
                stream: options.stream ?? false,
              },
        });
        await drainBackgroundWork();
        return response;
      },
    };
  }

  const boundaryCases = [
    {
      model: "claude-haiku-5.5",
      threshold: 100_000,
      stream: false,
      responses: false,
    },
    {
      model: "claude-haiku-5.5",
      threshold: 100_000,
      stream: true,
      responses: false,
    },
    { model: "grok-4.7", threshold: 200_000, stream: true, responses: false },
    {
      model: "gpt-5.6-luna",
      threshold: 200_000,
      stream: false,
      responses: true,
    },
    { model: "gpt-6.1-sol", threshold: 272_000, stream: true, responses: true },
    {
      model: "gpt-6.1-terra",
      threshold: 272_000,
      stream: false,
      responses: true,
    },
  ];

  test.for(
    boundaryCases,
  )("imports and settles %j at exact prompt boundaries", async (scenario, {
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const c = await setup({
      makeOrganization,
      makeAgent,
      makeUser,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const catalogModel = c.catalog["github-copilot"].models[scenario.model];
    const cost = catalogModel.cost as ModelsDevCost;
    const tier = cost.tiers?.[0];
    expect(tier?.tier.size).toBe(scenario.threshold);
    let total = 0;
    const read = 500;
    const write = cost.cache_write === undefined ? 0 : 100;
    for (const prompt of [
      scenario.threshold - 1,
      scenario.threshold,
      scenario.threshold + 1,
    ]) {
      const rates = prompt > scenario.threshold ? tier : cost;
      if (!rates) throw new Error("Missing captured tier");
      const expected =
        ((prompt - read - write) * (rates.input ?? 0) +
          read * (rates.cache_read ?? 0) +
          write * (rates.cache_write ?? 0) +
          4 * (rates.output ?? 0)) /
        1_000_000;
      const response = await c.send(scenario.model, prompt, {
        ...scenario,
        read,
        write,
      });
      expect(response.statusCode, response.body).toBe(200);
      const logs = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.profileId, c.agent.id));
      const log = logs.find((row) => row.inputTokens === prompt - read - write);
      expect(log?.cost).toBe(expected.toFixed(10));
      expect(log?.cacheReadTokens).toBe(read);
      expect(log?.cacheWriteTokens).toBe(write);
      const [receipt] = await InteractionBillingModel.findMany([log?.id ?? ""]);
      expect(receipt.usage.status).toBe("complete");
      expect(receipt.usage.cost).toBe(expected.toFixed(10));
      expect(Number(receipt.usage.components[0].prices.input)).toBe(
        rates.input,
      );
      expect(Number(receipt.usage.components[0].prices.output)).toBe(
        rates.output,
      );
      total += expected;
      expect(
        (await LimitModel.getModelUsageBreakdowns([c.cap.id])).get(
          c.cap.id,
        )?.[0].cost,
      ).toBeCloseTo(total, 10);
    }
    if (total <= 1) return; // Spend limits are whole USD; exercise denial once these small fixtures reach one dollar.
    await LimitModel.patch(c.cap.id, { limitValue: 1 });
    const before = c.calls();
    expect(
      (await c.send(scenario.model, scenario.threshold + 1, scenario))
        .statusCode,
    ).toBe(402);
    expect(c.calls()).toBe(before);
  });

  test("sync refresh/removal preserves settled history; no-tier usage and replay settle correctly", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const c = await setup({
      makeOrganization,
      makeAgent,
      makeUser,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const noTier = c.catalog["github-copilot"].models["gpt-5-mini"].cost;
    expect((await c.send("gpt-5-mini", 300_001)).statusCode).toBe(200);
    const [ordinaryLog] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.model, "gpt-5-mini"));
    expect(ordinaryLog.cost).toBe(
      (
        (300_001 * (noTier?.input ?? 0) + 4 * (noTier?.output ?? 0)) /
        1e6
      ).toFixed(10),
    );
    const id = "claude-haiku-5.5";
    const row = await ModelModel.findByProviderAndModelId("github-copilot", id);
    if (!row) throw new Error("Missing synced model");
    expect(
      (await c.send(id, 100_001, { read: 500, write: 100 })).statusCode,
    ).toBe(200);
    const [original] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.model, id));
    const [receipt] = await InteractionBillingModel.findMany([original.id]);
    const counters = await db.select().from(schema.limitBillingUsageTable);
    const legacyCounters = await db.select().from(schema.limitModelUsageTable);
    const next = structuredClone(c.catalog);
    const cost = next["github-copilot"].models[id].cost;
    if (!cost?.tiers?.[0]) throw new Error("Missing captured tier");
    cost.tiers[0].input = 0.7;
    c.changeCatalog(next);
    await c.sync();
    delete cost.tiers;
    await c.sync();
    expect(await InteractionBillingModel.findMany([original.id])).toEqual([
      receipt,
    ]);
    expect(await db.select().from(schema.limitBillingUsageTable)).toEqual(
      counters,
    );
    expect(await db.select().from(schema.limitModelUsageTable)).toEqual(
      legacyCounters,
    );
    expect(
      (
        await db
          .select()
          .from(schema.interactionsTable)
          .where(eq(schema.interactionsTable.id, original.id))
      )[0].cost,
    ).toBe(original.cost);
    await InteractionModel.create({
      ...original,
      billingUsage: receipt.usage,
      billingAttribution: {
        organizationId: c.agent.organizationId,
        environmentId: c.agent.environmentId,
        entities: receipt.entities ?? [],
      },
    });
    expect(await db.select().from(schema.limitBillingUsageTable)).toEqual(
      counters,
    );
  });

  test("custom prices win in actual proxy receipts without importing a surcharge", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const c = await setup({
      makeOrganization,
      makeAgent,
      makeUser,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const model = "claude-haiku-5.5";
    const row = await ModelModel.findByProviderAndModelId(
      "github-copilot",
      model,
    );
    if (!row) throw new Error("Missing synced model");
    const verify = async (
      prompt: number,
      rates: [number, number, number, number],
    ) => {
      expect(
        (await c.send(model, prompt, { read: 500, write: 100 })).statusCode,
      ).toBe(200);
      const logs = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.profileId, c.agent.id));
      const log = logs.find((item) => item.inputTokens === prompt - 600);
      const expected =
        ((prompt - 600) * rates[0] +
          4 * rates[1] +
          500 * rates[2] +
          100 * rates[3]) /
        1e6;
      expect(log?.cost).toBe(expected.toFixed(10));
      const [receipt] = await InteractionBillingModel.findMany([log?.id ?? ""]);
      expect(receipt.usage.cost).toBe(expected.toFixed(10));
    };
    await ModelModel.update(row.id, {
      customPricePerMillionInput: "0.03",
      customPricePerMillionOutput: "0.07",
    });
    await verify(100_001, [0.03, 0.07, 0.05, 0.625]);
    await ModelModel.update(row.id, {
      customPricePerMillionInput: null,
      customPricePerMillionOutput: null,
      customPricePerMillionCacheRead: "0.02",
      customPricePerMillionCacheWrite: "0.04",
    });
    await verify(100_002, [0.5, 2.5, 0.02, 0.04]);
    await ModelModel.update(row.id, {
      longContextThreshold: 150_000,
      longContextPricePerMillionInput: "2",
      longContextPricePerMillionOutput: "3",
      longContextPricePerMillionCacheRead: "0.2",
      longContextPricePerMillionCacheWrite: "2.5",
    });
    await verify(120_000, [0.1, 0.5, 0.02, 0.04]);
    await verify(150_001, [2, 3, 0.2, 2.5]);
  });

  test("passthrough discovery and registry refresh price already-known Copilot models without stored keys", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const c = await setup(
      {
        makeOrganization,
        makeAgent,
        makeUser,
        makeMember,
        makeSecret,
        makeLlmProviderApiKey,
      },
      false,
    );
    const modelId = "claude-haiku-5.5";
    expect(
      await ModelModel.findByProviderAndModelId("github-copilot", modelId),
    ).toBeNull();
    expect(
      (await c.send(modelId, 100_001, { read: 500, write: 100 })).statusCode,
    ).toBe(200);
    const row = await ModelModel.findByProviderAndModelId(
      "github-copilot",
      modelId,
    );
    if (!row) throw new Error("Missing discovered model");
    expect(row.discoveredViaLlmProxy).toBe(true);
    expect(row.syncedLongContextThreshold).toBe(100_000);
    const [original] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, c.agent.id));
    expect(original.cost).toBe("0.0497980000");
    const [receipt] = await InteractionBillingModel.findMany([original.id]);
    expect(receipt.usage.cost).toBe(original.cost);
    const counters = await db.select().from(schema.limitBillingUsageTable);
    const legacyCounters = await db.select().from(schema.limitModelUsageTable);

    // Simulate a row discovered before tier metadata existed. Registry refresh
    // must upgrade future pricing without a stored credential or history rewrite.
    const oldRow = await ModelModel.ensureModelExists(
      "gpt-6.1-sol",
      "github-copilot",
    );
    expect(oldRow?.syncedLongContextThreshold).toBeNull();
    await ModelModel.update(row.id, {
      customPricePerMillionInput: "0.03",
      customPricePerMillionOutput: "0.07",
    });
    const next = structuredClone(c.catalog);
    const tier = next["github-copilot"].models[modelId].cost?.tiers?.[0];
    if (!tier) throw new Error("Missing fixture tier");
    tier.input = 0.7;
    c.changeCatalog(next);
    modelsDevClient.clearFetchCache();
    expect(await modelsDevClient.syncModelMetadata(true)).toBe(2);
    const refreshed = await ModelModel.findById(row.id);
    expect(Number(refreshed?.syncedLongContextPromptPricePerToken)).toBe(
      0.0000007,
    );
    expect(refreshed?.customPricePerMillionInput).toBe("0.03");
    expect(refreshed?.discoveredViaLlmProxy).toBe(true);
    expect(
      (
        await ModelModel.findByProviderAndModelId(
          "github-copilot",
          "gpt-6.1-sol",
        )
      )?.syncedLongContextThreshold,
    ).toBe(272_000);
    expect(
      await ModelModel.findByProviderAndModelId("github-copilot", "grok-4.7"),
    ).toBeNull();
    expect(await db.select().from(schema.llmProviderApiKeysTable)).toEqual([]);

    delete next["github-copilot"].models[modelId].cost?.tiers;
    c.changeCatalog(next);
    modelsDevClient.clearFetchCache();
    await modelsDevClient.syncModelMetadata(true);
    expect(
      (await ModelModel.findById(row.id))?.syncedLongContextThreshold,
    ).toBeNull();
    expect((await InteractionBillingModel.findMany([original.id]))[0]).toEqual(
      receipt,
    );
    expect(await db.select().from(schema.limitBillingUsageTable)).toEqual(
      counters,
    );
    expect(await db.select().from(schema.limitModelUsageTable)).toEqual(
      legacyCounters,
    );
    expect(
      (
        await db
          .select()
          .from(schema.interactionsTable)
          .where(eq(schema.interactionsTable.id, original.id))
      )[0].cost,
    ).toBe(original.cost);
  });
});
